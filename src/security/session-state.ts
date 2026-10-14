import { ensure,hashPattern,timestamp,uuidPattern,validateBinding,validateIdentityMetadata,
  type IdentityBinding,type MembershipSnapshot,type ProtectedOperationPermit,type SessionRecord,type VerifiedIdentity } from './contracts';
import { validateSessionPolicy,type ElevatedAction,type SessionPolicy } from './session-policy';

type Versioned={readonly expectedVersion:number};
export type SessionEvent=Versioned&(
  |{readonly type:'primary_authenticated';readonly handleHash:string;readonly identity:VerifiedIdentity;readonly membership:MembershipSnapshot}
  |{readonly type:'evaluate_mfa'|'activity'|'expire'}
  |{readonly type:'mfa_completed';readonly handleHash:string;readonly identity:VerifiedIdentity}
  |{readonly type:'acquire_refresh';readonly ownerId:string}
  |{readonly type:'refresh_completed';readonly ownerId:string;readonly identity:VerifiedIdentity}
  |{readonly type:'logout'|'provider_revoked'|'disabled'|'recovery_started'}
  |{readonly type:'privileges_changed';readonly membership:MembershipSnapshot}
  |{readonly type:'assurance_changed';readonly identity:VerifiedIdentity}
  |{readonly type:'rotate';readonly handleHash:string}
);
const eventTypes:readonly SessionEvent['type'][]=['primary_authenticated','evaluate_mfa','activity','expire','mfa_completed',
  'acquire_refresh','refresh_completed','logout','provider_revoked','disabled','recovery_started','privileges_changed','assurance_changed','rotate'];
