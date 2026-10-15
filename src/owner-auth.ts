import type { Identity } from './auth';
import { ApiError } from './errors';
import { createClient,type SupabaseClient } from '@supabase/supabase-js';
import { createCipheriv,createDecipheriv,createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import { uuid } from './validation';

/** Server-only provider credentials; never browser JSON, storage or logs. */
export interface OwnerTokenPair { readonly accessToken:string;readonly refreshToken:string }
export interface OwnerTotpFactor { readonly id:string;readonly status:'verified'|'unverified' }
/** A concrete adapter proves a current managed password session, verified
 * claims and confirmed mailbox. Factor metadata is compatibility data only. */
export interface OwnerProviderSession {
  readonly identity:Identity;
  readonly email:string;
  readonly emailConfirmed:boolean;
  readonly passwordAuthenticatedAt:number;
  readonly sessionId:string;
  readonly assurance:'aal1'|'aal2';
  readonly expiresAt:number;
  readonly mfaVerifiedAt:number|null;
  readonly factors:readonly OwnerTotpFactor[];
  readonly tokens:OwnerTokenPair;
}
export interface OwnerManagedProvider {
  signIn(email:string,password:string):Promise<OwnerProviderSession>;
  /** Mandatory managed refresh/revocation gate on EVERY cookie-authenticated
   * request. getUser/getClaims or a locally valid JWT alone do not satisfy it. */
  verifySession(tokens:OwnerTokenPair):Promise<OwnerProviderSession>;
  enrollTotp(tokens:OwnerTokenPair):Promise<Readonly<{session:OwnerProviderSession;factorId:string;qrCode:string}>>;
  verifyTotp(tokens:OwnerTokenPair,factorId:string,code:string):Promise<OwnerProviderSession>;
  /** Global managed sign-out. Failure must never be reported as confirmed. */
  signOut(tokens:OwnerTokenPair):Promise<void>;
}
export interface ManagedOwnerProviderOptions {
  readonly supabaseUrl:string;
  readonly publishableKey:string;
  readonly requestTimeoutMs:number;
  /** Test-only constructor injection; never selected by deployable env flags. */
  readonly fetch?:typeof fetch;
}
export interface OwnerAuthPolicy {
  readonly owner:Identity;
  readonly ownerEmail:string;
  readonly projectRef:string;
  readonly origin:string;
  /** false accepted only by injected loopback test compositions. */
  readonly cookieSecure:boolean;
  readonly idleTimeoutMs:number;
  readonly absoluteTimeoutMs:number;
  readonly csrfLifetimeMs:number;
}
export type OwnerAuthFlow='login'|'mfa'|'refresh'|'recovery'|'write';
export interface OwnerRateLimiter {
  consume(flow:OwnerAuthFlow,serverDerivedKey:string,now:number):Promise<boolean>;
}
export interface OwnerAuthAuditEvent {
  readonly event:'login'|'mfa_enrollment'|'mfa_verified'|'logout'|'recovery_prepared'|'denied';
  readonly outcome:'accepted'|'denied'|'unconfirmed';
  readonly requestId:string;
}
export interface OwnerAuthAudit { append(event:OwnerAuthAuditEvent):Promise<void> }
export interface OwnerAuthOptions {
  readonly policy:OwnerAuthPolicy;
  readonly provider:OwnerManagedProvider;
  readonly cookieKey:Uint8Array;
  readonly clock:()=>number;
  readonly randomBytes:(length:number)=>Uint8Array;
  readonly limiter:OwnerRateLimiter;
  readonly audit:OwnerAuthAudit;
}
export type OwnerAuthPhase='anonymous'|'authenticated'|'recovery_pending';
/** Safe browser projection. No identity, password, OTP or provider tokens. */
export interface OwnerAuthState {
  readonly state:OwnerAuthPhase;
  readonly csrfToken:string;
  readonly expiresAt:number|null;
  readonly factors:readonly OwnerTotpFactor[];
}
export interface OwnerEnrollmentState extends OwnerAuthState {
  readonly enrollment:Readonly<{factorId:string;qrCodeDataUrl:string}>;
}
/** Server-only result: caller appends each Set-Cookie line independently. */
export interface OwnerAuthorization {
  readonly identity:Identity;
  readonly sessionId:string;
  readonly state:OwnerAuthState;
  readonly setCookies:readonly string[];
}
export interface OwnerAuthController {
  handle(request:Request):Promise<Response>;
  /** Requires the sole confirmed owner and managed password authentication. Unsafe methods
   * additionally require exact Origin and session-bound X-Hamdee-CSRF. */
  authorize(request:Request):Promise<OwnerAuthorization>;
}
const ownerMessages:Readonly<Record<string,string>>={
  CONFIGURATION_UNAVAILABLE:'The dedicated owner backend is not configured.',AUTH_UNAVAILABLE:'Authentication could not be confirmed. Try again.',
  UNAUTHENTICATED:'Sign in with an authorized account.',OWNER_ACCESS_DENIED:'This account cannot access this CRM.',
  MFA_REQUIRED:'Verify your owner authenticator to continue.',CSRF_REJECTED:'Reload the sign-in state and try again.',
  RATE_LIMITED:'Too many attempts. Wait before trying again.',SIGN_OUT_UNCONFIRMED:'Local cookies were cleared. Server sign-out could not be confirmed.',
  FACTOR_ALREADY_ENROLLED:'Use your existing owner authenticator.',INVALID_JSON:'Submit valid JSON.',PAYLOAD_TOO_LARGE:'The submission is too large.',
  JSON_REQUIRED:'Submit JSON.',VALIDATION_FAILED:'Check the submitted fields.',NOT_FOUND:'Endpoint not found.',METHOD_NOT_ALLOWED:'This method is unavailable.'
};
function ownerError(status:number,code:string):ApiError {return new ApiError(status,code,ownerMessages[code]||ownerMessages.AUTH_UNAVAILABLE);}
function ownerRequire(value:unknown,status:number,code:string):asserts value {if(!value)throw ownerError(status,code);}
function detached<T>(value:T):T {const result=structuredClone(value);const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}};freeze(result);return result;}
const milliseconds=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function pair(value:OwnerTokenPair):OwnerTokenPair {
  ownerRequire(value&&Object.keys(value).length===2&&[value.accessToken,value.refreshToken].every(t=>typeof t==='string'&&t.length>0&&t.length<=16384&&/^[\x21-\x7e]+$/.test(t)),401,'UNAUTHENTICATED');
  return detached({accessToken:value.accessToken,refreshToken:value.refreshToken});
}
function providerError(error:unknown,mfa=false):never {
  if(error instanceof ApiError)throw ownerError(error.status,ownerMessages[error.code]?error.code:'AUTH_UNAVAILABLE');
  const e=error as {status?:number;code?:string}|null;
  if(e?.status===429)throw ownerError(429,'RATE_LIMITED');
  if(e?.status&&[400,401,403,404,422].includes(e.status))throw ownerError(mfa?403:401,mfa?'MFA_REQUIRED':'UNAUTHENTICATED');
  throw ownerError(503,'AUTH_UNAVAILABLE');
}
/** Each operation has its own SDK client/in-memory session and bounded fetch.
 * No storage, listeners, auto-refresh, admin credential or provider I/O at construction. */
