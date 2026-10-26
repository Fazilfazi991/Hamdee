import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {createOwnerQaFixture} from './support/owner-crm-harness';
import {PropertyService} from '../src/service';
import {DailyDashboardService} from '../src/daily-dashboard';
import type {Database} from '../src/database';

// Independent operational checks. Only disposable local synthetic fixtures are
// used; original source receipts and posted account movements remain distinct.
type Fixture=Awaited<ReturnType<typeof createOwnerQaFixture>>;
type Saved={id:string;[key:string]:unknown};
type Money=string|null;
interface OverviewCurrency {
 currency:string;totalCollected:Money;pendingCollection:Money;companyCash:Money;companyBank:Money;monthlyExpenses:Money;
 rent:{expected:Money;allocated:Money;outstanding:Money;unappliedAdvances:Money;depositHeld:Money;pendingCheques:Money};
 operations:{carCollected:Money;staffHeld:Money;pendingCheques:Money;pendingRentCheques:Money;pendingCarCheques:Money;upcomingAmount:Money;upcomingCount:number;nextDueDate:string|null};
 trend:{month:string;collections:Money;expenses:Money}[];trendReady:boolean;
}
interface Overview {
 overviewVersion:number;overview:{currencies:OverviewCurrency[];basis:Record<string,string>};
 upcomingDues:unknown[];
}
const base='/api/hamdee/v1',migrations=['006_local_operations_records.up.sql','007_local_car_rentals.up.sql'];
async function fixture(t:TestContext,files=migrations){const f=await createOwnerQaFixture({migrationFiles:files});t.after(()=>f.close());await f.login();return f;}
async function body<T>(response:Response):Promise<T>{const b=await response.json();assert.ok(response.ok,JSON.stringify(b));return b.data as T;}
async function post(f:Fixture,module:string,input:Record<string,unknown>){return body<Saved>(await f.request('POST',base+'/'+module,input,{'Idempotency-Key':randomUUID()}));}
const rental=(f:Fixture,action:string,fields:Record<string,unknown>)=>post(f,'rental',{action,...fields});
const command=(f:Fixture,module:string,fields:Record<string,unknown>)=>post(f,module+'/commands',fields);
async function dashboard(f:Fixture,month='2026-11',asOf='2026-11-03'){return body<Overview>(await f.request('GET',base+'/operations-dashboard?month='+month+'&asOf='+asOf));}
function currency(d:Overview,name:string){assert.equal(d.overviewVersion,1);const row=d.overview.currencies.find(c=>c.currency===name);assert.ok(row,'Expected business currency '+name);return row;}
async function account(f:Fixture,scope:string,kind:string,currencyCode:string,amount:string,date='2026-10-01'){
 return command(f,scope==='personal'?'personal-finance':'company-finance',{action:'create-account',name:'SYNTHETIC '+scope+' '+kind+' '+currencyCode,scope,kind,currency:currencyCode,openingDate:date,openingAmount:amount,ownerConfirmedOpening:true});
}
async function terms(f:Fixture,propertyId:string,code:string,currencyCode='QAR'){
 const room=await rental(f,'create-room',{propertyId,code}),tenant=await rental(f,'create-tenant',{name:'SYNTHETIC '+code});
 return rental(f,'create-agreement',{roomId:room.id,tenantId:tenant.id,monthlyRent:'1000',currency:currencyCode,depositRequired:'500',dueTerms:'Explicit synthetic monthly due, no automatic proration',startDate:'2026-10-01',endDate:null});
}
async function receipt(f:Fixture,agreementId:string,kind:string,method:string,amount:string,receivedDate:string,extra:Record<string,unknown>={}){
 return rental(f,'record-collection',{agreementId,kind,method,amount,receivedDate,reference:'SYNTHETIC-'+randomUUID(),...extra});
}
async function immutableSnapshot(f:Fixture){
 const tableNames=['rent_collections','rent_allocations','rent_dues','car_receipts','car_expenses','property_expenses','ops_money','ops_transfers','ops_collections','ops_commands'];
 const values=[];
 for(const name of tableNames)values.push((await f.pg!.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM hamdee_private.${name} t`)).rows);
 return values;
}

test('Independent overview: missing verified history never manufactures a currency or account balance; optional car schema remains optional',async t=>{
 const f=await fixture(t,['006_local_operations_records.up.sql']);
 let d=await dashboard(f);assert.equal(d.overviewVersion,1);assert.deepEqual(d.overview.currencies,[]);
 await account(f,'personal','cash','USD','9876.54321');
 d=await dashboard(f);assert.deepEqual(d.overview.currencies,[],'Personal-only currency must not create business totals');
 await account(f,'company','bank','INR','999','2026-12-01');
 d=await dashboard(f);const c=currency(d,'INR');assert.equal(c.companyCash,null);assert.equal(c.companyBank,null);
 assert.equal(c.totalCollected,null);assert.equal(c.pendingCollection,null);assert.equal(c.monthlyExpenses,null);assert.equal(c.trendReady,false);assert.deepEqual(c.trend,[]);
});

test('Independent overview: allocation KPIs, original cash receipt trend, custody and recorded costs reconcile without double counting',async t=>{
 const f=await fixture(t),p=await post(f,'properties',{name:'SYNTHETIC dashboard QA villa'}),a=await terms(f,p.id,'QA-A');
 const due=await rental(f,'issue-due',{agreementId:a.id,period:'2026-11',dueDate:'2026-11-05',amount:'1000'});
 const cash=await account(f,'company','cash','QAR','1000'),bank=await account(f,'company','bank','QAR','200');
 await account(f,'personal','cash','USD','999999.99');
 const advance=await receipt(f,a.id,'advance','cash','300','2026-10-26');
 await receipt(f,a.id,'deposit','cash','500','2026-10-26');
 const october=await receipt(f,a.id,'rent','cash','250','2026-10-26',{allocations:[{dueId:due.id,amount:'250'}]});
 const november=await receipt(f,a.id,'rent','cash','50','2026-11-02',{allocations:[{dueId:due.id,amount:'50'}]});
 await rental(f,'allocate-advance',{collectionId:advance.id,dueId:due.id,amount:'200',allocationDate:'2026-10-26'});
 await receipt(f,a.id,'rent','cheque','60','2026-10-27');
 await receipt(f,a.id,'rent','cash','10','2026-11-20',{allocations:[{dueId:due.id,amount:'10'}]});
 const vehicle=await command(f,'car-rentals',{action:'create-vehicle',registration:'SYNTHETIC-QA-'+randomUUID().slice(0,8),make:'Synthetic',model:'Dashboard QA',status:'active'});
 const car=await command(f,'car-rentals',{action:'create-agreement',vehicleId:vehicle.id,agreementKey:randomUUID(),customerName:'Synthetic driver',startDate:'2026-10-01',endDate:'2026-11-30',agreedAmount:'1000',currency:'QAR',billingPeriod:'Explicit synthetic total'});
 const carReceipt=async(amount:string,date:string,method:string)=>command(f,'car-rentals',{action:'record-collection',agreementId:car.id,receiptKey:randomUUID(),amount,currency:'QAR',receivedDate:date,method});
 const carOct=await carReceipt('100','2026-10-28','cash'),carNov=await carReceipt('50','2026-11-03','bank');await carReceipt('70','2026-10-28','cheque');
 await post(f,'expenses',{action:'record-expense',propertyId:p.id,category:'landlord',expenseDate:'2026-10-28',amount:'40',currency:'QAR',vendorName:'Synthetic landlord',reference:'SYNTHETIC-OCT-COST'});
 await post(f,'expenses',{action:'record-expense',propertyId:p.id,category:'maintenance',expenseDate:'2026-11-20',amount:'30',currency:'QAR',vendorName:'Synthetic maintenance vendor',reference:'SYNTHETIC-FUTURE-COST'});
 await command(f,'car-rentals',{action:'record-maintenance',vehicleId:vehicle.id,expenseKey:randomUUID(),expenseDate:'2026-11-01',amount:'20',currency:'QAR',description:'Synthetic actual cost once'});
 for(const source of [{id:advance.id,kind:'property-rent'},{id:october.id,kind:'property-rent'},{id:carOct.id,kind:'car-rental'}])await command(f,'company-finance',{action:'receive',accountId:cash.id,sourceKind:source.kind,sourceId:source.id,ownerConfirmedDisposition:true});
 await command(f,'company-finance',{action:'receive',accountId:bank.id,sourceKind:'car-rental',sourceId:carNov.id,ownerConfirmedDisposition:true});
 const collector=await command(f,'staff-collections',{action:'create-collector',name:'SYNTHETIC QA collector'});
 await command(f,'staff-collections',{action:'record-collection',collectorId:collector.id,sourceKind:'property-rent',sourceId:november.id,disposition:'collector-held',ownerConfirmedDisposition:true});
 await command(f,'staff-collections',{action:'handover',collectorId:collector.id,accountId:cash.id,amount:'20',currency:'QAR',handedOn:'2026-11-03',reference:'SYNTHETIC-QA-HANDOVER'});
 await command(f,'company-finance',{action:'expense',accountId:cash.id,expenseKey:randomUUID(),paidOn:'2026-11-02',amount:'10',reference:'SYNTHETIC-STANDALONE-COST'});
 await command(f,'company-finance',{action:'transfer',fromAccountId:cash.id,toAccountId:bank.id,amount:'40',transferredOn:'2026-11-03',reference:'SYNTHETIC-QA-TRANSFER'});
 const before=await immutableSnapshot(f),d=await dashboard(f),c=currency(d,'QAR');
 assert.deepEqual([c.totalCollected,c.pendingCollection,c.rent.expected],['500','500','1000']);
 assert.deepEqual([c.rent.unappliedAdvances,c.rent.depositHeld],['100','500']);
 assert.deepEqual([c.companyCash,c.companyBank,c.operations.staffHeld],['1620','290','30']);
 assert.equal(c.monthlyExpenses,'20','Single recorded vehicle maintenance cost; standalone company cash debit excluded from this labelled basis');
 assert.equal(c.operations.carCollected,'50');assert.equal(c.operations.pendingRentCheques,'60');assert.equal(c.operations.pendingCarCheques,'70');assert.equal(c.operations.pendingCheques,'130');
 assert.equal(c.operations.upcomingCount,1);assert.equal(c.operations.upcomingAmount,'500');assert.equal(c.operations.nextDueDate,'2026-11-05');
 assert.deepEqual(c.trend,[{month:'2026-10',collections:'350',expenses:'40'},{month:'2026-11',collections:'100',expenses:'20'}]);
 assert.equal(c.trendReady,true);assert.equal(d.overview.currencies.some(row=>row.currency==='USD'),false);
 assert.match(d.overview.basis.totalCollected,/allocat/i);assert.match(d.overview.basis.expenses,/property.*vehicle/i);
 // Benchmark the old and new service on exactly the same disposable fixture.
 // The original service is loaded read-only from Git, never restored into src.
 const selectStatements:string[]=[];
 const measured:Database={transaction:work=>f.database.transaction(sql=>work({query(statement,parameters){if(/^\s*(SELECT|WITH)\b/i.test(statement))selectStatements.push(statement);return sql.query(statement,parameters);}}))};
 const service=new PropertyService(measured,f.options.policy.owner),query={month:'2026-11',asOf:'2026-11-03'};
 const newService=new DailyDashboardService(service);
 async function measure(read:()=>Promise<unknown>){const samples:number[]=[];await read();for(let n=0;n<5;n++){const start=performance.now();await read();samples.push(performance.now()-start);}return samples.sort((a,b)=>a-b)[2];}
 let oldSource:string|null=null,oldMedian:number|null=null;
 try{oldSource=execFileSync('git',['show','0e65c56c1309c7cceaf5f67eef04aeb8e881023f:src/daily-dashboard.ts'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}
 catch{t.diagnostic('Prior Git object unavailable in this checkout; before/after timing comparison not executed. Current aggregate/read-only assertions still run.');}
 if(oldSource!==null){
  const relocated=oldSource.replace(/from '\.\/([a-z-]+)'/g,(_whole,name:string)=>`from '${new URL('../src/'+name+'.ts',import.meta.url).href}'`);
  const compiled=ts.transpileModule(relocated,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const previous=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64')) as {DailyDashboardService:typeof DailyDashboardService};
  const oldService=new previous.DailyDashboardService(service);oldMedian=await measure(()=>oldService.overview(f.options.policy.owner,query));
 }
 selectStatements.length=0;const newMedian=await measure(()=>newService.overview(f.options.policy.owner,query));
 const dataStatements=selectStatements.filter(statement=>/AS data\b/i.test(statement));
 assert.equal(dataStatements.length,6,'One bounded aggregate data statement per warm-up/overview read');
 assert.ok(c.trend.length<=6);assert.ok(d.upcomingDues.length<=10);
 assert.ok(newMedian<5000,'Local aggregate query must stay bounded; not a hosted performance certification');
 t.diagnostic(JSON.stringify({scope:'local disposable same-fixture read-only service; five warm samples',beforeMedianMs:oldMedian===null?null:Number(oldMedian.toFixed(3)),afterMedianMs:Number(newMedian.toFixed(3)),aggregateStatementsPerOverview:1,trendMonths:c.trend.length}));
 await dashboard(f);assert.deepEqual(await immutableSnapshot(f),before,'Dashboard is read-only for sources, allocations, accounts, commands and history');
});

test('Independent overview: complete upcoming count exceeds detail pagination and selected currency never absorbs another currency',async t=>{
 const f=await fixture(t),p=await post(f,'properties',{name:'SYNTHETIC dashboard due-count villa'});
 for(let n=0;n<12;n++){
  const a=await terms(f,p.id,'QA-'+n,n===11?'INR':'QAR');
  await rental(f,'issue-due',{agreementId:a.id,period:'2026-11',dueDate:'2026-11-05',amount:n===11?'9.99':'1.01'});
 }
 const d=await dashboard(f,'2026-11','2026-11-01'),qar=currency(d,'QAR'),inr=currency(d,'INR');
 assert.equal(d.upcomingDues.length,10,'Legacy details remain bounded');
 assert.equal(qar.operations.upcomingCount,11);assert.equal(qar.operations.upcomingAmount,'11.11');assert.equal(qar.rent.expected,'11.11');assert.equal(qar.totalCollected,'0');
 assert.equal(inr.operations.upcomingCount,1);assert.equal(inr.operations.upcomingAmount,'9.99');assert.equal(inr.rent.expected,'9.99');
 assert.equal(qar.companyCash,null);assert.equal(inr.companyCash,null);assert.equal(qar.trendReady,false);assert.equal(inr.trendReady,false);
});

test('Independent overview: direct reads require current owner and valid query; expired or logged-out copied cookies stay denied',async t=>{
 const f=await createOwnerQaFixture({migrationFiles:migrations});t.after(()=>f.close());
 const path=base+'/operations-dashboard?month=2026-11&asOf=2026-11-03';
 assert.equal((await f.request('GET',path)).status,401);await f.login();assert.equal((await f.request('GET',path)).status,200);
 assert.equal((await f.request('GET',path+'&month=2026-10')).status,400);
 assert.equal((await f.request('GET',base+'/operations-dashboard?month=2026-11&asOf=2026-02-30')).status,400);
 assert.equal((await f.request('POST',path,{})).status,405);
 const copied=f.jar.fork();await f.auth('POST','logout',{});assert.equal((await f.request('GET',path,undefined,{},copied)).status,401);
 await f.login();f.clock.advance(f.options.policy.idleTimeoutMs+1);assert.equal((await f.request('GET',path)).status,401);
});
