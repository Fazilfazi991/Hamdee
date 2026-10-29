import {test,expect,type Page} from '@playwright/test';
import {startOwnerBrowserHarness} from '../support/owner-crm-harness';

let server:Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(90_000);
test.beforeEach(async()=>{server=await startOwnerBrowserHarness({migrationFiles:['006_local_operations_records.up.sql','007_local_car_rentals.up.sql','008_local_partner_records.up.sql','009_local_partner_corrections.up.sql']});});
test.afterEach(async()=>{await server.close();});
async function login(page:Page){
  await page.goto(server.url+'/login');
  await page.getByLabel('Email',{exact:true}).fill(server.fixture.inputs.email);
  await page.getByLabel('Password',{exact:true}).fill(server.fixture.inputs.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Business Overview',exact:true})).toBeVisible();
  await expect(page.locator('#daily-dashboard')).toHaveAttribute('aria-busy','false');
}
async function nav(page:Page,name:string){
  const menu=page.getByRole('button',{name:'Open navigation',exact:true});
  if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')!=='true')await menu.click();
  await page.locator('#navigation').getByRole('link',{name,exact:true}).click();
}

test('performance: hosted-shaped startup discovers capabilities without operational payloads or post-read auth fanout',async({page},info)=>{
  const paths:string[]=[];
  page.on('request',request=>{if(request.method()==='GET')paths.push(new URL(request.url()).pathname);});
  await login(page);
  await expect.poll(()=>paths.filter(p=>p==='/api/hamdee/v1/capabilities').length).toBe(1);
  for(const module of ['staff-collections','company-finance','personal-finance','car-rentals','partners'])expect(paths.filter(p=>p==='/api/hamdee/v1/'+module)).toHaveLength(0);
  const startupApiPaths=paths.filter(path=>path.startsWith('/api/hamdee/'));
  const before=paths.filter(p=>p==='/api/hamdee/auth/state').length;
  await nav(page,'Villas & Properties');
  await expect(page.getByRole('heading',{name:'Properties',exact:true})).toBeVisible();
  await expect(page.locator('#main')).toHaveAttribute('aria-busy','false');
  expect(paths.filter(p=>p==='/api/hamdee/auth/state')).toHaveLength(before);
  console.log('PERFORMANCE_REQUEST_COUNTS',JSON.stringify({project:info.project.name,startupApiGetCount:startupApiPaths.length,startupApiGetPaths:startupApiPaths,propertyNavigationApiGetCount:paths.filter(path=>path.startsWith('/api/hamdee/')).length-startupApiPaths.length}));
  await test.info().attach('request-path-counts',{body:JSON.stringify({project:info.project.name,counts:Object.fromEntries([...new Set(paths)].map(path=>[path,paths.filter(p=>p===path).length]))}),contentType:'application/json'});
});

test('performance: a held property read changes the selected section immediately and a new route stays usable',async({page})=>{
  await login(page);
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>entered=r);
  await page.route('**/api/hamdee/v1/properties?*',async route=>{entered();await gate;await route.continue().catch(()=>{});});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await nav(page,'Villas & Properties');await seen;
    await expect(page.locator('#navigation a[href="#properties"]')).toHaveAttribute('aria-current','page');
    await expect(page.getByRole('heading',{name:'Villas & Properties',exact:true})).toBeVisible();
    await expect(page.locator('#main')).toHaveAttribute('aria-busy','true');
    await nav(page,'Dashboard');
    await expect(page.getByRole('heading',{name:'Business Overview',exact:true})).toBeVisible();
    await expect(page.locator('#daily-dashboard')).toHaveAttribute('aria-busy','false');
  }finally{release();await page.unroute('**/api/hamdee/v1/properties?*');}
  expect(errors).toEqual([]);
});
