import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fixture,adapter,issuer } from './fixture';
import { PropertyService } from '../../src/service';
import { RentalService } from '../../src/rental';
import { StaffCollectionsService } from '../../src/staff-collections';
import { CompanyFinanceService,type OperationRow } from '../../src/company-finance';
export const operationsMigration=()=>readFile(new URL('../../migrations/006_local_operations_records.up.sql',import.meta.url),'utf8');
export async function operationsFixture(persistent=false){
 const f=await fixture(persistent);await f.pg.transaction(async tx=>{await tx.exec(await operationsMigration());});
 const identity={issuer,subject:f.users.admin.subject},properties=new PropertyService(adapter(f.pg),identity);
 const staff=new StaffCollectionsService(properties),finance=new CompanyFinanceService(properties),rental=new RentalService(properties);
 const writeStaff=async(body:unknown,key:string=randomUUID())=>(await staff.mutate(identity,body,key,randomUUID())).data as unknown as OperationRow;
 const writeFinance=async(body:unknown,key:string=randomUUID())=>(await finance.mutate(identity,body,key,randomUUID())).data as unknown as OperationRow;
 const collector=()=>writeStaff({action:'create-collector',name:'Synthetic collector',phone:'TEST-ONLY',notes:'Synthetic contact; no account'});
 const account=(fields:OperationRow={})=>writeFinance({action:'create-account',name:'Synthetic company cash',scope:'company',kind:'cash',currency:'XTS',openingDate:'2026-10-01',openingAmount:'0',ownerConfirmedOpening:true,...fields});
 const receipt=(fields:OperationRow={})=>writeFinance({action:'create-classified-receipt',receiptKey:randomUUID(),classification:'synthetic-other-receipt',receivedOn:'2026-10-15',amount:'100',currency:'XTS',method:'cash',reference:'SYNTHETIC',...fields});
 const collect=(collectorId:unknown,sourceId:unknown,fields:OperationRow={})=>writeStaff({action:'record-collection',collectorId,sourceKind:'classified-receipt',sourceId,disposition:'collector-held',ownerConfirmedDisposition:true,...fields});
 const handover=(collectorId:unknown,accountId:unknown,fields:OperationRow={})=>writeStaff({action:'handover',collectorId,accountId,amount:'30',currency:'XTS',handedOn:'2026-10-16',reference:'SYNTHETIC-'+randomUUID(),...fields});
 const rentSource=async(kind='advance',method='cash')=>{
  const p=await f.create(),write=async(body:unknown)=>((await rental.mutate(identity,body,randomUUID(),randomUUID())) as {data:OperationRow}).data;
  const room=await write({action:'create-room',propertyId:p.id,code:'SYN-'+randomUUID().slice(0,6),label:'Synthetic room'}),tenant=await write({action:'create-tenant',name:'Synthetic tenant'});
  const agreement=await write({action:'create-agreement',roomId:room.id,tenantId:tenant.id,startDate:'2026-10-01',endDate:null,monthlyRent:'100',currency:'XTS',depositRequired:'0',dueTerms:'Explicit synthetic record only'});
  const due=kind==='rent'&&method!=='cheque'?await write({action:'issue-due',agreementId:agreement.id,period:'2026-10',dueDate:'2026-10-15',amount:'100'}):null;
  return write({action:'record-collection',agreementId:agreement.id,kind,method,amount:'100',receivedDate:'2026-10-15',...(due?{allocations:[{dueId:due.id,amount:'100'}]}:{})});
 };
 return {...f,identity,properties,staff,finance,rental,writeStaff,writeFinance,collector,account,receipt,collect,handover,rentSource};
}

// Bulk synthetic source documents for pagination tests only. Every receipt
// retains its own required audit event; no source schema or business rule changes.
export async function seedRentReceiptChoices(f:Awaited<ReturnType<typeof operationsFixture>>,template:OperationRow,count:number,onlyDate?:string){
 const rows=Array.from({length:count},(_,i)=>({id:randomUUID(),eventId:randomUUID(),date:onlyDate??['2026-10-01','2026-10-15','2026-10-30'][i%3]}));
 await f.pg.transaction(async tx=>{
  await tx.query(`INSERT INTO hamdee_private.rental_events(id,property_id,room_id,entity_id,action,detail,actor_id)
   SELECT r.event_id,$2,$3,r.id,'record-collection','{"syntheticPagination":true}'::jsonb,$4
   FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,event_id uuid,date date)`,[JSON.stringify(rows.map(r=>({id:r.id,event_id:r.eventId,date:r.date}))),template.propertyId,template.roomId,f.users.admin.id]);
  await tx.query(`INSERT INTO hamdee_private.rent_collections(id,agreement_id,room_id,property_id,currency,kind,method,amount_minor,received_date,reference,status,event_id)
   SELECT r.id,$2,$3,$4,$5,'advance','cash',$6,r.date,'SYNTHETIC-PAGINATION','recorded',r.event_id
   FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,event_id uuid,date date)`,[JSON.stringify(rows.map(r=>({id:r.id,event_id:r.eventId,date:r.date}))),template.agreementId,template.roomId,template.propertyId,template.currency,template.amountMinor]);
 });return rows.map(r=>({kind:'property-rent' as const,id:r.id,date:r.date}));
}
export async function seedClassifiedReceiptChoices(f:Awaited<ReturnType<typeof operationsFixture>>,sharedId:string){
 const rows=[{id:sharedId,eventId:randomUUID(),receiptKey:randomUUID(),date:'2026-10-01',method:'cash'},
  {id:randomUUID(),eventId:randomUUID(),receiptKey:randomUUID(),date:'2026-10-31',method:'cheque'}];
 await f.pg.transaction(async tx=>{
  const input=JSON.stringify(rows.map(r=>({...r,event_id:r.eventId,receipt_key:r.receiptKey})));
  await tx.query(`INSERT INTO hamdee_private.ops_events(id,actor_id,action,detail)
   SELECT r.event_id,$2,'finance:create-classified-receipt','{"syntheticPagination":true}'::jsonb
   FROM jsonb_to_recordset($1::jsonb) AS r(event_id uuid)`,[input,f.users.admin.id]);
  await tx.query(`INSERT INTO hamdee_private.ops_receipts(id,receipt_key,classification,received_date,amount,currency,method,status,reference,event_id)
   SELECT r.id,r.receipt_key,'synthetic-pagination',r.date,1,'XTS',r.method,CASE WHEN r.method='cheque' THEN 'pending' ELSE 'recorded' END,'SYNTHETIC-PAGINATION',r.event_id
   FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,event_id uuid,receipt_key uuid,date date,method text)`,[input]);
 });return rows.map(r=>({kind:'classified-receipt' as const,id:r.id,date:r.date}));
}