export function createManagedOwnerProvider(options:ManagedOwnerProviderOptions):OwnerManagedProvider {
  const url=options.supabaseUrl,key=options.publishableKey,timeout=options.requestTimeoutMs,transport=options.fetch??globalThis.fetch;
  let parsed:URL;try{parsed=new URL(url);}catch{throw ownerError(503,'CONFIGURATION_UNAVAILABLE');}
  ownerRequire(parsed.protocol==='https:'&&/^[a-z]{20}\.supabase\.co$/.test(parsed.hostname)&&parsed.origin===url&&!parsed.username&&!parsed.password&&
    typeof key==='string'&&/^sb_publishable_[A-Za-z0-9_-]{8,512}$/.test(key)&&Number.isSafeInteger(timeout)&&timeout>0&&timeout<=30000&&typeof transport==='function',503,'CONFIGURATION_UNAVAILABLE');
  const issuer=url+'/auth/v1';
  const client=()=>{const deadline=Date.now()+timeout;return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
    const destination=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    ownerRequire(destination.origin===url&&destination.pathname.startsWith('/auth/v1/')&&!destination.username&&!destination.password,503,'AUTH_UNAVAILABLE');
    const remaining=deadline-Date.now();ownerRequire(remaining>0,503,'AUTH_UNAVAILABLE');
    const signals=[AbortSignal.timeout(remaining)];if(init?.signal)signals.push(init.signal);
    try{return await transport(input,{...init,redirect:'error',signal:AbortSignal.any(signals)});}
    catch{throw new Error('HAMDEE managed authentication transport unavailable.');}
  }}});};
  async function verified(c:SupabaseClient,raw:OwnerTokenPair):Promise<OwnerProviderSession> {
    const tokens=pair(raw),claimsResult=await c.auth.getClaims(tokens.accessToken);
    if(claimsResult.error)providerError(claimsResult.error);
    const claims=claimsResult.data?.claims;
    const userResult=await c.auth.getUser(tokens.accessToken);if(userResult.error)providerError(userResult.error);
    const user=userResult.data.user,n=Math.floor(Date.now()/1000);
    ownerRequire(claims&&user&&uuid.test(user.id)&&!user.is_anonymous&&claims.iss===issuer&&claims.sub===user.id&&
      (claims.aud==='authenticated'||(Array.isArray(claims.aud)&&claims.aud.length===1&&claims.aud[0]==='authenticated'))&&claims.role==='authenticated'&&
      claims.is_anonymous===false&&typeof claims.session_id==='string'&&uuid.test(claims.session_id)&&
      Number.isSafeInteger(claims.exp)&&claims.exp>n&&Number.isSafeInteger(claims.iat)&&claims.iat<=n&&claims.iat<claims.exp&&
      (claims.nbf===undefined||(Number.isSafeInteger(claims.nbf)&&claims.nbf<=n))&&['aal1','aal2'].includes(claims.aal),401,'UNAUTHENTICATED');
    const factors=(user.factors??[]).filter(f=>f.factor_type==='totp'&&uuid.test(f.id)&&['verified','unverified'].includes(f.status)).map(f=>({id:f.id,status:f.status}));
    const amr=Array.isArray(claims.amr)?claims.amr:[];
    const passwordTimes=amr.flatMap(a=>a&&typeof a==='object'&&a.method==='password'&&Number.isSafeInteger(a.timestamp)&&a.timestamp>=0&&a.timestamp<=n?[a.timestamp*1000]:[]);
    ownerRequire(typeof user.email==='string'&&typeof user.email_confirmed_at==='string'&&milliseconds(Date.parse(user.email_confirmed_at))&&
      Date.parse(user.email_confirmed_at)<=Date.now()&&claims.email===user.email&&passwordTimes.length>0,401,'UNAUTHENTICATED');
    const times=amr.flatMap(a=>a&&typeof a==='object'&&['totp','mfa/totp'].includes(a.method)&&Number.isSafeInteger(a.timestamp)&&a.timestamp>=0&&a.timestamp<=n?[a.timestamp*1000]:[]);
    const mfaVerifiedAt=claims.aal==='aal2'&&times.length?Math.max(...times):null;
    return detached({identity:{issuer,subject:user.id},email:user.email,emailConfirmed:true,passwordAuthenticatedAt:Math.max(...passwordTimes),sessionId:claims.session_id,assurance:claims.aal as 'aal1'|'aal2',expiresAt:claims.exp*1000,mfaVerifiedAt,
      factors:factors as OwnerTotpFactor[],tokens});
  }
  async function refresh(c:SupabaseClient,tokens:OwnerTokenPair):Promise<OwnerProviderSession> {
    const r=await c.auth.refreshSession({refresh_token:pair(tokens).refreshToken});if(r.error)providerError(r.error);
    ownerRequire(r.data.session,401,'UNAUTHENTICATED');
    return verified(c,{accessToken:r.data.session.access_token,refreshToken:r.data.session.refresh_token});
  }
  async function guarded<T>(work:()=>Promise<T>,mfa=false):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([work(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(ownerError(503,'AUTH_UNAVAILABLE')),timeout);})]);}
    catch(error){return providerError(error,mfa);}finally{if(timer)clearTimeout(timer);}
  }
  return Object.freeze<OwnerManagedProvider>({
    signIn(email,password){return guarded(async()=>{const c=client(),r=await c.auth.signInWithPassword({email,password});if(r.error)providerError(r.error);
      ownerRequire(r.data.session,401,'UNAUTHENTICATED');return verified(c,{accessToken:r.data.session.access_token,refreshToken:r.data.session.refresh_token});});},
    verifySession(tokens){const captured=pair(tokens);return guarded(()=>refresh(client(),captured));},
    enrollTotp(tokens){const captured=pair(tokens);return guarded(async()=>{const c=client(),session=await refresh(c,captured);
      ownerRequire(!session.factors.some(f=>f.status==='verified'),409,'FACTOR_ALREADY_ENROLLED');
      const r=await c.auth.mfa.enroll({factorType:'totp',friendlyName:'HAMDEE Owner'});if(r.error)providerError(r.error,true);
      ownerRequire(r.data&&r.data.type==='totp'&&uuid.test(r.data.id)&&typeof r.data.totp.qr_code==='string',503,'AUTH_UNAVAILABLE');
      return detached({session,factorId:r.data.id,qrCode:r.data.totp.qr_code});},true);},
    verifyTotp(tokens,factorId,code){const captured=pair(tokens);return guarded(async()=>{const c=client();await refresh(c,captured);
      const r=await c.auth.mfa.challengeAndVerify({factorId,code});if(r.error)providerError(r.error,true);
      ownerRequire(r.data,403,'MFA_REQUIRED');return verified(c,{accessToken:r.data.access_token,refreshToken:r.data.refresh_token});},true);},
    signOut(tokens){const captured=pair(tokens);return guarded(async()=>{
      // The convenience auth.signOut swallows401/403/404. This SDK method uses
      // the supplied USER JWT, not an admin/service key, and retains errors.
      const r=await client().auth.admin.signOut(captured.accessToken,'global');if(r.error)throw ownerError(503,'SIGN_OUT_UNCONFIRMED');
    });}
  });
}
interface OwnerCookie {
  readonly tokens:OwnerTokenPair;readonly sessionId:string;readonly createdAt:number;readonly lastActivityAt:number;
  readonly passwordAuthenticatedAt:number;
  readonly assurance:'aal1'|'aal2';readonly mfaVerifiedAt:number|null;readonly csrfSeed:string;
}
/** Thin sealed-cookie transport around managed sessions. There is no durable
 * application session/token platform and no test identity selection in env. */
