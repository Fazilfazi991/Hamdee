import {test,expect,type Page} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import {startOwnerBrowserHarness} from '../support/owner-crm-harness';
let server:Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(90_000);
test.beforeEach(async()=>{server=await startOwnerBrowserHarness({migrationFiles:['008_local_partner_records.up.sql']});await mkdir('evidence/partner-ui',{recursive:true});});
test.afterEach(async()=>{await server?.close();});
async function login(page:Page){await page.goto(server.url+'/workspace/index.html');await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Property overview',exact:true})).toBeVisible();}
async function save(page:Page){const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Save partner record',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(page.getByRole('status').filter({hasText:'Partner record saved.'})).toBeVisible();}
async function partners(page:Page){const mobile=page.getByRole('button',{name:'Open navigation',exact:true});if(await mobile.isVisible())await mobile.click();await page.getByRole('link',{name:'Partners & Investments',exact:true}).click();await expect(page.getByRole('heading',{name:'Partner contacts',exact:true})).toBeVisible();}

test('managed owner creates contact, property link, exact dated movements and CSV, then refreshes and signs in anew',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await login(page);
  await page.getByRole('button',{name:'Add property',exact:true}).click();await page.getByLabel('Property name',{exact:true}).fill('Synthetic partner project');await page.getByRole('button',{name:'Save property',exact:true}).click();await expect(page.getByRole('heading',{name:'Synthetic partner project',exact:true})).toBeVisible();
  await partners(page);await page.getByRole('button',{name:'Add partner contact',exact:true}).click();await page.getByLabel('Partner name',{exact:true}).fill('Synthetic partner contact');await page.getByLabel('Phone (optional)',{exact:true}).fill('TEST-ONLY');await page.getByLabel('Email (optional)',{exact:true}).fill('partner@example.invalid');await save(page);
  await page.getByRole('button',{name:'Link partner to property',exact:true}).click();await page.getByLabel('Property',{exact:true}).last().selectOption({label:'Synthetic partner project'});await page.getByLabel('Partner',{exact:true}).selectOption({label:'Synthetic partner contact'});await save(page);
  const today=new Date().toISOString().slice(0,10);
  for(const [kind,amount,currency] of [['contribution','9007199254740993.123456789012','XTS'],['withdrawal','2.123456789012','XTS'],['contribution','7','AED']]){
    await page.getByRole('button',{name:'Record contribution / withdrawal',exact:true}).click();await page.getByLabel('Property',{exact:true}).last().selectOption({label:'Synthetic partner project'});await page.getByLabel('Partner',{exact:true}).selectOption({label:'Synthetic partner contact'});await page.getByLabel('Recorded movement',{exact:true}).selectOption(kind);await page.getByLabel('Movement date',{exact:true}).fill(today);await page.getByLabel('Exact recorded amount',{exact:true}).fill(amount);await page.getByLabel('Explicit currency code',{exact:true}).fill(currency);await save(page);
  }
  const totals=page.getByRole('region',{name:'Separate currency totals',exact:true});await expect(totals).toContainText('9007199254740991');await expect(totals).toContainText('AED');await expect(page.getByRole('region',{name:'Partner movement history',exact:true}).locator('tbody tr')).toHaveCount(3);
  const download=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download monthly summary',exact:true}).click()]);const csv=await readFile((await download[0].path())!,'utf8');expect(csv).toContain('9007199254740991');expect(csv).toContain('Synthetic partner project');expect(csv).toContain('XTS');expect(csv).toContain('AED');
  await page.reload();await expect(page.getByRole('region',{name:'Partner movement history',exact:true}).locator('tbody tr')).toHaveCount(3);await page.screenshot({path:`evidence/partner-ui/${info.project.name}-partner-ledger.png`,fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Sign-in required',exact:true})).toBeVisible();expect(await page.locator('#main').textContent()).not.toContain('Synthetic partner contact');expect((await page.request.get(server.url+'/api/hamdee/v1/partners?month='+today.slice(0,7)+'&asOf='+today)).status()).toBe(401);
  await login(page);await partners(page);await expect(page.getByRole('region',{name:'Partner movement history',exact:true}).locator('tbody tr')).toHaveCount(3);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();expect(errors).toEqual([]);
});

test('contact form keeps draft after expired CSRF, renews proof explicitly and stays mobile keyboard usable',async({page})=>{
  await login(page);await partners(page);await page.getByRole('button',{name:'Add partner contact',exact:true}).click();await page.getByLabel('Partner name',{exact:true}).fill('Synthetic retained contact');server.fixture.clock.advance(60_001);
  await page.getByRole('button',{name:'Save partner record',exact:true}).click();await expect(page.getByRole('button',{name:'Verify session',exact:true})).toBeVisible();await expect(page.getByLabel('Partner name',{exact:true})).toHaveValue('Synthetic retained contact');await page.getByRole('button',{name:'Verify session',exact:true}).click();await expect(page.getByRole('alert')).toContainText('save explicitly');
  expect((await server.fixture.pg!.query('SELECT id FROM hamdee_private.partners')).rows).toHaveLength(0);await save(page);await page.getByRole('button',{name:'Add partner contact',exact:true}).click();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Add partner contact',exact:true})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
