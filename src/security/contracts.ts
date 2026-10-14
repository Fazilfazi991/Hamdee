// CP1: server-internal contracts and structural validation only. No identity
// authenticity is established here; the future provider must verify signatures,
// claims, live sessions and factors before supplying a VerifiedIdentity.
export type SecurityCode='INVALID_POLICY'|'INVALID_IDENTITY'|'INVALID_STATE'|'STALE_REVISION'|'LEASE_CONFLICT'|'ACCESS_DENIED'|'PORT_UNAVAILABLE';
export class SecurityContractError extends Error {
  constructor(readonly code:SecurityCode){super('HAMDEE security precondition failed.');this.name='SecurityContractError';}
}
export function ensure(value:unknown,code:SecurityCode):asserts value {if(!value)throw new SecurityContractError(code);}
export const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const hashPattern=/^[0-9a-f]{64}$/;
export const timestamp=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export interface IdentityBinding {
  readonly provider:'supabase';readonly appId:'hamdee';readonly environment:'development';readonly dataClass:'synthetic_only';
  readonly projectRef:string;readonly issuer:string;readonly audience:'authenticated';
}
export interface VerifiedIdentity {
  readonly binding:IdentityBinding;readonly subject:string;readonly providerSessionId:string;
  readonly issuedAt:number;readonly notBefore:number;readonly expiresAt:number;
  readonly assurance:'aal1'|'aal2';readonly mfaVerifiedAt:number|null;readonly factorVerified:boolean;
  readonly status:'active'|'disabled'|'deleted'|'anonymous';readonly liveSessionStatus:'active'|'revoked'|'unavailable';
}
export interface TokenRules {readonly jwtLifetime:number;readonly clockTolerance:number}
export function validateBinding(value:IdentityBinding):void {
  const keys=['provider','appId','environment','dataClass','projectRef','issuer','audience'];
  ensure(value&&typeof value==='object'&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)),'INVALID_IDENTITY');
  ensure(value&&value.provider==='supabase'&&value.appId==='hamdee'&&value.environment==='development'&&value.dataClass==='synthetic_only'&&
    /^[a-z]{20}$/.test(value.projectRef)&&value.issuer==='https://'+value.projectRef+'.supabase.co/auth/v1'&&value.audience==='authenticated','INVALID_IDENTITY');
}
export function sameBinding(a:IdentityBinding,b:IdentityBinding):boolean {
  return a.provider===b.provider&&a.appId===b.appId&&a.environment===b.environment&&a.dataClass===b.dataClass&&a.projectRef===b.projectRef&&a.issuer===b.issuer&&a.audience===b.audience;
}
export function validateIdentityMetadata(value:VerifiedIdentity,expected:IdentityBinding,now:number,rules:TokenRules):VerifiedIdentity {
  validateBinding(expected);ensure(value&&typeof value==='object','INVALID_IDENTITY');validateBinding(value.binding);
  ensure(timestamp(now)&&timestamp(rules.jwtLifetime)&&rules.jwtLifetime>0&&timestamp(rules.clockTolerance)&&rules.clockTolerance<rules.jwtLifetime,'INVALID_IDENTITY');
  ensure(sameBinding(value.binding,expected)&&uuidPattern.test(value.subject)&&uuidPattern.test(value.providerSessionId)&&
    value.status==='active'&&value.liveSessionStatus==='active','INVALID_IDENTITY');
  ensure([value.issuedAt,value.notBefore,value.expiresAt].every(timestamp)&&value.issuedAt<=value.notBefore&&value.notBefore<value.expiresAt&&
    value.expiresAt-value.issuedAt<=rules.jwtLifetime&&value.issuedAt<=now+rules.clockTolerance&&value.notBefore<=now+rules.clockTolerance&&value.expiresAt>now,'INVALID_IDENTITY');
  ensure((value.assurance==='aal1'&&value.mfaVerifiedAt===null&&value.factorVerified===false)||
    (value.assurance==='aal2'&&value.factorVerified===true&&timestamp(value.mfaVerifiedAt)&&value.mfaVerifiedAt<=now&&value.mfaVerifiedAt<=value.issuedAt+rules.clockTolerance),'INVALID_IDENTITY');
  // Explicit projection drops arbitrary claims, tokens, user_metadata and roles.
  return Object.freeze({binding:Object.freeze({...expected}),subject:value.subject,providerSessionId:value.providerSessionId,
    issuedAt:value.issuedAt,notBefore:value.notBefore,expiresAt:value.expiresAt,assurance:value.assurance,
    mfaVerifiedAt:value.mfaVerifiedAt,factorVerified:value.factorVerified,status:value.status,liveSessionStatus:value.liveSessionStatus});
}
export type Role='admin'|'finance'|'operations'|'read_only';
export interface StoredGrant {readonly role:Role;readonly scope:Readonly<{kind:'portfolio'}|{kind:'properties';propertyIds:readonly string[]}>}
// Fresh server-resolved grants, never an identity-provider/browser role claim.
export interface MembershipSnapshot {
  readonly issuer:string;readonly subject:string;readonly enabled:boolean;readonly revision:number;readonly grants:readonly StoredGrant[];
}
export type SessionStatus='anonymous'|'primary_authenticated'|'mfa_required'|'authenticated'|'revoked'|'expired'|'recovery_pending';
export interface RefreshLease {readonly ownerId:string;readonly expiresAt:number}
export interface SessionRecord {
  readonly state:SessionStatus;readonly handleHash:string|null;readonly version:number;readonly observedAt:number;
  readonly identity:VerifiedIdentity|null;readonly membership:MembershipSnapshot|null;
  readonly createdAt:number|null;readonly lastActivityAt:number|null;readonly absoluteExpiresAt:number|null;
  readonly revokedAt:number|null;readonly reason:'logout'|'provider_revoked'|'disabled'|'recovery'|'idle'|'absolute'|null;
  readonly rotationRequired:boolean;readonly refreshLease:RefreshLease|null;
}
export type FailureKind='invalid_identity'|'expired'|'revoked'|'insufficient_assurance'|'rate_limited'|'unavailable'|'ambiguous';
export type SecurityResult<T>={readonly ok:true;readonly value:T}|{readonly ok:false;readonly failure:FailureKind};
export function requirePortSuccess<T>(result:SecurityResult<T>):T {ensure(result?.ok===true,'PORT_UNAVAILABLE');return result.value;}
// Raw provider tokens are ephemeral server-only inputs/outputs, never browser
// contracts or durable SessionRecord fields. Secret material must not be logged.
export interface ServerTokenPair {readonly accessToken:string;readonly refreshToken:string}
export interface TokenEnvelope {readonly keyVersion:string;readonly algorithm:string;readonly nonce:string;readonly ciphertext:string}
export interface IdentityProviderPort {
  verify(accessToken:string,binding:IdentityBinding):Promise<SecurityResult<VerifiedIdentity>>;
  refresh(refreshToken:string,binding:IdentityBinding):Promise<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>;
  sessionStatus(identity:VerifiedIdentity):Promise<SecurityResult<'active'|'revoked'>>;
  revoke(identity:VerifiedIdentity,scope:'local'|'all'):Promise<SecurityResult<void>>;
  enrollFactor(identity:VerifiedIdentity,factor:'totp'|'phone'):Promise<SecurityResult<{factorId:string;serverOnlyEnrollmentMaterial:string}>>;
  challengeFactor(identity:VerifiedIdentity,factorId:string):Promise<SecurityResult<{challengeId:string}>>;
  verifyFactor(identity:VerifiedIdentity,challengeId:string,code:string):Promise<SecurityResult<{identity:VerifiedIdentity;tokens:ServerTokenPair}>>;
  verifyAssuranceAndFactors(identity:VerifiedIdentity):Promise<SecurityResult<VerifiedIdentity>>;
}
export interface SecurityAuditEvent {
  readonly operationId:string;readonly actorSubject:string|null;readonly providerSessionId:string|null;
  readonly event:'primary_verified'|'mfa_verified'|'refresh'|'logout'|'revoked'|'disabled'|'recovery_started'|'privilege_changed'|'rotated'|'denied';
  readonly occurredAt:number;readonly sessionVersion:number;readonly outcome:'accepted'|'denied'|'reconciliation_required';
}
export interface DurableSession {readonly session:SessionRecord;readonly tokens:TokenEnvelope|null}
export type CasResult=SecurityResult<'applied'|'conflict'>;
export interface SessionStorePort {
  read(handleHash:string):Promise<SecurityResult<DurableSession|null>>;
  create(record:DurableSession,audit:readonly SecurityAuditEvent[]):Promise<CasResult>;
  // Atomic revision compare + session/token/audit commit. On failure nothing is
  // applied; conflict requires reread, never blind overwrite. Rotation consumes
  // old hash atomically and cannot reuse any retired hash. Revocations persist.
  compareAndSwap(handleHash:string,expectedVersion:number,next:DurableSession,audit:readonly SecurityAuditEvent[]):Promise<CasResult>;
}
export interface ClockPort {now():number}
export interface SecureRandomPort {bytes(length:number):Uint8Array}
export interface SessionHandlePort {hash(rawHandle:Uint8Array):Promise<string>}
export interface TokenEnvelopePort {seal(tokens:ServerTokenPair,binding:IdentityBinding):Promise<TokenEnvelope>;open(envelope:TokenEnvelope,binding:IdentityBinding):Promise<ServerTokenPair>}
export interface SecurityAuditPort {append(events:readonly SecurityAuditEvent[]):Promise<SecurityResult<void>>}
export type LimitedFlow='login'|'refresh'|'mfa'|'recovery'|'invitation'|'write';
export interface RateLimiterPort {consume(flow:LimitedFlow,serverDerivedKey:string,now:number):Promise<SecurityResult<{allowed:boolean;retryAt:number|null}>>}
export interface ProtectedOperationPermit {
  readonly handleHash:string;readonly sessionVersion:number;readonly membershipRevision:number;
  readonly subject:string;readonly providerSessionId:string;
}
