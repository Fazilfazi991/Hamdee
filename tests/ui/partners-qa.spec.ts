import { test,expect,type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';

let server:Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(90_000);
test.beforeEach(async()=>{server=await startOwnerBrowserHarness({migrationFiles:['008_local_partner_records.up.sql']});});
test.afterEach(async()=>{await server.close();});
async function login(page:Page){
  await page.goto(server.url+'/workspace/index.html');
  await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);
  await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Property overview',exact:true})).toBeVisible();
  await expect(page.locator('#navigation a[href="#partners"]')).toHaveCount(1);
}
async function partners(page:Page){
  const menu=page.getByRole('button',{name:'Open navigation',exact:true});
  if(await menu.isVisible())await menu.click();
  await page.getByRole('link',{name:'Partners & Investments',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Partner contacts',exact:true})).toBeVisible();
}
async function command(body:Record<string,unknown>){
  const response=await server.fixture.request('POST','/api/hamdee/v1/partners/commands',body,{'Idempotency-Key':randomUUID()});
  expect(response.status).toBe(201);return (await response.json()).data;
}

test('Independent integrated owner partners: exact separate currencies, safe CSV, mobile draft and logout cleanup',async({page})=>{
  await server.fixture.login();
  const response=await server.fixture.request('POST','/api/hamdee/v1/properties',{name:'=SYNTHETIC property'},{'Idempotency-Key':randomUUID()});
  expect(response.status).toBe(201);const property=(await response.json()).data;
  const partner=await command({action:'create-partner',name:'=SYNTHETIC <img src=x>'});
  await command({action:'link-property',propertyId:property.id,partnerId:partner.id});
  const movement={action:'record-entry',propertyId:property.id,partnerId:partner.id,kind:'contribution',entryDate:'2026-10-01',amount:'9007199254740993.123456789012',currency:'XTS'};
  await command(movement);await command({...movement,kind:'withdrawal',amount:'0.000000000001'});
  await command({...movement,amount:'2',currency:'INR'});
  await login(page);await partners(page);
  await page.getByLabel('Movement month',{exact:true}).fill('2026-10');
  await page.getByLabel('Through date',{exact:true}).fill('2026-10-31');
  await page.getByRole('button',{name:'Apply statement filters',exact:true}).click();
  const totals=page.getByRole('region',{name:'Separate currency totals',exact:true});
  await expect(totals).toContainText('9007199254740993.123456789011');
  await expect(totals).toContainText('XTS');await expect(totals).toContainText('INR');
  await expect(totals.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByRole('region',{name:'Partner contact register',exact:true})).toContainText('=SYNTHETIC <img src=x>');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download monthly summary',exact:true}).click();
  const csv=await readFile((await (await pending).path())!,'utf8');
  expect(csv).toContain('"\'=SYNTHETIC property"');expect(csv).toContain('"\'=SYNTHETIC <img src=x>"');
  expect(csv).toContain('9007199254740993.123456789011');
  expect(csv).toContain('Net recorded movements (not profit or available cash)');
  await page.getByRole('button',{name:'Add partner contact',exact:true}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  const bounds=await dialog.boundingBox();expect(bounds).not.toBeNull();expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByLabel('Partner name',{exact:true}).fill('SYNTHETIC cancelled private draft');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
  await expect(page.locator('#navigation a[href="#partners"]')).toHaveCount(0);
  await expect(page.locator('#main')).not.toContainText('9007199254740993.123456789011');
  await expect(page.locator('body')).not.toContainText('SYNTHETIC cancelled private draft');
});

test('Independent integrated owner partners: live provider denial clears a pending contact draft without committing it',async({page})=>{
  await login(page);await partners(page);
  await page.getByRole('button',{name:'Add partner contact',exact:true}).click();
  await page.getByLabel('Partner name',{exact:true}).fill('SYNTHETIC denied private draft');
  server.fixture.fake.facts.emailConfirmed=false;
  await page.getByRole('button',{name:'Save partner record',exact:true}).click();
  await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByLabel('Partner name',{exact:true})).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('SYNTHETIC denied private draft');
  await expect(page.locator('#navigation a[href="#partners"]')).toHaveCount(0);
  const stored=(await server.fixture.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partners')).rows[0].n;
  expect(stored).toBe(0);
});
