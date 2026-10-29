import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {startOwnerBrowserHarness} from '../support/owner-crm-harness';
let server:Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.beforeEach(async()=>{server=await startOwnerBrowserHarness({migrationFiles:['006_local_operations_records.up.sql','007_local_car_rentals.up.sql','008_local_partner_records.up.sql','009_local_partner_corrections.up.sql']});await mkdir('evidence/overview-polish',{recursive:true});});
test.afterEach(async()=>{await server.close();});
function response(url:string,populated:boolean){
 const params=new URL(url).searchParams;
 return{data:{month:params.get('month'),asOf:params.get('asOf'),moneyUnit:'decimal-major-unit-strings',overviewVersion:1,accounts:{companySetupRequired:!populated},overview:{basis:{totalCollected:'Synthetic render-contract fixture; explicit allocations only.',trendCollections:'Synthetic recorded receipts, no advances or deposits.',expenses:'Recorded costs, not profit.',balances:'Separate company accounts only.'},currencies:populated?[{currency:'QAR',totalCollected:'2800',pendingCollection:'3200',companyCash:'8500',companyBank:'16700',monthlyExpenses:'0',rent:{expected:'6000',allocated:'2800',outstanding:'3200',unappliedAdvances:'300',depositHeld:'500',pendingCheques:'0'},operations:{carCollected:null,staffHeld:'500',pendingCheques:'0',pendingRentCheques:'0',pendingCarCheques:'0',upcomingAmount:'3200',upcomingCount:3,nextDueDate:'2026-11-05',overdueAmount:'0',overdueCount:0,oldestOverdueDate:null},trend:['06','07','08','09','10'].map((m,i)=>({month:'2026-'+m,collections:String([900,1200,700,1300,2800][i]),expenses:String([850,1100,700,1350,0][i])})),trendReady:true}]:[]}}};
}
for(const populated of [false,true])test(`${populated?'Populated':'Unconfigured'} dashboard preserves honest figures, chart alignment, responsive forms and refresh`,async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/workspace/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('<head>','<head><meta name="hamdee-demo" content="isolated-local">')});});
 await page.route('**/api/hamdee/v1/operations-dashboard?*',route=>route.fulfill({status:200,json:response(route.request().url(),populated)}));
 await page.goto(server.url+'/login');await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.locator('#daily-dashboard')).toHaveAttribute('aria-busy','false');
 const sizes=info.project.name==='desktop'?[[1440,1000],[1366,768],[1024,768],[768,1024]]:[[390,844],[430,932]];
 for(const [width,height]of sizes){
  await page.setViewportSize({width,height});
  await expect(page.locator('.overview-chart-card')).toHaveCount(3);await expect(page.locator('.overview-kpi')).toHaveCount(5);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  if(width>=1366){const cards=await page.locator('.overview-chart-card').evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return{top:r.top,height:r.height};}));expect(Math.max(...cards.map(c=>c.top))-Math.min(...cards.map(c=>c.top))).toBeLessThanOrEqual(1);expect(Math.max(...cards.map(c=>c.height))-Math.min(...cards.map(c=>c.height))).toBeLessThanOrEqual(1);}
  if(width===390||width===430)expect((await page.getByLabel('Reporting month',{exact:true}).boundingBox())!.width).toBeGreaterThan(200);
  if(populated){await expect(page.locator('.overview-kpi').first()).toContainText('2,800.00');await expect(page.locator('.overview-kpi').last()).toContainText('0.00');await expect(page.locator('.overview-bar-receipts')).toHaveCount(5);await expect(page.locator('.overview-donut-allocated')).toHaveAttribute('stroke-dasharray',/^46\.66/);await expect(page.locator('.overview-setup-notice')).toHaveCount(0);}
  else{await expect(page.locator('.overview-setup-notice')).toHaveCount(1);expect(await page.locator('.overview-unverified').allInnerTexts()).toEqual(expect.arrayContaining(['—']));await expect(page.locator('.overview-bar-receipts,.overview-donut-allocated,.overview-funds-zero-label')).toHaveCount(0);await expect(page.getByRole('img',{name:'No recorded activity. No financial values are plotted.',exact:true})).toBeVisible();}
  await page.screenshot({path:`evidence/overview-polish/${populated?'populated':'unconfigured'}-${width}.png`,fullPage:true});
 }
 await page.reload();await expect(page.locator('#daily-dashboard')).toHaveAttribute('aria-busy','false');
 await page.getByRole('link',{name:'Record collection',exact:true}).click();await expect(page.getByRole('heading',{name:'Properties',exact:true})).toBeVisible();
 expect(errors).toEqual([]);
});
