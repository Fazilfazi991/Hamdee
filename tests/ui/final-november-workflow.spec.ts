import {test,expect,type Page,type Locator} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import {startOwnerBrowserHarness} from '../support/owner-crm-harness';

// Complete owner UI -> actual loopback HTTP -> disposable PostgreSQL engine.
// No API response mocks, provider credentials, hosted targets or fake ledger
// writes. The constructor-injected synthetic identity is test support only.
let server:Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(180_000);
test.beforeEach(async()=>{server=await startOwnerBrowserHarness({migrationFiles:['006_local_operations_records.up.sql']});await mkdir('evidence/final-november',{recursive:true});});
test.afterEach(async()=>{await server?.close();});
const propertyName='SYNTHETIC November operational villa',tenantName='SYNTHETIC November operational tenant',collectorName='SYNTHETIC November collector';
async function login(page:Page){
 expect(new URL(server.url).hostname).toBe('127.0.0.1');
 await page.goto(server.url+'/login');await expect(page.locator('#sidebar')).toHaveCount(0);
 await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Business Overview',exact:true})).toBeVisible();
 await expect(page.locator('#daily-dashboard')).toHaveAttribute('aria-busy','false');
}
async function nav(page:Page,name:string){
 const menu=page.getByRole('button',{name:'Open navigation',exact:true});if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')!=='true')await menu.click();
 await page.locator('#navigation').getByRole('link',{name,exact:true}).click();await expect(page.locator('#main')).toHaveAttribute('aria-busy','false');
}
async function save(dialog:Locator){await dialog.getByRole('button',{name:'Save record',exact:true}).click();await expect(dialog).not.toBeVisible();}
async function state(page:Page,module:string){
 const r=await page.request.get(server.url+'/api/hamdee/v1/'+module+'?month=2026-11&asOf=2026-10-26');const b=await r.json();expect(r.status(),JSON.stringify(b)).toBe(200);return b.data;
}
async function quickRoom(page:Page){
 const row=page.getByRole('region',{name:'Rooms and occupancy',exact:true}).getByRole('row').filter({has:page.getByRole('cell',{name:'NOV-01',exact:true})});
 await row.getByRole('button',{name:'Collect room rent',exact:true}).click();const d=page.locator('#rental-dialog');
 await expect(d.getByLabel('Collection month',{exact:true})).toHaveValue('2026-11');
 await d.getByRole('button',{name:'Open selected month',exact:true}).click();await expect(d.getByRole('heading',{name:'Room collection',exact:true})).toBeVisible();return d;
}
async function collection(page:Page,agreementId:string,purpose:string,amount:string,reference:string,method='cash'){
 await page.getByRole('button',{name:'Record collection',exact:true}).click();const d=page.locator('#rental-dialog');
 await d.getByLabel('Agreement',{exact:true}).selectOption(agreementId);await d.getByLabel('Collection purpose',{exact:true}).selectOption(purpose);
 await d.getByLabel('Payment method',{exact:true}).selectOption(method);await d.getByLabel('Amount',{exact:true}).fill(amount);
 await d.getByLabel('Received date',{exact:true}).fill('2026-10-26');await d.getByLabel('Reference (optional)',{exact:true}).fill(reference);await save(d);
}
async function dashboard(page:Page){
 await nav(page,'Dashboard');const filter=page.locator('[data-daily-filters]');
 await filter.locator('[name="month"]').fill('2026-11');await filter.locator('[name="asOf"]').fill('2026-10-26');await filter.locator('button[type="submit"]').click();
 await expect(page.locator('#daily-dashboard')).toHaveAttribute('aria-busy','false');
 await expect(page.getByRole('link',{name:/Total Collected:.*450\.00/})).toBeVisible();
 await expect(page.getByRole('link',{name:/Pending Collection:.*550\.00/})).toBeVisible();
 await expect(page.getByRole('link',{name:/Company Cash in Hand:.*400\.00/})).toBeVisible();
 await expect(page.getByRole('link',{name:/Company Bank Balance:.*Not verified/})).toBeVisible();
 await expect(page.getByRole('link',{name:/Money held by staff/})).toContainText('150.00');
 await expect(page.locator('#daily-dashboard table')).toHaveCount(0);
}

