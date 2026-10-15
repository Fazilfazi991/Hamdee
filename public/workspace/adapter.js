// Explicit backend-only adapter. Never imports model.js or accesses localStorage.
export class PropertyApi {
  constructor(base='/api/hamdee/v1') { this.base=base; this.csrfToken=null; }
  async request(path,options={}) {
    return this.fetchJson(this.base+path,options);
  }
  async fetchJson(url,options={}) {
    let response,result;
    try{response=await fetch(url,{...options,cache:'no-store',credentials:'same-origin'});}
    catch(cause){if(cause.name==='AbortError')throw cause;const error=new Error('Connection interrupted. Retry the same submission to confirm its result.');error.uncertain=true;throw error;}
    try{result=await response.json();}
    catch{const error=new Error('The service returned an unreadable response. Retry the same submission or refresh the connection.');error.status=response.status;error.uncertain=true;throw error;}
    if(!response.ok){const error=new Error(result.error?.message||'The operation could not be confirmed.');error.code=result.error?.code;error.status=response.status;error.requestId=result.requestId;error.retryAfter=response.headers.get('Retry-After');error.uncertain=response.status>=500;throw error;}
    return result;
  }
  rememberState(data){
    if(!data||!['anonymous','mfa_required','authenticated','recovery_pending'].includes(data.state)||typeof data.csrfToken!=='string'||!data.csrfToken||!Array.isArray(data.factors)||!data.factors.every(f=>f&&typeof f.id==='string'&&f.id&&['verified','unverified'].includes(f.status))||(data.expiresAt!==null&&(!Number.isSafeInteger(data.expiresAt)||data.expiresAt<0))){throw new Error('The service returned an invalid access state. Check the connection before continuing.');}
    this.csrfToken=data.csrfToken;
    return {state:data.state,csrfToken:data.csrfToken,expiresAt:data.expiresAt,factors:data.factors.map(f=>({id:f.id,status:f.status}))};
  }
  authState(signal){return this.fetchJson('/api/hamdee/auth/state',{signal});}
  auth(action,body={},signal){
    if(!['login','mfa/enroll','mfa/verify','refresh','logout','recovery'].includes(action))throw new Error('This account action is unavailable.');
    if(!this.csrfToken){const error=new Error('Check your session before submitting this action.');error.code='CSRF_REJECTED';error.status=403;throw error;}
    return this.fetchJson('/api/hamdee/auth/'+action,{method:'POST',signal,headers:{'Content-Type':'application/json','X-Hamdee-CSRF':this.csrfToken},body:JSON.stringify(body)});
  }
  session(signal){return this.request('/session',{signal});}
  dashboard(signal){return this.request('/dashboard',{signal});}
  rentalRead(filters,signal){return this.request('/rental?'+new URLSearchParams(filters),{signal});}
  expenseRead(filters,signal){return this.request('/expenses?'+new URLSearchParams(filters),{signal});}
  expenseWrite(body,key,signal){return this.request('/expenses',{method:'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{})},body:JSON.stringify(body)});}
  rentalWrite(body,key,signal){return this.request('/rental',{method:'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{})},body:JSON.stringify(body)});}
  list(filters,signal){return this.request('/properties?'+new URLSearchParams(filters),{signal});}
  get(id,signal){return this.request('/properties/'+encodeURIComponent(id),{signal});}
  audit(id,cursor='',signal){return this.request('/properties/'+encodeURIComponent(id)+'/audit?limit=50&cursor='+cursor,{signal});}
  mutate(action,id,body,key,version,signal){return this.request('/properties'+(id?'/'+encodeURIComponent(id):'')+(['archive','restore'].includes(action)?'/'+action:''),{
    method:action==='update'?'PATCH':'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{}),...(id?{'If-Match':`"property:${id}:${version}"`}:{})},body:JSON.stringify(body)
  });}
}
