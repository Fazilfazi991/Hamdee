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
    try{const response=await fetch(origin+'/workspace/index.html',{signal:AbortSignal.timeout(1000)});ready=response.status===200;if(ready)break;}catch{/* Await owned startup only. */}
    await setTimeout(100);
  }
  assert.equal(ready,true,'Owned Next server startup timed out');
  const page=await fetch(origin+'/workspace/index.html');assert.equal(page.status,200);assert.match(await page.text(),/PRODUCTION DEVELOPMENT/);
  const rentalAsset=await fetch(origin+'/workspace/rental.js');assert.equal(rentalAsset.status,200);
  const expenseAsset=await fetch(origin+'/workspace/expenses.js');assert.equal(expenseAsset.status,200);
  for(const path of ['/api/hamdee/v1/properties','/api/hamdee/v1/rental','/api/hamdee/v1/expenses'])for(const method of ['GET','POST','PATCH','DELETE']){
    const response=await fetch(origin+path,{method,headers:{Authorization:'Bearer synthetic-test-bypass-must-fail',Origin:origin}});
    assert.equal(response.status,503);assert.equal((await response.json()).error.code,'CONFIGURATION_UNAVAILABLE');
    assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  }
  console.log('PASS: built Next runtime; UI/rental/expense modules 200; property/rental/expense GET/POST/PATCH/DELETE remain 503 despite test-auth/shared-venture variables. 15 HTTP response checks.');
}finally{
  child.kill();await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('exit',resolve);});
}
