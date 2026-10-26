import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldFormData=Object.getOwnPropertyDescriptor(globalThis,'FormData');
Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:()=>null,addEventListener(){}}});
Object.defineProperty(globalThis,'window',{configurable:true,value:{AbortController,icon:(name:string)=>`<svg aria-hidden="true" data-icon="${name}"></svg>`}});
Object.defineProperty(globalThis,'FormData',{configurable:true,value:class extends Map<string,string>{constructor(form:{values:Record<string,string>}){super(Object.entries(form.values));}}});
const daily=await import('../public/workspace/daily-dashboard.js');
test.afterEach(()=>daily.resetDailyDashboard());
test.after(()=>{for(const [name,value]of [['document',oldDocument],['window',oldWindow],['FormData',oldFormData]] as const){if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name);}});
function row(currency='XTS'){
 return{currency,totalCollected:'450',pendingCollection:'550',companyCash:'1850',companyBank:'1000',monthlyExpenses:'100',
 rent:{expected:'1000',allocated:'450',outstanding:'550',unappliedAdvances:'100',depositHeld:'500',pendingCheques:'600'},
 operations:{carCollected:'300',staffHeld:'700',pendingCheques:'650',pendingRentCheques:'600',pendingCarCheques:'50',upcomingAmount:'550',upcomingCount:1,nextDueDate:'2026-11-05' as string|null},
 trend:[{month:'2026-10',collections:'550',expenses:'200'},{month:'2026-11',collections:'250',expenses:'100'}],trendReady:true};
}
function dashboard(){return{month:'2026-11',asOf:'2026-11-05',moneyUnit:'decimal-major-unit-strings',accounts:{companySetupRequired:false},overviewVersion:1,
 overview:{currencies:[row()],basis:{totalCollected:'Allocations to confirmed issued rent dues for the selected month; not revenue recognition.',trendCollections:'Original recorded cash/bank rent-kind and car receipts by receipt date. Advances, deposits, transfers and handovers excluded.',expenses:'Recorded property & vehicle costs by expense date; not distributable profit.',balances:'Confirmed company account openings and saved movements. Personal finance excluded.'}},
 personalBalances:[{currency:'INR',cash:'987654321.89'}],recentCollections:[{tenantName:'PRIVATE-TENANT-DO-NOT-DISPLAY'}],staff:[{name:'PRIVATE-COLLECTOR-DO-NOT-DISPLAY'}]};}
class Target{
 innerHTML='';attributes=new Map<string,string>();handlers=new Map<string,(event:unknown)=>void>();focused='';
 elements=new Map<string,{value:string;addEventListener:(name:string,handler:(event:unknown)=>void)=>void;focus:()=>void}>();
 setAttribute(name:string,value:string){this.attributes.set(name,value);}
 querySelector(selector:string){let element=this.elements.get(selector);if(!element){element={value:'',addEventListener:(_:string,handler:(event:unknown)=>void)=>{this.handlers.set(selector,handler);},focus:()=>{this.focused=selector;}};this.elements.set(selector,element);}return element;}
}
async function render(data=dashboard(),more:Record<string,unknown>={}){
 const target=new Target(),calls:unknown[]=[],route=new AbortController();let checks=0,lost=0;
 const api={operationsDashboard:async(filters:unknown)=>{calls.push(filters);return{data};}};
 await daily.renderDailyDashboard(target,{api,month:data.month,asOf:data.asOf,signal:route.signal,isCurrent:()=>true,verifyAccess:async()=>{checks++;return true;},onAccessLoss:async()=>{lost++;},...more});
 return{target,calls,route,checks:()=>checks,lost:()=>lost};
}

test('Business overview has exactly five financial KPI cards, two genuine charts and four compact operations without detailed tables',()=>{
 const html=daily.dailyDashboardMarkup(dashboard());
 assert.equal((html.match(/class="overview-kpi(?: overview-kpi-primary)?"/g)||[]).length,5);
 assert.equal((html.match(/class="overview-chart-card"/g)||[]).length,2);
 assert.equal((html.match(/class="overview-operation"/g)||[]).length,4);
 for(const label of ['Business Overview','Total Collected','Pending Collection','Company Cash in Hand','Company Bank Balance','Monthly Expenses','Collection Status','Monthly Collections vs Expenses'])assert(html.includes(label));
 assert.doesNotMatch(html,/<table|Recently updated properties|Total properties|PRIVATE-TENANT|PRIVATE-COLLECTOR|987654321/);
 assert.match(html,/Allocated to issued rent dues/);assert.match(html,/Receipt-date cash\/bank collections/);assert.match(html,/Recorded property &amp; vehicle costs/);
 assert.match(html,/stroke-dasharray="45 100"/);assert.match(html,/2026[^<]*|Nov 2026/);
});

