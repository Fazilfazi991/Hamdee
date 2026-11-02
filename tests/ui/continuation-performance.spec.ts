import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {startOwnerBrowserHarness} from '../support/owner-crm-harness';

test('Repeated local customer navigation and connected collection saves retain exact balances',async({page},info)=>{
 test.setTimeout(180000);
 const server=await startOwnerBrowserHarness({migrationFiles:['006_local_operations_records.up.sql','007_local_car_rentals.up.sql','008_local_partner_records.up.sql','009_local_partner_corrections.up.sql','011_local_owner_occupancy.up.sql','012_local_private_documents.up.sql','013_local_customers_kyc_cheques.up.sql','014_local_connected_funding.up.sql','015_local_account_reconciliation.up.sql','016_local_scoped_expenses.up.sql','017_local_corrections_and_source_compatibility.up.sql','018_local_collector_counts.up.sql','019_local_principal_supporting_records.up.sql']});
 const profileSamples:number[]=[],saveSamples:number[]=[];
 try{
  await server.fixture.login();
  const post=async(path:string,body:Record<string,unknown>)=>{const response=await server.fixture.request('POST','/api/hamdee/v1'+path,body,{'Idempotency-Key':randomUUID()});const value=await response.json();expect(response.ok,JSON.stringify(value)).toBe(true);return value.data as Record<string,unknown>;};
  const property=await post('/properties',{name:'Synthetic repeated performance villa'}),room=await post('/rental',{action:'create-room',propertyId:property.id,code:'PERF-01'}),customer=await post('/customers/commands',{action:'create-customer',name:'Synthetic repeated performance customer'});
  const terms=await post('/rental',{action:'create-agreement',roomId:room.id,tenantId:customer.id,startDate:'2026-11-01',monthlyRent:'1000',currency:'XTS',depositRequired:'0',dueTerms:'Explicit synthetic monthly terms'});
  await post('/rental',{action:'issue-due',agreementId:terms.id,period:'2026-11',dueDate:'2026-11-01',amount:'1000'});
  const account=await post('/company-finance/commands',{action:'create-account',name:'Synthetic repeated performance account',scope:'company',kind:'cash',currency:'XTS',openingDate:'2026-11-01',openingAmount:'0',ownerConfirmedOpening:true});
  await page.addInitScript(()=>{const NativeDate=Date,fixed=new NativeDate('2026-11-02T12:00:00Z').valueOf();class TestDate extends NativeDate{constructor(...args:ConstructorParameters<typeof Date>){if(args.length)super(...args);else super(fixed);}static now(){return NativeDate.now();}}Object.defineProperty(window,'Date',{value:TestDate});});
  await page.goto(server.url+'/workspace/index.html');await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Business Overview',exact:true})).toBeVisible();
  // One warm-up before the five retained observations; no hosted timing claim.
  await page.goto(server.url+'/workspace/index.html#customers/'+customer.id);await expect(page.getByRole('heading',{name:'Synthetic repeated performance customer',exact:true})).toBeVisible();
  for(let index=0;index<5;index++){
   await page.goto(server.url+'/workspace/index.html#dashboard');await expect(page.getByRole('heading',{name:'Business Overview',exact:true})).toBeVisible();let start=performance.now();
   await page.goto(server.url+'/workspace/index.html#customers/'+customer.id);await expect(page.getByRole('heading',{name:'Synthetic repeated performance customer',exact:true})).toBeVisible();await expect(page.locator('#customer-section-properties')).toContainText('PERF-01');profileSamples.push(performance.now()-start);
   await page.locator('#customer-section-properties').getByRole('link',{name:'Record payment',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'Record collection',exact:true})).toBeVisible();await dialog.getByLabel('Payment method',{exact:true}).selectOption('cash');await expect(dialog.getByLabel('Receiving account or collector',{exact:true})).toBeEnabled();await dialog.getByLabel('Receiving account or collector',{exact:true}).selectOption(String(account.id));await dialog.getByLabel('Amount',{exact:true}).fill('100');await dialog.getByLabel('Reference (optional)',{exact:true}).fill('SYN-PERF-'+index);start=performance.now();
   await dialog.getByRole('button',{name:'Save record',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(page.getByRole('region',{name:'Monthly villa and room collection register',exact:true})).toContainText('XTS '+(900-index*100)+'.00');saveSamples.push(performance.now()-start);
  }
  const ledger=await server.fixture.request('GET','/api/hamdee/v1/company-finance?month=2026-11&asOf=2026-11-30'),money=(await ledger.json()).data;expect(Number(money.totals.find((row:{accountId:unknown})=>row.accountId===account.id).balance)).toBe(500);
  const rental=await server.fixture.request('GET','/api/hamdee/v1/rental?month=2026-11&asOf=2026-11-30'),rent=(await rental.json()).data;expect(rent.collections).toHaveLength(5);expect(rent.dues[0].outstandingMinor).toBe('50000');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const summary=(samples:number[])=>{const sorted=[...samples].sort((a,b)=>a-b);return {sampleCount:samples.length,minMs:sorted[0],medianMs:sorted[Math.floor(sorted.length/2)],maxMs:sorted.at(-1),samplesMs:samples};};
  await mkdir('evidence/continuation-performance',{recursive:true});await writeFile('evidence/continuation-performance/'+info.project.name+'.json',JSON.stringify({environment:'isolated loopback HTTP with PGlite and constructor-injected fake provider; real workspace UI; five samples after one warm-up; Playwright action-to-visible timing',hosted:false,viewport:info.project.use.viewport,profileNavigation:summary(profileSamples),connectedCollectionSave:summary(saveSamples),verifiedReceipts:5,receivedAmount:'500',outstandingAmount:'500',currency:'XTS'},null,2));
 }finally{await server.close();}
});
