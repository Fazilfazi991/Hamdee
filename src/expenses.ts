import { createHash,randomUUID } from 'node:crypto';
import type { Identity } from './auth';
import { PropertyService } from './service';
import { requireThat } from './errors';
import { uuid } from './validation';
import { text,id,date,month,money,canonical,view,day } from './rental';
type Row=Record<string,unknown>;
const categories=['landlord','kahramaa','wifi_utilities','maintenance','cleaning','miscellaneous'];
const check=(ok:unknown,message:string,code='INVALID_EXPENSE',status=422)=>requireThat(ok,status,code,message);
const workKey=(s:unknown)=>String(s).trim().replace(/\s+/g,' ').toLowerCase();
export class ExpenseService {
  constructor(private readonly properties:PropertyService){}
  async overview(identity:Identity,query:{month:string;asOf:string;propertyId?:string}){
    const period=month(query.month),asOf=date(query.asOf),propertyId=query.propertyId?id(query.propertyId):null;
    return this.properties.ownerContext(identity,async sql=>{
      const expenses=(await sql.query<Row>(`SELECT e.*,
        coalesce((SELECT sum(p.amount_minor) FROM hamdee_private.expense_payments p WHERE p.expense_id=e.id AND p.status='recorded' AND p.payment_date<=$2::date),0)::text AS paid_minor,
        coalesce((SELECT sum(p.amount_minor) FROM hamdee_private.expense_payments p WHERE p.expense_id=e.id AND p.status='pending' AND p.payment_date<=$2::date),0)::text AS pending_cheque_minor
        FROM hamdee_private.property_expenses e WHERE ($1::uuid IS NULL OR e.property_id=$1) ORDER BY e.expense_date DESC,e.id`,[propertyId,asOf])).rows;
      const payments=(await sql.query<Row>('SELECT * FROM hamdee_private.expense_payments WHERE ($1::uuid IS NULL OR property_id=$1) ORDER BY payment_date,id',[propertyId])).rows;
      const jobs=(await sql.query<Row>('SELECT * FROM hamdee_private.maintenance_jobs WHERE ($1::uuid IS NULL OR property_id=$1) ORDER BY opened_date DESC,id',[propertyId])).rows;
      const history=(await sql.query<Row>('SELECT * FROM hamdee_private.expense_events WHERE ($1::uuid IS NULL OR property_id=$1) ORDER BY occurred_at,id',[propertyId])).rows;
      // All report figures use ONE SQL statement snapshot. Cost dates and
      // payment dates are separate; this is an operational comparison only.
      const rows=(await sql.query<Row>(`WITH keys AS (
        SELECT property_id,currency FROM hamdee_private.rent_dues UNION SELECT property_id,currency FROM hamdee_private.rent_collections
        UNION SELECT property_id,currency FROM hamdee_private.property_expenses
      ) SELECT k.property_id,k.currency,
        coalesce((SELECT sum(d.amount_minor) FROM hamdee_private.rent_dues d WHERE d.property_id=k.property_id AND d.currency=k.currency AND d.period=$2),0)::text AS due_minor,
        coalesce((SELECT sum(a.amount_minor) FROM hamdee_private.rent_allocations a JOIN hamdee_private.rent_dues d ON d.id=a.due_id WHERE d.property_id=k.property_id AND d.currency=k.currency AND d.period=$2 AND a.allocated_date<=$3::date),0)::text AS collected_minor,
        coalesce((SELECT sum(e.amount_minor) FROM hamdee_private.property_expenses e WHERE e.property_id=k.property_id AND e.currency=k.currency AND to_char(e.expense_date,'YYYY-MM')=$2 AND e.expense_date<=$3::date),0)::text AS expense_minor,
        coalesce((SELECT sum(p.amount_minor) FROM hamdee_private.expense_payments p JOIN hamdee_private.property_expenses e ON e.id=p.expense_id WHERE e.property_id=k.property_id AND e.currency=k.currency AND p.status='recorded' AND to_char(p.payment_date,'YYYY-MM')=$2 AND p.payment_date<=$3::date),0)::text AS paid_expense_minor,
        coalesce((SELECT sum(c.amount_minor-coalesce((SELECT sum(a.amount_minor) FROM hamdee_private.rent_allocations a WHERE a.collection_id=c.id AND a.allocated_date<=$3::date),0)) FROM hamdee_private.rent_collections c WHERE c.property_id=k.property_id AND c.currency=k.currency AND c.kind='advance' AND c.status='recorded' AND c.received_date<=$3::date),0)::text AS advance_minor,
        coalesce((SELECT sum(CASE c.kind WHEN 'deposit' THEN c.amount_minor WHEN 'deposit_refund' THEN -c.amount_minor ELSE 0 END) FROM hamdee_private.rent_collections c WHERE c.property_id=k.property_id AND c.currency=k.currency AND c.status='recorded' AND c.received_date<=$3::date),0)::text AS deposit_minor,
        coalesce((SELECT jsonb_agg(jsonb_build_object('category',x.category,'amountMinor',x.amount::text) ORDER BY x.category) FROM
          (SELECT e.category,sum(e.amount_minor) AS amount FROM hamdee_private.property_expenses e WHERE e.property_id=k.property_id AND e.currency=k.currency AND to_char(e.expense_date,'YYYY-MM')=$2 AND e.expense_date<=$3::date GROUP BY e.category) x),'[]'::jsonb) AS categories
        FROM keys k WHERE ($1::uuid IS NULL OR k.property_id=$1) ORDER BY k.property_id,k.currency`,[propertyId,period,asOf])).rows;
      const properties:Row[]=rows.map(r=>({...view(r),outstandingMinor:String(BigInt(String(r.due_minor))-BigInt(String(r.collected_minor))),comparisonMinor:String(BigInt(String(r.collected_minor))-BigInt(String(r.expense_minor)))}));
      const totals=new Map<string,Row>();const monetary=['dueMinor','collectedMinor','outstandingMinor','expenseMinor','paidExpenseMinor','comparisonMinor','advanceMinor','depositMinor'];
      for(const p of properties){const currency=String(p.currency);if(!totals.has(currency))totals.set(currency,{currency,...Object.fromEntries(monetary.map(k=>[k,'0'])),categories:[]});const total=totals.get(currency)!;
        for(const k of monetary)total[k]=String(BigInt(String(total[k]))+BigInt(String((p as Row)[k])));
        const cats=total.categories as {category:string;amountMinor:string}[];for(const c of p.categories as {category:string;amountMinor:string}[]){const old=cats.find(x=>x.category===c.category);if(old)old.amountMinor=String(BigInt(old.amountMinor)+BigInt(c.amountMinor));else cats.push({...c});}
      }
      return {expenses:expenses.map(e=>({...view(e),outstandingMinor:String(BigInt(String(e.amount_minor))-BigInt(String(e.paid_minor)))})),payments:payments.map(view),
        jobs:jobs.map(j=>({...view(j),repeatWarnings:jobs.filter(old=>old.id!==j.id&&old.status==='completed'&&old.property_id===j.property_id&&old.room_id===j.room_id&&workKey(old.work_type)===workKey(j.work_type)&&day(old.completed_date)<=day(j.opened_date)).map(old=>({jobId:old.id,vendorName:old.vendor_name,warrantyStartDate:old.warranty_start_date?day(old.warranty_start_date):null,warrantyEndDate:old.warranty_end_date?day(old.warranty_end_date):null,withinWarranty:!!old.warranty_start_date&&day(old.warranty_start_date)<=day(j.opened_date)&&day(old.warranty_end_date)>=day(j.opened_date)}))})),history:history.map(view),summary:{properties,currencies:[...totals.values()]}};
    });
  }
  async mutate(identity:Identity,input:unknown,key:string,requestId:string){
    check(uuid.test(key),'Use a valid operation key.','IDEMPOTENCY_KEY_REQUIRED',400);check(input&&typeof input==='object'&&!Array.isArray(input),'Submit an expense operation.');const b=input as Row;
    const fields:Record<string,string[]>={
      'record-expense':['propertyId','roomId','category','expenseDate','amount','currency','vendorName','vendorContact','reference','notes','payment'],
      'record-payment':['expenseId','method','amount','paymentDate','reference'],
      'create-job':['propertyId','roomId','workType','issue','openedDate','vendorName','vendorContact','notes'],
      'update-job':['jobId','expectedVersion','vendorName','vendorContact','issue','notes'],
      'complete-job':['jobId','expectedVersion','completedDate','workCompleted','actualCost','currency','warrantyStartDate','warrantyEndDate','reference','notes','payment'],
      'update-warranty':['jobId','expectedVersion','warrantyStartDate','warrantyEndDate','notes'],
      'cancel-job':['jobId','expectedVersion','reason']};
    const action=String(b.action);check(Object.hasOwn(fields,action)&&Object.keys(b).every(k=>k==='action'||fields[action].includes(k)),'Unknown operation or fields.');
    const digest=createHash('sha256').update(canonical(b)).digest('hex');
    return this.properties.ownerContext(identity,async(sql,actorId)=>{
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['expense-command:'+actorId+':'+key]);
      const saved=(await sql.query<{digest:string;result:Row}>('SELECT digest,result FROM hamdee_private.expense_commands WHERE actor_id=$1 AND key=$2',[actorId,key])).rows[0];
      if(saved){check(saved.digest===digest,'Use a new key for a changed submission.','IDEMPOTENCY_KEY_REUSED',409);return {...saved.result,replay:true};}
      const get=async(table:'property_expenses'|'maintenance_jobs',value:unknown)=>{const row=(await sql.query<Row>(`SELECT * FROM hamdee_private.${table} WHERE id=$1`,[id(value)])).rows[0];check(row,'Record not found.','NOT_FOUND',404);return row;};
      let parent:Row|undefined;if(b.jobId)parent=await get('maintenance_jobs',b.jobId);else if(b.expenseId)parent=await get('property_expenses',b.expenseId);
      const propertyId=parent?String(parent.property_id):id(b.propertyId);
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['property:'+propertyId]);
      const p=(await sql.query<Row>('SELECT id,lifecycle_status FROM hamdee_private.properties WHERE id=$1',[propertyId])).rows[0];check(p,'Property not found.','NOT_FOUND',404);check(p.lifecycle_status==='registered','Restore the property before changing expenses or jobs.','PROPERTY_ARCHIVED',409);
      if(b.jobId)parent=await get('maintenance_jobs',b.jobId);else if(b.expenseId)parent=await get('property_expenses',b.expenseId);
      const roomId=parent?parent.room_id:b.roomId===undefined||b.roomId===null?null:id(b.roomId);
      if(roomId)check((await sql.query('SELECT id FROM hamdee_private.rooms WHERE id=$1 AND property_id=$2',[roomId,propertyId])).rows.length,'This room belongs to another property.','ROOM_PROPERTY_MISMATCH',409);
      const eventId=randomUUID();let entityId:string=randomUUID(),data:Row;
      const insert=async(table:string,values:Row)=>{const entries=Object.entries(values);return (await sql.query<Row>(`INSERT INTO hamdee_private.${table}(${entries.map(([k])=>k).join(',')}) VALUES(${entries.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,entries.map(([,v])=>v))).rows[0];};
      const currency=(v:unknown)=>{const c=text(v,3);check(/^[A-Z]{3}$/.test(c),'Choose an explicit three-letter currency.');return c;};
      const payment=async(expense:Row,value:unknown)=>{
        check(value&&typeof value==='object'&&!Array.isArray(value),'Enter payment details.');const v=value as Row;check(Object.keys(v).every(k=>['method','amount','paymentDate','reference'].includes(k)),'Check payment fields.');check(['cash','bank','cheque'].includes(String(v.method)),'Choose cash, bank or pending cheque.');
        const amount=money(v.amount),reference=text(v.reference??'',200,false);const paid=(await sql.query<{amount:string}>("SELECT coalesce(sum(amount_minor),0)::text AS amount FROM hamdee_private.expense_payments WHERE expense_id=$1 AND status='recorded'",[expense.id])).rows[0];
        check(BigInt(amount)+BigInt(paid.amount)<=BigInt(String(expense.amount_minor)),'Payment exceeds the unpaid expense.','PAYMENT_EXCEEDED',409);
        if(reference)check(!(await sql.query('SELECT id FROM hamdee_private.expense_payments WHERE expense_id=$1 AND method=$2 AND upper(trim(reference))=upper(trim($3))',[expense.id,v.method,reference])).rows.length,'This payment reference is already recorded.','DUPLICATE_PAYMENT',409);
        return insert('expense_payments',{id:randomUUID(),expense_id:expense.id,property_id:propertyId,method:v.method,amount_minor:amount,payment_date:date(v.paymentDate),reference,status:v.method==='cheque'?'pending':'recorded',event_id:eventId});
      };
      const expense=async(values:Row)=>{
        const reference=text(b.reference??'',200,false),vendorName=String(values.vendor_name);if(reference)check(!(await sql.query('SELECT id FROM hamdee_private.property_expenses WHERE property_id=$1 AND lower(trim(vendor_name))=lower(trim($2)) AND upper(trim(reference))=upper(trim($3))',[propertyId,vendorName,reference])).rows.length,'This vendor invoice/reference is already recorded for the property.','DUPLICATE_EXPENSE',409);
        const row=await insert('property_expenses',{...values,property_id:propertyId,room_id:roomId,reference,notes:text(b.notes??'',2000,false),event_id:eventId});if(b.payment!==undefined&&b.payment!==null)await payment(row,b.payment);return row;
      };
      const warranty=()=>{const start=b.warrantyStartDate===undefined||b.warrantyStartDate===null?null:date(b.warrantyStartDate),end=b.warrantyEndDate===undefined||b.warrantyEndDate===null?null:date(b.warrantyEndDate);check((start===null&&end===null)||(start!==null&&end!==null&&start<=end),'Enter both warranty dates in chronological order, or leave both empty.');return {warranty_start_date:start,warranty_end_date:end};};
      if(action==='record-expense'){
        check(categories.includes(String(b.category)),'Choose a property expense category.');data=await expense({id:entityId,category:b.category,expense_date:date(b.expenseDate),amount_minor:money(b.amount),currency:currency(b.currency),vendor_name:text(b.vendorName,200),vendor_contact:text(b.vendorContact??'',500,false),maintenance_job_id:null});
      }else if(action==='record-payment'){
        data=await payment(parent!,{method:b.method,amount:b.amount,paymentDate:b.paymentDate,reference:b.reference});entityId=String(data.id);
      }else if(action==='create-job'){
        data=await insert('maintenance_jobs',{id:entityId,property_id:propertyId,room_id:roomId,work_type:text(b.workType,120),issue:text(b.issue,2000),opened_date:date(b.openedDate),vendor_name:text(b.vendorName??'',200,false),vendor_contact:text(b.vendorContact??'',500,false),notes:text(b.notes??'',2000,false),event_id:eventId});
      }else {
        check(parent&&Number.isInteger(b.expectedVersion)&&b.expectedVersion===parent.version,'This job changed. Reload before saving.','VERSION_CONFLICT',412);const job=parent!;entityId=String(job.id);
        let changes:Row={version:Number(job.version)+1,event_id:eventId};
        if(action==='update-job'){
          check(job.status==='open','Only open jobs can be edited.','JOB_FINAL',409);for(const [input,column,max] of [['vendorName','vendor_name',200],['vendorContact','vendor_contact',500],['issue','issue',2000],['notes','notes',2000]] as const)if(input in b)changes[column]=text(b[input],max,input==='issue');
          check(Object.keys(changes).length>2,'Enter job changes.');
        }else if(action==='complete-job'){
          check(job.status==='open','This job already has a final outcome.','JOB_FINAL',409);const completed=date(b.completedDate);check(completed>=day(job.opened_date),'Completion cannot precede the job opening date.');
          check(String(job.vendor_name).trim(),'Assign a vendor before completing the job.');
          changes={...changes,status:'completed',completed_date:completed,work_completed:text(b.workCompleted,2000),actual_cost_minor:money(b.actualCost,true),currency:currency(b.currency),cost_expense_id:randomUUID(),...warranty(),notes:text(b.notes??job.notes,2000,false)};
        }else if(action==='update-warranty'){
          check(job.status==='completed','Warranty updates require a completed job.');changes={...changes,...warranty(),notes:text(b.notes??job.notes,2000,false)};
        }else {check(job.status==='open','Only an open job can be cancelled.','JOB_FINAL',409);changes={...changes,status:'cancelled',notes:text(b.reason,2000)};}
        const entries=Object.entries(changes);data=(await sql.query<Row>(`UPDATE hamdee_private.maintenance_jobs SET ${entries.map(([k],i)=>k+'=$'+(i+2)).join(',')} WHERE id=$1 AND version=$${entries.length+2} RETURNING *`,[entityId,...entries.map(([,v])=>v),b.expectedVersion])).rows[0];check(data,'This job changed. Reload before saving.','VERSION_CONFLICT',412);
        if(action==='complete-job')await expense({id:data.cost_expense_id,category:'maintenance',expense_date:data.completed_date,amount_minor:data.actual_cost_minor,currency:data.currency,vendor_name:data.vendor_name,vendor_contact:data.vendor_contact,maintenance_job_id:data.id});
      }
      await insert('expense_events',{id:eventId,property_id:propertyId,entity_id:entityId,action,detail:JSON.stringify({requestId,record:view(data!)}),actor_id:actorId});
      const result={data:view(data!),replay:false};await insert('expense_commands',{actor_id:actorId,key,digest,result:JSON.stringify(result)});return result;
    });
  }
}
