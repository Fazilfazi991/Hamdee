import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityContractError,type IdentityBinding,type VerifiedIdentity,type MembershipSnapshot,type SessionRecord,type Role } from '../src/security/contracts';
import { validateSessionPolicy,elevatedActions,type SessionPolicy } from '../src/security/session-policy';
import { anonymousSession,transitionSession,businessPermit,recheckProtectedOperation,type SessionEvent } from '../src/security/session-state';

const binding:IdentityBinding={provider:'supabase',appId:'hamdee',environment:'development',dataClass:'synthetic_only',projectRef:'abcdefghijklmnopqrst',issuer:'https://abcdefghijklmnopqrst.supabase.co/auth/v1',audience:'authenticated'};
const at=100000,hashA='a'.repeat(64),hashB='b'.repeat(64),hashC='c'.repeat(64),ownerA='33333333-3333-4333-8333-333333333333',ownerB='44444444-4444-4444-8444-444444444444';
function policy():SessionPolicy {return validateSessionPolicy({idleTimeout:10000,absoluteTimeout:60000,jwtLifetime:6000,refreshLead:2000,refreshLease:1000,clockTolerance:100,stepUpMaxAge:4000,
  allowedOrigins:['https://hamdee.invalid'],redirectAllowlist:['https://hamdee.invalid/auth/callback'],logoutScope:'local',trustedProxyPolicy:{mode:'none'},
  limits:Object.fromEntries(['login','refresh','mfa','recovery','invitation','write'].map(flow=>[flow,{bounds:3,window:1000,backoff:200}])),
  mfa:{administratorRequired:true,requireLiveAdminSession:true,otherRoles:'optional',factor:'totp',stepUpActions:[...elevatedActions]},disablementBoundary:'recheck_at_commit'});}
function identity(time=at,mfa=false):VerifiedIdentity {return {binding,subject:'11111111-1111-4111-8111-111111111111',providerSessionId:'22222222-2222-4222-8222-222222222222',issuedAt:time,notBefore:time,expiresAt:time+6000,assurance:mfa?'aal2':'aal1',mfaVerifiedAt:mfa?time:null,factorVerified:mfa,status:'active',liveSessionStatus:'active'};}
function membership(roles:Role[]=['read_only'],revision=1,enabled=true):MembershipSnapshot {return {issuer:binding.issuer,subject:identity().subject,enabled,revision,grants:roles.map(role=>({role,scope:{kind:'portfolio'}}))};}
function step(s:SessionRecord,event:Omit<SessionEvent,'expectedVersion'>,time=at,p=policy()):SessionRecord {return transitionSession(s,{...event,expectedVersion:s.version} as SessionEvent,binding,p,time);}
function primary(roles:Role[]=['read_only'],mfa=false,p=policy()):SessionRecord {return transitionSession(anonymousSession(at),{type:'primary_authenticated',expectedVersion:0,handleHash:hashA,identity:identity(at,mfa),membership:membership(roles)},binding,p,at);}
function logged(roles:Role[]=['read_only'],mfa=false,p=policy()):SessionRecord {return step(primary(roles,mfa,p),{type:'evaluate_mfa'},at,p);}
const rejects=(fn:()=>unknown,code?:string)=>assert.throws(fn,(e:unknown)=>e instanceof SecurityContractError&&(!code||e.code===code));
const denied=(s:SessionRecord,time=at,p=policy())=>rejects(()=>businessPermit(s,binding,p,time,null));

