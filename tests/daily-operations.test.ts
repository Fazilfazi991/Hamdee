import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOwnerQaFixture} from './support/owner-crm-harness';
import {fixture as legacyFixture} from './support/fixture';

type Fixture=Awaited<ReturnType<typeof createOwnerQaFixture>>;
const base='/api/hamdee/v1',migrations=['006_local_operations_records.up.sql','007_local_car_rentals.up.sql'];
async function setup(t:TestContext){const f=await createOwnerQaFixture({migrationFiles:migrations});t.after(()=>f.close());await f.login();return f;}
async function value(response:Response,status=200){const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body.data;}
async function command(f:Fixture,module:string,body:unknown){return {data:await value(await f.request('POST',base+'/'+module+'/commands',body,{'Idempotency-Key':randomUUID()}))};}
async function rental(f:Fixture,action:string,fields:Record<string,unknown>){return {data:await value(await f.request('POST',base+'/rental',{action,...fields},{'Idempotency-Key':randomUUID()}))};}
async function dashboard(f:Fixture,asOf='2026-11-03'){return value(await f.request('GET',base+'/operations-dashboard?month=2026-11&asOf='+asOf));}
async function account(f:Fixture,scope='company',kind='cash',currency='QAR',openingAmount='0',openingDate='2026-10-01'){
  return (await command(f,scope==='company'?'company-finance':'personal-finance',{action:'create-account',name:'Synthetic '+scope+' '+kind,scope,kind,currency,openingAmount,openingDate,ownerConfirmedOpening:true})).data;
}
async function arrangement(f:Fixture,suffix='1'){
  const p=await value(await f.request('POST',base+'/properties',{name:'Synthetic daily villa '+suffix},{'Idempotency-Key':randomUUID()}),201);
  const room=(await rental(f,'create-room',{propertyId:p.id,code:'SYN-'+suffix,label:'Synthetic daily room'})).data;
  const tenant=(await rental(f,'create-tenant',{name:'Synthetic daily tenant '+suffix})).data;
  const agreement=(await rental(f,'create-agreement',{roomId:room.id,tenantId:tenant.id,monthlyRent:'1000',currency:'QAR',depositRequired:'500',dueTerms:'Explicit monthly fifth day',startDate:'2026-10-01',endDate:null})).data;
  const due=(await rental(f,'issue-due',{agreementId:agreement.id,period:'2026-11',dueDate:'2026-11-05',amount:'1000'})).data;
  return {p,room,tenant,agreement,due};
}
test('Daily dashboard empty setup never invents accounts, balances or rent values and stays read-only',async t=>{
  const f=await setup(t),before=(await f.pg!.query('SELECT count(*)::int AS n FROM hamdee_private.ops_events')).rows;
  const d=await dashboard(f);assert.equal(d.month,'2026-11');assert.equal(d.moneyUnit,'decimal-major-unit-strings');
  assert.deepEqual(d.accounts,{companySetupRequired:true,personalSetupRequired:true,company:[],personal:[]});
  for(const key of ['balances','personalBalances','rent','expenses','staff','recentCollections','upcomingDues'])assert.deepEqual(d[key],[]);
  assert.deepEqual((await f.pg!.query('SELECT count(*)::int AS n FROM hamdee_private.ops_events')).rows,before);
});
test('October advance allocates November dues without duplicate cash, income or deposit reclassification; as-of cutoffs match existing services',async t=>{
  const f=await setup(t),a=await arrangement(f),cash=await account(f);
  const advance=(await rental(f,'record-collection',{agreementId:a.agreement.id,kind:'advance',method:'cash',amount:'300',receivedDate:'2026-10-20'})).data;
  const deposit=(await rental(f,'record-collection',{agreementId:a.agreement.id,kind:'deposit',method:'cash',amount:'500',receivedDate:'2026-10-21'})).data;
  await command(f,'company-finance',{action:'receive',accountId:cash.id,sourceKind:'property-rent',sourceId:advance.id,ownerConfirmedDisposition:true});
  const partial=(await rental(f,'record-collection',{agreementId:a.agreement.id,kind:'rent',method:'cash',amount:'250',receivedDate:'2026-11-02',allocations:[{dueId:a.due.id,amount:'250'}]})).data;
  await command(f,'company-finance',{action:'receive',accountId:cash.id,sourceKind:'property-rent',sourceId:partial.id,ownerConfirmedDisposition:true});
  const before=await dashboard(f,'2026-11-02');assert.equal(before.rent[0].allocated,'250');assert.equal(before.rent[0].unappliedAdvances,'300');
  const moneyBefore=(await f.pg!.query('SELECT id,delta::text FROM hamdee_private.ops_money ORDER BY id')).rows;
  await rental(f,'allocate-advance',{collectionId:advance.id,dueId:a.due.id,amount:'200',allocationDate:'2026-11-03'});
  const d=await dashboard(f);assert.deepEqual(d.rent,[{currency:'QAR',expected:'1000',allocated:'450',outstanding:'550',unappliedAdvances:'100',depositHeld:'500',pendingCheques:'0'}]);
  assert.equal(d.balances[0].companyCash,'550');assert.equal(d.balances[0].companyBank,null);assert.equal(d.accounts.personalSetupRequired,true);
  assert.equal(d.recentCollections.length,3);assert.equal(d.recentCollections[0].id,partial.id);assert.ok(d.recentCollections.some((row:{id:string;date:string})=>row.id===advance.id&&row.date==='2026-10-20'));assert.equal(d.upcomingDues[0].outstanding,'550');
  assert.deepEqual((await f.pg!.query('SELECT id,delta::text FROM hamdee_private.ops_money ORDER BY id')).rows,moneyBefore);
  const old=await dashboard(f,'2026-11-01');assert.equal(old.rent[0].allocated,'0');assert.equal(old.rent[0].unappliedAdvances,'300');assert.equal(old.balances[0].companyCash,'300');assert.equal(old.recentCollections.length,2);assert.ok(old.recentCollections.every((row:{id:string})=>row.id!==partial.id));
  const rentals=await value(await f.request('GET',base+'/rental?month=2026-11&asOf=2026-11-03'));
  assert.equal(rentals.collections.find((row:{id:string})=>row.id===advance.id).availableAdvanceMinor,'10000');
  assert.equal(Object.hasOwn(rentals.collections.find((row:{id:string})=>row.id===deposit.id),'availableAdvanceMinor'),false);
  assert.equal(rentals.summary.currencies[0].advanceMinor,'10000');assert.equal(rentals.collections.length,3);
  const finance=await value(await f.request('GET',base+'/company-finance?month=2026-11&asOf=2026-11-03'));assert.equal(d.accounts.company[0].balance,finance.totals[0].balance);
  assert.equal(finance.monthEntries.filter((row:{entryKind:string})=>row.entryKind==='receipt').length,1);
  await rental(f,'allocate-advance',{collectionId:advance.id,dueId:a.due.id,amount:'50',allocationDate:'2026-11-10'});
  assert.equal((await dashboard(f)).rent[0].unappliedAdvances,'100');assert.equal((await dashboard(f,'2026-11-10')).rent[0].unappliedAdvances,'50');
  const future=(await rental(f,'record-collection',{agreementId:a.agreement.id,kind:'advance',method:'cash',amount:'20',receivedDate:'2026-11-20'})).data;
  const current=await value(await f.request('GET',base+'/rental?month=2026-11&asOf=2026-11-03'));assert.equal(Object.hasOwn(current.collections.find((row:{id:string})=>row.id===future.id),'availableAdvanceMinor'),false);
});
test('Daily recorded account/staff balances equal authoritative ledgers, retain reversals and separate company, personal and currencies',async t=>{
  const f=await setup(t),cash=await account(f,'company','cash','QAR','100'),bank=await account(f,'company','bank','QAR','20');
  const personal=await account(f,'personal','cash','INR','50.125');await account(f,'company','bank','QAR','999','2026-12-01');
  const collector=(await command(f,'staff-collections',{action:'create-collector',name:'Synthetic daily collector'})).data;
  const receipt=(await command(f,'company-finance',{action:'create-classified-receipt',receiptKey:randomUUID(),classification:'Synthetic classified receipt',receivedOn:'2026-11-01',amount:'60',currency:'QAR',method:'cash'})).data;
  await command(f,'staff-collections',{action:'record-collection',collectorId:collector.id,sourceKind:'classified-receipt',sourceId:receipt.id,disposition:'collector-held',ownerConfirmedDisposition:true});
  const handover=(await command(f,'staff-collections',{action:'handover',collectorId:collector.id,accountId:cash.id,amount:'20',currency:'QAR',handedOn:'2026-11-02',reference:'SYN-HANDOVER'})).data;
  await command(f,'company-finance',{action:'transfer',fromAccountId:cash.id,toAccountId:bank.id,amount:'10',transferredOn:'2026-11-03',reference:'SYN-TRANSFER'});
  const d=await dashboard(f);assert.deepEqual(d.balances,[{currency:'QAR',companyCash:'110',companyBank:'30',staffHeld:'40'}]);
  assert.deepEqual(d.personalBalances,[{currency:'INR',cash:'50.125',bank:null}]);assert.equal(d.accounts.personal[0].id,personal.id);
  assert.equal(d.accounts.company.find((row:{openingDate:string})=>row.openingDate==='2026-12-01').balance,null);
  const company=await value(await f.request('GET',base+'/company-finance?month=2026-11&asOf=2026-11-03'));
  for(const row of d.accounts.company.filter((row:{balance:string|null})=>row.balance!==null))assert.equal(row.balance,company.totals.find((entry:{accountId:string})=>entry.accountId===row.id).balance);
  assert.ok(company.totals.every((row:{receipts:string})=>row.receipts==='0'));
  const staff=await value(await f.request('GET',base+'/staff-collections?month=2026-11&asOf=2026-11-03'));assert.equal(d.staff[0].balance,staff.totals[0].balance);
  await command(f,'staff-collections',{action:'reverse-handover',handoverId:handover.id,reversedOn:'2026-11-05',reason:'Synthetic retained correction'});
  assert.equal((await dashboard(f)).balances[0].staffHeld,'40');const later=await dashboard(f,'2026-11-05');assert.equal(later.balances[0].staffHeld,'60');assert.equal(later.balances[0].companyCash,'90');
});
test('Daily expenses retain cost/payment/cheque date bases without subtracting unlinked costs from cash',async t=>{
  const f=await setup(t),a=await arrangement(f);await account(f,'company','cash','QAR','100');
  const response=await f.request('POST',base+'/expenses',{action:'record-expense',propertyId:a.p.id,category:'landlord',expenseDate:'2026-11-01',amount:'100',currency:'QAR',vendorName:'Synthetic landlord',vendorContact:'',reference:'SYN-EXPENSE',notes:'Synthetic explicit expense',payment:{method:'cash',amount:'25',paymentDate:'2026-11-02',reference:'SYN-PAID'}},{'Idempotency-Key':randomUUID()});
  const expense=await value(response);
  await value(await f.request('POST',base+'/expenses',{action:'record-payment',expenseId:expense.id,method:'cheque',amount:'15',paymentDate:'2026-11-04',reference:'SYN-PENDING'},{'Idempotency-Key':randomUUID()}));
  const d=await dashboard(f,'2026-11-04');assert.deepEqual(d.expenses,[{currency:'QAR',recorded:'100',paid:'25',pendingCheques:'15'}]);assert.equal(d.balances[0].companyCash,'100');
  const old=await dashboard(f,'2026-11-01');assert.equal(old.expenses[0].paid,'0');assert.equal(old.expenses[0].pendingCheques,'0');
  const existing=await value(await f.request('GET',base+'/expenses?month=2026-11&asOf=2026-11-04'));assert.equal(existing.summary.currencies[0].paidExpenseMinor,'2500');
});
test('Daily dashboard rejects anonymous/nonowner/write/invalid-query access and absent operation schema stays fail closed',async t=>{
  const f=await setup(t);
  for(const suffix of ['','?month=2026-11&asOf=2026-02-30','?month=2026-11&month=2026-10&asOf=2026-11-03','?month=2026-11&asOf=2026-11-03&scope=all'])assert.equal((await f.request('GET',base+'/operations-dashboard'+suffix)).status,400);
  assert.equal((await f.request('POST',base+'/operations-dashboard?month=2026-11&asOf=2026-11-03',{})).status,405);
  const old=f.jar.fork();await f.auth('POST','logout',{});assert.equal((await f.request('GET',base+'/operations-dashboard?month=2026-11&asOf=2026-11-03',undefined,{},old)).status,401);
  const legacy=await legacyFixture();t.after(()=>legacy.pg.close());
  for(const user of ['finance','reader','ops','scopedAdmin'])assert.equal((await legacy.request(user,'GET','/operations-dashboard?month=2026-11&asOf=2026-11-03')).status,403);
  const missing=await createOwnerQaFixture();t.after(()=>missing.close());await missing.login();const response=await missing.request('GET',base+'/operations-dashboard?month=2026-11&asOf=2026-11-03');assert.equal(response.status,503);assert.equal((await response.json()).error.code,'OPERATIONS_UNAVAILABLE');
});
