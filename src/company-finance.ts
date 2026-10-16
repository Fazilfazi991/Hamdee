/** Frozen local contract v1. Company/personal CASH ledger, not a profit report.
 * GET /api/hamdee/v1/company-finance -> overview(identity, {month,asOf,accountId?})
 * POST /api/hamdee/v1/company-finance/commands -> mutate(identity, body, key, requestId)
 * Owner-confirmed opening is mandatory. No account receives an invented balance.
 */
import type { Sql } from './database';
import type { SourceReceipt,ReceiptKind,ReceiptListQuery } from './staff-collections';
import type { Identity } from './auth';
import { PropertyService } from './service';
import { requireThat } from './errors';
import { uuid } from './validation';
import { canonical,date,id,text,month,day } from './rental';
import { createHash,randomUUID } from 'node:crypto';
export interface ReceiptSourceReader {
  read(sql:Sql,kind:ReceiptKind,id:string):Promise<SourceReceipt|null>;
  /** Apply after/limit to the complete kind/date/id ordered source set, never
   * to an already truncated oldest-receipt list. No business values change.
   */
  list(sql:Sql,query:ReceiptListQuery):Promise<SourceReceipt[]>;
}
export interface CashAccount {id:string;name:string;scope:'company'|'personal';kind:'cash'|'bank';currency:string;openingDate:string;openingAmount:string}
export type FinanceCommand =
 | {action:'create-account';name:string;scope:'company'|'personal';kind:'cash'|'bank';currency:string;openingDate:string;openingAmount:string;ownerConfirmedOpening:true;notes?:string}
 | {action:'create-classified-receipt';receiptKey:string;classification:string;receivedOn:string;amount:string;currency:string;method:'cash'|'bank'|'cheque';reference?:string;notes?:string}
 | {action:'receive';accountId:string;sourceKind:ReceiptKind;sourceId:string;ownerConfirmedDisposition:true;notes?:string}
 | {action:'expense';accountId:string;expenseKey:string;paidOn:string;amount:string;reference?:string;notes?:string}
 | {action:'transfer';fromAccountId:string;toAccountId:string;transferredOn:string;amount:string;reference:string;notes?:string}
 | {action:'reverse';entryId:string;reversedOn:string;reason:string};
export interface AccountTotal {accountId:string;currency:string;opening:string;receipts:string;expenses:string;transfersIn:string;transfersOut:string;balance:string}
export interface FinanceOverview {accounts:CashAccount[];transferAccounts:CashAccount[];scope:'company'|'personal'|'all';totals:AccountTotal[];entries:OperationRow[];monthEntries:OperationRow[];month:string;asOf:string;moneyUnit:'decimal-major-unit-strings';basis:string}
export interface ClassifiedReceiptRecord {id:string;receiptKey:string;classification:string;receivedDate:string;amount:string;currency:string;method:'cash'|'bank'|'cheque';status:'recorded'|'pending';reference:string;notes:string}
export interface CashLedgerRecord {id:string;locationType:'account'|'collector';accountId:string|null;collectorId:string|null;businessDate:string;delta:string;currency:string;method:'cash'|'bank';entryKind:string;classification:string;reference:string;notes:string}
export interface CashTransferRecord {id:string;fromAccountId:string|null;toAccountId:string;collectorId:string|null;amount:string;currency:string;businessDate:string;reference:string;notes:string}
export interface CashReversalRecord {id:string;originalId:string;reversedOn:string;reason:string}
export interface FinanceMutationResult {data:CashAccount|ClassifiedReceiptRecord|CashLedgerRecord|CashTransferRecord|CashReversalRecord;replay:boolean}

