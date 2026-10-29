/** Minimal LOCAL car records v1. No HTTP/UI/runtime hookup is registered.
 * Proposed GET /api/hamdee/v1/car-rentals -> overview(identity, query)
 * POST /api/hamdee/v1/car-rentals/commands -> mutate(identity, body, key, requestId)
 * Keep existing owner/password, CSRF/Origin, no-store and safe error handling.
 * Money is decimal MAJOR-unit strings. agreedAmount is the explicit TOTAL for
 * this saved rental term; billingPeriod is a required descriptive label, never
 * multiplied. No proration, tariffs, automatic billing, refunds or returns.
 * Availability uses inclusive saved rental dates and current vehicle status.
 */
export type VehicleStatus='active'|'maintenance'|'inactive'|'needs_confirmation';
export interface VehicleRecord {id:string;registration:string|null;make:string|null;model:string;status:VehicleStatus;notes:string;version:number}
export interface CarAgreementRecord {id:string;vehicleId:string;agreementKey:string;customerName:string;customerContact:string;startDate:string;endDate:string;agreedAmount:string;currency:string;billingPeriod:string;reference:string;notes:string;previousAgreementId:string|null;vehicleSnapshot:VehicleRecord}
export interface CarReceiptRecord {id:string;agreementId:string;vehicleId:string;receiptKey:string;receivedDate:string;amount:string;currency:string;method:'cash'|'bank'|'cheque';status:'recorded'|'pending';reference:string;notes:string}
export interface CarExpenseRecord {id:string;vehicleId:string;agreementId:string|null;expenseKey:string;expenseDate:string;amount:string;currency:string;kind:'expense'|'maintenance';description:string;vendorName:string;reference:string;notes:string}
export type CarCommand=
 | {action:'create-vehicle';registration:string|null;make:string|null;model:string;status:VehicleStatus;notes?:string;sourceKey?:string;sourceReference?:string}
 | {action:'update-vehicle';vehicleId:string;expectedVersion:number;registration?:string|null;make?:string|null;model?:string;status?:VehicleStatus;notes?:string}
 | {action:'add-source-reference';vehicleId:string;sourceKey:string;sourceReference:string;amountReference?:string}
 | {action:'create-agreement';vehicleId:string;agreementKey:string;customerName:string;customerContact?:string;startDate:string;endDate:string;agreedAmount:string;currency:string;billingPeriod:string;reference?:string;notes?:string;previousAgreementId?:string}
 | {action:'record-collection';agreementId:string;receiptKey:string;receivedDate:string;amount:string;currency:string;method:'cash'|'bank'|'cheque';reference?:string;notes?:string}
 | {action:'record-expense'|'record-maintenance';vehicleId:string;agreementId?:string;expenseKey:string;expenseDate:string;amount:string;currency:string;description:string;vendorName?:string;reference?:string;notes?:string};
export interface CarQuery {month:string;asOf:string;vehicleId?:string;availabilityStart?:string;availabilityEnd?:string}
export interface CarAvailability {vehicleId:string;startDate:string;endDate:string;available:boolean;reason:'available'|'maintenance'|'inactive'|'rented'|'needs_confirmation';agreementIds:string[]}
export interface CarBalance {agreementId:string;vehicleId:string;currency:string;agreedAmount:string;collectedAmount:string;outstandingAmount:string;pendingChequeAmount:string}
export interface CarMonthlyTotal {vehicleId:string;currency:string;cashCollected:string;recordedCosts:string;recordedComparison:string;pendingCheques:string}
export interface CarOverview {vehicles:VehicleRecord[];agreements:CarAgreementRecord[];availability:CarAvailability[];balances:CarBalance[];collections:CarReceiptRecord[];expenses:CarExpenseRecord[];history:Record<string,unknown>[];summary:CarMonthlyTotal[];month:string;asOf:string;moneyUnit:'decimal-major-unit-strings';basis:string}
export interface CarMutationResult {data:VehicleRecord|CarAgreementRecord|CarReceiptRecord|CarExpenseRecord;replay:boolean}

