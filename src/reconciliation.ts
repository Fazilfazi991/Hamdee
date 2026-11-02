import type { Identity } from './auth';
import { PropertyService } from './service';
import { date,id,text,day } from './rental';
import { allowFields,operationCheck as check,operationWrite,operationView,cashAccount,exactAmount,moneyEntry,insertOperation,explicitCurrency,assertFunds } from './company-finance';
import { randomUUID } from 'node:crypto';

export class ReconciliationService {
 constructor(private readonly properties:PropertyService){}
 async overview(identity:Identity,query:{asOf:string;accountId?:string;collectorId?:string;currency?:string}){
  const asOf=date(query.asOf),accountId=query.accountId?id(query.accountId):null,collectorId=query.collectorId?id(query.collectorId):null,currency=query.currency?explicitCurrency(query.currency):null;
  return this.properties.ownerContext(identity,async sql=>{
   const records=(await sql.query(`SELECT r.*,r.calculated_balance::text,r.counted_balance::text,r.difference::text,
    (SELECT trim_scale(coalesce(sum(m.delta),0))::text FROM hamdee_private.ops_money m WHERE m.account_id=r.account_id AND m.business_date<=r.reconciled_date) AS current_calculated_balance
    FROM hamdee_private.account_reconciliations r WHERE r.reconciled_date<=$1::date AND ($2::uuid IS NULL OR r.account_id=$2) ORDER BY r.reconciled_date DESC,r.created_at DESC,r.id`,[asOf,accountId])).rows;
   const collectorAvailable=(await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.collector_reconciliations') IS NOT NULL AS ready")).rows[0].ready;
   const collectorRecords=collectorAvailable?(await sql.query(`SELECT r.*,r.calculated_balance::text,r.counted_balance::text,r.difference::text,
    (SELECT trim_scale(coalesce(sum(m.delta),0))::text FROM hamdee_private.ops_money m WHERE m.collector_id=r.collector_id AND m.currency=r.currency AND m.business_date<=r.reconciled_date) AS current_calculated_balance
    FROM hamdee_private.collector_reconciliations r WHERE r.reconciled_date<=$1::date AND ($2::uuid IS NULL OR r.collector_id=$2) AND ($3::text IS NULL OR r.currency=$3) ORDER BY r.reconciled_date DESC,r.created_at DESC,r.id`,[asOf,collectorId,currency])).rows:[];
   const collectorOpenings=collectorAvailable?(await sql.query('SELECT *,opening_amount::text FROM hamdee_private.collector_openings WHERE opening_date<=$1::date AND ($2::uuid IS NULL OR collector_id=$2) AND ($3::text IS NULL OR currency=$3)',[asOf,collectorId,currency])).rows:[];
   const collectorMovements=collectorAvailable?(await sql.query(`SELECT m.*,m.delta::text,c.source_kind,c.source_id,e.actor_id,e.occurred_at,
    (SELECT trim_scale(sum(x.delta))::text FROM hamdee_private.ops_money x WHERE x.collector_id=m.collector_id AND x.currency=m.currency AND x.business_date<=m.business_date) AS day_end_balance
    FROM hamdee_private.ops_money m LEFT JOIN hamdee_private.ops_claims c ON c.id=m.claim_id JOIN hamdee_private.ops_events e ON e.id=m.event_id
    WHERE m.collector_id IS NOT NULL AND m.business_date<=$1::date AND ($2::uuid IS NULL OR m.collector_id=$2) AND ($3::text IS NULL OR m.currency=$3) ORDER BY m.business_date,e.occurred_at,m.id`,[asOf,collectorId,currency])).rows:[];
   return {records:records.map(operationView),collectorRecords:collectorRecords.map(operationView),collectorOpenings:collectorOpenings.map(operationView),collectorMovements:collectorMovements.map(operationView),collectorAvailable,asOf,basis:'A retained count compared with recorded funds at the time of review. A difference creates no income, withdrawal or adjustment. Later backdated entries may change the current calculated balance. Collector figures without an explicit opening are labelled recorded movements, not a verified historical opening.'};
  });
 }
 async mutate(identity:Identity,input:unknown,key:string,requestId:string){
  const b=allowFields(input,{'record-reconciliation':['accountId','reconciledOn','countedBalance','explanation','denominations'],
   'record-collector-reconciliation':['collectorId','currency','reconciledOn','countedBalance','explanation'],
   'confirm-collector-opening':['collectorId','currency','openingDate','openingAmount','method','ownerConfirmedOpening','sourceReference','notes']});
  return operationWrite(this.properties,identity,'reconciliation',b,key,requestId,async(sql,_actor,eventId)=>{
   if(b.action!=='record-reconciliation'){
    const ready=(await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.collector_reconciliations') IS NOT NULL AS ready")).rows[0].ready;
    check(ready,'Collector reconciliation upgrade is not available.','CONFIGURATION_UNAVAILABLE',503);
    const collectorId=id(b.collectorId),currency=explicitCurrency(b.currency);
    check((await sql.query('SELECT id FROM hamdee_private.ops_collectors WHERE id=$1',[collectorId])).rows.length,'Collector not found.','NOT_FOUND',404);
    if(b.action==='confirm-collector-opening'){
     check(b.ownerConfirmedOpening===true,'Confirm the actual collector opening amount and date.');
     check(['cash','bank'].includes(String(b.method)),'Confirm whether the collector opening is held as cash or bank funds.');
     const when=date(b.openingDate),amount=exactAmount(b.openingAmount,true),entryId=randomUUID();
     check(!(await sql.query('SELECT 1 FROM hamdee_private.collector_openings WHERE collector_id=$1 AND currency=$2',[collectorId,currency])).rows.length,'This collector opening is already confirmed.','OPENING_EXISTS',409);
     check(!(await sql.query('SELECT 1 FROM hamdee_private.ops_money WHERE collector_id=$1 AND currency=$2 AND business_date<$3::date',[collectorId,currency,when])).rows.length,'Opening date must not follow existing recorded movements.');
     const row=await insertOperation(sql,'collector_openings',{collector_id:collectorId,currency,opening_date:when,opening_amount:amount,method:b.method,owner_confirmed:true,source_reference:text(b.sourceReference,500),notes:text(b.notes??'',2000,false),money_entry_id:entryId,event_id:eventId});
     await moneyEntry(sql,eventId,{id:entryId,collector_id:collectorId,entry_kind:'opening',delta:amount,currency,business_date:when,method:b.method,classification:'confirmed-collector-opening',reference:text(b.sourceReference,500).slice(0,200),notes:row.notes});
     await assertFunds(sql);return operationView({...row,opening_amount:amount});
    }
    const when=date(b.reconciledOn),counted=exactAmount(b.countedBalance,true),explanation=text(b.explanation,2000);
    const balance=(await sql.query<{balance:string}>('SELECT trim_scale(coalesce(sum(delta),0))::text AS balance FROM hamdee_private.ops_money WHERE collector_id=$1 AND currency=$2 AND business_date<=$3::date',[collectorId,currency,when])).rows[0].balance;
    const opening=(await sql.query('SELECT 1 FROM hamdee_private.collector_openings WHERE collector_id=$1 AND currency=$2 AND opening_date<=$3::date',[collectorId,currency,when])).rows.length>0;
    const row=(await sql.query(`INSERT INTO hamdee_private.collector_reconciliations(id,collector_id,currency,reconciled_date,calculated_balance,counted_balance,difference,opening_confirmed,explanation,event_id)
     VALUES($1,$2,$3,$4,$5::numeric,$6::numeric,$6::numeric-$5::numeric,$7,$8,$9) RETURNING *,calculated_balance::text,counted_balance::text,difference::text`,[randomUUID(),collectorId,currency,when,balance,counted,opening,explanation,eventId])).rows[0];
    return operationView(row);
   }
   const account=await cashAccount(sql,b.accountId),when=date(b.reconciledOn),counted=exactAmount(b.countedBalance,true),explanation=text(b.explanation,2000);
   check(when>=day(account.opening_date),'Count cannot precede the confirmed account opening.');
   const balance=(await sql.query<{balance:string}>('SELECT trim_scale(coalesce(sum(delta),0))::text AS balance FROM hamdee_private.ops_money WHERE account_id=$1 AND business_date<=$2::date',[account.id,when])).rows[0].balance;
   let components:{denomination:string;quantity:number}[]|null=null;
   if(b.denominations!==undefined){
    check(account.kind==='cash'&&Array.isArray(b.denominations)&&b.denominations.length<=20,'Use up to twenty denomination rows for physical cash only.');
    components=b.denominations.map((value:unknown)=>{check(value&&typeof value==='object'&&!Array.isArray(value),'Enter denomination and quantity.');const row=value as Record<string,unknown>;check(Object.keys(row).every(k=>['denomination','quantity'].includes(k))&&Number.isSafeInteger(row.quantity)&&Number(row.quantity)>=0&&Number(row.quantity)<=1000000,'Use whole nonnegative note counts.');return {denomination:exactAmount(row.denomination),quantity:Number(row.quantity)};});
    check(new Set(components.map(row=>row.denomination)).size===components.length,'Use one row for each denomination.');
    check((await sql.query<{ok:boolean}>("SELECT coalesce(sum((v->>'denomination')::numeric*(v->>'quantity')::numeric),0)=$2::numeric AS ok FROM jsonb_array_elements($1::jsonb) v",[JSON.stringify(components),counted])).rows[0].ok,'Denominations must equal the actual counted balance.');
    check((await sql.query<{ready:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hamdee_private.account_reconciliations'::regclass AND attname='count_details') AS ready")).rows[0].ready,'Cash count upgrade is unavailable.','CONFIGURATION_UNAVAILABLE',503);
   }
   const row=await insertOperation(sql,'account_reconciliations',{id:randomUUID(),account_id:account.id,currency:account.currency,reconciled_date:when,calculated_balance:balance,counted_balance:counted,difference:(await sql.query<{difference:string}>('SELECT ($1::numeric-$2::numeric)::text AS difference',[counted,balance])).rows[0].difference,explanation,event_id:eventId,...(components?{count_details:JSON.stringify(components)}:{})});
   // No ops_money entry: an unexplained difference is evidence, not a withdrawal.
   return operationView(row);
  }) as Promise<{data:Record<string,unknown>;replay:boolean}>;
 }
}
