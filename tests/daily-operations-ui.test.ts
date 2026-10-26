import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const listeners=new Map<string,(event:unknown)=>Promise<void>|void>();
const documentDescriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
const windowDescriptor=Object.getOwnPropertyDescriptor(globalThis,'window');
const formDataDescriptor=Object.getOwnPropertyDescriptor(globalThis,'FormData');
Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:()=>null,addEventListener:(name:string,listener:(event:unknown)=>Promise<void>|void)=>listeners.set(name,listener)}});
Object.defineProperty(globalThis,'window',{configurable:true,value:{AbortController}});
Object.defineProperty(globalThis,'FormData',{configurable:true,value:class extends Map<string,string>{constructor(form:{values:Record<string,string>}){super(Object.entries(form.values));}}});
const rental=await import('../public/workspace/rental.js');
const daily=await import('../public/workspace/daily-dashboard.js');
test.afterEach(()=>{rental.resetRental();daily.resetDailyDashboard();});
test.after(()=>{for(const [name,value]of [['document',documentDescriptor],['window',windowDescriptor],['FormData',formDataDescriptor]] as const){if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name);}});
function records(){return{
 rooms:[{id:'demo-room',propertyId:'demo-property',code:'DEMO-R01',label:'',historicalOccupants:[{tenantId:'demo-historical-tenant',period:'2026-10',source:'DEMO source',sourceReference:'DEMO p1',currentOccupancyVerified:false}]}],
 tenants:[{id:'demo-tenant',name:'DEMO verified tenant',phone:'',email:'',notes:''},{id:'demo-historical-tenant',name:'DEMO historical contact',phone:'',email:'',notes:''}],
 agreements:[{id:'demo-agreement',roomId:'demo-room',propertyId:'demo-property',tenantId:'demo-tenant',startDate:'2026-10-01',endDate:null,monthlyRentMinor:'100000',currency:'QAR',dueTerms:'Explicit owner terms',depositRequiredMinor:'50000'}],
 dues:[{id:'demo-due',agreementId:'demo-agreement',roomId:'demo-room',propertyId:'demo-property',period:'2026-11',dueDate:'2026-11-05',amountMinor:'100000',paidMinor:'25000',outstandingMinor:'75000',currency:'QAR',status:'partial',snapshot:{roomCode:'DEMO-R01',tenantName:'DEMO verified tenant'}}],
 collections:[{id:'demo-advance',agreementId:'demo-agreement',roomId:'demo-room',propertyId:'demo-property',kind:'advance',method:'cash',status:'recorded',receivedDate:'2026-10-26',amountMinor:'30000',availableAdvanceMinor:'10000',currency:'QAR',reference:'DEMO-OCT-ADVANCE'},
 {id:'demo-deposit',agreementId:'demo-agreement',roomId:'demo-room',propertyId:'demo-property',kind:'deposit',method:'bank',status:'recorded',receivedDate:'2026-10-26',amountMinor:'50000',currency:'QAR',reference:'DEMO-DEPOSIT'}],
 allocations:[],history:[],summary:{totalRooms:1,currencies:[]}
};}
class Target{
 innerHTML='';attributes=new Map<string,string>();handlers=new Map<string,()=>void>();
 setAttribute(name:string,value:string){this.attributes.set(name,value);}removeAttribute(name:string){this.attributes.delete(name);}
 querySelectorAll(){return[];}
 querySelector(selector:string){return{addEventListener:(_:string,handler:()=>void)=>this.handlers.set(selector,handler)};}
}
async function renderRental(data=records()){
 const target=new Target(),reads:unknown[]=[];let writes=0;
 const options={property:{id:'demo-property',name:'DEMO villa'},section:'collections',api:{rentalRead:async(filters:unknown)=>{reads.push(filters);return{data};},rentalWrite:async()=>{writes++;assert.fail('Read cannot write');}},signal:new AbortController().signal,isCurrent:()=>true,verifyAccess:async()=>true,onAccessLoss:async()=>assert.fail('Unexpected access loss')};
 await rental.renderRental(target,options);return{target,reads,writes:()=>writes};
}
function dashboard(){return{
 month:'2026-11',asOf:'2026-11-03',moneyUnit:'decimal-major-unit-strings',
 overviewVersion:1,overview:{basis:{totalCollected:'Allocated to issued rent dues',trendCollections:'Original cash/bank rent and car receipts',expenses:'Recorded property & vehicle costs',balances:'Verified company accounts only'},currencies:[{currency:'QAR',totalCollected:'450.00',pendingCollection:'550.00',companyCash:null,companyBank:null,monthlyExpenses:'200.00',rent:{expected:'1000.00',allocated:'450.00',outstanding:'550.00',unappliedAdvances:'100.00',depositHeld:'500.00',pendingCheques:'0.00'},operations:{carCollected:null,staffHeld:'100.00',pendingCheques:'0.00',pendingRentCheques:'0.00',pendingCarCheques:'0.00',upcomingAmount:'550.00',upcomingCount:1,nextDueDate:'2026-11-05'},trend:[],trendReady:false}]},
 accounts:{companySetupRequired:true,personalSetupRequired:false,company:[],personal:[{id:'demo-personal',name:'PERSONAL-SECRET-REFERENCE',kind:'bank',currency:'INR',balance:'987654.32'}]},
 balances:[{currency:'QAR',companyCash:null,companyBank:null,staffHeld:'100.00'}],personalBalances:[{currency:'INR',personalCash:'987654.32',personalBank:'987654.32'}],
 rent:[{currency:'QAR',expected:'1000.00',allocated:'450.00',outstanding:'550.00',unappliedAdvances:'100.00',depositHeld:'500.00',pendingCheques:'0.00'}],
 expenses:[{currency:'QAR',recorded:'200.00',paid:'50.00',pendingCheques:'0.00'}],staff:[{collectorId:'demo-collector',name:'DEMO collector <img src=x>',currency:'QAR',balance:'100.00'}],
 recentCollections:[{id:'demo-receipt',propertyId:'demo-property',propertyName:'DEMO villa',roomId:'demo-room',roomCode:'DEMO-R01',tenantName:'DEMO tenant',date:'2026-10-26',kind:'advance',method:'cash',status:'recorded',currency:'QAR',amount:'300.00'}],
 upcomingDues:[{id:'demo-due',agreementId:'demo-agreement',propertyId:'demo-property',propertyName:'DEMO villa',roomId:'demo-room',roomCode:'DEMO-R01',tenantName:'DEMO tenant',period:'2026-11',dueDate:'2026-11-05',currency:'QAR',amount:'1000.00',paid:'450.00',outstanding:'550.00'}],
 basis:'DEMO server-authoritative saved operations; currencies remain separate.'
};}

