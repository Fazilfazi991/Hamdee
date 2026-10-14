import { LocalPostgresDatabase,type Database } from './database';
import { createOwnerAuth,createManagedOwnerProvider,type OwnerAuthOptions,type OwnerAuthorization,type OwnerAuthFlow } from './owner-auth';
import type { SecurityLogger } from './security-log';
import { createHandler,unavailable } from './http';
import { bindIdentityRecheck } from './auth';
import { requireThat } from './errors';
import { PropertyService,safeUnexpected } from './service';
import { randomBytes,randomUUID } from 'node:crypto';
import { uuid } from './validation';

export interface OwnerApplicationOptions extends OwnerAuthOptions {
  readonly database:Database;
  readonly logger?:SecurityLogger;
}
export interface OwnerApplication {
  handleAuth(request:Request):Promise<Response>;
  handleProperties(request:Request):Promise<Response>;
}
/** Test composition takes injected provider/database, never an env fake mode.
 * Caller owns database cleanup. No provider/database work at construction. */
export function createOwnerApplication(options:OwnerApplicationOptions):OwnerApplication {
  const auth=createOwnerAuth(options),owner=Object.freeze({...options.policy.owner}),logger=options.logger,
    service=new PropertyService({transaction:options.database.transaction.bind(options.database)},owner);
  const cookieFlags=`Path=/; HttpOnly; SameSite=Strict${options.policy.cookieSecure?'; Secure':''}; Max-Age=0`;
  const clear=[`hamdee_owner=; ${cookieFlags}`,`hamdee_csrf=; ${cookieFlags}`];
  function failed(error:unknown,erase=false):Response {
    const safe=safeUnexpected(error),requestId=randomUUID(),headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Request-Id':requestId});
    if(erase||safe.status===401||safe.code==='OWNER_ACCESS_DENIED')for(const c of clear)headers.append('Set-Cookie',c);
    return Response.json({error:{code:safe.code,message:safe.message},requestId},{status:safe.status,headers});
  }
  const withCookies=(response:Response,lines:readonly string[])=>{const headers=new Headers(response.headers);for(const c of lines)headers.append('Set-Cookie',c);
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});};
  return Object.freeze<OwnerApplication>({
    async handleAuth(request){
      try{
        const response=await auth.handle(request),data=response.ok?(await response.clone().json()).data:null;
        // Managed authentication never bootstraps/reenables database membership.
        if(data?.state==='authenticated')await service.session(owner);
        return response;
      }catch(error){return failed(error,true);}
    },
    async handleProperties(request){
      try{
        let current=await auth.authorize(request);
        function currentRequest():Request {
          const headers=new Headers(request.headers),jar=new Map<string,string>();
          for(const f of (headers.get('cookie')??'').split(';')){const i=f.indexOf('=');if(i>0)jar.set(f.slice(0,i).trim(),f.slice(i+1).trim());}
          for(const line of current.setCookies){const first=line.split(';')[0],i=first.indexOf('=');jar.set(first.slice(0,i),first.slice(i+1));}
          headers.set('cookie',[...jar].map(([k,v])=>k+'='+v).join('; '));
          headers.set('x-hamdee-csrf',current.state.csrfToken);
          return new Request(request.url,{method:request.method,headers});
        }
        const identity=bindIdentityRecheck(current.identity,async()=>{
          const next:OwnerAuthorization=await auth.authorize(currentRequest());
          requireThat(next.identity.issuer===owner.issuer&&next.identity.subject===owner.subject&&next.sessionId===current.sessionId,
            401,'UNAUTHENTICATED','Sign in with an authorized account.');current=next;
        });
        const provider={kind:'managed-supabase-owner',validate:async()=>identity};
        const response=await createHandler(provider,service,logger)(request);
        return withCookies(response,response.status===401?clear:current.setCookies);
      }catch(error){return failed(error);}
    }
  });
}
let configured:OwnerApplication|null=null;
function configuredApplication():OwnerApplication|null {
  if(configured)return configured;
  // Activation requires a separately approved exact environment. No fallback,
  // generic SUPABASE_/DATABASE_URL, test identity or hosted SQL connection.
  if(process.env.HAMDEE_OWNER_RUNTIME_APPROVAL!=='approved-development-owner-runtime')return null;
  const e=process.env;
  try{
    requireThat(e.HAMDEE_APP_ID==='hamdee'&&e.HAMDEE_ENVIRONMENT==='development'&&e.HAMDEE_DATA_CLASS==='synthetic_only'&&
      e.HAMDEE_REGION==='ap-southeast-1'&&e.HAMDEE_RESIDENCY_DECISION==='approved_synthetic_development_only'&&
      !!e.HAMDEE_PROJECT_OWNER?.trim()&&e.HAMDEE_PROJECT_REF==='dytlzfwbgeuhzgzemqsf'&&
      e.HAMDEE_SUPABASE_URL===`https://${e.HAMDEE_PROJECT_REF}.supabase.co`&&e.HAMDEE_AUTH_ISSUER===e.HAMDEE_SUPABASE_URL+'/auth/v1'&&
      e.HAMDEE_AUTH_AUDIENCE==='authenticated'&&!!e.HAMDEE_OWNER_SUBJECT&&uuid.test(e.HAMDEE_OWNER_SUBJECT)&&
      !!e.HAMDEE_DATABASE_URL&&!!e.HAMDEE_OWNER_ORIGIN?.startsWith('https://')&&
      !!e.HAMDEE_OWNER_COOKIE_KEY&&/^[A-Za-z0-9_-]{43}$/.test(e.HAMDEE_OWNER_COOKIE_KEY),503,'CONFIGURATION_UNAVAILABLE','Dedicated owner configuration is required.');
    const number=(key:string)=>{const text=e[key];requireThat(!!text&&/^[1-9]\d*$/.test(text),503,'CONFIGURATION_UNAVAILABLE','Dedicated owner configuration is required.');
      const n=Number(text);requireThat(Number.isSafeInteger(n)&&n>0,503,'CONFIGURATION_UNAVAILABLE','Dedicated owner configuration is required.');return n;};
    const cookieKey=Buffer.from(e.HAMDEE_OWNER_COOKIE_KEY,'base64url');requireThat(cookieKey.length===32&&cookieKey.toString('base64url')===e.HAMDEE_OWNER_COOKIE_KEY,503,'CONFIGURATION_UNAVAILABLE','Dedicated owner configuration is required.');
    const window=number('HAMDEE_OWNER_RATE_WINDOW_MS'),bounds=number('HAMDEE_OWNER_RATE_BOUNDS'),backoff=number('HAMDEE_OWNER_RATE_BACKOFF_MS');
    const timeout=number('HAMDEE_OWNER_AUTH_TIMEOUT_MS');
    requireThat(timeout<=5000&&Number.isSafeInteger(Date.now()+window)&&Number.isSafeInteger(Date.now()+backoff),503,'CONFIGURATION_UNAVAILABLE','Dedicated owner configuration is required.');
    const buckets=new Map<OwnerAuthFlow,{count:number;reset:number;blocked:number}>();
    const app=createOwnerApplication({policy:{owner:{issuer:e.HAMDEE_AUTH_ISSUER,subject:e.HAMDEE_OWNER_SUBJECT},projectRef:e.HAMDEE_PROJECT_REF,
      origin:e.HAMDEE_OWNER_ORIGIN!,cookieSecure:true,idleTimeoutMs:number('HAMDEE_OWNER_IDLE_MS'),absoluteTimeoutMs:number('HAMDEE_OWNER_ABSOLUTE_MS'),
      csrfLifetimeMs:number('HAMDEE_OWNER_CSRF_MS'),mfaMaxAgeMs:number('HAMDEE_OWNER_MFA_MAX_AGE_MS')},
      cookieKey,clock:()=>Date.now(),randomBytes,
      provider:createManagedOwnerProvider({supabaseUrl:e.HAMDEE_SUPABASE_URL,publishableKey:e.HAMDEE_SUPABASE_PUBLISHABLE_KEY??'',requestTimeoutMs:timeout}),
      database:new LocalPostgresDatabase(e.HAMDEE_DATABASE_URL),
      limiter:{async consume(flow,_key,now){let b=buckets.get(flow);if(!b||now>=b.reset){b={count:0,reset:now+window,blocked:0};buckets.set(flow,b);}
        if(now<b.blocked)return false;if(++b.count>bounds){b.blocked=now+backoff;return false;}return true;}},
      audit:{async append(event){console.info(JSON.stringify(event));}}
    });
    configured=app;return app;
  }catch{return null;}
}
/** No normal request can select the injected test provider or a hosted DB. */
export async function handleOwnerAuthRequest(request:Request):Promise<Response> {
  return configuredApplication()?.handleAuth(request)??unavailable();
}
export async function handleOwnerPropertyRequest(request:Request):Promise<Response> {
  return configuredApplication()?.handleProperties(request)??unavailable();
}