export function createOwnerAuth(options:OwnerAuthOptions):OwnerAuthController {
  const p=detached(options.policy);
  ownerRequire(p&&Object.keys(p).length===8&&p.owner&&Object.keys(p.owner).length===2&&uuid.test(p.owner.subject)&&/^[a-z]{20}$/.test(p.projectRef)&&
    typeof p.ownerEmail==='string'&&p.ownerEmail===p.ownerEmail.trim().toLowerCase()&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.ownerEmail)&&
    p.owner.issuer===`https://${p.projectRef}.supabase.co/auth/v1`&&typeof p.cookieSecure==='boolean'&&
    [p.idleTimeoutMs,p.absoluteTimeoutMs,p.csrfLifetimeMs].every(v=>milliseconds(v)&&v>0)&&
    p.idleTimeoutMs<=p.absoluteTimeoutMs&&p.csrfLifetimeMs<=p.absoluteTimeoutMs,503,'CONFIGURATION_UNAVAILABLE');
  let origin:URL;try{origin=new URL(p.origin);}catch{throw ownerError(503,'CONFIGURATION_UNAVAILABLE');}
  ownerRequire(origin.origin===p.origin&&!origin.username&&!origin.password&&
    (p.cookieSecure?origin.protocol==='https:':origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)),503,'CONFIGURATION_UNAVAILABLE');
  ownerRequire(options.cookieKey instanceof Uint8Array&&options.cookieKey.byteLength===32&&typeof options.clock==='function'&&typeof options.randomBytes==='function',503,'CONFIGURATION_UNAVAILABLE');
  ownerRequire(options.provider&&['signIn','verifySession','enrollTotp','verifyTotp','signOut'].every(k=>typeof options.provider[k as keyof OwnerManagedProvider]==='function')&&
    typeof options.limiter?.consume==='function'&&typeof options.audit?.append==='function',503,'CONFIGURATION_UNAVAILABLE');
  const secret=Buffer.from(options.cookieKey),encryptionKey=createHmac('sha256',secret).update('hamdee/owner/encryption/v1').digest(),
    csrfKey=createHmac('sha256',secret).update('hamdee/owner/csrf/v1').digest();secret.fill(0);
  const aad=Buffer.from(JSON.stringify(['hamdee/owner/password/v2',p.projectRef,p.owner.issuer,p.owner.subject,p.ownerEmail,p.origin]));
  const clock=options.clock,random=options.randomBytes,consume=options.limiter.consume.bind(options.limiter),append=options.audit.append.bind(options.audit);
  const provider:OwnerManagedProvider={signIn:options.provider.signIn.bind(options.provider),verifySession:options.provider.verifySession.bind(options.provider),
    enrollTotp:options.provider.enrollTotp.bind(options.provider),verifyTotp:options.provider.verifyTotp.bind(options.provider),signOut:options.provider.signOut.bind(options.provider)};
  const usedNonces=new Set<string>();
  const now=()=>{const n=clock();ownerRequire(milliseconds(n)&&Number.isSafeInteger(n+p.absoluteTimeoutMs)&&Number.isSafeInteger(n+p.csrfLifetimeMs),503,'AUTH_UNAVAILABLE');return n;};
  const bytes=(length:number)=>{const b=random(length);ownerRequire(b instanceof Uint8Array&&b.byteLength===length,503,'AUTH_UNAVAILABLE');return Buffer.from(b);};
  function decode(value:string,max:number):Buffer {
    ownerRequire(typeof value==='string'&&value.length>0&&value.length<=max&&/^[A-Za-z0-9_-]+$/.test(value),401,'UNAUTHENTICATED');
    const b=Buffer.from(value,'base64url');ownerRequire(b.toString('base64url')===value,401,'UNAUTHENTICATED');return b;
  }
  function cookies(req:Request):Map<string,string> {
    const header=req.headers.get('cookie')??'';ownerRequire(header.length<=8192,401,'UNAUTHENTICATED');const map=new Map<string,string>();
    for(const field of header.split(';')){const i=field.indexOf('=');if(i<0)continue;const name=field.slice(0,i).trim();
      if(!['hamdee_owner','hamdee_csrf'].includes(name))continue;ownerRequire(!map.has(name),401,'UNAUTHENTICATED');map.set(name,field.slice(i+1).trim());}
    return map;
  }
  const cookie=(name:string,value:string,maxAge:number)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Strict${p.cookieSecure?'; Secure':''}; Max-Age=${Math.max(0,Math.ceil(maxAge))}`;
  const clear=()=>[cookie('hamdee_owner','',0),cookie('hamdee_csrf','',0)];
  function liveDeadline(record:OwnerCookie):void {
    const n=now();ownerRequire(n<record.createdAt+p.absoluteTimeoutMs&&n-record.lastActivityAt<p.idleTimeoutMs,401,'UNAUTHENTICATED');
  }
  function open(req:Request,expiredAllowed=false):OwnerCookie {
    let plaintext:Buffer|undefined;
    try{
      const raw=cookies(req).get('hamdee_owner');ownerRequire(raw&&raw.length<=3800,401,'UNAUTHENTICATED');const fields=raw.split('.');
      ownerRequire(fields.length===4&&fields[0]==='v1',401,'UNAUTHENTICATED');
      const nonce=decode(fields[1],16),tag=decode(fields[2],22),encrypted=decode(fields[3],3750);
      ownerRequire(nonce.length===12&&tag.length===16,401,'UNAUTHENTICATED');
      const decipher=createDecipheriv('aes-256-gcm',encryptionKey,nonce);decipher.setAAD(aad);decipher.setAuthTag(tag);
      plaintext=Buffer.concat([decipher.update(encrypted),decipher.final()]);const text=plaintext.toString('utf8');
      ownerRequire(Buffer.from(text).equals(plaintext),401,'UNAUTHENTICATED');const value=JSON.parse(text) as OwnerCookie,n=now();
      ownerRequire(value&&Object.keys(value).length===8&&uuid.test(value.sessionId)&&milliseconds(value.createdAt)&&milliseconds(value.lastActivityAt)&&
        value.createdAt<=value.lastActivityAt&&value.lastActivityAt<=n&&Number.isSafeInteger(value.createdAt+p.absoluteTimeoutMs)&&
        milliseconds(value.passwordAuthenticatedAt)&&value.passwordAuthenticatedAt<=value.createdAt&&
        ['aal1','aal2'].includes(value.assurance)&&(value.mfaVerifiedAt===null||(milliseconds(value.mfaVerifiedAt)&&value.mfaVerifiedAt<=n))&&
        typeof value.csrfSeed==='string'&&decode(value.csrfSeed,43).length===32,401,'UNAUTHENTICATED');
      const r=detached({...value,tokens:pair(value.tokens)});if(!expiredAllowed)liveDeadline(r);return r;
    }catch(error){if(error instanceof ApiError&&error.status===503)throw error;throw ownerError(401,'UNAUTHENTICATED');}
    finally{plaintext?.fill(0);}
  }
  function seal(record:OwnerCookie):string {
    const nonce=bytes(12),nonceKey=nonce.toString('base64url');ownerRequire(!usedNonces.has(nonceKey),503,'AUTH_UNAVAILABLE');usedNonces.add(nonceKey);
    const plaintext=Buffer.from(JSON.stringify(record));try{
      const cipher=createCipheriv('aes-256-gcm',encryptionKey,nonce);cipher.setAAD(aad);
      const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
      const value=['v1',nonceKey,cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
      ownerRequire(value.length<=3800,503,'AUTH_UNAVAILABLE');return value;
    }finally{plaintext.fill(0);}
  }
  const csrfBinding=(record:OwnerCookie|null)=>record?JSON.stringify(['session',record.sessionId,record.createdAt,record.csrfSeed,record.assurance]):'anonymous';
  function makeCsrf(record:OwnerCookie|null):string {
    const expiresAt=now()+p.csrfLifetimeMs;ownerRequire(milliseconds(expiresAt),503,'AUTH_UNAVAILABLE');
    const body=Buffer.from(JSON.stringify({nonce:bytes(32).toString('base64url'),binding:csrfBinding(record),expiresAt})).toString('base64url');
    return `v1.${body}.${createHmac('sha256',csrfKey).update(aad).update(body).digest('base64url')}`;
  }
  function validCsrf(token:string,record:OwnerCookie|null):boolean {
    try{
      if(typeof token!=='string'||token.length>1500)return false;const [version,body,mac,...extra]=token.split('.');
      if(version!=='v1'||extra.length)return false;const payload=decode(body,1400),actual=decode(mac,43);
      const expected=createHmac('sha256',csrfKey).update(aad).update(body).digest();
      if(actual.length!==32||!timingSafeEqual(actual,expected))return false;
      const c=JSON.parse(payload.toString('utf8')) as {nonce:string;binding:string;expiresAt:number};
      return Object.keys(c).length===3&&decode(c.nonce,43).length===32&&c.binding===csrfBinding(record)&&milliseconds(c.expiresAt)&&c.expiresAt>now()&&c.expiresAt<=now()+p.csrfLifetimeMs;
    }catch{return false;}
  }
  function requestOrigin(req:Request):void {ownerRequire(new URL(req.url).origin===p.origin,403,'CSRF_REJECTED');}
  function mutation(req:Request,record:OwnerCookie|null):void {
    requestOrigin(req);ownerRequire(req.headers.get('origin')===p.origin,403,'CSRF_REJECTED');
    const proof=req.headers.get('x-hamdee-csrf'),stored=cookies(req).get('hamdee_csrf');
    ownerRequire(proof&&stored&&proof.length<=1500&&stored.length<=1500,403,'CSRF_REJECTED');
    const actual=Buffer.from(proof),expected=Buffer.from(stored);
    ownerRequire(actual.length===expected.length&&timingSafeEqual(actual,expected)&&validCsrf(proof,record),403,'CSRF_REJECTED');
  }
  async function limited(flow:OwnerAuthFlow):Promise<void> {
    let allowed:boolean;try{allowed=await consume(flow,`${p.projectRef}:${p.owner.subject}`,now());}catch{throw ownerError(503,'AUTH_UNAVAILABLE');}
    ownerRequire(allowed===true,allowed===false?429:503,allowed===false?'RATE_LIMITED':'AUTH_UNAVAILABLE');
  }
  async function event(name:OwnerAuthAuditEvent['event'],requestId:string,outcome:OwnerAuthAuditEvent['outcome']='accepted'):Promise<void> {
    try{await append(detached({event:name,outcome,requestId}));}catch{throw ownerError(503,'AUTH_UNAVAILABLE');}
  }
  async function call<T>(work:()=>Promise<T>):Promise<T> {try{return detached(await work());}catch(error){return providerError(error);}}
  function session(raw:OwnerProviderSession,previous?:OwnerCookie):OwnerProviderSession {
    const r=detached(raw),n=now();
    ownerRequire(r&&r.identity&&r.identity.issuer===p.owner.issuer&&r.identity.subject===p.owner.subject,403,'OWNER_ACCESS_DENIED');
    ownerRequire(typeof r.email==='string'&&r.email.toLowerCase()===p.ownerEmail&&r.emailConfirmed===true&&
      milliseconds(r.passwordAuthenticatedAt)&&r.passwordAuthenticatedAt<=n,403,'OWNER_ACCESS_DENIED');
    ownerRequire(uuid.test(r.sessionId)&&milliseconds(r.expiresAt)&&r.expiresAt>n&&['aal1','aal2'].includes(r.assurance)&&Array.isArray(r.factors)&&
      r.factors.every(f=>uuid.test(f.id)&&['verified','unverified'].includes(f.status))&&new Set(r.factors.map(f=>f.id)).size===r.factors.length&&
      (r.mfaVerifiedAt===null||(milliseconds(r.mfaVerifiedAt)&&r.mfaVerifiedAt<=n)),401,'UNAUTHENTICATED');
    pair(r.tokens);
    if(previous){
      liveDeadline(previous);ownerRequire(r.sessionId===previous.sessionId,401,'UNAUTHENTICATED');
      ownerRequire(r.passwordAuthenticatedAt===previous.passwordAuthenticatedAt,401,'UNAUTHENTICATED');
    }
    return detached({identity:{...p.owner},email:r.email,emailConfirmed:true,passwordAuthenticatedAt:r.passwordAuthenticatedAt,sessionId:r.sessionId,assurance:r.assurance,expiresAt:r.expiresAt,mfaVerifiedAt:r.mfaVerifiedAt,
      factors:r.factors.map(f=>({id:f.id,status:f.status})),tokens:pair(r.tokens)});
  }
  async function read(req:Request):Promise<{record:OwnerCookie;verified:OwnerProviderSession}> {
    const record=open(req);await limited('refresh');const verified=session(await call(()=>provider.verifySession(record.tokens)),record);
    liveDeadline(record);return {record:detached({...record,tokens:verified.tokens}),verified};
  }
  function transport(req:Request,record:OwnerCookie|null,s:OwnerProviderSession|null,phase?:OwnerAuthPhase):{state:OwnerAuthState;setCookies:readonly string[]} {
    if(record)liveDeadline(record);
    const old=cookies(req).get('hamdee_csrf'),csrfToken=old&&validCsrf(old,record)?old:makeCsrf(record),lines:string[]=[];
    if(record)lines.push(cookie('hamdee_owner',seal(record),(record.createdAt+p.absoluteTimeoutMs-now())/1000));
    lines.push(cookie('hamdee_csrf',csrfToken,p.csrfLifetimeMs/1000));
    return {state:detached({state:phase??(s?'authenticated':'anonymous'),csrfToken,
      expiresAt:record?Math.min(record.createdAt+p.absoluteTimeoutMs,record.lastActivityAt+p.idleTimeoutMs):null,
      factors:[]}),setCookies:lines};
  }
  async function finish(req:Request,r:OwnerCookie,s:OwnerProviderSession):Promise<{state:OwnerAuthState;setCookies:readonly string[]}> {
    const latest=session(await call(()=>provider.verifySession(s.tokens)),r);
    return transport(req,detached({...r,tokens:latest.tokens}),latest);
  }
  async function body(req:Request,keys:readonly string[]):Promise<Record<string,unknown>> {
    ownerRequire(req.headers.get('content-type')?.split(';')[0].trim()==='application/json',415,'JSON_REQUIRED');
    const reader=req.body?.getReader(),chunks:Uint8Array[]=[];let length=0;
    if(reader)while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;
      if(length>16384){await reader.cancel();throw ownerError(413,'PAYLOAD_TOO_LARGE');}chunks.push(value);}
    let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw ownerError(400,'INVALID_JSON');}
    ownerRequire(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)),422,'VALIDATION_FAILED');
    return value as Record<string,unknown>;
  }
  const email=(value:unknown)=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  function json(requestId:string,data:unknown,status:number,lines:readonly string[]=[]):Response {
    const headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Request-Id':requestId});for(const line of lines)headers.append('Set-Cookie',line);
    return Response.json({...data as object,requestId},{status,headers});
  }
  return Object.freeze<OwnerAuthController>({
    async authorize(request){
      try{
        const req=request.clone();requestOrigin(req);ownerRequire(!req.headers.has('authorization'),401,'UNAUTHENTICATED');
        const existing=open(req);if(!['GET','HEAD','OPTIONS'].includes(req.method)){mutation(req,existing);await limited('write');}
        const {record,verified}=await read(req);
        // Only business authorization advances idle; auth-state/refresh never do.
        const next=detached({...record,lastActivityAt:now()}),out=transport(req,next,verified);
        return detached({identity:{...p.owner},sessionId:verified.sessionId,...out});
      }catch(error){await event('denied',randomUUID(),'denied');return providerError(error);}
    },
    async handle(request){
      const requestId=randomUUID();let clearing=false;
      try{
        const req=request.clone();requestOrigin(req);ownerRequire(!req.headers.has('authorization'),401,'UNAUTHENTICATED');
        const url=new URL(req.url);ownerRequire(!url.search&&url.pathname.startsWith('/api/hamdee/auth/'),404,'NOT_FOUND');
        const action=url.pathname.slice('/api/hamdee/auth/'.length);
        ownerRequire(['state','login','refresh','logout','recovery'].includes(action),404,'NOT_FOUND');
        ownerRequire(req.method===(action==='state'?'GET':'POST'),405,'METHOD_NOT_ALLOWED');
        if(action==='state'){
          if(!cookies(req).has('hamdee_owner')){const out=transport(req,null,null);return json(requestId,{data:out.state},200,out.setCookies);}
          try{const {record,verified}=await read(req),out=transport(req,record,verified);return json(requestId,{data:out.state},200,out.setCookies);}
          catch(error){if(!(error instanceof ApiError)||error.code!=='UNAUTHENTICATED')throw error;
            const out=transport(new Request(req.url),null,null);return json(requestId,{data:out.state},200,[...clear(),...out.setCookies]);}
        }
        const present=cookies(req).has('hamdee_owner')?open(req,action==='logout'||action==='recovery'):null;mutation(req,present);
        if(action==='login'){
          await limited('login');const b=await body(req,['email','password']);ownerRequire(email(b.email)&&typeof b.password==='string'&&b.password.length>0&&b.password.length<=1024,422,'VALIDATION_FAILED');
          ownerRequire((b.email as string).toLowerCase()===p.ownerEmail,401,'UNAUTHENTICATED');
          const s=session(await call(()=>provider.signIn(b.email as string,b.password as string))),n=now();
          const r:OwnerCookie=detached({tokens:s.tokens,sessionId:s.sessionId,createdAt:n,lastActivityAt:n,passwordAuthenticatedAt:s.passwordAuthenticatedAt,assurance:s.assurance,mfaVerifiedAt:s.mfaVerifiedAt,csrfSeed:bytes(32).toString('base64url')});
          await event('login',requestId);const out=await finish(req,r,s);return json(requestId,{data:out.state},200,out.setCookies);
        }
        if(action==='logout'||action==='recovery'){
          await limited(action==='recovery'?'recovery':'write');const b=await body(req,action==='recovery'?['email']:[]);
          if(action==='recovery')ownerRequire(email(b.email),422,'VALIDATION_FAILED');
          clearing=true;
          if(present){
            try{await call(()=>provider.signOut(present.tokens));}catch{await event(action==='logout'?'logout':'recovery_prepared',requestId,'unconfirmed');throw ownerError(503,'SIGN_OUT_UNCONFIRMED');}
          }
          await event(action==='logout'?'logout':'recovery_prepared',requestId);
          const out=transport(new Request(req.url),null,null,action==='recovery'?'recovery_pending':'anonymous');
          return json(requestId,{data:out.state},action==='recovery'?202:200,[...clear(),...out.setCookies]);
        }
        ownerRequire(present,401,'UNAUTHENTICATED');await limited('refresh');
        await body(req,[]);const {record,verified}=await read(req),out=transport(req,record,verified);
        return json(requestId,{data:out.state},200,out.setCookies);
      }catch(error){
        let safe=error instanceof ApiError&&ownerMessages[error.code]?ownerError(error.status,error.code):ownerError(503,'AUTH_UNAVAILABLE');
        try{await event('denied',requestId,'denied');}catch{safe=ownerError(503,'AUTH_UNAVAILABLE');}
        return json(requestId,{error:{code:safe.code,message:safe.message}},safe.status,clearing||['UNAUTHENTICATED','OWNER_ACCESS_DENIED'].includes(safe.code)?clear():[]);
      }
    }
  });
}
