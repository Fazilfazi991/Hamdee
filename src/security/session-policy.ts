import { isIP } from 'node:net';
import { ensure,type LimitedFlow } from './contracts';

export const elevatedActions=['membership_change','factor_change','recovery_approval','administrator_activation'] as const;
export type ElevatedAction=typeof elevatedActions[number];
export interface LimitPolicy {readonly bounds:number;readonly window:number;readonly backoff:number}
export interface SessionPolicy {
  readonly idleTimeout:number;readonly absoluteTimeout:number;readonly jwtLifetime:number;readonly refreshLead:number;
  readonly refreshLease:number;readonly clockTolerance:number;readonly stepUpMaxAge:number;
  readonly allowedOrigins:readonly string[];readonly redirectAllowlist:readonly string[];readonly logoutScope:'local'|'all';
  readonly trustedProxyPolicy:Readonly<{mode:'none'}|{mode:'exact';addresses:readonly string[];header:'forwarded'|'x-forwarded-for'}>;
  readonly limits:Readonly<Record<LimitedFlow,LimitPolicy>>;
  readonly mfa:Readonly<{administratorRequired:true;requireLiveAdminSession:true;otherRoles:'required'|'optional';factor:'totp'|'phone';stepUpActions:readonly ElevatedAction[]}>;
  // Required future commit-time decision; CP1 models optimistic revalidation,
  // not a database lock, transaction orchestration or an in-flight guarantee.
  readonly disablementBoundary:'recheck_at_commit'|'member_lock';
}
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  ensure(value&&typeof value==='object'&&!Array.isArray(value),'INVALID_POLICY');
  const record=value as Record<string,unknown>;
  ensure(Object.keys(record).length===keys.length&&keys.every(key=>Object.hasOwn(record,key)),'INVALID_POLICY');return record;
}
function duration(value:unknown,zero=false):asserts value is number {
  ensure(typeof value==='number'&&Number.isSafeInteger(value)&&(zero?value>=0:value>0),'INVALID_POLICY');
}
function urls(value:unknown,origins?:readonly string[]):readonly string[] {
  ensure(Array.isArray(value)&&value.length>0&&value.every(x=>typeof x==='string')&&new Set(value).size===value.length,'INVALID_POLICY');
  for(const raw of value){
    let url:URL;try{url=new URL(raw);}catch{ensure(false,'INVALID_POLICY');}
    ensure(!/[\s*\\]/.test(raw)&&url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&url.hostname!=='localhost'&&!isIP(url.hostname.replace(/^\[|\]$/g,'')),'INVALID_POLICY');
    ensure(origins?origins.includes(url.origin)&&url.href===raw:url.origin===raw&&url.pathname==='/'&&!url.search,'INVALID_POLICY');
  }
  return Object.freeze([...value]);
}
export function validateSessionPolicy(input:unknown):SessionPolicy {
  const p=object(input,['idleTimeout','absoluteTimeout','jwtLifetime','refreshLead','refreshLease','clockTolerance','stepUpMaxAge','allowedOrigins','redirectAllowlist','logoutScope','trustedProxyPolicy','limits','mfa','disablementBoundary']);
  for(const key of ['idleTimeout','absoluteTimeout','jwtLifetime','refreshLead','refreshLease','stepUpMaxAge'])duration(p[key]);duration(p.clockTolerance,true);
  const n=p as unknown as SessionPolicy;
  ensure(n.idleTimeout<=n.absoluteTimeout&&n.jwtLifetime<=n.absoluteTimeout&&n.stepUpMaxAge<=n.absoluteTimeout&&n.refreshLead<n.jwtLifetime&&n.refreshLease<=n.refreshLead&&n.clockTolerance<n.jwtLifetime&&n.clockTolerance<n.stepUpMaxAge,'INVALID_POLICY');
  const allowedOrigins=urls(p.allowedOrigins),redirectAllowlist=urls(p.redirectAllowlist,allowedOrigins);
  ensure(p.logoutScope==='local'||p.logoutScope==='all','INVALID_POLICY');
  const proxy=p.trustedProxyPolicy as Record<string,unknown>;
  let trustedProxyPolicy:SessionPolicy['trustedProxyPolicy'];
  if(proxy?.mode==='none'){object(proxy,['mode']);trustedProxyPolicy=Object.freeze({mode:'none'});}
  else{
    object(proxy,['mode','addresses','header']);ensure(proxy.mode==='exact'&&['forwarded','x-forwarded-for'].includes(proxy.header as string)&&Array.isArray(proxy.addresses)&&proxy.addresses.length>0,'INVALID_POLICY');
    const addresses=proxy.addresses as string[];
    ensure(new Set(addresses).size===addresses.length&&addresses.every(ip=>typeof ip==='string'&&isIP(ip)>0&&!['0.0.0.0','::'].includes(ip)),'INVALID_POLICY');
    trustedProxyPolicy=Object.freeze({mode:'exact',addresses:Object.freeze([...addresses]),header:proxy.header as 'forwarded'|'x-forwarded-for'});
  }
  const flows:LimitedFlow[]=['login','refresh','mfa','recovery','invitation','write'];const limits=object(p.limits,flows);const checked={} as Record<LimitedFlow,LimitPolicy>;
  for(const flow of flows){const limit=object(limits[flow],['bounds','window','backoff']);for(const v of Object.values(limit))duration(v);checked[flow]=Object.freeze({...limit}) as unknown as LimitPolicy;}
  const mfa=object(p.mfa,['administratorRequired','requireLiveAdminSession','otherRoles','factor','stepUpActions']);
  const actions=mfa.stepUpActions;
  ensure(mfa.administratorRequired===true&&mfa.requireLiveAdminSession===true&&['required','optional'].includes(mfa.otherRoles as string)&&['totp','phone'].includes(mfa.factor as string)&&
    Array.isArray(actions)&&actions.length===elevatedActions.length&&new Set(actions).size===elevatedActions.length&&elevatedActions.every(a=>actions.includes(a)),'INVALID_POLICY');
  ensure(['recheck_at_commit','member_lock'].includes(p.disablementBoundary as string),'INVALID_POLICY');
  return Object.freeze({...n,allowedOrigins,redirectAllowlist,trustedProxyPolicy,limits:Object.freeze(checked),
    mfa:Object.freeze({...n.mfa,stepUpActions:Object.freeze([...n.mfa.stepUpActions])})});
}