export type OperationRow=Record<string,unknown>;
export function operationCheck(ok:unknown,message:string,code='INVALID_OPERATION',status=422):asserts ok {requireThat(ok,status,code,message);}
export function exactAmount(v:unknown,zero=false):string {
 operationCheck(typeof v==='string'&&/^\d{1,18}(\.\d{1,12})?$/.test(v),'Enter an exact positive decimal (up to 18 whole/12 fractional digits).','INVALID_AMOUNT');
 const [a,b='']=(v as string).split('.'),whole=BigInt(a).toString(),fraction=b.replace(/0+$/,'');
 operationCheck(zero||whole!=='0'||!!fraction,'Enter a positive amount.','INVALID_AMOUNT');return whole+(fraction?'.'+fraction:'');
}
export const explicitCurrency=(v:unknown)=>{const c=text(v,3);operationCheck(/^[A-Z]{3}$/.test(c),'Enter an explicit three-letter currency.');return c;};
export function allowFields(input:unknown,fields:Record<string,string[]>):OperationRow {
 operationCheck(input&&typeof input==='object'&&!Array.isArray(input),'Submit an operation.');const b=input as OperationRow;
 operationCheck(typeof b.action==='string'&&Object.hasOwn(fields,b.action)&&Object.keys(b).every(k=>k==='action'||fields[String(b.action)].includes(k)),'Unknown action or fields.');return b;
}
export function operationView(row:OperationRow):OperationRow {return Object.fromEntries(Object.entries(row).filter(([k])=>k!=='event_id').map(([k,v])=>[
 k.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),v instanceof Date?v.toISOString().slice(0,k.endsWith('_date')?10:24):v]));}
