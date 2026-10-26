import {test,expect,type Page} from '@playwright/test';
import {startOwnerBrowserHarness} from '../support/owner-crm-harness';
let server:Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(90_000);
test.beforeEach(async()=>{server=await startOwnerBrowserHarness({migrationFiles:['006_local_operations_records.up.sql','007_local_car_rentals.up.sql','008_local_partner_records.up.sql']});});
test.afterEach(async()=>{await server.close();});
async function login(page:Page){await page.goto(server.url+'/workspace/index.html');await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Business Overview',exact:true})).toBeVisible();}
test('transient operational read errors offer explicit local retry without logging out or replaying writes',async({page})=>{
  await login(page);
  for(const [route,path,heading] of [['company','company-finance','Company Finance accounts'],['personal-finance','personal-finance','Personal Finance accounts'],['car-rentals','car-rentals','Vehicles & availability']]){
    let failed=false,reads=0,writes=0;
    await page.route('**/api/hamdee/v1/'+path+'?*',async request=>{
      if(request.request().method()!=='GET'){writes++;await request.continue();return;}
      if(await page.evaluate(()=>location.hash)==='#'+route){reads++;if(!failed){failed=true;await request.fulfill({status:503,json:{error:{code:'STORAGE_UNAVAILABLE',message:'Synthetic recoverable interruption.'}}});return;}}
      await request.continue();
    });
    await page.evaluate(hash=>{location.hash=hash;},route);await expect(page.locator('#operations-workspace')).toContainText('Synthetic recoverable interruption.');
    expect(await page.locator('#operations-workspace').getByRole('button',{name:'Retry loading',exact:true}).count()).toBe(1);
    expect(reads).toBe(1);await page.getByRole('button',{name:'Retry loading',exact:true}).click();await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();expect(writes).toBe(0);await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  }
});
