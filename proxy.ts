import { NextResponse,type NextRequest } from 'next/server';
import { handleOwnerAuthRequest } from './src/owner-runtime';
import { ownerPageAccess } from './src/owner-page-access';

/** Next's Node proxy guards page navigation; property/auth APIs keep their
 * existing server authentication, response codes and transactional safeguards. */
export async function proxy(request:NextRequest):Promise<Response> {
  const decision=await ownerPageAccess(request,handleOwnerAuthRequest);
  let response:Response;
  if(decision.kind==='redirect-login')response=NextResponse.redirect(new URL('/login',request.url),303);
  else if(decision.kind==='redirect-workspace')response=NextResponse.redirect(new URL('/workspace/index.html#dashboard',request.url),303);
  else if(decision.kind==='login'){
    // The static rewrite destination MUST stay outside the proxy matcher.
    // Matching it again would redirect /login.html -> /login indefinitely.
    response=NextResponse.rewrite(new URL('/login.html',request.url));
  }else if(decision.kind==='workspace'){
    response=['/workspace','/workspace/'].includes(request.nextUrl.pathname)
      ?NextResponse.rewrite(new URL('/workspace/index.html',request.url)):NextResponse.next();
  }else response=new Response(decision.kind==='method-not-allowed'?'Method not allowed.':
    'Owner access is temporarily unavailable. Retry this page or return to /login.',
    {status:decision.kind==='method-not-allowed'?405:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  decision.headers.forEach((value,key)=>{if(key.toLowerCase()!=='set-cookie')response.headers.set(key,value);});
  for(const line of decision.headers.getSetCookie())response.headers.append('Set-Cookie',line);
  return response;
}
export const config={matcher:['/','/login','/workspace','/workspace/','/workspace/index.html']};
