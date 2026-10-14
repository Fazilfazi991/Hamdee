import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIdentityMetadata,requirePortSuccess,SecurityContractError,type IdentityBinding,type VerifiedIdentity,type SessionStorePort,type DurableSession,type IdentityProviderPort,type SecurityResult } from '../src/security/contracts';
import { validateSessionPolicy,elevatedActions,type SessionPolicy } from '../src/security/session-policy';
import { anonymousSession,transitionSession } from '../src/security/session-state';

const binding:IdentityBinding={provider:'supabase',appId:'hamdee',environment:'development',dataClass:'synthetic_only',projectRef:'abcdefghijklmnopqrst',issuer:'https://abcdefghijklmnopqrst.supabase.co/auth/v1',audience:'authenticated'};
const at=100000;
function fixture(){return {idleTimeout:10000,absoluteTimeout:60000,jwtLifetime:6000,refreshLead:2000,refreshLease:1000,clockTolerance:100,stepUpMaxAge:4000,
  allowedOrigins:['https://hamdee.invalid'],redirectAllowlist:['https://hamdee.invalid/auth/callback'],logoutScope:'local',trustedProxyPolicy:{mode:'none'},
  limits:Object.fromEntries(['login','refresh','mfa','recovery','invitation','write'].map(flow=>[flow,{bounds:3,window:1000,backoff:200}])),
  mfa:{administratorRequired:true,requireLiveAdminSession:true,otherRoles:'optional',factor:'totp',stepUpActions:[...elevatedActions]},disablementBoundary:'recheck_at_commit'};}
const identity:VerifiedIdentity={binding,subject:'11111111-1111-4111-8111-111111111111',providerSessionId:'22222222-2222-4222-8222-222222222222',issuedAt:at,notBefore:at,expiresAt:at+6000,assurance:'aal1',mfaVerifiedAt:null,factorVerified:false,status:'active',liveSessionStatus:'active'};
const rejects=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:unknown)=>e instanceof SecurityContractError&&e.code===code);