export async function insertOperation(sql:Sql,table:string,values:OperationRow):Promise<OperationRow> {
 // Table/column names are service-owned constants, never request strings.
 const fields=Object.keys(values);return (await sql.query<OperationRow>(`INSERT INTO hamdee_private.${table}(${fields.join(',')}) VALUES(${fields.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(values))).rows[0];
}
export async function operationWrite(properties:PropertyService,identity:Identity,module:string,body:OperationRow,key:string,requestId:string,
 work:(sql:Sql,actorId:string,eventId:string)=>Promise<OperationRow>) {
 operationCheck(uuid.test(key)&&uuid.test(requestId),'Use UUID operation/request identifiers.','INVALID_KEY',400);
 const digest=createHash('sha256').update(canonical({module,api:1,body})).digest('hex');
 return properties.ownerContext(identity,async(sql,actorId)=>{
  // One small single-owner ledger: serialize cash/custody decisions across
  // processes; no process-local mutex or stale preflight balance is trusted.
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['hamdee-operations-money']);
  const saved=(await sql.query<{digest:string;result:OperationRow}>('SELECT digest,result FROM hamdee_private.ops_commands WHERE actor_id=$1 AND key=$2',[actorId,key])).rows[0];
  if(saved){operationCheck(saved.digest===digest,'Use a new key for a changed submission.','IDEMPOTENCY_KEY_REUSED',409);return {...saved.result,replay:true};}
  const eventId=randomUUID(),data=await work(sql,actorId,eventId),result={data,replay:false};
  await insertOperation(sql,'ops_events',{id:eventId,actor_id:actorId,action:module+':'+body.action,detail:JSON.stringify({data,requestId})});
  await insertOperation(sql,'ops_commands',{actor_id:actorId,key,digest,result:JSON.stringify(result),event_id:eventId});return result;
 });
}
export async function cashAccount(sql:Sql,value:unknown,companyOnly=false):Promise<OperationRow>{
 const row=(await sql.query<OperationRow>('SELECT *,opening_amount::text AS opening_amount FROM hamdee_private.ops_accounts WHERE id=$1',[id(value)])).rows[0];
 operationCheck(row,'Account not found.','NOT_FOUND',404);operationCheck(row.owner_confirmed===true&&(!companyOnly||row.scope==='company'),'Choose a confirmed company cash/bank account.','INVALID_ACCOUNT',409);return row;
}
export async function moneyEntry(sql:Sql,eventId:string,values:OperationRow){
 return insertOperation(sql,'ops_money',{id:randomUUID(),location_type:values.account_id?'account':'collector',collector_id:null,account_id:null,
 claim_id:null,collection_id:null,transfer_id:null,reversal_of:null,classification:'transfer',reference:'',notes:'',...values,event_id:eventId});
}
export async function assertFunds(sql:Sql){
 const negative=(await sql.query(`SELECT 1 FROM (SELECT sum(daily) OVER(PARTITION BY location_type,location_id,currency ORDER BY business_date) AS balance FROM
 (SELECT location_type,coalesce(account_id,collector_id) AS location_id,currency,business_date,sum(delta) AS daily FROM hamdee_private.ops_money GROUP BY location_type,coalesce(account_id,collector_id),currency,business_date) d) b WHERE balance<0 LIMIT 1`)).rows;
 operationCheck(!negative.length,'This entry would create negative recorded custody/account funds on a recorded date.','INSUFFICIENT_FUNDS',409);
}
export async function reverseMoney(sql:Sql,eventId:string,entryId:unknown,reversedOn:unknown,reason:unknown){
 const entry=(await sql.query<OperationRow>('SELECT *,delta::text AS delta FROM hamdee_private.ops_money WHERE id=$1',[id(entryId)])).rows[0];
 operationCheck(entry,'Money entry not found.','NOT_FOUND',404);operationCheck(!['opening','reversal'].includes(String(entry.entry_kind)),'This entry cannot be reversed through this command.','INVALID_REVERSAL',409);
 const when=date(reversedOn),why=text(reason,2000);operationCheck(when>=day(entry.business_date),'Reversal cannot precede the original recorded date.');
 const originals=entry.transfer_id?(await sql.query<OperationRow>("SELECT *,delta::text AS delta FROM hamdee_private.ops_money WHERE transfer_id=$1 AND entry_kind<>'reversal' ORDER BY id",[entry.transfer_id])).rows:[entry];
 for(const original of originals){
  operationCheck(!(await sql.query('SELECT id FROM hamdee_private.ops_money WHERE reversal_of=$1',[original.id])).rows.length,'This entry was already reversed.','ALREADY_REVERSED',409);
  const amount=String(original.delta);await moneyEntry(sql,eventId,{location_type:original.location_type,account_id:original.account_id,collector_id:original.collector_id,
   currency:original.currency,business_date:when,delta:amount.startsWith('-')?amount.slice(1):'-'+amount,method:original.method,entry_kind:'reversal',
   claim_id:original.claim_id,collection_id:original.collection_id,transfer_id:original.transfer_id,reversal_of:original.id,classification:original.classification,reference:original.reference,notes:why});
 }
 return entry;
}

export const localReceiptReader:ReceiptSourceReader={
 async read(sql,kind,sourceId){
  if(kind==='property-rent'){
   const r=(await sql.query<OperationRow>(`SELECT c.*,a.tenant_id,p.name AS property_label,room.label AS room_label,t.name AS customer_label FROM hamdee_private.rent_collections c
    JOIN hamdee_private.rental_agreements a ON a.id=c.agreement_id JOIN hamdee_private.properties p ON p.id=c.property_id
    JOIN hamdee_private.rooms room ON room.id=c.room_id JOIN hamdee_private.tenants t ON t.id=a.tenant_id
    WHERE c.id=$1 AND c.kind IN ('rent','deposit','advance')`,[sourceId])).rows[0];if(!r)return null;
   const amount=BigInt(String(r.amount_minor));return {kind,id:sourceId,date:day(r.received_date),amount:`${amount/100n}.${String(amount%100n).padStart(2,'0')}`,currency:String(r.currency),method:r.method as SourceReceipt['method'],classification:String(r.kind),status:r.status as SourceReceipt['status'],disposition:'unassigned',propertyId:String(r.property_id),roomId:String(r.room_id),agreementId:String(r.agreement_id),tenantId:String(r.tenant_id),customerLabel:String(r.customer_label),propertyLabel:String(r.property_label),roomLabel:String(r.room_label)};
  }
  if(kind==='classified-receipt'){
   const r=(await sql.query<OperationRow>('SELECT *,amount::text AS amount FROM hamdee_private.ops_receipts WHERE id=$1',[sourceId])).rows[0];if(!r)return null;
   return {kind,id:sourceId,date:day(r.received_date),amount:String(r.amount),currency:String(r.currency),method:r.method as SourceReceipt['method'],classification:String(r.classification),status:r.status as SourceReceipt['status'],disposition:'unassigned'};
  }
  // Car adapter can be injected after its own immutable receipt model exists.
  return null;
 },
 async list(sql,q){
  const limit=q.limit??101;operationCheck(Number.isInteger(limit)&&limit>=1&&limit<=101,'Invalid receipt page size.','INVALID_RECEIPT_CURSOR',400);
  // Page the UNION before reading metadata: neither source can hide newer rows
  // behind its own oldest-101 limit. C collation matches ASCII key comparison.
  const keys=(await sql.query<{kind:ReceiptKind;id:string}>(`WITH source_keys AS(
   SELECT 'property-rent'::text AS kind,received_date,id FROM hamdee_private.rent_collections
    WHERE received_date<=$1::date AND kind IN ('rent','deposit','advance') AND ($2::uuid IS NULL OR property_id=$2)
   UNION ALL SELECT 'classified-receipt'::text,received_date,id FROM hamdee_private.ops_receipts
    WHERE received_date<=$1::date AND $2::uuid IS NULL)
   SELECT kind,id FROM source_keys WHERE ($3::text IS NULL OR (kind COLLATE "C",received_date,id)>($3::text COLLATE "C",$4::date,$5::uuid))
   ORDER BY kind COLLATE "C",received_date,id LIMIT $6`,[date(q.asOf),q.propertyId?id(q.propertyId):null,q.after?.kind??null,q.after?.date??null,q.after?.id??null,limit])).rows;
  const rows:SourceReceipt[]=[];for(const key of keys){const value=await this.read(sql,key.kind,key.id);operationCheck(value,'Receipt page changed; reload the picker.','SOURCE_CHANGED',409);rows.push(value);}return rows;
 }
};
export async function verifiedReceipt(sql:Sql,reader:ReceiptSourceReader,kind:unknown,sourceId:unknown):Promise<SourceReceipt>{
 operationCheck(['property-rent','car-rental','classified-receipt'].includes(String(kind)),'Choose a supported receipt source.');const requested=id(sourceId),r=await reader.read(sql,kind as ReceiptKind,requested);
 operationCheck(r&&r.id===requested&&r.kind===kind,'Authoritative source receipt is unavailable.','SOURCE_UNAVAILABLE',409);
 operationCheck(['cash','bank','cheque'].includes(r.method)&&['recorded','pending'].includes(r.status)&&['unassigned','collector-held','company-direct'].includes(r.disposition),'Source receipt state is unavailable.','SOURCE_UNAVAILABLE',409);
 const result:SourceReceipt={kind:r.kind,id:r.id,date:date(r.date),amount:exactAmount(r.amount),currency:explicitCurrency(r.currency),method:r.method,status:r.status,classification:text(r.classification,120),disposition:r.disposition};
 if(r.propertyId){result.propertyId=id(r.propertyId);operationCheck((await sql.query('SELECT id FROM hamdee_private.properties WHERE id=$1',[result.propertyId])).rows.length,'Source property is unavailable.','SOURCE_UNAVAILABLE',409);}
 for(const field of ['accountId','collectorId','roomId','agreementId','tenantId','customerId'] as const)if(r[field])result[field]=id(r[field]);
 for(const field of ['propertyLabel','roomLabel','customerLabel'] as const)if(r[field])result[field]=text(r[field],200);
 return result;
}
export async function sourceClaim(sql:Sql,eventId:string,r:SourceReceipt){
 const existing=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.ops_claims WHERE source_kind=$1 AND source_id=$2',[r.kind,r.id])).rows[0];
 const facts=(value:unknown)=>Object.fromEntries(Object.entries(value as OperationRow).filter(([key])=>!['propertyLabel','roomLabel','customerLabel'].includes(key)));
 if(existing){operationCheck(canonical(facts(existing.snapshot))===canonical(facts(r)),'Authoritative receipt changed; review its history.','SOURCE_CHANGED',409);return String(existing.id);}
 return String((await insertOperation(sql,'ops_claims',{id:randomUUID(),source_kind:r.kind,source_id:r.id,snapshot:JSON.stringify(r),event_id:eventId})).id);
}
export async function activePlacement(sql:Sql,claimId:string){return (await sql.query<OperationRow>(`SELECT *,delta::text AS delta FROM hamdee_private.ops_money m WHERE claim_id=$1 AND entry_kind IN ('collection','receipt')
 AND NOT EXISTS(SELECT 1 FROM hamdee_private.ops_money r WHERE r.reversal_of=m.id)`,[claimId])).rows[0];}
export async function sourcePlacementDate(sql:Sql,claimId:string,sourceDate:string):Promise<string>{
 return (await sql.query<{date:string}>('SELECT hamdee_private.ops_claim_placement_date($1,$2::date)::text AS date',[claimId,sourceDate])).rows[0].date;
}

export class CompanyFinanceService {
 constructor(private readonly properties:PropertyService,private readonly sources:ReceiptSourceReader=localReceiptReader,private readonly accountScope?:'company'|'personal'){}
 private checkScope(account:OperationRow){operationCheck(!this.accountScope||account.scope===this.accountScope,'Choose an account in this ledger.','ACCOUNT_SCOPE_MISMATCH',409);}
 async mutate(identity:Identity,input:unknown,key:string,requestId:string):Promise<FinanceMutationResult>{
  const b=allowFields(input,{'create-account':['name','scope','kind','currency','openingDate','openingAmount','ownerConfirmedOpening','notes'],
   'create-classified-receipt':['receiptKey','classification','receivedOn','amount','currency','method','reference','notes'],
   receive:['accountId','sourceKind','sourceId','ownerConfirmedDisposition','notes'],expense:['accountId','expenseKey','paidOn','amount','reference','notes'],
   transfer:['fromAccountId','toAccountId','transferredOn','amount','reference','notes'],reverse:['entryId','reversedOn','reason']});
  // Preserve published company command digests/replay; personal has a distinct
  // namespace so an identical key/body cannot replay across the two ledgers.
  return await operationWrite(this.properties,identity,this.accountScope==='personal'?'personal-finance':'finance',b,key,requestId,async(sql,actorId,eventId)=>{
   let record:OperationRow;
   if(b.action==='create-account'){
    operationCheck(b.ownerConfirmedOpening===true,'The owner must explicitly confirm this opening.','OPENING_UNCONFIRMED',409);
    operationCheck(['company','personal'].includes(String(b.scope))&&['cash','bank'].includes(String(b.kind)),'Choose account scope and cash/bank type.');
    this.checkScope(b);
    const accountId=randomUUID(),openingId=randomUUID(),openingAmount=exactAmount(b.openingAmount,true),openingDate=date(b.openingDate),currency=explicitCurrency(b.currency);
    record=await insertOperation(sql,'ops_accounts',{id:accountId,name:text(b.name,200),scope:b.scope,kind:b.kind,currency,opening_date:openingDate,opening_amount:openingAmount,owner_confirmed:true,opening_entry_id:openingId,notes:text(b.notes??'',2000,false),event_id:eventId});
    await moneyEntry(sql,eventId,{id:openingId,account_id:accountId,entry_kind:'opening',delta:openingAmount,currency,business_date:openingDate,method:b.kind,classification:'owner-confirmed-opening'});
   }else if(b.action==='create-classified-receipt'){
    operationCheck(['cash','bank','cheque'].includes(String(b.method)),'Choose an explicit receipt method.');const receiptKey=id(b.receiptKey);
    operationCheck(!(await sql.query('SELECT id FROM hamdee_private.ops_receipts WHERE receipt_key=$1',[receiptKey])).rows.length,'This receipt identity is already recorded.','DUPLICATE_RECEIPT',409);
    record=await insertOperation(sql,'ops_receipts',{id:randomUUID(),receipt_key:receiptKey,classification:text(b.classification,120),received_date:date(b.receivedOn),amount:exactAmount(b.amount),currency:explicitCurrency(b.currency),method:b.method,status:b.method==='cheque'?'pending':'recorded',reference:text(b.reference??'',200,false),notes:text(b.notes??'',2000,false),event_id:eventId});
   }else if(b.action==='receive'){
    operationCheck(b.ownerConfirmedDisposition===true,'Confirm actual receipt into this account.','DISPOSITION_REQUIRED',409);const account=await cashAccount(sql,b.accountId),source=await verifiedReceipt(sql,this.sources,b.sourceKind,b.sourceId);
    this.checkScope(account);
    operationCheck(source.status==='recorded'&&source.method!=='cheque','Pending receipts/cheques are not available cash.','SOURCE_PENDING',409);
    operationCheck(source.disposition!=='collector-held'&&(!source.accountId||source.accountId===account.id),'Source funds belong to another holding location.','SOURCE_LOCATION_MISMATCH',409);
    operationCheck(source.currency===account.currency,'Currencies must match.','CURRENCY_MISMATCH',409);const claim=await sourceClaim(sql,eventId,source);
    operationCheck(!await activePlacement(sql,claim),'This source receipt is already placed.','SOURCE_ALREADY_LINKED',409);
    record=await moneyEntry(sql,eventId,{account_id:account.id,entry_kind:'receipt',delta:source.amount,currency:source.currency,business_date:await sourcePlacementDate(sql,claim,source.date),method:source.method,claim_id:claim,classification:source.classification,notes:text(b.notes??'',2000,false)});
   }else if(b.action==='expense'){
    const account=await cashAccount(sql,b.accountId),expenseKey=id(b.expenseKey);
    this.checkScope(account);
    operationCheck(!(await sql.query('SELECT id FROM hamdee_private.ops_expense_keys WHERE id=$1',[expenseKey])).rows.length,'This expense identity is already recorded.','DUPLICATE_EXPENSE',409);
    record=await moneyEntry(sql,eventId,{account_id:account.id,entry_kind:'expense',delta:'-'+exactAmount(b.amount),currency:account.currency,business_date:date(b.paidOn),method:account.kind,classification:'owner-recorded-expense',reference:text(b.reference??'',200,false),notes:text(b.notes??'',2000,false)});
    await insertOperation(sql,'ops_expense_keys',{id:expenseKey,entry_id:record.id,event_id:eventId});
   }else if(b.action==='transfer'){
    const from=await cashAccount(sql,b.fromAccountId),to=await cashAccount(sql,b.toAccountId);
    this.checkScope(from);
    operationCheck(from.id!==to.id&&from.currency===to.currency,'Choose distinct same-currency accounts.','CURRENCY_MISMATCH',409);
    const reference=text(b.reference,200);operationCheck(!(await sql.query('SELECT id FROM hamdee_private.ops_transfers WHERE from_account_id=$1 AND reference=$2',[from.id,reference])).rows.length,'This transfer reference is already recorded.','DUPLICATE_TRANSFER',409);
    record=await insertOperation(sql,'ops_transfers',{id:randomUUID(),collector_id:null,from_account_id:from.id,to_account_id:to.id,currency:from.currency,amount:exactAmount(b.amount),business_date:date(b.transferredOn),reference,notes:text(b.notes??'',2000,false),event_id:eventId});
    for(const [account,kind,sign] of [[from,'transfer-out','-'],[to,'transfer-in','']] as const)await moneyEntry(sql,eventId,{account_id:account.id,entry_kind:kind,delta:sign+record.amount,currency:record.currency,business_date:record.business_date,method:account.kind,transfer_id:record.id,reference,notes:record.notes});
   }else{
    const old=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.ops_money WHERE id=$1',[id(b.entryId)])).rows[0];operationCheck(old&&old.location_type==='account'&&!['handover-in','handover-out'].includes(String(old.entry_kind)),'Use the staff command for collector handover corrections.','INVALID_REVERSAL',409);
    this.checkScope(await cashAccount(sql,old.account_id));
    if(old.entry_kind==='receipt')operationCheck(!(await sql.query(`SELECT id FROM hamdee_private.ops_collections c WHERE c.claim_id=$1 AND c.disposition='company-direct'
      AND NOT EXISTS(SELECT 1 FROM hamdee_private.ops_collection_reversals r WHERE r.collection_id=c.id)`,[old.claim_id])).rows.length,
      'Reverse the linked collector attribution before correcting the direct account receipt.','COLLECTION_LINKED',409);
    const original=await reverseMoney(sql,eventId,b.entryId,b.reversedOn,b.reason);record={id:eventId,originalId:original.id,reversedOn:date(b.reversedOn),reason:text(b.reason,2000)};
   }
   await assertFunds(sql);return operationView(record);
  }) as unknown as FinanceMutationResult;
 }
 async overview(identity:Identity,query:{month:string;asOf:string;accountId?:string}){
  const period=month(query.month),asOf=date(query.asOf),accountId=query.accountId?id(query.accountId):null;
  return this.properties.ownerContext(identity,async sql=>{
   if(accountId)this.checkScope(await cashAccount(sql,accountId));
   const data=(await sql.query<{data:OperationRow}>(`WITH eligible AS(SELECT m.*,coalesce(o.entry_kind,m.entry_kind) AS effective_kind FROM hamdee_private.ops_money m LEFT JOIN hamdee_private.ops_money o ON o.id=m.reversal_of
    WHERE m.location_type='account' AND m.business_date<=$1::date AND ($2::uuid IS NULL OR m.account_id=$2) AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM hamdee_private.ops_accounts a WHERE a.id=m.account_id AND a.scope=$4))), totals AS(SELECT account_id,currency,
    coalesce(sum(delta) FILTER(WHERE effective_kind='opening'),0)::text AS opening,coalesce(sum(delta) FILTER(WHERE effective_kind='receipt'),0)::text AS receipts,
    (-coalesce(sum(delta) FILTER(WHERE effective_kind='expense'),0))::text AS expenses,coalesce(sum(delta) FILTER(WHERE effective_kind IN ('transfer-in','handover-in')),0)::text AS transfers_in,
    (-coalesce(sum(delta) FILTER(WHERE effective_kind IN ('transfer-out','handover-out')),0))::text AS transfers_out,sum(delta)::text AS balance FROM eligible GROUP BY account_id,currency)
    SELECT jsonb_build_object('accounts',coalesce((SELECT jsonb_agg(to_jsonb(a)-'event_id'-'opening_amount'||jsonb_build_object('opening_amount',a.opening_amount::text) ORDER BY a.id) FROM hamdee_private.ops_accounts a WHERE ($2::uuid IS NULL OR a.id=$2) AND ($4::text IS NULL OR a.scope=$4)),'[]'::jsonb),
    'transferAccounts',coalesce((SELECT jsonb_agg(to_jsonb(a)-'event_id'-'opening_amount'||jsonb_build_object('opening_amount',a.opening_amount::text) ORDER BY a.id) FROM hamdee_private.ops_accounts a),'[]'::jsonb),
    'totals',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY account_id,currency) FROM totals t),'[]'::jsonb),
    'entries',coalesce((SELECT jsonb_agg(to_jsonb(e)-'event_id'-'delta'||jsonb_build_object('delta',e.delta::text) ORDER BY business_date,id) FROM eligible e),'[]'::jsonb),
    'monthEntries',coalesce((SELECT jsonb_agg(to_jsonb(e)-'event_id'-'delta'||jsonb_build_object('delta',e.delta::text) ORDER BY business_date,id) FROM eligible e WHERE to_char(business_date,'YYYY-MM')=$3),'[]'::jsonb)) AS data`,[asOf,accountId,period,this.accountScope??null])).rows[0].data;
   return {accounts:(data.accounts as OperationRow[]).map(operationView),transferAccounts:(data.transferAccounts as OperationRow[]).map(operationView),scope:this.accountScope??'all',totals:(data.totals as OperationRow[]).map(operationView),entries:(data.entries as OperationRow[]).map(operationView),monthEntries:(data.monthEntries as OperationRow[]).map(operationView),month:period,asOf,moneyUnit:'decimal-major-unit-strings',basis:'Explicit dated cash/account records only. Transfers and staff handovers are not receipt income or profit.'} as unknown as FinanceOverview;
  });
 }
}