test('Owner-confirmed November start is the initial default while earlier entries and later months remain explicit choices',()=>{
 assert.equal(rental.defaultCollectionMonth('2026-10-26'),'2026-11');assert.equal(rental.defaultCollectionMonth('2026-11-10'),'2026-11');assert.equal(rental.defaultCollectionMonth('2027-01-03'),'2027-01');
 assert.equal(rental.quickCollectionPlan(records(),'demo-room','2026-10').period,'2026-10');
});

test('November room plan uses only saved dated agreements and issued dues; no historical tenant or amount generates records',()=>{
 const data=records(),before=JSON.stringify(data),plan=rental.quickCollectionPlan(data,'demo-room','2026-11');
 assert.equal(plan.agreement?.tenantId,'demo-tenant');assert.equal(plan.dues[0].period,'2026-11');assert.equal(plan.advances[0].receivedDate,'2026-10-26');
 assert.equal(JSON.stringify(data),before);
 data.agreements=[];data.dues=[];const unverified=rental.quickCollectionPlan(data,'demo-room','2026-11');
 assert.equal(unverified.agreement,null);assert.deepEqual(unverified.agreements,[]);assert.deepEqual(unverified.dues,[]);
 assert.equal(data.rooms[0].historicalOccupants[0].tenantId,'demo-historical-tenant');
});
test('Agreement month matching excludes future/ended tenancy, preserves multiple candidates for owner selection and validates months',()=>{
 const data=records();data.agreements[0].endDate='2026-10-31' as never;assert.equal(rental.quickCollectionPlan(data,'demo-room','2026-11').agreement,null);
 data.agreements[0].endDate=null;data.agreements[0].startDate='2026-12-01';assert.equal(rental.quickCollectionPlan(data,'demo-room','2026-11').agreement,null);
 data.agreements[0].startDate='2026-10-01';data.agreements.push({...data.agreements[0],id:'demo-second-agreement'});
 assert.equal(rental.quickCollectionPlan(data,'demo-room','2026-11').agreement,null);assert.equal(rental.quickCollectionPlan(data,'demo-room','2026-11','demo-second-agreement').agreement?.id,'demo-second-agreement');
 assert.throws(()=>rental.quickCollectionPlan(data,'demo-room','2026-13'));assert.throws(()=>rental.quickCollectionPlan(data,'missing-room','2026-11'));
});
test('Selecting November keeps October advances visible and explicitly allocatable while security deposits remain separate',async()=>{
 const {target,writes}=await renderRental();
 await listeners.get('submit')?.({preventDefault(){},target:{matches:(selector:string)=>selector==='[data-rental-filter]',values:{month:'2026-11',asOf:'2026-11-03'}}});
 const source=target.innerHTML.split('aria-label="Cross-month advances"')[1].split('</table>')[0];
 assert.match(source,/2026-10-26/);assert.match(source,/QAR 300\.00/);assert.match(source,/QAR 100\.00/);assert.match(source,/data-rental-action="allocate-advance"/);
 assert.doesNotMatch(source,/demo-deposit|QAR 500\.00/);assert.match(target.innerHTML,/Collection month|Rent month/);assert.equal(writes(),0);
});
test('An unknown advance availability is visibly unverified and cannot manufacture a remaining amount',async()=>{
 const data=records();delete (data.collections[0] as {availableAdvanceMinor?:string}).availableAdvanceMinor;
 const {target}=await renderRental(data);const source=target.innerHTML.split('aria-label="Cross-month advances"')[1].split('</table>')[0];
 assert.match(source,/Not verified/);assert.doesNotMatch(source,/data-rental-action="allocate-advance"/);
});
test('Dashboard shows compact authoritative figures and module links without personal or detailed-record disclosure',()=>{
 const data=dashboard(),before=JSON.stringify(data),html=daily.dailyDashboardMarkup(data);
 assert.match(html,/Not verified/);assert.match(html,/href="#company"/);
 assert.match(html,/550\.00/);assert.match(html,/100\.00/);assert.match(html,/Deposits held/);assert.match(html,/href="#collections"/);
 assert.doesNotMatch(html,/PERSONAL-SECRET-REFERENCE|987654\.32|Personal cash|Personal bank|Distributable profit/);
 assert.doesNotMatch(html,/<table|DEMO collector|DEMO villa|demo-property|img src=x/);assert.equal(JSON.stringify(data),before);
});
test('Dashboard formats decimal strings exactly and currency selection never combines company balances',()=>{
 const data=dashboard();data.accounts.companySetupRequired=false;data.accounts.company.push({id:'demo-account',name:'DEMO cash',kind:'cash',currency:'INR',balance:'1234.123456789'} as never);
 data.balances.push({currency:'INR',companyCash:'1234.123456789',companyBank:null,staffHeld:'0.00'} as never);
 data.overview.currencies.push({...data.overview.currencies[0],currency:'INR',companyCash:'1234.123456789'} as never);
 const html=daily.dailyDashboardMarkup(data,'INR');assert.match(html,/1,234\.123456789/);assert.doesNotMatch(html,/1334\.12|Combined balance|QAR<\/span>/);
});
test('Dashboard requests the chosen month/cutoff, re-verifies owner access and clears data after route abort',async()=>{
 const target=new Target(),route=new AbortController(),calls:unknown[]=[];let verified=0;
 await daily.renderDailyDashboard(target,{api:{operationsDashboard:async(filters:unknown)=>{calls.push(filters);return{data:dashboard()};}},month:'2026-11',asOf:'2026-11-03',signal:route.signal,isCurrent:()=>true,verifyAccess:async()=>{verified++;return true;},onAccessLoss:async()=>assert.fail('Unexpected loss')});
 assert.deepEqual(calls,[{month:'2026-11',asOf:'2026-11-03'}]);assert.equal(verified,1);assert.match(target.innerHTML,/Business Overview/);route.abort();assert.equal(target.innerHTML,'');
});
test('Dashboard denies stale/cross-period responses and owner access errors without retaining private figures',async()=>{
 for(const denied of [false,true]){
  const target=new Target();let lost=0;
  await daily.renderDailyDashboard(target,{api:{operationsDashboard:async()=>{if(denied)throw Object.assign(new Error('Denied'),{status:401});return{data:{...dashboard(),month:'2026-10'}};}},month:'2026-11',asOf:'2026-11-03',signal:new AbortController().signal,isCurrent:()=>true,verifyAccess:async()=>true,onAccessLoss:async()=>{lost++;}});
  assert.doesNotMatch(target.innerHTML,/DEMO villa|QAR 550/);assert.equal(lost,denied?1:0);
 }
});
test('Standalone login has no CRM sidebar, hardcoded identity, MFA prompt or local credential storage',async()=>{
 const html=await readFile(new URL('../public/login.html',import.meta.url),'utf8'),script=await readFile(new URL('../public/login.js',import.meta.url),'utf8');
 assert.match(html,/name="password" type="password" autocomplete="current-password" required/);assert.match(html,/id="login-email"/);
 assert.doesNotMatch(html+script,/sidebar|fazil4fazi|ahadabdusamad|admin@hamdee|localStorage|sessionStorage|authenticator|six-digit|QR-code/);
 assert.match(script,/delete body\.password/);assert.match(script,/window\.location\.replace\('\/workspace\/index\.html#dashboard'\)/);
 assert.match(script,/api\.authState/);assert.match(script,/pagehide/);
});
test('Quick collection UI uses existing explicit commands and does not submit collection-month or confirmation fields as financial rules',async()=>{
 const source=await readFile(new URL('../public/workspace/rental.js',import.meta.url),'utf8'),app=await readFile(new URL('../public/workspace/app.js',import.meta.url),'utf8');
 assert.match(source,/Collect room rent','quick-room'/);assert.match(source,/Collection month','month'/);assert.match(source,/Confirm agreement terms/);
 assert.match(source,/requiresTermsConfirmation/);assert.match(source,/delete body\.confirmTerms/);
 assert.match(source,/state\.action==='quick-month'/);assert.match(source,/Company cash or bank placement is a separate confirmed step/);
 assert.match(app,/window\.location\.replace\('\/login'\)/);assert.match(app,/pageshow/);assert.match(app,/event\.persisted/);
 assert.doesNotMatch(source,/create-classified-receipt|\.financeWrite\(|automatic proration enabled/);
 const css=await readFile(new URL('../public/workspace/foundation.css',import.meta.url),'utf8');assert.match(css,/#rental-save\[hidden\]\{display:none\}/);
});