test('CP1 state: anonymous and primary verification have no business access; evaluation is explicit',()=>{
  const anon=anonymousSession(at);denied(anon);const s=primary();denied(s);assert.equal(s.state,'primary_authenticated');
  const auth=step(s,{type:'evaluate_mfa'});assert.equal(auth.state,'authenticated');assert.equal(businessPermit(auth,binding,policy(),at,null).sessionVersion,2);assert.equal(s.version,1);assert.ok(Object.isFrozen(auth));
});
test('CP1 state: Admin aal1 and mixed-role Admin cannot use lower-role business access',()=>{
  for(const roles of [['admin'],['admin','read_only'],['operations','admin']] as Role[][]){const s=logged(roles);assert.equal(s.state,'mfa_required');denied(s);}
  const p=validateSessionPolicy({...policy(),mfa:{...policy().mfa,otherRoles:'required'}});assert.equal(logged(['finance'],false,p).state,'mfa_required');
});
test('CP1 state: verified MFA must bind the session and rotate the handle before access',()=>{
  const s=logged(['admin']);rejects(()=>transitionSession(s,{type:'mfa_completed',expectedVersion:s.version,handleHash:hashA,identity:identity(at+100,true)},binding,policy(),at+100),'INVALID_STATE');
  const good=transitionSession(s,{type:'mfa_completed',expectedVersion:s.version,handleHash:hashB,identity:identity(at+100,true)},binding,policy(),at+100);
  assert.equal(good.state,'authenticated');assert.equal(good.handleHash,hashB);assert.equal(businessPermit(good,binding,policy(),at+101,'membership_change').subject,identity().subject);
  const wrong={...identity(at+100,true),providerSessionId:ownerA};rejects(()=>transitionSession(s,{type:'mfa_completed',expectedVersion:s.version,handleHash:hashB,identity:wrong},binding,policy(),at+100),'INVALID_IDENTITY');
});
test('CP1 state: malformed identity/membership/state and time regression fail closed',()=>{
  rejects(()=>transitionSession(anonymousSession(at),{type:'primary_authenticated',expectedVersion:0,handleHash:hashA,identity:identity(),membership:membership([],1,false)},binding,policy(),at),'ACCESS_DENIED');
  rejects(()=>transitionSession(anonymousSession(at),{type:'primary_authenticated',expectedVersion:0,handleHash:hashA,identity:identity(),membership:{...membership(),subject:ownerA}},binding,policy(),at),'INVALID_STATE');
  rejects(()=>step({...logged(),state:'bogus'} as unknown as SessionRecord,{type:'activity'}),'INVALID_STATE');
  rejects(()=>step(logged(),{type:'activity'},at-1),'INVALID_STATE');rejects(()=>step(logged(),{type:'evaluate_mfa'}),'INVALID_STATE');
  rejects(()=>step(logged(),{type:'expire'}),'INVALID_STATE');
});
test('CP1 state: idle expiry boundary denies access and wins over pending events',()=>{
  const s=logged();const refreshed={...identity(at+8000),expiresAt:at+14000};
  const record={...s,identity:refreshed,observedAt:at+8000};assert.ok(businessPermit(record,binding,policy(),at+9999,null));denied(record,at+10000);
  const expired=step(record,{type:'activity'},at+10000);assert.equal(expired.state,'expired');assert.equal(expired.reason,'idle');assert.equal(expired.lastActivityAt,at);
  rejects(()=>step(expired,{type:'evaluate_mfa'},at+10000),'INVALID_STATE');
});
test('CP1 state: absolute expiration is exact and cannot be extended by refresh/activity',()=>{
  const p=validateSessionPolicy({...policy(),idleTimeout:60000});const s=logged(['read_only'],false,p);
  rejects(()=>step(s,{type:'expire'},at+59999,p),'INVALID_STATE');const expired=step(s,{type:'expire'},at+60000,p);
  assert.equal(expired.state,'expired');assert.equal(expired.reason,'absolute');assert.equal(expired.absoluteExpiresAt,at+60000);denied(expired,at+60000,p);
});
test('CP1 state: logout/provider revocation/disablement are terminal and deny saved permits',()=>{
  for(const type of ['logout','provider_revoked','disabled'] as const){const s=logged(['admin'],true),permit=businessPermit(s,binding,policy(),at,null),end=step(s,{type},at+1);
    assert.equal(end.state,'revoked');denied(end,at+1);rejects(()=>recheckProtectedOperation(end,permit,binding,policy(),at+1,null));
    rejects(()=>step(end,{type:'evaluate_mfa'},at+1),'INVALID_STATE');rejects(()=>transitionSession(end,{type:'mfa_completed',expectedVersion:end.version,handleHash:hashB,identity:identity(at+1,true)},binding,policy(),at+1),'INVALID_STATE');
  }
});
test('CP1 state: revoked/expired may start only a fresh validated login with a different hash',()=>{
  for(const end of [step(logged(),{type:'logout'},at+1),step(logged(),{type:'expire'},at+10000)]){
    const time=end.observedAt+1,base={type:'primary_authenticated' as const,expectedVersion:end.version,identity:identity(time),membership:membership()};
    rejects(()=>transitionSession(end,{...base,handleHash:hashA},binding,policy(),time),'INVALID_STATE');
    const fresh=transitionSession(end,{...base,handleHash:hashB},binding,policy(),time);assert.equal(fresh.state,'primary_authenticated');denied(fresh,time);assert.equal(fresh.createdAt,time);
  }
});
test('CP1 race: logout wins over a late refresh; stale logout also revokes a newer refresh',()=>{
  const s=logged(),lease=transitionSession(s,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerA},binding,policy(),at+4000);
  const end=step(lease,{type:'logout'},at+4100);
  rejects(()=>transitionSession(end,{type:'refresh_completed',expectedVersion:lease.version,ownerId:ownerA,identity:identity(at+4200)},binding,policy(),at+4200),'STALE_REVISION');denied(end,at+4200);
  const done=transitionSession(lease,{type:'refresh_completed',expectedVersion:lease.version,ownerId:ownerA,identity:identity(at+4100)},binding,policy(),at+4100);
  const lateLogout=transitionSession(done,{type:'logout',expectedVersion:s.version},binding,policy(),at+4200);assert.equal(lateLogout.state,'revoked');
});
test('CP1 race: simultaneous refresh attempts have one lease revision winner',()=>{
  const s=logged(),first=transitionSession(s,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerA},binding,policy(),at+4000);
  rejects(()=>transitionSession(first,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerB},binding,policy(),at+4000),'STALE_REVISION');
  rejects(()=>transitionSession(first,{type:'acquire_refresh',expectedVersion:first.version,ownerId:ownerB},binding,policy(),at+4001),'LEASE_CONFLICT');
  rejects(()=>transitionSession(s,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerA},binding,policy(),at),'INVALID_STATE');
});
test('CP1 race: lease expiry permits a new owner, never completion by the retired owner',()=>{
  const s=logged(),lease=transitionSession(s,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerA},binding,policy(),at+4000);
  rejects(()=>transitionSession(lease,{type:'refresh_completed',expectedVersion:lease.version,ownerId:ownerA,identity:identity(at+5000)},binding,policy(),at+5000),'LEASE_CONFLICT');
  const takeover=transitionSession(lease,{type:'acquire_refresh',expectedVersion:lease.version,ownerId:ownerB},binding,policy(),at+5000);
  rejects(()=>transitionSession(takeover,{type:'refresh_completed',expectedVersion:takeover.version,ownerId:ownerA,identity:identity(at+5001)},binding,policy(),at+5001),'LEASE_CONFLICT');
  const done=transitionSession(takeover,{type:'refresh_completed',expectedVersion:takeover.version,ownerId:ownerB,identity:identity(at+5001)},binding,policy(),at+5001);
  assert.equal(done.lastActivityAt,at);assert.equal(done.absoluteExpiresAt,s.absoluteExpiresAt);assert.equal(done.refreshLease,null);
});
test('CP1 state: refresh is not MFA step-up and cannot change assurance or MFA timestamp',()=>{
  const s=logged(['admin'],true),lease=transitionSession(s,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerA},binding,policy(),at+4000);
  rejects(()=>transitionSession(lease,{type:'refresh_completed',expectedVersion:lease.version,ownerId:ownerA,identity:identity(at+4100,true)},binding,policy(),at+4100),'INVALID_IDENTITY');
  const refreshed={...identity(at+4100,true),mfaVerifiedAt:at};const done=transitionSession(lease,{type:'refresh_completed',expectedVersion:lease.version,ownerId:ownerA,identity:refreshed},binding,policy(),at+4100);
  assert.ok(businessPermit(done,binding,policy(),at+4100,null));rejects(()=>businessPermit(done,binding,policy(),at+4100,'factor_change'),'ACCESS_DENIED');
  assert.ok(businessPermit(s,binding,policy(),at+3999,'factor_change'));rejects(()=>businessPermit(s,binding,policy(),at+4000,'factor_change'),'ACCESS_DENIED');
});
test('CP1 race: disablement invalidates a protected-operation permit and pending refresh',()=>{
  const s=logged(),permit=businessPermit(s,binding,policy(),at,null);recheckProtectedOperation(s,permit,binding,policy(),at+1,null);
  const disabled=step(s,{type:'disabled'},at+2);rejects(()=>recheckProtectedOperation(disabled,permit,binding,policy(),at+2,null));
  assert.equal(disabled.membership!.enabled,false);rejects(()=>transitionSession(disabled,{type:'refresh_completed',expectedVersion:s.version,ownerId:ownerA,identity:identity(at+3)},binding,policy(),at+3),'STALE_REVISION');
});
test('CP1 race: session revocation wins over pending verified MFA completion',()=>{
  const s=logged(['admin']),end=step(s,{type:'provider_revoked'},at+1);
  rejects(()=>transitionSession(end,{type:'mfa_completed',expectedVersion:s.version,handleHash:hashB,identity:identity(at+2,true)},binding,policy(),at+2),'STALE_REVISION');
});
test('CP1 recovery: initiation removes access and cannot self-reactivate or finish old work',()=>{
  const s=logged(['admin'],true),permit=businessPermit(s,binding,policy(),at,null),recovery=step(s,{type:'recovery_started'},at+1);
  assert.equal(recovery.state,'recovery_pending');denied(recovery,at+1);assert.equal(recovery.refreshLease,null);
  rejects(()=>recheckProtectedOperation(recovery,permit,binding,policy(),at+1,null));
  rejects(()=>transitionSession(recovery,{type:'primary_authenticated',expectedVersion:recovery.version,handleHash:hashB,identity:identity(at+2,true),membership:membership(['admin'])},binding,policy(),at+2),'INVALID_STATE');
  rejects(()=>step(recovery,{type:'rotate',handleHash:hashB} as Omit<SessionEvent,'expectedVersion'>,at+2),'INVALID_STATE');
});
test('CP1 privilege changes: revoke stale permits, enforce MFA for new Admin and require rotation',()=>{
  const s=logged(),permit=businessPermit(s,binding,policy(),at,null);
  const changed=transitionSession(s,{type:'privileges_changed',expectedVersion:s.version,membership:membership(['admin','read_only'],2)},binding,policy(),at+1);
  assert.equal(changed.state,'mfa_required');assert.equal(changed.rotationRequired,true);denied(changed,at+1);rejects(()=>recheckProtectedOperation(changed,permit,binding,policy(),at+1,null));
  const rotated=transitionSession(changed,{type:'rotate',expectedVersion:changed.version,handleHash:hashB},binding,policy(),at+2);denied(rotated,at+2);
  const complete=transitionSession(rotated,{type:'mfa_completed',expectedVersion:rotated.version,handleHash:hashC,identity:identity(at+3,true)},binding,policy(),at+3);assert.ok(businessPermit(complete,binding,policy(),at+3,null));
});
test('CP1 privilege changes: role removal still requires rotation; stale membership rejected',()=>{
  const s=logged(['admin'],true);rejects(()=>transitionSession(s,{type:'privileges_changed',expectedVersion:s.version,membership:membership(['read_only'],1)},binding,policy(),at+1),'STALE_REVISION');
  const changed=transitionSession(s,{type:'privileges_changed',expectedVersion:s.version,membership:membership(['read_only'],2)},binding,policy(),at+1);denied(changed,at+1);
  const rotated=transitionSession(changed,{type:'rotate',expectedVersion:changed.version,handleHash:hashB},binding,policy(),at+2);
  const auth=step(rotated,{type:'evaluate_mfa'},at+3);assert.ok(businessPermit(auth,binding,policy(),at+3,null));rejects(()=>businessPermit(auth,binding,policy(),at+3,'membership_change'),'ACCESS_DENIED');
});
test('CP1 assurance downgrade: no stale aal2 business access or upgrade through refresh',()=>{
  const s=logged(['admin'],true),down=transitionSession(s,{type:'assurance_changed',expectedVersion:s.version,identity:identity(at+1)},binding,policy(),at+1);
  assert.equal(down.state,'mfa_required');assert.equal(down.rotationRequired,true);denied(down,at+1);
  rejects(()=>transitionSession(down,{type:'assurance_changed',expectedVersion:down.version,identity:identity(at+2,true)},binding,policy(),at+2),'INVALID_IDENTITY');
});
test('CP1 stale results: expiration outranks a matching-revision refresh completion',()=>{
  const s=logged(),lease=transitionSession(s,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerA},binding,policy(),at+4000);
  const expired=transitionSession(lease,{type:'refresh_completed',expectedVersion:lease.version,ownerId:ownerA,identity:identity(at+10000)},binding,policy(),at+10000);
  assert.equal(expired.state,'expired');assert.equal(expired.reason,'idle');denied(expired,at+10000);
});
test('CP1 defensive guards: forged authenticated Admin aal1 and future revocation/lease metadata deny',()=>{
  denied({...logged(['admin','finance']),state:'authenticated'});
  const s=logged(),end=step(s,{type:'logout'},at+1);
  rejects(()=>step({...end,revokedAt:at+2},{type:'logout'},at+1),'INVALID_STATE');
  rejects(()=>step({...s,refreshLease:{ownerId:ownerA,expiresAt:at+99999}},{type:'activity'}),'INVALID_STATE');
});
test('CP1 refresh: mismatched provider subject/session and stale result after privilege change deny',()=>{
  const s=logged(),lease=transitionSession(s,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerA},binding,policy(),at+4000);
  for(const patch of [{subject:ownerA},{providerSessionId:ownerB}])rejects(()=>transitionSession(lease,{type:'refresh_completed',expectedVersion:lease.version,ownerId:ownerA,identity:{...identity(at+4001),...patch}},binding,policy(),at+4001),'INVALID_IDENTITY');
  const changed=transitionSession(lease,{type:'privileges_changed',expectedVersion:lease.version,membership:membership(['finance'],2)},binding,policy(),at+4001);
  rejects(()=>transitionSession(changed,{type:'refresh_completed',expectedVersion:lease.version,ownerId:ownerA,identity:identity(at+4002)},binding,policy(),at+4002),'STALE_REVISION');
});
test('CP1 expired MFA: late verified completion cannot revive an idle-expired pending session',()=>{
  const s=logged(['admin']);const expired=transitionSession(s,{type:'mfa_completed',expectedVersion:s.version,handleHash:hashB,identity:identity(at+10000,true)},binding,policy(),at+10000);
  assert.equal(expired.state,'expired');assert.equal(expired.handleHash,hashA);denied(expired,at+10000);
});

