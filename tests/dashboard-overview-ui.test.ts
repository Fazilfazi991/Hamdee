import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldFormData=Object.getOwnPropertyDescriptor(globalThis,'FormData');
Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:()=>null,addEventListener(){}}});
Object.defineProperty(globalThis,'window',{configurable:true,value:{AbortController,icon:(name:string)=>`<svg aria-hidden="true" data-icon="${name}"></svg>`}});
Object.defineProperty(globalThis,'FormData',{configurable:true,value:class extends Map<string,string>{constructor(form:{values?:Record<string,string>}){super(Object.entries(form.values||{}));}}});
const daily=await import('../public/workspace/daily-dashboard.js');
test.afterEach(()=>daily.resetDailyDashboard());
test.after(()=>{for(const [name,value]of [['document',oldDocument],['window',oldWindow],['FormData',oldFormData]] as const){if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name);}});
function row(currency='QAR'){
 return{currency,totalCollected:'450',pendingCollection:'550',companyCash:'1850',companyBank:'1000',monthlyExpenses:'100',
 rent:{expected:'1000',allocated:'450',outstanding:'550',unappliedAdvances:'100',depositHeld:'500',pendingCheques:'600'},
 operations:{carCollected:'300',staffHeld:'700',pendingCheques:'650',pendingRentCheques:'600',pendingCarCheques:'50',upcomingAmount:'550',upcomingCount:1,nextDueDate:'2026-11-05' as string|null,overdueAmount:'0' as string|null,overdueCount:0,oldestOverdueDate:null as string|null},
 trend:[{month:'2026-10',collections:'550',expenses:'200'},{month:'2026-11',collections:'250',expenses:'100'}],trendReady:true};
}
function dashboard(){return{month:'2026-11',asOf:'2026-11-05',moneyUnit:'decimal-major-unit-strings',accounts:{companySetupRequired:false},overviewVersion:1,
 overview:{currencies:[row()],basis:{totalCollected:'Allocations to confirmed issued rent dues for the selected month; not revenue recognition.',trendCollections:'Original recorded cash/bank rent-kind and car receipts by receipt date. Advances, deposits, transfers and handovers excluded.',expenses:'Recorded property & vehicle costs by expense date; not distributable profit.',balances:'Confirmed company account openings and saved movements. Personal finance excluded.'}},
 personalBalances:[{currency:'INR',cash:'987654321.89'}],recentCollections:[{tenantName:'PRIVATE-TENANT-DO-NOT-DISPLAY'}],staff:[{name:'PRIVATE-COLLECTOR-DO-NOT-DISPLAY'}]};}
class Target{
 innerHTML='';attributes=new Map<string,string>();handlers=new Map<string,(event:unknown)=>void>();focused='';
 elements=new Map<string,{value:string;values:Record<string,string>;addEventListener:(name:string,handler:(event:unknown)=>void)=>void;focus:()=>void}>();
 setAttribute(name:string,value:string){this.attributes.set(name,value);}
 querySelector(selector:string){let element=this.elements.get(selector);if(!element){element={value:'',values:{},addEventListener:(_:string,handler:(event:unknown)=>void)=>{this.handlers.set(selector,handler);},focus:()=>{this.focused=selector;}};this.elements.set(selector,element);}return element;}
}
async function render(data=dashboard(),more:Record<string,unknown>={}){
 const target=new Target(),calls:unknown[]=[],route=new AbortController();let checks=0,lost=0;
 const api={operationsDashboard:async(filters:unknown)=>{calls.push(filters);return{data};}};
 await daily.renderDailyDashboard(target,{api,month:data.month,asOf:data.asOf,signal:route.signal,isCurrent:()=>true,verifyAccess:async()=>{checks++;return true;},onAccessLoss:async()=>{lost++;},...more});
 return{target,calls,route,checks:()=>checks,lost:()=>lost};
}

