import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerPageAccess } from '../src/owner-page-access';
import { createOwnerQaFixture } from './support/owner-crm-harness';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from '../proxy';
import nextConfiguration from '../next.config.mjs';

const origin='https://synthetic-hamdee.example.invalid';
const request=(path:string,cookie='')=>new Request(origin+path,{headers:{Cookie:cookie}});
const state=(phase='anonymous')=>Response.json({data:{state:phase,csrfToken:'SYNTHETIC_CSRF',
  expiresAt:phase==='authenticated'?Date.now()+10000:null,factors:[]}});

test('Owner page routing: internal login rewrite target and APIs never rematch the proxy',()=>{
  for(const url of ['/login','/workspace/index.html'])assert.equal(unstable_doesMiddlewareMatch({config,url}),true);
  for(const url of ['/login.html','/login.js','/login.css','/api/hamdee/auth/state','/api/hamdee/v1/properties'])
    assert.equal(unstable_doesMiddlewareMatch({config,url}),false);
});
test('Owner page routing: static HTML responses preserve private no-store at the filesystem layer',async()=>{
  const routes=await nextConfiguration.headers();
  for(const source of ['/login','/login.html','/workspace','/workspace/index.html']){
    const route=routes.find(entry=>entry.source===source);assert.ok(route,source);
    assert.match(route.headers.find(header=>header.key==='Cache-Control')?.value??'',/private, no-store/);
    assert.equal(route.headers.find(header=>header.key==='Vary')?.value,'Cookie');
  }
});

test('Owner page routing: forged cookie presence never opens workspace',async()=>{
  let checked=0;
  const decision=await ownerPageAccess(request('/workspace/index.html?next=https://other.invalid','hamdee_owner=SYNTHETIC_FORGED'),async input=>{
    checked++;assert.equal(new URL(input.url).pathname,'/api/hamdee/auth/state');
    assert.equal(new URL(input.url).search,'');assert.equal(input.headers.get('cookie'),'hamdee_owner=SYNTHETIC_FORGED');
    return state();
  });
  assert.equal(checked,1);assert.equal(decision.kind,'redirect-login');
  assert.match(decision.headers.get('Cache-Control')! ,/private, no-store/);
  assert.equal(decision.headers.get('Vary'),'Cookie');
});
test('Owner page routing: authenticated login goes to workspace; anonymous login remains reachable',async()=>{
  assert.equal((await ownerPageAccess(request('/login'),async()=>state('authenticated'))).kind,'redirect-workspace');
  assert.equal((await ownerPageAccess(request('/login'),async()=>state())).kind,'login');
  assert.equal((await ownerPageAccess(request('/workspace/index.html'),async()=>state('authenticated'))).kind,'workspace');
  assert.equal((await ownerPageAccess(request('/'),async()=>state('authenticated'))).kind,'redirect-workspace');
});
test('Owner page routing: failures close workspace without login redirect loops',async()=>{
  for(const status of [429,500,503]){
    const handler=async()=>Response.json({error:{code:'SYNTHETIC_UNAVAILABLE'}},{status});
    assert.equal((await ownerPageAccess(request('/workspace/index.html'),handler)).kind,'unavailable');
    assert.equal((await ownerPageAccess(request('/login'),handler)).kind,'login');
  }
  for(const payload of [{data:{state:'authenticated',csrfToken:'x',expiresAt:null}},
    {data:{state:'unknown',csrfToken:'x'}},null])
    assert.equal((await ownerPageAccess(request('/workspace/index.html'),async()=>Response.json(payload))).kind,'unavailable');
  assert.equal((await ownerPageAccess(request('/workspace/index.html'),async()=>{throw new Error('SYNTHETIC_OUTAGE');})).kind,'unavailable');
});
test('Owner page routing: refresh and clearing cookies retain separate Set-Cookie lines',async()=>{
  const lines=['hamdee_owner=SYNTHETIC_SEALED; Path=/; HttpOnly; SameSite=Strict; Secure',
    'hamdee_csrf=SYNTHETIC_CSRF; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; Secure'];
  const decision=await ownerPageAccess(request('/login'),async()=>{
    const response=state('authenticated');for(const line of lines)response.headers.append('Set-Cookie',line);return response;
  });
  assert.deepEqual(decision.headers.getSetCookie(),lines);
  const denied=await ownerPageAccess(request('/workspace/index.html'),async()=>{
    const response=Response.json({error:{code:'UNAUTHENTICATED'}},{status:401});
    response.headers.append('Set-Cookie','hamdee_owner=; Path=/; Max-Age=0; HttpOnly');return response;
  });
  assert.equal(denied.kind,'redirect-login');assert.equal(denied.headers.getSetCookie().length,1);
});
test('Owner page routing: unsafe page method never invokes authentication',async()=>{
  let calls=0;const decision=await ownerPageAccess(new Request(origin+'/login',{method:'POST'}),async()=>{calls++;return state();});
  assert.equal(decision.kind,'method-not-allowed');assert.equal(calls,0);
});
test('Owner page routing: real owner state, logout, expiry and disabled binding remain authoritative',async t=>{
  const fixture=await createOwnerQaFixture();t.after(()=>fixture.close());
  const page=(path:string)=>new Request(fixture.options.policy.origin+path,{headers:{Cookie:fixture.jar.header()}});
  const handler=fixture.app().handleAuth;
  assert.equal((await ownerPageAccess(page('/workspace/index.html'),handler)).kind,'redirect-login');
  const api=await fixture.request('GET','/api/hamdee/v1/dashboard');
  assert.equal(api.status,401);assert.equal(api.headers.has('Location'),false);
  await fixture.login();
  assert.equal((await ownerPageAccess(page('/login'),handler)).kind,'redirect-workspace');
  assert.equal((await ownerPageAccess(page('/workspace/index.html'),handler)).kind,'workspace');
  await fixture.auth('POST','logout',{});
  assert.equal((await ownerPageAccess(page('/workspace/index.html'),handler)).kind,'redirect-login');
  await fixture.login();fixture.clock.advance(fixture.inputs.idleMilliseconds);
  const expired=await ownerPageAccess(page('/workspace/index.html'),handler);
  assert.equal(expired.kind,'redirect-login');assert.ok(expired.headers.getSetCookie().some(line=>line.includes('Max-Age=0')));
  await fixture.login();
  await fixture.pg!.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[fixture.member!.id]);
  assert.equal((await ownerPageAccess(page('/workspace/index.html'),handler)).kind,'redirect-login');
});
