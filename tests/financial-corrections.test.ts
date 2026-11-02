import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {operationsFixture} from './support/operations-fixture';
import {ExpenseService} from '../src/expenses';
import {CustomerService} from '../src/customers';
import {FinancialCorrectionService} from '../src/financial-corrections';
type Row=Record<string,unknown>;
const query={month:'2026-11',asOf:'2026-11-30'};
async function setup(t:test.TestContext){
 const f=await operationsFixture();t.after(()=>f.pg.close());
 for(const file of ['007_local_car_rentals.up.sql','011_local_owner_occupancy.up.sql','012_local_private_documents.up.sql','013_local_customers_kyc_cheques.up.sql','014_local_connected_funding.up.sql','015_local_account_reconciliation.up.sql','016_local_scoped_expenses.up.sql','017_local_corrections_and_source_compatibility.up.sql'])await f.pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const expenses=new ExpenseService(f.properties),customers=new CustomerService(f.properties),corrections=new FinancialCorrectionService(f.properties);
 const expense=async(b:unknown)=>(await expenses.mutate(f.identity,b,randomUUID(),randomUUID()) as {data:Row}).data;
 const customer=async(b:unknown)=>(await customers.mutate(f.identity,b,randomUUID(),randomUUID()) as {data:Row}).data;
 const rental=async(b:unknown)=>(await f.rental.mutate(f.identity,b,randomUUID(),randomUUID()) as {data:Row}).data;
 const correct=async(b:unknown,key=randomUUID())=>corrections.mutate(f.identity,b,key,randomUUID());
 const balance=async(accountId:unknown,asOf=query.asOf)=>Number((await f.finance.overview(f.identity,{month:'2026-11',asOf,accountId:String(accountId)})).totals[0].balance);
 return {...f,expenses,customers,corrections,expense,customer,rental,correct,balance};
}
test('funded bill correction preserves original, replaces once and retains prior dated bill/account snapshots',async t=>{
 const f=await setup(t),account=await f.account({openingDate:'2026-11-01',openingAmount:'1000'}),p=await f.create();
 const bill=await f.expense({action:'record-expense',propertyId:p.id,category:'maintenance',expenseDate:'2026-11-02',amount:'600',currency:'XTS',vendorName:'Synthetic correction vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-11-03',fundingAccountId:account.id,reference:'SYN-ORIGINAL'}});
 const payment=(await f.pg.query<Row>('SELECT * FROM hamdee_private.expense_payments')).rows[0],original=JSON.stringify(payment),key=randomUUID();
 const command={action:'correct-expense-payment',paymentId:payment.id,correctedOn:'2026-11-05',reason:'Synthetic entered wrong paid amount',replacement:{amount:'150',method:'cash',fundingAccountId:account.id,reference:'SYN-ORIGINAL'}};
 const results=await Promise.all([f.correct(command,key),f.correct(command,key)]);assert.equal(results.filter(r=>r.replay).length,1);assert.equal(await f.balance(account.id),850);assert.equal(await f.balance(account.id,'2026-11-04'),800);
 let costs=await f.expenses.overview(f.identity,query);assert.equal((costs.expenses[0] as Row).paidMinor,'15000');assert.equal(costs.expenses[0].outstandingMinor,'45000');assert.equal((costs.expenses[0] as Row).id,bill.id);
 costs=await f.expenses.overview(f.identity,{...query,asOf:'2026-11-04'});assert.equal((costs.expenses[0] as Row).paidMinor,'20000');
 assert.equal(JSON.stringify((await f.pg.query('SELECT * FROM hamdee_private.expense_payments WHERE id=$1',[payment.id])).rows[0]),original);
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.property_expenses')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM hamdee_private.expense_payments')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM hamdee_private.financial_corrections')).rows.length,1);
 await assert.rejects(f.correct(command));await assert.rejects(f.correct({...command,reason:'Changed submission'},key));
 await assert.rejects(f.expense({action:'record-payment',expenseId:bill.id,method:'cash',amount:'50',paymentDate:'2026-11-06',fundingAccountId:account.id,reference:'SYN-ORIGINAL'}));
 const replacement=results[0].data.replacementId;await f.correct({action:'correct-expense-payment',paymentId:replacement,correctedOn:'2026-11-06',reason:'Synthetic source void after review'});
 assert.equal(await f.balance(account.id),1000);assert.equal((await f.expenses.overview(f.identity,query)).expenses[0].outstandingMinor,'60000');
});
test('failed replacement rolls back source correction and same key can succeed with actual funds; generic source reversal denied',async t=>{
 const f=await setup(t),account=await f.account({openingAmount:'1000'}),collector=await f.collector(),p=await f.create();
 await f.expense({action:'record-expense',propertyId:p.id,category:'cleaning',expenseDate:'2026-11-01',amount:'600',currency:'XTS',vendorName:'Synthetic rollback vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-11-02',fundingAccountId:account.id}});
 const payment=(await f.pg.query<Row>('SELECT * FROM hamdee_private.expense_payments')).rows[0],link=(await f.pg.query<Row>('SELECT * FROM hamdee_private.expense_funding_links')).rows[0];
 await assert.rejects(f.writeFinance({action:'reverse',entryId:link.entry_id,reversedOn:'2026-11-05',reason:'Synthetic unsafe standalone reversal'}));
 const key=randomUUID(),command={action:'correct-expense-payment',paymentId:payment.id,correctedOn:'2026-11-05',reason:'Synthetic actual payer correction',replacement:{amount:'150',method:'cash',fundingCollectorId:collector.id}};
 await assert.rejects(f.correct({...command,replacement:false}));assert.equal((await f.pg.query('SELECT * FROM hamdee_private.financial_corrections')).rows.length,0);
 await assert.rejects(f.correct(command,key));assert.equal((await f.pg.query('SELECT * FROM hamdee_private.financial_corrections')).rows.length,0);assert.equal(await f.balance(account.id),800);
 const receipt=await f.receipt({amount:'300',receivedOn:'2026-11-01'});await f.collect(collector.id,receipt.id);
 await f.correct(command,key);assert.equal(await f.balance(account.id),1000);assert.equal(Number((await f.staff.overview(f.identity,query)).totals[0].balance),150);
 await assert.rejects(f.corrections.overview({issuer:f.identity.issuer,subject:f.users.reader.subject},{asOf:query.asOf}));
});
test('funded rental refund correction restores and replaces deposit/account once without rent income',async t=>{
 const f=await setup(t),p=await f.create(),tenant=await f.customer({action:'create-customer',name:'Synthetic refundable tenant'}),account=await f.account();
 const room=await f.rental({action:'create-room',propertyId:p.id,code:'REFUND'}),terms=await f.rental({action:'create-agreement',roomId:room.id,tenantId:tenant.id,startDate:'2026-11-01',monthlyRent:'2000',currency:'XTS',depositRequired:'2000',dueTerms:'Synthetic explicit monthly terms'});
 await f.rental({action:'issue-due',agreementId:terms.id,period:'2026-11',dueDate:'2026-11-01',amount:'2000'});
 await f.rental({action:'record-collection',agreementId:terms.id,kind:'deposit',method:'cash',amount:'2000',receivedDate:'2026-11-02',receivingAccountId:account.id,accountConfirmed:true});
 const refund=await f.rental({action:'refund-deposit',agreementId:terms.id,method:'cash',amount:'500',receivedDate:'2026-11-03',fundingAccountId:account.id});
 const correction=await f.correct({action:'correct-rental-refund',collectionId:refund.id,correctedOn:'2026-11-05',reason:'Synthetic refund amount correction',replacement:{amount:'300',method:'cash',fundingAccountId:account.id}});
 assert.equal(await f.balance(account.id),1700);let profile=await f.customers.profile(f.identity,tenant.id,{asOf:query.asOf});assert.equal(profile.customer.balances[0].depositMinor,'170000');assert.equal(profile.customer.balances[0].outstandingMinor,'200000');
 profile=await f.customers.profile(f.identity,tenant.id,{asOf:'2026-11-04'});assert.equal(profile.customer.balances[0].depositMinor,'150000');
 const filtered=await f.customers.profile(f.identity,tenant.id,{asOf:'2026-11-05',from:'2026-11-05'});assert.ok(filtered.history.some(event=>event.reason==='Synthetic refund amount correction'&&event.actorId===f.users.admin.id));
 await f.correct({action:'correct-rental-refund',collectionId:correction.data.replacementId,correctedOn:'2026-11-06',reason:'Synthetic void replacement refund'});assert.equal(await f.balance(account.id),2000);
 assert.equal((await f.customers.profile(f.identity,tenant.id,{asOf:query.asOf})).customer.balances[0].depositMinor,'200000');
});
test('unlinked cheque refund correction preserves dated funded balance and prevents a backdated clearance reversal',async t=>{
 const f=await setup(t),tenant=await f.customer({action:'create-customer',name:'Synthetic cheque refund customer'}),account=await f.account({kind:'bank'});
 const cheque=await f.customer({action:'record-security-cheque',customerId:tenant.id,chequeNumber:'SYN-REFUND',bank:'Synthetic bank',drawerName:'Synthetic drawer',chequeDate:'2026-11-01',receivedDate:'2026-11-01',amount:'2000',currency:'XTS'});
 await f.customer({action:'transition-cheque',chequeId:cheque.id,expectedVersion:1,status:'presented',businessDate:'2026-11-02',reason:'Synthetic presented'});await f.customer({action:'transition-cheque',chequeId:cheque.id,expectedVersion:2,status:'cleared',businessDate:'2026-11-03',reason:'Synthetic confirmed clearance',accountId:account.id});
 const refund=await f.customer({action:'refund-security-deposit',chequeId:cheque.id,expectedVersion:3,businessDate:'2026-11-05',amount:'500',accountId:account.id,reason:'Synthetic original refund'});
 const correction=await f.correct({action:'correct-security-refund',refundId:refund.id,correctedOn:'2026-11-06',reason:'Synthetic wrong refund amount',replacement:{amount:'200',method:'bank',fundingAccountId:account.id}});assert.equal(await f.balance(account.id),1800);
 assert.equal((await f.customers.profile(f.identity,tenant.id,{asOf:'2026-11-05'})).customer.balances[0].depositMinor,'150000');
 assert.equal((await f.customers.profile(f.identity,tenant.id,{asOf:query.asOf})).customer.balances[0].depositMinor,'180000');
 await f.correct({action:'correct-security-refund',refundId:correction.data.replacementId,correctedOn:'2026-11-10',reason:'Synthetic void refund after review'});assert.equal(await f.balance(account.id),2000);
 await assert.rejects(f.customer({action:'reverse-cleared-cheque',chequeId:cheque.id,expectedVersion:3,businessDate:'2026-11-04',reason:'Synthetic unsafe backdated bounce'}));
 await f.customer({action:'reverse-cleared-cheque',chequeId:cheque.id,expectedVersion:3,businessDate:'2026-11-11',reason:'Synthetic confirmed bounce after refunds corrected'});assert.equal(await f.balance(account.id),0);
});

