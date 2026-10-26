import {PropertyApi} from './workspace/adapter.js';
const api=new PropertyApi(),form=document.querySelector('#login-form'),error=document.querySelector('#login-error'),status=document.querySelector('#login-status');
let controller=null,busy=false,phase='anonymous';
const dashboard=()=>window.location.replace('/workspace/index.html#dashboard');
function enabled(){document.querySelectorAll('.login-card button').forEach(button=>button.disabled=busy||(button.type==='submit'&&(!api.csrfToken||phase==='recovery_pending')));form.setAttribute('aria-busy',String(busy));}
function remember(data){const value=api.rememberState(data);phase=value.state;if(phase==='authenticated'){form.querySelector('[name="password"]').value='';dashboard();return;}status.textContent=phase==='recovery_pending'?'Recovery is prepared for operator review. No reset email has been sent; contact the authorized account operator.':'';enabled();}
async function check(){
 if(busy)return;controller?.abort();const c=new window.AbortController();controller=c;busy=true;enabled();error.textContent='';status.textContent='Checking secure access…';
 try{const result=await api.authState(c.signal);if(!c.signal.aborted)remember(result.data);}catch(cause){if(!c.signal.aborted){api.csrfToken=null;status.textContent='';error.textContent=cause.message;}}
 finally{if(controller===c){busy=false;enabled();}}
}
async function submit(action,input){
 if(busy)return;controller?.abort();const c=new window.AbortController();controller=c;busy=true;enabled();error.textContent='';status.textContent=action==='login'?'Signing in…':'Preparing recovery for review…';
 const body=action==='login'?{email:input.elements.email.value,password:input.elements.password.value}:{email:input.elements.email.value};
 try{const pending=api.auth(action,body,c.signal);if(action==='login')input.elements.password.value='';const result=await pending;if(!c.signal.aborted)remember(result.data);}
 catch(cause){
  if(c.signal.aborted)return;status.textContent='';error.textContent=cause.message;error.focus();
  if(action==='login'&&(cause.code==='CSRF_REJECTED'||cause.status===401||cause.code==='OWNER_ACCESS_DENIED')){
   api.csrfToken=null;try{const state=await api.authState(c.signal);if(!c.signal.aborted)remember(state.data);}catch{if(!c.signal.aborted)status.textContent='Check the connection before another explicit sign-in attempt.';}
  }
 }finally{delete body.password;form.querySelector('[name="password"]').value='';if(controller===c){busy=false;enabled();}}
}
form.addEventListener('submit',event=>{event.preventDefault();void submit('login',event.target);});
document.querySelector('#login-recovery-form').addEventListener('submit',event=>{event.preventDefault();void submit('recovery',event.target);});
document.querySelector('#login-check').addEventListener('click',()=>void check());
window.addEventListener('pagehide',()=>{controller?.abort();form.querySelector('[name="password"]').value='';});
window.addEventListener('pageshow',event=>{if(event.persisted){form.querySelector('[name="password"]').value='';busy=false;controller=null;void check();}});
void check();
