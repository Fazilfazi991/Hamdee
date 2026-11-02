import {randomUUID} from 'node:crypto';
import type {Identity} from './auth';
import type {Sql} from './database';
import {PropertyService} from './service';
import {id,date,day,text,money,view} from './rental';
import {allowFields,operationCheck as check,operationWrite,insertOperation,moneyEntry,cashAccount,assertFunds,type OperationRow} from './company-finance';

const minorMajor=(n:string)=>`${BigInt(n)/100n}.${String(BigInt(n)%100n).padStart(2,'0')}`;
async function ready(sql:Sql){check((await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.financial_corrections') IS NOT NULL AS ready")).rows[0]?.ready,'Financial corrections migration is unavailable.','CONFIGURATION_UNAVAILABLE',503);}
export class FinancialCorrectionService {
 constructor(private readonly properties:PropertyService){}
 async overview(identity:Identity,query:{asOf:string;customerId?:string}){
  const asOf=date(query.asOf),customerId=query.customerId?id(query.customerId):null;
  return this.properties.ownerContext(identity,async sql=>{
   await ready(sql);
   const corrections=(await sql.query<OperationRow>(`SELECT c.* FROM hamdee_private.financial_corrections c WHERE corrected_date<=$1::date AND ($2::uuid IS NULL OR
    (source_kind='rental-refund' AND EXISTS(SELECT 1 FROM hamdee_private.rent_collections r JOIN hamdee_private.rental_agreements a ON a.id=r.agreement_id WHERE r.id=c.source_id AND a.tenant_id=$2)) OR
    (source_kind='security-refund' AND EXISTS(SELECT 1 FROM hamdee_private.security_deposit_refunds r JOIN hamdee_private.security_cheques s ON s.id=r.cheque_id WHERE r.id=c.source_id AND s.customer_id=$2))) ORDER BY corrected_date,c.created_at,c.id`,[asOf,customerId])).rows;
   const sources=(await sql.query<OperationRow>(`SELECT 'expense-payment' AS source_kind,p.id AS source_id,p.payment_date AS business_date,p.amount_minor,e.currency,l.entry_id AS money_entry_id,p.expense_id AS parent_id,NULL::uuid AS customer_id,m.account_id,m.collector_id,p.method FROM hamdee_private.expense_payments p JOIN hamdee_private.property_expenses e ON e.id=p.expense_id JOIN hamdee_private.expense_funding_links l ON l.payment_id=p.id JOIN hamdee_private.ops_money m ON m.id=l.entry_id WHERE p.status='recorded' AND p.payment_date<=$1::date AND $2::uuid IS NULL
    UNION ALL SELECT 'rental-refund',r.id,r.received_date,r.amount_minor,r.currency,m.id,r.agreement_id,a.tenant_id,m.account_id,m.collector_id,r.method FROM hamdee_private.rent_collections r JOIN hamdee_private.rental_agreements a ON a.id=r.agreement_id JOIN hamdee_private.rental_refund_funding_links l ON l.collection_id=r.id JOIN hamdee_private.ops_money m ON m.id=l.entry_id WHERE r.kind='deposit_refund' AND r.received_date<=$1::date AND ($2::uuid IS NULL OR a.tenant_id=$2)
    UNION ALL SELECT 'security-refund',r.id,r.business_date,r.amount_minor,s.currency,m.id,r.cheque_id,s.customer_id,m.account_id,m.collector_id,m.method FROM hamdee_private.security_deposit_refunds r JOIN hamdee_private.security_cheques s ON s.id=r.cheque_id JOIN hamdee_private.ops_money m ON m.id=r.money_entry_id WHERE r.business_date<=$1::date AND ($2::uuid IS NULL OR s.customer_id=$2)`,[asOf,customerId])).rows;
   return {corrections:corrections.map(view),sources:sources.map(s=>({...view(s),corrected:corrections.some(c=>c.source_kind===s.source_kind&&c.source_id===s.source_id)})),asOf,basis:'Original source rows and dated linked compensations. Corrections are bookkeeping records, not external payment instructions.'};
  });
 }
 async mutate(identity:Identity,input:unknown,key:string,requestId:string){
  const b=allowFields(input,{'correct-expense-payment':['paymentId','correctedOn','reason','replacement'],'correct-rental-refund':['collectionId','correctedOn','reason','replacement'],'correct-security-refund':['refundId','correctedOn','reason','replacement']});
  return operationWrite(this.properties,identity,'financial-correction',b,key,requestId,async(sql,actorId,eventId)=>{
   await ready(sql);const kind=b.action==='correct-expense-payment'?'expense-payment':b.action==='correct-rental-refund'?'rental-refund':'security-refund',sourceId=id(b.paymentId??b.collectionId??b.refundId),when=date(b.correctedOn),reason=text(b.reason,2000);
   check(!(await sql.query('SELECT id FROM hamdee_private.financial_corrections WHERE source_kind=$1 AND source_id=$2',[kind,sourceId])).rows.length,'This source already has a correction. Correct its replacement if necessary.','ALREADY_CORRECTED',409);
   let source:OperationRow|undefined,movement:OperationRow|undefined,parent:OperationRow|undefined;
   if(kind==='expense-payment'){
    source=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.expense_payments WHERE id=$1 AND status=\'recorded\'',[sourceId])).rows[0];
    if(source){parent=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.property_expenses WHERE id=$1',[source.expense_id])).rows[0];movement=(await sql.query<OperationRow>('SELECT m.*,m.delta::text FROM hamdee_private.ops_money m JOIN hamdee_private.expense_funding_links l ON l.entry_id=m.id WHERE l.payment_id=$1',[sourceId])).rows[0];}
   }else if(kind==='rental-refund'){
    source=(await sql.query<OperationRow>("SELECT * FROM hamdee_private.rent_collections WHERE id=$1 AND kind='deposit_refund' AND status='recorded'",[sourceId])).rows[0];
    if(source){parent=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.rental_agreements WHERE id=$1',[source.agreement_id])).rows[0];movement=(await sql.query<OperationRow>("SELECT m.*,m.delta::text FROM hamdee_private.ops_money m JOIN hamdee_private.rental_refund_funding_links l ON l.entry_id=m.id WHERE l.collection_id=$1::uuid AND m.entry_kind='expense'",[sourceId])).rows[0];}
   }else{
    source=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.security_deposit_refunds WHERE id=$1',[sourceId])).rows[0];
    if(source){parent=(await sql.query<OperationRow>('SELECT * FROM hamdee_private.security_cheques WHERE id=$1',[source.cheque_id])).rows[0];movement=(await sql.query<OperationRow>('SELECT *,delta::text FROM hamdee_private.ops_money WHERE id=$1',[source.money_entry_id])).rows[0];}
   }
   check(source&&parent&&movement,'Choose an original funded source payment or refund.','SOURCE_NOT_FOUND',404);
   check(when>=day(source.payment_date??source.received_date??source.business_date),'Correction cannot precede the original posting.');
   check(!(await sql.query('SELECT id FROM hamdee_private.ops_money WHERE reversal_of=$1',[movement.id])).rows.length,'The source funding already has a reversal.','ALREADY_REVERSED',409);
   if(b.replacement!==undefined)check(b.replacement&&typeof b.replacement==='object'&&!Array.isArray(b.replacement),'Replacement must be an object, or omitted for an explicit void.');
   const correctionId=randomUUID(),reversalId=randomUUID(),replacementId=b.replacement?randomUUID():null;
   const replacement=b.replacement as OperationRow|undefined;
   if(replacement)check(typeof replacement==='object'&&!Array.isArray(replacement)&&Object.keys(replacement).every(k=>['amount','method','fundingAccountId','fundingCollectorId','reference'].includes(k)),'Check replacement fields.');
   await insertOperation(sql,'financial_corrections',{id:correctionId,source_kind:kind,source_id:sourceId,corrected_date:when,original_amount_minor:source.amount_minor,money_entry_id:movement.id,reversal_entry_id:reversalId,replacement_id:replacementId,reason,actor_id:actorId,event_id:eventId});
   await moneyEntry(sql,eventId,{id:reversalId,location_type:movement.location_type,account_id:movement.account_id,collector_id:movement.collector_id,currency:movement.currency,business_date:when,delta:String(movement.delta).startsWith('-')?String(movement.delta).slice(1):'-'+movement.delta,method:movement.method,entry_kind:'reversal',claim_id:movement.claim_id,collection_id:movement.collection_id,transfer_id:movement.transfer_id,reversal_of:movement.id,classification:movement.classification,reference:movement.reference,notes:reason});
   if(kind==='expense-payment')await insertOperation(sql,'expense_events',{id:eventId,property_id:source.property_id,entity_id:source.expense_id,action:'correct-funded-payment',detail:JSON.stringify({sourceId,correctionId,replacementId,reason,requestId}),actor_id:actorId});
   else if(kind==='rental-refund')await insertOperation(sql,'rental_events',{id:eventId,property_id:source.property_id,room_id:source.room_id,entity_id:source.id,action:'correct-funded-deposit-refund',detail:JSON.stringify({sourceId,correctionId,replacementId,reason,requestId}),actor_id:actorId});
   else await insertOperation(sql,'customer_events',{id:eventId,customer_id:parent.customer_id,action:'correct-funded-deposit-refund',reason,actor_id:actorId});
   let replacementEntryId:string|null=null;
   if(replacement){
    check(['cash','bank'].includes(String(replacement.method)),'Replacement must use cash or bank.');
    check((replacement.fundingAccountId!==undefined)!==(replacement.fundingCollectorId!==undefined),'Choose exactly one replacement funding account or collector.');
    check(kind==='expense-payment'||replacement.fundingCollectorId===undefined,'Deposit refunds require an explicit company funding account.');
    const amount=money(replacement.amount),account=replacement.fundingAccountId?await cashAccount(sql,replacement.fundingAccountId,kind!=='expense-payment'):null,collector=replacement.fundingCollectorId?(await sql.query<OperationRow>('SELECT id FROM hamdee_private.ops_collectors WHERE id=$1',[id(replacement.fundingCollectorId)])).rows[0]:null;
    check(account||collector,'Replacement funding location not found.','NOT_FOUND',404);
    if(account)check(account.currency===movement.currency&&account.kind===replacement.method&&when>=day(account.opening_date),'Replacement account must match currency, method and date.','ACCOUNT_MISMATCH',409);
    const reference=text(replacement.reference??'',200,false);
    if(kind==='expense-payment')await insertOperation(sql,'expense_payments',{id:replacementId,expense_id:source.expense_id,property_id:source.property_id,method:replacement.method,amount_minor:amount,payment_date:when,reference,status:'recorded',event_id:eventId});
    else if(kind==='rental-refund')await insertOperation(sql,'rent_collections',{id:replacementId,agreement_id:source.agreement_id,room_id:source.room_id,property_id:source.property_id,currency:source.currency,kind:'deposit_refund',method:replacement.method,amount_minor:amount,received_date:when,reference,status:'recorded',event_id:eventId});
    const entry=await moneyEntry(sql,eventId,{account_id:account?.id??null,collector_id:collector?.id??null,entry_kind:'expense',delta:'-'+minorMajor(amount),currency:movement.currency,business_date:when,method:replacement.method,classification:movement.classification,reference,notes:reason});replacementEntryId=String(entry.id);
    await insertOperation(sql,'ops_expense_keys',{id:randomUUID(),entry_id:entry.id,event_id:eventId});
    if(kind==='expense-payment')await insertOperation(sql,'expense_funding_links',{payment_id:replacementId,entry_id:entry.id,event_id:eventId});
    else if(kind==='rental-refund')await insertOperation(sql,'rental_refund_funding_links',{collection_id:replacementId,entry_id:entry.id,event_id:eventId});
    else if(kind==='security-refund')await insertOperation(sql,'security_deposit_refunds',{id:replacementId,cheque_id:source.cheque_id,amount_minor:amount,business_date:when,reason,money_entry_id:entry.id,event_id:eventId});
   }
   if(kind!=='expense-payment'){
    if(kind==='rental-refund'){
     const rows=(await sql.query<OperationRow>("SELECT received_date AS business_date,CASE kind WHEN 'deposit' THEN amount_minor ELSE -amount_minor END AS delta FROM hamdee_private.rental_collection_effects WHERE agreement_id=$1 AND status='recorded' AND kind IN ('deposit','deposit_refund') ORDER BY received_date,id",[source.agreement_id])).rows;
     await assertDepositDays(rows);
    }else{
     const rows=(await sql.query<OperationRow>(`SELECT business_date,-amount_minor AS delta FROM hamdee_private.security_deposit_refund_effects WHERE cheque_id=$1 UNION ALL SELECT s.business_date,c.amount_minor FROM hamdee_private.security_cheques c JOIN hamdee_private.security_cheque_events s ON s.cheque_id=c.id WHERE c.id=$1 AND s.status='cleared' ORDER BY business_date`,[source.cheque_id])).rows;
     await assertDepositDays(rows);
    }
   }
   await assertFunds(sql);
   return {id:correctionId,sourceKind:kind,sourceId,correctedDate:when,reason,replacementId,reversalEntryId:reversalId,replacementEntryId,customerId:parent.tenant_id??parent.customer_id??null};
  }) as Promise<{data:OperationRow;replay:boolean}>;
 }
}
async function assertDepositDays(rows:OperationRow[]){
 const days=new Map<string,bigint>();for(const row of rows){const d=day(row.business_date);days.set(d,(days.get(d)??0n)+BigInt(String(row.delta)));}
 let balance=0n;for(const [,delta] of [...days].sort(([a],[b])=>a.localeCompare(b))){balance+=delta;check(balance>=0n,'Replacement would exceed the dated funded deposit balance.','DEPOSIT_EXCEEDED',409);}
}
