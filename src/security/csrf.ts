import type { IdentityBinding } from './contracts';
import type { SessionPolicy } from './session-policy';
import { hashPattern,validateBinding } from './contracts';
import { validateSessionPolicy } from './session-policy';
import { createHmac,timingSafeEqual } from 'node:crypto';

export interface CsrfBinding {
  readonly identityBinding:IdentityBinding;
  readonly purpose:'login'|'session';
  readonly handleHash:string;
}
export interface MutationContext {
  readonly origin:string|null;
  readonly csrfToken:string|null;
  /** Trusted server-derived limiter key, never a browser authorization claim. */
  readonly limiterKey:string;
}
export interface CsrfProtector {
  issue(binding:CsrfBinding):string;
  verify(token:string,binding:CsrfBinding):boolean;
  assertMutation(context:MutationContext,binding:CsrfBinding,policy:SessionPolicy):void;
}
export class CsrfError extends Error {
  readonly code='CSRF_REJECTED';
  constructor(){super('HAMDEE request verification failed.');this.name='CsrfError';}
}
/** Server-only HMAC proof bound to purpose, full project binding and handle. */
export function createCsrfProtector(key:Uint8Array):CsrfProtector {
  if(!(key instanceof Uint8Array)||key.byteLength!==32)throw new CsrfError();
  const secret=Buffer.from(key);
  const issue=(binding:CsrfBinding):string=>{
    try{
      validateBinding(binding.identityBinding);
      if(!['login','session'].includes(binding.purpose)||!hashPattern.test(binding.handleHash)||
        Object.keys(binding).length!==3)throw new CsrfError();
      const b=binding.identityBinding;
      const payload=JSON.stringify(['hamdee/csrf/v1',binding.purpose,binding.handleHash,b.provider,b.appId,b.environment,b.dataClass,b.projectRef,b.issuer,b.audience]);
      return 'v1.'+createHmac('sha256',secret).update(payload).digest('base64url');
    }catch{throw new CsrfError();}
  };
  const verify=(token:string,binding:CsrfBinding):boolean=>{
    try{
      if(typeof token!=='string'||!/^v1\.[A-Za-z0-9_-]{43}$/.test(token))return false;
      const actual=Buffer.from(token.slice(3),'base64url'),expected=Buffer.from(issue(binding).slice(3),'base64url');
      return actual.length===32&&actual.toString('base64url')===token.slice(3)&&timingSafeEqual(actual,expected);
    }catch{return false;}
  };
  return Object.freeze<CsrfProtector>({issue,verify,assertMutation(context,binding,policy){
    try{
      const p=validateSessionPolicy(policy);
      if(!context||typeof context.origin!=='string'||!p.allowedOrigins.includes(context.origin)||
        typeof context.limiterKey!=='string'||context.limiterKey.length<1||context.limiterKey.length>512||
        !verify(context.csrfToken!,binding))throw new CsrfError();
    }catch{throw new CsrfError();}
  }});
}