test('Business overview shows five headline KPIs, three simultaneous charts and four compact operations without detailed tables',()=>{
 const html=daily.dailyDashboardMarkup(dashboard());
 assert.equal((html.match(/class="overview-kpi(?: overview-kpi-primary)?"/g)||[]).length,5);
 assert.equal((html.match(/class="overview-chart-card(?: overview-(?:funds|activity)-card)?"/g)||[]).length,3);
 assert.equal((html.match(/class="overview-operation"/g)||[]).length,4);
 for(const label of ['Business Overview','Total Collected','Pending Collection','Company Cash in Hand','Company Bank Balance','Monthly Expenses','Collection Status','Company Funds','Monthly Collections vs Expenses'])assert(html.includes(label));
 assert.doesNotMatch(html,/<table|Recently updated properties|Total properties|PRIVATE-TENANT|PRIVATE-COLLECTOR|987654321/);
 assert.match(html,/Allocated to issued rent dues/);assert.match(html,/Separate balances/);assert.match(html,/Recorded property &amp; vehicle costs/);
 assert.match(html,/stroke-dasharray="45 100"/);assert.match(html,/2026[^<]*|Nov 2026/);
 assert.match(html,/<i class="overview-dot allocated"><\/i>Allocated to rent<\/dt><dd><span class="overview-money"><span class="overview-currency">QAR<\/span> 450\.00/);assert.match(html,/class="overview-issued-value"><span class="overview-money"><span class="overview-currency">QAR<\/span> 1,000\.00/);assert.match(html,/Property &amp; vehicle costs/);
});

test('Only the selected currency is presented; personal balances and currency combinations never enter totals',()=>{
 const data=dashboard();data.overview.currencies.push({...row('INR'),companyCash:'98765.43210001',totalCollected:'12345.67'});
 const initial=daily.dailyDashboardMarkup(data,'QAR'),selected=daily.dailyDashboardMarkup(data,'INR');
 assert.match(initial,/>QAR<\/span> 450\.00/);assert.doesNotMatch(initial,/98,765|12,345/);
 assert.match(selected,/>INR<\/span> 98,765\.43210001/);assert.match(selected,/>INR<\/span> 12,345\.67/);assert.doesNotMatch(selected,/>QAR<\/span>/);
 assert.doesNotMatch(initial+selected,/987654321\.89|Combined balance/);
});

test('QAR is the default and other currencies never leak into the overview',()=>{
 const data=dashboard();data.overview.currencies=[row('INR')];const html=daily.dailyDashboardMarkup(data);
 assert.doesNotMatch(html,/450\.00|INR<\/span>|Reporting currency/);assert.match(html,/Financial setup required/);
});

