import { test,expect,type Page,type Route } from '@playwright/test';
import { readFile,mkdir } from 'node:fs/promises';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';

let server:Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(60000);
test.beforeEach(async({page})=>{
  server=await startOwnerBrowserHarness();await mkdir('evidence/operations-ui',{recursive:true});
  // Serve only the new owned UI assets until QA extends its static whitelist.
  // Authentication and property requests still use the actual synthetic harness.
  for(const name of ['staff-collections.js','car-rentals.js','company-finance.js']){
    await page.route('**/workspace/'+name,async route=>route.fulfill({status:200,contentType:'text/javascript',body:await readFile(new URL('../../public/workspace/'+name,import.meta.url),'utf8')}));
  }
});
test.afterEach(async()=>{await server?.close();});
async function login(page:Page){
  await page.goto(server.url+'/workspace/index.html');
  await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);
  await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Business Overview',exact:true})).toBeVisible();
}
async function navigate(page:Page,name:string){
  const menu=page.getByRole('button',{name:'Open navigation',exact:true});
  if(await menu.isVisible()&&!await page.locator('#sidebar').evaluate(el=>el.classList.contains('open')))await menu.click();
  await page.getByRole('link',{name:new RegExp('^'+name+'(?: Unavailable)?$')}).click();
}
test('operations shells preserve owner access and never fabricate unconnected balances',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await login(page);
  await expect(page.locator('#navigation button')).toHaveCount(5);
  for(const entry of await page.locator('#navigation button').all()){
    await expect(entry).toContainText(/Unavailable|Checking…|Retry/);
    expect(await entry.getAttribute('href')).toBeNull();
    if((await entry.textContent())?.includes('Retry'))await expect(entry).toHaveAttribute('data-action','retry-modules');
    else await expect(entry).toBeDisabled();
  }
  await expect(page.getByRole('link',{name:'Staff Collections',exact:true})).toHaveCount(0);
  await page.goto(server.url+'/workspace/index.html#staff-collections');
  await expect(page.getByRole('heading',{name:'Staff Collections unavailable',exact:true})).toBeVisible();
  await expect(page.locator('#main')).toContainText('do not provide sign-in access');
  await expect(page.locator('#main input,#main select')).toHaveCount(0);
  await page.screenshot({path:`evidence/operations-ui/${info.project.name}-staff-shell.png`,fullPage:true});
  await expect(page.getByRole('link',{name:'Car Rentals',exact:true})).toHaveCount(0);
  await page.goto(server.url+'/workspace/index.html#car-rentals');await expect(page.getByRole('heading',{name:'Car Rentals unavailable',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Company Finance',exact:true})).toHaveCount(0);
  await page.goto(server.url+'/workspace/index.html#company');await expect(page.getByRole('heading',{name:'Company Finance unavailable',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Personal Finance',exact:true})).toHaveCount(0);
  await page.goto(server.url+'/workspace/index.html#personal-finance');await expect(page.getByRole('heading',{name:'Personal Finance unavailable',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();expect(errors).toEqual([]);
});
test('property rooms remain in the parent property workspace',async({page})=>{
  await login(page);await navigate(page, 'Villas & Properties');
  await page.getByRole('button',{name:'Add property',exact:true}).click();
  await page.getByLabel('Property name',{exact:true}).fill('Synthetic operations parent villa');
  await page.getByRole('button',{name:'Save property',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Synthetic operations parent villa',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Rooms & rentals',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Rooms & units',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add room',exact:true})).toBeVisible();
  expect(page.url()).toContain('#properties/');
});

// UI contract fixtures only. These do not certify the service's financial
// reconciliation; Agent 4 exercises that separately against its frozen service.
const collectorId='00000000-0000-4000-8000-000000000101',accountId='00000000-0000-4000-8000-000000000102',receiptId='00000000-0000-4000-8000-000000000103';
async function staffContract(page:Page,write?:(route:Route,body:Record<string,unknown>,index:number)=>Promise<void>){
  await page.route('**/api/hamdee/v1/capabilities',route=>route.fulfill({json:{data:{rentals:true,partners:false,staffCollections:true,companyFinance:true,personalFinance:false,carRentals:false}}}));
  const day=new Date().toISOString().slice(0,10),month=day.slice(0,7),commands:{body:Record<string,unknown>;key:string;csrf:string}[]=[];
  const collectors=[{id:collectorId,name:'Synthetic collector',phone:'Synthetic contact',notes:'',version:1}];
  const source={kind:'property-rent',id:receiptId,date:day,amount:'125.123456789123',currency:'AED',method:'cash',classification:'rent',status:'recorded',disposition:'unassigned',propertyLabel:'Synthetic villa',roomLabel:'Synthetic room',linked:false,companyAccountId:null};
  const accounts=[{id:accountId,name:'Synthetic company cash',scope:'company',kind:'cash',currency:'AED',openingDate:day,openingAmount:'0',ownerConfirmed:true}];
  const overview={collectors,collections:[],handovers:[{id:'00000000-0000-4000-8000-000000000104',collectorId,accountId,businessDate:day,amount:'50',currency:'AED',reference:'SYNTHETIC-OLD',notes:'',reversed:false,replacesHandoverId:null}],
    totals:[{collectorId,currency:'AED',received:'150.123456789123',companyDirect:'250',pending:'75',handedOver:'50',balance:'100.123456789123',monthReceived:'150.123456789123',monthHandedOver:'50',month,asOf:day},
      {collectorId,currency:'USD',received:'9007199254740993.01',companyDirect:'0',pending:'0',handedOver:'0',balance:'9007199254740993.01',monthReceived:'9007199254740993.01',monthHandedOver:'0',month,asOf:day}],
    daily:[{collectorId,currency:'AED',date:day,received:'150.123456789123',handedOver:'50',balance:'100.123456789123'}],history:[],month,asOf:day,moneyUnit:'decimal-major-unit-strings',basis:'Synthetic service snapshot; no client totals.'};
  await page.route('**/api/hamdee/v1/staff-collections**',async route=>{
    if(new URL(route.request().url()).pathname.endsWith('/commands')){
      const body=route.request().postDataJSON() as Record<string,unknown>,headers=route.request().headers();commands.push({body,key:headers['idempotency-key'],csrf:headers['x-hamdee-csrf']});
      if(write){await write(route,body,commands.length);return;}
      if(body.action==='create-collector')collectors.push({id:'00000000-0000-4000-8000-000000000105',name:String(body.name),phone:String(body.phone||''),notes:String(body.notes||''),version:1});
      await route.fulfill({json:{data:{id:collectorId},replay:false,requestId:'synthetic-request'}});return;
    }
    await route.fulfill({json:{data:new URL(route.request().url()).pathname.endsWith('/receipts')?{data:[source],hasMore:false,asOf:day,moneyUnit:overview.moneyUnit}:overview,requestId:'synthetic-request'}});
  });
  await page.route('**/api/hamdee/v1/company-finance?*',route=>route.fulfill({json:{data:{accounts,transferAccounts:accounts,scope:'company',moneyUnit:'decimal-major-unit-strings',totals:[],entries:[],monthEntries:[],month,asOf:day},requestId:'synthetic-request'}}));
  await page.route('**/api/hamdee/v1/company-finance/commands',async route=>{
    const body=route.request().postDataJSON() as Record<string,unknown>,headers=route.request().headers();commands.push({body,key:headers['idempotency-key'],csrf:headers['x-hamdee-csrf']});
    await route.fulfill({json:{data:{id:accountId},replay:false}});
  });
  return {commands,day,month,source,collectors};
}

test('staff contract displays exact currency-separated snapshots and native collector forms',async({page},info)=>{
  const fixture=await staffContract(page);await login(page);await navigate(page,'Staff Collections');
  const balances=page.getByRole('region',{name:'Collector custody balances',exact:true});
  await expect(balances).toContainText('AED 100.123456789123');await expect(balances).toContainText('USD 9007199254740993.01');
  await expect(page.getByRole('region',{name:'Daily collector statement',exact:true})).toContainText(fixture.day);
  await page.screenshot({path:`evidence/operations-ui/${info.project.name}-staff-ledger.png`,fullPage:true});
  await page.getByRole('button',{name:'Add collector',exact:true}).click();await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByRole('button',{name:'Add collector',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Add collector',exact:true}).click();
  await page.getByLabel('Collector name',{exact:true}).fill('Synthetic added collector');
  await page.screenshot({path:`evidence/operations-ui/${info.project.name}-collector-form.png`,fullPage:true});
  await page.getByRole('button',{name:'Save record',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('region',{name:'Collector register',exact:true})).toContainText('Synthetic added collector');
  await expect(page.getByRole('button',{name:'Add collector',exact:true})).toBeFocused();
  expect(fixture.commands[0].body).toEqual({action:'create-collector',name:'Synthetic added collector',phone:'',notes:''});
  expect(fixture.commands[0].key).toMatch(/^[0-9a-f-]{36}$/);expect(fixture.commands[0].csrf).toBeTruthy();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('receipt linking sends source identity without replacing original money or date',async({page},info)=>{
  const fixture=await staffContract(page);await login(page);await navigate(page,'Staff Collections');
  await page.getByRole('button',{name:'Link collected receipt',exact:true}).click();
  await page.getByLabel('Collector',{exact:true}).last().selectOption(collectorId);
  await page.getByLabel('Original receipt',{exact:true}).selectOption('property-rent:'+receiptId);
  await expect(page.locator('#staff-receipt-detail')).toContainText('AED 125.123456789123');
  await page.getByLabel('Where is the money?',{exact:true}).selectOption('collector-held');
  await page.getByLabel('I confirm where this receipt is held.',{exact:true}).check();
  await page.screenshot({path:`evidence/operations-ui/${info.project.name}-receipt-link.png`,fullPage:true});
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(fixture.commands[0].body).toEqual({action:'record-collection',collectorId,sourceKind:'property-rent',sourceId:receiptId,disposition:'collector-held',ownerConfirmedDisposition:true,notes:''});
});

test('handover errors retain the draft and uncertain retries reuse the exact command',async({page},info)=>{
  const fixture=await staffContract(page,async(route,_body,index)=>{
    if(index===1){await route.fulfill({status:409,json:{error:{code:'INSUFFICIENT_FUNDS',message:'Choose an amount within the saved available balance.'}}});return;}
    if(index===2){await route.abort('failed');return;}
    await route.fulfill({json:{data:{id:'synthetic-handover'},replay:true}});
  });
  await login(page);await navigate(page,'Staff Collections');await page.getByRole('button',{name:'Record handover',exact:true}).click();
  await page.getByLabel('Collector',{exact:true}).last().selectOption(collectorId);await page.getByLabel('Company cash / bank account',{exact:true}).selectOption(accountId);
  await expect(page.getByLabel('Account currency',{exact:true})).toHaveValue('AED');
  await page.getByLabel('Handover amount',{exact:true}).fill('25.123456789123');await page.getByLabel('Handover date',{exact:true}).fill(fixture.day);
  await page.getByLabel('New unique handover reference',{exact:true}).fill('SYNTHETIC-PARTIAL');
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('alert')).toContainText('saved available balance');
  await expect(page.getByLabel('Handover amount',{exact:true})).toHaveValue('25.123456789123');
  await page.screenshot({path:`evidence/operations-ui/${info.project.name}-handover-error.png`,fullPage:true});
  await page.getByLabel('Handover amount',{exact:true}).fill('20');await page.getByRole('button',{name:'Save record',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('save may have reached');await expect(page.getByLabel('Handover amount',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(fixture.commands[1].body).toEqual(fixture.commands[2].body);expect(fixture.commands[1].key).toBe(fixture.commands[2].key);
  expect(fixture.commands[0].key).not.toBe(fixture.commands[1].key);expect(fixture.commands[2].body).toEqual({action:'handover',collectorId,accountId,amount:'20',currency:'AED',handedOn:fixture.day,reference:'SYNTHETIC-PARTIAL',notes:''});
});

test('handover corrections require a new reference and preserve reason fields',async({page})=>{
  const fixture=await staffContract(page);await login(page);await navigate(page,'Staff Collections');
  await page.getByRole('button',{name:'Correct handover',exact:true}).click();
  await expect(page.getByLabel('Handover date',{exact:true})).toHaveValue(fixture.day);
  await expect(page.getByLabel('New unique handover reference',{exact:true})).toHaveValue('');
  await page.getByLabel('New unique handover reference',{exact:true}).fill('SYNTHETIC-CORRECTION');await page.getByLabel('Correction reason',{exact:true}).fill('Synthetic reference correction');
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(fixture.commands[0].body).toMatchObject({action:'correct-handover',handedOn:fixture.day,reason:'Synthetic reference correction',reference:'SYNTHETIC-CORRECTION',handoverId:'00000000-0000-4000-8000-000000000104'});
  expect(fixture.commands[0].body).not.toHaveProperty('collectorId');
});

test('pending receipts remain pending without requiring an invented custody location',async({page})=>{
  const fixture=await staffContract(page);fixture.source.method='cheque';fixture.source.status='pending';
  await login(page);await navigate(page,'Staff Collections');await page.getByRole('button',{name:'Link collected receipt',exact:true}).click();
  await page.getByLabel('Collector',{exact:true}).last().selectOption(collectorId);await page.getByLabel('Original receipt',{exact:true}).selectOption('property-rent:'+receiptId);
  await expect(page.locator('#staff-receipt-detail')).toContainText('cannot be handed over');
  await expect(page.getByLabel('Where is the money?',{exact:true})).not.toBeVisible();
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(fixture.commands[0].body).not.toHaveProperty('accountId');expect(fixture.commands[0].body).not.toHaveProperty('disposition');
  expect(fixture.commands[0].body).not.toHaveProperty('amount');
});

test('direct company receipt linking requires a same-currency account and confirmation',async({page})=>{
  const fixture=await staffContract(page);await login(page);await navigate(page,'Staff Collections');await page.getByRole('button',{name:'Link collected receipt',exact:true}).click();
  await page.getByLabel('Collector',{exact:true}).last().selectOption(collectorId);await page.getByLabel('Original receipt',{exact:true}).selectOption('property-rent:'+receiptId);
  await page.getByLabel('Where is the money?',{exact:true}).selectOption('company-direct');
  await page.getByLabel('Company cash / bank account',{exact:true}).selectOption(accountId);await page.getByLabel('I confirm where this receipt is held.',{exact:true}).check();
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(fixture.commands[0].body).toMatchObject({action:'record-collection',disposition:'company-direct',accountId,ownerConfirmedDisposition:true});
});

test('company account setup has no default opening balance and requires owner confirmation',async({page})=>{
  const fixture=await staffContract(page);await login(page);await navigate(page,'Staff Collections');await page.getByRole('button',{name:'Add company account',exact:true}).click();
  await expect(page.getByLabel('Owner-confirmed opening balance',{exact:true})).toHaveValue('');await expect(page.getByLabel('Opening balance date',{exact:true})).toHaveValue('');
  await page.getByLabel('Account name',{exact:true}).fill('Synthetic confirmed bank');await page.getByLabel('Account type',{exact:true}).selectOption('bank');
  await page.getByLabel('Currency',{exact:true}).fill('AED');await page.getByLabel('Opening balance date',{exact:true}).fill(fixture.day);await page.getByLabel('Owner-confirmed opening balance',{exact:true}).fill('0');
  await page.getByLabel('I confirm this account’s opening amount and date, including an explicit zero if appropriate.',{exact:true}).check();
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(fixture.commands[0].body).toEqual({action:'create-account',scope:'company',name:'Synthetic confirmed bank',kind:'bank',currency:'AED',openingDate:fixture.day,openingAmount:'0',ownerConfirmedOpening:true,notes:''});
});

test('expired write proof retains a staff draft and requires explicit verification and save',async({page})=>{
  const fixture=await staffContract(page,async(route,_body,index)=>{
    await route.fulfill(index===1?{status:403,json:{error:{code:'CSRF_REJECTED',message:'Session verification expired.'}}}:{json:{data:{id:collectorId},replay:false}});
  });
  await login(page);await navigate(page,'Staff Collections');await page.getByRole('button',{name:'Edit collector',exact:true}).click();
  await page.getByLabel('Collector name',{exact:true}).fill('Synthetic retained edit');await page.getByRole('button',{name:'Save record',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('verification expired');await page.getByRole('button',{name:'Renew session verification',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('save explicitly');expect(fixture.commands).toHaveLength(1);await expect(page.getByLabel('Collector name',{exact:true})).toHaveValue('Synthetic retained edit');
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(fixture.commands[1].body).toMatchObject({action:'update-collector',collectorId,expectedVersion:1,name:'Synthetic retained edit'});
});

test('collector revision review keeps the draft and requires an explicit save',async({page})=>{
  const fixture=await staffContract(page,async(route,_body,index)=>{
    if(index===1){fixture.collectors[0].version=2;fixture.collectors[0].name='Synthetic concurrent saved name';await route.fulfill({status:412,json:{error:{code:'VERSION_CONFLICT',message:'Reload and review this collector revision.'}}});return;}
    await route.fulfill({json:{data:{id:collectorId},replay:false}});
  });
  await login(page);await navigate(page,'Staff Collections');await page.getByRole('button',{name:'Edit collector',exact:true}).click();await page.getByLabel('Collector name',{exact:true}).fill('Synthetic retained draft');
  await page.getByRole('button',{name:'Save record',exact:true}).click();await page.getByRole('button',{name:'Review latest collector revision',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Latest revision 2: Synthetic concurrent saved name');await expect(page.getByLabel('Collector name',{exact:true})).toHaveValue('Synthetic retained draft');expect(fixture.commands).toHaveLength(1);
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();expect(fixture.commands[1].body).toMatchObject({expectedVersion:2,name:'Synthetic retained draft'});expect(fixture.commands[1].key).not.toBe(fixture.commands[0].key);
});

test('receipt pagination selects beyond the first 100 without losing draft or duplicating choices',async({page},info)=>{
  const fixture=await staffContract(page),cursor='opaque+/receipt?cursor=page-two',requests:URL[]=[];
  const first=Array.from({length:100},(_,index)=>({...fixture.source,id:`00000000-0000-4000-8000-${String(2000+index).padStart(12,'0')}`}));
  const tail={...fixture.source,id:'00000000-0000-4000-8000-000000003000',roomLabel:'Synthetic later room'};
  await page.route('**/api/hamdee/v1/staff-collections/receipts?*',async route=>{
    const url=new URL(route.request().url());requests.push(url);
    await route.fulfill({json:{data:{data:url.searchParams.has('cursor')?[first[99],{...first[0],kind:'car-rental',classification:'car receipt'},tail]:first,hasMore:!url.searchParams.has('cursor'),nextCursor:url.searchParams.has('cursor')?null:cursor,asOf:url.searchParams.get('asOf'),moneyUnit:'decimal-major-unit-strings'}}});
  });
  await login(page);await navigate(page,'Staff Collections');await page.getByRole('button',{name:'Link collected receipt',exact:true}).click();
  await page.getByLabel('Collector',{exact:true}).last().selectOption(collectorId);await page.getByLabel('Original receipt',{exact:true}).selectOption('property-rent:'+first[0].id);
  await page.getByLabel('Where is the money?',{exact:true}).selectOption('collector-held');await page.getByLabel('I confirm where this receipt is held.',{exact:true}).check();await page.getByLabel('Notes (optional)',{exact:true}).fill('Synthetic paging draft');
  expect((await page.getByRole('button',{name:'Load more receipts',exact:true}).boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({path:`evidence/operations-ui/${info.project.name}-receipt-pagination-ready.png`,fullPage:true});
  await page.getByRole('button',{name:'Load more receipts',exact:true}).click();await expect(page.locator('#staff-receipt-page-status')).toContainText('102 receipt records loaded');
  await expect(page.getByLabel('Original receipt',{exact:true})).toHaveValue('property-rent:'+first[0].id);await expect(page.getByLabel('Collector',{exact:true}).last()).toHaveValue(collectorId);
  await expect(page.getByLabel('Where is the money?',{exact:true})).toHaveValue('collector-held');await expect(page.getByLabel('I confirm where this receipt is held.',{exact:true})).toBeChecked();await expect(page.getByLabel('Notes (optional)',{exact:true})).toHaveValue('Synthetic paging draft');
  const picker=page.getByLabel('Original receipt',{exact:true});await expect(picker.locator('option')).toHaveCount(103);
  await expect(picker.locator(`option[value="property-rent:${first[99].id}"]`)).toHaveCount(1);await expect(picker.locator(`option[value="car-rental:${first[0].id}"]`)).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Load more receipts',exact:true})).not.toBeVisible();
  expect(requests[1].searchParams.get('cursor')).toBe(cursor);expect(requests[1].searchParams.get('asOf')).toBe(requests[0].searchParams.get('asOf'));expect([...requests[1].searchParams.keys()].sort()).toEqual(['asOf','cursor']);
  await picker.selectOption('property-rent:'+tail.id);await expect(page.locator('#staff-receipt-detail')).toContainText('AED 125.123456789123');
  await page.getByLabel('Where is the money?',{exact:true}).selectOption('collector-held');
  await page.screenshot({path:`evidence/operations-ui/${info.project.name}-receipt-pagination.png`,fullPage:true});
  await page.getByRole('button',{name:'Save record',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(fixture.commands[0].body).toMatchObject({sourceId:tail.id,sourceKind:'property-rent',notes:'Synthetic paging draft'});
});

test('all-linked first receipt page still opens the picker and failed page loads retry explicitly',async({page})=>{
  const fixture=await staffContract(page),requests:URL[]=[];let laterAttempts=0;
  const first=Array.from({length:100},(_,index)=>({...fixture.source,id:`00000000-0000-4000-8000-${String(4000+index).padStart(12,'0')}`,linked:true}));
  await page.route('**/api/hamdee/v1/staff-collections/receipts?*',async route=>{
    const url=new URL(route.request().url());requests.push(url);
    if(url.searchParams.has('cursor')&&++laterAttempts===1){await route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'Synthetic receipt page unavailable.'}}});return;}
    await route.fulfill({json:{data:{data:url.searchParams.has('cursor')?[fixture.source]:first,hasMore:!url.searchParams.has('cursor'),nextCursor:url.searchParams.has('cursor')?null:'opaque-page-two',asOf:url.searchParams.get('asOf'),moneyUnit:'decimal-major-unit-strings'}}});
  });
  await login(page);await navigate(page,'Staff Collections');await expect(page.getByRole('button',{name:'Link collected receipt',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Link collected receipt',exact:true}).click();
  await expect(page.getByLabel('Original receipt',{exact:true}).locator('option')).toHaveCount(1);await page.getByLabel('Collector',{exact:true}).last().selectOption(collectorId);await page.getByLabel('Notes (optional)',{exact:true}).fill('Synthetic retained after page failure');
  await page.getByRole('button',{name:'Load more receipts',exact:true}).click();await expect(page.locator('#staff-receipt-page-error')).toContainText('Synthetic receipt page unavailable');
  await expect(page.getByLabel('Notes (optional)',{exact:true})).toHaveValue('Synthetic retained after page failure');expect(laterAttempts).toBe(1);
  await page.getByRole('button',{name:'Load more receipts',exact:true}).click();await expect(page.getByLabel('Original receipt',{exact:true}).locator('option')).toHaveCount(2);
  expect(requests[2].searchParams.get('cursor')).toBe(requests[1].searchParams.get('cursor'));await expect(page.locator('#staff-receipt-page-error')).toBeEmpty();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Link collected receipt',exact:true}).click();await expect(page.getByLabel('Original receipt',{exact:true}).locator('option')).toHaveCount(2);await expect(page.getByRole('button',{name:'Load more receipts',exact:true})).not.toBeVisible();
});
