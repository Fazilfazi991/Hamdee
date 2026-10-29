import {test,expect} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startOwnerBrowserHarness} from '../support/owner-crm-harness';

test('Owner can save and privately download a room document on desktop and mobile',async({page},info)=>{
 test.setTimeout(90000);
 const server=await startOwnerBrowserHarness({migrationFiles:['012_local_private_documents.up.sql']});
 try{
  await server.fixture.login();
  const propertyResponse=await server.fixture.request('POST','/api/hamdee/v1/properties',{name:'Synthetic villa'},{'Idempotency-Key':randomUUID()});
  expect(propertyResponse.status).toBe(201);const property=(await propertyResponse.json()).data;
  const roomResponse=await server.fixture.request('POST','/api/hamdee/v1/rental',{action:'create-room',propertyId:property.id,code:'TEST-1',label:''},{'Idempotency-Key':randomUUID()});
  expect(roomResponse.status).toBe(200);const room=(await roomResponse.json()).data;
  const source=await readFile(new URL('../../public/workspace/documents.js',import.meta.url),'utf8');
  await page.route('**/workspace/documents.js',route=>route.fulfill({status:200,contentType:'text/javascript',body:source}));
  await page.route('**/synthetic-documents-fixture',route=>route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/shared/styles.css"><link rel="stylesheet" href="/workspace/foundation.css"><main id="documents"></main><script type="module">
    import {PropertyApi} from '/workspace/adapter.js';import {renderDocuments} from '/workspace/documents.js';
    const api=new PropertyApi();const state=await api.authState();api.rememberState(state.data);
    renderDocuments(document.querySelector('#documents'),{api,property:${JSON.stringify(property)},rooms:[${JSON.stringify(room)}],signal:new AbortController().signal,isCurrent:()=>true,
      verifyAccess:async()=>{const state=await api.authState();api.rememberState(state.data);return state.data.state==='authenticated';},onAccessLoss:()=>{document.body.textContent='Session expired';}});
    </script>`}));
  await page.goto(server.url+'/login');await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL(/\/workspace\/index\.html/);
  await page.goto(server.url+'/synthetic-documents-fixture');await expect(page.getByRole('heading',{name:'Documents',exact:true})).toBeVisible();
  await page.getByLabel('Room',{exact:true}).selectOption(room.id);
  const contents=Buffer.from('%PDF-1.4\n% synthetic owner test\n%%EOF');
  await page.getByLabel('Choose document',{exact:true}).setInputFiles({name:'Synthetic agreement.pdf',mimeType:'application/pdf',buffer:contents});
  await page.getByRole('button',{name:'Save document',exact:true}).click();await expect(page.getByRole('status')).toContainText('Document saved.');
  const saved=page.getByRole('region',{name:'Saved documents',exact:true});await expect(saved).toContainText('Synthetic agreement.pdf');await expect(saved).toContainText('TEST-1');
  await expect(page.getByRole('button',{name:'Load more documents',exact:true})).toBeHidden();
  await mkdir('evidence/private-documents',{recursive:true});await page.screenshot({path:`evidence/private-documents/${info.project.name}.png`,fullPage:true});
  const downloadPromise=page.waitForEvent('download');await saved.getByRole('link',{name:'Synthetic agreement.pdf',exact:true}).click();const download=await downloadPromise;
  expect(download.suggestedFilename()).toBe('Synthetic agreement.pdf');const savedPath=await download.path();expect(savedPath).not.toBeNull();expect(await readFile(savedPath!)).toEqual(contents);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await server.close();}
});
