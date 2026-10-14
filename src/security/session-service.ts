import type {
  CasResult,ClockPort,DurableSession,IdentityBinding,IdentityProviderPort,
  MembershipSnapshot,ProtectedOperationPermit,RateLimiterPort,SecureRandomPort,
  SecurityAuditEvent,SecurityAuditPort,SecurityResult,ServerTokenPair,
  SessionHandlePort,SessionStatus,TokenEnvelopePort,VerifiedIdentity
} from './contracts';
import type { ElevatedAction,SessionPolicy } from './session-policy';
import type { CsrfProtector,MutationContext } from './csrf';
import { SecurityContractError,hashPattern,timestamp,validateBinding,validateIdentityMetadata,
  type LimitedFlow,type SessionRecord,type TokenEnvelope } from './contracts';
import { elevatedActions,validateSessionPolicy } from './session-policy';
import { anonymousSession,businessPermit,transitionSession } from './session-state';

export type SessionServiceErrorCode='CP2_NOT_READY'|'SESSION_UNAVAILABLE'|'UNAUTHENTICATED'|'MFA_REQUIRED'|'STEP_UP_REQUIRED'|'ROTATION_REQUIRED'|'CSRF_REJECTED'|'RATE_LIMITED'|'CONFLICT';
const statuses:Readonly<Record<SessionServiceErrorCode,number>>={CP2_NOT_READY:503,SESSION_UNAVAILABLE:503,UNAUTHENTICATED:401,MFA_REQUIRED:403,STEP_UP_REQUIRED:403,ROTATION_REQUIRED:403,CSRF_REJECTED:403,RATE_LIMITED:429,CONFLICT:409};
export class SessionServiceError extends Error {
  readonly status:number;
  constructor(readonly code:SessionServiceErrorCode){super('HAMDEE session operation could not be authorized or confirmed.');this.name='SessionServiceError';this.status=statuses[code];}
}
/** Atomic subject-wide epoch/recovery tombstone is separate from one-hash CAS.
 * No operation in this contract clears recovery or enables membership. */
export interface SubjectSecuritySnapshot {
  readonly membership:MembershipSnapshot|null;
  readonly epoch:number;
  readonly recoveryPending:boolean;
}
export interface SubjectSecurityPort {
  read(binding:IdentityBinding,subject:string):Promise<SecurityResult<SubjectSecuritySnapshot>>;
  invalidate(input:Readonly<{binding:IdentityBinding;subject:string;expectedEpoch:number;reason:'logout_all'|'recovery';audit:readonly SecurityAuditEvent[]}>):Promise<CasResult>;
}
/** CP1 durability/CAS semantics plus the epoch captured at session creation.
 * The extension is required to reject all-device logout/recovery across new
 * handles; a single-hash session record alone cannot provide that guarantee. */
export interface StoredServiceSession extends DurableSession {readonly subjectEpoch:number}
export interface SessionServiceStorePort {
  read(handleHash:string):Promise<SecurityResult<StoredServiceSession|null>>;
  create(record:StoredServiceSession,audit:readonly SecurityAuditEvent[]):Promise<CasResult>;
  compareAndSwap(handleHash:string,expectedVersion:number,next:StoredServiceSession,audit:readonly SecurityAuditEvent[]):Promise<CasResult>;
}
export interface LoginChallengeRecord {readonly handleHash:string;readonly origin:string;readonly expiresAt:number}
export interface LoginChallengeStorePort {
  create(record:LoginChallengeRecord):Promise<CasResult>;
  /** Atomic single use; wrong origin, missing, consumed or deadline => false. */
  consume(handleHash:string,origin:string,now:number):Promise<SecurityResult<boolean>>;
}
export interface SessionServiceOptions {
  readonly binding:IdentityBinding;readonly policy:SessionPolicy;
  readonly provider:IdentityProviderPort;readonly store:SessionServiceStorePort;
  readonly subjects:SubjectSecurityPort;readonly challenges:LoginChallengeStorePort;
  readonly clock:ClockPort;readonly random:SecureRandomPort;readonly hasher:SessionHandlePort;
  readonly envelopes:TokenEnvelopePort;readonly csrf:CsrfProtector;
  readonly limiter:RateLimiterPort;readonly audit:SecurityAuditPort;
  readonly challengeLifetime:number;readonly maxCasAttempts:number;
}
/** Safe UI state only; neither roles nor this view authorize property access. */
export interface SessionView {
  readonly state:SessionStatus;readonly version:number;
  readonly idleExpiresAt:number|null;readonly absoluteExpiresAt:number|null;
}
/** Server transport outputs: raw handles go ONLY to future HttpOnly cookies,
 * not browser JavaScript/JSON. csrfToken/view may be sent to the same-origin UI. */