test('CP1 policy: explicit synthetic values validate and are detached/deep frozen',()=>{
  const input=fixture(),p=validateSessionPolicy(input);input.allowedOrigins.push('https://other.invalid');input.limits.login.bounds=99;
  assert.equal(p.allowedOrigins.length,1);assert.equal(p.limits.login.bounds,3);assert.ok(Object.isFrozen(p.mfa.stepUpActions));assert.ok(Object.isFrozen(p.limits.login));
  assert.throws(()=>{(p.allowedOrigins as string[]).push('https://other.invalid');});
});
test('CP1 policy: every required top-level field is mandatory, with no defaults',()=>{
  for(const key of Object.keys(fixture())){const p:Record<string,unknown>=fixture();delete p[key];rejects(()=>validateSessionPolicy(p),'INVALID_POLICY');}
  for(const input of [null,undefined,{},[],{...fixture(),extra:'unexpected'}])rejects(()=>validateSessionPolicy(input),'INVALID_POLICY');
});
test('CP1 policy: duration types, bounds and contradictory timeouts fail closed',()=>{
  for(const key of ['idleTimeout','absoluteTimeout','jwtLifetime','refreshLead','refreshLease','stepUpMaxAge'])for(const value of [0,-1,0.5,NaN,Infinity,'1000',Number.MAX_SAFE_INTEGER+1])rejects(()=>validateSessionPolicy({...fixture(),[key]:value}),'INVALID_POLICY');
  for(const patch of [{idleTimeout:60001},{jwtLifetime:60001},{refreshLead:6000},{refreshLease:2001},{clockTolerance:-1},{clockTolerance:4000},{stepUpMaxAge:60001}])rejects(()=>validateSessionPolicy({...fixture(),...patch}),'INVALID_POLICY');
  assert.equal(validateSessionPolicy({...fixture(),clockTolerance:0}).clockTolerance,0);
});
test('CP1 policy: origins reject HTTP, credentials, wildcard, local/IP and non-origin URLs',()=>{
  for(const origin of ['http://hamdee.invalid','https://a:b@hamdee.invalid','https://*.invalid','https://localhost','https://127.0.0.1','https://hamdee.invalid/path','https://hamdee.invalid?x=1','https://hamdee.invalid#x','https://hamdee.invalid/'])rejects(()=>validateSessionPolicy({...fixture(),allowedOrigins:[origin]}),'INVALID_POLICY');
  for(const origins of [[],['https://hamdee.invalid','https://hamdee.invalid']])rejects(()=>validateSessionPolicy({...fixture(),allowedOrigins:origins}),'INVALID_POLICY');
});
test('CP1 policy: redirects must be canonical exact HTTPS destinations on approved origins',()=>{
  for(const redirect of ['/auth/callback','https://other.invalid/auth/callback','http://hamdee.invalid/auth/callback','https://hamdee.invalid/*','https://hamdee.invalid/a/../auth/callback','https://hamdee.invalid/auth/callback#token'])rejects(()=>validateSessionPolicy({...fixture(),redirectAllowlist:[redirect]}),'INVALID_POLICY');
  rejects(()=>validateSessionPolicy({...fixture(),redirectAllowlist:[]}),'INVALID_POLICY');
});
test('CP1 policy: proxy trust and logout scope require safe explicit alternatives',()=>{
  for(const proxy of [{mode:'all'},{mode:'exact',addresses:['*'],header:'x-forwarded-for'},{mode:'exact',addresses:['0.0.0.0'],header:'forwarded'},{mode:'exact',addresses:['10.0.0.0/8'],header:'forwarded'},{mode:'none',trustAll:true}])rejects(()=>validateSessionPolicy({...fixture(),trustedProxyPolicy:proxy}),'INVALID_POLICY');
  assert.equal(validateSessionPolicy({...fixture(),logoutScope:'all',trustedProxyPolicy:{mode:'exact',addresses:['192.0.2.10'],header:'forwarded'}}).logoutScope,'all');
  for(const scope of ['global','others',null])rejects(()=>validateSessionPolicy({...fixture(),logoutScope:scope}),'INVALID_POLICY');
});
test('CP1 policy: all limiter definitions and positive bounds/window/backoff are required',()=>{
  for(const flow of Object.keys(fixture().limits)){const p=fixture();delete p.limits[flow];rejects(()=>validateSessionPolicy(p),'INVALID_POLICY');}
  for(const field of ['bounds','window','backoff'])rejects(()=>validateSessionPolicy({...fixture(),limits:{...fixture().limits,login:{bounds:3,window:1000,backoff:200,[field]:0}}}),'INVALID_POLICY');
});
test('CP1 policy: Admin MFA/live status cannot be disabled; step-up actions cannot be omitted',()=>{
  for(const patch of [{administratorRequired:false},{requireLiveAdminSession:false},{otherRoles:'never'},{factor:'undecided'},{stepUpActions:[]},{stepUpActions:['membership_change','membership_change','factor_change','recovery_approval']}])rejects(()=>validateSessionPolicy({...fixture(),mfa:{...fixture().mfa,...patch}}),'INVALID_POLICY');
  rejects(()=>validateSessionPolicy({...fixture(),disablementBoundary:'last_write_wins'}),'INVALID_POLICY');
});
test('CP1 identity: project binding and subject/session metadata are projected without client roles',()=>{
  const result=validateIdentityMetadata({...identity,role:'admin',user_metadata:{admin:true},accessToken:'SYNTHETIC_DISCARDED'} as VerifiedIdentity,binding,at,validateSessionPolicy(fixture()));
  assert.deepEqual(result,identity);assert.doesNotMatch(JSON.stringify(result),/user_metadata|accessToken|SYNTHETIC_DISCARDED/);assert.ok(Object.isFrozen(result.binding));
});
test('CP1 identity: wrong provider/project/issuer/audience/environment/data class or identifiers rejected',()=>{
  const p=validateSessionPolicy(fixture());
  for(const patch of [{provider:'other'},{projectRef:'zzzzzzzzzzzzzzzzzzzz'},{issuer:'https://other.invalid/auth/v1'},{audience:'admin'},{environment:'production'},{dataClass:'real'}])rejects(()=>validateIdentityMetadata({...identity,binding:{...binding,...patch}} as VerifiedIdentity,binding,at,p),'INVALID_IDENTITY');
  rejects(()=>validateIdentityMetadata(identity,{...binding,accessToken:'SYNTHETIC_UNEXPECTED'} as IdentityBinding,at,p),'INVALID_IDENTITY');
  for(const patch of [{subject:'bad'},{providerSessionId:'bad'},{status:'anonymous'},{status:'disabled'},{status:'deleted'},{liveSessionStatus:'revoked'},{liveSessionStatus:'unavailable'}])rejects(()=>validateIdentityMetadata({...identity,...patch} as VerifiedIdentity,binding,at,p),'INVALID_IDENTITY');
});
test('CP1 identity: malformed/expired/future token times and contradictory assurance rejected',()=>{
  const p=validateSessionPolicy(fixture());
  for(const patch of [{expiresAt:at},{expiresAt:at+6001},{issuedAt:-1},{notBefore:at-1},{notBefore:at+101},{expiresAt:Infinity},{assurance:'aal3'},{assurance:'aal2'},{mfaVerifiedAt:at},{factorVerified:true}])rejects(()=>validateIdentityMetadata({...identity,...patch} as VerifiedIdentity,binding,at,p),'INVALID_IDENTITY');
  assert.equal(validateIdentityMetadata({...identity,assurance:'aal2',factorVerified:true,mfaVerifiedAt:at},binding,at,p).assurance,'aal2');
  rejects(()=>validateIdentityMetadata({...identity,assurance:'aal2',factorVerified:true,mfaVerifiedAt:at+1},binding,at,p),'INVALID_IDENTITY');
});
test('CP1 provider port: failures never yield a successful identity; no real provider instantiated',async()=>{
  const fail=async():Promise<SecurityResult<never>>=>({ok:false,failure:'unavailable'});
  const provider:IdentityProviderPort={verify:fail,refresh:fail,sessionStatus:fail,revoke:fail,enrollFactor:fail,challengeFactor:fail,verifyFactor:fail,verifyAssuranceAndFactors:fail};
  rejects(()=>requirePortSuccess({ok:false,failure:'ambiguous'}),'PORT_UNAVAILABLE');
  rejects(()=>requirePortSuccess(awaitedFailure),'PORT_UNAVAILABLE');
  const result=await provider.verify('SYNTHETIC_TEST_INPUT',binding);rejects(()=>requirePortSuccess(result),'PORT_UNAVAILABLE');
});
const awaitedFailure:SecurityResult<VerifiedIdentity>={ok:false,failure:'revoked'};
test('CP1 store port: illustrative fake CAS requires revision and atomic audit success',async()=>{
  let record:DurableSession|null=null,auditAvailable=true;
  const store:SessionStorePort={read:async hash=>({ok:true,value:record?.session.handleHash===hash?record:null}),create:async next=>{if(!auditAvailable)return {ok:false,failure:'unavailable'};if(record)return {ok:true,value:'conflict'};record=next;return {ok:true,value:'applied'};},
    compareAndSwap:async(hash,version,next)=>{if(!auditAvailable)return {ok:false,failure:'unavailable'};if(record?.session.handleHash!==hash||record.session.version!==version||next.session.version!==version+1)return {ok:true,value:'conflict'};record=next;return {ok:true,value:'applied'};}};
  const hash='a'.repeat(64),session=transitionSession(anonymousSession(at),{type:'primary_authenticated',expectedVersion:0,handleHash:hash,identity,membership:{issuer:binding.issuer,subject:identity.subject,enabled:true,revision:1,grants:[]}},binding,validateSessionPolicy(fixture()),at);
  const next:DurableSession={session,tokens:null};assert.equal(requirePortSuccess(await store.create(next,[])),'applied');
  assert.equal(requirePortSuccess(await store.compareAndSwap(hash,99,next,[])),'conflict');
  const candidate:DurableSession={session:{...session,version:session.version+1},tokens:null};
  const race=await Promise.all([store.compareAndSwap(hash,session.version,candidate,[]),store.compareAndSwap(hash,session.version,candidate,[])]);
  assert.deepEqual(race.map(requirePortSuccess),['applied','conflict']);auditAvailable=false;
  rejects(()=>requirePortSuccess({ok:false,failure:'rate_limited'}),'PORT_UNAVAILABLE');
  const result=await store.compareAndSwap(hash,candidate.session.version,{...candidate,session:{...candidate.session,version:candidate.session.version+1}},[]);rejects(()=>requirePortSuccess(result),'PORT_UNAVAILABLE');assert.equal(requirePortSuccess(await store.read(hash)),candidate);
});
// Compile-time contract witness; no operational policy constant is exported.
const typedPolicy:SessionPolicy=validateSessionPolicy(fixture());void typedPolicy;
