import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOwnerQaFixture} from './support/owner-crm-harness';

type Fixture=Awaited<ReturnType<typeof createOwnerQaFixture>>;
const base='/api/hamdee/v1';
async function setup(t:TestContext,cars=true){const f=await createOwnerQaFixture({migrationFiles:['006_local_operations_records.up.sql',...(cars?['007_local_car_rentals.up.sql']:[])]});t.after(()=>f.close());await f.login();return f;}
async function data(response:Response,status=200){const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body.data;}
async function rental(f:Fixture,action:string,fields:Record<string,unknown>){return data(await f.request('POST',base+'/rental',{action,...fields},{'Idempotency-Key':randomUUID()}));}
async function command(f:Fixture,module:string,body:unknown){return data(await f.request('POST',base+'/'+module+'/commands',body,{'Idempotency-Key':randomUUID()}));}
async function overview(f:Fixture,asOf='2026-11-30',month='2026-11'){return data(await f.request('GET',base+'/operations-dashboard?month='+month+'&asOf='+asOf));}
async function account(f:Fixture,scope='company',kind='cash',currency='QAR',openingAmount='0',openingDate='2026-10-01'){
 return command(f,scope==='company'?'company-finance':'personal-finance',{action:'create-account',name:'Synthetic dashboard '+scope+' '+kind,scope,kind,currency,openingAmount,openingDate,ownerConfirmedOpening:true});
}
async function terms(f:Fixture){
 const p=await data(await f.request('POST',base+'/properties',{name:'Synthetic dashboard villa'},{'Idempotency-Key':randomUUID()}),201);
 const room=await rental(f,'create-room',{propertyId:p.id,code:'SYN-OVERVIEW'}),tenant=await rental(f,'create-tenant',{name:'Synthetic dashboard tenant'});
 const agreement=await rental(f,'create-agreement',{roomId:room.id,tenantId:tenant.id,monthlyRent:'1000',currency:'QAR',depositRequired:'500',dueTerms:'Explicit fifth day',startDate:'2026-09-01',endDate:null});
 const due=await rental(f,'issue-due',{agreementId:agreement.id,period:'2026-11',dueDate:'2026-11-05',amount:'1000'});
 return {p,room,tenant,agreement,due};
}
async function cost(f:Fixture,propertyId:string,amount:string,expenseDate:string){return data(await f.request('POST',base+'/expenses',{action:'record-expense',propertyId,category:'maintenance',expenseDate,amount,currency:'QAR',vendorName:'Synthetic workshop',vendorContact:'',reference:'SYN-'+randomUUID(),notes:'Synthetic dashboard cost'},{'Idempotency-Key':randomUUID()}));}

test('Business overview empty and future-only setup do not invent currency, rent, account balances or chart history',async t=>{
 const f=await setup(t);let d=await overview(f);assert.equal(d.overviewVersion,1);assert.deepEqual(d.overview.currencies,[]);
 await account(f,'personal','cash','INR','500');d=await overview(f);assert.deepEqual(d.overview.currencies,[],'Personal-only currency is not a company dashboard choice');
 await account(f,'company','bank','USD','999','2026-12-01');d=await overview(f);assert.equal(d.overview.currencies.length,1);
 const usd=d.overview.currencies[0];assert.equal(usd.currency,'USD');
 for(const key of ['totalCollected','pendingCollection','companyCash','companyBank','monthlyExpenses'])assert.equal(usd[key],null,key);
 assert.deepEqual(usd.trend,[]);assert.equal(usd.trendReady,false);assert.equal(usd.operations.staffHeld,null);
});

