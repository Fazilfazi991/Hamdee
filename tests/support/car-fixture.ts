import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './operations-fixture';
import { CarRentalService,combinedReceiptSourceReader } from '../../src/car-rentals';
import { StaffCollectionsService } from '../../src/staff-collections';
import { CompanyFinanceService,type OperationRow } from '../../src/company-finance';
export const carMigration=()=>readFile(new URL('../../migrations/007_local_car_rentals.up.sql',import.meta.url),'utf8');
export async function carFixture(persistent=false){
 const f=await operationsFixture(persistent);await f.pg.transaction(async tx=>{await tx.exec(await carMigration());});
 const cars=new CarRentalService(f.properties),staff=new StaffCollectionsService(f.properties,combinedReceiptSourceReader),finance=new CompanyFinanceService(f.properties,combinedReceiptSourceReader);
 const writeCar=async(body:unknown,key:string=randomUUID())=>(await cars.mutate(f.identity,body,key,randomUUID())).data as unknown as OperationRow;
 const writeStaff=async(body:unknown,key:string=randomUUID())=>(await staff.mutate(f.identity,body,key,randomUUID())).data as unknown as OperationRow;
 const writeFinance=async(body:unknown,key:string=randomUUID())=>(await finance.mutate(f.identity,body,key,randomUUID())).data as unknown as OperationRow;
 const vehicle=(fields:OperationRow={})=>writeCar({action:'create-vehicle',registration:'SYNTH-'+randomUUID().slice(0,8),make:'Synthetic make',model:'Synthetic model',status:'active',...fields});
 const agreement=(vehicleId:unknown,fields:OperationRow={})=>writeCar({action:'create-agreement',vehicleId,agreementKey:randomUUID(),customerName:'Synthetic car customer',customerContact:'customer@example.invalid',startDate:'2026-10-01',endDate:'2026-10-31',agreedAmount:'1000',currency:'XTS',billingPeriod:'Explicit total for October term',...fields});
 const collection=(agreementId:unknown,fields:OperationRow={})=>writeCar({action:'record-collection',agreementId,receiptKey:randomUUID(),receivedDate:'2026-10-15',amount:'100',currency:'XTS',method:'cash',reference:'SYNTHETIC',...fields});
 const expense=(vehicleId:unknown,fields:OperationRow={})=>writeCar({action:'record-expense',vehicleId,expenseKey:randomUUID(),expenseDate:'2026-10-15',amount:'10',currency:'XTS',description:'Synthetic vehicle cost',...fields});
 const collectCar=(collectorId:unknown,sourceId:unknown,fields:OperationRow={})=>writeStaff({action:'record-collection',collectorId,sourceKind:'car-rental',sourceId,disposition:'collector-held',ownerConfirmedDisposition:true,...fields});
 return {...f,cars,staff,finance,writeCar,writeStaff,writeFinance,vehicle,agreement,collection,expense,collectCar};
}
// Bulk immutable source documents for a >100-item composed-picker regression.
export async function seedCarReceiptChoices(f:Awaited<ReturnType<typeof carFixture>>,agreement:OperationRow,count:number){
 const rows=Array.from({length:count},(_,i)=>({id:randomUUID(),receiptKey:randomUUID(),eventId:randomUUID(),date:i%2?'2026-10-15':'2026-10-01'}));
 await f.pg.transaction(async tx=>{
  const input=JSON.stringify(rows.map(r=>({...r,receipt_key:r.receiptKey,event_id:r.eventId})));
  await tx.query(`INSERT INTO hamdee_private.ops_events(id,actor_id,action,detail)
   SELECT r.event_id,$2,'cars:record-collection',jsonb_build_object('data',jsonb_build_object('id',r.id)) FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,event_id uuid)`,[input,f.users.admin.id]);
  await tx.query(`INSERT INTO hamdee_private.car_receipts(id,agreement_id,vehicle_id,receipt_key,received_date,amount,currency,method,status,reference,event_id)
   SELECT r.id,$2,$3,r.receipt_key,r.date,1,$4,'cash','recorded','SYNTHETIC-PAGINATION',r.event_id FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,event_id uuid,receipt_key uuid,date date)`,[input,agreement.id,agreement.vehicleId,agreement.currency]);
 });return rows.map(r=>({kind:'car-rental',id:r.id,date:r.date}));
}
