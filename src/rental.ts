import { createHash,randomUUID } from 'node:crypto';
import type { Identity } from './auth';
import { PropertyService } from './service';
import { requireThat } from './errors';
import { uuid } from './validation';
import { historicalOccupantsByRoom,isOwnerConfirmedOctoberContact } from './historical-occupancy';

type Row=Record<string,unknown>;
export const day=(v:unknown)=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const tables={room:'rooms',tenant:'tenants',agreement:'rental_agreements',due:'rent_dues',collection:'rent_collections'} as const;
const check=(ok:unknown,message:string,code='INVALID_RENTAL',status=422)=>requireThat(ok,status,code,message);
export function text(v:unknown,max:number,required=true):string {check(typeof v==='string'&&v.trim().length<=max&&(!required||v.trim().length>0),'Check text fields.');return (v as string).trim();}
export function id(v:unknown):string {check(typeof v==='string'&&uuid.test(v),'Select an existing record.');return v as string;}
export function date(v:unknown):string {check(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v),'Enter a date as YYYY-MM-DD.');const s=v as string;check(s.slice(0,4)>='1900'&&s.slice(0,4)<='9999'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s,'Enter a real calendar date.');return s;}
export function month(v:unknown):string {check(typeof v==='string'&&/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/.test(v),'Choose a reporting month.');return v as string;}
export function money(v:unknown,zero=false):string {check(typeof v==='string'&&/^\d{1,10}(\.\d{1,2})?$/.test(v),'Enter an amount with at most two decimal places.');const [whole,fraction='']=(v as string).split('.');const n=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));check(n<=999999999999n&&(zero?n>=0n:n>0n),'Check the amount.');return String(n);}
export function canonical(v:unknown):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';return JSON.stringify(v);}
export function view(row:Row):Row {return Object.fromEntries(Object.entries(row).filter(([k])=>k!=='event_id').map(([k,v])=>[k.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),k.endsWith('_minor')&&v!==null?String(v):v instanceof Date?v.toISOString().slice(0,k.endsWith('_date')?10:24):v]));}
export class RentalService {
  constructor(private readonly properties:PropertyService){}
  async overview(identity:Identity,query:{month:string;asOf:string;propertyId?:string}) {
    const period=month(query.month),asOf=date(query.asOf),propertyId=query.propertyId?id(query.propertyId):null;
    return this.properties.ownerContext(identity,async sql=>{
      const select=async(table:string,field='property_id')=>(await sql.query<Row>(`SELECT * FROM hamdee_private.${table} ${field?'WHERE ($1::uuid IS NULL OR '+field+'=$1)':''} ORDER BY id`,field?[propertyId]:[])).rows;
      const rooms=await select('rooms'),agreements=await select('rental_agreements'),tenants=await select('tenants','');
      const occupancyAvailable=Boolean((await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.room_occupancy_confirmations') IS NOT NULL AND to_regclass('hamdee_private.source_roster_confirmations') IS NOT NULL AS ready")).rows[0]?.ready);
      const occupancyHistory=occupancyAvailable?await select('room_occupancy_confirmations'):[];
      const sourceConfirmations=occupancyAvailable?(await sql.query<Row>(`SELECT s.* FROM hamdee_private.source_roster_confirmations s LEFT JOIN hamdee_private.rooms r ON r.id=s.room_id WHERE ($1::uuid IS NULL OR r.property_id=$1 OR s.room_id IS NULL) ORDER BY s.id`,[propertyId])).rows:[];
      // Use immutable creation profiles/command results so routine display-name,
      // room-code and contact-note edits cannot rewrite imported source history.
      const properties=(await sql.query<Row>(`SELECT property_id AS id,profile->>'name' AS name FROM hamdee_private.property_revisions WHERE version=1 AND ($1::uuid IS NULL OR property_id=$1)`,[propertyId])).rows;
      const original=(await sql.query<{profile:Row}>(`SELECT result->'data' AS profile FROM hamdee_private.rental_commands
        WHERE result->'data'->>'version'='1' AND result->'data'->>'id'=ANY($1::text[])`,[[...rooms,...tenants].map(row=>String(row.id))])).rows.map(row=>row.profile);
      const roomIds=new Set(rooms.map(row=>String(row.id))),tenantIds=new Set(tenants.map(row=>String(row.id)));
      const originalRooms=original.filter(row=>roomIds.has(String(row.id))&&typeof row.code==='string').map(row=>({...row,property_id:row.propertyId}));
      const originalTenants=original.filter(row=>tenantIds.has(String(row.id))&&typeof row.notes==='string');
      const historical=historicalOccupantsByRoom(properties,originalRooms,originalTenants);
      const octoberRosterIds=new Set(originalTenants.filter(isOwnerConfirmedOctoberContact).map(row=>String(row.id)));
      const collections=await select('rent_collections'),history=await select('rental_events');
      const dues=(await sql.query<Row>(`SELECT d.*,coalesce(sum(a.amount_minor),0)::text AS paid_minor,
        (d.amount_minor-coalesce(sum(a.amount_minor),0))::text AS outstanding_minor FROM hamdee_private.rent_dues d
        LEFT JOIN hamdee_private.rent_allocations a ON a.due_id=d.id AND a.allocated_date<=$3::date WHERE ($1::uuid IS NULL OR d.property_id=$1) AND d.period=$2
        GROUP BY d.id ORDER BY d.due_date,d.id`,[propertyId,period,asOf])).rows;
      const allocations=(await sql.query<Row>(`SELECT a.* FROM hamdee_private.rent_allocations a JOIN hamdee_private.rent_collections c ON c.id=a.collection_id WHERE ($1::uuid IS NULL OR c.property_id=$1) ORDER BY a.id`,[propertyId])).rows;
      const availableAdvance=(collection:Row)=>BigInt(String(collection.amount_minor))-allocations.filter(a=>a.collection_id===collection.id&&day(a.allocated_date)<=asOf).reduce((sum,a)=>sum+BigInt(String(a.amount_minor)),0n);
      const summaries=new Map<string,Record<string,bigint>>();
      const group=(currency:string)=>{if(!summaries.has(currency))summaries.set(currency,{dueMinor:0n,collectedMinor:0n,outstandingMinor:0n,advanceMinor:0n,depositMinor:0n,chequePendingMinor:0n});return summaries.get(currency)!;};
      for(const due of dues){const g=group(String(due.currency));g.dueMinor+=BigInt(String(due.amount_minor));g.collectedMinor+=BigInt(String(due.paid_minor));g.outstandingMinor+=BigInt(String(due.outstanding_minor));}
      // Rent figures describe selected-month obligations and their allocations.
      // Deposit/credit balances are separately labelled as-of balances.
      for(const c of collections){if(day(c.received_date)>asOf)continue;const g=group(String(c.currency)),amount=BigInt(String(c.amount_minor));
        if(c.status==='pending'){if(day(c.received_date).slice(0,7)===period)g.chequePendingMinor+=amount;continue;}
        if(c.kind==='advance'){g.advanceMinor+=availableAdvance(c);}
        if(c.kind==='deposit')g.depositMinor+=amount;if(c.kind==='deposit_refund')g.depositMinor-=amount;
      }
      const roomViews=rooms.map(room=>{
        const history=occupancyHistory.filter(c=>c.room_id===room.id).sort((a,b)=>Number(a.version)-Number(b.version));
        const confirmation=history.filter(c=>day(c.effective_date)<=asOf).at(-1);
        const agreement=agreements.find(a=>a.room_id===room.id&&day(a.start_date)<=asOf&&(!a.end_date||day(a.end_date)>=asOf));
        // Ended/newer rental terms must not resurrect an older occupant or vacancy.
        const superseded=confirmation&&agreements.some(a=>a.room_id===room.id&&day(a.start_date)<=asOf&&
          (day(a.start_date)>day(confirmation.effective_date)||(a.id===confirmation.agreement_id&&a.end_date&&day(a.end_date)<asOf)));
        const effectiveConfirmation=superseded?undefined:confirmation;
        return {...view(room),occupancy:agreement?'occupied':effectiveConfirmation?.status??'unknown',occupancyVersion:history.at(-1)?.version??0,
          currentTenantId:agreement?.tenant_id??effectiveConfirmation?.tenant_id??null,occupancyConfirmation:confirmation?{...view(confirmation),internalAgreementId:confirmation.agreement_id}:null,
          occupancyHistory:history.map(c=>({...view(c),internalAgreementId:c.agreement_id})),
          historicalOccupants:historical.get(String(room.id))?.historicalOccupants??[],historicalOccupancyReviewRequired:historical.get(String(room.id))?.historicalOccupancyReviewRequired??false};
      });
      return {rooms:roomViews,tenants:tenants.map(t=>({...view(t),ownerConfirmedOctoberRoster:octoberRosterIds.has(String(t.id))})),agreements:agreements.map(view),dues:dues.map(d=>({...view(d),status:BigInt(String(d.outstanding_minor))===0n?'paid':BigInt(String(d.paid_minor))>0n?'partial':'pending'})),collections:collections.map(c=>({...view(c),...(c.kind==='advance'&&c.status==='recorded'&&day(c.received_date)<=asOf?{availableAdvanceMinor:String(availableAdvance(c))}:{})})),allocations:allocations.map(view),history:history.map(view),occupancyAvailable,sourceConfirmations:sourceConfirmations.map(view),
        summary:{totalRooms:rooms.length,occupiedRooms:roomViews.filter(r=>r.occupancy==='occupied').length,vacantRooms:roomViews.filter(r=>r.occupancy==='vacant').length,unverifiedRooms:roomViews.filter(r=>r.occupancy==='unknown').length,currencies:[...summaries].map(([currency,values])=>({currency,...Object.fromEntries(Object.entries(values).map(([k,v])=>[k,String(v)]))}))}};
    });
  }
  async mutate(identity:Identity,input:unknown,key:string,requestId:string) {
    check(uuid.test(key),'Use a valid operation key.','IDEMPOTENCY_KEY_REQUIRED',400);
    check(input&&typeof input==='object'&&!Array.isArray(input),'Submit a rental operation.');const b=input as Row;
    const fields:Record<string,string[]>={
      'create-room':['propertyId','code','label'],'update-room':['roomId','expectedVersion','code','label'],
      'create-tenant':['name','phone','email','notes'],'update-tenant':['tenantId','expectedVersion','name','phone','email','notes'],
      'create-agreement':['roomId','tenantId','monthlyRent','currency','depositRequired','dueTerms','startDate','endDate','previousAgreementId'],
      'confirm-occupancy':['roomId','tenantId','status','effectiveDate','expectedOccupancyVersion','notes','terms'],
      'confirm-source-reference':['roomId','tenantId','sourceSha256','sourceReference','period','notes'],
      'end-agreement':['agreementId','roomId','tenantId','period','expectedVersion','endDate'],'issue-due':['agreementId','roomId','tenantId','period','dueDate','amount'],
      'record-collection':['agreementId','roomId','tenantId','period','kind','method','amount','receivedDate','reference','allocations'],
      'allocate-advance':['collectionId','dueId','amount','allocationDate'],'refund-deposit':['agreementId','roomId','tenantId','period','amount','receivedDate','method','reference']};
    const action=String(b.action);check(Object.hasOwn(fields,action)&&Object.keys(b).every(k=>k==='action'||fields[action].includes(k)),'Unknown operation or fields.');
    const digest=createHash('sha256').update(canonical(b)).digest('hex');
    return this.properties.ownerContext(identity,async(sql,actorId)=>{
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['rental-command:'+actorId+':'+key]);
      const saved=(await sql.query<{digest:string;result:Row}>('SELECT digest,result FROM hamdee_private.rental_commands WHERE actor_id=$1 AND key=$2',[actorId,key])).rows[0];
      if(saved){check(saved.digest===digest,'Use a new key for a changed submission.','IDEMPOTENCY_KEY_REUSED',409);return {...saved.result,replay:true};}
      const get=async(kind:keyof typeof tables,value:unknown)=>{const row=(await sql.query<Row>(`SELECT * FROM hamdee_private.${tables[kind]} WHERE id=$1`,[id(value)])).rows[0];check(row,'Record not found.','NOT_FOUND',404);return row;};
      const resolveAgreement=async()=>{
        if(b.agreementId!==undefined){check(b.roomId===undefined&&b.tenantId===undefined,'Choose one internal rental terms reference.');return get('agreement',b.agreementId);}
        const room=id(b.roomId),tenant=id(b.tenantId),period=month(b.period);
        const found=(await sql.query<Row>(`SELECT * FROM hamdee_private.rental_agreements WHERE room_id=$1 AND tenant_id=$2 AND to_char(start_date,'YYYY-MM')<=$3 AND (end_date IS NULL OR to_char(end_date,'YYYY-MM')>=$3) ORDER BY start_date,id`,[room,tenant,period])).rows;
        check(found.length===1,found.length?'More than one rental terms record covers this room, tenant and month. Confirm the exact terms before proceeding.':'Confirm rental terms and their effective date before recording dues or collections.',found.length?'RENTAL_TERMS_AMBIGUOUS':'RENTAL_TERMS_REQUIRED',409);
        return found[0];
      };
      let propertyId:string|null=null,roomId:string|null=null,entityId:string=randomUUID(),data:Row;const eventId=randomUUID();
      let parent:Row|undefined;
      if(action==='create-room')propertyId=id(b.propertyId);
      else if(['update-room','create-agreement','confirm-occupancy'].includes(action)){parent=await get('room',b.roomId);propertyId=String(parent.property_id);roomId=String(parent.id);}
      else if(action==='confirm-source-reference'&&b.roomId){parent=await get('room',b.roomId);propertyId=String(parent.property_id);roomId=String(parent.id);}
      else if(action==='allocate-advance'){parent=await get('collection',b.collectionId);propertyId=String(parent.property_id);roomId=String(parent.room_id);}
      else if(['end-agreement','issue-due','record-collection','refund-deposit'].includes(action)){parent=await resolveAgreement();propertyId=String(parent.property_id);roomId=String(parent.room_id);}
      if(propertyId){
        await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['property:'+propertyId]);
        const p=(await sql.query<Row>('SELECT id,lifecycle_status FROM hamdee_private.properties WHERE id=$1',[propertyId])).rows[0];check(p,'Property not found.','NOT_FOUND',404);check(p.lifecycle_status==='registered','Restore the property before adding or changing rental records.','PROPERTY_ARCHIVED',409);
        if(['update-room','create-agreement','confirm-occupancy','confirm-source-reference'].includes(action))parent=await get('room',b.roomId);
        else if(action==='allocate-advance')parent=await get('collection',b.collectionId);
        else if(action!=='create-room')parent=await resolveAgreement();
      }
      const insert=async(table:string,values:Row)=>{const entries=Object.entries(values);return (await sql.query<Row>(`INSERT INTO hamdee_private.${table}(${entries.map(([k])=>k).join(',')}) VALUES(${entries.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,entries.map(([,v])=>v))).rows[0];};
      const version=(row:Row)=>check(Number.isInteger(b.expectedVersion)&&b.expectedVersion===row.version,'This record changed. Reload before saving.','VERSION_CONFLICT',412);
      const allocate=async(collection:Row,dueId:unknown,amount:unknown,allocationDate:unknown)=>{
        const due=await get('due',dueId),n=money(amount);check(due.agreement_id===collection.agreement_id&&due.currency===collection.currency,'Choose a due from this agreement.','ALLOCATION_MISMATCH',409);
        const allocatedDate=date(allocationDate);check(allocatedDate>=day(collection.received_date),'Allocation cannot precede its receipt.');
        check(collection.status==='recorded'&&['rent','advance'].includes(String(collection.kind)),'This receipt cannot be allocated.');
        const used=(await sql.query<{receipt:string;due:string}>(`SELECT coalesce(sum(amount_minor) FILTER(WHERE collection_id=$1),0)::text AS receipt,
          coalesce(sum(amount_minor) FILTER(WHERE due_id=$2),0)::text AS due FROM hamdee_private.rent_allocations WHERE collection_id=$1 OR due_id=$2`,[collection.id,due.id])).rows[0];
        check(BigInt(n)+BigInt(used.receipt)<=BigInt(String(collection.amount_minor))&&BigInt(n)+BigInt(used.due)<=BigInt(String(due.amount_minor)),'Allocation exceeds available credit or pending rent.','ALLOCATION_EXCEEDED',409);
        return insert('rent_allocations',{id:randomUUID(),collection_id:collection.id,due_id:due.id,agreement_id:collection.agreement_id,currency:collection.currency,amount_minor:n,allocated_date:allocatedDate,event_id:eventId});
      };
      if(action==='confirm-source-reference'||action==='confirm-occupancy'){
        check((await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.room_occupancy_confirmations') IS NOT NULL AND to_regclass('hamdee_private.source_roster_confirmations') IS NOT NULL AS ready")).rows[0]?.ready,'Owner occupancy confirmation is not enabled in this database.','OCCUPANCY_UNAVAILABLE',503);
        if(action==='confirm-source-reference'){
          await get('tenant',b.tenantId);const sha=text(b.sourceSha256,64),period=month(b.period),reference=text(b.sourceReference,500);
          check(/^[0-9a-f]{64}$/.test(sha),'Use the exact original source SHA-256.');
          await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['source-roster:'+sha+':'+period+':'+b.tenantId+':'+(roomId??'contact')]);
          check(!(await sql.query('SELECT id FROM hamdee_private.source_roster_confirmations WHERE source_sha256=$1 AND period=$2 AND tenant_id=$3 AND room_id IS NOT DISTINCT FROM $4::uuid',[sha,period,b.tenantId,roomId])).rows.length,'This source reference is already confirmed.','SOURCE_ALREADY_CONFIRMED',409);
          data=await insert('source_roster_confirmations',{id:entityId,tenant_id:b.tenantId,room_id:roomId,source_sha256:sha,source_reference:reference,period,notes:text(b.notes??'',1000,false),event_id:eventId});
        }else{
          const effective=date(b.effectiveDate),status=String(b.status);check(['occupied','vacant','unknown'].includes(status),'Choose occupied, vacant or occupancy not verified.');
          check(status==='occupied'?Boolean(b.tenantId):b.tenantId===undefined||b.tenantId===null,'Only an occupied room may have a confirmed tenant.');
          const tenant=status==='occupied'?await get('tenant',b.tenantId):null;
          const previous=(await sql.query<Row>('SELECT * FROM hamdee_private.room_occupancy_confirmations WHERE room_id=$1 ORDER BY version DESC LIMIT 1',[roomId])).rows[0];
          check(Number.isInteger(b.expectedOccupancyVersion)&&b.expectedOccupancyVersion===(previous?.version??0),'Room occupancy changed. Reload before saving.','VERSION_CONFLICT',412);
          check(!previous||effective>=day(previous.effective_date),'A new confirmation cannot predate the latest confirmation. Add a dated correction without rewriting history.','OCCUPANCY_DATE_CONFLICT',409);
          const active=(await sql.query<Row>('SELECT * FROM hamdee_private.rental_agreements WHERE room_id=$1 AND start_date<=$2::date AND (end_date IS NULL OR end_date>=$2::date)',[roomId,effective])).rows;
          check(!active.length||(status==='occupied'&&active.every(a=>a.tenant_id===tenant?.id)),'End conflicting rental terms with an explicit date before changing the occupant or vacancy.','TERMS_CONFLICT',409);
          let agreement=active[0]??null;
          if(b.terms!==undefined&&b.terms!==null){
            check(status==='occupied'&&typeof b.terms==='object'&&!Array.isArray(b.terms),'Only an occupied room may have confirmed rental terms.');
            const terms=b.terms as Row;check(Object.keys(terms).every(k=>['monthlyRent','currency','depositRequired','dueTerms','endDate'].includes(k)),'Unknown rental terms fields.');
            const monthly=money(terms.monthlyRent),deposit=terms.depositRequired===undefined||terms.depositRequired===null?null:money(terms.depositRequired,true),currency=text(terms.currency,3),dueTerms=text(terms.dueTerms,200),end=terms.endDate?date(terms.endDate):null;
            check(/^[A-Z]{3}$/.test(currency)&&(!end||end>=effective),'Check the currency and rental term end date.');
            if(agreement){
              check(String(agreement.monthly_rent_minor)===monthly&&(terms.depositRequired===undefined||(agreement.deposit_required_minor===null?null:String(agreement.deposit_required_minor))===deposit)&&agreement.currency===currency&&agreement.due_terms===dueTerms&&(terms.endDate===undefined||day(agreement.end_date??'')===(end??'')),'Existing rental terms differ. End the old terms and explicitly confirm the replacement.','TERMS_CONFLICT',409);
            }else{
              check(!(await sql.query('SELECT id FROM hamdee_private.rental_agreements WHERE room_id=$1 AND start_date<=coalesce($2::date,\'infinity\'::date) AND coalesce(end_date,\'infinity\'::date)>=$3::date',[roomId,end,effective])).rows.length,'The confirmed term dates overlap existing rental terms.','TERMS_CONFLICT',409);
              agreement=await insert('rental_agreements',{id:randomUUID(),property_id:propertyId,room_id:roomId,tenant_id:tenant!.id,start_date:effective,end_date:end,monthly_rent_minor:monthly,deposit_required_minor:deposit,currency,due_terms:dueTerms,previous_agreement_id:null,event_id:eventId});
            }
          }
          data=await insert('room_occupancy_confirmations',{id:entityId,property_id:propertyId,room_id:roomId,tenant_id:tenant?.id??null,status,effective_date:effective,version:Number(previous?.version??0)+1,notes:text(b.notes??'',1000,false),agreement_id:agreement?.id??null,event_id:eventId});
          data={...data,internal_agreement_id:agreement?.id??null};
        }
      }else if(action==='create-room'||action==='update-room'){
        const code=text(b.code,40).toUpperCase();check(/^[A-Z0-9][A-Z0-9._ -]*$/.test(code),'Use a room code containing letters, numbers, spaces, dots or hyphens.');
        const label=text(b.label??'',200,false);const exists=(await sql.query('SELECT id FROM hamdee_private.rooms WHERE property_id=$1 AND code=$2 AND id<>$3',[propertyId,code,parent?.id??entityId])).rows;
        check(!exists.length,'This property already has that room code.','DUPLICATE_ROOM',409);
        if(action==='create-room'){roomId=entityId;data=await insert('rooms',{id:entityId,property_id:propertyId,code,label,event_id:eventId});}
        else {version(parent!);entityId=String(parent!.id);data=(await sql.query<Row>('UPDATE hamdee_private.rooms SET code=$2,label=$3,version=version+1,event_id=$4 WHERE id=$1 AND version=$5 RETURNING *',[entityId,code,label,eventId,b.expectedVersion])).rows[0];}
      }else if(action==='create-tenant'||action==='update-tenant'){
        const values={name:text(b.name,200),phone:text(b.phone??'',60,false),email:text(b.email??'',254,false),notes:text(b.notes??'',1000,false)};
        check(!values.email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email),'Enter a valid email address.');
        if(action==='create-tenant')data=await insert('tenants',{id:entityId,...values,event_id:eventId});
        else {const tenant=await get('tenant',b.tenantId);await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['tenant:'+tenant.id]);const fresh=await get('tenant',b.tenantId);version(fresh);entityId=String(tenant.id);data=(await sql.query<Row>('UPDATE hamdee_private.tenants SET name=$2,phone=$3,email=$4,notes=$5,version=version+1,event_id=$6 WHERE id=$1 AND version=$7 RETURNING *',[entityId,values.name,values.phone,values.email,values.notes,eventId,b.expectedVersion])).rows[0];}
      }else if(action==='create-agreement'){
        await get('tenant',b.tenantId);const start=date(b.startDate),end=b.endDate?date(b.endDate):null;check(!end||end>=start,'End date must follow the start date.');
        const overlapping=(await sql.query('SELECT id FROM hamdee_private.rental_agreements WHERE room_id=$1 AND start_date<=coalesce($2::date,\'infinity\'::date) AND coalesce(end_date,\'infinity\'::date)>=$3::date',[roomId,end,start])).rows;
        check(!overlapping.length,'This room already has an agreement covering those dates.','AGREEMENT_OVERLAP',409);
        const currency=text(b.currency,3);check(/^[A-Z]{3}$/.test(currency),'Choose an explicit three-letter currency.');
        if(b.previousAgreementId){const previous=await get('agreement',b.previousAgreementId);check(previous.room_id===roomId&&previous.end_date&&day(previous.end_date)<start,'End the previous agreement before renewal.');}
        data=await insert('rental_agreements',{id:entityId,property_id:propertyId,room_id:roomId,tenant_id:id(b.tenantId),start_date:start,end_date:end,monthly_rent_minor:money(b.monthlyRent),deposit_required_minor:money(b.depositRequired,true),currency,due_terms:text(b.dueTerms,200),previous_agreement_id:b.previousAgreementId?id(b.previousAgreementId):null,event_id:eventId});
      }else if(action==='end-agreement'){
        version(parent!);const end=date(b.endDate);check(end>=day(parent!.start_date),'End date must follow the start date.');
        check(!parent!.end_date||end<=day(parent!.end_date),'Renew with a new agreement to extend its terms.');
        entityId=String(parent!.id);data=(await sql.query<Row>('UPDATE hamdee_private.rental_agreements SET end_date=$2,version=version+1,event_id=$3 WHERE id=$1 AND version=$4 RETURNING *',[entityId,end,eventId,b.expectedVersion])).rows[0];
      }else if(action==='issue-due'){
        const period=month(b.period),dueDate=date(b.dueDate);check(dueDate.slice(0,7)===period,'Due date must be in the selected month.');
        if(b.agreementId===undefined)check(money(b.amount)===String(parent!.monthly_rent_minor),'The monthly due must match the owner-confirmed monthly rent. Confirm corrected rental terms before issuing a different amount.','DUE_TERMS_MISMATCH',409);
        if(b.agreementId===undefined)check(dueDate>=day(parent!.start_date)&&(!parent!.end_date||dueDate<=day(parent!.end_date)),'The due date must fall within the confirmed rental terms.','DUE_OUTSIDE_TERMS',409);
        check(day(parent!.start_date).slice(0,7)<=period&&(!parent!.end_date||day(parent!.end_date).slice(0,7)>=period),'Agreement does not cover this month.');
        check(!(await sql.query('SELECT id FROM hamdee_private.rent_dues WHERE agreement_id=$1 AND period=$2',[parent!.id,period])).rows.length,'A due already exists for this agreement and month.','DUPLICATE_DUE',409);
        const tenant=await get('tenant',parent!.tenant_id),room=await get('room',roomId);
        data=await insert('rent_dues',{id:entityId,agreement_id:parent!.id,room_id:roomId,property_id:propertyId,currency:parent!.currency,period,due_date:dueDate,amount_minor:money(b.amount),snapshot:JSON.stringify({agreement:view(parent!),tenantName:tenant.name,roomCode:room.code}),event_id:eventId});
      }else if(action==='record-collection'||action==='refund-deposit'){
        const refund=action==='refund-deposit',kind=refund?'deposit_refund':b.kind;check(['rent','advance','deposit','deposit_refund'].includes(String(kind))&&(!(!refund&&kind==='deposit_refund')),'Choose rent, advance or security deposit.');
        check(['cash','bank','cheque'].includes(String(b.method))&&(!refund||b.method!=='cheque'),'Choose a permitted payment method.');
        const n=money(b.amount),received=date(b.receivedDate),pending=b.method==='cheque';
        check(b.allocations===undefined||Array.isArray(b.allocations),'Check allocations.');const allocations=(b.allocations??[]) as Row[];
        check(allocations.length<=100&&allocations.every(a=>a&&typeof a==='object'&&Object.keys(a).every(k=>['dueId','amount'].includes(k))),'Check allocations.');
        if(kind==='rent'&&!pending)check(allocations.length>0&&allocations.reduce((s,a)=>s+BigInt(money(a.amount)),0n)===BigInt(n),'Allocate the full rent receipt to explicit dues.');
        else check(allocations.length===0,'Deposits, advances and pending cheques are recorded separately.');
        if(refund){
          const movements=(await sql.query<Row>("SELECT received_date,kind,amount_minor FROM hamdee_private.rent_collections WHERE agreement_id=$1 AND status='recorded' AND kind IN ('deposit','deposit_refund')",[parent!.id])).rows;
          const byDay=new Map<string,bigint>();for(const m of movements){const key=day(m.received_date);byDay.set(key,(byDay.get(key)??0n)+(m.kind==='deposit'?1n:-1n)*BigInt(String(m.amount_minor)));}
          byDay.set(received,(byDay.get(received)??0n)-BigInt(n));let balance=0n;
          for(const [,delta] of [...byDay].sort(([a],[b])=>a.localeCompare(b))){balance+=delta;check(balance>=0n,'Refund exceeds the deposit available on its date.','DEPOSIT_EXCEEDED',409);}
        }
        data=await insert('rent_collections',{id:entityId,agreement_id:parent!.id,room_id:roomId,property_id:propertyId,currency:parent!.currency,kind,method:b.method,amount_minor:n,received_date:received,reference:text(b.reference??'',200,false),status:pending?'pending':'recorded',event_id:eventId});
        for(const a of allocations)await allocate(data,a.dueId,a.amount,received);
      }else {
        check(parent!.kind==='advance','Choose an advance receipt.');data=await allocate(parent!,b.dueId,b.amount,b.allocationDate);entityId=String(data.id);
      }
      check(data!,'This record changed. Reload before saving.','VERSION_CONFLICT',412);
      await insert('rental_events',{id:eventId,property_id:propertyId,room_id:roomId,entity_id:entityId,action,detail:JSON.stringify({fields:Object.keys(b).filter(k=>k!=='action'),requestId,...(action.includes('room')?{code:data!.code,label:data!.label}:{}),...(action.includes('agreement')?{startDate:data!.start_date,endDate:data!.end_date}: {})}),actor_id:actorId});
      const result={data:view(data!),replay:false};await insert('rental_commands',{actor_id:actorId,key,digest,result:JSON.stringify(result)});return result;
    });
  }
}