test('Unknown openings and no confirmed rental terms stay Not verified; a genuine confirmed zero remains zero',()=>{
 const data=dashboard(),r=data.overview.currencies[0];
 Object.assign(r,{companyCash:null,companyBank:null,totalCollected:null,pendingCollection:null,monthlyExpenses:'0'});Object.assign(r.rent,{expected:null,allocated:null,outstanding:null});
 const html=daily.dailyDashboardMarkup(data);
 assert.match(html,/Confirm room terms/);assert.match(html,/No confirmed issued dues/);assert((html.match(/overview-unverified/g)||[]).length>=6);
 assert.match(html,/Monthly Expenses[\s\S]*?QAR<\/span> 0\.00/);assert.doesNotMatch(html,/stroke-dasharray="45/);
});

test('An empty source response assumes no currency or bank opening and invents no historical trend bars',()=>{
 const data=dashboard();data.overview.currencies=[];const html=daily.dailyDashboardMarkup(data);
 assert.match(html,/No entries yet/);assert.doesNotMatch(html,/name="currency"/);
 assert.doesNotMatch(html,/>QAR|overview-bar-receipts|NaN|Infinity/);
});

test('One actual source month shows its genuine paired activity bars without pretending to be a trend or fabricating prior months',()=>{
 const data=dashboard();data.overview.currencies[0].trend=[{month:'2026-11',collections:'250',expenses:'100'}];data.overview.currencies[0].trendReady=false;
 const html=daily.dailyDashboardMarkup(data);assert.match(html,/Company Funds/);assert.match(html,/Recorded Activity/);assert.match(html,/1 available month · Nov 2026/);assert.equal((html.match(/class="overview-bar-receipts"/g)||[]).length,1);assert.equal((html.match(/class="overview-bar-expenses"/g)||[]).length,1);assert.doesNotMatch(html,/Monthly Collections vs Expenses|Oct 2026|overview-trend-empty/);
});

test('Decimal strings retain full precision, sign and large exact values instead of floating point rounding',()=>{
 assert.equal(daily.formatOverviewAmount('12345678901234567890.123456789'),'12,345,678,901,234,567,890.123456789');
 assert.equal(daily.formatOverviewAmount('-1234.5'),'-1,234.50');assert.equal(daily.formatOverviewAmount('0'),'0.00');assert.equal(daily.formatOverviewAmount(null),'Not verified');
 assert.equal(daily.formatOverviewAmount('1e5'),'Not verified');
});

test('All indicators drill down to real modules; incoming pending cheques have separate rental and car destinations',()=>{
 const html=daily.dailyDashboardMarkup(dashboard());
 for(const path of ['#collections','#company','#car-rentals','#staff-collections','#expenses','#reports','#cheques'])assert(html.includes('href="'+path+'"'));
 assert.match(html,/Incoming rent and car cheques through the reporting cutoff/);assert.match(html,/href="#cheques">Rent /);assert.match(html,/href="#car-rentals">Car /);
 assert.match(html,/Unallocated advances/);assert.match(html,/Deposits held/);assert.match(html,/Personal finance stays separate/);
 assert.doesNotMatch(html,/#[^" ]*\?month=/);
});

test('Reading re-verifies owner access once, uses one aggregate request and clears all private figures on route abort',async()=>{
 const {target,calls,route,checks}=await render();
 assert.deepEqual(calls,[{month:'2026-11',asOf:'2026-11-05'}]);assert.equal(checks(),1);assert.match(target.innerHTML,/1,850\.00/);
 route.abort();assert.equal(target.innerHTML,'');
});

test('Chosen month and cutoff are sent explicitly; changing them does not write or reclassify receipts',async()=>{
 const data=dashboard(),{target,calls}=await render(data);
 target.handlers.get('[data-daily-filters]')?.({preventDefault(){},target:{values:{month:'2026-10',asOf:'2026-10-31',currency:'QAR'}}});
 await Promise.resolve();await Promise.resolve();assert.deepEqual(calls[1],{month:'2026-10',asOf:'2026-10-31'});
});

test('Malformed summaries, cross-period replies and unauthorized responses never preserve stale financial figures',async()=>{
 for(const mode of ['version','period','decimal','duplicate','split','owner']as const){
  const data=dashboard();if(mode==='version')data.overviewVersion=0;if(mode==='period')data.month='2026-10';if(mode==='decimal')data.overview.currencies[0].companyCash='1e9';if(mode==='duplicate')data.overview.currencies.push(row());if(mode==='split')delete (data.overview.currencies[0].operations as {pendingRentCheques?:string}).pendingRentCheques;
  const {target,lost}=await render(data,{month:'2026-11',asOf:'2026-11-05',...(mode==='owner'?{api:{operationsDashboard:async()=>{throw Object.assign(new Error('Denied'),{status:401});}}}:{})});
  assert.doesNotMatch(target.innerHTML,/1,850\.00|450\.00|overview-kpi-primary/);assert.equal(lost(),mode==='owner'?1:0);
 }
});

test('Untrusted server basis is escaped and all three charts expose exact accessible descriptions',()=>{
 const data=dashboard();data.overview.basis.totalCollected='<img src=x onerror=alert(1)>';const html=daily.dailyDashboardMarkup(data,'QAR');
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/<img src=x/);assert.equal((html.match(/role="img" aria-label=/g)||[]).length,3);assert.match(html,/<details><summary>Reporting basis<\/summary>/);
 assert.match(html,/aria-describedby="overview-activity-description"/);assert.match(html,/<desc id="overview-activity-description">Oct 2026: QAR 550\.00 cash\/bank receipts; QAR 200\.00 recorded costs\./);
 assert.match(html,/>Exact monthly values<\/summary>/);assert.match(html,/QAR · top 550\.00/);assert.match(html,/class="overview-activity-month"[^>]*>Oct26<\/text>/);assert.match(html,/<desc id="overview-funds-description">Company cash: QAR 1,850\.00; Company bank: QAR 1,000\.00; Held by collectors: QAR 700\.00/);
});

test('Funds comparison keeps cash, bank and custody separate without an invented total, income or personal balance',()=>{
 const html=daily.dailyDashboardMarkup(dashboard());
 assert.equal((html.match(/class="overview-funds-column (?:cash|bank|staff)"/g)||[]).length,3);
 for(const label of ['Company cash','Company bank','Held by collectors'])assert(html.includes(label));
 for(const value of ['1,850.00','1,000.00','700.00'])assert(html.includes(value));
 assert.match(html,/Separate balances · not income or profit/);assert.doesNotMatch(html,/3,550|free cash|PERSONAL|987654321|overview-trend-empty/);
});

test('Funds comparison preserves negative exact balances and unknown values instead of clipping them into positive or zero balances',()=>{
 const data=dashboard();data.overview.currencies[0].companyCash='0';data.overview.currencies[0].companyBank='-125.123456789';Object.assign(data.overview.currencies[0].operations,{staffHeld:null});
 const html=daily.dailyDashboardMarkup(data),funds=html.split('overview-funds-card')[1].split('overview-activity-card')[0];
 assert.match(funds,/bank negative/);assert.match(funds,/Negative balance shown below zero/);assert.match(funds,/-125\.123456789/);assert.match(funds,/>QAR<\/span> 0\.00/);assert.match(funds,/Not verified/);
 const bank=funds.split('overview-funds-column bank negative')[1].split('</g>')[0];assert.match(bank,/<rect x="153" y="14" width="50" height="132"/);
 const staff=funds.split('overview-funds-column staff')[1].split('</g>')[0];assert.match(staff,/overview-placeholder-track/);assert.doesNotMatch(staff,/<title>/);
});

test('Three charts are immediately visible from one summary read, without a toggle or extra API request',async()=>{
 const {target,calls,checks}=await render();for(const title of ['Collection Status','Company Funds','Monthly Collections vs Expenses'])assert(target.innerHTML.includes(title));assert.equal(calls.length,1);assert.equal(checks(),1);
 assert.doesNotMatch(target.innerHTML,/data-chart-switch|data-overview-view/);assert.match(target.innerHTML,/class="overview-bar-receipts"/);assert.match(target.innerHTML,/class="overview-vertical-funds"/);
});

test('Six supplied activity months render exactly six readable short ticks and pairs, retaining full exact source values',()=>{
 const data=dashboard();data.overview.currencies[0].trend=['06','07','08','09','10','11'].map((month,index)=>({month:'2026-'+month,collections:String(index+1)+'.123456789',expenses:String(index)+'.000000001'}));
 const html=daily.dailyDashboardMarkup(data),activity=html.split('overview-activity-card')[1].split('</section>')[0];
 assert.equal((activity.match(/class="overview-bar-receipts"/g)||[]).length,6);assert.equal((activity.match(/class="overview-bar-expenses"/g)||[]).length,6);assert.equal((activity.match(/class="overview-activity-month"/g)||[]).length,6);
 assert.match(activity,/>Sep26<\/text>/);assert.match(activity,/Sept 2026: QAR 4\.123456789 cash\/bank receipts; QAR 3\.000000001 recorded costs/);assert.match(activity,/viewBox="0 0 360 180"/);
 assert.match(activity,/6 activity months/);assert.doesNotMatch(activity,/Dec26|4\.12<|3\.00</);
});

test('No activity creates only a compact setup state, while verified funds and rent remain visible',async()=>{
 const data=dashboard();data.overview.currencies[0].trendReady=false;data.overview.currencies[0].trend=[];
 const {target,calls}=await render(data);assert.match(target.innerHTML,/Recorded Activity/);assert.match(target.innerHTML,/No entries yet/);assert.match(target.innerHTML,/Company Funds/);assert.match(target.innerHTML,/1,850\.00/);assert.doesNotMatch(target.innerHTML,/class="overview-bar-receipts"|overview-trend-empty/);assert.equal(calls.length,1);
});

test('Overdue visibility uses server amount, count and oldest date rather than recalculating due status in the client',()=>{
 const data=dashboard();Object.assign(data.overview.currencies[0].operations,{overdueAmount:'300.25',overdueCount:2,oldestOverdueDate:'2026-11-02'});
 const html=daily.dailyDashboardMarkup(data);assert.match(html,/Overdue rent/);assert.match(html,/300\.25/);assert.match(html,/2 dues · since 2 Nov/);assert.match(html,/href="#collections"/);
 Object.assign(data.overview.currencies[0].operations,{overdueAmount:'0',overdueCount:0,oldestOverdueDate:null});assert.match(daily.dailyDashboardMarkup(data),/No overdue dues at this cutoff/);
 Object.assign(data.overview.currencies[0].operations,{overdueAmount:null,overdueCount:0,oldestOverdueDate:null});assert.doesNotMatch(daily.dailyDashboardMarkup(data),/No overdue dues|Overdue rent/);
});

test('Malformed partial overdue information fails closed instead of displaying an invented overdue amount',async()=>{
 const data=dashboard();delete (data.overview.currencies[0].operations as {overdueCount?:number}).overdueCount;
 const {target}=await render(data);assert.doesNotMatch(target.innerHTML,/450\.00|overview-kpi-primary/);assert.match(target.innerHTML,/Saved overview unavailable/);
});

test('Dashboard route no longer requests duplicate property metadata or lists villas; responsive layout remains scoped',async()=>{
 const app=await readFile(new URL('../public/workspace/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/workspace/foundation.css',import.meta.url),'utf8');
 const branch=app.split("}else if(route==='dashboard'&&managed){")[1].split("}else if(['expenses'")[0];
 assert.doesNotMatch(branch,/api\.dashboard|Total properties|Recently updated|table\(/);assert.match(branch,/renderDailyDashboard/);assert.match(app,/main\.classList\.toggle\('business-overview-page'/);
 for(const width of ['1100px','850px','640px'])assert(css.includes('max-width:'+width));assert.match(css,/\.overview-kpis\{display:grid;grid-template-columns:repeat\(5/);
 const compact=css.split('@media(min-width:1100px) and (max-height:850px)')[1]?.split('\n')[0];assert(compact);assert.match(compact,/min-height:310px/);assert.match(compact,/height:158px/);assert.doesNotMatch(compact,/display:none|overflow:hidden|font-size:[1-8]px/);
 assert.match(css,/\.overview-kpi:nth-child\(4\)/);assert.match(css,/\.overview-chart-card\{display:flex;flex-direction:column/);

 assert.doesNotMatch(css,/\.overview[^\n]*(?:animation:|transition:all)/);
});

test('Missing financial figures use one setup notice, accessible dashes and unscaled chart placeholders rather than repeated warnings or invented zero amounts',()=>{
 const data=dashboard();data.overview.currencies=[];const html=daily.dailyDashboardMarkup(data);
 assert.equal((html.match(/class="overview-setup-notice"/g)||[]).length,1);
 assert.match(html,/aria-label="Not verified"[^>]*>—<\/span>/);assert.match(html,/Confirm rent terms →/);assert.match(html,/Set opening balances →/);
 assert.match(html,/No entries yet/);assert.doesNotMatch(html,/>Not verified<|overview-funds-zero-label|overview-bar-receipts|overview-donut-allocated/);
 assert.match(html,/No financial values are plotted/);assert.match(html,/href="#properties"[^>]*>[^<]*|Record collection/);
});
