import {randomUUID} from 'node:crypto';
import type {Identity} from './auth';
import {PropertyService} from './service';
import {id,text} from './rental';
import {allowFields,operationCheck as check,operationWrite,operationView,insertOperation,exactAmount,explicitCurrency} from './company-finance';
type Row=Record<string,unknown>;
const kinds=['landlord-terms','utility-account','utility-schedule','policy','investment','asset','other-reference'];
const profileFields=['kind','label','propertyId','roomId','vehicleId','customerId','sourceReference','originalWording','notes','details','reviewQuestions','status'];
const optional=(value:unknown,max:number)=>text(value??'',max,false);
function detail(input:unknown){
 check(input&&typeof input==='object'&&!Array.isArray(input),'Enter supporting details.');const fields=input as Row;
 const allowed=['dueDayReference','frequency','serviceReference','location','sourceDateReference','sourceOrder','amount','currency','premium','contribution','paidAmount','valuationReference','classification'];
 check(Object.keys(fields).every(k=>allowed.includes(k)),'Unknown supporting detail fields.');
 if(fields.sourceOrder!==undefined&&fields.sourceOrder!=='')check(typeof fields.sourceOrder==='string'&&/^[1-9]\d{0,4}$/.test(fields.sourceOrder),'Source order must be an explicit positive integer.');
 return Object.fromEntries(Object.entries(fields).filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([key,value])=>[key,['amount','premium','contribution','paidAmount'].includes(key)?exactAmount(value,true):key==='currency'?explicitCurrency(value):text(value,500)]));
}
export class SupportingRecordService {
 constructor(private readonly properties:PropertyService){}
 async overview(identity:Identity,query:{kind?:string;propertyId?:string;customerId?:string;q?:string}={}){
  check(query.kind===undefined||kinds.includes(query.kind),'Choose a supporting record type.');const propertyId=query.propertyId?id(query.propertyId):null,customerId=query.customerId?id(query.customerId):null,q=optional(query.q,200).toLowerCase();
  return this.properties.ownerContext(identity,async sql=>{
   const records=(await sql.query<Row>(`SELECT * FROM(SELECT DISTINCT ON(id) * FROM hamdee_private.supporting_records ORDER BY id,version DESC) r WHERE ($1::text IS NULL OR kind=$1) AND ($2::uuid IS NULL OR property_id=$2) AND ($3='' OR strpos(lower(label||' '||source_reference||' '||details::text),$3)>0) AND ($4::uuid IS NULL OR customer_id=$4) ORDER BY kind,label,id`,[query.kind??null,propertyId,q,customerId])).rows;
   const revisions=(await sql.query<Row>('SELECT * FROM hamdee_private.supporting_records WHERE id=ANY($1::uuid[]) ORDER BY id,version',[records.map(r=>r.id)])).rows;
   const links=(await sql.query<Row>(`SELECT l.*,e.expense_date,e.amount_minor::text,e.currency,e.category,e.reference,e.vendor_name FROM hamdee_private.supporting_expense_links l JOIN hamdee_private.property_expenses e ON e.id=l.expense_id WHERE l.record_id=ANY($1::uuid[]) ORDER BY e.expense_date,l.expense_id`,[records.map(r=>r.id)])).rows;
   return {records:records.map(operationView),revisions:revisions.map(operationView),linkedExpenses:links.map(operationView),basis:'Supporting references and locations only. Values are not cash, an approved return, depreciation, an automatic recurring bill or a historical financial posting. Unanswered source questions hold only affected values.'};
  });
 }
 async mutate(identity:Identity,input:unknown,key:string,requestId:string){
  const b=allowFields(input,{'create-reference':profileFields,'revise-reference':['recordId','expectedVersion','reason',...profileFields],'link-expense':['recordId','expenseId','reason']});
  return operationWrite(this.properties,identity,'supporting-record',b,key,requestId,async(sql,_actor,eventId)=>{
   if(b.action==='link-expense'){
    const record=(await sql.query<Row>('SELECT * FROM hamdee_private.supporting_records WHERE id=$1 ORDER BY version DESC LIMIT 1',[id(b.recordId)])).rows[0],expense=(await sql.query<Row>('SELECT * FROM hamdee_private.property_expenses WHERE id=$1',[id(b.expenseId)])).rows[0];
    check(record&&expense,'Supporting record or bill not found.','NOT_FOUND',404);check(record.property_id===null||record.property_id===expense.property_id,'This bill belongs to another property.','PROPERTY_MISMATCH',409);
    check(!(await sql.query('SELECT expense_id FROM hamdee_private.supporting_expense_links WHERE expense_id=$1',[expense.id])).rows.length,'This bill already has a supporting record.','ALREADY_LINKED',409);
    return operationView(await insertOperation(sql,'supporting_expense_links',{expense_id:expense.id,record_id:record.id,record_version:record.version,reason:text(b.reason,2000),event_id:eventId}));
   }
   const old=b.action==='revise-reference'?(await sql.query<Row>('SELECT * FROM hamdee_private.supporting_records WHERE id=$1 ORDER BY version DESC LIMIT 1',[id(b.recordId)])).rows[0]:null;
   if(b.action==='revise-reference')check(old&&old.version===b.expectedVersion,'This supporting record changed. Reload before saving.','VERSION_CONFLICT',412);
   const previous=old?operationView(old):{},value={...previous,...b};check(kinds.includes(String(value.kind)),'Choose a supporting record type.');
   const propertyId=value.propertyId?id(value.propertyId):null,roomId=value.roomId?id(value.roomId):null,vehicleId=value.vehicleId?id(value.vehicleId):null,customerId=value.customerId?id(value.customerId):null;
   if(propertyId)check((await sql.query('SELECT id FROM hamdee_private.properties WHERE id=$1',[propertyId])).rows.length,'Property not found.','NOT_FOUND',404);
   check(!roomId||propertyId,'A room reference requires its property.');if(roomId)check((await sql.query('SELECT id FROM hamdee_private.rooms WHERE id=$1 AND property_id=$2',[roomId,propertyId])).rows.length,'Choose a room in this property.');
   if(vehicleId)check((await sql.query('SELECT id FROM hamdee_private.car_vehicles WHERE id=$1',[vehicleId])).rows.length,'Vehicle not found.','NOT_FOUND',404);
   if(customerId)check((await sql.query('SELECT id FROM hamdee_private.tenants WHERE id=$1',[customerId])).rows.length,'Customer not found.','NOT_FOUND',404);
   const questions=value.reviewQuestions??[];check(Array.isArray(questions)&&questions.length<=14&&questions.every(q=>typeof q==='string'&&/^Q(0[1-9]|1[0-4])$/.test(q)),'Use the original Q01–Q14 question IDs.');
   const status=value.status??'unconfirmed';check(['unconfirmed','owner-confirmed'].includes(String(status)),'Choose a supporting review status.');
   const details=detail(value.details??{});
   if(details.sourceOrder){check(roomId&&propertyId&&value.kind==='other-reference','Source order requires a room/property reference.');if(status==='owner-confirmed')check(!(await sql.query(`SELECT 1 FROM(SELECT DISTINCT ON(id) * FROM hamdee_private.supporting_records ORDER BY id,version DESC) r WHERE r.id IS DISTINCT FROM $1::uuid AND r.property_id=$2 AND r.status='owner-confirmed' AND r.kind='other-reference' AND (r.room_id=$3 OR r.details->>'sourceOrder'=$4) AND r.details ? 'sourceOrder'`,[old?.id??null,propertyId,roomId,details.sourceOrder])).rows.length,'A confirmed room/order already exists. Revise that record instead.','SOURCE_ORDER_CONFLICT',409);}
   return operationView(await insertOperation(sql,'supporting_records',{id:old?.id??randomUUID(),version:Number(old?.version??0)+1,kind:value.kind,label:text(value.label,200),property_id:propertyId,room_id:roomId,vehicle_id:vehicleId,customer_id:customerId,source_reference:optional(value.sourceReference,500),original_wording:optional(value.originalWording,2000),notes:optional(value.notes,2000),details:JSON.stringify(details),review_questions:JSON.stringify([...new Set(questions)]),status,reason:old?text(b.reason,2000):'',event_id:eventId}));
  }) as Promise<{data:Row;replay:boolean}>;
 }
}
