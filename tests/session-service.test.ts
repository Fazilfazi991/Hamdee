import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSessionService,SessionServiceError,type SessionIssued,type SessionServiceOptions,
  type StoredServiceSession,type SubjectSecuritySnapshot,type LoginChallengeRecord } from '../src/security/session-service';
import { createCsrfProtector } from '../src/security/csrf';
import { createTokenEnvelope } from '../src/security/token-envelope';
import type { IdentityBinding,MembershipSnapshot,SecurityAuditEvent,SecurityResult,ServerTokenPair,VerifiedIdentity } from '../src/security/contracts';
import type { SessionPolicy } from '../src/security/session-policy';

// Agent 1 local test doubles: deterministic and synthetic, never runtime ports.
const origin='https://cp2-local.hamdee.invalid',subject='11111111-2222-4333-8444-555555555555',providerSessionId='66666666-7777-4888-8999-aaaaaaaaaaaa';
const binding:IdentityBinding={provider:'supabase',appId:'hamdee',environment:'development',dataClass:'synthetic_only',projectRef:'zyxwvutsrqponmlkjihg',issuer:'https://zyxwvutsrqponmlkjihg.supabase.co/auth/v1',audience:'authenticated'};
const ok=<T>(value:T):SecurityResult<T>=>({ok:true,value});
const unavailable=():SecurityResult<never>=>({ok:false,failure:'unavailable'});
const copy=<T>(value:T):T=>structuredClone(value);
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
async function entered(condition:()=>boolean){for(let i=0;i<1000&&!condition();i++)await Promise.resolve();assert.equal(condition(),true,'Fake port must be entered before changing the synthetic world');}
async function denied(work:()=>Promise<unknown>,code?:string){await assert.rejects(work,error=>error instanceof SessionServiceError&&(!code||error.code===code));}
function fixture(initialTime=500_000,admin=false,mfa=false){
  const flow={bounds:5,window:1_000,backoff:250};
  const policy:SessionPolicy={idleTimeout:20_000,absoluteTimeout:120_000,jwtLifetime:12_000,refreshLead:4_000,refreshLease:2_000,clockTolerance:100,stepUpMaxAge:8_000,
    allowedOrigins:[origin],redirectAllowlist:[origin+'/auth/callback'],logoutScope:'local',trustedProxyPolicy:{mode:'none'},
    limits:{login:{...flow},refresh:{...flow},mfa:{...flow},recovery:{...flow},invitation:{...flow},write:{...flow}},
    mfa:{administratorRequired:true,requireLiveAdminSession:true,otherRoles:'optional',factor:'totp',stepUpActions:['membership_change','factor_change','recovery_approval','administrator_activation']},disablementBoundary:'recheck_at_commit'};
  const identity:VerifiedIdentity={binding:copy(binding),subject,providerSessionId,issuedAt:initialTime,notBefore:initialTime,expiresAt:initialTime+policy.jwtLifetime,
    assurance:mfa?'aal2':'aal1',mfaVerifiedAt:mfa?initialTime:null,factorVerified:mfa,status:'active',liveSessionStatus:'active'};
  const membership:MembershipSnapshot={issuer:binding.issuer,subject,enabled:true,revision:1,grants:[{role:admin?'admin':'operations',scope:{kind:'portfolio'}}]};
  const state={now:initialTime,identity,tokens:{accessToken:'SYNTHETIC_CP2_ACCESS',refreshToken:'SYNTHETIC_CP2_REFRESH'} as ServerTokenPair,
    subject:{membership,epoch:0,recoveryPending:false} as SubjectSecuritySnapshot,storeAvailable:true,auditAvailable:true,providerAvailable:true,
    limiterAvailable:true,allowed:true,conflict:false,revokeAvailable:true,refreshCalls:0,verifyCalls:0,casCalls:0,subjectInvalidations:0,
    events:[] as SecurityAuditEvent[],refreshGate:null as Promise<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>|null,
    mfaGate:null as Promise<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>|null,mfaCalls:0,randomCounter:0};
  const records=new Map<string,StoredServiceSession>(),retired=new Set<string>(),challenges=new Map<string,LoginChallengeRecord>(),factorChallenges=new Set<string>();
  const random={bytes(length:number){const output=new Uint8Array(length);output.set(createHash('sha256').update('SYNTHETIC_DETERMINISTIC_RANDOM_'+(++state.randomCounter)).digest().subarray(0,length));return output;}};
  const append=(events:readonly SecurityAuditEvent[])=>{if(!state.auditAvailable)return false;state.events.push(...copy(events));return true;};
  const refreshed=():VerifiedIdentity=>({...copy(state.identity),issuedAt:state.now,notBefore:state.now,expiresAt:state.now+policy.jwtLifetime});
  const options:SessionServiceOptions={binding:copy(binding),policy:copy(policy),clock:{now:()=>state.now},random,
    hasher:{async hash(bytes){return createHash('sha256').update(bytes).digest('hex');}},
    envelopes:{...createTokenEnvelope({keys:{local:new Uint8Array(32).fill(7)},activeKeyVersion:'local',random})},csrf:createCsrfProtector(new Uint8Array(32).fill(8)),
    challengeLifetime:2_000,maxCasAttempts:3,
    limiter:{async consume(){return state.limiterAvailable?ok({allowed:state.allowed,retryAt:state.allowed?null:state.now+250}):unavailable();}},
    audit:{async append(events){return append(events)?ok(undefined):unavailable();}},
    subjects:{async read(){return ok(copy(state.subject));},async invalidate(input){
      if(!state.auditAvailable)return unavailable();if(input.expectedEpoch!==state.subject.epoch)return ok('conflict');
      append(input.audit);state.subjectInvalidations++;
      state.subject={...state.subject,epoch:state.subject.epoch+1,recoveryPending:state.subject.recoveryPending||input.reason==='recovery'};return ok('applied');}},
    challenges:{async create(record){if(challenges.has(record.handleHash))return ok('conflict');challenges.set(record.handleHash,copy(record));return ok('applied');},
      async consume(h,expectedOrigin,time){const found=challenges.get(h);if(!found||found.origin!==expectedOrigin||found.expiresAt<=time)return ok(false);challenges.delete(h);return ok(true);}},
    store:{async read(h){return state.storeAvailable?ok(copy(records.get(h)??null)):unavailable();},
      async create(record,events){if(!state.storeAvailable||!state.auditAvailable)return unavailable();const h=record.session.handleHash!;
        if(records.has(h)||retired.has(h)||state.conflict)return ok('conflict');append(events);records.set(h,copy(record));return ok('applied');},
      async compareAndSwap(h,version,next,events){state.casCalls++;if(!state.storeAvailable||!state.auditAvailable)return unavailable();const old=records.get(h),replacement=next.session.handleHash!;
        if(state.conflict||!old||old.session.version!==version||next.session.version!==version+1||(replacement!==h&&(records.has(replacement)||retired.has(replacement))))return ok('conflict');
        append(events);if(replacement!==h){records.delete(h);retired.add(h);}records.set(replacement,copy(next));return ok('applied');}},
    provider:{async verify(token){state.verifyCalls++;return state.providerAvailable&&token===state.tokens.accessToken?ok(copy(state.identity)):unavailable();},
      async refresh(){state.refreshCalls++;if(!state.providerAvailable)return unavailable();return state.refreshGate??ok({identity:refreshed(),tokens:copy(state.tokens)});},
      async sessionStatus(){return state.providerAvailable?ok('active'):unavailable();},async revoke(){return state.revokeAvailable?ok(undefined):unavailable();},
      async enrollFactor(){return ok({factorId:'synthetic-factor',serverOnlyEnrollmentMaterial:'SYNTHETIC_ONLY'});},
      async challengeFactor(_who,factor){if(factor!=='synthetic-factor')return {ok:false,failure:'invalid_identity'};const challengeId='challenge-'+factorChallenges.size;factorChallenges.add(challengeId);return ok({challengeId});},
      async verifyFactor(_who,challengeId,code){state.mfaCalls++;if(state.mfaGate)return state.mfaGate;if(!factorChallenges.delete(challengeId)||code!=='123456')return {ok:false,failure:'invalid_identity'};
        const who={...refreshed(),assurance:'aal2' as const,mfaVerifiedAt:state.now,factorVerified:true};state.identity=who;return ok({identity:who,tokens:copy(state.tokens)});},
      async verifyAssuranceAndFactors(who){return state.providerAvailable?ok(copy(who)):unavailable();}}
  };
  const h={options,state,records,retired,challenges,policy,refreshed,service:createSessionService(options),
    context:(csrfToken:string|null)=>({origin,csrfToken,limiterKey:'SYNTHETIC_SERVER_DERIVED_KEY'}),
    async login(){const c=await h.service.issueLoginChallenge({origin,limiterKey:'SYNTHETIC_SERVER_DERIVED_KEY'});return h.service.login({challengeHandle:c.handle,tokens:state.tokens,context:h.context(c.csrfToken)});},
    authorize:(issued:SessionIssued)=>h.service.authorize({handle:issued.handle,action:null,mutation:null}),
    mutation:(issued:SessionIssued)=>({handle:issued.handle,context:h.context(issued.csrfToken)}),
    async row(issued:SessionIssued){const hash=await options.hasher.hash(Buffer.from(issued.handle,'base64url'));return records.get(hash)!;},
    membership(changes:Partial<MembershipSnapshot>){state.subject={...state.subject,membership:{...state.subject.membership!,...copy(changes)}};}
  };
  return h;
}