test('Only the selected currency is presented; personal balances and currency combinations never enter totals',()=>{
 const data=dashboard();data.overview.currencies.push({...row('INR'),companyCash:'98765.43210001',totalCollected:'12345.67'});
 const initial=daily.dailyDashboardMarkup(data,'XTS'),selected=daily.dailyDashboardMarkup(data,'INR');
 assert.match(initial,/>XTS<\/span> 450\.00/);assert.doesNotMatch(initial,/98,765|12,345/);
 assert.match(selected,/>INR<\/span> 98,765\.43210001/);assert.match(selected,/>INR<\/span> 12,345\.67/);assert.doesNotMatch(selected,/>XTS<\/span>/);
 assert.match(selected,/<option value="INR" selected/);assert.doesNotMatch(initial+selected,/987654321\.89|Combined balance/);
});

test('Default currency prioritizes verified issued rent over an alphabetical account-only currency while preserving explicit selection',async()=>{
 const data=dashboard(),accountOnly={...row('INR'),companyCash:'2500',totalCollected:null,pendingCollection:null,rent:{...row().rent,expected:null,allocated:null,outstanding:null}};
 data.overview.currencies.unshift(accountOnly as unknown as ReturnType<typeof row>);
 const initial=daily.dailyDashboardMarkup(data);assert.match(initial,/<option value="XTS" selected/);assert.match(initial,/>XTS<\/span> 450\.00/);assert.doesNotMatch(initial,/>INR<\/span>/);
 const explicit=daily.dailyDashboardMarkup(data,'INR');assert.match(explicit,/<option value="INR" selected/);assert.match(explicit,/>INR<\/span> 2,500\.00/);assert.match(explicit,/No confirmed issued dues/);assert.doesNotMatch(explicit,/>XTS<\/span>/);
 const {target}=await render(data);assert.match(target.innerHTML,/<option value="XTS" selected/);
 target.handlers.get('[name="currency"]')?.({target:{value:'INR'}});assert.match(target.innerHTML,/<option value="INR" selected/);assert.match(target.innerHTML,/No confirmed issued dues/);
});

