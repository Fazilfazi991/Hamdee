/** Page navigation only. APIs retain their existing JSON authorization responses.
 * The injected state handler is the existing owner runtime: provider verification
 * plus the fresh enabled Admin binding, never a cookie-presence shortcut. */
export interface OwnerPageDecision {
  readonly kind:'login'|'workspace'|'redirect-login'|'redirect-workspace'|'unavailable'|'method-not-allowed';
  readonly headers:Headers;
}
export type OwnerStateHandler=(request:Request)=>Promise<Response>;
export async function ownerPageAccess(request:Request,state:OwnerStateHandler):Promise<OwnerPageDecision> {
  const path=new URL(request.url).pathname,login=path==='/login'||path==='/login.html',
    headers=new Headers({'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie',
      'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'});
  if(!['GET','HEAD'].includes(request.method)){
    headers.set('Allow','GET, HEAD');return {kind:'method-not-allowed',headers};
  }
  try{
    const input=new Headers();
    for(const name of ['cookie','authorization']){const value=request.headers.get(name);if(value)input.set(name,value);}
    const result=await state(new Request(new URL('/api/hamdee/auth/state',request.url),{method:'GET',headers:input}));
    // Do not collapse separate Set-Cookie lines (Expires may contain commas).
    for(const line of result.headers.getSetCookie())headers.append('Set-Cookie',line);
    if(result.status===401||result.status===403)return {kind:login?'login':'redirect-login',headers};
    if(!result.ok)return {kind:login?'login':'unavailable',headers};
    const body=await result.json(),data=body?.data;
    if(!data||typeof data.csrfToken!=='string'||!data.csrfToken)return {kind:login?'login':'unavailable',headers};
    if(data.state==='authenticated'&&Number.isSafeInteger(data.expiresAt)&&data.expiresAt>0)
      return {kind:login||path==='/'?'redirect-workspace':'workspace',headers};
    if(data.state==='anonymous'||data.state==='recovery_pending')return {kind:login?'login':'redirect-login',headers};
    return {kind:login?'login':'unavailable',headers};
  }catch{
    // Login remains reachable to explain backend outages. Protected pages never
    // open during configuration/provider/database failures or redirect in loops.
    return {kind:login?'login':'unavailable',headers};
  }
}