const terminal=(state:SessionRecord['state'])=>['revoked','expired','recovery_pending'].includes(state);
function member(value:MembershipSnapshot,identity:VerifiedIdentity):MembershipSnapshot {
  ensure(value&&value.issuer===identity.binding.issuer&&value.subject===identity.subject&&typeof value.enabled==='boolean'&&Number.isSafeInteger(value.revision)&&value.revision>0&&Array.isArray(value.grants),'INVALID_STATE');
  ensure(new Set(value.grants.map(g=>g.role)).size===value.grants.length,'INVALID_STATE');
  const grants=value.grants.map(grant=>{
    ensure(['admin','finance','operations','read_only'].includes(grant.role)&&grant.scope,'INVALID_STATE');
    const scope=grant.scope;
    ensure(scope.kind==='portfolio'||(scope.kind==='properties'&&Array.isArray(scope.propertyIds)&&scope.propertyIds.every((id:unknown)=>typeof id==='string'&&uuidPattern.test(id))&&new Set(scope.propertyIds).size===scope.propertyIds.length),'INVALID_STATE');
    return Object.freeze({role:grant.role,scope:Object.freeze(scope.kind==='portfolio'?{kind:'portfolio' as const}:{kind:'properties' as const,propertyIds:Object.freeze([...scope.propertyIds])})});
  });
  return Object.freeze({issuer:value.issuer,subject:value.subject,enabled:value.enabled,revision:value.revision,grants:Object.freeze(grants)});
}
function snapshot(record:SessionRecord):SessionRecord {
  return Object.freeze({...record,refreshLease:record.refreshLease?Object.freeze({...record.refreshLease}):null});
}
export function anonymousSession(now:number):SessionRecord {
  ensure(timestamp(now),'INVALID_STATE');return snapshot({state:'anonymous',handleHash:null,version:0,observedAt:now,identity:null,membership:null,
    createdAt:null,lastActivityAt:null,absoluteExpiresAt:null,revokedAt:null,reason:null,rotationRequired:false,refreshLease:null});
}
function checked(record:SessionRecord,binding:IdentityBinding,p:SessionPolicy):SessionRecord {
  const keys=['state','handleHash','version','observedAt','identity','membership','createdAt','lastActivityAt','absoluteExpiresAt','revokedAt','reason','rotationRequired','refreshLease'];
  ensure(record&&typeof record==='object'&&Object.keys(record).length===keys.length&&keys.every(k=>Object.hasOwn(record,k)),'INVALID_STATE');
  ensure(['anonymous','primary_authenticated','mfa_required','authenticated','revoked','expired','recovery_pending'].includes(record.state)&&Number.isSafeInteger(record.version)&&record.version>=0&&timestamp(record.observedAt)&&typeof record.rotationRequired==='boolean','INVALID_STATE');
  if(record.state==='anonymous'){
    ensure(record.version===0&&record.handleHash===null&&record.identity===null&&record.membership===null&&record.createdAt===null&&record.lastActivityAt===null&&record.absoluteExpiresAt===null&&record.revokedAt===null&&record.reason===null&&!record.rotationRequired&&record.refreshLease===null,'INVALID_STATE');return snapshot(record);
  }
  ensure(typeof record.handleHash==='string'&&hashPattern.test(record.handleHash)&&record.version>0&&record.identity&&record.membership,'INVALID_STATE');
  // Shape-check stored claims at their own issuance, allowing an expired token
  // to be refreshed while the separately bounded app session is still live.
  const identity=validateIdentityMetadata(record.identity,binding,Math.max(record.identity.issuedAt,record.identity.mfaVerifiedAt??0),p);
  const membership=member(record.membership,identity);
  ensure(timestamp(record.createdAt)&&timestamp(record.lastActivityAt)&&timestamp(record.absoluteExpiresAt)&&record.createdAt<=record.lastActivityAt&&record.lastActivityAt<=record.observedAt&&record.absoluteExpiresAt===record.createdAt+p.absoluteTimeout&&Number.isSafeInteger(record.absoluteExpiresAt)&&identity.issuedAt<=record.observedAt+p.clockTolerance&&(identity.mfaVerifiedAt===null||identity.mfaVerifiedAt<=record.observedAt),'INVALID_STATE');
  ensure(record.state==='revoked'?timestamp(record.revokedAt)&&['logout','provider_revoked','disabled'].includes(record.reason!):
    record.state==='recovery_pending'?timestamp(record.revokedAt)&&record.reason==='recovery':
    record.state==='expired'?record.revokedAt===null&&['idle','absolute'].includes(record.reason!):record.revokedAt===null&&record.reason===null,'INVALID_STATE');
  if(record.revokedAt!==null)ensure(record.revokedAt>=record.createdAt&&record.revokedAt<=record.observedAt,'INVALID_STATE');
  if(record.refreshLease)ensure(['authenticated','mfa_required'].includes(record.state)&&uuidPattern.test(record.refreshLease.ownerId)&&timestamp(record.refreshLease.expiresAt)&&record.refreshLease.expiresAt<=record.observedAt+p.refreshLease,'INVALID_STATE');
  if(terminal(record.state))ensure(record.refreshLease===null,'INVALID_STATE');
  return snapshot({...record,identity,membership});
}
function requiresMfa(record:SessionRecord,p:SessionPolicy):boolean {
  return !!record.membership?.grants.some(g=>g.role==='admin')||p.mfa.otherRoles==='required';
}
function hasMfa(identity:VerifiedIdentity):boolean {return identity.assurance==='aal2'&&identity.factorVerified&&identity.mfaVerifiedAt!==null;}
function next(current:SessionRecord,now:number,patch:Partial<SessionRecord>):SessionRecord {
  ensure(Number.isSafeInteger(current.version+1),'INVALID_STATE');return snapshot({...current,...patch,version:current.version+1,observedAt:now});
}
function expiration(record:SessionRecord,now:number,p:SessionPolicy):'absolute'|'idle'|null {
  if(record.state==='anonymous'||terminal(record.state))return null;
  if(now>=record.absoluteExpiresAt!)return 'absolute';
  return now-record.lastActivityAt!>=p.idleTimeout?'idle':null;
}
function newHash(hash:string,current:SessionRecord):void {ensure(typeof hash==='string'&&hashPattern.test(hash)&&hash!==current.handleHash,'INVALID_STATE');}
function sameSession(identity:VerifiedIdentity,current:SessionRecord,binding:IdentityBinding,now:number,p:SessionPolicy):VerifiedIdentity {
  const valid=validateIdentityMetadata(identity,binding,now,p);
  ensure(valid.subject===current.identity!.subject&&valid.providerSessionId===current.identity!.providerSessionId,'INVALID_IDENTITY');return valid;
}
// A lifecycle/assurance gate only. Actual same-grant property/capability checks
// remain the existing service's responsibility, with fresh DB membership.
export function businessPermit(current:SessionRecord,binding:IdentityBinding,policy:SessionPolicy,now:number,action:ElevatedAction|null):ProtectedOperationPermit {
  const p=validateSessionPolicy(policy);validateBinding(binding);const s=checked(current,binding,p);
  ensure(timestamp(now)&&now>=s.observedAt&&s.state==='authenticated'&&!s.rotationRequired&&!expiration(s,now,p)&&s.membership?.enabled&&s.membership.grants.length>0,'ACCESS_DENIED');
  const identity=validateIdentityMetadata(s.identity!,binding,now,p);
  ensure(!requiresMfa(s,p)||hasMfa(identity),'ACCESS_DENIED');
  if(action!==null){ensure(p.mfa.stepUpActions.includes(action)&&s.membership.grants.some(g=>g.role==='admin')&&hasMfa(identity)&&now-identity.mfaVerifiedAt!<p.stepUpMaxAge,'ACCESS_DENIED');}
  return Object.freeze({handleHash:s.handleHash!,sessionVersion:s.version,membershipRevision:s.membership.revision,subject:identity.subject,providerSessionId:identity.providerSessionId});
}
export function recheckProtectedOperation(current:SessionRecord,permit:ProtectedOperationPermit,binding:IdentityBinding,policy:SessionPolicy,now:number,action:ElevatedAction|null):void {
  const fresh=businessPermit(current,binding,policy,now,action);
  ensure(Object.keys(fresh).every(key=>fresh[key as keyof ProtectedOperationPermit]===permit[key as keyof ProtectedOperationPermit]),'STALE_REVISION');
}
export function transitionSession(current:SessionRecord,event:SessionEvent,binding:IdentityBinding,policy:SessionPolicy,now:number):SessionRecord {
  const p=validateSessionPolicy(policy);validateBinding(binding);const s=checked(current,binding,p);
  // Validate even at deadlines and on terminal retries. Only the four security
  // events may carry an older revision of this same loaded session.
  ensure(timestamp(now)&&now>=s.observedAt&&event&&typeof event==='object'&&!Array.isArray(event)&&
    typeof event.type==='string'&&eventTypes.includes(event.type)&&Number.isSafeInteger(event.expectedVersion)&&event.expectedVersion>=0,'INVALID_STATE');
  const revoking=['logout','provider_revoked','disabled','recovery_started'].includes(event.type);
  ensure(revoking?event.expectedVersion<=s.version:event.expectedVersion===s.version,'STALE_REVISION');
  if(revoking){
    ensure(s.state!=='anonymous','INVALID_STATE');
    // A recovery hold is stronger than expiration or ordinary revocation. It
    // has no completion/login escape in CP1, including after an expiry sweep.
    if(event.type==='recovery_started'){
      if(s.state==='recovery_pending')return s;
      return next(s,now,{state:'recovery_pending',reason:'recovery',revokedAt:now,refreshLease:null,rotationRequired:true});
    }
    if(event.type==='disabled'){
      if(s.state==='recovery_pending'){
        if(!s.membership!.enabled)return s;
        return next(s,now,{membership:Object.freeze({...s.membership!,enabled:false}),refreshLease:null,rotationRequired:true});
      }
      if(s.state==='revoked'&&s.reason==='disabled'&&!s.membership!.enabled)return s;
      return next(s,now,{state:'revoked',reason:'disabled',revokedAt:s.revokedAt??now,
        membership:Object.freeze({...s.membership!,enabled:false}),refreshLease:null,rotationRequired:true});
    }
    // Logout/provider revocation may strengthen ordinary expiry, but never
    // erase recovery or disabled membership. Duplicate revocations are no-ops.
    if(s.state==='recovery_pending'||s.state==='revoked')return s;
    return next(s,now,{state:'revoked',reason:event.type as 'logout'|'provider_revoked',revokedAt:now,refreshLease:null,rotationRequired:true});
  }
  const reason=expiration(s,now,p);
  // A valid, exactly versioned ordinary event cannot override a deadline.
  if(reason)return next(s,now,{state:'expired',reason,refreshLease:null,rotationRequired:true});
  if(event.type==='primary_authenticated'){
    ensure(['anonymous','revoked','expired'].includes(s.state),'INVALID_STATE');newHash(event.handleHash,s);
    const identity=validateIdentityMetadata(event.identity,binding,now,p),membership=member(event.membership,identity);
    ensure(membership.enabled&&Number.isSafeInteger(now+p.absoluteTimeout),'ACCESS_DENIED');
    return next(s,now,{state:'primary_authenticated',handleHash:event.handleHash,identity,membership,createdAt:now,lastActivityAt:now,absoluteExpiresAt:now+p.absoluteTimeout,revokedAt:null,reason:null,rotationRequired:false,refreshLease:null});
  }
  ensure(s.state!=='anonymous'&&!terminal(s.state),'INVALID_STATE');
  switch(event.type){
    case 'evaluate_mfa':{
      ensure(s.state==='primary_authenticated'&&!s.rotationRequired&&s.membership!.enabled,'INVALID_STATE');validateIdentityMetadata(s.identity!,binding,now,p);
      return next(s,now,{state:requiresMfa(s,p)&&!hasMfa(s.identity!)?'mfa_required':'authenticated'});
    }
    case 'mfa_completed':{
      ensure(['primary_authenticated','mfa_required','authenticated'].includes(s.state)&&s.membership!.enabled,'INVALID_STATE');newHash(event.handleHash,s);
      const identity=sameSession(event.identity,s,binding,now,p);
      ensure(hasMfa(identity)&&identity.mfaVerifiedAt!>=s.observedAt&&(s.identity!.mfaVerifiedAt===null||identity.mfaVerifiedAt!>s.identity!.mfaVerifiedAt),'INVALID_IDENTITY');
      return next(s,now,{state:'authenticated',identity,handleHash:event.handleHash,rotationRequired:false,refreshLease:null});
    }
    case 'activity':businessPermit(s,binding,p,now,null);return next(s,now,{lastActivityAt:now});
    case 'acquire_refresh':{
      ensure(['authenticated','mfa_required'].includes(s.state)&&!s.rotationRequired&&s.membership!.enabled&&uuidPattern.test(event.ownerId)&&Number.isSafeInteger(now+p.refreshLease),'INVALID_STATE');
      ensure(!s.refreshLease||(s.refreshLease.expiresAt<=now&&s.refreshLease.ownerId!==event.ownerId),'LEASE_CONFLICT');
      ensure(s.identity!.expiresAt-now<=p.refreshLead,'INVALID_STATE');
      return next(s,now,{refreshLease:{ownerId:event.ownerId,expiresAt:now+p.refreshLease}});
    }
    case 'refresh_completed':{
      ensure(s.refreshLease&&s.refreshLease.ownerId===event.ownerId&&s.refreshLease.expiresAt>now&&!s.rotationRequired&&s.membership!.enabled,'LEASE_CONFLICT');
      const identity=sameSession(event.identity,s,binding,now,p);
      ensure(identity.issuedAt>=s.identity!.issuedAt&&identity.assurance===s.identity!.assurance&&identity.mfaVerifiedAt===s.identity!.mfaVerifiedAt&&identity.factorVerified===s.identity!.factorVerified,'INVALID_IDENTITY');
      return next(s,now,{identity,refreshLease:null}); // Never extend idle/absolute or MFA recency.
    }
    case 'privileges_changed':{
      const membership=member(event.membership,s.identity!);ensure(membership.revision>s.membership!.revision,'STALE_REVISION');
      if(!membership.enabled)return next(s,now,{state:'revoked',membership,revokedAt:now,reason:'disabled',rotationRequired:true,refreshLease:null});
      const changed={...s,membership};return next(s,now,{membership,state:requiresMfa(changed,p)&&!hasMfa(s.identity!)?'mfa_required':'primary_authenticated',rotationRequired:true,refreshLease:null});
    }
    case 'assurance_changed':{
      const identity=sameSession(event.identity,s,binding,now,p);
      ensure(identity.assurance==='aal1'&&identity.issuedAt>=s.identity!.issuedAt,'INVALID_IDENTITY');
      return next(s,now,{identity,state:requiresMfa(s,p)?'mfa_required':'primary_authenticated',rotationRequired:true,refreshLease:null});
    }
    case 'rotate':newHash(event.handleHash,s);ensure(s.rotationRequired,'INVALID_STATE');return next(s,now,{handleHash:event.handleHash,rotationRequired:false,refreshLease:null});
    default:ensure(false,'INVALID_STATE');
  }
}
