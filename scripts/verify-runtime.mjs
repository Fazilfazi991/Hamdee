import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
const root=fileURLToPath(new URL('../',import.meta.url));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const child=spawn(process.execPath,[fileURLToPath(new URL('../node_modules/next/dist/bin/next',import.meta.url)),'start','--hostname','127.0.0.1','--port',String(port)],{
  cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,HAMDEE_TEST_AUTH:'admin',SUPABASE_URL:'https://other-venture.invalid',DATABASE_URL:'postgres://unapproved.invalid/other_venture'}
});
const origin='http://127.0.0.1:'+port;
try{
  let ready=false;for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw new Error('Owned Next server did not start');
    try{const response=await fetch(origin+'/login',{signal:AbortSignal.timeout(1000)});ready=response.status===200;if(ready)break;}catch{/* Await owned startup only. */}
    await setTimeout(100);
  }
  assert.equal(ready,true,'Owned Next server startup timed out');
  const page=await fetch(origin+'/login');assert.equal(page.status,200);const login=await page.text();assert.match(login,/id="login-form"/);assert.doesNotMatch(login,/id="sidebar"|id="navigation"|Company Finance|Staff Collections/);
  const workspace=await fetch(origin+'/workspace/index.html',{redirect:'manual'});assert.equal(workspace.status,503);assert.match(workspace.headers.get('cache-control'),/no-store/);assert.doesNotMatch(await workspace.text(),/id="sidebar"/);
  const loginAsset=await fetch(origin+'/login.js');assert.equal(loginAsset.status,200);
  const dailyAsset=await fetch(origin+'/workspace/daily-dashboard.js');assert.equal(dailyAsset.status,200);
  const rentalAsset=await fetch(origin+'/workspace/rental.js');assert.equal(rentalAsset.status,200);
  const expenseAsset=await fetch(origin+'/workspace/expenses.js');assert.equal(expenseAsset.status,200);
  const partnerAsset=await fetch(origin+'/workspace/partners.js');assert.equal(partnerAsset.status,200);
  for(const path of ['/api/hamdee/v1/properties','/api/hamdee/v1/rental','/api/hamdee/v1/expenses','/api/hamdee/v1/partners','/api/hamdee/v1/partners/commands','/api/hamdee/v1/operations-dashboard'])for(const method of ['GET','POST','PATCH','DELETE']){
    const response=await fetch(origin+path,{method,headers:{Authorization:'Bearer synthetic-test-bypass-must-fail',Origin:origin}});
    assert.equal(response.status,503);assert.equal((await response.json()).error.code,'CONFIGURATION_UNAVAILABLE');
    assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  }
  console.log('PASS: built Next runtime; standalone login and public assets 200 without workspace navigation; unconfigured workspace503/no-store; six protected API paths across four methods remain503. 31 HTTP response checks.');
}finally{
  child.kill();await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('exit',resolve);});
}
