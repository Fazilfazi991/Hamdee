/** Frozen local contract v1. No HTTP handler/auth/UI is registered here.
 * GET /api/hamdee/v1/staff-collections -> overview(identity, query)
 * GET /api/hamdee/v1/staff-collections/receipts -> receipts(identity, query)
 * POST /api/hamdee/v1/staff-collections/commands -> mutate(identity, body, key, requestId)
 * The Coordinator must retain owner/password, CSRF/Origin, body-size and no-store guards.
 * Amounts are exact decimal MAJOR-unit strings (not integer minor units).
 * Handover reference is required and unique per collector, across currencies;
 * a correction uses a new reference and preserves the superseded handover.
 */
export interface CollectorRecord { id:string; name:string; phone:string; notes:string; version:number }
export type ReceiptKind='property-rent'|'car-rental'|'classified-receipt';
export interface SourceReceipt {
  kind:ReceiptKind; id:string; date:string; amount:string; currency:string;
  method:'cash'|'bank'|'cheque'; classification:string; status:'recorded'|'pending';
  disposition:'unassigned'|'collector-held'|'company-direct';
  propertyId?:string; roomId?:string; agreementId?:string; tenantId?:string; customerId?:string;
  propertyLabel?:string; roomLabel?:string; customerLabel?:string;
  collectorId?:string; accountId?:string;
}
export interface CollectionQuery { month:string; asOf:string; collectorId?:string }
/** Backward-compatible picker v1.1: keep asOf/propertyId fixed while using
 * opaque cursor. Pages have at most 100 items ordered kind/date/id ascending;
 * nextCursor=null is the end and hasMore always agrees with nextCursor.
 */
export interface ReceiptQuery {asOf:string;propertyId?:string;cursor?:string}
export interface ReceiptPosition {kind:ReceiptKind;date:string;id:string}
export interface ReceiptListQuery {asOf:string;propertyId?:string;after?:ReceiptPosition;limit?:number}
export type StaffCommand =
 | {action:'create-collector';name:string;phone?:string;notes?:string}
 | {action:'update-collector';collectorId:string;expectedVersion:number;name?:string;phone?:string;notes?:string}
 | {action:'record-collection';collectorId:string;sourceKind:ReceiptKind;sourceId:string;disposition?:'collector-held'|'company-direct';accountId?:string;ownerConfirmedDisposition?:boolean;notes?:string}
 | {action:'handover';collectorId:string;accountId:string;amount:string;currency:string;handedOn:string;reference:string;notes?:string}
 | {action:'reverse-collection';collectionId:string;reversedOn:string;reason:string}
 | {action:'reverse-handover';handoverId:string;reversedOn:string;reason:string}
 | {action:'correct-handover';handoverId:string;accountId:string;amount:string;currency:string;handedOn:string;reference:string;reason:string;notes?:string};
export interface CollectorTotal {
  collectorId:string;currency:string;received:string;companyDirect:string;pending:string;
  handedOver:string;balance:string;monthReceived:string;monthHandedOver:string;month:string;asOf:string;
}
export interface CollectorDaily {collectorId:string;currency:string;date:string;received:string;handedOver:string;balance:string}
export interface CollectionRecord {id:string;collectorId:string;source:SourceReceipt;businessDate:string;amount:string;currency:string;method:SourceReceipt['method'];classification:string;disposition:'collector-held'|'company-direct'|'pending';accountId:string|null;notes:string;reversed:boolean}
export interface HandoverRecord {id:string;collectorId:string;accountId:string;businessDate:string;amount:string;currency:string;reference:string;notes:string;reversed:boolean;replacesHandoverId:string|null;reason?:string}
export interface ReversalRecord {id:string;originalId:string;kind:'collection'|'handover';reversedOn:string;reason:string}
export interface StaffOverview {collectors:CollectorRecord[];collections:CollectionRecord[];handovers:HandoverRecord[];totals:CollectorTotal[];daily:CollectorDaily[];history:Record<string,unknown>[];month:string;asOf:string;moneyUnit:'decimal-major-unit-strings';basis:string}
export interface ReceiptChoices {data:(SourceReceipt&{linked:boolean;companyAccountId:string|null})[];hasMore:boolean;nextCursor:string|null;asOf:string;moneyUnit:'decimal-major-unit-strings'}
export interface StaffMutationResult {data:CollectorRecord|CollectionRecord|HandoverRecord|ReversalRecord;replay:boolean}

