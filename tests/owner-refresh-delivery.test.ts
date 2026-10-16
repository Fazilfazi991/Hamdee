import {test,before,after,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {ApiError} from '../src/errors';
import type {OwnerProviderSession} from '../src/owner-auth';
import {createOwnerQaFixture,ownerProviderFake,ownerQaClock,ownerQaInputs,OTHER_QA_SUBJECT} from './support/owner-crm-harness';

// Synthetic model of the documented provider contract, not hosted acceptance:
// atomic rotation, ten-second reuse, active-parent returns current child, and
// global termination for an older token reused outside those exceptions.
interface RefreshNode {session:OwnerProviderSession;parent:RefreshNode|null;usedAt:number|null}
function rotatingProvider(clock:ReturnType<typeof ownerQaClock>){
  const fake=ownerProviderFake(clock),original=fake.provider,nodes=new Map<string,RefreshNode>();
  let active:RefreshNode|null=null,revoked=false,calls=0,rotations=0,revokeAt=Infinity,tail=Promise.resolve();
  function serial<T>(work:()=>Promise<T>){const pending=tail.then(work);tail=pending.then(()=>undefined,()=>undefined);return pending;}
  const current=(session:OwnerProviderSession):OwnerProviderSession=>({...structuredClone(session),
    identity:{issuer:fake.facts.wrongIssuer?'https://other.invalid/auth/v1':ownerQaInputs().issuer,subject:fake.facts.subject},
    email:fake.facts.email,emailConfirmed:fake.facts.emailConfirmed,passwordAuthenticatedAt:fake.facts.passwordAuthenticatedAt,
    expiresAt:clock.now()+ownerQaInputs().tokenMilliseconds});
  const rotate=(session:OwnerProviderSession)=>{const node={session,parent:active,usedAt:null};nodes.set(session.tokens.refreshToken,node);active=node;rotations++;return current(session);};
  fake.provider={...original,
    signIn(email,password){return serial(async()=>{nodes.clear();active=null;revoked=false;calls=0;rotations=0;revokeAt=Infinity;
      return rotate(await original.signIn(email,password));});},
    verifySession(tokens){return serial(async()=>{
      calls++;if(calls===revokeAt)revoked=true;
      if(revoked)throw new ApiError(401,'UNAUTHENTICATED','Synthetic managed session revoked.');
      if(fake.facts.unavailable)throw new ApiError(503,'AUTH_UNAVAILABLE','Synthetic provider unavailable.');
      const input=nodes.get(tokens.refreshToken);
      if(!input||!active)throw new ApiError(401,'UNAUTHENTICATED','Synthetic unknown refresh token.');
      if(input===active){input.usedAt=clock.now();return rotate(await original.verifySession(tokens));}
      if(input===active.parent||(input.usedAt!==null&&clock.now()-input.usedAt<10_000))return current(active.session);
      revoked=true;throw new ApiError(401,'UNAUTHENTICATED','Synthetic reuse termination.');
    });},
    signOut(tokens){return serial(async()=>{await original.signOut(tokens);revoked=true;});}
  };
  return {fake,snapshot:()=>({calls,rotations,revoked}),revokeAtNextMutationCommit:()=>{revokeAt=calls+3;}};
}
let networkCalls=0;
const originalFetch=globalThis.fetch,originalConnect=net.Socket.prototype.connect;
before(()=>{
  globalThis.fetch=async()=>{networkCalls++;throw new Error('Offline provider only.');};
  net.Socket.prototype.connect=function(){networkCalls++;throw new Error('Offline PGlite only.');};
});
after(()=>{globalThis.fetch=originalFetch;net.Socket.prototype.connect=originalConnect;assert.equal(networkCalls,0);});
const base='/api/hamdee/v1',revision=(id:string,version:number)=>`"property:${id}:${version}"`;
async function fixture(t:TestContext){
  const clock=ownerQaClock(ownerQaInputs().time),model=rotatingProvider(clock);
  const f=await createOwnerQaFixture({clock,provider:model.fake,timings:{idleTimeoutMs:120_000,absoluteTimeoutMs:600_000,csrfLifetimeMs:60_000}});
  t.after(async()=>{if(!f.pg!.closed)await f.close();});await f.login();return {f,model};
}
async function value(r:Response,status:number){const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
async function create(f:Awaited<ReturnType<typeof createOwnerQaFixture>>){
  return (await value(await f.request('POST',base+'/properties',{name:'Synthetic delivery property'},{'Idempotency-Key':randomUUID()}),201)).data as {id:string;version:number};
}
function patch(f:Awaited<ReturnType<typeof createOwnerQaFixture>>,id:string,name:string){
  return new Request(f.options.policy.origin+base+'/properties/'+id,{method:'PATCH',body:JSON.stringify({name}),headers:{Cookie:f.jar.header(),
    Origin:f.options.policy.origin,'Content-Type':'application/json','X-Hamdee-CSRF':f.jar.csrfToken,'Idempotency-Key':randomUUID(),
    'X-Hamdee-Property-Revision':revision(id,1)}});
}
async function stored(f:Awaited<ReturnType<typeof createOwnerQaFixture>>,id:string){
  return {version:(await f.pg!.query<{version:number}>('SELECT version FROM hamdee_private.properties WHERE id=$1',[id])).rows[0].version,
    audit:(await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.audit_events WHERE property_id=$1',[id])).rows[0].n,
    commands:(await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.commands WHERE property_id=$1',[id])).rows[0].n};
}

test('Delivery model: active-parent retry survives outside10s; grandparent reuse terminates the entire session',async()=>{
  const inputs=ownerQaInputs(),clock=ownerQaClock(inputs.time),m=rotatingProvider(clock);
  const first=await m.fake.provider.signIn(inputs.email,inputs.password),child=await m.fake.provider.verifySession(first.tokens);
  clock.advance(10_001);const retry=await m.fake.provider.verifySession(first.tokens);assert.deepEqual(retry.tokens,child.tokens);assert.equal(m.snapshot().rotations,2);
  await m.fake.provider.verifySession(child.tokens);clock.advance(10_001);
  await assert.rejects(()=>m.fake.provider.verifySession(first.tokens),{code:'UNAUTHENTICATED'});assert.equal(m.snapshot().revoked,true);
  await assert.rejects(()=>m.fake.provider.verifySession(child.tokens),{code:'UNAUTHENTICATED'});
});

test('Delivery: lost committed PATCH has three live checks but one rotation; a fresh request after10s recovers',async t=>{
  const {f,model}=await fixture(t),p=await create(f),cookie=f.jar.header(),before=model.snapshot();
  const lost=await f.app().handleProperties(patch(f,p.id,'Synthetic committed edit'));
  assert.equal((await value(lost,200)).data.version,2);assert.equal(f.jar.header(),cookie); // Deliberately discard Set-Cookie.
  const during=model.snapshot();assert.equal(during.calls-before.calls,3);assert.equal(during.rotations-before.rotations,1);
  assert.deepEqual(await stored(f,p.id),{version:2,audit:2,commands:2});
  f.clock.advance(10_001);const state=await value(await f.auth('GET','state'),200);assert.equal(state.data.state,'authenticated');assert.equal(model.snapshot().revoked,false);
  await value(await f.request('GET',base+'/dashboard'),200);
});

test('Delivery: concurrent same-cookie revisions retain one provider generation and one database mutation',async t=>{
  const {f,model}=await fixture(t),p=await create(f),before=model.snapshot();
  const first=patch(f,p.id,'Synthetic concurrent A'),second=patch(f,p.id,'Synthetic concurrent B');
  const responses=await Promise.all([f.app().handleProperties(first),f.app().handleProperties(second)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,412]);assert.deepEqual(await stored(f,p.id),{version:2,audit:2,commands:2});
  assert.equal(model.snapshot().rotations-before.rotations,1);assert.ok(model.snapshot().calls-before.calls>=5);
  f.clock.advance(10_001);assert.equal((await value(await f.auth('GET','state'),200)).data.state,'authenticated');
});

test('Delivery: fresh precommit provider revocation still rejects and rolls back record, audit and command',async t=>{
  const {f,model}=await fixture(t),p=await create(f),before=model.snapshot();model.revokeAtNextMutationCommit();
  await value(await f.app().handleProperties(patch(f,p.id,'Synthetic revoked edit')),401);
  assert.equal(model.snapshot().calls-before.calls,3);assert.equal(model.snapshot().revoked,true);
  assert.deepEqual(await stored(f,p.id),{version:1,audit:1,commands:1});
});

test('Delivery: wrong owner, CSRF, expiry, logout and recovery continue denying protected access',async t=>{
  for(const mode of ['owner','csrf','expiry','logout','recovery'] as const){
    const {f,model}=await fixture(t),p=await create(f),before=await stored(f,p.id);
    if(mode==='owner'){
      f.fake.facts.subject=OTHER_QA_SUBJECT;await value(await f.app().handleProperties(patch(f,p.id,'Synthetic denied owner')),403);
    }else if(mode==='csrf'){
      const req=patch(f,p.id,'Synthetic denied CSRF');req.headers.set('X-Hamdee-CSRF','');const calls=model.snapshot().calls;
      await value(await f.app().handleProperties(req),403);assert.equal(model.snapshot().calls,calls);
    }else if(mode==='expiry'){
      f.clock.advance(120_000);const calls=model.snapshot().calls;await value(await f.request('GET',base+'/dashboard'),401);assert.equal(model.snapshot().calls,calls);
    }else{
      const copied=f.jar.fork();await value(await f.auth('POST',mode,mode==='recovery'?{email:f.inputs.email}:{}),mode==='recovery'?202:200);
      await value(await f.request('GET',base+'/dashboard',undefined,{},copied),401);assert.equal(model.snapshot().revoked,true);
    }
    assert.deepEqual(await stored(f,p.id),before);await f.close();
  }
});

test('Delivery: oversized owner PATCH returns413 promptly with no mutation or unread-body clone hang',{timeout:15_000},async t=>{
  const {f,model}=await fixture(t),p=await create(f),before=await stored(f,p.id),checks=model.snapshot().calls;
  const r=await f.request('PATCH',base+'/properties/'+p.id,{name:'x'.repeat(17_000)},
    {'Idempotency-Key':randomUUID(),'X-Hamdee-Property-Revision':revision(p.id,1)});
  const denied=await value(r,413);assert.equal(denied.error.code,'PAYLOAD_TOO_LARGE');assert.equal(r.headers.get('Cache-Control'),'private, no-store');
  assert.deepEqual(await stored(f,p.id),before);assert.ok(model.snapshot().calls>checks);
});
