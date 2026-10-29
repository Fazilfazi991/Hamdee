import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';

let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(90_000);
test.beforeEach(async () => { server = await startOwnerBrowserHarness({migrationFiles:['011_local_owner_occupancy.up.sql']}); await mkdir('evidence/rental-qa', { recursive: true }); });
test.afterEach(async () => { await server?.close(); });
async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html#dashboard');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();
}
async function nav(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true }); if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name, exact: true }).click();
}
async function addProperty(page: Page) {
  await nav(page, 'Villas & Properties'); await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill('Synthetic Rental Browser Villa');
  await page.getByRole('button', { name: 'Save property', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Rental Browser Villa', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rooms & rentals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rooms & units', exact: true })).toBeVisible();await openAllRentals(page);
}
async function openAllRentals(page: Page) { const id = new URL(page.url()).hash.split('/')[1]; await page.goto(server.url+'/workspace/index.html#properties/'+id+'/rental'); await expect(page.getByRole('heading',{name:'Rooms & units',exact:true})).toBeVisible(); }
async function open(page: Page, name: string) { await page.getByRole('button', { name, exact: true }).first().click(); return page.locator('#rental-dialog'); }
async function save(dialog: Locator) { await dialog.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(dialog).not.toBeVisible(); }
async function room(page: Page, code: string) { const d = await open(page, 'Add room'); await d.getByLabel('Room code', { exact: true }).fill(code); await save(d); }
async function prepareRoomAgreement(page: Page) {
  await addProperty(page); await room(page, 'QA-R01'); await room(page, 'QA-R02');
  let d = await open(page, 'Add tenant'); await d.getByLabel('Tenant name', { exact: true }).fill('Synthetic Browser Tenant');
  await d.getByLabel('Phone (optional)', { exact: true }).fill('+00000000000');
  await d.getByLabel('Email (optional)', { exact: true }).fill('tenant-browser@example.invalid');
  await d.getByLabel('Notes (optional)', { exact: true }).fill('Synthetic <img src=x onerror=alert(1)>'); await save(d);
  d = await open(page, 'Add agreement');
  await d.getByLabel('Room / unit', { exact: true }).selectOption({ label: 'Synthetic Rental Browser Villa · QA-R01' });
  await d.getByLabel('Tenant', { exact: true }).selectOption({ label: 'Synthetic Browser Tenant' });
  await d.getByLabel('Monthly rent', { exact: true }).fill('1000.00'); await expect(d.locator('input[name=currency]')).toHaveValue('QAR');
  await d.getByLabel('Due-date terms', { exact: true }).fill('Explicit amount due on owner-entered date');
  await d.getByLabel('Security deposit required', { exact: true }).fill('500.00');
  await d.getByLabel('Agreement start date', { exact: true }).fill('2026-10-01'); await save(d);
  await page.getByLabel('Rent month', { exact: true }).fill('2026-10');
  await page.getByLabel('Occupancy / balance date', { exact: true }).fill('2026-10-15');
  await page.getByRole('button', { name: 'Apply rental filters', exact: true }).click();
  d = await open(page, 'Issue monthly due');
  await d.getByLabel('Room / unit', { exact: true }).selectOption({ label: 'Synthetic Rental Browser Villa · QA-R01' }); await d.getByLabel('Tenant', { exact: true }).selectOption({ label: 'Synthetic Browser Tenant' });
  await d.getByLabel('Rent month', { exact: true }).fill('2026-10'); await d.getByLabel('Exact due date', { exact: true }).fill('2026-10-05');
  await d.getByLabel('Amount', { exact: true }).fill('1000.00'); await save(d);
}
async function collect(page: Page, purpose: string, method: string, amount: string) {
  if (purpose === 'Rent' && method !== 'Cheque (pending only)') await page.getByRole('region',{name:'Monthly rent dues',exact:true}).getByRole('button',{name:'Collect rent',exact:true}).first().click(); else await page.getByRole('button',{name:'Record collection',exact:true}).first().click();
  const d=page.locator('#rental-dialog'); await d.getByLabel('Room / unit',{exact:true}).selectOption({label:'Synthetic Rental Browser Villa · QA-R01'}); await d.getByLabel('Tenant',{exact:true}).selectOption({label:'Synthetic Browser Tenant'}); await d.getByLabel('Rental month',{exact:true}).fill('2026-10');
  await d.getByLabel('Collection purpose', { exact: true }).selectOption({ label: purpose });
  await d.getByLabel('Payment method', { exact: true }).selectOption({ label: method });
  await d.getByLabel('Amount', { exact: true }).fill(amount); await d.getByLabel('Received date', { exact: true }).fill('2026-10-10');
  await d.getByLabel('Reference (optional)', { exact: true }).fill('SYNTHETIC-' + method.toUpperCase());
  await save(d);
}