import type { Identity } from './auth';
import type { Sql } from './database';
import { PropertyService } from './service';
import { randomUUID } from 'node:crypto';
import { uuid } from './validation';
import { date,id,text,month,day } from './rental';
import { allowFields,operationCheck as check,operationWrite,operationView,insertOperation,exactAmount,explicitCurrency,
 cashAccount,moneyEntry,assertFunds,reverseMoney,verifiedReceipt,sourceClaim,sourcePlacementDate,activePlacement,localReceiptReader,type ReceiptSourceReader,type OperationRow } from './company-finance';

function receiptOrder(a:ReceiptPosition,b:ReceiptPosition):number {
 for(const field of ['kind','date','id'] as const){if(a[field]<b[field])return -1;if(a[field]>b[field])return 1;}return 0;
}
function encodeReceiptCursor(asOf:string,propertyId:string|undefined,position:ReceiptPosition):string {
 return Buffer.from(JSON.stringify({version:1,asOf,propertyId:propertyId??null,kind:position.kind,date:position.date,id:position.id}),'utf8').toString('base64url');
}
function cursorCheck(ok:unknown):asserts ok {check(ok,'Reload receipt choices after changing filters or an invalid cursor.','INVALID_RECEIPT_CURSOR',400);}
function decodeReceiptCursor(token:unknown,asOf:string,propertyId:string|undefined):ReceiptPosition {
 cursorCheck(typeof token==='string'&&token.length>0&&token.length<=512&&/^[A-Za-z0-9_-]+$/.test(token));
 let payload:OperationRow;
 try{
  const raw=Buffer.from(token,'base64url');cursorCheck(raw.length<=384);const parsed:unknown=JSON.parse(raw.toString('utf8'));
  cursorCheck(parsed&&typeof parsed==='object'&&!Array.isArray(parsed));payload=parsed as OperationRow;
  cursorCheck(Object.keys(payload).length===6&&Object.keys(payload).every(k=>['version','asOf','propertyId','kind','date','id'].includes(k)));
  cursorCheck(payload.version===1&&payload.asOf===asOf&&payload.propertyId===(propertyId??null));
  cursorCheck(['property-rent','car-rental','classified-receipt'].includes(String(payload.kind))&&typeof payload.date==='string'&&date(payload.date)===payload.date&&payload.date<=asOf);
  cursorCheck(typeof payload.id==='string'&&uuid.test(payload.id)&&payload.id===payload.id.toLowerCase());
 }catch{cursorCheck(false);}
 const position={kind:payload.kind as ReceiptKind,date:payload.date as string,id:payload.id as string};
 // Reject alternate base64 bits, duplicate JSON keys, padding, whitespace,
 // unknown fields and noncanonical encodings, not just decodable JSON.
 cursorCheck(encodeReceiptCursor(asOf,propertyId,position)===token);return position;
}