test('November owner workflow: confirmed room terms, October advance/partial payment, allocation, custody, company cash, dashboard, CSV and fresh login',async({page},info)=>{
 const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));await login(page);
 await nav(page,'Villas & Properties');await page.getByRole('button',{name:'Add property',exact:true}).click();
 await page.getByLabel('Property name',{exact:true}).fill(propertyName);await page.getByRole('button',{name:'Save property',exact:true}).click();
 await expect(page.getByRole('heading',{name:propertyName,exact:true})).toBeVisible();const propertyId=page.url().split('#properties/')[1];
 await page.getByRole('button',{name:'Rooms & rentals',exact:true}).click();await page.getByRole('button',{name:'Add room',exact:true}).click();
 let d=page.locator('#rental-dialog');await d.getByLabel('Room code',{exact:true}).fill('NOV-01');await save(d);
 await page.getByRole('button',{name:'Add tenant',exact:true}).click();d=page.locator('#rental-dialog');await d.getByLabel('Tenant name',{exact:true}).fill(tenantName);await save(d);
 const roomRow=page.getByRole('region',{name:'Rooms and occupancy',exact:true}).getByRole('row').filter({has:page.getByRole('cell',{name:'NOV-01',exact:true})});
 await roomRow.getByRole('button',{name:'Collect room rent',exact:true}).click();d=page.locator('#rental-dialog');
 await d.getByRole('button',{name:'Add previous entry',exact:true}).click();await expect(d.getByLabel('Collection month',{exact:true})).toHaveValue('');
 await d.getByRole('button',{name:'Close rental dialog',exact:true}).click();
 d=await quickRoom(page);await expect(d).toContainText('No dated agreement is saved');await d.getByRole('button',{name:'Confirm agreement terms',exact:true}).click();
 await d.getByLabel('Tenant',{exact:true}).selectOption({label:tenantName});await d.getByLabel('Monthly rent',{exact:true}).fill('1000');await d.getByLabel('Currency',{exact:true}).fill('XTS');
 await d.getByLabel('Due-date terms',{exact:true}).fill('Explicit owner-confirmed 1000 XTS due 5 November; no proration');await d.getByLabel('Security deposit required',{exact:true}).fill('500');
 await d.getByLabel('Agreement start date',{exact:true}).fill('2026-11-01');await d.getByLabel('Agreement end date (optional)',{exact:true}).fill('2026-11-30');
 await d.getByRole('checkbox',{name:/I confirm this tenant and these agreement terms/}).check();await d.getByRole('button',{name:'Save record',exact:true}).click();
 await expect(d.getByRole('heading',{name:'Room collection',exact:true})).toBeVisible();
 let rental=await state(page,'rental');expect(rental.agreements).toHaveLength(1);expect(rental.dues).toHaveLength(0);expect(rental.collections).toHaveLength(0);const agreementId=rental.agreements[0].id;
 await d.getByRole('button',{name:'Prepare monthly due',exact:true}).click();await expect(d.getByLabel('Rent month',{exact:true})).toHaveValue('2026-11');
 await d.getByLabel('Exact due date',{exact:true}).fill('2026-11-05');await d.getByLabel('Amount',{exact:true}).fill('1000');await d.getByRole('button',{name:'Save record',exact:true}).click();
 await expect(d.getByRole('heading',{name:'Room collection',exact:true})).toBeVisible();await d.getByRole('button',{name:'Close rental dialog',exact:true}).click();
 await collection(page,agreementId,'advance','300','SYNTHETIC-NOV-ADVANCE');await collection(page,agreementId,'deposit','500','SYNTHETIC-NOV-DEPOSIT','bank');
 d=await quickRoom(page);await d.getByRole('button',{name:'Record payment',exact:true}).click();await d.getByLabel('Payment method',{exact:true}).selectOption('cash');
 await d.getByLabel('Amount',{exact:true}).fill('250');await d.getByLabel('Received date',{exact:true}).fill('2026-10-26');await d.getByLabel('Reference (optional)',{exact:true}).fill('SYNTHETIC-NOV-PARTIAL');
 await d.getByRole('button',{name:'Save record',exact:true}).click();await expect(d.getByRole('heading',{name:'Room collection',exact:true})).toBeVisible();
 await d.getByRole('button',{name:'Apply advance',exact:true}).click();await d.getByLabel('Rent due',{exact:true}).selectOption({index:1});await d.getByLabel('Amount',{exact:true}).fill('200');await d.getByLabel('Allocation date',{exact:true}).fill('2026-10-26');
 await d.getByRole('button',{name:'Save record',exact:true}).click();await expect(d.getByRole('heading',{name:'Room collection',exact:true})).toBeVisible();
 const obligation=d.getByRole('region',{name:'Selected room rent obligations',exact:true});await expect(obligation).toContainText('XTS 450.00');await expect(obligation).toContainText('XTS 550.00');
 await d.getByRole('button',{name:'Close rental dialog',exact:true}).click();rental=await state(page,'rental');
 expect(rental.dues).toHaveLength(1);expect(rental.collections).toHaveLength(3);expect(rental.dues[0]).toMatchObject({period:'2026-11',paidMinor:'45000',outstandingMinor:'55000',status:'partial'});
 const advance=rental.collections.find((row:{reference:string})=>row.reference==='SYNTHETIC-NOV-ADVANCE'),partial=rental.collections.find((row:{reference:string})=>row.reference==='SYNTHETIC-NOV-PARTIAL');
 expect(advance).toMatchObject({receivedDate:'2026-10-26',availableAdvanceMinor:'10000'});expect(partial.receivedDate).toBe('2026-10-26');expect(rental.summary.currencies[0].depositMinor).toBe('50000');
 await nav(page,'Staff Collections');await page.getByRole('button',{name:'Add collector',exact:true}).click();d=page.getByRole('dialog');await d.getByLabel('Collector name',{exact:true}).fill(collectorName);await save(d);
 await page.getByRole('button',{name:'Add company account',exact:true}).click();d=page.getByRole('dialog');await d.getByLabel('Account name',{exact:true}).fill('SYNTHETIC November company cash');await d.getByLabel('Account type',{exact:true}).selectOption('cash');
 await d.getByLabel('Currency',{exact:true}).fill('XTS');await d.getByLabel('Opening balance date',{exact:true}).fill('2026-10-01');await d.getByLabel('Owner-confirmed opening balance',{exact:true}).fill('0');
 await d.getByLabel('I confirm this account’s opening amount and date, including an explicit zero if appropriate.',{exact:true}).check();await save(d);
 const staffBefore=await state(page,'staff-collections'),companyBefore=await state(page,'company-finance'),collectorId=staffBefore.collectors[0].id,accountId=companyBefore.accounts[0].id;
 await page.getByRole('button',{name:'Link collected receipt',exact:true}).click();d=page.getByRole('dialog');await d.getByLabel('Collector',{exact:true}).selectOption(collectorId);await d.getByLabel('Original receipt',{exact:true}).selectOption('property-rent:'+partial.id);await d.getByLabel('Where is the money?',{exact:true}).selectOption('collector-held');await d.getByLabel('I confirm where this receipt is held.',{exact:true}).check();await save(d);
 await page.getByRole('button',{name:'Record handover',exact:true}).click();d=page.getByRole('dialog');await d.getByLabel('Collector',{exact:true}).selectOption(collectorId);await d.getByLabel('Company cash / bank account',{exact:true}).selectOption(accountId);await d.getByLabel('Handover amount',{exact:true}).fill('100');await d.getByLabel('Handover date',{exact:true}).fill('2026-10-26');await d.getByLabel('New unique handover reference',{exact:true}).fill('SYNTHETIC-NOV-HANDOVER');await save(d);
 expect((await state(page,'staff-collections')).totals[0].balance).toBe('150');
 let company=await state(page,'company-finance');expect(company.totals[0]).toMatchObject({balance:'100',receipts:'0',transfersIn:'100'});
 await nav(page,'Company Finance');await page.getByRole('button',{name:'Receive existing receipt',exact:true}).click();d=page.getByRole('dialog');await d.getByLabel('Account',{exact:true}).selectOption(accountId);await d.getByLabel('Original receipt',{exact:true}).selectOption('property-rent:'+advance.id);await d.getByLabel('I confirm this receipt was actually received into the selected account.',{exact:true}).check();await save(d);
 company=await state(page,'company-finance');expect(company.totals[0]).toMatchObject({balance:'400',receipts:'300',transfersIn:'100'});expect((await state(page,'personal-finance')).accounts).toHaveLength(0);
 await page.getByRole('button',{name:'Receive existing receipt',exact:true}).click();d=page.getByRole('dialog');await expect(d.getByLabel('Original receipt',{exact:true}).locator('option[value="property-rent:'+advance.id+'"]')).toHaveCount(0);await expect(d.getByLabel('Original receipt',{exact:true}).locator('option[value="property-rent:'+partial.id+'"]')).toHaveCount(0);await d.getByRole('button',{name:'Cancel',exact:true}).click();
 await dashboard(page);await page.reload();await expect(page.getByRole('link',{name:/Total Collected:.*450\.00/})).toBeVisible();await expect(page.getByRole('link',{name:/Company Cash in Hand:.*400\.00/})).toBeVisible();
 await nav(page,'Reports');await page.getByLabel('Expense month',{exact:true}).fill('2026-11');await page.getByLabel('Report through',{exact:true}).fill('2026-10-26');await page.getByRole('button',{name:'Apply expense filters',exact:true}).click();
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download monthly CSV',exact:true}).click();const download=await downloaded;expect(download.suggestedFilename()).toBe('HAMDEE-operations-2026-11.csv');const csv=await readFile((await download.path())!,'utf8');
 expect(csv).toContain('"'+propertyName+'","XTS","1000.00","450.00","550.00","0.00","0.00","450.00","500.00","100.00"');
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Welcome to HAMDEE',exact:true})).toBeVisible();await page.goBack();await expect(page.getByRole('heading',{name:'Welcome to HAMDEE',exact:true})).toBeVisible();await expect(page.locator('body')).not.toContainText(propertyName);
 expect((await page.request.get(server.url+'/api/hamdee/v1/properties')).status()).toBe(401);await login(page);await dashboard(page);
 await nav(page,'Villas & Properties');await page.getByRole('button',{name:propertyName,exact:true}).click();expect(page.url()).toContain('#properties/'+propertyId);await page.getByRole('button',{name:'Rooms & rentals',exact:true}).click();await expect(page.getByRole('region',{name:'Tenant register',exact:true})).toContainText(tenantName);
 expect((await state(page,'rental')).collections).toHaveLength(3);expect((await state(page,'company-finance')).totals[0].balance).toBe('400');expect((await state(page,'staff-collections')).totals[0].balance).toBe('150');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();expect(pageErrors).toEqual([]);await page.screenshot({path:`evidence/final-november/${info.project.name}-persistent-november-workflow.png`,fullPage:true});
});
