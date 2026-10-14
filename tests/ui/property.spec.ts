import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startHarness } from '../support/browser-server';
let server:Awaited<ReturnType<typeof startHarness>>;
test.beforeAll(async()=>{server=await startHarness();await mkdir('evidence',{recursive:true});});
test.afterAll(async()=>{await server?.close();});
test('authenticated property create/edit/archive/restore and scoped audit',async({page},info)=>{
  const failures:string[]=[];page.on('pageerror',e=>failures.push(e.message));
  await page.setExtraHTTPHeaders({Authorization:'Bearer '+server.f.users.admin.token});
  await page.goto(server.url+'/workspace/index.html');
  await expect(page.getByText('Automated test identity · Synthetic records only')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Property overview'})).toBeVisible();
  await expect(page.locator('.unavailable-metric')).toHaveCount(3);
  await page.getByRole('button',{name:'Add property',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button',{name:'Add property',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Add property',exact:true}).click();
  await page.getByLabel('Property name',{exact:true}).fill('Synthetic Browser Villa');
  await page.getByLabel('Location / address (optional)').fill('Synthetic location only');
  await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Synthetic Browser Villa'})).toBeVisible();
  await page.getByRole('button',{name:'Edit property',exact:true}).click();
  await page.getByLabel('Property name',{exact:true}).fill('Synthetic Updated Villa');
  await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Synthetic Updated Villa'})).toBeVisible();
  await page.reload();await expect(page.getByRole('heading',{name:'Synthetic Updated Villa'})).toBeVisible();
  await page.getByRole('button',{name:'Archive',exact:true}).click();
  await page.getByLabel('Reason',{exact:true}).fill('Synthetic archive test');
  await page.getByRole('button',{name:'Confirm archive'}).click();
  await expect(page.getByRole('button',{name:'Restore',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Restore',exact:true}).click();
  await page.getByLabel('Reason',{exact:true}).fill('Synthetic restore test');
  await page.getByRole('button',{name:'Restore property',exact:true}).click();
  await page.getByRole('button',{name:'Audit history',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Audit history',exact:true})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Synthetic archive test',exact:true})).toBeVisible();
  await page.screenshot({path:`evidence/${info.project.name}-property-audit.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  expect(failures).toEqual([]);
});
test('no session, no backend and injected demo storage cannot simulate success',async({browser},info)=>{
  const context=await browser.newContext({viewport:info.project.use.viewport});
  await context.addInitScript(()=>localStorage.setItem('hamdee-investment-demo-v1',JSON.stringify({properties:[{id:'fake',name:'DEMO MUST NOT APPEAR'}]})));
  const page=await context.newPage();await page.goto(server.url+'/workspace/index.html');
  await expect(page.getByRole('heading',{name:'Sign-in required'})).toBeVisible();
  await expect(page.getByText('DEMO MUST NOT APPEAR')).toHaveCount(0);
  const missing=await startHarness(false);try{
    await page.goto(missing.url+'/workspace/index.html');await expect(page.getByRole('heading',{name:'Backend unavailable'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Add property',exact:true})).toHaveCount(0);
    await page.screenshot({path:`evidence/${info.project.name}-unavailable.png`,fullPage:true});
  }finally{await context.close();await missing.close();}
});
test('read-only assigned view hides mutation controls; mobile navigation remains usable',async({page},info)=>{
  const p=await server.f.create();await server.f.pg.query('INSERT INTO hamdee_private.property_access VALUES($1,$2)',[server.f.users.reader.assignment,p.id]);
  await page.setExtraHTTPHeaders({Authorization:'Bearer '+server.f.users.reader.token});
  await page.goto(server.url+'/workspace/index.html#properties/'+p.id);
  await expect(page.getByRole('heading',{name:p.name,exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Edit property',exact:true})).toHaveCount(0);
  if(info.project.name==='mobile'){
    await page.getByRole('button',{name:'Open navigation'}).click();
    await page.getByRole('link',{name:'Properties',exact:true}).click();
  }else{await page.getByRole('link',{name:'Properties',exact:true}).click();}
  await expect(page.getByRole('heading',{name:'Properties',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add property',exact:true})).toHaveCount(0);
});
test('lost committed response retries once; concurrent edit retains draft until reviewed',async({page})=>{
  await page.setExtraHTTPHeaders({Authorization:'Bearer '+server.f.users.admin.token});
  await page.goto(server.url+'/workspace/index.html#properties');
  await page.getByRole('button',{name:'Add property',exact:true}).click();
  await page.getByLabel('Property name',{exact:true}).fill('Synthetic lost response');
  let lose=true;
  await page.route('**/api/hamdee/v1/properties',async route=>{
    if(route.request().method()==='POST'&&lose){lose=false;await route.fetch();await route.abort('failed');}
    else await route.continue();
  });
  await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.locator('#form-error')).not.toBeEmpty();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Synthetic lost response',exact:true})).toBeVisible();
  const id=page.url().split('#properties/')[1];
  expect((await server.f.pg.query('SELECT * FROM hamdee_private.properties WHERE name=$1',['Synthetic lost response'])).rows).toHaveLength(1);
  await page.getByRole('button',{name:'Edit property',exact:true}).click();
  await page.getByLabel('Property name',{exact:true}).fill('Synthetic retained draft');
  const response=await server.f.request('admin','PATCH','/properties/'+id,{name:'Synthetic external edit'},{'Idempotency-Key':randomUUID(),'If-Match':`"property:${id}:1"`});expect(response.status).toBe(200);
  await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.locator('#form-error')).toContainText('changed');
  await expect(page.getByLabel('Property name',{exact:true})).toHaveValue('Synthetic retained draft');
  await page.getByRole('button',{name:'Review latest revision'}).click();
  await expect(page.locator('#conflict-review')).toContainText('Synthetic external edit');
  await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Synthetic retained draft',exact:true})).toBeVisible();
});

test('empty scoped view, strict validation, safe text and failed saves remain actionable',async({page},info)=>{
  await page.setExtraHTTPHeaders({Authorization:'Bearer '+server.f.users.unassigned.token});
  await page.goto(server.url+'/workspace/index.html#properties');
  await expect(page.getByRole('heading',{name:'No authorized properties'})).toBeVisible();
  await page.setExtraHTTPHeaders({Authorization:'Bearer '+server.f.users.admin.token});await page.reload();
  await page.getByRole('button',{name:'Add property',exact:true}).click();
  await page.getByLabel('Property name',{exact:true}).fill('   ');await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.locator('#form-error')).toContainText('text lengths');
  const literal='<img src=x onerror=alert(1)> Synthetic text';
  await page.getByLabel('Property name',{exact:true}).fill(literal);await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.getByRole('heading',{name:literal,exact:true})).toBeVisible();await expect(page.locator('#main img')).toHaveCount(0);
  await page.getByRole('button',{name:'Edit property',exact:true}).click();await page.getByLabel('Property name',{exact:true}).fill('Synthetic retained after server failure');
  await page.route('**/api/hamdee/v1/properties/*',async route=>{if(route.request().method()==='PATCH')await route.fulfill({status:503,contentType:'text/html',body:'PRIVATE SQL STACK MUST NOT APPEAR'});else await route.continue();});
  await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.locator('#form-error')).toContainText('unreadable response');await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('PRIVATE SQL');await expect(page.locator('#feedback')).toBeEmpty();
  await page.screenshot({path:`evidence/${info.project.name}-validation.png`,fullPage:true});
});

test('expired session during conflict review clears protected record and draft',async({page})=>{
  const p=await server.f.create('admin','Synthetic expiry record');
  await page.setExtraHTTPHeaders({Authorization:'Bearer '+server.f.users.admin.token});await page.goto(server.url+'/workspace/index.html#properties/'+p.id);
  await page.getByRole('button',{name:'Edit property',exact:true}).click();await page.getByLabel('Property name',{exact:true}).fill('Synthetic private draft');
  const changed=await server.f.request('admin','PATCH','/properties/'+p.id,{name:'Synthetic latest expiry revision'},{'Idempotency-Key':randomUUID(),'If-Match':`"property:${p.id}:1"`});expect(changed.status).toBe(200);
  await page.getByRole('button',{name:'Save property',exact:true}).click();await expect(page.getByRole('button',{name:'Review latest revision'})).toBeVisible();
  await page.route('**/api/hamdee/v1/properties/'+p.id,route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{code:'UNAUTHENTICATED',message:'Sign in with an authorized account.'}})}));
  await page.getByRole('button',{name:'Review latest revision'}).click();
  await expect(page.getByRole('heading',{name:'Sign-in required'})).toBeVisible();await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('#dialog-body')).toBeEmpty();await expect(page.locator('#user-context')).toHaveText('Not signed in');
  await expect(page.locator('body')).not.toContainText('Synthetic expiry record');
});

test('a delayed committed response cannot repopulate a session that has failed validation',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setExtraHTTPHeaders({Authorization:'Bearer '+server.f.users.admin.token});await page.goto(server.url+'/workspace/index.html#properties');
  await page.getByRole('button',{name:'Add property',exact:true}).click();await page.getByLabel('Property name',{exact:true}).fill('Synthetic delayed response');
  let release!:()=>void,committed!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{committed=resolve;});
  await page.route('**/api/hamdee/v1/properties',async route=>{if(route.request().method()==='POST'){const response=await route.fetch();committed();await hold;await route.fulfill({response});}else await route.continue();});
  await page.getByRole('button',{name:'Save property',exact:true}).click();await ready;
  await page.setExtraHTTPHeaders({Authorization:'Bearer expired-synthetic'});await page.evaluate(()=>{window.location.hash='dashboard';});
  await expect(page.getByRole('heading',{name:'Sign-in required'})).toBeVisible();release();
  await expect(page.locator('#user-context')).toHaveText('Not signed in');await expect(page.locator('#feedback')).toBeEmpty();
  await expect(page.getByRole('heading',{name:'Synthetic delayed response'})).toHaveCount(0);expect(errors).toEqual([]);
});

test('backend property changes never consume or replace demo localStorage',async({page})=>{
  const sentinel=JSON.stringify({properties:[{id:'demo-fake',name:'Demo financial record',rent:123456}]});
  await page.addInitScript(value=>localStorage.setItem('hamdee-investment-demo-v1',value),sentinel);
  await page.setExtraHTTPHeaders({Authorization:'Bearer '+server.f.users.admin.token});await page.goto(server.url+'/workspace/index.html');
  await expect(page.locator('.unavailable-metric')).toHaveCount(3);await expect(page.locator('#main')).not.toContainText('123456');
  await page.getByRole('button',{name:'Add property',exact:true}).click();await page.getByLabel('Property name',{exact:true}).fill('Synthetic backend only');await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Synthetic backend only'})).toBeVisible();
  expect(await page.evaluate(()=>localStorage.getItem('hamdee-investment-demo-v1'))).toBe(sentinel);
  expect(await page.evaluate(()=>localStorage.length)).toBe(1);
});