test('CP1-R01: recovery at the idle deadline preserves a recovery hold',()=>{
  const s=logged(['admin'],true),time=at+10000;
  const hold=transitionSession(s,{type:'recovery_started',expectedVersion:s.version},binding,policy(),time);
  assert.equal(hold.state,'recovery_pending');assert.equal(hold.reason,'recovery');assert.equal(hold.revokedAt,time);
  assert.equal(hold.refreshLease,null);assert.equal(hold.rotationRequired,true);assert.equal(hold.absoluteExpiresAt,s.absoluteExpiresAt);denied(hold,time);
});
test('CP1-R01: recovery at the absolute deadline preserves a recovery hold',()=>{
  const p=validateSessionPolicy({...policy(),idleTimeout:60000}),s=logged(['admin'],true,p),time=at+60000;
  const hold=transitionSession(s,{type:'recovery_started',expectedVersion:s.version},binding,p,time);
  assert.equal(hold.state,'recovery_pending');assert.equal(hold.reason,'recovery');assert.equal(hold.revokedAt,time);denied(hold,time,p);
});
test('CP1-R01: recovery after persisted idle or absolute expiration is recorded',()=>{
  for(const [time,p] of [[at+10000,policy()],[at+60000,validateSessionPolicy({...policy(),idleTimeout:60000})]] as const){
    const s=logged(['admin'],true,p),expired=transitionSession(s,{type:'expire',expectedVersion:s.version},binding,p,time);
    assert.equal(expired.state,'expired');
    const hold=transitionSession(expired,{type:'recovery_started',expectedVersion:s.version},binding,p,time+1);
    assert.equal(hold.state,'recovery_pending');assert.equal(hold.reason,'recovery');assert.equal(hold.version,expired.version+1);denied(hold,time+1,p);
  }
});
test('CP1-R01: disablement at and after expiry preserves disabled membership',()=>{
  for(const [time,p] of [[at+10000,policy()],[at+60000,validateSessionPolicy({...policy(),idleTimeout:60000})]] as const){
    const s=logged(['admin'],true,p),expired=transitionSession(s,{type:'expire',expectedVersion:s.version},binding,p,time);
    for(const current of [s,expired])for(const eventAt of [time,time+1]){
      const end=transitionSession(current,{type:'disabled',expectedVersion:s.version},binding,p,eventAt);
      assert.equal(end.state,'revoked');assert.equal(end.reason,'disabled');assert.equal(end.membership!.enabled,false);assert.equal(end.refreshLease,null);denied(end,eventAt,p);
    }
  }
});
test('CP1-R01: repeated recovery and disablement are idempotent even after deadlines',()=>{
  for(const type of ['recovery_started','disabled'] as const){
    const s=logged(['admin'],true),first=transitionSession(s,{type,expectedVersion:0},binding,policy(),at+10000);
    const repeated=transitionSession(first,{type,expectedVersion:0},binding,policy(),at+60001);
    assert.deepEqual(repeated,first);assert.equal(repeated.version,first.version);assert.equal(repeated.revokedAt,first.revokedAt);denied(repeated,at+60001);
  }
});
test('CP1-R01: recovery hold outranks later logout or revocation and retains disablement',()=>{
  const s=logged(['admin'],true),hold=transitionSession(s,{type:'recovery_started',expectedVersion:s.version},binding,policy(),at+10000);
  for(const type of ['logout','provider_revoked'] as const){
    const kept=transitionSession(hold,{type,expectedVersion:0},binding,policy(),at+10001);assert.deepEqual(kept,hold);
  }
  const disabled=transitionSession(hold,{type:'disabled',expectedVersion:0},binding,policy(),at+10001);
  assert.equal(disabled.state,'recovery_pending');assert.equal(disabled.reason,'recovery');assert.equal(disabled.membership!.enabled,false);
  assert.deepEqual(transitionSession(disabled,{type:'disabled',expectedVersion:0},binding,policy(),at+10002),disabled);
  assert.deepEqual(transitionSession(disabled,{type:'recovery_started',expectedVersion:0},binding,policy(),at+10002),disabled);
  const firstDisabled=transitionSession(s,{type:'disabled',expectedVersion:0},binding,policy(),at+10000);
  const thenRecovery=transitionSession(firstDisabled,{type:'recovery_started',expectedVersion:0},binding,policy(),at+10001);
  assert.equal(thenRecovery.state,'recovery_pending');assert.equal(thenRecovery.membership!.enabled,false);denied(thenRecovery,at+10001);
});
test('CP1-R01: recovery beats late refresh at expiry and after an expiry sweep',()=>{
  const s=logged(['admin'],true),lease=transitionSession(s,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerA},binding,policy(),at+4000);
  const expired=transitionSession(lease,{type:'expire',expectedVersion:lease.version},binding,policy(),at+10000);
  for(const current of [lease,expired]){
    const hold=transitionSession(current,{type:'recovery_started',expectedVersion:s.version},binding,policy(),at+10000);
    assert.equal(hold.state,'recovery_pending');assert.equal(hold.refreshLease,null);
    for(const expectedVersion of [lease.version,hold.version])rejects(()=>transitionSession(hold,{type:'refresh_completed',expectedVersion,ownerId:ownerA,identity:{...identity(at+10001,true),mfaVerifiedAt:at}},binding,policy(),at+10001));
    denied(hold,at+10001);
  }
});
test('CP1-R01: logout at a deadline wins over a pending refresh with stale revocation allowed',()=>{
  const s=logged(),lease=transitionSession(s,{type:'acquire_refresh',expectedVersion:s.version,ownerId:ownerA},binding,policy(),at+4000);
  const end=transitionSession(lease,{type:'logout',expectedVersion:s.version},binding,policy(),at+10000);
  assert.equal(end.state,'revoked');assert.equal(end.reason,'logout');assert.equal(end.refreshLease,null);
  rejects(()=>transitionSession(end,{type:'refresh_completed',expectedVersion:lease.version,ownerId:ownerA,identity:identity(at+10001)},binding,policy(),at+10001),'STALE_REVISION');
  assert.deepEqual(transitionSession(end,{type:'logout',expectedVersion:0},binding,policy(),at+10001),end);denied(end,at+10001);
});
test('CP1-R02: unknown or malformed events reject at idle and absolute deadlines',()=>{
  for(const [time,p] of [[at+10000,policy()],[at+60000,validateSessionPolicy({...policy(),idleTimeout:60000})]] as const){
    const s=logged(['admin'],true,p);
    for(const event of [null,undefined,[],{type:'unknown',expectedVersion:s.version},{type:'',expectedVersion:s.version},{type:null,expectedVersion:s.version}])
      rejects(()=>transitionSession(s,event as unknown as SessionEvent,binding,p,time),'INVALID_STATE');
  }
});
test('CP1-R02: future revisions reject before expiry or terminal idempotence',()=>{
  const s=logged(['admin'],true),time=at+10000,expired=transitionSession(s,{type:'expire',expectedVersion:s.version},binding,policy(),time);
  for(const current of [s,expired])for(const type of ['activity','expire','mfa_completed','refresh_completed','logout','provider_revoked','disabled','recovery_started'] as const)
    rejects(()=>transitionSession(current,{type,expectedVersion:current.version+1} as SessionEvent,binding,policy(),time+1),'STALE_REVISION');
});
test('CP1-R02: invalid revision values reject at expiry without state mutation',()=>{
  const s=logged(['admin'],true);
  for(const expectedVersion of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1,'2',undefined]){
    rejects(()=>transitionSession(s,{type:'recovery_started',expectedVersion} as SessionEvent,binding,policy(),at+10000),'INVALID_STATE');
    assert.equal(s.state,'authenticated');assert.equal(s.version,2);
  }
});
test('CP1-R02: stale ordinary activity refresh and MFA reject before expiration',()=>{
  const s=logged(['admin'],true);
  for(const type of ['activity','expire','evaluate_mfa','acquire_refresh','refresh_completed','mfa_completed','rotate'] as const)
    rejects(()=>transitionSession(s,{type,expectedVersion:s.version-1} as SessionEvent,binding,policy(),at+10000),'STALE_REVISION');
});
test('CP1-R02: supported stale security revisions remain valid at and after expiry',()=>{
  const s=logged(['admin'],true),expired=transitionSession(s,{type:'expire',expectedVersion:s.version},binding,policy(),at+10000);
  for(const current of [s,expired])for(const type of ['logout','provider_revoked','disabled','recovery_started'] as const){
    const end=transitionSession(current,{type,expectedVersion:0},binding,policy(),at+10001);
    assert.equal(end.state,type==='recovery_started'?'recovery_pending':'revoked');
    if(type==='disabled')assert.equal(end.membership!.enabled,false);
    rejects(()=>transitionSession(end,{type,expectedVersion:end.version+1},binding,policy(),at+10002),'STALE_REVISION');
    denied(end,at+10002);
  }
});
test('CP1-R01: fresh verified primary login cannot bypass any accepted recovery hold',()=>{
  const s=logged(['admin'],true),expired=transitionSession(s,{type:'expire',expectedVersion:s.version},binding,policy(),at+10000);
  for(const current of [s,expired]){
    const hold=transitionSession(current,{type:'recovery_started',expectedVersion:0},binding,policy(),at+10001);
    for(const expectedVersion of [0,hold.version])rejects(()=>transitionSession(hold,{type:'primary_authenticated',expectedVersion,handleHash:hashB,identity:identity(at+10002,true),membership:membership(['admin'],2)},binding,policy(),at+10002));
    denied(hold,at+10002);
  }
});
test('CP1 correction: terminal restrictions deny MFA refresh activity and privilege changes',()=>{
  const s=logged(['admin'],true),time=at+10000;
  const ends=[transitionSession(s,{type:'expire',expectedVersion:s.version},binding,policy(),time),
    transitionSession(s,{type:'disabled',expectedVersion:s.version},binding,policy(),time),
    transitionSession(s,{type:'recovery_started',expectedVersion:s.version},binding,policy(),time)];
  for(const end of ends){
    const events:SessionEvent[]=[{type:'mfa_completed',expectedVersion:end.version,handleHash:hashB,identity:identity(time+1,true)},
      {type:'refresh_completed',expectedVersion:end.version,ownerId:ownerA,identity:identity(time+1,true)},
      {type:'activity',expectedVersion:end.version},{type:'rotate',expectedVersion:end.version,handleHash:hashB},
      {type:'privileges_changed',expectedVersion:end.version,membership:membership(['admin'],2)}];
    for(const event of events)rejects(()=>transitionSession(end,event,binding,policy(),time+1),'INVALID_STATE');
    denied(end,time+1);
  }
});
test('CP1 correction: valid ordinary activity refresh and MFA cannot prevent expiry',()=>{
  for(const [time,p,reason] of [[at+10000,policy(),'idle'],[at+60000,validateSessionPolicy({...policy(),idleTimeout:60000}),'absolute']] as const){
    const s=logged(['admin'],true,p);
    const events:SessionEvent[]=[{type:'activity',expectedVersion:s.version},
      {type:'mfa_completed',expectedVersion:s.version,handleHash:hashB,identity:identity(time,true)},
      {type:'refresh_completed',expectedVersion:s.version,ownerId:ownerA,identity:identity(time,true)}];
    for(const event of events){const expired=transitionSession(s,event,binding,p,time);assert.equal(expired.state,'expired');assert.equal(expired.reason,reason);denied(expired,time,p);}
  }
});
