import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {PropertyApi} from '../public/workspace/adapter.js';

// Real logout controller and HTTP adapter; tiny browser/transport stubs only.
// No PGlite, hosted session, credential, financial write or provider is used.
const app=await readFile(new URL('../public/workspace/app.js',import.meta.url),'utf8');
const logoutSource=app.slice(app.indexOf('async function logout(){'),app.indexOf('async function refreshProof(){'));
const originalFetch=globalThis.fetch,originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
test.after(()=>{globalThis.fetch=originalFetch;if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');});
function failure(code:string,status:number){return Response.json({error:{code,message:code}},{status});}
function fixture(options:{race?:number;logoutFailure?:'provider'|'network'|'invalid-state';stateFailure?:boolean;anonymous?:boolean;anonymousOnRetry?:boolean;gate?:Promise<void>}={}){
 const api=new PropertyApi(),events:string[]=[],main={innerHTML:''},facts={states:0,posts:0,providerCalls:0,revoked:false,owner:!options.anonymous,proof:'cookie-newer-than-js',redirects:[] as string[],failure:null as null|{title:string;message:string}};
 const state=()=>({state:facts.owner?'authenticated':'anonymous',csrfToken:facts.proof,expiresAt:facts.owner?Date.now()+60_000:null,factors:[]});
 Object.defineProperty(globalThis,'window',{configurable:true,value:{AbortController,setTimeout,clearTimeout}});
 globalThis.fetch=async(resource,init)=>{
  const pathname=String(resource);assert.equal(init?.cache,'no-store');assert.equal(init?.credentials,'same-origin');
  if(pathname==='/api/hamdee/auth/state'){
   events.push('GET state');facts.states++;assert(events.includes('clear protected'));
   if(options.gate)await options.gate;
   if(options.stateFailure)return failure('AUTH_UNAVAILABLE',503);
   if(options.anonymousOnRetry&&facts.states===2)facts.owner=false;
   facts.proof='fresh-proof-'+facts.states;return Response.json({data:state()});
  }
  assert.equal(pathname,'/api/hamdee/auth/logout');events.push('POST logout');facts.posts++;
  assert.match(main.innerHTML,/Signing out/,'Protected UI stays cleared during proof renewal and mutation');
  const supplied=new Headers(init?.headers).get('X-Hamdee-CSRF');
  if((options.race||0)>=facts.posts)facts.proof='late-cookie-'+facts.posts;
  if(supplied!==facts.proof)return failure('CSRF_REJECTED',403);
  if(options.logoutFailure==='network')throw new TypeError('Synthetic connection interrupted');
  facts.providerCalls++;
  if(options.logoutFailure==='provider'){facts.owner=false;return failure('SIGN_OUT_UNCONFIRMED',503);}
  if(options.logoutFailure==='invalid-state')return Response.json({data:state()});
  facts.revoked=true;facts.owner=false;facts.proof='anonymous-proof';return Response.json({data:state()});
 };
 const context={api,authGeneration:0,managed:true,recoveryView:false,authController:null as AbortController|null,window:{AbortController},
  $:(selector:string)=>{assert.equal(selector,'#main');return main;},
  clearProtected:()=>{events.push('clear protected');context.authGeneration++;api.csrfToken=null;},
  accountBusy:(busy:boolean)=>events.push('busy '+busy),
  rememberAccess:(value:unknown)=>{events.push('remember final access');api.rememberState(value);},
  renderAccess:(message:string)=>{events.push(message);facts.redirects.push('/login');},
  showUnavailable:(title:string,message:string)=>{facts.failure={title,message};events.push('unconfirmed');}
 };
 api.csrfToken='stale-js-proof';
 const logout=runInNewContext('('+logoutSource+')',context) as ()=>Promise<void>;
 return {api,facts,events,context,logout};
}

test('Logout always renews stale CSRF after clearing protected reads, then confirms one managed logout',async()=>{
 const f=fixture();await f.logout();assert.deepEqual(f.events.filter(x=>x.startsWith('GET')||x.startsWith('POST')),['GET state','POST logout']);
 assert.equal(f.events[0],'clear protected');assert.equal(f.facts.providerCalls,1);assert.equal(f.facts.revoked,true);assert.deepEqual(f.facts.redirects,['/login']);assert.equal(f.facts.failure,null);
 assert(f.events.indexOf('remember final access')>f.events.indexOf('POST logout'));assert(f.events.includes('You have signed out.'));
});
test('A late rotating read permits exactly one known-pre-mutation CSRF renewal and logout retry',async()=>{
 const f=fixture({race:1});await f.logout();assert.equal(f.facts.posts,2);assert.equal(f.facts.states,2);assert.equal(f.facts.providerCalls,1);assert.equal(f.facts.revoked,true);
 assert.deepEqual(f.events.filter(x=>x.startsWith('GET')||x.startsWith('POST')),['GET state','POST logout','GET state','POST logout']);
});
test('Persistent CSRF rejection stops after one safe retry without claiming provider revocation',async()=>{
 const f=fixture({race:2});await f.logout();assert.equal(f.facts.posts,2);assert.equal(f.facts.states,2);assert.equal(f.facts.providerCalls,0);assert.equal(f.facts.revoked,false);assert.deepEqual(f.facts.redirects,[]);
 assert.equal(f.facts.failure?.title,'Unable to confirm sign-out');assert.match(f.facts.failure?.message||'',/Global sign-out has not been confirmed/);
});
for(const kind of ['provider','network','invalid-state'] as const)test('Logout does not automatically retry '+kind+' uncertainty or restore owner UI',async()=>{
 const f=fixture({logoutFailure:kind});await f.logout();assert.equal(f.facts.posts,1);assert.equal(f.facts.states,1);assert.equal(f.facts.revoked,false);assert.deepEqual(f.facts.redirects,[]);assert(f.facts.failure);assert(!f.events.includes('remember final access'));
 if(kind==='provider')assert.equal(f.facts.failure.title,'Sign-out unconfirmed');
});
test('Failed fresh-state preflight never posts logout or restores protected state',async()=>{
 const f=fixture({stateFailure:true});await f.logout();assert.equal(f.facts.posts,0);assert.equal(f.facts.providerCalls,0);assert.deepEqual(f.facts.redirects,[]);assert(f.facts.failure);assert(!f.events.includes('remember final access'));
});
test('Anonymous fresh state opens login without claiming that a managed provider logout ran',async()=>{
 const f=fixture({anonymous:true});await f.logout();assert.equal(f.facts.posts,0);assert.equal(f.facts.providerCalls,0);assert.deepEqual(f.facts.redirects,['/login']);assert(!f.events.includes('You have signed out.'));assert(!f.events.includes('remember final access'));
});
test('A session lost during the one CSRF renewal never performs an anonymous logout as false global confirmation',async()=>{
 const f=fixture({race:1,anonymousOnRetry:true});await f.logout();assert.equal(f.facts.posts,1);assert.equal(f.facts.providerCalls,0);assert.deepEqual(f.facts.redirects,['/login']);assert(!f.events.includes('You have signed out.'));
});
test('A late fresh proof after generation change cannot post logout or repopulate private access',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const f=fixture({gate}),pending=f.logout();
 await Promise.resolve();f.context.authGeneration++;release();await pending;assert.equal(f.facts.posts,0);assert.deepEqual(f.facts.redirects,[]);assert(!f.events.includes('remember final access'));
});