test('CP2 constructor validates required configuration without calling any port',()=>{
  const h=fixture();assert.equal(h.state.verifyCalls,0);assert.equal(h.records.size,0);assert.equal(h.state.events.length,0);
  for(const maxCasAttempts of [0,-1,1.5,17,NaN])assert.throws(()=>createSessionService({...h.options,maxCasAttempts}),SessionServiceError);
  assert.throws(()=>createSessionService({...h.options,challengeLifetime:0}),SessionServiceError);
  assert.throws(()=>createSessionService({...h.options,policy:{} as SessionPolicy}),SessionServiceError);
  assert.equal(h.state.events.length,0);
});
test('CP2 login yields server-only handle and redacted immutable view; role claims are discarded',async()=>{
  const h=fixture();Object.assign(h.state.identity,{user_metadata:{role:'admin'},role:'admin',accessToken:'PRIVATE'});
  const issued=await h.login(),authorized=await h.authorize(issued);
  assert.equal(issued.handle.length,43);assert.deepEqual(Object.keys(issued.view).sort(),['absoluteExpiresAt','idleExpiresAt','state','version']);
  assert.equal(authorized.membership.grants[0].role,'operations');assert.equal(Object.hasOwn(authorized.identity,'user_metadata'),false);
  assert.ok(Object.isFrozen(authorized.membership.grants));
  assert.doesNotMatch(JSON.stringify(issued.view)+JSON.stringify(h.state.events),/SYNTHETIC_CP2_(ACCESS|REFRESH)|PRIVATE/);
  assert.ok([...h.records.values()].every(r=>!JSON.stringify(r).includes(h.state.tokens.refreshToken)));
});
test('CP2 caller tokens and context are copied before asynchronous login work',async()=>{
  const h=fixture(),gate=deferred<SecurityResult<boolean>>();let consumed=false;
  const consume=h.options.challenges.consume.bind(h.options.challenges);
  h.options.challenges.consume=async(...args)=>{consumed=true;await gate.promise;return consume(...args);};h.service=createSessionService(h.options);
  const c=await h.service.issueLoginChallenge({origin,limiterKey:'server'});
  const input={challengeHandle:c.handle,tokens:{...h.state.tokens},context:h.context(c.csrfToken)};
  const pending=h.service.login(input);await entered(()=>consumed);
  input.tokens.accessToken='MUTATED';input.tokens.refreshToken='MUTATED';input.context.origin='https://wrong.invalid';input.challengeHandle='wrong';
  gate.resolve(ok(true));const issued=await pending;await h.authorize(issued);
  const stored=await h.row(issued);assert.deepEqual(await h.options.envelopes.open(stored.tokens!,binding),h.state.tokens);
});
test('CP2 immutable binding/policy and captured port methods survive external option mutation',async()=>{
  const h=fixture();Object.assign(h.options.binding,{projectRef:'aaaaaaaaaaaaaaaaaaaa'});
  (h.options.policy.allowedOrigins as string[])[0]='https://wrong.invalid';
  h.options.provider.verify=async()=>unavailable();h.options.clock.now=()=>-1;
  await h.authorize(await h.login());
});
test('CP2 provider-returned mutable metadata cannot change identity while another port awaits',async()=>{
  const h=fixture(),gate=deferred<SecurityResult<'active'>>();let checking=false;
  h.options.provider.verify=async()=>ok(h.state.identity);
  h.options.provider.sessionStatus=async()=>{checking=true;return gate.promise;};h.service=createSessionService(h.options);
  const pending=h.login();await entered(()=>checking);Object.assign(h.state.identity,{subject:'bbbbbbbb-2222-4333-8444-555555555555'});
  gate.resolve(ok('active'));const issued=await pending;assert.equal((await h.row(issued)).session.identity!.subject,subject);
});
test('CP2 recovery during login encryption prevents creation of a new session',async()=>{
  const h=fixture(),seal=h.options.envelopes.seal.bind(h.options.envelopes),gate=deferred<void>();let sealing=false;
  h.options.envelopes.seal=async(...args)=>{sealing=true;await gate.promise;return seal(...args);};h.service=createSessionService(h.options);
  const pending=h.login();await entered(()=>sealing);h.state.subject={...h.state.subject,epoch:1,recoveryPending:true};gate.resolve();
  await denied(()=>pending);assert.equal(h.records.size,0);
});
test('CP2 business authorization renews idle only and returns the committed permit revision',async()=>{
  const h=fixture(),issued=await h.login(),before=copy(await h.row(issued));h.state.now+=500;
  const permit=await h.authorize(issued),row=await h.row(issued);
  assert.equal(row.session.lastActivityAt,h.state.now);assert.equal(row.session.absoluteExpiresAt,before.session.absoluteExpiresAt);
  assert.equal(row.session.createdAt,before.session.createdAt);assert.equal(row.session.identity!.mfaVerifiedAt,before.session.identity!.mfaVerifiedAt);
  assert.equal(permit.permit.sessionVersion,row.session.version);assert.equal(permit.view.idleExpiresAt,h.state.now+h.policy.idleTimeout);
  assert.equal(h.state.events.at(-1)!.sessionVersion,row.session.version);
});
test('CP2 audit failure rolls back business activity and cannot return a permit',async()=>{
  const h=fixture(),issued=await h.login(),before=copy(await h.row(issued));h.state.now+=500;h.state.auditAvailable=false;
  await denied(()=>h.authorize(issued),'SESSION_UNAVAILABLE');assert.deepEqual(await h.row(issued),before);
});
test('CP2 activity CAS conflicts have bounded retries and do not alter stored state',async()=>{
  const h=fixture(),issued=await h.login(),before=copy(await h.row(issued));h.state.conflict=true;
  await denied(()=>h.authorize(issued),'CONFLICT');assert.equal(h.state.casCalls,h.options.maxCasAttempts);assert.deepEqual(await h.row(issued),before);
});
test('CP2 exact idle deadline cannot be renewed by business activity',async()=>{
  const h=fixture(),issued=await h.login();h.state.now+=h.policy.idleTimeout;
  await denied(()=>h.authorize(issued));assert.equal((await h.row(issued)).session.state,'expired');assert.equal((await h.row(issued)).tokens,null);
});
test('CP2 administrator MFA timestamp zero is valid before its step-up boundary',async()=>{
  const h=fixture(0,true,true),issued=await h.login();
  const value=await h.service.authorize({handle:issued.handle,action:'membership_change',mutation:h.context(issued.csrfToken)});
  assert.equal(value.identity.mfaVerifiedAt,0);h.state.now=h.policy.stepUpMaxAge;
  await denied(()=>h.service.authorize({handle:issued.handle,action:'membership_change',mutation:h.context(issued.csrfToken)}),'STEP_UP_REQUIRED');
});
test('CP2 every elevated action requires mutation CSRF even for an authenticated aal2 Admin',async()=>{
  const h=fixture(500_000,true,true),issued=await h.login();
  for(const action of ['membership_change','factor_change','recovery_approval','administrator_activation'] as const){
    const before=copy(await h.row(issued));
    await denied(()=>h.service.authorize({handle:issued.handle,action,mutation:null}),'CSRF_REJECTED');
    assert.deepEqual(await h.row(issued),before);
  }
  await h.authorize(issued);
  await h.service.authorize({handle:issued.handle,action:'membership_change',mutation:h.context(issued.csrfToken)});
});
test('CP2 observed recovery and disabled membership both persist in the session snapshot',async()=>{
  const h=fixture(),issued=await h.login();h.membership({enabled:false,revision:2});h.state.subject={...h.state.subject,recoveryPending:true,epoch:1};
  await denied(()=>h.authorize(issued));const row=await h.row(issued);
  assert.equal(row.session.state,'recovery_pending');assert.equal(row.session.membership!.enabled,false);assert.equal(row.tokens,null);
  await h.service.logout(h.mutation(issued));assert.equal((await h.row(issued)).session.membership!.enabled,false);
  await denied(()=>h.login());
});
test('CP2 late MFA cannot undo logout, recovery, disablement or the idle deadline',async()=>{
  for(const restriction of ['logout','recovery','disabled','idle'] as const){
    const h=fixture(500_000,true),issued=await h.login(),gate=deferred<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>();h.state.mfaGate=gate.promise;
    const pending=h.service.completeMfa({...h.mutation(issued),challengeId:'synthetic-challenge',code:'123456'});await entered(()=>h.state.mfaCalls===1);
    if(restriction==='logout')await h.service.logout(h.mutation(issued));
    else if(restriction==='recovery')await h.service.startRecovery(h.mutation(issued));
    else if(restriction==='disabled')h.membership({enabled:false,revision:2});
    else h.state.now+=h.policy.idleTimeout;
    const rejected=denied(()=>pending);
    gate.resolve(ok({identity:{...h.refreshed(),assurance:'aal2',mfaVerifiedAt:h.state.now,factorVerified:true},tokens:h.state.tokens}));
    await rejected;await denied(()=>h.authorize(issued));assert.equal(h.retired.size,0);
  }
});
test('CP2 verified MFA rotates handle and prevents reuse of retired hash and prior CSRF',async()=>{
  const h=fixture(500_000,true),issued=await h.login();await denied(()=>h.authorize(issued),'MFA_REQUIRED');
  const challenge=await h.service.challengeMfa({...h.mutation(issued),factorId:'synthetic-factor'});
  h.state.now++;
  const elevated=await h.service.completeMfa({...h.mutation(issued),challengeId:challenge.challengeId,code:'123456'});
  assert.notEqual(elevated.handle,issued.handle);await denied(()=>h.authorize(issued));await h.authorize(elevated);
  await denied(()=>h.service.authorize({handle:elevated.handle,action:null,mutation:h.context(issued.csrfToken)}),'CSRF_REJECTED');
});
test('CP2 privilege change requires rotation and never gives new Admin grants aal1 access',async()=>{
  const h=fixture(),issued=await h.login();h.membership({revision:2,grants:[{role:'operations',scope:{kind:'portfolio'}},{role:'admin',scope:{kind:'properties',propertyIds:[]}}]});
  await denied(()=>h.authorize(issued),'ROTATION_REQUIRED');const rotated=await h.service.rotate(h.mutation(issued));
  assert.equal(rotated.view.state,'mfa_required');await denied(()=>h.authorize(rotated),'MFA_REQUIRED');await denied(()=>h.authorize(issued));
});
test('CP2 refresh after token expiry preserves idle, absolute and MFA timestamps',async()=>{
  const h=fixture(500_000,true,true),issued=await h.login(),before=copy(await h.row(issued));h.state.now+=h.policy.jwtLifetime;
  await denied(()=>h.authorize(issued));const refreshed=await h.service.refresh(h.mutation(issued)),row=await h.row(issued);
  assert.equal(refreshed.state,'authenticated');assert.equal(row.session.identity!.issuedAt,h.state.now);
  assert.equal(row.session.lastActivityAt,before.session.lastActivityAt);assert.equal(row.session.absoluteExpiresAt,before.session.absoluteExpiresAt);
  assert.equal(row.session.identity!.mfaVerifiedAt,before.session.identity!.mfaVerifiedAt);
  await denied(()=>h.service.authorize({handle:issued.handle,action:'factor_change',mutation:h.context(issued.csrfToken)}),'STEP_UP_REQUIRED');
});
test('CP2 competing workers produce only one provider refresh and never replay token rotation',async()=>{
  const h=fixture(),issued=await h.login(),gate=deferred<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>();h.state.now+=8_000;h.state.refreshGate=gate.promise;
  const first=h.service.refresh(h.mutation(issued));await entered(()=>h.state.refreshCalls===1);
  await denied(()=>createSessionService(h.options).refresh(h.mutation(issued)),'CONFLICT');
  await denied(()=>h.authorize(issued),'CONFLICT');
  gate.resolve(ok({identity:h.refreshed(),tokens:h.state.tokens}));await first;assert.equal(h.state.refreshCalls,1);
});
test('CP2 ambiguous provider refresh persists a local revocation instead of retrying',async()=>{
  const h=fixture(),issued=await h.login();h.state.now+=8_000;h.state.refreshGate=Promise.resolve({ok:false,failure:'ambiguous'});
  await denied(()=>h.service.refresh(h.mutation(issued)),'SESSION_UNAVAILABLE');
  assert.equal(h.state.refreshCalls,1);assert.equal((await h.row(issued)).session.state,'revoked');assert.equal((await h.row(issued)).tokens,null);
  await denied(()=>h.service.refresh(h.mutation(issued)));assert.equal(h.state.refreshCalls,1);
});
test('CP2 expired refresh lease takeover cannot be revoked or overwritten by the previous owner',async()=>{
  const h=fixture(),one=deferred<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>(),two=deferred<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>();
  h.options.provider.refresh=async()=>{h.state.refreshCalls++;return h.state.refreshCalls===1?one.promise:two.promise;};h.service=createSessionService(h.options);
  const issued=await h.login();h.state.now+=8_000;const first=h.service.refresh(h.mutation(issued));await entered(()=>h.state.refreshCalls===1);
  h.state.now+=h.policy.refreshLease;const second=createSessionService(h.options).refresh(h.mutation(issued));await entered(()=>h.state.refreshCalls===2);
  const latest=copy(await h.row(issued)),rejected=denied(()=>first,'CONFLICT');one.resolve(ok({identity:h.refreshed(),tokens:h.state.tokens}));await rejected;
  assert.deepEqual(await h.row(issued),latest);two.resolve(ok({identity:h.refreshed(),tokens:h.state.tokens}));await second;
  await h.authorize(issued);assert.equal(h.state.refreshCalls,2);
});
test('CP2 refresh token/audit CAS failure cannot produce a successful updated session',async()=>{
  const h=fixture(),issued=await h.login(),gate=deferred<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>();h.state.now+=8_000;h.state.refreshGate=gate.promise;
  const pending=h.service.refresh(h.mutation(issued));await entered(()=>h.state.refreshCalls===1);const leased=copy(await h.row(issued));h.state.auditAvailable=false;
  const rejected=denied(()=>pending,'SESSION_UNAVAILABLE');gate.resolve(ok({identity:h.refreshed(),tokens:{accessToken:'NEW_SYNTHETIC_ACCESS',refreshToken:'NEW_SYNTHETIC_REFRESH'}}));await rejected;
  assert.deepEqual(await h.row(issued),leased);h.state.auditAvailable=true;await denied(()=>h.authorize(issued),'CONFLICT');
});
test('CP2 late refresh preserves logout and recovery terminal security events',async()=>{
  for(const recovery of [false,true]){
    const h=fixture(),issued=await h.login(),gate=deferred<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>();h.state.now+=8_000;h.state.refreshGate=gate.promise;
    const pending=h.service.refresh(h.mutation(issued));await entered(()=>h.state.refreshCalls===1);
    if(recovery)await h.service.startRecovery(h.mutation(issued));else await h.service.logout(h.mutation(issued));
    const before=copy(await h.row(issued)),rejected=denied(()=>pending);gate.resolve(ok({identity:h.refreshed(),tokens:h.state.tokens}));await rejected;
    assert.deepEqual(await h.row(issued),before);assert.equal(before.tokens,null);
  }
});
test('CP2 failed session reconciliation cannot undo an authoritative subject recovery hold',async()=>{
  const h=fixture(),issued=await h.login();h.state.conflict=true;
  await denied(()=>h.service.startRecovery(h.mutation(issued)),'CONFLICT');assert.equal(h.state.subject.recoveryPending,true);
  assert.equal(h.state.casCalls,h.options.maxCasAttempts);h.state.conflict=false;await denied(()=>h.authorize(issued));await denied(()=>h.login());
});
test('CP2 all-device logout invalidates old handles, permits fresh login and is retry-idempotent by epoch',async()=>{
  const h=fixture();h.service=createSessionService({...h.options,policy:{...h.policy,logoutScope:'all'}});
  const a=await h.login(),b=await h.login();await h.service.logout(h.mutation(a));await denied(()=>h.authorize(b));
  const fresh=await h.login();await h.service.logout(h.mutation(a));await h.authorize(fresh);assert.equal(h.state.subjectInvalidations,1);
});
test('CP2 provider logout outage returns reconciliation only after local denial is stored and audited',async()=>{
  const h=fixture(),issued=await h.login();h.state.revokeAvailable=false;
  assert.deepEqual(await h.service.logout(h.mutation(issued)),{localRevoked:true,providerRevocation:'reconciliation_required'});
  assert.equal((await h.row(issued)).tokens,null);assert.equal(h.state.events.at(-1)!.outcome,'reconciliation_required');await denied(()=>h.authorize(issued));
});
test('CP2 CSRF and limiter failures precede provider work and preserve unconsumed valid challenge',async()=>{
  const h=fixture(),c=await h.service.issueLoginChallenge({origin,limiterKey:'server'});
  await denied(()=>h.service.login({challengeHandle:c.handle,tokens:h.state.tokens,context:h.context(null)}),'CSRF_REJECTED');assert.equal(h.state.verifyCalls,0);
  h.state.allowed=false;await denied(()=>h.service.login({challengeHandle:c.handle,tokens:h.state.tokens,context:h.context(c.csrfToken)}),'RATE_LIMITED');assert.equal(h.state.verifyCalls,0);
  h.state.allowed=true;await h.service.login({challengeHandle:c.handle,tokens:h.state.tokens,context:h.context(c.csrfToken)});
  await denied(()=>h.service.login({challengeHandle:c.handle,tokens:h.state.tokens,context:h.context(c.csrfToken)}),'CSRF_REJECTED');
});
test('CP2 malformed handles, policies and port errors never disclose provider data',async()=>{
  const h=fixture();for(const handle of ['', 'x'.repeat(43),'x'.repeat(44),'SECRET_PROVIDER_FAILURE']){
    try{await h.service.authorize({handle,action:null,mutation:null});assert.fail('Expected denial');}
    catch(error){assert.ok(error instanceof SessionServiceError);assert.doesNotMatch(String(error),/SECRET_PROVIDER_FAILURE|SYNTHETIC_CP2/);}
  }
  h.state.limiterAvailable=false;await denied(()=>h.login(),'SESSION_UNAVAILABLE');assert.equal(h.state.verifyCalls,0);
});
