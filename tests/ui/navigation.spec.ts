import {test as base,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startOwnerBrowserHarness} from '../support/owner-crm-harness';
import {StaffCollectionsService} from '../../src/staff-collections';
import {CompanyFinanceService} from '../../src/company-finance';
import {seedPropertyReceipt} from '../support/staff-qa-fixture';

const test=base.extend<{operationsEnabled:boolean}>({operationsEnabled:[false,{option:true}]});
let server:Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(120_000);
test.beforeEach(async({operationsEnabled})=>{
  server=await startOwnerBrowserHarness(operationsEnabled?{migrationFiles:['006_local_operations_records.up.sql'],operationsFactory:properties=>({staffCollections:new StaffCollectionsService(properties),companyFinance:new CompanyFinanceService(properties)})}:{});
  await mkdir('evidence/navigation/screenshots',{recursive:true});
});
test.afterEach(async()=>{await server?.close();});
async function login(page:Page){await page.goto(server.url+'/workspace/index.html');await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Property overview',exact:true})).toBeVisible();}
async function nav(page:Page,name:string){const menu=page.getByRole('button',{name:'Open navigation',exact:true});if(await menu.isVisible())await menu.click();await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('link',{name,exact:true}).click();}
async function createVilla(page:Page){await nav(page,'Villas & Properties');await page.getByRole('button',{name:'Add property',exact:true}).click();await page.getByLabel('Property name',{exact:true}).fill('Synthetic navigation villa');await page.getByRole('button',{name:'Save property',exact:true}).click();await expect(page.getByRole('heading',{name:'Synthetic navigation villa',exact:true})).toBeVisible();return page.url().split('#properties/')[1];}
async function post(path:string,body:Record<string,unknown>){const response=await server.fixture.request('POST','/api/hamdee/v1/'+path,body,{'Idempotency-Key':randomUUID()});expect(response.ok).toBeTruthy();return (await response.json()).data;}
const mainNav=(page:Page)=>page.getByRole('navigation',{name:'Main navigation',exact:true});
const orderedNames=['Dashboard','Villas & Properties','Car Rentals','Staff Collections','Expenses','Company Finance','Personal Finance','Partners & Investments','Reports'];
async function sidebarNames(page:Page,names:string[]){const menu=page.getByRole('button',{name:'Open navigation',exact:true}),mobile=await menu.isVisible();if(mobile)await menu.click();await expect(mainNav(page).locator('.nav-link>span')).toHaveText(orderedNames);await expect(mainNav(page).getByRole('link')).toHaveText(names);for(const label of orderedNames.filter(label=>!names.includes(label))){const control=mainNav(page).getByRole('button').filter({has:page.locator('span').filter({hasText:new RegExp('^'+label+'$')})});await expect(control).toHaveCount(1);await expect(control).not.toHaveAttribute('href');if((await control.textContent())?.includes('Retry'))await expect(control).toHaveAttribute('data-action','retry-modules');else await expect(control).toBeDisabled();}if(mobile)await page.getByRole('button',{name:'Close navigation',exact:true}).click();}

test('core sidebar exposes working destinations and legacy hashes still load',async({page},info)=>{
  const errors:string[]=[],receiptRequests:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/staff-collections/receipts'))receiptRequests.push(request.url());});
  const unavailable=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/hamdee/v1/staff-collections');await login(page);expect((await unavailable).status()).toBe(503);
  await sidebarNames(page,['Dashboard','Villas & Properties','Expenses','Reports']);expect(receiptRequests).toHaveLength(0);
  const id=await createVilla(page);await expect(page.getByRole('button',{name:'Partners',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Funding',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Back to properties',exact:true}).click();await expect(page.getByRole('heading',{name:'Properties',exact:true})).toBeVisible();await page.getByRole('button',{name:'Synthetic navigation villa',exact:true}).click();expect(page.url()).toContain('#properties/'+id);
  await nav(page,'Expenses');await expect(page.getByRole('heading',{name:'Property expenses',level:1,exact:true})).toBeVisible();await expect(page.locator('#main')).toHaveAttribute('aria-busy','false');await nav(page,'Reports');await expect(page.getByRole('heading',{name:'Monthly property report',level:1,exact:true})).toBeVisible();await expect(page.locator('#main')).toHaveAttribute('aria-busy','false');
  for(const alias of ['tenants','collections','cheques']){await page.goto(server.url+'/workspace/index.html#'+alias);await expect(page.getByRole('heading',{name:'Rooms & units',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Add tenant',exact:true})).toBeVisible();}
  await page.goto(server.url+'/workspace/index.html#maintenance');await expect(page.getByRole('heading',{name:'Maintenance jobs',exact:true})).toBeVisible();
  await nav(page,'Villas & Properties');await expect(page.getByRole('heading',{name:'Properties',exact:true})).toBeVisible();await expect(page.locator('#main')).toHaveAttribute('aria-busy','false');await page.screenshot({path:`evidence/navigation/screenshots/${info.project.name}-core-sidebar.png`});expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('villa section routes preserve records, cutoff, Back and direct-link behavior',async({page},info)=>{
  const f=server.fixture,source=await seedPropertyReceipt(f,{amount:'100.00'}),other=await seedPropertyReceipt(f,{amount:'20.00'});
  await post('rental',{action:'record-collection',agreementId:source.agreement.id,kind:'deposit',method:'bank',amount:'5.00',receivedDate:'2026-10-10',reference:'SYNTHETIC-NAV-DEPOSIT'});
  await post('rental',{action:'record-collection',agreementId:source.agreement.id,kind:'rent',method:'cheque',amount:'7.00',receivedDate:'2026-10-10',reference:'SYNTHETIC-NAV-CHEQUE',allocations:[]});
  await post('expenses',{action:'record-expense',propertyId:source.property.id,category:'landlord',expenseDate:'2026-10-07',amount:'12.00',currency:'QAR',vendorName:'Synthetic navigation landlord'});
  await post('expenses',{action:'record-expense',propertyId:source.property.id,category:'wifi_utilities',expenseDate:'2026-10-08',amount:'3.00',currency:'QAR',vendorName:'Synthetic navigation utility'});
  await post('expenses',{action:'create-job',propertyId:source.property.id,workType:'Synthetic service',issue:'Synthetic navigation maintenance',openedDate:'2026-10-09',vendorName:'Synthetic navigation vendor',vendorContact:'Synthetic contact'});
  await login(page);await nav(page,'Villas & Properties');await page.getByRole('button',{name:source.property.name,exact:true}).click();await page.getByRole('button',{name:'Rooms & rentals',exact:true}).click();
  const rentalNav=page.getByRole('navigation',{name:'Villa rental sections',exact:true});await expect(rentalNav.getByRole('link')).toHaveText(['All rentals','Rooms','Tenants','Agreements','Collections','Cheques','Deposits']);
  await page.getByLabel('Rent month',{exact:true}).fill('2026-10');await page.getByLabel('Occupancy / balance date',{exact:true}).fill('2026-10-16');await page.getByRole('button',{name:'Apply rental filters',exact:true}).click();
  await rentalNav.getByRole('link',{name:'Rooms',exact:true}).click();await expect(page.getByRole('heading',{name:'Rooms & units',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Tenants',exact:true})).not.toBeVisible();await expect(page.getByRole('region',{name:'Rooms and occupancy',exact:true})).not.toContainText(other.property.name);
  await page.getByLabel('Occupancy / balance date',{exact:true}).fill('2026-10-15');await page.getByRole('button',{name:'Apply rental filters',exact:true}).click();
  await rentalNav.getByRole('link',{name:'Tenants',exact:true}).click();await expect(page.getByRole('heading',{name:'Tenants',exact:true})).toBeVisible();await expect(page.getByLabel('Occupancy / balance date',{exact:true})).toHaveValue('2026-10-15');
  await rentalNav.getByRole('link',{name:'Agreements',exact:true}).click();await expect(page.getByRole('heading',{name:'Rental agreements',exact:true})).toBeVisible();await page.goBack();await expect(rentalNav.getByRole('link',{name:'Tenants',exact:true})).toHaveAttribute('aria-current','page');
  await rentalNav.getByRole('link',{name:'Cheques',exact:true}).click();await expect(page.getByRole('region',{name:'Collection register',exact:true})).toContainText('SYNTHETIC-NAV-CHEQUE');await expect(page.getByRole('region',{name:'Collection register',exact:true})).not.toContainText('SYNTHETIC-NAV-DEPOSIT');
  await rentalNav.getByRole('link',{name:'Deposits',exact:true}).click();await expect(page.getByRole('region',{name:'Collection register',exact:true})).toContainText('SYNTHETIC-NAV-DEPOSIT');await expect(page.getByRole('button',{name:'Refund deposit',exact:true})).toBeVisible();
  await page.reload();await expect(rentalNav.getByRole('link',{name:'Deposits',exact:true})).toHaveAttribute('aria-current','page');
  await page.getByRole('button',{name:'Expenses & maintenance',exact:true}).click();const expensesNav=page.getByRole('navigation',{name:'Villa expense sections',exact:true});await expensesNav.getByRole('link',{name:'Landlord payments',exact:true}).click();await expect(page.getByRole('region',{name:'Property expense register',exact:true})).toContainText('Synthetic navigation landlord');await expect(page.getByRole('region',{name:'Property expense register',exact:true})).not.toContainText('Synthetic navigation utility');
  await expensesNav.getByRole('link',{name:'Utilities',exact:true}).click();await expect(page.getByRole('region',{name:'Property expense register',exact:true})).toContainText('Synthetic navigation utility');
  await expensesNav.getByRole('link',{name:'Maintenance',exact:true}).click();await expect(page.getByRole('region',{name:'Maintenance job register',exact:true})).toContainText('Synthetic navigation vendor');await page.screenshot({path:`evidence/navigation/screenshots/${info.project.name}-villa-maintenance.png`,fullPage:true});
  await page.getByRole('button',{name:'Audit history',exact:true}).click();await expect(page.getByRole('region',{name:'Property audit history',exact:true})).toBeVisible();await page.reload();await expect(page.getByRole('region',{name:'Property audit history',exact:true})).toBeVisible();
  await page.goto(server.url+'/workspace/index.html#properties/'+source.property.id+'/collections');await expect(page.getByRole('heading',{name:'Monthly rent dues',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'Collection register',exact:true})).toContainText(source.collection.reference);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('keyboard skip and mobile drawer preserve route and return focus',async({page},info)=>{
  await login(page);const hash=new URL(page.url()).hash;await page.getByRole('link',{name:'Skip to workspace',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.locator('#main')).toBeFocused();expect(new URL(page.url()).hash).toBe(hash);
  const menu=page.getByRole('button',{name:'Open navigation',exact:true});
  if(await menu.isVisible()){
    await menu.focus();await page.keyboard.press('Enter');await expect(menu).toHaveAttribute('aria-expanded','true');await expect(mainNav(page).getByRole('link',{name:'Dashboard',exact:true})).toBeFocused();await mainNav(page).getByRole('link',{name:'Reports',exact:true}).focus();await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Hamdee dashboard',exact:true})).toBeFocused();
    await page.screenshot({path:`evidence/navigation/screenshots/${info.project.name}-drawer.png`});await page.keyboard.press('Escape');await expect(menu).toBeFocused();await expect(menu).toHaveAttribute('aria-expanded','false');
    await page.keyboard.press('Enter');await mainNav(page).getByRole('link',{name:'Villas & Properties',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Properties',exact:true})).toBeVisible();await expect(menu).toHaveAttribute('aria-expanded','false');await expect(page.locator('#main')).toBeFocused();
  }else{await mainNav(page).getByRole('link',{name:'Villas & Properties',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Properties',exact:true})).toBeVisible();await expect(page.locator('#main')).toBeFocused();}
});

test('focused villa tenants include its agreement history while global contacts and picker stay complete',async({page},info)=>{
  const a=await seedPropertyReceipt(server.fixture,{amount:'10.00'}),b=await seedPropertyReceipt(server.fixture,{amount:'20.00'});
  await post('rental',{action:'update-tenant',tenantId:a.tenant.id,expectedVersion:a.tenant.version,name:'Synthetic villa A current tenant'});
  await post('rental',{action:'update-tenant',tenantId:b.tenant.id,expectedVersion:b.tenant.version,name:'Synthetic villa B tenant'});
  const former=await post('rental',{action:'create-tenant',name:'Synthetic villa A historical tenant'});
  await post('rental',{action:'create-tenant',name:'Synthetic unassigned owner contact'});
  await post('rental',{action:'create-agreement',roomId:a.room.id,tenantId:former.id,monthlyRent:'1000.00',currency:'QAR',depositRequired:'0.00',dueTerms:'Explicit historical agreement',startDate:'2026-09-01',endDate:'2026-09-30'});
  await login(page);await page.goto(server.url+'/workspace/index.html#properties/'+a.property.id+'/tenants');
  const tenants=page.getByRole('region',{name:'Tenant register',exact:true});await expect(tenants).toContainText('Synthetic villa A current tenant');await expect(tenants).toContainText('Synthetic villa A historical tenant');await expect(tenants).not.toContainText('Synthetic villa B tenant');await expect(tenants).not.toContainText('Synthetic unassigned owner contact');
  await page.screenshot({path:`evidence/navigation/screenshots/${info.project.name}-villa-tenant-scope.png`});
  await page.getByRole('navigation',{name:'Villa rental sections',exact:true}).getByRole('link',{name:'Agreements',exact:true}).click();await page.getByRole('button',{name:'Add agreement',exact:true}).click();const dialog=page.getByRole('dialog');
  await expect(dialog.getByLabel('Tenant',{exact:true}).locator('option')).toHaveCount(5);expect((await dialog.getByLabel('Tenant',{exact:true}).locator('option').allTextContents()).sort()).toEqual(['Choose…','Synthetic villa A current tenant','Synthetic villa B tenant','Synthetic villa A historical tenant','Synthetic unassigned owner contact'].sort());
  await dialog.getByLabel('Tenant',{exact:true}).selectOption(b.tenant.id);await expect(dialog.getByLabel('Tenant',{exact:true})).toHaveValue(b.tenant.id);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('navigation',{name:'Villa rental sections',exact:true}).getByRole('link',{name:'All rentals',exact:true}).click();await expect(tenants).toContainText('Synthetic villa B tenant');await expect(tenants).toContainText('Synthetic unassigned owner contact');
  await page.goto(server.url+'/workspace/index.html#tenants');await expect(tenants).toContainText('Synthetic villa A current tenant');await expect(tenants).toContainText('Synthetic villa A historical tenant');await expect(tenants).toContainText('Synthetic villa B tenant');await expect(tenants).toContainText('Synthetic unassigned owner contact');
});

test('choosing the current sidebar destination closes the drawer and focuses usable content',async({page})=>{
  await login(page);await nav(page,'Villas & Properties');await expect(page.getByRole('heading',{name:'Properties',exact:true})).toBeVisible();const before=page.url();
  await nav(page,'Villas & Properties');await expect(page.locator('.workspace')).toHaveJSProperty('inert',false);expect(page.url()).toBe(before);
  const menu=page.getByRole('button',{name:'Open navigation',exact:true});if(await menu.isVisible())await expect(menu).toHaveAttribute('aria-expanded','false');await expect(page.locator('#main')).toBeFocused();
  await page.getByRole('button',{name:'Add property',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Cancel',exact:true}).click();
});

test.describe('Actual local006 readiness',()=>{
  test.use({operationsEnabled:true});
  test('Staff appears only after real service readiness and its workflow works',async({page},info)=>{
    let receiptReads=0;page.on('request',request=>{if(request.url().includes('/staff-collections/receipts'))receiptReads++;});await login(page);const menu=page.getByRole('button',{name:'Open navigation',exact:true});if(await menu.isVisible())await menu.click();await expect(mainNav(page).getByRole('link',{name:'Staff Collections',exact:true})).toBeVisible();if(await menu.isVisible())await page.getByRole('button',{name:'Close navigation',exact:true}).click();await sidebarNames(page,['Dashboard','Villas & Properties','Staff Collections','Expenses','Reports']);expect(receiptReads).toBe(0);
    await nav(page,'Staff Collections');await expect(page.getByRole('region',{name:'Collector register',exact:true})).toBeVisible();await page.getByRole('button',{name:'Add collector',exact:true}).click();await page.getByLabel('Collector name',{exact:true}).fill('Synthetic navigation collector');await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('region',{name:'Collector register',exact:true})).toContainText('Synthetic navigation collector');
    await page.screenshot({path:`evidence/navigation/screenshots/${info.project.name}-staff-ready.png`,fullPage:true});await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByLabel('Email',{exact:true})).toBeVisible();await expect(page.locator('#navigation a[href="#staff-collections"]')).toHaveCount(0);await expect(page.locator('#navigation button').filter({hasText:'Staff Collections'})).toBeDisabled();
  });
  test('late service readiness cannot add Staff after logout',async({page})=>{
    let release!:()=>void,entered!:()=>void,delivered!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;}),settled=new Promise<void>(resolve=>{delivered=resolve;});
    await page.route('**/api/hamdee/v1/staff-collections?*',async route=>{const response=await route.fetch();entered();await hold;try{await route.fulfill({response});}catch{/* Expected when logout aborts the read. */}finally{delivered();}});
    await login(page);await ready;await expect(page.locator('#navigation a[href="#staff-collections"]')).toHaveCount(0);await expect(page.locator('#navigation button').filter({hasText:'Staff Collections'})).toBeDisabled();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByLabel('Email',{exact:true})).toBeVisible();release();await settled;await expect(page.locator('#navigation a[href="#staff-collections"]')).toHaveCount(0);await expect(page.locator('#navigation button').filter({hasText:'Staff Collections'})).toBeDisabled();await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
  });
});
