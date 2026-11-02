import {randomUUID} from 'node:crypto';
import type {Identity} from './auth';
import type {Sql} from './database';
import {PropertyService} from './service';
import {date,day,id,text} from './rental';
import {allowFields,operationCheck as check,operationWrite,operationView,insertOperation,exactAmount,explicitCurrency,cashAccount,moneyEntry,assertFunds,localReceiptReader,verifiedReceipt,sourceClaim} from './company-finance';
type Row=Record<string,unknown>;
const optional=(value:unknown,max:number)=>text(value??'',max,false);
const amountView=(row:Row)=>operationView(row);
async function obligation(sql:Sql,value:unknown){const row=(await sql.query<Row>('SELECT *,amount::text FROM hamdee_private.principal_obligations WHERE id=$1',[id(value)])).rows[0];check(row,'Principal record not found.','NOT_FOUND',404);return row;}
async function checkPrincipal(sql:Sql,obligationId:unknown){
 const bad=(await sql.query(`WITH dates AS(SELECT opened_date AS d FROM hamdee_private.principal_obligations WHERE id=$1 UNION SELECT business_date FROM hamdee_private.principal_amendments WHERE obligation_id=$1 UNION SELECT business_date FROM hamdee_private.principal_movements WHERE obligation_id=$1 UNION SELECT c.business_date FROM hamdee_private.principal_corrections c JOIN hamdee_private.principal_movements m ON m.id=c.movement_id WHERE m.obligation_id=$1)
 SELECT 1 FROM dates d JOIN hamdee_private.principal_obligations o ON o.id=$1 WHERE coalesce((SELECT amount FROM hamdee_private.principal_amendments a WHERE a.obligation_id=o.id AND a.business_date<=d.d ORDER BY version DESC LIMIT 1),o.amount)<coalesce((SELECT sum(m.amount) FROM hamdee_private.principal_movements m WHERE m.obligation_id=o.id AND m.kind='repayment' AND m.business_date<=d.d AND NOT EXISTS(SELECT 1 FROM hamdee_private.principal_corrections c WHERE c.movement_id=m.id AND c.business_date<=d.d)),0) LIMIT 1`,[obligationId])).rows;
 check(!bad.length,'Repayment or correction exceeds principal on a recorded date.','PRINCIPAL_EXCEEDED',409);
}
async function post(sql:Sql,eventId:string,o:Row,kind:'funding'|'repayment',b:Row,replacesId:string|null=null,movementId=randomUUID()){
 const amount=exactAmount(b.amount),when=date(b.paidOn),method=String(b.method);check(['cash','bank'].includes(method),'Choose actual cash or bank; pending cheques are not principal payments.');
 check(when>=day(o.opened_date),'Money date cannot precede the original obligation.');check((b.accountId!==undefined)!==(b.collectorId!==undefined),'Choose exactly one actual account or collector.');
 const account=b.accountId!==undefined?await cashAccount(sql,b.accountId):null,collector=b.collectorId!==undefined?(await sql.query<Row>('SELECT id FROM hamdee_private.ops_collectors WHERE id=$1',[id(b.collectorId)])).rows[0]:null;
 check(account||collector,'Collector not found.','NOT_FOUND',404);if(account)check(account.currency===o.currency&&account.kind===method&&when>=day(account.opening_date),'Select a matching funding method, date and currency.','ACCOUNT_MISMATCH',409);
 const incoming=o.direction==='receivable'&&kind==='repayment'||o.direction==='payable'&&kind==='funding',classification='principal-'+kind,reference=optional(b.reference,200),notes=optional(b.notes,2000);
 let entry:Row;
 if(incoming){
  const receipt=await insertOperation(sql,'ops_receipts',{id:randomUUID(),receipt_key:randomUUID(),classification,received_date:when,amount,currency:o.currency,method,status:'recorded',reference,notes,event_id:eventId});
  const source=await verifiedReceipt(sql,localReceiptReader,'classified-receipt',String(receipt.id)),claim=await sourceClaim(sql,eventId,source);
  const collection=collector?await insertOperation(sql,'ops_collections',{id:randomUUID(),collector_id:collector.id,claim_id:claim,business_date:when,amount,currency:o.currency,method,classification,disposition:'collector-held',account_id:null,owner_confirmed:true,notes,event_id:eventId}):null;
  entry=await moneyEntry(sql,eventId,{account_id:account?.id??null,collector_id:collector?.id??null,collection_id:collection?.id??null,entry_kind:collector?'collection':'receipt',delta:amount,currency:o.currency,business_date:when,method,claim_id:claim,classification,reference,notes});
 }else{
  entry=await moneyEntry(sql,eventId,{account_id:account?.id??null,collector_id:collector?.id??null,entry_kind:'expense',delta:'-'+amount,currency:o.currency,business_date:when,method,classification,reference,notes});
  await insertOperation(sql,'ops_expense_keys',{id:randomUUID(),entry_id:entry.id,event_id:eventId});
 }
 return insertOperation(sql,'principal_movements',{id:movementId,obligation_id:o.id,kind,amount,business_date:when,method,account_id:account?.id??null,collector_id:collector?.id??null,money_entry_id:entry.id,reference,notes,replaces_id:replacesId,event_id:eventId});
}
export class PrincipalService {
 constructor(private readonly properties:PropertyService){}
 async overview(identity:Identity,query:{asOf:string;currency?:string;customerId?:string}){
  const asOf=date(query.asOf),currency=query.currency?explicitCurrency(query.currency):null,customerId=query.customerId?id(query.customerId):null;
  return this.properties.ownerContext(identity,async sql=>{
   const obligations=(await sql.query<Row>(`SELECT o.*,o.amount::text AS original_amount,coalesce(a.amount,o.amount)::text AS amount,coalesce(a.version,1) AS version,
    coalesce(p.paid,0)::text AS repaid_amount,(coalesce(a.amount,o.amount)-coalesce(p.paid,0))::text AS outstanding_amount
    FROM hamdee_private.principal_obligations o LEFT JOIN LATERAL(SELECT amount,version FROM hamdee_private.principal_amendments WHERE obligation_id=o.id AND business_date<=$1::date ORDER BY version DESC LIMIT 1)a ON true
    LEFT JOIN LATERAL(SELECT sum(m.amount) AS paid FROM hamdee_private.principal_movements m WHERE m.obligation_id=o.id AND m.kind='repayment' AND m.business_date<=$1::date AND NOT EXISTS(SELECT 1 FROM hamdee_private.principal_corrections c WHERE c.movement_id=m.id AND c.business_date<=$1::date))p ON true
    WHERE o.opened_date<=$1::date AND ($2::text IS NULL OR o.currency=$2) AND ($3::uuid IS NULL OR o.customer_id=$3) ORDER BY o.opened_date,o.id`,[asOf,currency,customerId])).rows;
   const ids=obligations.map(o=>o.id),movements=(await sql.query<Row>(`SELECT m.*,m.amount::text,c.business_date AS corrected_date,c.reason AS correction_reason,c.replacement_id FROM hamdee_private.principal_movements m LEFT JOIN hamdee_private.principal_corrections c ON c.movement_id=m.id AND c.business_date<=$2::date WHERE m.obligation_id=ANY($1::uuid[]) AND m.business_date<=$2::date ORDER BY m.business_date,m.id`,[ids,asOf])).rows;
   const history=(await sql.query<Row>(`SELECT e.* FROM hamdee_private.ops_events e WHERE e.id IN(SELECT event_id FROM hamdee_private.principal_obligations WHERE id=ANY($1::uuid[]) UNION SELECT event_id FROM hamdee_private.principal_movements WHERE obligation_id=ANY($1::uuid[]) UNION SELECT c.event_id FROM hamdee_private.principal_corrections c JOIN hamdee_private.principal_movements m ON m.id=c.movement_id WHERE m.obligation_id=ANY($1::uuid[]) UNION SELECT event_id FROM hamdee_private.principal_amendments WHERE obligation_id=ANY($1::uuid[])) ORDER BY e.occurred_at,e.id`,[ids])).rows;
   const totals=(await sql.query<Row>(`SELECT o.direction,o.currency,sum(coalesce(a.amount,o.amount))::text AS principal_amount,sum(coalesce(p.paid,0))::text AS repaid_amount,sum(coalesce(a.amount,o.amount)-coalesce(p.paid,0))::text AS outstanding_amount FROM hamdee_private.principal_obligations o
    LEFT JOIN LATERAL(SELECT amount FROM hamdee_private.principal_amendments WHERE obligation_id=o.id AND business_date<=$1::date ORDER BY version DESC LIMIT 1)a ON true LEFT JOIN LATERAL(SELECT sum(m.amount) paid FROM hamdee_private.principal_movements m WHERE m.obligation_id=o.id AND m.kind='repayment' AND m.business_date<=$1::date AND NOT EXISTS(SELECT 1 FROM hamdee_private.principal_corrections c WHERE c.movement_id=m.id AND c.business_date<=$1::date))p ON true WHERE o.id=ANY($2::uuid[]) GROUP BY o.direction,o.currency ORDER BY o.direction,o.currency`,[asOf,ids])).rows;
   return {obligations:obligations.map(amountView),movements:movements.map(amountView),totals:totals.map(amountView),history:history.map(amountView),asOf,basis:'Original obligations and principal repayments, separated by direction and currency. An opening obligation is not a cash receipt. Principal movements never become rent, interest, fees or automatic currency conversions.'};
  });
 }
 async mutate(identity:Identity,input:unknown,key:string,requestId:string){
  const correctionFields=['movementId','correctedOn','reason','replacement'];
  const b=allowFields(input,{'create-obligation':['direction','kind','counterparty','customerId','amount','currency','openedOn','reference','notes','fundingAccountId','fundingCollectorId','method','fundedOn'],repay:['obligationId','amount','paidOn','method','accountId','collectorId','reference','notes'],'correct-repayment':correctionFields,'correct-movement':correctionFields,'correct-obligation':['obligationId','expectedVersion','amount','correctedOn','reason']});
  return operationWrite(this.properties,identity,'principal',b,key,requestId,async(sql,_actor,eventId)=>{
   let result:Row;
   if(b.action==='create-obligation'){
    check(['receivable','payable'].includes(String(b.direction))&&['loan','receivable','arrears','reimbursement','other'].includes(String(b.kind)),'Choose the direction and principal classification.');
    if(b.customerId)check((await sql.query('SELECT id FROM hamdee_private.tenants WHERE id=$1',[id(b.customerId)])).rows.length,'Customer not found.','NOT_FOUND',404);
    result=await insertOperation(sql,'principal_obligations',{id:randomUUID(),direction:b.direction,kind:b.kind,counterparty:text(b.counterparty,200),customer_id:b.customerId?id(b.customerId):null,amount:exactAmount(b.amount),currency:explicitCurrency(b.currency),opened_date:date(b.openedOn),reference:optional(b.reference,200),notes:optional(b.notes,2000),event_id:eventId});
    check(!(b.fundingAccountId!==undefined&&b.fundingCollectorId!==undefined),'Choose one actual funding location.');
    if(b.fundingAccountId!==undefined||b.fundingCollectorId!==undefined)await post(sql,eventId,result,'funding',{amount:b.amount,paidOn:b.fundedOn,method:b.method,...(b.fundingAccountId!==undefined?{accountId:b.fundingAccountId}:{collectorId:b.fundingCollectorId}),reference:b.reference,notes:b.notes});
    else check(b.method===undefined&&b.fundedOn===undefined,'Actual funding details require a selected money location.');
   }else if(b.action==='repay'){
    const o=await obligation(sql,b.obligationId);result=await post(sql,eventId,o,'repayment',b);await checkPrincipal(sql,o.id);
   }else if(b.action==='correct-obligation'){
    const o=await obligation(sql,b.obligationId),previous=(await sql.query<Row>('SELECT * FROM hamdee_private.principal_amendments WHERE obligation_id=$1 ORDER BY version DESC LIMIT 1',[o.id])).rows[0];
    check(b.expectedVersion===(previous?.version??1),'Principal changed. Reload before correcting.','VERSION_CONFLICT',412);const when=date(b.correctedOn);check(when>=day(previous?.business_date??o.opened_date),'Correction cannot precede the previous principal confirmation.');
    result=await insertOperation(sql,'principal_amendments',{id:randomUUID(),obligation_id:o.id,version:Number(previous?.version??1)+1,amount:exactAmount(b.amount),business_date:when,reason:text(b.reason,2000),event_id:eventId});await checkPrincipal(sql,o.id);
   }else{
    const original=(await sql.query<Row>('SELECT *,amount::text FROM hamdee_private.principal_movements WHERE id=$1',[id(b.movementId)])).rows[0];check(original,'Principal movement not found.','NOT_FOUND',404);check(b.action!=='correct-repayment'||original.kind==='repayment','Choose a repayment to correct.');
    check(!(await sql.query('SELECT id FROM hamdee_private.principal_corrections WHERE movement_id=$1',[original.id])).rows.length,'This movement was already corrected.','ALREADY_CORRECTED',409);
    const when=date(b.correctedOn),reason=text(b.reason,2000);check(when>=day(original.business_date),'Correction cannot precede the original money movement.');
    const entry=(await sql.query<Row>('SELECT *,delta::text FROM hamdee_private.ops_money WHERE id=$1',[original.money_entry_id])).rows[0];
    const reversalId=randomUUID(),correctionId=randomUUID(),replacementId=b.replacement===undefined?null:randomUUID();
    result=await insertOperation(sql,'principal_corrections',{id:correctionId,movement_id:original.id,business_date:when,reason,reversal_entry_id:reversalId,replacement_id:replacementId,event_id:eventId});
    const delta=String(entry.delta);await moneyEntry(sql,eventId,{id:reversalId,location_type:entry.location_type,account_id:entry.account_id,collector_id:entry.collector_id,entry_kind:'reversal',delta:delta.startsWith('-')?delta.slice(1):'-'+delta,currency:entry.currency,business_date:when,method:entry.method,claim_id:entry.claim_id,collection_id:entry.collection_id,transfer_id:entry.transfer_id,reversal_of:entry.id,classification:entry.classification,reference:entry.reference,notes:reason});
    if(entry.collection_id)await insertOperation(sql,'ops_collection_reversals',{id:randomUUID(),collection_id:entry.collection_id,reversed_date:when,reason,event_id:eventId});
    if(b.replacement!==undefined){check(b.replacement&&typeof b.replacement==='object'&&!Array.isArray(b.replacement),'Enter replacement money details.');const replacement=b.replacement as Row;check(Object.keys(replacement).every(k=>['amount','paidOn','method','accountId','collectorId','reference','notes'].includes(k)),'Unknown replacement fields.');check(date(replacement.paidOn)>=when,'Replacement cannot rewrite an earlier statement period.');
     const o=await obligation(sql,original.obligation_id),newMovement=await post(sql,eventId,o,original.kind as 'funding'|'repayment',replacement,String(original.id),replacementId!);
     result={...result,replacementId:newMovement.id};
    }
    await checkPrincipal(sql,original.obligation_id);
   }
   await assertFunds(sql);return operationView(result);
  }) as Promise<{data:Row;replay:boolean}>;
 }
}
