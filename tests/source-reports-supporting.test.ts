import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {operationsFixture} from './support/operations-fixture';
import {ExpenseService} from '../src/expenses';
import {SourceReportService,scheduledPropertyResult} from '../src/source-reports';
import {SupportingRecordService} from '../src/supporting-records';
import {FinancialCorrectionService} from '../src/financial-corrections';
import {fixture,issuer} from './support/fixture';
type Row=Record<string,unknown>;
async function setup(t:test.TestContext){
 const f=await operationsFixture();t.after(()=>f.pg.close());for(const name of ['007_local_car_rentals.up.sql','013_local_customers_kyc_cheques.up.sql','014_local_connected_funding.up.sql','016_local_scoped_expenses.up.sql','017_local_corrections_and_source_compatibility.up.sql','019_local_principal_supporting_records.up.sql'])await f.pg.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const expenses=new ExpenseService(f.properties),reports=new SourceReportService(f.properties),support=new SupportingRecordService(f.properties);
 const expense=async(body:unknown)=>(await expenses.mutate(f.identity,body,randomUUID(),randomUUID()) as {data:Row}).data;
 const reference=async(body:unknown,key=randomUUID())=>support.mutate(f.identity,body,key,randomUUID());
 const rental=async(body:unknown)=>(await f.rental.mutate(f.identity,body,randomUUID(),randomUUID()) as {data:Row}).data;
 return {...f,expenses,reports,support,expense,reference,rental};
}
test('EX05 source calculation retains unconfirmed currency and does not become cash or a share distribution',()=>{
 const result=scheduledPropertyResult({scheduledRentMinor:'5350000',landlordMinor:'3400000',serviceChargeMinor:'50000',kahramaaMinor:'966400',detailedExpensesMinor:'318000',currency:null});
 assert.equal(result.scheduledResultMinor,'615600');assert.equal(result.currency,null);assert.equal(result.currencyConfirmed,false);
 // EX07 is raw source evidence; no rounding/remainder allocation is authorized.
 assert.equal(61560000n*3333n*3n,615538440000n);
});
test('source-matched property report separates scheduled53500/result6156 from cash1200 and paid200 with four utility accounts',async t=>{
 const f=await setup(t),p=await f.create(),room=await f.rental({action:'create-room',propertyId:p.id,code:'SYN-REPORT-01'}),tenant=await f.rental({action:'create-tenant',name:'Synthetic source report tenant'});
 const terms=await f.rental({action:'create-agreement',roomId:room.id,tenantId:tenant.id,startDate:'2026-10-01',monthlyRent:'53500',currency:'XTS',depositRequired:'0',dueTerms:'Confirmed source-derived synthetic schedule'}),due=await f.rental({action:'issue-due',agreementId:terms.id,period:'2026-10',dueDate:'2026-10-01',amount:'53500'}),a=await f.account({openingAmount:'1000'});
 await f.rental({action:'record-collection',agreementId:terms.id,kind:'rent',method:'cash',amount:'1200',receivedDate:'2026-10-03',allocations:[{dueId:due.id,amount:'1200'}],receivingAccountId:a.id,accountConfirmed:true});
 const bill=(category:string,amount:string,payment?:Row)=>f.expense({action:'record-expense',propertyId:p.id,category,expenseDate:'2026-10-03',amount,currency:'XTS',vendorName:'Synthetic report '+category,...(payment?{payment}:{})});
 await bill('landlord','34000',{method:'cash',amount:'200',paymentDate:'2026-10-03',fundingAccountId:a.id});await bill('service_charge','500');await bill('maintenance','3180');
 for(const [index,amount] of ['6994','1062','674','934'].entries()){
  const ref=(await f.reference({action:'create-reference',kind:'utility-account',label:'Synthetic account '+index,propertyId:p.id,details:{serviceReference:'SYN-UTILITY-'+index},sourceReference:'Synthetic source account '+index,reviewQuestions:['Q09'],status:'owner-confirmed'})).data;
  const expense=await bill('kahramaa',amount);await f.reference({action:'link-expense',recordId:ref.id,expenseId:expense.id,reason:'Synthetic explicit bill/account link'});
 }
 const before=(await f.pg.query('SELECT count(*)::int AS n FROM hamdee_private.ops_money')).rows[0],read=await f.reports.overview(f.identity,{month:'2026-10',asOf:'2026-10-31'}),report=read.propertyReports[0];
 assert.equal(report.scheduledRentMinor,'5350000');assert.equal(report.scheduledResultMinor,'615600');assert.equal(report.receivedRentMinor,'120000');assert.equal(report.actualPaidMinor,'20000');assert.equal(report.kahramaaMinor,'966400');assert.equal((report.utilityAccounts as Row[]).length,4);assert.equal((report.utilityBills as Row[]).length,4);assert.equal(report.ownerShareMinor,null);
 assert.equal(read.ownerSummary.propertyRows[0].ownerShareMinor,null);assert.equal(read.ownerSummary.propertyRows[0].extraMinor,null);assert.equal(read.ownerSummary.totalsByCurrency[0].propertyBalanceMinor,'615600');assert.deepEqual((await f.pg.query('SELECT count(*)::int AS n FROM hamdee_private.ops_money')).rows[0],before);
 assert.equal(Number((await f.finance.overview(f.identity,{month:'2026-10',asOf:'2026-10-31'})).totals[0].balance),2000);
});
test('supporting landlord/policy/investment/asset references preserve unknowns, locations and revisions without cash',async t=>{
 const f=await setup(t),p=await f.create(),other=await f.create('admin','Synthetic other supporting property'),key=randomUUID(),body={action:'create-reference',kind:'asset',label:'Synthetic equipment',propertyId:p.id,details:{location:'Synthetic villa / room',amount:'100.123456789123'},sourceReference:'Synthetic source cell',originalWording:'Synthetic raw unknown-currency wording',reviewQuestions:['Q13','Q14']};
 const r=await f.reference(body,key);assert.equal((await f.reference(body,key)).replay,true);await f.reference({action:'revise-reference',recordId:r.data.id,expectedVersion:1,details:{location:'Synthetic reviewed store',amount:'100.123456789123'},reason:'Synthetic location correction'});
 await assert.rejects(f.reference({action:'revise-reference',recordId:r.data.id,expectedVersion:1,label:'Stale update',reason:'Synthetic stale update'}));
 for(const kind of ['landlord-terms','utility-schedule','policy','investment'])await f.reference({action:'create-reference',kind,label:'Synthetic '+kind,propertyId:p.id,details:{frequency:'Owner-entered frequency',dueDayReference:'Original range preserved',sourceDateReference:'Original unknown date',premium:'10',paidAmount:'5',valuationReference:'Unconfirmed source reference'},reviewQuestions:['Q06','Q13','Q14']});
 const records=await f.support.overview(f.identity,{propertyId:String(p.id)});assert.equal(records.records.length,5);assert.equal(records.revisions.length,6);assert.equal((records.records.find(row=>row.id===r.data.id)?.details as Row).currency,undefined);assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_money')).rows.length,0);
 const expense=await f.expense({action:'record-expense',propertyId:other.id,category:'maintenance',expenseDate:'2026-11-01',amount:'10',currency:'XTS',vendorName:'Synthetic unrelated vendor'});
 await assert.rejects(f.reference({action:'link-expense',recordId:r.data.id,expenseId:expense.id,reason:'Synthetic wrong property link'}));
 await assert.rejects(f.support.overview({issuer:f.identity.issuer,subject:f.users.reader.subject}));
});
test('partial-month tenant changes require explicit amounts instead of invented proration or verified zero',async t=>{
 const f=await setup(t),p=await f.create(),room=await f.rental({action:'create-room',propertyId:p.id,code:'SYN-PARTIAL'}),tenant=await f.rental({action:'create-tenant',name:'Synthetic partial tenant'});
 await f.rental({action:'create-agreement',roomId:room.id,tenantId:tenant.id,startDate:'2026-11-15',monthlyRent:'2000',currency:'XTS',depositRequired:'0',dueTerms:'Explicit partial period not yet confirmed'});
 const report=(await f.reports.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).propertyReports[0];assert.equal(report.scheduledRentMinor,null);assert.equal(report.scheduledResultMinor,null);assert.match((report.rentSchedule as Row[])[0].scheduleBasis as string,/explicit period amount/);
});
test('source reports follow dated funded bill compensation without changing cost or previous-period paid history',async t=>{
 const f=await setup(t),p=await f.create(),a=await f.account({openingAmount:'1000'});
 const bill=await f.expense({action:'record-expense',propertyId:p.id,category:'landlord',expenseDate:'2026-10-01',amount:'600',currency:'XTS',vendorName:'Synthetic correction report vendor',payment:{method:'cash',amount:'200',paymentDate:'2026-10-02',fundingAccountId:a.id}});
 const payment=(await f.pg.query<Row>('SELECT id FROM hamdee_private.expense_payments WHERE expense_id=$1',[bill.id])).rows[0];
 await new FinancialCorrectionService(f.properties).mutate(f.identity,{action:'correct-expense-payment',paymentId:payment.id,correctedOn:'2026-11-01',reason:'Synthetic corrected paid amount',replacement:{method:'cash',amount:'150',fundingAccountId:a.id}},randomUUID(),randomUUID());
 const october=(await f.reports.overview(f.identity,{month:'2026-10',asOf:'2026-11-30'})).propertyReports[0];assert.equal(october.landlordMinor,'60000');assert.equal(october.actualPaidMinor,'20000');
 const november=(await f.reports.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).propertyReports[0];assert.equal(november.landlordMinor,'0');assert.equal(november.actualPaidMinor,'-5000');
 assert.equal(Number((await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).totals[0].balance),850);
});
test('room source order is explicit metadata with private provenance, never guessed from code or duplicated across rooms',async t=>{
 const f=await setup(t),p=await f.create(),first=await f.rental({action:'create-room',propertyId:p.id,code:'SYN-Z'}),second=await f.rental({action:'create-room',propertyId:p.id,code:'SYN-A'});
 const order=(roomId:unknown,sourceOrder:string)=>({action:'create-reference',kind:'other-reference',label:'Synthetic room source order',propertyId:p.id,roomId,details:{sourceOrder},sourceReference:'Synthetic sheet/cell',status:'owner-confirmed'});
 await f.reference(order(first.id,'3'));await f.reference(order(second.id,'1'));
 const refs=await f.support.overview(f.identity,{propertyId:String(p.id),kind:'other-reference'});assert.deepEqual(refs.records.map(r=>(r.details as Row).sourceOrder).sort(),['1','3']);
 await assert.rejects(f.reference(order(second.id,'2')));await assert.rejects(f.reference(order(first.id,'1')));await assert.rejects(f.reference(order(first.id,'0')));
 assert.equal((await f.pg.query('SELECT * FROM hamdee_private.rent_dues')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_money')).rows.length,0);
});
test('Sheet15 owner movement history retains original transfer and dated compensation without creating owner income',async t=>{
 const f=await setup(t),company=await f.account({openingAmount:'1000'}),personal=await f.account({scope:'personal',name:'Synthetic personal owner account',openingAmount:'0'});
 const transfer=await f.writeFinance({action:'transfer',fromAccountId:company.id,toAccountId:personal.id,transferredOn:'2026-10-03',amount:'100',reference:'SYN-OWNER-TRANSFER'});
 const original=(await f.finance.overview(f.identity,{month:'2026-10',asOf:'2026-10-03'})).entries.find(e=>e.transferId===transfer.id)!;
 await f.writeFinance({action:'reverse',entryId:original.id,reversedOn:'2026-11-01',reason:'Synthetic retained owner-transfer correction'});
 const october=await f.reports.overview(f.identity,{month:'2026-10',asOf:'2026-11-30'}),november=await f.reports.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'});
 assert.equal(Number(october.ownerSummary.ownerMovements[0].amount),100);assert.equal(Number(november.ownerSummary.ownerMovements[0].amount),-100);assert.equal(november.ownerSummary.ownerMovements[0].reversedTransferId,transfer.id);
 const finance=await f.finance.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'});assert.ok(finance.totals.every(row=>Number(row.receipts)===0));
});
test('source reports preserve old property-only availability without optional finance/support migrations or invented currencies',async t=>{
 const f=await fixture();t.after(()=>f.pg.close());await f.create();
 const report=await new SourceReportService(f.service).overview({issuer,subject:f.users.admin.subject},{month:'2026-11',asOf:'2026-11-30'});
 assert.deepEqual(report.propertyReports,[]);assert.deepEqual(report.ownerSummary.ownerMovements,[]);assert.deepEqual(report.ownerSummary.totalsByCurrency,[]);
});
test('source schedule order uses immutable imported provenance after contact-note edits instead of alphabetic code guesses',async t=>{
 const f=await setup(t),p=await f.create('admin','Synthetic source order villa');const tenants:Row[]=[];
 for(const [code,order] of [['SYN-Z','1'],['SYN-A','2']]){
  const room=await f.rental({action:'create-room',propertyId:p.id,code}),tenant=await f.rental({action:'create-tenant',name:'Synthetic source order '+order,notes:`October2026 source snapshot only. Occupancy and agreement terms unverified. Synthetic source order villa / ${code} (SL ${order}, PDF p1; AMOUNT=1000; R DATE=5)`});tenants.push(tenant);
  await f.rental({action:'create-agreement',roomId:room.id,tenantId:tenant.id,startDate:'2026-11-01',monthlyRent:'1000',currency:'XTS',depositRequired:'0',dueTerms:'Synthetic confirmed term'});
 }
 const before=(await f.reports.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).propertyReports[0];assert.deepEqual((before.rentSchedule as Row[]).map(row=>row.roomCode),['SYN-Z','SYN-A']);
 await f.rental({action:'update-tenant',tenantId:tenants[0].id,expectedVersion:1,name:tenants[0].name,phone:'',email:'',notes:'Synthetic routine contact-note edit'});
 const after=(await f.reports.overview(f.identity,{month:'2026-11',asOf:'2026-11-30'})).propertyReports[0];assert.deepEqual((after.rentSchedule as Row[]).map(row=>row.roomCode),['SYN-Z','SYN-A']);
});
test('supporting policy and asset profile filters use canonical customer IDs rather than duplicate names',async t=>{
 const f=await setup(t),first=await f.rental({action:'create-tenant',name:'Synthetic same-name reference contact'}),second=await f.rental({action:'create-tenant',name:'Synthetic same-name reference contact'});
 await f.reference({action:'create-reference',kind:'policy',label:'Synthetic linked policy',customerId:first.id,details:{premium:'10',frequency:'Explicit frequency reference'},reviewQuestions:['Q13']});
 await f.reference({action:'create-reference',kind:'asset',label:'Synthetic linked asset',customerId:second.id,details:{location:'Synthetic stored location'},reviewQuestions:['Q13']});
 const firstProfile=await f.support.overview(f.identity,{customerId:String(first.id)}),secondProfile=await f.support.overview(f.identity,{customerId:String(second.id)});
 assert.equal(firstProfile.records.length,1);assert.equal(firstProfile.records[0].kind,'policy');assert.equal(firstProfile.records[0].customerId,first.id);assert.equal(secondProfile.records.length,1);assert.equal(secondProfile.records[0].kind,'asset');assert.equal((await f.pg.query('SELECT * FROM hamdee_private.ops_money')).rows.length,0);
});
