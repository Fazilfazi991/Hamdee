// Explicit backend-only adapter. Never imports model.js or accesses localStorage.
export class PropertyApi {
  constructor(base='/api/hamdee/v1') { this.base=base; this.csrfToken=null; }
  async request(path,options={}) {
    return this.fetchJson(this.base+path,options);
  }
  async fetchJson(url,options={}) {
    let response,result,readController,deadline,aborted=false;
    const upstream=options.signal,onAbort=()=>readController.abort(upstream.reason);
    // Bound reads only. Mutations retain their existing exact-key/uncertain
    // submission handling and are never retried by this adapter.
    if(!options.method||options.method==='GET'){
      readController=new window.AbortController();
      if(upstream?.aborted)onAbort();else upstream?.addEventListener('abort',onAbort,{once:true});
      deadline=window.setTimeout(()=>{aborted=true;readController.abort();},25000);
      options={...options,signal:readController.signal};
    }
    try{
    try{response=await fetch(url,{...options,cache:'no-store',credentials:'same-origin'});}
    catch(cause){if(aborted){const error=new Error('The service took too long to respond. Retry when the connection is ready.');error.code='REQUEST_TIMEOUT';error.status=504;throw error;}if(cause.name==='AbortError')throw cause;const error=new Error('Connection interrupted. Retry the same submission to confirm its result.');error.uncertain=true;throw error;}
    try{result=await response.json();}
    catch{const error=new Error('The service returned an unreadable response. Retry the same submission or refresh the connection.');error.status=response.status;error.uncertain=true;throw error;}
    if(!response.ok){const error=new Error(result.error?.message||'The operation could not be confirmed.');error.code=result.error?.code;error.status=response.status;error.requestId=result.requestId;error.retryAfter=response.headers.get('Retry-After');error.uncertain=response.status>=500;throw error;}
    return result;
    }finally{window.clearTimeout(deadline);upstream?.removeEventListener('abort',onAbort);}
  }
  rememberState(data){
    if(!data||!['anonymous','authenticated','recovery_pending'].includes(data.state)||typeof data.csrfToken!=='string'||!data.csrfToken||!Array.isArray(data.factors)||data.factors.length!==0||(data.expiresAt!==null&&(!Number.isSafeInteger(data.expiresAt)||data.expiresAt<0))){throw new Error('The service returned an invalid access state. Check the connection before continuing.');}
    this.csrfToken=data.csrfToken;
    return {state:data.state,csrfToken:data.csrfToken,expiresAt:data.expiresAt,factors:[]};
  }
  authState(signal){return this.fetchJson('/api/hamdee/auth/state',{signal});}
  auth(action,body={},signal){
    if(!['login','refresh','logout','recovery'].includes(action))throw new Error('This account action is unavailable.');
    if(!this.csrfToken){const error=new Error('Check your session before submitting this action.');error.code='CSRF_REJECTED';error.status=403;throw error;}
    return this.fetchJson('/api/hamdee/auth/'+action,{method:'POST',signal,headers:{'Content-Type':'application/json','X-Hamdee-CSRF':this.csrfToken},body:JSON.stringify(body)});
  }
  session(signal){return this.request('/session',{signal});}
  dashboard(signal){return this.request('/dashboard',{signal});}
  staffRead(filters,signal){return this.request('/staff-collections?'+new URLSearchParams(filters),{signal});}
  staffReceipts(filters,signal){return this.request('/staff-collections/receipts?'+new URLSearchParams(filters),{signal});}
  staffWrite(body,key,signal){return this.request('/staff-collections/commands',{method:'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{})},body:JSON.stringify(body)});}
  financeRead(filters,signal){return this.request('/company-finance?'+new URLSearchParams(filters),{signal});}
  financeWrite(body,key,signal){return this.request('/company-finance/commands',{method:'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{})},body:JSON.stringify(body)});}
  personalRead(filters,signal){return this.request('/personal-finance?'+new URLSearchParams(filters),{signal});}
  personalWrite(body,key,signal){return this.request('/personal-finance/commands',{method:'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{})},body:JSON.stringify(body)});}
  carRead(filters,signal){return this.request('/car-rentals?'+new URLSearchParams(filters),{signal});}
  carWrite(body,key,signal){return this.request('/car-rentals/commands',{method:'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{})},body:JSON.stringify(body)});}
  rentalRead(filters,signal){return this.request('/rental?'+new URLSearchParams(filters),{signal});}
  expenseRead(filters,signal){return this.request('/expenses?'+new URLSearchParams(filters),{signal});}
  expenseWrite(body,key,signal){return this.request('/expenses',{method:'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{})},body:JSON.stringify(body)});}
  rentalWrite(body,key,signal){return this.request('/rental',{method:'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{})},body:JSON.stringify(body)});}
  list(filters,signal){return this.request('/properties?'+new URLSearchParams(filters),{signal});}
  get(id,signal){return this.request('/properties/'+encodeURIComponent(id),{signal});}
  audit(id,cursor='',signal){return this.request('/properties/'+encodeURIComponent(id)+'/audit?limit=50&cursor='+cursor,{signal});}
  mutate(action,id,body,key,version,signal){return this.request('/properties'+(id?'/'+encodeURIComponent(id):'')+(['archive','restore'].includes(action)?'/'+action:''),{
    method:action==='update'?'PATCH':'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(this.csrfToken?{'X-Hamdee-CSRF':this.csrfToken}:{}),...(id?{'X-Hamdee-Property-Revision':`"property:${id}:${version}"`}:{})},body:JSON.stringify(body)
  });}
}
