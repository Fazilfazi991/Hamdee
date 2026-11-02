import {effectiveLedgerSql} from './effective-ledgers';
import {createHash,randomUUID} from 'node:crypto';
import type {Identity} from './auth';
import type {Sql} from './database';
import {PropertyService} from './service';
import {date,day,id,text,money,view,canonical} from './rental';
import {allowFields,operationCheck as check,insertOperation,cashAccount,moneyEntry,sourceClaim,verifiedReceipt,localReceiptReader,assertFunds,reverseMoney} from './company-finance';
import {DOCUMENT_MAX_BYTES} from './documents';
type Row=Record<string,unknown>;
const digest=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
const optional=(v:unknown,max:number)=>text(v??'',max,false);
function document(input:unknown){
 check(input&&typeof input==='object'&&!Array.isArray(input),'Choose an identity document.');const b=input as Row;
 check(Object.keys(b).every(k=>['name','mimeType','base64','side'].includes(k)),'Unknown document fields.');
 const name=text(b.name,200);check(![...name].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127||c==='/'||c==='\\'),'Enter a safe file name.');
 const signatures:Record<string,number[]>={'application/pdf':[37,80,68,70,45],'image/jpeg':[255,216,255],'image/png':[137,80,78,71,13,10,26,10]};
 const mimeType=String(b.mimeType),signature=signatures[mimeType];check(signature,'Only PDF, JPEG and PNG documents are supported.');
 check(typeof b.base64==='string'&&b.base64.length<=Math.ceil(DOCUMENT_MAX_BYTES/3)*4&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.base64),'Choose a valid file.');
 const content=Buffer.from(b.base64 as string,'base64');check(content.length>0&&content.length<=DOCUMENT_MAX_BYTES&&content.toString('base64')===b.base64&&signature.every((n,i)=>content[i]===n),'File must match its type and be at most 1 MB.');
 const side=b.side??'other';check(['front','back','other'].includes(String(side)),'Choose a document side.');
 return {name,mime_type:mimeType,content,content_sha256:digest(content),side};
}
function kyc(input:unknown):Row {
 check(input&&typeof input==='object'&&!Array.isArray(input),'Enter identity details.');const k=input as Row;
 check(Object.keys(k).every(s=>['identityName','documentType','documentNumber','expiryDate','nationality','address','reviewNotes'].includes(s)),'Unknown identity fields.');
 const type=k.documentType??'Other';check(['QID','Passport','Other'].includes(String(type)),'Choose an identity document type.');
 return {identity_name:optional(k.identityName,200),document_type:type,document_number:optional(k.documentNumber,120),expiry_date:k.expiryDate?date(k.expiryDate):null,nationality:optional(k.nationality,120),address:optional(k.address,1000),review_notes:optional(k.reviewNotes,2000)};
}
function safeKyc(row:Row|undefined,asOf:string,documents:Row[]=[]){
 if(!row)return {status:documents.length?'pending-review':'not-added',version:0,documents};
 const {document_number:number,...safe}=row;return {...view(safe),maskedDocumentNumber:number?'••••'+(String(number).length>4?String(number).slice(-4):''):'',status:row.expiry_date&&day(row.expiry_date)<asOf?'expired':row.status,documents};
}
export class CustomerService {
 constructor(private readonly properties:PropertyService){}
 async overview(identity:Identity,query:{asOf:string;q?:string}){
 const asOf=date(query.asOf),q=optional(query.q,200).toLowerCase();
 return this.properties.ownerContext(identity,async sql=>{
      sql=await effectiveLedgerSql(sql);
 const ready=(await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.customer_kyc') IS NOT NULL AS ready")).rows[0]?.ready;
 check(ready,'Customers migration is not available in this environment.','CONFIGURATION_UNAVAILABLE',503);
 const tenants=(await sql.query<Row>('SELECT * FROM hamdee_private.tenants ORDER BY name,id')).rows;
 const terms=(await sql.query<Row>(`SELECT a.*,p.name AS property_name,r.code AS room_code FROM hamdee_private.rental_agreements a JOIN hamdee_private.properties p ON p.id=a.property_id JOIN hamdee_private.rooms r ON r.id=a.room_id`)).rows;
 const occupancyReady=(await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.room_occupancy_confirmations') IS NOT NULL AS ready")).rows[0]?.ready;
 const occupancy=occupancyReady?(await sql.query<Row>(`SELECT s.*,p.name AS property_name,r.code AS room_code FROM (SELECT DISTINCT ON(room_id) * FROM hamdee_private.room_occupancy_confirmations WHERE effective_date<=$1::date ORDER BY room_id,version DESC)s JOIN hamdee_private.rooms r ON r.id=s.room_id JOIN hamdee_private.properties p ON p.id=r.property_id WHERE s.status='occupied'`,[asOf])).rows:[];
 const cars=(await sql.query<Row>(`SELECT a.*,l.customer_id FROM hamdee_private.customer_car_links l JOIN hamdee_private.car_agreements a ON a.id=l.agreement_id`)).rows;
 const identities=(await sql.query<Row>('SELECT DISTINCT ON(customer_id) * FROM hamdee_private.customer_kyc ORDER BY customer_id,version DESC')).rows;
 const documented=new Set((await sql.query<{customer_id:string}>("SELECT DISTINCT customer_id FROM hamdee_private.customer_documents WHERE purpose='kyc'")).rows.map(r=>r.customer_id));
 const balanceRows=await this.allBalances(sql,asOf);
 const customers=[];
 for(const tenant of tenants){
 const property=terms.filter(a=>a.tenant_id===tenant.id),car=cars.filter(a=>a.customer_id===tenant.id);
 const relationships:Row[]=[...property.map(a=>({...view(a),type:'property',current:day(a.start_date)<=asOf&&(!a.end_date||day(a.end_date)>=asOf)})),...car.map(a=>({...view(a),type:'car',current:day(a.start_date)<=asOf&&day(a.end_date)>=asOf}))];
 for(const confirmation of occupancy.filter(o=>o.tenant_id===tenant.id&&!relationships.some(r=>r.type==='property'&&r.roomId===o.room_id&&r.current))){
 const superseded=terms.some(a=>a.room_id===confirmation.room_id&&day(a.start_date)<=asOf&&(day(a.start_date)>day(confirmation.effective_date)||(a.id===confirmation.agreement_id&&a.end_date&&day(a.end_date)<asOf)));
 if(!superseded)relationships.push({...view(confirmation),type:'property',current:true,agreementId:confirmation.agreement_id??null});
 }
 if(q&&![tenant.name,tenant.phone,...relationships.flatMap(a=>[a.propertyName,a.roomCode,JSON.stringify(a.vehicleSnapshot??{})])].some(v=>String(v??'').toLowerCase().includes(q)))continue;
 const balances=balanceRows.filter(b=>b.customerId===tenant.id).map(({customerId:_,...balance})=>{void _;return balance;});
 const k=safeKyc(identities.find(k=>k.customer_id===tenant.id),asOf,documented.has(String(tenant.id))?[{}]:[]);
 customers.push({...view(tenant),customerType:relationships.some(r=>r.type==='property')&&car.length?'both':car.length?'car':relationships.some(r=>r.type==='property')?'property':'unlinked',relationships,balances,kycStatus:k.status,potentialDuplicate:tenants.some(t=>t.id!==tenant.id&&(String(t.name).trim().toLowerCase()===String(tenant.name).trim().toLowerCase()||!!tenant.phone&&t.phone===tenant.phone))});
 }
 return {customers,asOf};
 });
 }
 private async allBalances(sql:Sql,asOf:string):Promise<Row[]>{
 return (await sql.query<Row>(`WITH rows AS(
 SELECT a.tenant_id AS customer_id,d.currency,sum(d.amount_minor-coalesce(p.paid,0)) AS outstanding,0::numeric AS advance,0::numeric AS deposit,0::numeric AS cheque,0::numeric AS car
 FROM hamdee_private.rent_dues d JOIN hamdee_private.rental_agreements a ON a.id=d.agreement_id
 LEFT JOIN LATERAL(SELECT sum(amount_minor) paid FROM hamdee_private.rent_allocations WHERE due_id=d.id AND allocated_date<=$1::date)p ON true
 WHERE d.due_date<=$1::date GROUP BY a.tenant_id,d.currency
 UNION ALL SELECT a.tenant_id,c.currency,0,sum(CASE WHEN c.kind='advance' AND c.status='recorded' THEN c.amount_minor-coalesce(p.paid,0) ELSE 0 END),sum(CASE WHEN c.kind='deposit' AND c.status='recorded' THEN c.amount_minor WHEN c.kind='deposit_refund' THEN -c.amount_minor ELSE 0 END),sum(CASE WHEN c.kind='deposit' AND c.status='pending' THEN c.amount_minor ELSE 0 END),0
 FROM hamdee_private.rent_collections c JOIN hamdee_private.rental_agreements a ON a.id=c.agreement_id
 LEFT JOIN LATERAL(SELECT sum(amount_minor) paid FROM hamdee_private.rent_allocations WHERE collection_id=c.id AND allocated_date<=$1::date)p ON true
 WHERE c.received_date<=$1::date GROUP BY a.tenant_id,c.currency
 UNION ALL SELECT c.customer_id,c.currency,0,0,sum(CASE WHEN s.status='cleared' AND c.agreement_id IS NULL THEN c.amount_minor ELSE 0 END),sum(CASE WHEN s.status IN ('held','presented') THEN c.amount_minor ELSE 0 END),0
 FROM hamdee_private.security_cheques c JOIN LATERAL(SELECT status FROM hamdee_private.security_cheque_events WHERE cheque_id=c.id AND business_date<=$1::date ORDER BY version DESC LIMIT 1)s ON true WHERE c.received_date<=$1::date GROUP BY c.customer_id,c.currency
 UNION ALL SELECT c.customer_id,c.currency,0,0,-sum(r.amount_minor),0,0 FROM hamdee_private.security_deposit_refunds r JOIN hamdee_private.security_cheques c ON c.id=r.cheque_id WHERE r.business_date<=$1::date GROUP BY c.customer_id,c.currency
 UNION ALL SELECT l.customer_id,a.currency,0,0,0,0,sum(a.agreed_amount-coalesce(r.paid,0)) FROM hamdee_private.car_agreements a JOIN hamdee_private.customer_car_links l ON l.agreement_id=a.id LEFT JOIN LATERAL(SELECT sum(amount) paid FROM hamdee_private.car_receipts WHERE agreement_id=a.id AND status='recorded' AND received_date<=$1::date)r ON true WHERE a.start_date<=$1::date GROUP BY l.customer_id,a.currency
 ) SELECT customer_id,currency,sum(outstanding)::text AS outstanding_minor,sum(advance)::text AS advance_minor,sum(deposit)::text AS deposit_minor,sum(cheque)::text AS security_cheque_minor,sum(car)::text AS car_outstanding_amount FROM rows GROUP BY customer_id,currency ORDER BY customer_id,currency`,[asOf])).rows.map(view);
 } private async balances(sql:Sql,customerId:string,asOf:string){
 const rows=(await sql.query<Row>(`SELECT d.currency,sum(d.amount_minor-coalesce(a.paid,0))::text AS outstanding_minor FROM hamdee_private.rent_dues d JOIN hamdee_private.rental_agreements t ON t.id=d.agreement_id LEFT JOIN LATERAL(SELECT sum(amount_minor) AS paid FROM hamdee_private.rent_allocations WHERE due_id=d.id AND allocated_date<=$2::date)a ON true WHERE t.tenant_id=$1 AND d.due_date<=$2::date GROUP BY d.currency`,[customerId,asOf])).rows;
 const groups=new Map<string,Row>();const group=(c:string)=>{if(!groups.has(c))groups.set(c,{currency:c,outstandingMinor:'0',advanceMinor:'0',depositMinor:'0',securityChequeMinor:'0'});return groups.get(c)!;};
 const add=(c:string,key:string,n:unknown)=>{const g=group(c);g[key]=String(BigInt(String(g[key]))+BigInt(String(n)));};
 for(const row of rows)add(String(row.currency),'outstandingMinor',row.outstanding_minor);
 const receipts=(await sql.query<Row>(`SELECT c.*,coalesce((SELECT sum(a.amount_minor) FROM hamdee_private.rent_allocations a WHERE a.collection_id=c.id AND a.allocated_date<=$2::date),0)::text AS allocated FROM hamdee_private.rent_collections c JOIN hamdee_private.rental_agreements a ON a.id=c.agreement_id WHERE a.tenant_id=$1 AND c.received_date<=$2::date AND c.status='recorded'`,[customerId,asOf])).rows;
 for(const c of receipts){if(c.kind==='advance')add(String(c.currency),'advanceMinor',BigInt(String(c.amount_minor))-BigInt(String(c.allocated)));if(c.kind==='deposit'||c.kind==='deposit_refund')add(String(c.currency),'depositMinor',BigInt(String(c.amount_minor))*(c.kind==='deposit'?1n:-1n));}
 const legacyCheques=(await sql.query<Row>(`SELECT c.currency,sum(c.amount_minor)::text AS held FROM hamdee_private.rent_collections c JOIN hamdee_private.rental_agreements a ON a.id=c.agreement_id WHERE a.tenant_id=$1 AND c.received_date<=$2::date AND c.kind='deposit' AND c.status='pending' GROUP BY c.currency`,[customerId,asOf])).rows;
 for(const c of legacyCheques)add(String(c.currency),'securityChequeMinor',c.held);
 const refunds=(await sql.query<Row>('SELECT r.*,c.currency FROM hamdee_private.security_deposit_refunds r JOIN hamdee_private.security_cheques c ON c.id=r.cheque_id WHERE c.customer_id=$1 AND r.business_date<=$2::date',[customerId,asOf])).rows;
 for(const r of refunds)add(String(r.currency),'depositMinor',-BigInt(String(r.amount_minor)));
 const cheques=await this.cheques(sql,customerId,asOf);
 for(const c of cheques){if(['held','presented'].includes(String(c.status)))add(String(c.currency),'securityChequeMinor',c.amountMinor);if(c.status==='cleared'&&!c.agreementId)add(String(c.currency),'depositMinor',c.amountMinor);}
 // Car totals retain their native decimal precision separately from property minor units.
 const car=(await sql.query<Row>(`SELECT a.currency,sum(a.agreed_amount-coalesce(r.paid,0))::text AS outstanding_amount FROM hamdee_private.car_agreements a JOIN hamdee_private.customer_car_links l ON l.agreement_id=a.id LEFT JOIN LATERAL(SELECT sum(amount) AS paid FROM hamdee_private.car_receipts WHERE agreement_id=a.id AND status='recorded' AND received_date<=$2::date)r ON true WHERE l.customer_id=$1 AND a.start_date<=$2::date GROUP BY a.currency`,[customerId,asOf])).rows;
 for(const c of car)group(String(c.currency)).carOutstandingAmount=c.outstanding_amount;
 return [...groups.values()];
 }
 private async cheques(sql:Sql,customerId:string,asOf:string){
 const cheques=(await sql.query<Row>(`SELECT c.*,s.version,s.status,s.business_date,s.reason,s.account_id,s.money_entry_id FROM hamdee_private.security_cheques c JOIN LATERAL(SELECT * FROM hamdee_private.security_cheque_events WHERE cheque_id=c.id AND business_date<=$2::date ORDER BY version DESC LIMIT 1)s ON true WHERE c.customer_id=$1 AND c.received_date<=$2::date ORDER BY c.received_date,c.id`,[customerId,asOf])).rows;
 const events=(await sql.query<Row>(`SELECT s.*,e.actor_id,e.occurred_at FROM hamdee_private.security_cheque_events s JOIN hamdee_private.customer_events e ON e.id=s.event_id WHERE s.cheque_id=ANY($1::uuid[]) AND s.business_date<=$2::date ORDER BY s.cheque_id,s.version`,[cheques.map(c=>c.id),asOf])).rows;
 return cheques.map(c=>({...view(c),history:events.filter(e=>e.cheque_id===c.id).map(view)} as Row));
 }
 async profile(identity:Identity,customer:unknown,query:{asOf:string;from?:string;currency?:string}){
 const customerId=id(customer),asOf=date(query.asOf),from=query.from?date(query.from):'1900-01-01';check(from<=asOf,'Choose an ordered statement period.');
 const currency=query.currency?text(query.currency,3):null;check(!currency||/^[A-Z]{3}$/.test(currency),'Choose an explicit currency.');
 return this.properties.ownerContext(identity,async sql=>{
      sql=await effectiveLedgerSql(sql);
 const tenant=(await sql.query<Row>('SELECT * FROM hamdee_private.tenants WHERE id=$1',[customerId])).rows[0];check(tenant,'Customer not found.','NOT_FOUND',404);
 const properties=(await sql.query<Row>(`SELECT a.*,p.name AS property_name,r.code AS room_code FROM hamdee_private.rental_agreements a JOIN hamdee_private.properties p ON p.id=a.property_id JOIN hamdee_private.rooms r ON r.id=a.room_id WHERE a.tenant_id=$1 ORDER BY a.start_date`,[customerId])).rows;
 const occupancyReady=(await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.room_occupancy_confirmations') IS NOT NULL AS ready")).rows[0]?.ready;
 const occupancyHistory=occupancyReady?(await sql.query<Row>(`SELECT o.*,r.code AS room_code,p.name AS property_name FROM hamdee_private.room_occupancy_confirmations o JOIN hamdee_private.rooms r ON r.id=o.room_id JOIN hamdee_private.properties p ON p.id=r.property_id WHERE o.tenant_id=$1 ORDER BY o.effective_date,o.version`,[customerId])).rows.map(view):[];
 const propertyDocumentsReady=(await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.property_documents') IS NOT NULL AS ready")).rows[0]?.ready;
 const customerRoomIds=[...new Set([...properties.map(p=>p.room_id),...occupancyHistory.map(p=>p.roomId)].filter(Boolean))],customerPropertyIds=[...new Set([...properties.map(p=>p.property_id),...occupancyHistory.map(p=>p.propertyId)].filter(Boolean))];
 const propertyDocuments=propertyDocumentsReady?(await sql.query<Row>(`SELECT id,property_id,room_id,name,mime_type,octet_length(content) AS size,created_at FROM hamdee_private.property_documents WHERE room_id=ANY($1::uuid[]) OR (room_id IS NULL AND property_id=ANY($2::uuid[])) ORDER BY created_at,id`,[customerRoomIds,customerPropertyIds])).rows.map(view):[];
 const agreements=properties.map(a=>a.id);
 const allDues=(await sql.query<Row>(`SELECT d.*,coalesce(a.paid,0)::text AS paid_minor,(d.amount_minor-coalesce(a.paid,0))::text AS outstanding_minor FROM hamdee_private.rent_dues d LEFT JOIN LATERAL(SELECT sum(amount_minor) paid FROM hamdee_private.rent_allocations WHERE due_id=d.id AND allocated_date<=$2::date)a ON true WHERE d.agreement_id=ANY($1::uuid[]) AND d.due_date<=$2::date ORDER BY d.due_date,d.id`,[agreements,asOf])).rows;
 const collections=(await sql.query<Row>('SELECT * FROM hamdee_private.rent_collections WHERE agreement_id=ANY($1::uuid[]) AND received_date BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR currency=$4) ORDER BY received_date,id',[agreements,from,asOf,currency])).rows;
 const statementReceipts=(await sql.query<Row>("SELECT c.*,ARRAY(SELECT DISTINCT d.period FROM hamdee_private.rent_allocations a JOIN hamdee_private.rent_dues d ON d.id=a.due_id WHERE a.collection_id=c.id AND a.allocated_date<=$2::date ORDER BY d.period) AS rental_months FROM hamdee_private.rent_collections c WHERE c.agreement_id=ANY($1::uuid[]) AND c.received_date<=$2::date AND c.status='recorded' AND c.kind IN ('rent','advance') AND ($3::text IS NULL OR c.currency=$3)",[agreements,asOf,currency])).rows;
 const statementRows=[...allDues.filter(d=>!currency||d.currency===currency).map(d=>({id:String(d.id),date:day(d.due_date),period:String(d.period),type:'due',currency:String(d.currency),chargeMinor:String(d.amount_minor),receivedMinor:'0'})),...statementReceipts.map(c=>({id:String(c.id),date:day(c.received_date),period:Array.isArray(c.rental_months)&&c.rental_months.length?c.rental_months.join(', '):null,type:String(c.kind),currency:String(c.currency),chargeMinor:'0',receivedMinor:String(c.amount_minor)}))].sort((a,b)=>a.date.localeCompare(b.date)||Number(b.type==='due')-Number(a.type==='due')||a.id.localeCompare(b.id));
 const running=new Map<string,bigint>(),opening=new Map<string,bigint>();const statement=[];
 for(const row of statementRows){const balance=(running.get(row.currency)??0n)+BigInt(row.chargeMinor)-BigInt(row.receivedMinor);running.set(row.currency,balance);if(row.date<from)opening.set(row.currency,balance);else statement.push({...row,balanceMinor:String(balance)});}
 const statementBalances=[...running].map(([currency,balance])=>({currency,openingMinor:String(opening.get(currency)??0n),closingMinor:String(balance)}));
 const allocations=(await sql.query<Row>('SELECT * FROM hamdee_private.rent_allocations WHERE agreement_id=ANY($1::uuid[]) AND allocated_date BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR currency=$4) ORDER BY allocated_date,id',[agreements,from,asOf,currency])).rows;
 const cars=(await sql.query<Row>('SELECT a.*,a.agreed_amount::text AS agreed_amount FROM hamdee_private.car_agreements a JOIN hamdee_private.customer_car_links l ON l.agreement_id=a.id WHERE l.customer_id=$1 ORDER BY a.start_date',[customerId])).rows;
 const carIds=cars.map(a=>a.id),carReceipts=(await sql.query<Row>('SELECT *,amount::text AS amount FROM hamdee_private.car_receipts WHERE agreement_id=ANY($1::uuid[]) AND received_date BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR currency=$4)',[carIds,from,asOf,currency])).rows;
 const carCosts=(await sql.query<Row>('SELECT *,amount::text AS amount FROM hamdee_private.car_expenses WHERE agreement_id=ANY($1::uuid[]) AND expense_date BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR currency=$4)',[carIds,from,asOf,currency])).rows;
 const allCarReceipts=(await sql.query<Row>("SELECT *,amount::text AS amount FROM hamdee_private.car_receipts WHERE agreement_id=ANY($1::uuid[]) AND received_date<=$2::date AND status='recorded' AND ($3::text IS NULL OR currency=$3)",[carIds,asOf,currency])).rows;
 const scaled=(value:string)=>{const [whole,fraction='']=value.split('.');return BigInt(whole)*1000000000000n+BigInt(fraction.padEnd(12,'0'));};
 const decimal=(value:bigint)=>{const negative=value<0n,n=negative?-value:value,fraction=String(n%1000000000000n).padStart(12,'0').replace(/0+$/,'');return (negative?'-':'')+String(n/1000000000000n)+(fraction?'.'+fraction:'');};
 const carRows=[...cars.filter(c=>day(c.start_date)<=asOf&&(!currency||c.currency===currency)).map(c=>({id:String(c.id),date:day(c.start_date),type:'car-agreement',currency:String(c.currency),chargeAmount:String(c.agreed_amount),receivedAmount:'0',agreementId:c.id})),...allCarReceipts.map(r=>({id:String(r.id),date:day(r.received_date),type:'car-receipt',currency:String(r.currency),chargeAmount:'0',receivedAmount:String(r.amount),agreementId:r.agreement_id}))].sort((a,b)=>a.date.localeCompare(b.date)||a.type.localeCompare(b.type)||a.id.localeCompare(b.id));
 const carRunning=new Map<string,bigint>(),carOpening=new Map<string,bigint>();const carStatement=[];
 for(const row of carRows){const balance=(carRunning.get(row.currency)??0n)+scaled(row.chargeAmount)-scaled(row.receivedAmount);carRunning.set(row.currency,balance);if(row.date<from)carOpening.set(row.currency,balance);else carStatement.push({...row,balanceAmount:decimal(balance)});}
 const carStatementBalances=[...carRunning].map(([currency,balance])=>({currency,openingAmount:decimal(carOpening.get(currency)??0n),closingAmount:decimal(balance)}));
 const k=(await sql.query<Row>('SELECT * FROM hamdee_private.customer_kyc WHERE customer_id=$1 ORDER BY version DESC LIMIT 1',[customerId])).rows[0];
 const documents=(await sql.query<Row>("SELECT id,name,mime_type,side,created_at FROM hamdee_private.customer_documents WHERE customer_id=$1 AND purpose='kyc' ORDER BY created_at,id",[customerId])).rows.map(view);
 const history=(await sql.query<Row>('SELECT * FROM hamdee_private.customer_events WHERE customer_id=$1 ORDER BY occurred_at,id',[customerId])).rows.map(view);
 const carHistory=(await sql.query<Row>(`SELECT e.* FROM hamdee_private.ops_events e WHERE e.id IN (
 SELECT event_id FROM hamdee_private.car_agreements WHERE id=ANY($1::uuid[])
 UNION SELECT event_id FROM hamdee_private.car_receipts WHERE agreement_id=ANY($1::uuid[])
 UNION SELECT event_id FROM hamdee_private.car_expenses WHERE agreement_id=ANY($1::uuid[])) ORDER BY e.occurred_at,e.id`,[carIds])).rows.map(view);
 const moneyHistory=(await sql.query<Row>(`SELECT DISTINCT e.* FROM hamdee_private.ops_events e JOIN hamdee_private.ops_money m ON m.event_id=e.id JOIN hamdee_private.ops_claims c ON c.id=m.claim_id
 WHERE c.snapshot->>'agreementId'=ANY($1::text[]) ORDER BY e.occurred_at,e.id`,[[...agreements,...carIds].map(String)])).rows.map(view);
 const correctionsReady=(await sql.query<{ready:boolean}>("SELECT to_regclass('hamdee_private.financial_corrections') IS NOT NULL AS ready")).rows[0]?.ready;
 const correctionHistory=correctionsReady?(await sql.query<Row>(`SELECT e.*,c.reason FROM hamdee_private.financial_corrections c JOIN hamdee_private.ops_events e ON e.id=c.event_id WHERE
 (c.source_kind='rental-refund' AND EXISTS(SELECT 1 FROM hamdee_private.rent_collections r JOIN hamdee_private.rental_agreements a ON a.id=r.agreement_id WHERE r.id=c.source_id AND a.tenant_id=$1)) OR
 (c.source_kind='security-refund' AND EXISTS(SELECT 1 FROM hamdee_private.security_deposit_refunds r JOIN hamdee_private.security_cheques q ON q.id=r.cheque_id WHERE r.id=c.source_id AND q.customer_id=$1)) ORDER BY e.occurred_at,e.id`,[customerId])).rows.map(view):[];
 const depositRefunds=(await sql.query<Row>(`SELECT r.*,c.currency FROM hamdee_private.security_deposit_refunds r JOIN hamdee_private.security_cheques c ON c.id=r.cheque_id WHERE c.customer_id=$1 AND r.business_date BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR c.currency=$4) ORDER BY r.business_date,r.id`,[customerId,from,asOf,currency])).rows.map(view);
 const rentalHistory=(await sql.query<Row>(`SELECT * FROM hamdee_private.rental_events WHERE entity_id=$1 OR entity_id=ANY($2::uuid[]) OR entity_id=ANY($3::uuid[]) ORDER BY occurred_at,id`,[customerId,agreements,[...allDues,...collections,...allocations].map(r=>r.id)])).rows.map(view);
 return {depositRefunds,occupancyHistory,propertyDocuments,carStatement,carStatementBalances,carStatementBasis: 'Explicit total agreed car amounts dated at rental start minus actual recorded receipts; decimal major units, without proration.',statement,statementBalances,statementBasis:'Issued property dues minus actual recorded rent and advances; deposits and pending cheques excluded. Receipt date and rental period are separate.',customer:{...view(tenant),balances:await this.balances(sql,customerId,asOf)},properties:properties.map(view),carRentals:cars.map(c=>({...view(c),collections:carReceipts.filter(r=>r.agreement_id===c.id).map(view),expenses:carCosts.filter(r=>r.agreement_id===c.id).map(view)})),dues:allDues.filter(d=>day(d.due_date)>=from&&(!currency||d.currency===currency)).map(view),collections:collections.map(view),allocations:allocations.map(view),cheques:(await this.cheques(sql,customerId,asOf)).filter(c=>!currency||c.currency===currency),kyc:safeKyc(k,asOf,documents),history:[...new Map([...history,...rentalHistory,...carHistory,...moneyHistory,...correctionHistory].map(event=>[event.id,event])).values()].sort((a,b)=>String(a.occurredAt).localeCompare(String(b.occurredAt))||String(a.id).localeCompare(String(b.id))),asOf,from,currency};
 });
 }
 async getDocument(identity:Identity,value:unknown){return this.properties.ownerContext(identity,async sql=>{
      sql=await effectiveLedgerSql(sql);
 const r=(await sql.query<Row>('SELECT * FROM hamdee_private.customer_documents WHERE id=$1',[id(value)])).rows[0];check(r,'Document not found.','NOT_FOUND',404);check(r.content instanceof Uint8Array&&r.content.length<=DOCUMENT_MAX_BYTES&&digest(r.content)===r.content_sha256,'Document is unavailable.','DOCUMENT_UNAVAILABLE',503);return {name:String(r.name),mimeType:String(r.mime_type),content:Buffer.from(r.content as Uint8Array)};
 });}
 async mutate(identity:Identity,input:unknown,key:string,requestId:string){
 id(key);const b=allowFields(input,{'create-customer':['name','phone','email','notes','kyc','documents'],'update-kyc':['customerId','expectedVersion','kyc','reason'],'review-kyc':['customerId','expectedVersion','status','reason'],'upload-kyc':['customerId','name','mimeType','base64','side'],'link-car':['customerId','agreementId','reason'],'reveal-identity':['customerId'],'record-security-cheque':['customerId','agreementId','carAgreementId','chequeNumber','bank','drawerName','chequeDate','receivedDate','amount','currency','notes','replacesId','image'],'transition-cheque':['chequeId','expectedVersion','status','businessDate','reason','accountId'],'reverse-cleared-cheque':['chequeId','expectedVersion','businessDate','reason'],'refund-security-deposit':['chequeId','expectedVersion','businessDate','amount','accountId','reason']});
 const hash=digest(canonical(b));
 return this.properties.ownerContext(identity,async(sql,actorId)=>{
      sql=await effectiveLedgerSql(sql);
 await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['hamdee-operations-money']);
 const saved=(await sql.query<{digest:string;result:Row}>('SELECT digest,result FROM hamdee_private.customer_commands WHERE actor_id=$1 AND key=$2',[actorId,key])).rows[0];
 if(saved){check(saved.digest===hash,'Use a new operation key for changed data.','IDEMPOTENCY_KEY_REUSED',409);if(b.action!=='reveal-identity')return {...saved.result,replay:true};}
 let customerId=b.action==='create-customer'?randomUUID():b.customerId?id(b.customerId):null;
 let cheque:Row|undefined;
 if(b.action==='transition-cheque'||b.action==='reverse-cleared-cheque'||b.action==='refund-security-deposit'){cheque=(await sql.query<Row>('SELECT * FROM hamdee_private.security_cheques WHERE id=$1',[id(b.chequeId)])).rows[0];check(cheque,'Cheque not found.','NOT_FOUND',404);customerId=String(cheque.customer_id);}
 check(customerId,'Choose a customer.');
 if(b.action!=='create-customer')check((await sql.query('SELECT id FROM hamdee_private.tenants WHERE id=$1',[customerId])).rows.length,'Customer not found.','NOT_FOUND',404);
 const eventId=randomUUID(),reason=optional(b.reason,2000);let data:Row={id:customerId};
 const event=()=>insertOperation(sql,'customer_events',{id:eventId,customer_id:customerId,action:b.action,reason,actor_id:actorId});
 if(b.action==='create-customer'){
 const rentalEvent=randomUUID();await insertOperation(sql,'rental_events',{id:rentalEvent,property_id:null,room_id:null,entity_id:customerId,action:'create-tenant',detail:JSON.stringify({fields:['name','phone','email','notes'],requestId}),actor_id:actorId});
 const tenant=await insertOperation(sql,'tenants',{id:customerId,name:text(b.name,200),phone:optional(b.phone,60),email:optional(b.email,254),notes:optional(b.notes,1000),version:1,event_id:rentalEvent});data=view(tenant);await event();
 if(b.kyc)await insertOperation(sql,'customer_kyc',{customer_id:customerId,version:1,...kyc(b.kyc),status:'pending-review',reviewed_by:null,reviewed_at:null,event_id:eventId});
 if(b.documents!==undefined){check(Array.isArray(b.documents)&&b.documents.length<=2,'Attach at most two identity files.');for(const f of b.documents)await insertOperation(sql,'customer_documents',{id:randomUUID(),customer_id:customerId,...document(f),event_id:eventId});}
 }else{
 await event();
 if(b.action==='update-kyc'||b.action==='review-kyc'){
 check(reason,'Record why the identity details or review changed.');
 const old=(await sql.query<Row>('SELECT * FROM hamdee_private.customer_kyc WHERE customer_id=$1 ORDER BY version DESC LIMIT 1',[customerId])).rows[0];
 check(Number.isInteger(b.expectedVersion)&&b.expectedVersion===(old?.version??0),'Identity details changed. Reload before saving.','VERSION_CONFLICT',412);
 if(b.action==='review-kyc'){
 check(old,'Add identity details before review.');check(['verified','pending-review'].includes(String(b.status)),'Choose a review status.');
 const verified=b.status==='verified';check(!verified||!!old.document_number&&!!old.identity_name,'Confirm identity name and document number before verifying.');
 check(!verified||!old.expiry_date||day(old.expiry_date)>=new Date().toISOString().slice(0,10),'An expired identity cannot be verified.');
 const {customer_id:_,version:__,event_id:___,...fields}=old;void _;void __;void ___;
 const updated=await insertOperation(sql,'customer_kyc',{customer_id:customerId,version:Number(old.version)+1,...fields,status:b.status,reviewed_by:verified?actorId:null,reviewed_at:verified?new Date():null,event_id:eventId});data=safeKyc(updated,new Date().toISOString().slice(0,10));
 }else{const updated=await insertOperation(sql,'customer_kyc',{customer_id:customerId,version:Number(old?.version??0)+1,...kyc(b.kyc),status:'pending-review',reviewed_by:null,reviewed_at:null,event_id:eventId});data=safeKyc(updated,new Date().toISOString().slice(0,10));}
 }else if(b.action==='upload-kyc'){
 const {customerId:_,action:__,...file}=b;void _;void __;const f=document(file);
 const row=await insertOperation(sql,'customer_documents',{id:randomUUID(),customer_id:customerId,...f,event_id:eventId});data={id:row.id,name:row.name,mimeType:row.mime_type,side:row.side};
 // Adding a document invalidates any prior verification and preserves its revision.
 const old=(await sql.query<Row>('SELECT * FROM hamdee_private.customer_kyc WHERE customer_id=$1 ORDER BY version DESC LIMIT 1',[customerId])).rows[0];
 if(old){const {customer_id:_,version:__,event_id:___,...fields}=old;void _;void __;void ___;await insertOperation(sql,'customer_kyc',{customer_id:customerId,version:Number(old.version)+1,...fields,status:'pending-review',reviewed_by:null,reviewed_at:null,event_id:eventId});}
 }else if(b.action==='link-car'){
 check(reason,'Record why these records belong to the same customer.');const agreementId=id(b.agreementId);check((await sql.query('SELECT id FROM hamdee_private.car_agreements WHERE id=$1',[agreementId])).rows.length,'Car agreement not found.','NOT_FOUND',404);
 const existing=(await sql.query<Row>('SELECT * FROM hamdee_private.customer_car_links WHERE agreement_id=$1',[agreementId])).rows[0];check(!existing,'This car rental already has a customer link.','ALREADY_LINKED',409);
 data=view(await insertOperation(sql,'customer_car_links',{agreement_id:agreementId,customer_id:customerId,event_id:eventId}));
 }else if(b.action==='reveal-identity'){
 const current=(await sql.query<Row>('SELECT document_number FROM hamdee_private.customer_kyc WHERE customer_id=$1 ORDER BY version DESC LIMIT 1',[customerId])).rows[0];
 const result={data:{customerId,documentNumber:current?.document_number??''},replay:!!saved};
 if(!saved)await insertOperation(sql,'customer_commands',{actor_id:actorId,key,digest:hash,result:JSON.stringify({data:{customerId},replay:false}),event_id:eventId});return result;
 }else if(b.action==='record-security-cheque'){
 const agreementId=b.agreementId?id(b.agreementId):null,carId=b.carAgreementId?id(b.carAgreementId):null;check(!(agreementId&&carId),'Choose one rental relationship.');
 const currency=text(b.currency,3);check(/^[A-Z]{3}$/.test(currency),'Choose an explicit currency.');
 if(agreementId)check((await sql.query('SELECT id FROM hamdee_private.rental_agreements WHERE id=$1 AND tenant_id=$2 AND currency=$3',[agreementId,customerId,currency])).rows.length,'Choose this customer’s rental in the cheque currency.');
 if(carId)check((await sql.query('SELECT a.id FROM hamdee_private.car_agreements a JOIN hamdee_private.customer_car_links l ON l.agreement_id=a.id WHERE a.id=$1 AND l.customer_id=$2 AND a.currency=$3',[carId,customerId,currency])).rows.length,'Choose this customer’s car rental in the cheque currency.');
 const received=date(b.receivedDate),replaces=b.replacesId?id(b.replacesId):null;
 if(replaces){const old=(await sql.query<Row>('SELECT c.*,s.status,s.version,s.business_date FROM hamdee_private.security_cheques c JOIN LATERAL(SELECT * FROM hamdee_private.security_cheque_events WHERE cheque_id=c.id ORDER BY version DESC LIMIT 1)s ON true WHERE c.id=$1',[replaces])).rows[0];check(old&&old.customer_id===customerId&&['held','presented','bounced','returned','cancelled'].includes(String(old.status)),'Choose an uncleared cheque belonging to this customer.');check(received>=day(old.business_date),'Replacement cannot precede the previous cheque history.');await insertOperation(sql,'security_cheque_events',{cheque_id:replaces,version:Number(old.version)+1,status:'replaced',business_date:received,reason:'Replacement cheque received',event_id:eventId});}
 const imageId=b.image?randomUUID():null;if(imageId)await insertOperation(sql,'customer_documents',{id:imageId,customer_id:customerId,purpose:'cheque',...document(b.image),event_id:eventId});
 const row=await insertOperation(sql,'security_cheques',{id:randomUUID(),customer_id:customerId,agreement_id:agreementId,car_agreement_id:carId,cheque_number:text(b.chequeNumber,120),bank:text(b.bank,200),drawer_name:text(b.drawerName,200),cheque_date:date(b.chequeDate),received_date:received,amount_minor:money(b.amount),currency,notes:optional(b.notes,2000),image_document_id:imageId,replaces_id:replaces,event_id:eventId});
 await insertOperation(sql,'security_cheque_events',{cheque_id:row.id,version:1,status:'held',business_date:received,reason:'Security cheque received',event_id:eventId});data={...view(row),status:'held',version:1};
 }else if(b.action==='refund-security-deposit'){
 check(!cheque!.agreement_id,'Use the linked rental deposit refund so property history stays connected.');
 const state=(await sql.query<Row>('SELECT * FROM hamdee_private.security_cheque_events WHERE cheque_id=$1 ORDER BY version DESC LIMIT 1',[cheque!.id])).rows[0];
 check(b.expectedVersion===state.version,'Cheque history changed. Reload before saving.','VERSION_CONFLICT',412);check(state.status==='cleared','Only funded cleared deposits can be refunded.');
 check(reason,'Record the actual refund reason.');const when=date(b.businessDate),n=money(b.amount);check(when>=day(state.business_date),'Refund cannot precede clearance.');
 const refunded=(await sql.query<{total:string}>('SELECT coalesce(sum(amount_minor),0)::text AS total FROM hamdee_private.security_deposit_refunds WHERE cheque_id=$1',[cheque!.id])).rows[0].total;
 check(BigInt(refunded)+BigInt(n)<=BigInt(String(cheque!.amount_minor)),'Refund exceeds the funded deposit.','DEPOSIT_EXCEEDED',409);
 const account=await cashAccount(sql,b.accountId,true);check(account.currency===cheque!.currency&&when>=day(account.opening_date),'Choose a company funding account in the deposit currency.');
 const opsId=randomUUID(),minor=BigInt(n),amount=`${minor/100n}.${String(minor%100n).padStart(2,'0')}`;
 const entry=await moneyEntry(sql,opsId,{account_id:account.id,business_date:when,delta:'-'+amount,currency:cheque!.currency,method:account.kind,entry_kind:'expense',classification:'security-deposit-refund',notes:reason});
 await insertOperation(sql,'ops_expense_keys',{id:randomUUID(),entry_id:entry.id,event_id:opsId});
 await insertOperation(sql,'ops_events',{id:opsId,actor_id:actorId,action:'security-deposit:refund',detail:JSON.stringify({chequeId:cheque!.id,moneyEntryId:entry.id,reason,requestId})});await assertFunds(sql);
 data=view(await insertOperation(sql,'security_deposit_refunds',{id:randomUUID(),cheque_id:cheque!.id,amount_minor:n,business_date:when,reason,money_entry_id:entry.id,event_id:eventId})); }else if(b.action==='reverse-cleared-cheque'){
 const state=(await sql.query<Row>('SELECT * FROM hamdee_private.security_cheque_events WHERE cheque_id=$1 ORDER BY version DESC LIMIT 1',[cheque!.id])).rows[0];
 check(b.expectedVersion===state.version,'Cheque history changed. Reload before saving.','VERSION_CONFLICT',412);
 check(state.status==='cleared','Only a confirmed cleared cheque can have its bank posting reversed.','INVALID_CHEQUE_TRANSITION',409);
 check(reason,'Record the confirmed bank reversal reason.');const when=date(b.businessDate);check(when>=day(state.business_date),'Reversal cannot precede clearance.');
 check(!(await sql.query('SELECT cheque_id FROM hamdee_private.security_deposit_refunds WHERE cheque_id=$1 GROUP BY cheque_id HAVING sum(amount_minor)>0',[cheque!.id])).rows.length,'Correct the funded refunds before reversing clearance.','DEPOSIT_EXCEEDED',409);
 if(!cheque!.agreement_id){
  const refunds=(await sql.query<Row>('SELECT business_date,amount_minor FROM hamdee_private.security_deposit_refunds WHERE cheque_id=$1',[cheque!.id])).rows;
  const days=new Map<string,bigint>([[day(state.business_date),BigInt(String(cheque!.amount_minor))]]);
  for(const r of refunds){const d=day(r.business_date);days.set(d,(days.get(d)??0n)-BigInt(String(r.amount_minor)));}
  days.set(when,(days.get(when)??0n)-BigInt(String(cheque!.amount_minor)));let held=0n;
  for(const [,delta] of [...days].sort(([a],[b])=>a.localeCompare(b))){held+=delta;check(held>=0n,'This reversal would invalidate a dated funded refund.','DEPOSIT_EXCEEDED',409);}
 }
 const opsId=randomUUID();await reverseMoney(sql,opsId,state.money_entry_id,when,reason);
 const reversal=(await sql.query<Row>('SELECT id FROM hamdee_private.ops_money WHERE reversal_of=$1',[state.money_entry_id])).rows[0];
 if(cheque!.agreement_id){
 const terms=(await sql.query<Row>('SELECT * FROM hamdee_private.rental_agreements WHERE id=$1',[cheque!.agreement_id])).rows[0];
 // A deposit correction must leave all dated refundable balances nonnegative.
 const movements=(await sql.query<Row>("SELECT received_date,kind,amount_minor FROM hamdee_private.rent_collections WHERE agreement_id=$1 AND status='recorded' AND kind IN ('deposit','deposit_refund')",[terms.id])).rows;
 const byDay=new Map<string,bigint>();for(const m of movements){const d=day(m.received_date);byDay.set(d,(byDay.get(d)??0n)+(m.kind==='deposit'?1n:-1n)*BigInt(String(m.amount_minor)));}
 byDay.set(when,(byDay.get(when)??0n)-BigInt(String(cheque!.amount_minor)));let balance=0n;
 for(const [,n] of [...byDay].sort(([a],[b])=>a.localeCompare(b))){balance+=n;check(balance>=0n,'This deposit has already been refunded or used. Review the linked correction before reversing.','DEPOSIT_EXCEEDED',409);}
 const rentalEvent=randomUUID(),collectionId=randomUUID();await insertOperation(sql,'rental_events',{id:rentalEvent,property_id:terms.property_id,room_id:terms.room_id,entity_id:collectionId,action:'security-cheque-bank-reversal',detail:JSON.stringify({chequeId:cheque!.id,originalCollectionId:state.rental_collection_id,reason,requestId}),actor_id:actorId});
 await insertOperation(sql,'rent_collections',{id:collectionId,agreement_id:terms.id,room_id:terms.room_id,property_id:terms.property_id,currency:terms.currency,kind:'deposit_refund',method:'bank',amount_minor:String(cheque!.amount_minor),received_date:when,reference:'Bank correction: '+String(cheque!.cheque_number).slice(0,180),status:'recorded',event_id:rentalEvent});
 }
 await insertOperation(sql,'ops_events',{id:opsId,actor_id:actorId,action:'security-cheque:bank-reversal',detail:JSON.stringify({chequeId:cheque!.id,reversalEntryId:reversal.id,reason,requestId})});await assertFunds(sql);
 data={...view(cheque!),...view(await insertOperation(sql,'security_cheque_events',{cheque_id:cheque!.id,version:Number(state.version)+1,status:'bounced',business_date:when,reason,reversal_entry_id:reversal.id,event_id:eventId}))}; }else if(b.action==='transition-cheque'){
 const state=(await sql.query<Row>('SELECT * FROM hamdee_private.security_cheque_events WHERE cheque_id=$1 ORDER BY version DESC LIMIT 1',[cheque!.id])).rows[0];check(b.expectedVersion===state.version,'Cheque history changed. Reload before saving.','VERSION_CONFLICT',412);
 const next=String(b.status),allowed:Record<string,string[]>={held:['presented','returned','cancelled'],presented:['cleared','bounced','returned','cancelled']};check(allowed[String(state.status)]?.includes(next),'This cheque transition is unavailable. Cleared postings require a separate explicit correction.','INVALID_CHEQUE_TRANSITION',409);
 check(reason,'Record the reason for this cheque change.');const when=date(b.businessDate);check(when>=day(state.business_date)&&when>=day(cheque!.received_date),'Cheque history dates must be ordered.');
 const values:Row={cheque_id:cheque!.id,version:Number(state.version)+1,status:next,business_date:when,reason,event_id:eventId};
 if(next==='cleared'){
 const account=await cashAccount(sql,b.accountId,true);check(account.kind==='bank'&&account.currency===cheque!.currency&&when>=day(account.opening_date),'Choose a company bank account in the cheque currency after its opening date.');check(when>=day(cheque!.cheque_date),'Clearance cannot precede the cheque date.');
 const opsId=randomUUID(),minor=BigInt(String(cheque!.amount_minor)),amount=`${minor/100n}.${String(minor%100n).padStart(2,'0')}`;
 let sourceKind:'property-rent'|'classified-receipt'='classified-receipt',sourceId:string;
 if(cheque!.agreement_id){
 const terms=(await sql.query<Row>('SELECT * FROM hamdee_private.rental_agreements WHERE id=$1',[cheque!.agreement_id])).rows[0];
 const rentalEvent=randomUUID(),collectionId=randomUUID();
 await insertOperation(sql,'rental_events',{id:rentalEvent,property_id:terms.property_id,room_id:terms.room_id,entity_id:collectionId,action:'security-cheque-clearance',detail:JSON.stringify({chequeId:cheque!.id,requestId}),actor_id:actorId});
 await insertOperation(sql,'rent_collections',{id:collectionId,agreement_id:terms.id,room_id:terms.room_id,property_id:terms.property_id,currency:terms.currency,kind:'deposit',method:'bank',amount_minor:String(cheque!.amount_minor),received_date:when,reference:String(cheque!.cheque_number),status:'recorded',event_id:rentalEvent});
 sourceKind='property-rent';sourceId=collectionId;values.rental_collection_id=collectionId;
 }else{
 const receipt=await insertOperation(sql,'ops_receipts',{id:randomUUID(),receipt_key:randomUUID(),classification:'security-deposit',received_date:when,amount,currency:cheque!.currency,method:'bank',status:'recorded',reference:String(cheque!.cheque_number),notes:'Confirmed security cheque clearance; refundable deposit',event_id:opsId});
 sourceId=String(receipt.id);values.funded_receipt_id=receipt.id;
 }
 const source=await verifiedReceipt(sql,localReceiptReader,sourceKind,sourceId),claim=await sourceClaim(sql,opsId,source);
 const entry=await moneyEntry(sql,opsId,{account_id:account.id,entry_kind:'receipt',delta:amount,currency:cheque!.currency,business_date:when,method:'bank',claim_id:claim,classification:source.classification,reference:String(cheque!.cheque_number)});
 await insertOperation(sql,'ops_events',{id:opsId,actor_id:actorId,action:'security-cheque:clear',detail:JSON.stringify({chequeId:cheque!.id,moneyEntryId:entry.id,requestId})});
 values.account_id=account.id;values.money_entry_id=entry.id;await assertFunds(sql);
 }else check(b.accountId===undefined,'Only clearance posts to a bank account.');
 data={...view(cheque!),...view(await insertOperation(sql,'security_cheque_events',values))};
 }
 }
 const result={data,replay:false};await insertOperation(sql,'customer_commands',{actor_id:actorId,key,digest:hash,result:JSON.stringify(result),event_id:eventId});return result;
 });
 }
}