test('Unknown openings and no confirmed rental terms stay Not verified; a genuine confirmed zero remains zero',()=>{
 const data=dashboard(),r=data.overview.currencies[0];
 Object.assign(r,{companyCash:null,companyBank:null,totalCollected:null,pendingCollection:null,monthlyExpenses:'0'});Object.assign(r.rent,{expected:null,allocated:null,outstanding:null});
 const html=daily.dailyDashboardMarkup(data);
 assert.match(html,/Confirm room terms/);assert.match(html,/No confirmed issued dues/);assert((html.match(/overview-unverified/g)||[]).length>=6);
 assert.match(html,/Monthly Expenses[\s\S]*?XTS<\/span> 0\.00/);assert.doesNotMatch(html,/stroke-dasharray="45/);
});

test('An empty source response assumes no currency or bank opening and invents no historical trend bars',()=>{
 const data=dashboard();data.overview.currencies=[];const html=daily.dailyDashboardMarkup(data);
 assert.match(html,/No verified currency/);assert.match(html,/Not enough verified history/);assert.match(html,/name="currency"[^>]*disabled/);
 assert.doesNotMatch(html,/>QAR|overview-bar-receipts|NaN|Infinity/);
});

test('A single source month produces honest insufficient-history state, not fabricated prior months',()=>{
 const data=dashboard();data.overview.currencies[0].trend=[{month:'2026-11',collections:'250',expenses:'100'}];data.overview.currencies[0].trendReady=false;
 const html=daily.dailyDashboardMarkup(data);assert.match(html,/Not enough verified history/);assert.doesNotMatch(html,/class="overview-bar-receipts"|Oct 2026/);
});

test('Decimal strings retain full precision, sign and large exact values instead of floating point rounding',()=>{
 assert.equal(daily.formatOverviewAmount('12345678901234567890.123456789'),'12,345,678,901,234,567,890.123456789');
 assert.equal(daily.formatOverviewAmount('-1234.5'),'-1,234.50');assert.equal(daily.formatOverviewAmount('0'),'0.00');assert.equal(daily.formatOverviewAmount(null),'Not verified');
 assert.equal(daily.formatOverviewAmount('1e5'),'Not verified');
});

test('All indicators drill down to real modules; incoming pending cheques have separate rental and car destinations',()=>{
 const html=daily.dailyDashboardMarkup(dashboard());
 for(const path of ['#collections','#company','#car-rentals','#staff-collections','#expenses','#reports','#cheques'])assert(html.includes('href="'+path+'"'));
 assert.match(html,/Incoming only · through cutoff/);assert.match(html,/href="#cheques">Rent /);assert.match(html,/href="#car-rentals">Car /);
 assert.match(html,/Unallocated advances/);assert.match(html,/Deposits held/);assert.match(html,/Personal finance and unposted history are excluded/);
 assert.doesNotMatch(html,/#[^" ]*\?month=/);
});

test('Reading re-verifies owner access once, uses one aggregate request and clears all private figures on route abort',async()=>{
 const {target,calls,route,checks}=await render();
 assert.deepEqual(calls,[{month:'2026-11',asOf:'2026-11-05'}]);assert.equal(checks(),1);assert.match(target.innerHTML,/1,850\.00/);
 route.abort();assert.equal(target.innerHTML,'');
});

test('Changing currency reuses the existing server aggregate without additional API or ledger requests and retains keyboard focus',async()=>{
 const data=dashboard();data.overview.currencies.push({...row('INR'),companyCash:'98765.43'});const {target,calls}=await render(data);
 target.handlers.get('[name="currency"]')?.({target:{value:'INR'}});assert.equal(calls.length,1);assert.match(target.innerHTML,/98,765\.43/);assert.equal(target.focused,'[name="currency"]');
});

test('Currency changes preserve unsubmitted date filters without relabelling the saved dataset or requesting another period',async()=>{
 const data=dashboard();data.overview.currencies.push({...row('INR'),companyCash:'98765.43'});const {target,calls}=await render(data);
 target.handlers.get('[name="currency"]')?.({target:{value:'INR',form:{values:{month:'2026-10',asOf:'2026-10-31',currency:'INR'}}}});
 assert.equal(target.querySelector('[name="month"]').value,'2026-10');assert.equal(target.querySelector('[name="asOf"]').value,'2026-10-31');
 assert.equal(calls.length,1);assert.deepEqual(calls[0],{month:'2026-11',asOf:'2026-11-05'});assert.match(target.innerHTML,/Issued rent dues · Nov 2026/);
 assert.match(target.innerHTML,/98,765\.43/);assert.equal(target.focused,'[name="currency"]');
});

test('Chosen month and cutoff are sent explicitly; changing them does not write or reclassify receipts',async()=>{
 const data=dashboard(),{target,calls}=await render(data);
 target.handlers.get('[data-daily-filters]')?.({preventDefault(){},target:{values:{month:'2026-10',asOf:'2026-10-31',currency:'XTS'}}});
 await Promise.resolve();await Promise.resolve();assert.deepEqual(calls[1],{month:'2026-10',asOf:'2026-10-31'});
});

test('Malformed summaries, cross-period replies and unauthorized responses never preserve stale financial figures',async()=>{
 for(const mode of ['version','period','decimal','duplicate','split','owner']as const){
  const data=dashboard();if(mode==='version')data.overviewVersion=0;if(mode==='period')data.month='2026-10';if(mode==='decimal')data.overview.currencies[0].companyCash='1e9';if(mode==='duplicate')data.overview.currencies.push(row());if(mode==='split')delete (data.overview.currencies[0].operations as {pendingRentCheques?:string}).pendingRentCheques;
  const {target,lost}=await render(data,{month:'2026-11',asOf:'2026-11-05',...(mode==='owner'?{api:{operationsDashboard:async()=>{throw Object.assign(new Error('Denied'),{status:401});}}}:{})});
  assert.doesNotMatch(target.innerHTML,/1,850\.00|450\.00|overview-kpi-primary/);assert.equal(lost(),mode==='owner'?1:0);
 }
});

test('Untrusted server basis is escaped and charts expose accessible descriptive names',()=>{
 const data=dashboard();data.overview.basis.totalCollected='<img src=x onerror=alert(1)>';const html=daily.dailyDashboardMarkup(data);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/<img src=x/);assert.equal((html.match(/role="img" aria-label=/g)||[]).length,2);assert.match(html,/<details><summary>Reporting basis<\/summary>/);
 assert.match(html,/aria-describedby="overview-trend-values"/);assert.match(html,/<desc id="overview-trend-values">Oct 2026: XTS 550\.00 cash\/bank collections; XTS 200\.00 recorded costs\./);
 assert.match(html,/>View monthly values<\/summary>/);assert.match(html,/XTS · top 550\.00/);
 assert.match(html,/class="overview-chart-month overview-chart-month-short"[^>]*>Oct 26<\/text>/);assert.match(html,/class="overview-chart-month overview-chart-month-full"[^>]*>Oct 2026<\/text>/);
});

test('Dashboard route no longer requests duplicate property metadata or lists villas; responsive layout remains scoped',async()=>{
 const app=await readFile(new URL('../public/workspace/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/workspace/foundation.css',import.meta.url),'utf8');
 const branch=app.split("}else if(route==='dashboard'&&managed){")[1].split("}else if(['expenses'")[0];
 assert.doesNotMatch(branch,/api\.dashboard|Total properties|Recently updated|table\(/);assert.match(branch,/renderDailyDashboard/);assert.match(app,/main\.classList\.toggle\('business-overview-page'/);
 for(const width of ['1100px','850px','640px'])assert(css.includes('max-width:'+width));assert.match(css,/\.overview-kpis\{display:grid;grid-template-columns:repeat\(5/);
 const compact=css.split('@media(min-width:1100px) and (max-height:950px)')[1]?.split('\n')[0];assert(compact);assert.match(compact,/\.overview-donut\{width:128px;height:128px\}/);assert.match(compact,/\.overview-bar-chart\{height:116px;min-height:116px/);assert.doesNotMatch(compact,/display:none|overflow:hidden|font-size:[1-8]px/);
 assert.match(css,/@media\(max-width:640px\)\{\.overview-chart-month-full\{display:none\}\.overview-chart-month-short\{display:block;font-size:22px\}\.overview-chart-scale\{font-size:22px\}\}/);
 assert.doesNotMatch(css,/\.overview[^\n]*(?:animation:|transition:all)/);
});