test('Rental UI QA: full owner room/tenant/agreement/due/partial collection workflow and saved dashboard', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); await prepareRoomAgreement(page);
  const occupancy = page.getByRole('region', { name: 'Rooms and occupancy', exact: true });
  await expect(occupancy.getByRole('cell', { name: 'Occupied', exact: true })).toHaveCount(1);
  await expect(occupancy.getByRole('cell', { name: 'Occupancy not verified', exact: true })).toHaveCount(1);
  await collect(page, 'Rent', 'Cash', '400.00');
  const dues = page.getByRole('region', { name: 'Monthly rent dues', exact: true });
  await expect(dues.getByRole('cell', { name: 'partial', exact: true })).toBeVisible();
  await expect(dues.getByRole('cell', { name: 'QAR 600.00', exact: true })).toBeVisible();
  await collect(page, 'Security deposit', 'Bank', '500.00'); await collect(page, 'Rent', 'Cheque (pending only)', '600.00');
  await expect(dues.getByRole('cell', { name: 'partial', exact: true })).toBeVisible();
  await collect(page, 'Rent', 'Bank', '600.00'); await expect(dues.getByRole('cell', { name: 'paid', exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Rooms & rentals', exact: true }).click(); await openAllRentals(page);
  // Reload restores the approved November entry default. This fixture's issued
  // due is explicitly October and must be selected to verify saved history.
  await page.getByLabel('Rent month', { exact: true }).fill('2026-10');
  await page.getByLabel('Occupancy / balance date', { exact: true }).fill('2026-10-15');
  await page.getByRole('button', { name: 'Apply rental filters', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Monthly rent dues', exact: true }).getByRole('cell', { name: 'paid', exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Rooms and occupancy', exact: true }).getByRole('row').filter({ has: page.getByRole('cell', { name: 'QA-R01', exact: true }) }).getByRole('button', { name: 'Room history', exact: true }).click();
  const history = page.locator('#rental-dialog'); await expect(history.getByRole('cell', { name: 'Synthetic Browser Tenant', exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: `evidence/rental-qa/${info.project.name}-rental-workflow.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await nav(page, 'Dashboard');
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Monthly rental summary', exact: true })).toHaveCount(0);
  await nav(page, 'Villas & Properties');
  await page.getByRole('button', { name: 'Synthetic Rental Browser Villa', exact: true }).click();
  await page.getByRole('button', { name: 'Rooms & rentals', exact: true }).click(); await openAllRentals(page);
  await page.getByLabel('Rent month', { exact: true }).fill('2026-10');
  await page.getByLabel('Occupancy / balance date', { exact: true }).fill('2026-10-15');
  await page.getByRole('button', { name: 'Apply rental filters', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Monthly rental summary', exact: true });
  await expect(summary.getByRole('cell', { name: 'QAR 1000.00', exact: true })).toHaveCount(2);
  await expect(summary.getByRole('cell', { name: 'QAR 0.00', exact: true })).toHaveCount(2);
  await expect(summary.getByRole('cell', { name: 'QAR 500.00', exact: true })).toBeVisible();
  await expect(summary.getByRole('cell', { name: 'QAR 600.00', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.rental-panel img'))).toBeNull(); expect(errors).toEqual([]);
  await page.screenshot({ path: `evidence/rental-qa/${info.project.name}-rental-dashboard.png`, fullPage: true });
});

test('Rental UI QA: duplicate code and failed save retain input; logout clears protected rental content', async ({ page }, info) => {
  await login(page); await addProperty(page); await room(page, 'QA-DUP');
  let d = await open(page, 'Add room'); await d.getByLabel('Room code', { exact: true }).fill('qa-dup');
  await d.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(d.locator('#rental-error')).toContainText(/already.*room code/i);
  await expect(d.getByLabel('Room code', { exact: true })).toHaveValue('qa-dup');
  await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  d = await open(page, 'Add tenant'); await d.getByLabel('Tenant name', { exact: true }).fill('Synthetic retained failure');
  await page.route('**/api/hamdee/v1/rental', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'text/html', body: 'PRIVATE_ERROR_MUST_NOT_APPEAR' }) : route.continue());
  await d.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(d.locator('#rental-error')).toContainText(/unreadable|retry|unavailable/i);
  await expect(d.getByLabel('Tenant name', { exact: true })).toHaveValue('Synthetic retained failure');
  await expect(page.locator('body')).not.toContainText('PRIVATE_ERROR_MUST_NOT_APPEAR');
  await page.screenshot({ path: `evidence/rental-qa/${info.project.name}-rental-error.png`, fullPage: true });
  await d.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.unroute('**/api/hamdee/v1/rental');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add room', exact: true })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'QA-DUP', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Rental CSRF recovery: expired proof preserves collection draft and requires Verify session then explicit Save', async ({ page }, info) => {
  await login(page);await prepareRoomAgreement(page);
  await page.getByRole('region',{name:'Monthly rent dues',exact:true}).getByRole('button',{name:'Collect rent',exact:true}).first().click();const d=page.locator('#rental-dialog');await d.getByLabel('Payment method',{exact:true}).selectOption('cash');await d.getByLabel('Amount',{exact:true}).fill('25.00');await d.getByLabel('Received date',{exact:true}).fill('2026-10-10');await d.getByLabel('Reference (optional)',{exact:true}).fill('SYNTHETIC-CSRF-RECOVERY');
  const draft=await d.locator('form').evaluate(form=>Object.fromEntries(new FormData(form as HTMLFormElement)));
  const writes:{body:unknown;key:string;csrf:string}[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/hamdee/v1/rental'){const headers=request.headers();writes.push({body:request.postDataJSON(),key:headers['idempotency-key'],csrf:headers['x-hamdee-csrf']});}});
  server.fixture.clock.advance(61_000);
  await d.getByRole('button',{name:'Save record',exact:true}).click();
  await expect(d.getByRole('button',{name:'Verify session',exact:true})).toBeVisible();
  expect(await d.locator('form').evaluate(form=>Object.fromEntries(new FormData(form as HTMLFormElement)))).toEqual(draft);expect(writes).toHaveLength(1);
  await expect(d.getByRole('button',{name:'Save record',exact:true})).toBeDisabled();
  await page.screenshot({path:`evidence/rental-qa/${info.project.name}-csrf-verify-action.png`,fullPage:true});
  await d.getByRole('button',{name:'Verify session',exact:true}).click();await expect(d.locator('#rental-error')).toContainText('save explicitly');
  expect(writes).toHaveLength(1);expect(await d.locator('form').evaluate(form=>Object.fromEntries(new FormData(form as HTMLFormElement)))).toEqual(draft);
  await page.screenshot({path:`evidence/rental-qa/${info.project.name}-csrf-renewed-draft.png`,fullPage:true});
  await save(d);
  expect(writes).toHaveLength(2);expect(writes[1].body).toEqual(writes[0].body);expect(writes[1].key===writes[0].key).toBeTruthy();expect(writes[1].csrf!==writes[0].csrf).toBeTruthy();
  await expect(page.getByRole('region',{name:'Collection register',exact:true}).getByRole('row').filter({hasText:'SYNTHETIC-CSRF-RECOVERY'})).toHaveCount(1);
  await expect(page.getByRole('region',{name:'Monthly rent dues',exact:true})).toContainText('QAR 975.00');
});

test('Rental CSRF recovery: uncertain commit stays frozen across rejection and failed proof renewal',async({page})=>{
  await login(page);await addProperty(page);const d=await open(page,'Add tenant');await d.getByLabel('Tenant name',{exact:true}).fill('Synthetic exact retry tenant');
  const writes:{body:unknown;key:string}[]=[];let committed=false;
  await page.route('**/api/hamdee/v1/rental',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    writes.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});
    if(!committed){const result=await route.fetch();expect(result.ok()).toBeTruthy();committed=true;await route.abort('failed');return;}
    await route.continue();
  });
  await d.getByRole('button',{name:'Save record',exact:true}).click();await expect(d.locator('#rental-error')).toContainText('same submission');await expect(d.getByLabel('Tenant name',{exact:true})).toBeDisabled();
  server.fixture.clock.advance(61_000);await d.getByRole('button',{name:'Save record',exact:true}).click();await expect(d.getByRole('button',{name:'Verify session',exact:true})).toBeVisible();await expect(d.getByLabel('Tenant name',{exact:true})).toBeDisabled();
  let failRead=true;await page.route('**/api/hamdee/auth/state',async route=>{if(failRead){failRead=false;await route.abort('failed');}else await route.continue();});
  await d.getByRole('button',{name:'Verify session',exact:true}).click();await expect(d.locator('#rental-error')).toContainText('draft is retained');await expect(d.getByRole('button',{name:'Save record',exact:true})).toBeDisabled();expect(writes).toHaveLength(2);
  await d.getByRole('button',{name:'Verify session',exact:true}).click();await expect(d.locator('#rental-error')).toContainText('save explicitly');await expect(d.getByLabel('Tenant name',{exact:true})).toBeDisabled();expect(writes).toHaveLength(2);
  await save(d);expect(writes).toHaveLength(3);expect(writes.every(write=>write.key===writes[0].key)).toBeTruthy();expect(writes.map(write=>write.body)).toEqual([writes[0].body,writes[0].body,writes[0].body]);
  await expect(page.getByRole('region',{name:'Tenant register',exact:true}).getByRole('row').filter({hasText:'Synthetic exact retry tenant'})).toHaveCount(1);
});

test('Rental CSRF recovery: logout wins over delayed proof and cannot restore a protected draft',async({page})=>{
  await login(page);await addProperty(page);const d=await open(page,'Add room');await d.getByLabel('Room code',{exact:true}).fill('SYNTHETIC-LATE-PROOF');
  let writes=0;await page.route('**/api/hamdee/v1/rental',async route=>{if(route.request().method()==='POST'){writes++;await route.fulfill({status:403,json:{error:{code:'CSRF_REJECTED',message:'Verify session before retrying.'}}});}else await route.continue();});
  await d.getByRole('button',{name:'Save record',exact:true}).click();await expect(d.getByRole('button',{name:'Verify session',exact:true})).toBeVisible();
  let release!:()=>void,entered!:()=>void,delivered!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;}),settled=new Promise<void>(resolve=>{delivered=resolve;});let delayed=false;
  await page.route('**/api/hamdee/auth/state',async route=>{
    if(delayed){await route.continue();return;}delayed=true;
    const response=await route.fetch();entered();await hold;
    // Logout aborts this stale read. Delivery may therefore be rejected by the
    // browser; either outcome must leave the cleared UI signed out.
    try{await route.fulfill({response});}catch{/* Expected for an aborted stale read. */}finally{delivered();}
  });
  await d.getByRole('button',{name:'Verify session',exact:true}).click();await ready;await expect(d.getByRole('button',{name:'Save record',exact:true})).toBeDisabled();
  const second=await page.context().newPage();
  try{
    await second.goto(server.url+'/workspace/index.html#dashboard');await expect(second.getByRole('heading',{name:'Business Overview',exact:true})).toBeVisible();await second.getByRole('button',{name:'Sign out',exact:true}).click();await expect(second.getByLabel('Email',{exact:true})).toBeVisible();
    await page.evaluate(()=>{window.location.hash='dashboard';});await expect(page.getByLabel('Email',{exact:true})).toBeVisible();release();await settled;
    await expect(d).not.toBeVisible();await expect(page.locator('body')).not.toContainText('SYNTHETIC-LATE-PROOF');expect(writes).toBe(1);await page.reload();await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
  }finally{release();await second.close();}
});