test('late correction audit failure rolls back compensation, replacement and source history; competing distinct corrections have one winner',async t=>{
 const f=await setup(t),account=await f.account({openingAmount:'1000'}),p=await f.create();
 await f.expense({action:'record-expense',propertyId:p.id,category:'maintenance',expenseDate:'2026-11-01',amount:'600',currency:'XTS',vendorName:'Synthetic late audit vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-11-02',fundingAccountId:account.id}});
 const payment=(await f.pg.query<Row>('SELECT * FROM hamdee_private.expense_payments')).rows[0],command={action:'correct-expense-payment',paymentId:payment.id,correctedOn:'2026-11-05',reason:'Synthetic correction rollback proof',replacement:{amount:'100',method:'cash',fundingAccountId:account.id}},key=randomUUID();
 const tables=['expense_payments','expense_events','expense_funding_links','ops_money','ops_expense_keys','ops_events','ops_commands','financial_corrections'];
 const snapshot=()=>Promise.all(tables.map(async table=>(await f.pg.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM hamdee_private.${table} t`)).rows));
 const before=await snapshot();await f.pg.exec("CREATE FUNCTION hamdee_private.synthetic_deny_correction_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'financial-correction:%' THEN RAISE EXCEPTION 'synthetic correction audit unavailable';END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_correction_audit BEFORE INSERT ON hamdee_private.ops_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.synthetic_deny_correction_audit();GRANT EXECUTE ON FUNCTION hamdee_private.synthetic_deny_correction_audit() TO hamdee_runtime");
 await assert.rejects(f.correct(command,key));assert.deepEqual(await snapshot(),before);
 await f.pg.exec('DROP TRIGGER synthetic_correction_audit ON hamdee_private.ops_events;DROP FUNCTION hamdee_private.synthetic_deny_correction_audit()');
 const results=await Promise.allSettled([f.correct(command,key),f.correct(command)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.pg.query('SELECT * FROM hamdee_private.financial_corrections')).rows.length,1);assert.equal(await f.balance(account.id),900);
});