async function collector(sql:Sql,value:unknown){const r=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.ops_collectors WHERE id=$1',[id(value)])).rows[0];check(r,'Collector not found.','NOT_FOUND',404);return r;}
async function handover(sql:Sql,eventId:string,b:OperationRow,collectorId:string,replaces:string|null=null){
 await collector(sql,collectorId);const account=await cashAccount(sql,b.accountId,true),currency=explicitCurrency(b.currency);
 check(currency===account.currency,'Currencies must match.','CURRENCY_MISMATCH',409);const reference=text(b.reference,200);
 check(!(await sql.query('SELECT id FROM hamdee_private.ops_transfers WHERE collector_id=$1 AND reference=$2',[collectorId,reference])).rows.length,
  'This collector handover reference is already recorded (across all currencies).','DUPLICATE_HANDOVER',409);
 const r=await insertOperation(sql,'ops_transfers',{id:randomUUID(),collector_id:collectorId,from_account_id:null,to_account_id:account.id,currency,amount:exactAmount(b.amount),business_date:date(b.handedOn),reference,notes:text(b.notes??'',2000,false),replaces_id:replaces,event_id:eventId});
 await moneyEntry(sql,eventId,{collector_id:collectorId,entry_kind:'handover-out',delta:'-'+r.amount,currency,business_date:r.business_date,method:account.kind,transfer_id:r.id,reference,notes:r.notes});
 await moneyEntry(sql,eventId,{account_id:account.id,entry_kind:'handover-in',delta:r.amount,currency,business_date:r.business_date,method:account.kind,transfer_id:r.id,reference,notes:r.notes});
 return {...operationView(r),accountId:account.id,reversed:false,replacesHandoverId:replaces};
}
export class StaffCollectionsService {
 constructor(private readonly properties:PropertyService,private readonly sources:ReceiptSourceReader=localReceiptReader){}
 async mutate(identity:Identity,input:unknown,key:string,requestId:string):Promise<StaffMutationResult>{
  const b=allowFields(input,{'create-collector':['name','phone','notes'],'update-collector':['collectorId','expectedVersion','name','phone','notes'],
   'record-collection':['collectorId','sourceKind','sourceId','disposition','accountId','ownerConfirmedDisposition','notes'],
   handover:['collectorId','accountId','amount','currency','handedOn','reference','notes'],
   'reverse-collection':['collectionId','reversedOn','reason'],'reverse-handover':['handoverId','reversedOn','reason'],
   'correct-handover':['handoverId','accountId','amount','currency','handedOn','reference','reason','notes']});
  return await operationWrite(this.properties,identity,'staff',b,key,requestId,async(sql,actorId,eventId)=>{
   let record:OperationRow;
   if(b.action==='create-collector'||b.action==='update-collector'){
    if(b.action==='create-collector')record=await insertOperation(sql,'ops_collectors',{id:randomUUID(),name:text(b.name,200),phone:text(b.phone??'',60,false),notes:text(b.notes??'',2000,false),version:1,event_id:eventId});
    else{
     const current=await collector(sql,b.collectorId);check(Number.isSafeInteger(b.expectedVersion)&&b.expectedVersion===current.version,'Reload and review this collector revision.','VERSION_CONFLICT',412);
     check(['name','phone','notes'].some(k=>k in b),'Enter collector changes.');
     record=(await sql.query<OperationRow>(`UPDATE hamdee_private.ops_collectors SET name=$2,phone=$3,notes=$4,version=version+1,event_id=$5 WHERE id=$1 AND version=$6 RETURNING *`,
      [current.id,'name' in b?text(b.name,200):current.name,'phone' in b?text(b.phone,60,false):current.phone,'notes' in b?text(b.notes,2000,false):current.notes,eventId,b.expectedVersion])).rows[0];check(record,'Reload and review this collector revision.','VERSION_CONFLICT',412);
    }
    await insertOperation(sql,'ops_collector_revisions',{collector_id:record.id,version:record.version,profile:JSON.stringify(operationView(record)),event_id:eventId});record=operationView(record);
   }else if(b.action==='record-collection'){
    const c=await collector(sql,b.collectorId),source=await verifiedReceipt(sql,this.sources,b.sourceKind,b.sourceId),claim=await sourceClaim(sql,eventId,source);
    check(!(await sql.query(`SELECT id FROM hamdee_private.ops_collections c WHERE claim_id=$1 AND NOT EXISTS(SELECT 1 FROM hamdee_private.ops_collection_reversals r WHERE r.collection_id=c.id)`,[claim])).rows.length,'This receipt already has an active collector record.','DUPLICATE_COLLECTION',409);
    let disposition:'collector-held'|'company-direct'|'pending';
    if(source.status==='pending'||source.method==='cheque')disposition='pending';
    else if(source.disposition==='unassigned'){
     check(b.ownerConfirmedDisposition===true&&['collector-held','company-direct'].includes(String(b.disposition)),'Confirm the actual holding location; a bank receipt does not imply staff-held cash.','DISPOSITION_REQUIRED',409);disposition=b.disposition as 'collector-held'|'company-direct';
    }else{disposition=source.disposition;check(b.disposition===undefined||b.disposition===disposition,'The source holding location cannot be overridden.','SOURCE_LOCATION_MISMATCH',409);}
    check(!source.collectorId||source.collectorId===c.id,'The source names another collector.','SOURCE_LOCATION_MISMATCH',409);
    if(disposition==='collector-held'&&!source.collectorId)check(b.ownerConfirmedDisposition===true,'Confirm which collector actually holds these funds.','DISPOSITION_REQUIRED',409);
    if(disposition==='company-direct'&&!source.accountId)check(b.ownerConfirmedDisposition===true,'Confirm the actual company destination account.','DISPOSITION_REQUIRED',409);
    const account=disposition==='company-direct'?await cashAccount(sql,source.accountId??b.accountId,true):null;
    if(account){check((b.accountId===undefined||b.accountId===account.id)&&account.currency===source.currency,'Choose the actual same-currency company account.','SOURCE_LOCATION_MISMATCH',409);}
    else check(b.accountId===undefined,'A collector-held or pending receipt has no company account yet.');
    const businessDate=await sourcePlacementDate(sql,claim,source.date);
    record=await insertOperation(sql,'ops_collections',{id:randomUUID(),collector_id:c.id,claim_id:claim,business_date:businessDate,amount:source.amount,currency:source.currency,method:source.method,classification:source.classification,disposition,account_id:account?.id??null,owner_confirmed:b.ownerConfirmedDisposition===true||source.disposition!=='unassigned'||disposition==='pending',notes:text(b.notes??'',2000,false),event_id:eventId});
    const placed=await activePlacement(sql,claim);
    if(disposition==='collector-held'){
     check(!placed,'This receipt already belongs to an account or collector custody.','SOURCE_ALREADY_LINKED',409);
     await moneyEntry(sql,eventId,{collector_id:c.id,claim_id:claim,collection_id:record.id,entry_kind:'collection',delta:source.amount,currency:source.currency,business_date:businessDate,method:source.method,classification:source.classification,notes:record.notes});
    }else if(disposition==='company-direct'){
     check(!placed||(placed.location_type==='account'&&placed.account_id===account!.id),'Source funds are already placed elsewhere.','SOURCE_ALREADY_LINKED',409);
     if(!placed)await moneyEntry(sql,eventId,{account_id:account!.id,claim_id:claim,entry_kind:'receipt',delta:source.amount,currency:source.currency,business_date:businessDate,method:source.method,classification:source.classification,notes:record.notes});
    }else check(!placed,'This source already has an available cash placement.','SOURCE_ALREADY_LINKED',409);
    record={...operationView(record),source,reversed:false};
   }else if(b.action==='handover')record=await handover(sql,eventId,b,id(b.collectorId));
   else if(b.action==='reverse-collection'){
    const c=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.ops_collections WHERE id=$1',[id(b.collectionId)])).rows[0];check(c,'Collection not found.','NOT_FOUND',404);
    const when=date(b.reversedOn),reason=text(b.reason,2000);check(when>=day(c.business_date),'Reversal cannot precede collection.');
    check(!(await sql.query('SELECT collection_id FROM hamdee_private.ops_collection_reversals WHERE collection_id=$1',[c.id])).rows.length,'This collection record is already reversed.','ALREADY_REVERSED',409);
    if(c.disposition==='collector-held'){
     const entry=(await sql.query<OperationRow>("SELECT id FROM hamdee_private.ops_money WHERE collection_id=$1 AND entry_kind='collection'",[c.id])).rows[0];check(entry,'Collection custody evidence is missing.','SOURCE_UNAVAILABLE',409);
     await reverseMoney(sql,eventId,entry.id,when,reason);
    }
    // Correcting a collector attribution for a direct company payment does
    // not erase the actual company receipt or count it a second time.
    const reversed=await insertOperation(sql,'ops_collection_reversals',{id:randomUUID(),collection_id:c.id,reversed_date:when,reason,event_id:eventId});
    record={id:reversed.id,originalId:c.id,kind:'collection',reversedOn:when,reason};
   }else{
    const old=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.ops_transfers WHERE id=$1 AND collector_id IS NOT NULL',[id(b.handoverId)])).rows[0];check(old,'Handover not found.','NOT_FOUND',404);
    const when=b.action==='correct-handover'?date(b.handedOn):date(b.reversedOn),reason=text(b.reason,2000);
    const entry=(await sql.query<OperationRow>("SELECT id FROM hamdee_private.ops_money WHERE transfer_id=$1 AND entry_kind='handover-out'",[old.id])).rows[0];check(entry,'Handover evidence is missing.','SOURCE_UNAVAILABLE',409);
    await reverseMoney(sql,eventId,entry.id,when,reason);
    record=b.action==='correct-handover'?{...await handover(sql,eventId,b,String(old.collector_id),String(old.id)),reason}:{id:eventId,originalId:old.id,kind:'handover',reversedOn:when,reason};
   }
   await assertFunds(sql);return record;
  }) as unknown as StaffMutationResult;
 }
 async receipts(identity:Identity,query:ReceiptQuery):Promise<ReceiptChoices>{
  const asOf=date(query.asOf),propertyId=query.propertyId?id(query.propertyId).toLowerCase():undefined;
  const after=query.cursor===undefined||query.cursor===''?undefined:decodeReceiptCursor(query.cursor,asOf,propertyId);
  return this.properties.ownerContext(identity,async sql=>{
   if(after){
    const anchor=await this.sources.read(sql,after.kind,after.id);
    cursorCheck(anchor&&anchor.kind===after.kind&&anchor.id===after.id&&anchor.date===after.date&&anchor.date<=asOf&&(!propertyId||anchor.propertyId?.toLowerCase()===propertyId));
   }
   const sources=await this.sources.list(sql,{asOf,propertyId,after,limit:101}),rows:ReceiptChoices['data']=[];
   check(Array.isArray(sources)&&sources.length<=101,'Receipt reader must provide a bounded page from the complete source set.','SOURCE_PAGE_INVALID',503);
   sources.sort(receiptOrder);const seen=new Set<string>();
   for(const source of sources){
    const position=source.kind+':'+source.id;
    check(!seen.has(position)&&(!after||receiptOrder(source,after)>0)&&source.date<=asOf&&(!propertyId||source.propertyId?.toLowerCase()===propertyId),
     'Receipt reader returned duplicate or out-of-scope page keys.','SOURCE_PAGE_INVALID',503);seen.add(position);
   }
   for(const r of sources.slice(0,100)){
    const verified=await verifiedReceipt(sql,this.sources,r.kind,r.id);
    check(receiptOrder(verified,r)===0&&(!propertyId||verified.propertyId?.toLowerCase()===propertyId),'Receipt page changed; reload the picker.','SOURCE_CHANGED',409);
    const claim=(await sql.query<{id:string}>('SELECT id FROM hamdee_private.ops_claims WHERE source_kind=$1 AND source_id=$2',[verified.kind,verified.id])).rows[0];
    const linked=claim?(await sql.query('SELECT id FROM hamdee_private.ops_collections c WHERE claim_id=$1 AND NOT EXISTS(SELECT 1 FROM hamdee_private.ops_collection_reversals r WHERE r.collection_id=c.id)',[claim.id])).rows.length>0:false;
    const placed=claim?await activePlacement(sql,claim.id):null;
    rows.push({...verified,linked,companyAccountId:placed?.location_type==='account'?String(placed.account_id):null});
   }
   const hasMore=sources.length>100,nextCursor=hasMore?encodeReceiptCursor(asOf,propertyId,rows[rows.length-1]):null;
   return {data:rows,hasMore,nextCursor,asOf,moneyUnit:'decimal-major-unit-strings'};
  });
 }
 async overview(identity:Identity,query:CollectionQuery):Promise<StaffOverview>{
  const period=month(query.month),asOf=date(query.asOf),collectorId=query.collectorId?id(query.collectorId):null;
  return this.properties.ownerContext(identity,async sql=>{
   if(collectorId)await collector(sql,collectorId);
   const result=(await sql.query<{data:OperationRow}>(`WITH money AS(SELECT m.*,coalesce(o.entry_kind,m.entry_kind) AS effective_kind FROM hamdee_private.ops_money m LEFT JOIN hamdee_private.ops_money o ON o.id=m.reversal_of
    WHERE m.location_type='collector' AND m.business_date<=$1::date AND ($2::uuid IS NULL OR m.collector_id=$2)),
    daily0 AS(SELECT collector_id,currency,business_date,sum(delta) FILTER(WHERE effective_kind='collection') AS received,-sum(delta) FILTER(WHERE effective_kind='handover-out') AS handed_over,sum(delta) AS net FROM money GROUP BY collector_id,currency,business_date),
    daily AS(SELECT collector_id,currency,business_date,coalesce(received,0)::text AS received,coalesce(handed_over,0)::text AS handed_over,sum(net) OVER(PARTITION BY collector_id,currency ORDER BY business_date)::text AS balance FROM daily0),
    collections AS(SELECT c.*,s.snapshot AS source,EXISTS(SELECT 1 FROM hamdee_private.ops_collection_reversals r WHERE r.collection_id=c.id AND r.reversed_date<=$1::date) AS reversed FROM hamdee_private.ops_collections c JOIN hamdee_private.ops_claims s ON s.id=c.claim_id WHERE c.business_date<=$1::date AND ($2::uuid IS NULL OR c.collector_id=$2)),
    keys AS(SELECT collector_id,currency FROM money UNION SELECT collector_id,currency FROM collections),
    totals AS(SELECT k.collector_id,k.currency,
    coalesce((SELECT sum(delta) FROM money m WHERE m.collector_id=k.collector_id AND m.currency=k.currency AND effective_kind='collection'),0)::text AS received,
    coalesce((SELECT sum(amount) FROM collections c WHERE c.collector_id=k.collector_id AND c.currency=k.currency AND disposition='company-direct' AND NOT reversed),0)::text AS company_direct,
    coalesce((SELECT sum(amount) FROM collections c WHERE c.collector_id=k.collector_id AND c.currency=k.currency AND disposition='pending' AND NOT reversed),0)::text AS pending,
    (-coalesce((SELECT sum(delta) FROM money m WHERE m.collector_id=k.collector_id AND m.currency=k.currency AND effective_kind='handover-out'),0))::text AS handed_over,
    coalesce((SELECT sum(delta) FROM money m WHERE m.collector_id=k.collector_id AND m.currency=k.currency),0)::text AS balance,
    coalesce((SELECT sum(delta) FROM money m WHERE m.collector_id=k.collector_id AND m.currency=k.currency AND effective_kind='collection' AND to_char(business_date,'YYYY-MM')=$3),0)::text AS month_received,
    (-coalesce((SELECT sum(delta) FROM money m WHERE m.collector_id=k.collector_id AND m.currency=k.currency AND effective_kind='handover-out' AND to_char(business_date,'YYYY-MM')=$3),0))::text AS month_handed_over FROM keys k)
    SELECT jsonb_build_object('collectors',coalesce((SELECT jsonb_agg(to_jsonb(c)-'event_id' ORDER BY c.id) FROM hamdee_private.ops_collectors c WHERE ($2::uuid IS NULL OR c.id=$2)),'[]'::jsonb),
    'collections',coalesce((SELECT jsonb_agg(to_jsonb(c)-'event_id'-'amount'||jsonb_build_object('amount',c.amount::text) ORDER BY business_date,id) FROM collections c),'[]'::jsonb),
    'handovers',coalesce((SELECT jsonb_agg(to_jsonb(t)-'event_id'-'amount'||jsonb_build_object('amount',t.amount::text,'accountId',t.to_account_id,'replacesHandoverId',t.replaces_id,'reversed',EXISTS(SELECT 1 FROM hamdee_private.ops_money r JOIN hamdee_private.ops_money o ON o.id=r.reversal_of WHERE o.transfer_id=t.id AND r.business_date<=$1::date)) ORDER BY t.business_date,t.id) FROM hamdee_private.ops_transfers t WHERE t.collector_id IS NOT NULL AND t.business_date<=$1::date AND ($2::uuid IS NULL OR t.collector_id=$2)),'[]'::jsonb),
    'totals',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY collector_id,currency) FROM totals t),'[]'::jsonb),
    'daily',coalesce((SELECT jsonb_agg(to_jsonb(d)-'business_date'||jsonb_build_object('date',d.business_date) ORDER BY business_date,collector_id,currency) FROM daily d WHERE to_char(business_date,'YYYY-MM')=$3),'[]'::jsonb),
    'history',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY occurred_at,id) FROM hamdee_private.ops_events e WHERE e.action LIKE 'staff:%' AND ($2::uuid IS NULL OR e.detail->'data'->>'collectorId'=$2::text OR e.detail->'data'->>'id'=$2::text OR e.detail->'data'->>'originalId' IN
      (SELECT id::text FROM hamdee_private.ops_collections WHERE collector_id=$2 UNION ALL SELECT id::text FROM hamdee_private.ops_transfers WHERE collector_id=$2))),'[]'::jsonb)) AS data`,[asOf,collectorId,period])).rows[0].data;
   return {collectors:(result.collectors as OperationRow[]).map(operationView),collections:(result.collections as OperationRow[]).map(operationView),handovers:(result.handovers as OperationRow[]).map(operationView),
    totals:(result.totals as OperationRow[]).map(r=>({...operationView(r),month:period,asOf})),daily:(result.daily as OperationRow[]).map(operationView),history:(result.history as OperationRow[]).map(operationView),
    month:period,asOf,moneyUnit:'decimal-major-unit-strings',basis:'Collector-held available funds only. Direct-company receipts and pending cheques are separate. Handover is a custody transfer, not new income; daily balances are recorded end-of-day balances.'} as unknown as StaffOverview;
  });
 }
}
