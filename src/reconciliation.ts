import type { Identity } from './auth';
import { PropertyService } from './service';
import { date,id,text,day } from './rental';
import { allowFields,operationCheck as check,operationWrite,operationView,cashAccount,exactAmount } from './company-finance';
import { randomUUID } from 'node:crypto';

export class ReconciliationService {
 constructor(private readonly properties:PropertyService){}
 async overview(identity:Identity,query:{asOf:string;accountId?:string}){
  const asOf=date(query.asOf),accountId=query.accountId?id(query.accountId):null;
  return this.properties.ownerContext(identity,async sql=>{
   const records=(await sql.query(`SELECT r.*,r.calculated_balance::text,r.counted_balance::text,r.difference::text,
    (SELECT trim_scale(coalesce(sum(m.delta),0))::text FROM hamdee_private.ops_money m WHERE m.account_id=r.account_id AND m.business_date<=r.reconciled_date) AS current_calculated_balance
    FROM hamdee_private.account_reconciliations r WHERE r.reconciled_date<=$1::date AND ($2::uuid IS NULL OR r.account_id=$2) ORDER BY r.reconciled_date DESC,r.created_at DESC,r.id`,[asOf,accountId])).rows;
   return {records:records.map(operationView),asOf,basis:'A retained count compared with recorded funds at the time of review. A difference creates no income, withdrawal or adjustment. Later backdated entries may change the current calculated balance.'};
  });
 }
 async mutate(identity:Identity,input:unknown,key:string,requestId:string){
  const b=allowFields(input,{'record-reconciliation':['accountId','reconciledOn','countedBalance','explanation']});
  return operationWrite(this.properties,identity,'reconciliation',b,key,requestId,async(sql,_actor,eventId)=>{
   const account=await cashAccount(sql,b.accountId),when=date(b.reconciledOn),counted=exactAmount(b.countedBalance,true),explanation=text(b.explanation,2000);
   check(when>=day(account.opening_date),'Count cannot precede the confirmed account opening.');
   const balance=(await sql.query<{balance:string}>('SELECT trim_scale(coalesce(sum(delta),0))::text AS balance FROM hamdee_private.ops_money WHERE account_id=$1 AND business_date<=$2::date',[account.id,when])).rows[0].balance;
   const row=(await sql.query(`INSERT INTO hamdee_private.account_reconciliations(id,account_id,currency,reconciled_date,calculated_balance,counted_balance,difference,explanation,event_id)
    VALUES($1,$2,$3,$4,$5::numeric,$6::numeric,$6::numeric-$5::numeric,$7,$8) RETURNING *,calculated_balance::text,counted_balance::text,difference::text`,[randomUUID(),account.id,account.currency,when,balance,counted,explanation,eventId])).rows[0];
   // No ops_money entry: an unexplained difference is evidence, not a withdrawal.
   return operationView(row);
  }) as Promise<{data:Record<string,unknown>;replay:boolean}>;
 }
}