import type { Identity } from './auth';
import type { Sql } from './database';
import type { SourceReceipt,ReceiptListQuery } from './staff-collections';
import { PropertyService } from './service';
import { randomUUID } from 'node:crypto';
import { date,id,text,month,day } from './rental';
import { allowFields,operationCheck as check,operationWrite,operationView,insertOperation,exactAmount,explicitCurrency,
 localReceiptReader,type ReceiptSourceReader,type OperationRow } from './company-finance';

async function vehicle(sql:Sql,value:unknown):Promise<OperationRow>{const row=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.car_vehicles WHERE id=$1',[id(value)])).rows[0];check(row,'Vehicle not found.','NOT_FOUND',404);return row;}
async function agreement(sql:Sql,value:unknown):Promise<OperationRow>{const row=(await sql.query<OperationRow>('SELECT *,agreed_amount::text AS agreed_amount FROM hamdee_private.car_agreements WHERE id=$1',[id(value)])).rows[0];check(row,'Car agreement not found.','NOT_FOUND',404);return row;}
function status(value:unknown):VehicleStatus {check(['active','maintenance','inactive','needs_confirmation'].includes(String(value)),'Choose an explicit vehicle status.');return value as VehicleStatus;}

export class CarRentalService {
 constructor(private readonly properties:PropertyService){}
 async mutate(identity:Identity,input:unknown,key:string,requestId:string):Promise<CarMutationResult>{
  const b=allowFields(input,{'create-vehicle':['registration','make','model','status','notes','sourceKey','sourceReference'],'update-vehicle':['vehicleId','expectedVersion','registration','make','model','status','notes'],
   'add-source-reference':['vehicleId','sourceKey','sourceReference','amountReference'],
   'create-agreement':['vehicleId','agreementKey','customerName','customerContact','startDate','endDate','agreedAmount','currency','billingPeriod','reference','notes','previousAgreementId'],
   'record-collection':['agreementId','receiptKey','receivedDate','amount','currency','method','reference','notes'],
   'record-expense':['vehicleId','agreementId','expenseKey','expenseDate','amount','currency','description','vendorName','reference','notes'],
   'record-maintenance':['vehicleId','agreementId','expenseKey','expenseDate','amount','currency','description','vendorName','reference','notes']});
  return await operationWrite(this.properties,identity,'cars',b,key,requestId,async(sql,_actor,eventId)=>{
   let row:OperationRow;
   if(b.action==='create-vehicle'||b.action==='update-vehicle'){
    const current=b.action==='update-vehicle'?await vehicle(sql,b.vehicleId):null;
    if(current){check(Number.isSafeInteger(b.expectedVersion)&&b.expectedVersion===current.version,'Reload and review the current vehicle revision.','VERSION_CONFLICT',412);check(['registration','make','model','status','notes'].some(k=>k in b),'Enter vehicle changes.');}
    const suppliedRegistration='registration' in b?b.registration:current?.registration;
    const registration=suppliedRegistration==null||suppliedRegistration===''?null:text(suppliedRegistration,80).toUpperCase();
    const suppliedMake='make' in b?b.make:current?.make;
    const make=suppliedMake==null||suppliedMake===''?null:text(suppliedMake,120);
    if(registration)check(!(await sql.query('SELECT id FROM hamdee_private.car_vehicles WHERE registration=$1 AND ($2::uuid IS NULL OR id<>$2)',[registration,current?.id??null])).rows.length,'This registration is already recorded.','DUPLICATE_VEHICLE',409);
    const values={registration,make,model:text('model' in b?b.model:current?.model,120),status:status('status' in b?b.status:current?.status),notes:text('notes' in b?b.notes:current?.notes??'',2000,false)};
    const hasSource=b.sourceKey!==undefined||b.sourceReference!==undefined;
    if(!registration||!make||values.status==='needs_confirmation'||hasSource)check((await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.car_source_references') IS NOT NULL AS ready")).rows[0].ready,'Vehicle source records are not enabled yet.','CAR_SOURCE_UNAVAILABLE',503);
    if(hasSource){
      check(!current&&values.status==='needs_confirmation','Source vehicles require an unconfirmed status.');
      check(!(await sql.query('SELECT id FROM hamdee_private.car_vehicles WHERE lower(trim(model))=lower(trim($1))',[values.model])).rows.length,'A vehicle with this model already exists. Review it before importing this source.','SOURCE_VEHICLE_REVIEW',409);
      check(!(await sql.query('SELECT id FROM hamdee_private.car_source_references WHERE source_key=$1',[text(b.sourceKey,240)])).rows.length,'This source reference is already recorded.','DUPLICATE_SOURCE',409);
    }
    if(current){row=(await sql.query<OperationRow>(`UPDATE hamdee_private.car_vehicles SET registration=$2,make=$3,model=$4,status=$5,notes=$6,version=version+1,event_id=$7 WHERE id=$1 AND version=$8 RETURNING *`,[current.id,values.registration,values.make,values.model,values.status,values.notes,eventId,b.expectedVersion])).rows[0];check(row,'Reload the current vehicle revision.','VERSION_CONFLICT',412);}
    else row=await insertOperation(sql,'car_vehicles',{id:randomUUID(),...values,version:1,event_id:eventId});
    await insertOperation(sql,'car_vehicle_revisions',{vehicle_id:row.id,version:row.version,profile:JSON.stringify(operationView(row)),event_id:eventId});
    if(hasSource)await insertOperation(sql,'car_source_references',{id:randomUUID(),vehicle_id:row.id,source_key:text(b.sourceKey,240),source_reference:text(b.sourceReference,1000),amount_reference:'',event_id:eventId});
   }else if(b.action==='add-source-reference'){
    check((await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.car_source_references') IS NOT NULL AS ready")).rows[0].ready,'Vehicle source records are not enabled yet.','CAR_SOURCE_UNAVAILABLE',503);
    const v=await vehicle(sql,b.vehicleId),sourceKey=text(b.sourceKey,240);
    check(!(await sql.query('SELECT id FROM hamdee_private.car_source_references WHERE source_key=$1',[sourceKey])).rows.length,'This source reference is already recorded.','DUPLICATE_SOURCE',409);
    row=await insertOperation(sql,'car_source_references',{id:randomUUID(),vehicle_id:v.id,source_key:sourceKey,source_reference:text(b.sourceReference,1000),amount_reference:text(b.amountReference??'',100,false),event_id:eventId});
   }else if(b.action==='create-agreement'){
    const v=await vehicle(sql,b.vehicleId),agreementKey=id(b.agreementKey),start=date(b.startDate),end=date(b.endDate);
    check(end>=start,'Rental end date must not precede its start.');
    check(!(await sql.query('SELECT id FROM hamdee_private.car_agreements WHERE agreement_key=$1',[agreementKey])).rows.length,'This agreement identity is already recorded.','DUPLICATE_AGREEMENT',409);
    const previous=b.previousAgreementId?await agreement(sql,b.previousAgreementId):null;
    if(previous)check(previous.vehicle_id===v.id&&day(previous.end_date)<start,'A renewal must follow the previous term for this vehicle.','INVALID_RENEWAL',409);
    check(v.status==='active','Mark this vehicle active before recording a new rental.','VEHICLE_UNAVAILABLE',409);
    check(!(await sql.query('SELECT id FROM hamdee_private.car_agreements WHERE vehicle_id=$1 AND start_date<=$3::date AND end_date>=$2::date',[v.id,start,end])).rows.length,'This vehicle already has a rental in the inclusive date range.','VEHICLE_UNAVAILABLE',409);
    row=await insertOperation(sql,'car_agreements',{id:randomUUID(),vehicle_id:v.id,agreement_key:agreementKey,customer_name:text(b.customerName,200),customer_contact:text(b.customerContact??'',500,false),
     start_date:start,end_date:end,agreed_amount:exactAmount(b.agreedAmount,true),currency:explicitCurrency(b.currency),billing_period:text(b.billingPeriod,120),reference:text(b.reference??'',200,false),notes:text(b.notes??'',2000,false),previous_agreement_id:previous?.id??null,vehicle_snapshot:JSON.stringify(operationView(v)),event_id:eventId});
   }else if(b.action==='record-collection'){
    const a=await agreement(sql,b.agreementId),receiptKey=id(b.receiptKey),currency=explicitCurrency(b.currency),amount=exactAmount(b.amount),when=date(b.receivedDate);
    check(currency===a.currency,'Receipt currency must match the explicit agreed currency.','CURRENCY_MISMATCH',409);
    check(['cash','bank','cheque'].includes(String(b.method)),'Choose cash, bank or a pending cheque.');
    check(!(await sql.query('SELECT id FROM hamdee_private.car_receipts WHERE receipt_key=$1',[receiptKey])).rows.length,'This receipt identity is already recorded.','DUPLICATE_RECEIPT',409);
    if(b.method!=='cheque'){
     const allowed=(await sql.query<{ok:boolean}>(`SELECT coalesce(sum(amount),0)+$2::numeric<=$3::numeric AS ok FROM hamdee_private.car_receipts WHERE agreement_id=$1 AND status='recorded'`,[a.id,amount,a.agreed_amount])).rows[0].ok;
     check(allowed,'This collection exceeds the entered agreed total remaining for this term.','CAR_COLLECTION_EXCEEDED',409);
    }
    row=await insertOperation(sql,'car_receipts',{id:randomUUID(),agreement_id:a.id,vehicle_id:a.vehicle_id,receipt_key:receiptKey,received_date:when,amount,currency,method:b.method,status:b.method==='cheque'?'pending':'recorded',reference:text(b.reference??'',200,false),notes:text(b.notes??'',2000,false),event_id:eventId});
   }else{
    const v=await vehicle(sql,b.vehicleId),expenseKey=id(b.expenseKey),a=b.agreementId?await agreement(sql,b.agreementId):null;
    check(!a||a.vehicle_id===v.id,'This agreement belongs to another vehicle.','VEHICLE_AGREEMENT_MISMATCH',409);
    check(!(await sql.query('SELECT id FROM hamdee_private.car_expenses WHERE expense_key=$1',[expenseKey])).rows.length,'This actual expense/maintenance identity is already recorded.','DUPLICATE_EXPENSE',409);
    row=await insertOperation(sql,'car_expenses',{id:randomUUID(),vehicle_id:v.id,agreement_id:a?.id??null,expense_key:expenseKey,expense_date:date(b.expenseDate),amount:exactAmount(b.amount,true),currency:explicitCurrency(b.currency),kind:b.action==='record-maintenance'?'maintenance':'expense',description:text(b.description,2000),vendor_name:text(b.vendorName??'',200,false),reference:text(b.reference??'',200,false),notes:text(b.notes??'',2000,false),event_id:eventId});
   }
   return operationView(row);
  }) as unknown as CarMutationResult;
 }
 async overview(identity:Identity,query:CarQuery):Promise<CarOverview>{
  const period=month(query.month),asOf=date(query.asOf),vehicleId=query.vehicleId?id(query.vehicleId):null;
  const availabilityStart=query.availabilityStart?date(query.availabilityStart):asOf,availabilityEnd=query.availabilityEnd?date(query.availabilityEnd):availabilityStart;
  check(availabilityEnd>=availabilityStart,'Availability end date must not precede its start.');
  return this.properties.ownerContext(identity,async sql=>{
   if(vehicleId)await vehicle(sql,vehicleId);
   const data=(await sql.query<{data:OperationRow}>(`WITH receipts AS(SELECT * FROM hamdee_private.car_receipts WHERE received_date<=$1::date AND ($2::uuid IS NULL OR vehicle_id=$2)),
    expenses AS(SELECT * FROM hamdee_private.car_expenses WHERE expense_date<=$1::date AND ($2::uuid IS NULL OR vehicle_id=$2)),
    keys AS(SELECT vehicle_id,currency FROM receipts UNION SELECT vehicle_id,currency FROM expenses),
    amounts AS(SELECT k.vehicle_id,k.currency,
     coalesce((SELECT sum(amount) FROM receipts r WHERE r.vehicle_id=k.vehicle_id AND r.currency=k.currency AND r.status='recorded' AND to_char(r.received_date,'YYYY-MM')=$3),0) AS cash_collected,
     coalesce((SELECT sum(amount) FROM receipts r WHERE r.vehicle_id=k.vehicle_id AND r.currency=k.currency AND r.status='pending' AND to_char(r.received_date,'YYYY-MM')=$3),0) AS pending_cheques,
     coalesce((SELECT sum(amount) FROM expenses e WHERE e.vehicle_id=k.vehicle_id AND e.currency=k.currency AND to_char(e.expense_date,'YYYY-MM')=$3),0) AS recorded_costs FROM keys k)
    SELECT jsonb_build_object(
     'sourceAvailable',to_regclass('hamdee_private.car_source_references') IS NOT NULL,
     'availability',coalesce((SELECT jsonb_agg(jsonb_build_object('vehicleId',v.id,'startDate',$4::text,'endDate',$5::text,
      'available',v.status='active' AND NOT EXISTS(SELECT 1 FROM hamdee_private.car_agreements a WHERE a.vehicle_id=v.id AND a.start_date<=$5::date AND a.end_date>=$4::date),
      'reason',CASE WHEN v.status<>'active' THEN v.status WHEN EXISTS(SELECT 1 FROM hamdee_private.car_agreements a WHERE a.vehicle_id=v.id AND a.start_date<=$5::date AND a.end_date>=$4::date) THEN 'rented' ELSE 'available' END,
      'agreementIds',coalesce((SELECT jsonb_agg(a.id ORDER BY a.start_date,a.id) FROM hamdee_private.car_agreements a WHERE a.vehicle_id=v.id AND a.start_date<=$5::date AND a.end_date>=$4::date),'[]'::jsonb)) ORDER BY v.id)
      FROM hamdee_private.car_vehicles v WHERE ($2::uuid IS NULL OR v.id=$2)),'[]'::jsonb),
     'balances',coalesce((SELECT jsonb_agg(jsonb_build_object('agreementId',a.id,'vehicleId',a.vehicle_id,'currency',a.currency,'agreedAmount',a.agreed_amount::text,
      'collectedAmount',coalesce((SELECT sum(r.amount) FROM receipts r WHERE r.agreement_id=a.id AND r.status='recorded'),0)::text,
      'outstandingAmount',(a.agreed_amount-coalesce((SELECT sum(r.amount) FROM receipts r WHERE r.agreement_id=a.id AND r.status='recorded'),0))::text,
      'pendingChequeAmount',coalesce((SELECT sum(r.amount) FROM receipts r WHERE r.agreement_id=a.id AND r.status='pending'),0)::text) ORDER BY a.start_date,a.id)
      FROM hamdee_private.car_agreements a WHERE ($2::uuid IS NULL OR a.vehicle_id=$2)),'[]'::jsonb),
     'vehicles',coalesce((SELECT jsonb_agg(to_jsonb(v)-'event_id' ORDER BY id) FROM hamdee_private.car_vehicles v WHERE ($2::uuid IS NULL OR id=$2)),'[]'::jsonb),
     'agreements',coalesce((SELECT jsonb_agg(to_jsonb(a)-'event_id'-'agreed_amount'||jsonb_build_object('agreed_amount',a.agreed_amount::text) ORDER BY start_date,id) FROM hamdee_private.car_agreements a WHERE ($2::uuid IS NULL OR vehicle_id=$2)),'[]'::jsonb),
     'collections',coalesce((SELECT jsonb_agg(to_jsonb(r)-'event_id'-'amount'||jsonb_build_object('amount',r.amount::text) ORDER BY received_date,id) FROM receipts r),'[]'::jsonb),
     'expenses',coalesce((SELECT jsonb_agg(to_jsonb(e)-'event_id'-'amount'||jsonb_build_object('amount',e.amount::text) ORDER BY expense_date,id) FROM expenses e),'[]'::jsonb),
     'summary',coalesce((SELECT jsonb_agg(jsonb_build_object('vehicleId',vehicle_id,'currency',currency,'cashCollected',cash_collected::text,'pendingCheques',pending_cheques::text,'recordedCosts',recorded_costs::text,'recordedComparison',(cash_collected-recorded_costs)::text) ORDER BY vehicle_id,currency) FROM amounts),'[]'::jsonb),
     'history',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY occurred_at,id) FROM hamdee_private.ops_events e WHERE action LIKE 'cars:%' AND ($2::uuid IS NULL OR e.detail->'data'->>'vehicleId'=$2::text OR e.detail->'data'->>'id'=$2::text)),'[]'::jsonb)) AS data`,[asOf,vehicleId,period,availabilityStart,availabilityEnd])).rows[0].data;
   const sourceAvailable=Boolean(data.sourceAvailable);
   const sourceReferences=sourceAvailable?(await sql.query<OperationRow>('SELECT id,vehicle_id,source_key,source_reference,amount_reference FROM hamdee_private.car_source_references WHERE ($1::uuid IS NULL OR vehicle_id=$1) ORDER BY id',[vehicleId])).rows.map(operationView):[];
   return {vehicles:(data.vehicles as OperationRow[]).map(operationView),agreements:(data.agreements as OperationRow[]).map(operationView),availability:data.availability,balances:data.balances,collections:(data.collections as OperationRow[]).map(operationView),expenses:(data.expenses as OperationRow[]).map(operationView),history:(data.history as OperationRow[]).map(operationView),summary:data.summary,sourceAvailable,sourceReferences,
    month:period,asOf,moneyUnit:'decimal-major-unit-strings',basis:'Monthly recorded cash/bank collections minus entered vehicle costs through asOf, separately by currency. Pending cheques are excluded from cash. This comparison is not profit, proration, a tariff or an automatic company ledger posting.'} as unknown as CarOverview;
  });
 }
}

export interface CarSourceReceipt extends SourceReceipt {vehicleId:string;vehicleRegistration:string}
export async function readCarReceipt(sql:Sql,receiptId:string):Promise<CarSourceReceipt|null>{
 if(!(await sql.query<{present:boolean}>("SELECT to_regclass('hamdee_private.car_receipts') IS NOT NULL AS present")).rows[0].present)return null;
 const r=(await sql.query<OperationRow>(`SELECT r.*,r.amount::text AS amount,a.customer_name,a.vehicle_snapshot FROM hamdee_private.car_receipts r JOIN hamdee_private.car_agreements a ON a.id=r.agreement_id WHERE r.id=$1`,[id(receiptId)])).rows[0];
 if(!r)return null;return {kind:'car-rental',id:String(r.id),date:day(r.received_date),amount:String(r.amount),currency:String(r.currency),method:r.method as CarSourceReceipt['method'],status:r.status as CarSourceReceipt['status'],classification:'car-rental',disposition:'unassigned',agreementId:String(r.agreement_id),customerLabel:String(r.customer_name),vehicleId:String(r.vehicle_id),vehicleRegistration:String((r.vehicle_snapshot as OperationRow).registration??'')};
}
/** Inject this into existing StaffCollectionsService/CompanyFinanceService
 * constructors only during a separately authorized integration. Both existing
 * property/classified receipts and immutable car receipts remain authoritative.
 * Each child returns its first N keys AFTER the same global cursor; merge then
 * truncate once so a large source cannot hide receipts in another source.
 */
export const combinedReceiptSourceReader:ReceiptSourceReader={
 read(sql,kind,receiptId){return kind==='car-rental'?readCarReceipt(sql,receiptId):localReceiptReader.read(sql,kind,receiptId);},
 async list(sql,query:ReceiptListQuery){
  const limit=query.limit??101;check(Number.isInteger(limit)&&limit>=1&&limit<=101,'Invalid receipt page size.','INVALID_RECEIPT_CURSOR',400);
  const base=await localReceiptReader.list(sql,{...query,limit});if(query.propertyId)return base;
  if(!(await sql.query<{present:boolean}>("SELECT to_regclass('hamdee_private.car_receipts') IS NOT NULL AS present")).rows[0].present)return base;
  const keys=(await sql.query<{id:string}>(`SELECT id FROM hamdee_private.car_receipts WHERE received_date<=$1::date
   AND ($2::text IS NULL OR ('car-rental'::text COLLATE "C",received_date,id)>($2::text COLLATE "C",$3::date,$4::uuid))
   ORDER BY received_date,id LIMIT $5`,[date(query.asOf),query.after?.kind??null,query.after?.date??null,query.after?.id??null,limit])).rows;
  const cars:SourceReceipt[]=[];for(const key of keys){const r=await readCarReceipt(sql,key.id);check(r,'Car receipt page changed; reload the picker.','SOURCE_CHANGED',409);cars.push(r);}
  return [...base,...cars].sort((a,b)=>{for(const key of ['kind','date','id'] as const){if(a[key]<b[key])return -1;if(a[key]>b[key])return 1;}return 0;}).slice(0,limit);
 }
};