test('November allocation KPI, receipt-date trend, deposits/advances and verified accounts retain different exact bases',async t=>{
 const f=await setup(t),a=await terms(f),cash=await account(f,'company','cash','QAR','1000'),bank=await account(f,'company','bank','QAR');
 const advance=await rental(f,'record-collection',{agreementId:a.agreement.id,kind:'advance',method:'cash',amount:'300',receivedDate:'2026-10-20'});
 const partial=await rental(f,'record-collection',{agreementId:a.agreement.id,kind:'rent',method:'bank',amount:'250',receivedDate:'2026-11-02',allocations:[{dueId:a.due.id,amount:'250'}]});
 await rental(f,'record-collection',{agreementId:a.agreement.id,kind:'deposit',method:'cash',amount:'500',receivedDate:'2026-11-01'});
 await rental(f,'record-collection',{agreementId:a.agreement.id,kind:'rent',method:'cheque',amount:'150',receivedDate:'2026-11-02'});
 await rental(f,'allocate-advance',{collectionId:advance.id,dueId:a.due.id,amount:'200',allocationDate:'2026-11-03'});
 for(const source of [advance,partial])await command(f,'company-finance',{action:'receive',accountId:cash.id,sourceKind:'property-rent',sourceId:source.id,ownerConfirmedDisposition:true});
 await command(f,'company-finance',{action:'transfer',fromAccountId:cash.id,toAccountId:bank.id,amount:'100',transferredOn:'2026-11-03',reference:'SYN-DASH-TRANSFER'});
 await command(f,'company-finance',{action:'expense',accountId:cash.id,expenseKey:randomUUID(),paidOn:'2026-11-03',amount:'30',reference:'SYN-STANDALONE-CASH-EXPENSE'});
 await cost(f,a.p.id,'100','2026-11-01');await cost(f,a.p.id,'10','2026-10-01');await cost(f,a.p.id,'12','2026-05-01');
 const vehicle=await command(f,'car-rentals',{action:'create-vehicle',registration:'SYN-DASH-CAR',make:'Synthetic make',model:'Synthetic car',status:'active'});
 const car=await command(f,'car-rentals',{action:'create-agreement',vehicleId:vehicle.id,agreementKey:randomUUID(),customerName:'Synthetic dashboard driver',startDate:'2026-11-01',endDate:'2026-11-30',agreedAmount:'1000',currency:'QAR',billingPeriod:'Explicit synthetic November total'});
 await command(f,'car-rentals',{action:'record-collection',agreementId:car.id,receiptKey:randomUUID(),receivedDate:'2026-11-03',amount:'100.125',currency:'QAR',method:'cash'});
 await command(f,'car-rentals',{action:'record-collection',agreementId:car.id,receiptKey:randomUUID(),receivedDate:'2026-11-03',amount:'75',currency:'QAR',method:'cheque'});
 await command(f,'car-rentals',{action:'record-maintenance',vehicleId:vehicle.id,expenseKey:randomUUID(),expenseDate:'2026-11-03',amount:'20.125',currency:'QAR',description:'Synthetic precise cost'});
 const before=(await f.pg!.query('SELECT id,delta::text FROM hamdee_private.ops_money ORDER BY id')).rows;
 const d=await overview(f,'2026-11-03'),q=d.overview.currencies[0];assert.equal(q.currency,'QAR');
 assert.equal(q.totalCollected,'450');assert.equal(q.pendingCollection,'550');assert.equal(q.companyCash,'1420');assert.equal(q.companyBank,'100');
 assert.equal(q.monthlyExpenses,'120.125','Recorded costs exclude standalone ledger movements with no shared source link');
 assert.equal(q.rent.expected,'1000');assert.equal(q.rent.unappliedAdvances,'100');assert.equal(q.rent.depositHeld,'500');
 assert.equal(q.operations.carCollected,'100.125');assert.equal(q.operations.pendingRentCheques,'150');assert.equal(q.operations.pendingCarCheques,'75');assert.equal(q.operations.pendingCheques,'225');
 assert.equal(q.operations.upcomingAmount,'550');assert.equal(q.operations.upcomingCount,1);assert.equal(q.operations.nextDueDate,'2026-11-05');
 assert.deepEqual(q.trend,[{month:'2026-10',collections:'0',expenses:'10'},{month:'2026-11',collections:'350.125',expenses:'120.125'}]);assert.equal(q.trendReady,true);
 assert.match(d.overview.basis.totalCollected,/issued rent dues/);assert.match(d.overview.basis.expenses,/Recorded property & vehicle costs/);
 assert.deepEqual((await f.pg!.query('SELECT id,delta::text FROM hamdee_private.ops_money ORDER BY id')).rows,before,'Dashboard only reads ledgers');
 const earlier=(await overview(f,'2026-11-01')).overview.currencies[0];assert.equal(earlier.totalCollected,'0');assert.equal(earlier.pendingCollection,'1000');assert.equal(earlier.rent.unappliedAdvances,'300');assert.equal(earlier.companyCash,'1300');assert.equal(earlier.monthlyExpenses,'100');assert.equal(earlier.operations.pendingCheques,'0');
});

test('Only actual activity months become trend rows and a single month never pretends to be history',async t=>{
 const f=await setup(t,false),a=await terms(f);await cost(f,a.p.id,'10','2026-11-05');
 const d=await overview(f),q=d.overview.currencies[0];assert.equal(q.totalCollected,'0');assert.equal(q.pendingCollection,'1000');
 assert.deepEqual(q.trend,[{month:'2026-11',collections:'0',expenses:'10'}]);assert.equal(q.trendReady,false);assert.equal(q.operations.carCollected,null);
 const emptyCosts=(await overview(f,'2026-11-01')).overview.currencies[0];assert.equal(emptyCosts.monthlyExpenses,null);assert.deepEqual(emptyCosts.trend,[]);
 const earlierMonth=(await overview(f,'2026-11-30','2026-10')).overview.currencies[0];assert.equal(earlierMonth.totalCollected,null);assert.equal(earlierMonth.pendingCollection,null);assert.equal(earlierMonth.monthlyExpenses,'0');assert.deepEqual(earlierMonth.trend,[]);
});
