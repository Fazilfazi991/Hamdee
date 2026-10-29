import {test} from 'node:test';
import assert from 'node:assert/strict';
// Adapter uses browser timers and AbortController; no DOM or real network.
if(!('window' in globalThis))Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});
const adapterUrl = new URL('../public/workspace/adapter.js', import.meta.url).href;
const {PropertyApi} = await import(adapterUrl);
const reply=()=>new Response(JSON.stringify({data:{synthetic:true}}),{status:200,headers:{'Content-Type':'application/json'}});
const gate=()=>{let resolve!:(value:Response)=>void;const promise=new Promise<Response>(r=>resolve=r);return {promise,resolve};};

test('frontend: identical outstanding GETs share one request only within the route signal',async t=>{
  const pending=gate();let calls=0;
  t.mock.method(globalThis,'fetch',()=>{calls++;return pending.promise.then(response=>response.clone());});
  const api=new PropertyApi(),signal=new AbortController().signal;
  const first=api.rentalRead({month:'2026-11',asOf:'2026-11-01'},signal);
  const second=api.rentalRead({month:'2026-11',asOf:'2026-11-01'},signal);
  assert.equal(calls,1);pending.resolve(reply());assert.deepEqual(await first,await second);
  const next=api.rentalRead({month:'2026-11',asOf:'2026-11-01'},signal);
  assert.equal(calls,2);await next;
});

test('frontend: separate route signals and explicit session clearing never share private reads',async t=>{
  const pending=gate();let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;return pending.promise.then(response=>response.clone());});
  const api=new PropertyApi(),one=new AbortController().signal,two=new AbortController().signal;
  const requests=[api.dashboard(one),api.dashboard(two)];assert.equal(calls,2);
  api.clearReads();requests.push(api.dashboard(one));assert.equal(calls,3);
  pending.resolve(reply());await Promise.all(requests);
});

test('frontend: a mutation invalidates outstanding reads before refresh, preserving fresh financial responses',async t=>{
  const pending=gate();let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;return pending.promise.then(response=>response.clone());});
  const api=new PropertyApi(),signal=new AbortController().signal;
  const stale=api.dashboard(signal),write=api.rentalWrite({action:'synthetic'},'synthetic-idempotency-key',signal),fresh=api.dashboard(signal);
  assert.equal(calls,3);pending.resolve(reply());await Promise.all([stale,write,fresh]);
});

test('frontend: coalescing forwards the original cancellation signal and aborted routes start no reusable read',async t=>{
  let calls=0;const controller=new AbortController();
  t.mock.method(globalThis,'fetch',(_url:string,options:RequestInit)=>{calls++;assert.equal(options.signal?.aborted,true);return Promise.reject(new DOMException('Aborted','AbortError'));});
  const api=new PropertyApi();controller.abort();
  await assert.rejects(api.dashboard(controller.signal),{name:'AbortError'});
  await assert.rejects(api.dashboard(controller.signal),{name:'AbortError'});assert.equal(calls,2);
});

test('frontend: successful verified response projects access without another request; cleared or aborted reads cannot renew state',async t=>{
  const pending=gate();let calls=0,renewals=0;
  t.mock.method(globalThis,'fetch',()=>{calls++;return pending.promise.then(response=>response.clone());});
  const api=new PropertyApi(),controller=new AbortController();api.onAccessState=()=>renewals++;
  const read=api.dashboard(controller.signal);api.clearReads();
  const headers={'Content-Type':'application/json','X-Hamdee-CSRF':'synthetic-proof','X-Hamdee-Session-Expires-At':'2000000000000'};
  pending.resolve(new Response(JSON.stringify({data:{synthetic:true}}),{headers}));
  const result=await read;assert.equal(renewals,0);assert.equal(result.access.expiresAt,2000000000000);
  await api.dashboard(new AbortController().signal);assert.equal(renewals,1);assert.equal(calls,2);
  const aborted=api.dashboard(controller.signal);controller.abort();await aborted;assert.equal(renewals,1);
});

test('frontend: delayed older access projection cannot shorten the active deadline or replace its proof',async t=>{
  const older=gate(),newer=gate(),seen:{expiresAt:number;csrfToken:string}[]=[];
  t.mock.method(globalThis,'fetch',(url:string)=>url.endsWith('/dashboard')?older.promise:newer.promise);
  const api=new PropertyApi();api.onAccessState=(state:{expiresAt:number;csrfToken:string})=>seen.push(state);
  const signal=new AbortController().signal,first=api.dashboard(signal),second=api.session(signal);
  const response=(expiresAt:string,proof:string)=>new Response(JSON.stringify({data:{synthetic:true}}),{headers:{'Content-Type':'application/json','X-Hamdee-CSRF':proof,'X-Hamdee-Session-Expires-At':expiresAt}});
  newer.resolve(response('2000000000100','synthetic-newer-proof'));await second;
  older.resolve(response('2000000000000','synthetic-older-proof'));await first;
  assert.deepEqual(seen,[{state:'authenticated',expiresAt:2000000000100,csrfToken:'synthetic-newer-proof',factors:[]}]);
  api.clearReads();assert.equal(api.accessDeadline,0);
});

test('frontend: explicit session renewal fences an older pending business response',async t=>{
  const pending=gate();let renewals=0;t.mock.method(globalThis,'fetch',()=>pending.promise);
  const api=new PropertyApi();api.onAccessState=()=>renewals++;
  const request=api.dashboard(new AbortController().signal);
  api.rememberState({state:'authenticated',csrfToken:'synthetic-explicit-proof',expiresAt:2000000000100,factors:[]});
  pending.resolve(new Response(JSON.stringify({data:{synthetic:true}}),{headers:{'Content-Type':'application/json','X-Hamdee-CSRF':'synthetic-older-proof','X-Hamdee-Session-Expires-At':'2000000000000'}}));
  await request;assert.equal(renewals,0);assert.equal(api.accessDeadline,2000000000100);assert.equal(api.csrfToken,'synthetic-explicit-proof');
});