export interface LoginChallenge {readonly handle:string;readonly csrfToken:string;readonly expiresAt:number}
export interface SessionIssued {readonly handle:string;readonly csrfToken:string;readonly view:SessionView}
export interface AuthenticatedSession {
  readonly identity:VerifiedIdentity;readonly membership:MembershipSnapshot;
  readonly permit:ProtectedOperationPermit;readonly view:SessionView;
}
export interface RevocationResult {readonly localRevoked:true;readonly providerRevocation:'confirmed'|'reconciliation_required'}
export interface LoginInput {readonly challengeHandle:string;readonly tokens:ServerTokenPair;readonly context:MutationContext}
export interface SessionMutationInput {readonly handle:string;readonly context:MutationContext}
export interface MfaChallengeInput extends SessionMutationInput {readonly factorId:string}
export interface MfaCompletionInput extends SessionMutationInput {readonly challengeId:string;readonly code:string}
export interface AuthorizationInput {
  readonly handle:string;readonly action:ElevatedAction|null;
  /** null is read-only server use; every unsafe request must supply context. */
  readonly mutation:MutationContext|null;
}
export interface SessionService {
  issueLoginChallenge(input:Readonly<{origin:string;limiterKey:string}>):Promise<LoginChallenge>;
  login(input:LoginInput):Promise<SessionIssued>;
  challengeMfa(input:MfaChallengeInput):Promise<Readonly<{challengeId:string}>>;
  completeMfa(input:MfaCompletionInput):Promise<SessionIssued>;
  authorize(input:AuthorizationInput):Promise<AuthenticatedSession>;
  refresh(input:SessionMutationInput):Promise<SessionView>;
  rotate(input:SessionMutationInput):Promise<SessionIssued>;
  logout(input:SessionMutationInput):Promise<RevocationResult>;
  startRecovery(input:SessionMutationInput):Promise<RevocationResult>;
}
/** Offline, injected server orchestration. Not imported by deployable routes. */
export function createSessionService(options:SessionServiceOptions):SessionService {
  function fail(code:SessionServiceErrorCode='SESSION_UNAVAILABLE'):never {throw new SessionServiceError(code);}
  function immutable<T>(value:T):T {
    const cloned=structuredClone(value);
    const freeze=(item:unknown):void=>{
      if(item&&typeof item==='object'){for(const child of Object.values(item))freeze(child);Object.freeze(item);}
    };
    freeze(cloned);return cloned;
  }
  function capture<T extends object,K extends keyof T>(port:T,key:K):T[K] {
    const value=port?.[key];if(typeof value!=='function')fail();return (value as (...args:never[])=>unknown).bind(port) as T[K];
  }
  let binding:IdentityBinding,p:SessionPolicy,attempts:number,lifetime:number;
  try{
    binding=immutable(options.binding);validateBinding(binding);p=validateSessionPolicy(options.policy);
    attempts=options.maxCasAttempts;lifetime=options.challengeLifetime;
    if(!Number.isSafeInteger(attempts)||attempts<1||attempts>16||!timestamp(lifetime)||lifetime<1||lifetime>p.absoluteTimeout)fail();
  }catch{throw new SessionServiceError('SESSION_UNAVAILABLE');}
  // Capture methods, not mutable method lookups after an await. The receiver's
  // internal backing state remains the injected port's responsibility.
  const provider={verify:capture(options.provider,'verify'),refresh:capture(options.provider,'refresh'),
    sessionStatus:capture(options.provider,'sessionStatus'),revoke:capture(options.provider,'revoke'),
    challengeFactor:capture(options.provider,'challengeFactor'),verifyFactor:capture(options.provider,'verifyFactor'),
    verifyAssuranceAndFactors:capture(options.provider,'verifyAssuranceAndFactors')};
  const store={read:capture(options.store,'read'),create:capture(options.store,'create'),compareAndSwap:capture(options.store,'compareAndSwap')};
  const subjects={read:capture(options.subjects,'read'),invalidate:capture(options.subjects,'invalidate')};
  const challenges={create:capture(options.challenges,'create'),consume:capture(options.challenges,'consume')};
  const envelopes={seal:capture(options.envelopes,'seal'),open:capture(options.envelopes,'open')};
  const csrf={issue:capture(options.csrf,'issue'),assertMutation:capture(options.csrf,'assertMutation')};
  const clock=capture(options.clock,'now'),random=capture(options.random,'bytes'),hash=capture(options.hasher,'hash');
  const limit=capture(options.limiter,'consume'),append=capture(options.audit,'append');
  const handles=new Set<string>();
  function now():number {const n=clock();if(!timestamp(n))fail();return n;}
  function bytes(length:number):Buffer {
    const value=random(length);if(!(value instanceof Uint8Array)||value.byteLength!==length)fail();return Buffer.from(value);
  }
  function uuid():string {const b=bytes(16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
  async function result<T>(promise:Promise<SecurityResult<T>>):Promise<T> {
    let r:SecurityResult<T>;try{r=await promise;}catch{return fail();}
    if(!r||r.ok!==true){
      if(r?.ok===false){
        if(r.failure==='rate_limited')fail('RATE_LIMITED');
        if(['invalid_identity','expired','revoked'].includes(r.failure))fail('UNAUTHENTICATED');
        if(r.failure==='insufficient_assurance')fail('MFA_REQUIRED');
      }
      fail();
    }
    return immutable(r.value);
  }
  function audit(s:SessionRecord|null,event:SecurityAuditEvent['event'],outcome:SecurityAuditEvent['outcome']='accepted'):readonly SecurityAuditEvent[] {
    return immutable([{operationId:uuid(),actorSubject:s?.identity?.subject??null,providerSessionId:s?.identity?.providerSessionId??null,
      event,occurredAt:now(),sessionVersion:s?.version??0,outcome}]);
  }
  async function guarded<T>(work:()=>Promise<T>):Promise<T> {
    try{return await work();}catch(error){
      let code:SessionServiceErrorCode='SESSION_UNAVAILABLE';
      if(error instanceof SessionServiceError)code=error.code;
      else if(error instanceof SecurityContractError){
        code=error.code==='STALE_REVISION'||error.code==='LEASE_CONFLICT'?'CONFLICT':
          ['ACCESS_DENIED','INVALID_IDENTITY','INVALID_STATE'].includes(error.code)?'UNAUTHENTICATED':'SESSION_UNAVAILABLE';
      }
      // Denial audit is redacted; inability to record it cannot yield success.
      try{await result(append(audit(null,'denied','denied')));}catch{code='SESSION_UNAVAILABLE';}
      throw new SessionServiceError(code);
    }
  }
  function context(value:MutationContext):MutationContext {
    if(!value||typeof value!=='object'||typeof value.limiterKey!=='string'||!value.limiterKey.length||value.limiterKey.length>512||
      !(value.origin===null||typeof value.origin==='string')||!(value.csrfToken===null||typeof value.csrfToken==='string'))fail('CSRF_REJECTED');
    return immutable({origin:value.origin,csrfToken:value.csrfToken,limiterKey:value.limiterKey});
  }
  function proof(ctx:MutationContext,handleHash:string,purpose:'login'|'session'='session'):void {
    try{csrf.assertMutation(ctx,immutable({identityBinding:binding,purpose,handleHash}),p);}catch{fail('CSRF_REJECTED');}
  }
  async function limited(flow:LimitedFlow,key:string):Promise<void> {
    if(typeof key!=='string'||!key.length||key.length>512)fail('CSRF_REJECTED');
    const r=await result(limit(flow,key,now()));
    if(!r||typeof r.allowed!=='boolean'||!(r.retryAt===null||timestamp(r.retryAt)))fail();
    if(!r.allowed)fail('RATE_LIMITED');
  }
  async function handle(raw:string):Promise<string> {
    if(typeof raw!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(raw))fail('UNAUTHENTICATED');
    const b=Buffer.from(raw,'base64url');if(b.length!==32||b.toString('base64url')!==raw)fail('UNAUTHENTICATED');
    const h=await hash(b);if(typeof h!=='string'||!hashPattern.test(h))fail();return h;
  }
  async function newHandle():Promise<{handle:string;hash:string}> {
    const raw=bytes(32).toString('base64url');if(handles.has(raw))fail();handles.add(raw);
    return {handle:raw,hash:await handle(raw)};
  }
  function tokens(value:ServerTokenPair):ServerTokenPair {
    if(!value||typeof value.accessToken!=='string'||typeof value.refreshToken!=='string'||
      [value.accessToken,value.refreshToken].some(t=>!t.length||t.length>16384||!/^[\x21-\x7e]+$/.test(t)))fail('UNAUTHENTICATED');
    return immutable({accessToken:value.accessToken,refreshToken:value.refreshToken});
  }
  function envelope(value:TokenEnvelope):TokenEnvelope {
    if(!value||Object.keys(value).length!==4||!['keyVersion','algorithm','nonce','ciphertext'].every(k=>typeof value[k as keyof TokenEnvelope]==='string'&&value[k as keyof TokenEnvelope].length>0&&value[k as keyof TokenEnvelope].length<=45000))fail();
    return immutable(value);
  }
  function identity(value:VerifiedIdentity,old?:VerifiedIdentity):VerifiedIdentity {
    const valid=validateIdentityMetadata(value,binding,now(),p);
    if(old&&(valid.subject!==old.subject||valid.providerSessionId!==old.providerSessionId))fail('UNAUTHENTICATED');return valid;
  }
  function member(value:MembershipSnapshot,who:VerifiedIdentity):MembershipSnapshot {
    // Reuse the frozen CP1 grant validator without requiring the stored JWT to
    // be unexpired (refresh is allowed within a still-live app session).
    const at=Math.max(who.issuedAt,who.mfaVerifiedAt??0);
    return transitionSession(anonymousSession(at),{type:'primary_authenticated',expectedVersion:0,handleHash:'0'.repeat(64),
      identity:who,membership:{...immutable(value),enabled:true}},binding,p,at).membership!;
  }
  async function subject(who:VerifiedIdentity):Promise<SubjectSecuritySnapshot> {
    const r=await result(subjects.read(binding,who.subject));
    if(!r||!Number.isSafeInteger(r.epoch)||r.epoch<0||typeof r.recoveryPending!=='boolean')fail();
    if(r.membership===null)return immutable(r);
    if(typeof r.membership.enabled!=='boolean')fail();
    const m=member(r.membership,who);
    return immutable({epoch:r.epoch,recoveryPending:r.recoveryPending,membership:{...m,enabled:r.membership.enabled}});
  }
  async function readRaw(h:string):Promise<StoredServiceSession> {
    const r=await result(store.read(h));
    if(!r||Object.keys(r).length!==3||!r.session||r.session.handleHash!==h||!r.session.identity||
      !Number.isSafeInteger(r.subjectEpoch)||r.subjectEpoch<0)fail('UNAUTHENTICATED');
    // Validate the full stored CP1 shape even for terminal/expired records.
    transitionSession(r.session,{type:'provider_revoked',expectedVersion:r.session.version},binding,p,now());
    if(r.tokens!==null)envelope(r.tokens);return r;
  }
  async function cas(h:string,old:StoredServiceSession,next:StoredServiceSession,event:SecurityAuditEvent['event']):Promise<boolean> {
    const r=await result(store.compareAndSwap(h,old.session.version,immutable(next),audit(next.session,event)));
    if(r!=='applied'&&r!=='conflict')fail();return r==='applied';
  }
  async function securityCommit(h:string,type:'logout'|'provider_revoked'|'disabled'|'recovery_started',expectedOwner?:string):Promise<StoredServiceSession> {
    for(let i=0;i<attempts;i++){
      const r=await readRaw(h);
      // A late refresh failure belongs only to its own lease; it cannot revoke
      // a newer lease/MFA/rotation winner. Unconditional security intent from
      // logout/disablement/recovery still wins through the ordinary path.
      if(expectedOwner!==undefined&&r.session.refreshLease?.ownerId!==expectedOwner)return r;
      const s=transitionSession(r.session,{type,expectedVersion:r.session.version},binding,p,now());
      if(s.version===r.session.version&&r.tokens===null)return r;
      const next=immutable({...r,tokens:null,session:s.version===r.session.version?{...s,version:s.version+1,observedAt:now()}:s});
      if(await cas(h,r,next,type==='provider_revoked'?'revoked':type==='recovery_started'?'recovery_started':type))return next;
    }
    return fail('CONFLICT');
  }
  async function fresh(h:string):Promise<StoredServiceSession> {
    for(let i=0;i<attempts;i++){
      const r=await readRaw(h),sub=await subject(r.session.identity!);
      const restriction=sub.recoveryPending?'recovery_started':!sub.membership?.enabled?'disabled':sub.epoch!==r.subjectEpoch?'provider_revoked':null;
      if(restriction){
        await securityCommit(h,restriction);
        if(sub.recoveryPending&&!sub.membership?.enabled)await securityCommit(h,'disabled');
        fail('UNAUTHENTICATED');
      }
      if(['revoked','expired','recovery_pending'].includes(r.session.state))fail('UNAUTHENTICATED');
      const m=sub.membership!;
      if(m.revision<r.session.membership!.revision)fail();
      if(m.revision===r.session.membership!.revision&&JSON.stringify(m)!==JSON.stringify(r.session.membership))fail();
      if(m.revision>r.session.membership!.revision){
        const s=transitionSession(r.session,{type:'privileges_changed',expectedVersion:r.session.version,membership:m},binding,p,now());
        if(await cas(h,r,{...r,session:s,tokens:s.state==='revoked'?null:r.tokens},'privilege_changed'))continue;
        continue;
      }
      const n=now();
      if(n>=r.session.absoluteExpiresAt!||n-r.session.lastActivityAt!>=p.idleTimeout){
        const s=transitionSession(r.session,{type:'expire',expectedVersion:r.session.version},binding,p,n);
        if(!await cas(h,r,{...r,session:s,tokens:null},'revoked'))continue;
        fail('UNAUTHENTICATED');
      }
      return r;
    }
    return fail('CONFLICT');
  }
  async function confirm(h:string,expected:StoredServiceSession,requireToken=true):Promise<StoredServiceSession> {
    const r=await fresh(h);
    if(r.session.version!==expected.session.version||r.subjectEpoch!==expected.subjectEpoch)fail('CONFLICT');
    // A logout can complete while the subject read is awaiting I/O. Never return
    // an earlier loaded active record after that completion.
    const last=await readRaw(h);
    if(last.session.version!==r.session.version||last.subjectEpoch!==r.subjectEpoch)fail('CONFLICT');
    if(['revoked','expired','recovery_pending'].includes(last.session.state))fail('UNAUTHENTICATED');
    const n=now();
    if(n>=last.session.absoluteExpiresAt!||n-last.session.lastActivityAt!>=p.idleTimeout)fail('UNAUTHENTICATED');
    if(requireToken)identity(last.session.identity!);
    return last;
  }
  async function live(who:VerifiedIdentity):Promise<VerifiedIdentity> {
    if(await result(provider.sessionStatus(who))!=='active')fail('UNAUTHENTICATED');
    const checked=identity(await result(provider.verifyAssuranceAndFactors(who)),who);
    // This port confirms existing assurance. Only explicit MFA completion may
    // elevate assurance or change the verified-factor timestamp.
    if(checked.assurance!==who.assurance||checked.mfaVerifiedAt!==who.mfaVerifiedAt||checked.factorVerified!==who.factorVerified||
      checked.issuedAt!==who.issuedAt||checked.notBefore!==who.notBefore||checked.expiresAt!==who.expiresAt)fail('MFA_REQUIRED');
    return checked;
  }
  function view(r:StoredServiceSession):SessionView {
    return Object.freeze({state:r.session.state,version:r.session.version,
      idleExpiresAt:r.session.lastActivityAt===null?null:r.session.lastActivityAt+p.idleTimeout,absoluteExpiresAt:r.session.absoluteExpiresAt});
  }
  function issued(raw:string,r:StoredServiceSession):SessionIssued {
    return Object.freeze({handle:raw,csrfToken:csrf.issue(immutable({identityBinding:binding,purpose:'session',handleHash:r.session.handleHash!})),view:view(r)});
  }
  function mutation(input:SessionMutationInput):{raw:string;ctx:MutationContext} {
    if(!input||typeof input.handle!=='string')fail('UNAUTHENTICATED');return {raw:input.handle,ctx:context(input.context)};
  }
  async function begin(input:{raw:string;ctx:MutationContext},flow:LimitedFlow):Promise<{h:string;r:StoredServiceSession}> {
    const h=await handle(input.raw);proof(input.ctx,h);await limited(flow,input.ctx.limiterKey);return {h,r:await fresh(h)};
  }
  async function invalidation(r:StoredServiceSession,reason:'logout_all'|'recovery'):Promise<void> {
    for(let i=0;i<attempts;i++){
      const sub=await subject(r.session.identity!);
      if(reason==='recovery'&&sub.recoveryPending)return;
      // An old logout cannot repeatedly invalidate new sessions. A stale handle
      // cannot start a new recovery after an all-device logout either.
      if(sub.epoch!==r.subjectEpoch){if(reason==='logout_all')return;fail('UNAUTHENTICATED');}
      if(!Number.isSafeInteger(sub.epoch+1))fail();
      const applied=await result(subjects.invalidate(immutable({binding,subject:r.session.identity!.subject,expectedEpoch:sub.epoch,reason,
        audit:audit(r.session,reason==='recovery'?'recovery_started':'logout')})));
      if(applied==='applied')return;if(applied!=='conflict')fail();
    }
    fail('CONFLICT');
  }
  async function revoke(input:SessionMutationInput,recovery:boolean):Promise<RevocationResult> {
    const {raw,ctx}=mutation(input),h=await handle(raw);proof(ctx,h);await limited(recovery?'recovery':'write',ctx.limiterKey);
    const old=await readRaw(h);
    if(recovery||p.logoutScope==='all')await invalidation(old,recovery?'recovery':'logout_all');
    const local=await securityCommit(h,recovery?'recovery_started':'logout');
    let confirmed=false;
    try{const r=await provider.revoke(immutable(old.session.identity!),recovery?'all':p.logoutScope);confirmed=r?.ok===true;}catch{/* Local denial already committed. */}
    if(!confirmed)await result(append(audit(local.session,recovery?'recovery_started':'logout','reconciliation_required')));
    return Object.freeze({localRevoked:true,providerRevocation:confirmed?'confirmed':'reconciliation_required'});
  }
  return Object.freeze<SessionService>({
    issueLoginChallenge(input){return guarded(async()=>{
      const value=immutable(input);
      if(!value||typeof value.origin!=='string'||!p.allowedOrigins.includes(value.origin))fail('CSRF_REJECTED');
      await limited('login',value.limiterKey);
      const raw=await newHandle(),expiresAt=now()+lifetime;if(!timestamp(expiresAt))fail();
      const proofValue=csrf.issue(immutable({identityBinding:binding,purpose:'login',handleHash:raw.hash}));
      const created=await result(challenges.create(immutable({handleHash:raw.hash,origin:value.origin,expiresAt})));
      if(created!=='applied')fail('CONFLICT');
      return Object.freeze({handle:raw.handle,csrfToken:proofValue,expiresAt});
    });},
    login(input){return guarded(async()=>{
      const raw=input?.challengeHandle,provided=tokens(input?.tokens),ctx=context(input?.context);
      const h=await handle(raw);proof(ctx,h,'login');await limited('login',ctx.limiterKey);
      if(await result(challenges.consume(h,ctx.origin!,now()))!==true)fail('CSRF_REJECTED');
      const who=identity(await result(provider.verify(provided.accessToken,binding)));
      const verified=await live(who),sub=await subject(verified);
      if(sub.recoveryPending||!sub.membership?.enabled)fail('UNAUTHENTICATED');
      const generated=await newHandle(),sealed=envelope(await envelopes.seal(provided,binding));
      let s=transitionSession(anonymousSession(now()),{type:'primary_authenticated',expectedVersion:0,handleHash:generated.hash,identity:verified,membership:sub.membership},binding,p,now());
      s=transitionSession(s,{type:'evaluate_mfa',expectedVersion:s.version},binding,p,now());
      const next=immutable({session:s,tokens:sealed,subjectEpoch:sub.epoch});
      const last=await subject(verified);
      if(last.epoch!==sub.epoch||last.recoveryPending||!last.membership?.enabled||JSON.stringify(last.membership)!==JSON.stringify(sub.membership))fail('UNAUTHENTICATED');
      if(await result(store.create(next,audit(s,'primary_verified')))!=='applied')fail('CONFLICT');
      const current=await confirm(generated.hash,next);return issued(generated.handle,current);
    });},
    challengeMfa(input){return guarded(async()=>{
      const value=mutation(input),factorId=input?.factorId;
      if(typeof factorId!=='string'||!factorId.length||factorId.length>256||/\s/.test(factorId)||Array.from(factorId).some(c=>c.charCodeAt(0)<32))fail('MFA_REQUIRED');
      const {h,r}=await begin(value,'mfa');identity(r.session.identity!);
      await live(r.session.identity!);
      const response=await result(provider.challengeFactor(r.session.identity!,factorId));
      if(!response||typeof response.challengeId!=='string'||!response.challengeId.length||response.challengeId.length>256)fail();
      await confirm(h,r);return Object.freeze({challengeId:response.challengeId});
    });},
    completeMfa(input){return guarded(async()=>{
      const value=mutation(input),challengeId=input?.challengeId,code=input?.code;
      if(typeof challengeId!=='string'||!challengeId.length||challengeId.length>256||typeof code!=='string'||!code.length||code.length>128||/\s/.test(code))fail('MFA_REQUIRED');
      const {h,r}=await begin(value,'mfa');identity(r.session.identity!);
      const response=await result(provider.verifyFactor(r.session.identity!,challengeId,code));
      const who=identity(response.identity,r.session.identity!),provided=tokens(response.tokens);
      await live(who);
      const generated=await newHandle(),sealed=envelope(await envelopes.seal(provided,binding));
      const current=await confirm(h,r),s=transitionSession(current.session,{type:'mfa_completed',expectedVersion:current.session.version,handleHash:generated.hash,identity:who},binding,p,now());
      if(s.state!=='authenticated')fail('UNAUTHENTICATED');
      const next=immutable({...current,session:s,tokens:sealed});
      if(!await cas(h,current,next,'mfa_verified'))fail('CONFLICT');
      return issued(generated.handle,await confirm(generated.hash,next));
    });},
    authorize(input){return guarded(async()=>{
      const raw=input?.handle,action=input?.action,ctx=input?.mutation===null?null:context(input?.mutation);
      if(action!==null&&!elevatedActions.includes(action))fail('UNAUTHENTICATED');
      if(action!==null&&ctx===null)fail('CSRF_REJECTED');
      const h=await handle(raw);if(ctx){proof(ctx,h);await limited('write',ctx.limiterKey);}
      for(let i=0;i<attempts;i++){
        const r=await fresh(h);
        if(r.session.rotationRequired)fail('ROTATION_REQUIRED');
        if(r.session.state==='mfa_required')fail('MFA_REQUIRED');
        if(r.session.refreshLease)fail('CONFLICT');
        identity(r.session.identity!);await live(r.session.identity!);
        const current=await confirm(h,r);
        if(action!==null&&(current.session.identity!.mfaVerifiedAt===null||now()-current.session.identity!.mfaVerifiedAt>=p.stepUpMaxAge))fail('STEP_UP_REQUIRED');
        businessPermit(current.session,binding,p,now(),action);
        const s=transitionSession(current.session,{type:'activity',expectedVersion:current.session.version},binding,p,now());
        const next=immutable({...current,session:s});
        // CP1's audit vocabulary has no separate activity event. This event
        // records verified primary-session business authorization atomically
        // with the idle timestamp; it is not another provider sign-in.
        if(!await cas(h,current,next,'primary_verified'))continue;
        const committed=await confirm(h,next),permit=businessPermit(committed.session,binding,p,now(),action);
        return immutable({identity:committed.session.identity!,membership:committed.session.membership!,permit,view:view(committed)});
      }
      return fail('CONFLICT');
    });},
    refresh(input){return guarded(async()=>{
      const value=mutation(input);const h=await handle(value.raw);proof(value.ctx,h);await limited('refresh',value.ctx.limiterKey);
      let leased:StoredServiceSession|null=null;const ownerId=uuid();
      for(let i=0;i<attempts;i++){
        const r=await fresh(h);if(r.session.rotationRequired)fail('ROTATION_REQUIRED');
        const s=transitionSession(r.session,{type:'acquire_refresh',expectedVersion:r.session.version,ownerId},binding,p,now());
        if(s.state==='expired')fail('UNAUTHENTICATED');
        const next=immutable({...r,session:s});if(await cas(h,r,next,'refresh')){leased=next;break;}
      }
      if(!leased)fail('CONFLICT');
      try{
        if(!leased.tokens)fail();
        const provided=tokens(await envelopes.open(leased.tokens,binding));
        // Recheck after decrypt: logout/recovery during a slow crypto adapter
        // must prevent even starting provider refresh when already observable.
        await confirm(h,leased,false);
        const response=await result(provider.refresh(provided.refreshToken,binding));
        const who=identity(response.identity,leased.session.identity!),updated=tokens(response.tokens);
        await live(who);
        const sealed=envelope(await envelopes.seal(updated,binding));
        const current=await confirm(h,leased,false),s=transitionSession(current.session,{type:'refresh_completed',expectedVersion:current.session.version,ownerId,identity:who},binding,p,now());
        if(!['authenticated','mfa_required'].includes(s.state))fail('UNAUTHENTICATED');
        const next=immutable({...current,session:s,tokens:sealed});
        if(!await cas(h,current,next,'refresh'))fail('CONFLICT');
        return view(await confirm(h,next));
      }catch(error){
        // Never blindly replay a possibly rotated provider refresh token. A
        // failed/ambiguous completion denies the local handle persistently.
        try{await securityCommit(h,'provider_revoked',ownerId);}catch{/* Original failure remains fail closed; durable adapter reconciliation required. */}
        throw error;
      }
    });},
    rotate(input){return guarded(async()=>{
      const value=mutation(input),{h,r}=await begin(value,'write');identity(r.session.identity!);await live(r.session.identity!);
      const generated=await newHandle(),current=await confirm(h,r);
      const s=transitionSession({...current.session,rotationRequired:true},{type:'rotate',expectedVersion:current.session.version,handleHash:generated.hash},binding,p,now());
      const next=immutable({...current,session:s});if(!await cas(h,current,next,'rotated'))fail('CONFLICT');
      let complete=await confirm(generated.hash,next);
      if(complete.session.state==='primary_authenticated'){
        const evaluated=transitionSession(complete.session,{type:'evaluate_mfa',expectedVersion:complete.session.version},binding,p,now());
        const replacement=immutable({...complete,session:evaluated});
        if(!await cas(generated.hash,complete,replacement,'rotated'))fail('CONFLICT');complete=await confirm(generated.hash,replacement);
      }
      return issued(generated.handle,complete);
    });},
    logout(input){return guarded(()=>revoke(input,false));},
    startRecovery(input){return guarded(()=>revoke(input,true));}
  });
}
