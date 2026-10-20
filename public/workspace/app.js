import { PropertyApi } from './adapter.js';
import { renderRental,renderRentalDashboard,resetRental,rentalReportPeriod } from './rental.js';
import { renderExpenses,resetExpenses,expenseReportPeriod } from './expenses.js';
const api=new PropertyApi(),$=s=>document.querySelector(s),icon=window.icon;
const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let session=null,current=null,formContext=null,pending=null,trigger=null,routeSequence=0,authGeneration=0;
let filters={archiveState:'active',q:'',limit:'50',cursor:''},page=null;
let managed=null,access=null,recoveryView=false,readController=null,writeController=null,authController=null,expiryTimer=null;
let staffWorkspace=null,staffReady=false,capabilityController=null;
let carReady=false,companyReady=false,personalReady=false,carWorkspace=null,companyWorkspace=null,personalWorkspace=null;
let partnerReady=false,partnerWorkspace=null;
let moduleStates={};
function resetOwnerOperations(){carWorkspace?.resetCarRentals();companyWorkspace?.resetCompanyFinance();personalWorkspace?.resetPersonalFinance();partnerWorkspace?.resetPartners();}
// Retain HAMDEE's paper panels, brass actions, Inter and compact 4px rhythm.
// Owner access has one primary action; property metadata keeps its existing hierarchy.
const can=action=>session?.capabilities.includes(action);
const btn=(label,action,css='',id='')=>`<button type="button" class="button ${css}" data-action="${action}" data-id="${e(id)}">${e(label)}</button>`;
const heading=(title,subtitle,actions='')=>`<div class="page-head"><div><span class="eyebrow">HAMDEE PROPERTY REGISTER</span><h1>${e(title)}</h1><p>${e(subtitle)}</p></div><div class="head-actions">${actions}</div></div>`;
const unavailable=(title,message)=>`<section class="panel foundation-unavailable"><span class="eyebrow">HAMDEE WORKSPACE</span><h1>${e(title)}</h1><p>${e(message)}</p>${btn('Retry connection','refresh','primary')}</section>`;
const date=v=>v?new Date(v).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC':'—';
const nav=[['dashboard','Dashboard','dashboard'],['properties','Villas & Properties','properties'],['car-rentals','Car Rentals','briefcase'],['staff-collections','Staff Collections','partners'],['expenses','Expenses','expenses'],['company','Company Finance','company'],['personal-finance','Personal Finance','wallet'],['partners','Partners & Investments','partners'],['reports','Reports','reports']];
const rentalSections=['rental','rooms','tenants','agreements','collections','cheques','deposits'];
const expenseSections=['expenses','landlord','utilities','maintenance'];
// Observe failures immediately while another independently authorized request
// is in flight. A route owns each result once; no private-record cache exists.
const settledRead=request=>request.then(value=>({ok:true,value}),error=>({ok:false,error}));
function closeNavigation(returnFocus=false){$('#sidebar').classList.remove('open');$('.workspace').inert=false;document.body.classList.remove('navigation-open');$('.mobile-menu').setAttribute('aria-expanded','false');if(returnFocus)$('.mobile-menu').focus();}
function invalidateForm(){writeController?.abort();writeController=null;formContext=null;pending=null;$('#dialog').close();$('#dialog-body').innerHTML='';$('#conflict-review').innerHTML='';$('#form-error').textContent='';$('#save-button').disabled=false;$('#property-form').removeAttribute('aria-busy');}
function clearProtected(){closeNavigation();resetOwnerOperations();carReady=false;companyReady=false;personalReady=false;partnerReady=false;staffReady=false;moduleStates={};capabilityController?.abort();capabilityController=null;staffWorkspace?.resetStaffCollections();resetExpenses();resetRental();authGeneration++;routeSequence++;readController?.abort();authController?.abort();window.clearTimeout(expiryTimer);session=null;current=null;page=null;access=null;api.csrfToken=null;invalidateForm();$('#user-context').textContent='Not signed in';$('#logout-button').hidden=true;$('#recovery-button').hidden=true;document.querySelectorAll('#recovery-button,.topbar [data-action="refresh"]').forEach(button=>button.disabled=false);$('#feedback').textContent='';$('#mode-detail').textContent='Sign in to access saved records';}
function beginRead(){readController?.abort();readController=new window.AbortController();routeSequence++;return readController;}
const validRead=(seq,controller)=>seq===routeSequence&&!controller.signal.aborted;
const accessLost=error=>error.status===401||error.code==='OWNER_ACCESS_DENIED';
function showUnavailable(title,message){$('#main').innerHTML=unavailable(title,message);$('#main').setAttribute('aria-busy','false');}
function rememberAccess(data){
  access=api.rememberState(data);window.clearTimeout(expiryTimer);
  if(access.expiresAt!==null){const generation=authGeneration,deadline=access.expiresAt;const expire=()=>{
    if(generation!==authGeneration)return;
    const remaining=deadline-Date.now();
    if(remaining>0){expiryTimer=window.setTimeout(expire,Math.min(remaining,2147483647));return;}
    clearProtected();renderAccess('Your session has expired. Check your session to sign in again.');
  };expiryTimer=window.setTimeout(expire,Math.max(0,Math.min(deadline-Date.now(),2147483647)));}
  $('#logout-button').hidden=!managed||access.state!=='authenticated';
  $('#recovery-button').hidden=!managed||access.state!=='authenticated';
  return access;
}
function renderAccess(message=''){
  navigation();$('#main').setAttribute('aria-busy','false');$('#user-context').textContent='Not signed in';
  const phase=access?.state||'anonymous';let body,title='Sign-in required',subtitle='Owner access to your property workspace.';
  if(phase==='recovery_pending'){
    title='Recovery preparation';subtitle='Recovery requires authorized review before access can resume.';
    body='<div class="auth-guidance"><h2>Recovery prepared for review</h2><p>No recovery email or text message has been sent. Your password has not been reset. Contact your authorized account operator to review the managed recovery procedure.</p></div>'+btn('Check session','refresh','primary');
  }else if(recoveryView){
    title='Prepare account recovery';subtitle='Prepare the managed recovery process for operator review.';
    body='<p class="auth-guidance">This prepares recovery guidance. It does not send an email or reset a password. A current owner session will be signed out first.</p><form id="owner-recovery" class="auth-form"><div class="field"><label for="recovery-email">Email</label><input id="recovery-email" name="email" type="email" autocomplete="email" required></div><p id="access-error" role="alert" tabindex="-1"></p><button class="button primary" type="submit" '+(!api.csrfToken?'disabled':'')+'>Prepare recovery</button></form>'+btn('Back to sign in','access-back','subtle');
  }else{
    body='<form id="owner-login" class="auth-form"><div class="field"><label for="owner-email">Email</label><input id="owner-email" name="email" type="email" autocomplete="username" required></div><div class="field"><label for="owner-password">Password</label><input id="owner-password" name="password" type="password" autocomplete="current-password" required></div><p id="access-error" role="alert" tabindex="-1"></p><button class="button primary" type="submit" '+(!api.csrfToken?'disabled':'')+'>Sign in</button></form><p class="auth-guidance">Access is limited to the configured owner. Partners and tenants do not have logins.</p>'+btn('Prepare account recovery','access-recovery','subtle');
  }
  $('#main').innerHTML=`<section class="panel owner-access"><span class="eyebrow">HAMDEE OWNER ACCESS</span><h1>${title}</h1><p class="auth-subtitle">${subtitle}</p>${message?`<p class="auth-notice" role="status">${e(message)}</p>`:''}${body}<div class="auth-footer">${btn('Check session','refresh','subtle')}</div></section>`;

}
function showAccessError(error){const target=$('#access-error');if(target){target.textContent=error.message+(error.code==='CSRF_REJECTED'?' Check your session, then submit again.':'');target.focus();}else showUnavailable('Unable to confirm access',error.message);}
function accountBusy(busy){document.querySelectorAll('.owner-access button,#recovery-button,.topbar [data-action="refresh"]').forEach(button=>button.disabled=busy||(!api.csrfToken&&button.type==='submit'));$('.owner-access')?.setAttribute('aria-busy',String(busy));}
async function showAccessLoss(error){
  if(error.code==='CSRF_REJECTED'){
    // Rental/expense views delegate rejected requests here. A stale write proof
    // is recoverable: retain the dialog and require an explicit save after GET.
    const generation=authGeneration,signal=readController?.signal;
    const target=document.querySelector('#expense-dialog[open] #expense-error,#rental-dialog[open] #rental-error,#dialog[open] #form-error');
    try{const fresh=await api.authState(signal);if(generation!==authGeneration||signal?.aborted)return;
      if(fresh.data.state==='authenticated'){rememberAccess(fresh.data);if(target?.isConnected){target.textContent='Session verification renewed. Review your draft, then save explicitly.';target.focus();}return;}
    }catch(failure){if(generation!==authGeneration||signal?.aborted)return;if(target?.isConnected){target.textContent=failure.message+' Your draft is retained. Check your session before retrying.';target.focus();return;}}
  }
  const legacy=managed===false;clearProtected();recoveryView=false;
  if(legacy){showUnavailable('Sign-in required',error.message);return;}
  const controller=beginRead(),seq=routeSequence;
  try{const result=await api.authState(controller.signal);if(!validRead(seq,controller))return;managed=true;rememberAccess(result.data);renderAccess(error.message);}
  catch(failure){if(!validRead(seq,controller))return;showUnavailable(failure.status===404?'Sign-in required':'Backend unavailable',failure.status===404?error.message:failure.message);}
}
async function syncAccess(signal){
  if(!managed)return true;
  const result=await api.authState(signal);if(signal?.aborted)return false;rememberAccess(result.data);
  if(access.state==='authenticated')return true;
  const data=access;clearProtected();rememberAccess(data);renderAccess('Your access changed. Verify your session before continuing.');return false;
}
async function runAccount(action,body={},form=null){
  if(authController&&!authController.signal.aborted)return;
  const controller=new window.AbortController(),generation=authGeneration;authController=controller;accountBusy(true);
  if($('#access-error'))$('#access-error').textContent='';
  try{
    const result=await api.auth(action,body,controller.signal);
    if(generation!==authGeneration||controller.signal.aborted)return;
    if(result.data.state==='authenticated'){
      rememberAccess(result.data);
      if(action==='login')window.history.replaceState(null,'',window.location.pathname+window.location.search+'#dashboard');
      authController=null;await boot();return;
    }
    clearProtected();managed=true;recoveryView=false;rememberAccess(result.data);renderAccess();
    if(access.state==='anonymous')$('#owner-email')?.focus();
  }catch(error){
    if(generation!==authGeneration||controller.signal.aborted)return;
    if(action==='login'&&accessLost(error)){
      // A denied login can clear the signed CSRF cookie. Prepare a fresh proof,
      // retaining the email/error, so the next explicit password attempt works.
      api.csrfToken=null;
      try{const fresh=await api.authState(controller.signal);if(generation!==authGeneration||controller.signal.aborted)return;if(fresh.data.state==='anonymous')rememberAccess(fresh.data);}
      catch{if(generation!==authGeneration||controller.signal.aborted)return;}
      showAccessError(api.csrfToken?error:new Error(error.message+' Check your session before trying again.'));
    }
    else if(accessLost(error))await showAccessLoss(error);
    else showAccessError(error);
  }finally{
    delete body.password;
    if(form?.isConnected)form.querySelectorAll('input[type="password"]').forEach(input=>input.value='');
    if(authController===controller){authController=null;accountBusy(false);}
  }
}
async function logout(){
  const proof=api.csrfToken;clearProtected();managed=true;recoveryView=false;api.csrfToken=proof;
  const generation=authGeneration,controller=new window.AbortController();authController=controller;accountBusy(true);
  $('#main').innerHTML='<section class="panel foundation-unavailable" role="status"><h1>Signing out…</h1><p>Clearing local access and confirming managed sign-out.</p></section>';
  try{const result=await api.auth('logout',{},controller.signal);if(generation!==authGeneration||controller.signal.aborted)return;rememberAccess(result.data);renderAccess('You have signed out.');}
  catch(error){if(generation!==authGeneration||controller.signal.aborted)return;api.csrfToken=null;showUnavailable(error.code==='SIGN_OUT_UNCONFIRMED'?'Sign-out unconfirmed':'Unable to confirm sign-out',error.message+' Local access has been cleared. Global sign-out has not been confirmed.');}
  finally{if(authController===controller){authController=null;accountBusy(false);}}
}
async function refreshProof(){
  const c=formContext,generation=authGeneration,controller=beginRead();
  try{const result=await api.authState(controller.signal);if(generation!==authGeneration||controller.signal.aborted||formContext!==c)return;
    if(result.data.state!=='authenticated'){clearProtected();managed=true;rememberAccess(result.data);renderAccess();return;}
    rememberAccess(result.data);$('#form-error').textContent='Session verified. Review your draft, then save explicitly.';$('#form-error').focus();
  }catch(error){if(generation===authGeneration&&!controller.signal.aborted&&formContext===c){$('#form-error').textContent=error.message;$('#form-error').focus();}}
}
function navigation(){
  const route=(window.location.hash.slice(1)||'dashboard').split('/')[0],active=['tenants','collections','cheques'].includes(route)?'properties':route==='maintenance'?'expenses':route;
  const focused=$('#navigation').contains(document.activeElement)?document.activeElement.closest('a')?.getAttribute('href'):null;
  const enabled=new Set(['dashboard','properties',...(managed!==false?['expenses','reports']:[]),...(staffReady?['staff-collections']:[]),...(carReady?['car-rentals']:[]),...(companyReady?['company']:[]),...(personalReady?['personal-finance']:[]),...(partnerReady?['partners']:[])]);
  $('#navigation').innerHTML='<div class="nav-group">WORKSPACE</div>'+nav.map(([id,name,ico])=>enabled.has(id)?`<a class="nav-link ${active===id?'active':''}" href="#${id}" ${active===id?'aria-current="page"':''}>${icon(ico)}<span>${e(name)}</span></a>`:moduleStates[id]==='retry'?`<button type="button" class="nav-link nav-unavailable nav-retry" data-action="retry-modules" title="Retry checking this service">${icon(ico)}<span>${e(name)}</span><small>Retry</small></button>`:`<button type="button" class="nav-link nav-unavailable" disabled>${icon(ico)}<span>${e(name)}</span><small>${moduleStates[id]==='loading'?'Checking…':'Unavailable'}</small></button>`).join('');
  $('#crumb').textContent=nav.find(n=>n[0]===active)?.[1]||'Property workspace';
  if(focused)[...$('#navigation').querySelectorAll('a')].find(link=>link.getAttribute('href')===focused)?.focus();
}
async function discoverOperations(){
  if(!session||!managed)return;capabilityController?.abort();const controller=new window.AbortController(),generation=authGeneration;capabilityController=controller;
  const asOf=new Date().toISOString().slice(0,10),month=asOf.slice(0,7),valid=()=>generation===authGeneration&&!controller.signal.aborted&&Boolean(session);
  const arrays=(data,keys)=>data?.moneyUnit==='decimal-major-unit-strings'&&keys.every(key=>Array.isArray(data[key]));
  const scoped=(data,scope)=>arrays(data,['accounts','transferAccounts','totals','entries','monthEntries'])&&data.scope===scope&&data.accounts.every(row=>row.scope===scope);
  const outcomes={};
  const tasks=[['staff-collections',()=>api.staffRead({month,asOf},controller.signal),data=>arrays(data,['collectors','collections','handovers','totals','daily','history'])],['company',()=>api.financeRead({month,asOf},controller.signal),data=>scoped(data,'company')],['personal-finance',()=>api.personalRead({month,asOf},controller.signal),data=>scoped(data,'personal')],['car-rentals',()=>api.carRead({month,asOf},controller.signal),data=>arrays(data,['vehicles','agreements','availability','balances','collections','expenses','history','summary'])],['partners',()=>api.partnerRead({month,asOf,limit:1},controller.signal),data=>arrays(data,['partners','links','entries','history','summary','currencies'])]];
  for(const [id] of tasks){outcomes[id]={state:'loading',data:null};moduleStates[id]='loading';}navigation();
  const update=()=>{
    if(!valid())return;
    companyReady=outcomes.company.state==='ready';personalReady=outcomes['personal-finance'].state==='ready';carReady=outcomes['car-rentals'].state==='ready';partnerReady=outcomes.partners.state==='ready';
    // Staff records have their own authorized service. Company account choices
    // are verified separately by the handover form; a slow finance probe must
    // not hide otherwise available collector records and custody history.
    staffReady=outcomes['staff-collections'].state==='ready';
    for(const [id] of tasks)moduleStates[id]=outcomes[id].state;
    navigation();
  };
  try{await Promise.allSettled(tasks.map(async([id,read,accept])=>{
    try{const result=await read();if(!valid())return;
      if(!accept(result.data)){outcomes[id]={state:'retry',data:null};update();return;}
      if(!await syncAccess(controller.signal)||!valid())return;
      outcomes[id]={state:'ready',data:result.data};update();
    }catch(error){if(!valid())return;if(accessLost(error)){await showAccessLoss(error);return;}
      const blocked=[401,403].includes(error.status)||['CONFIGURATION_UNAVAILABLE','ENVIRONMENT_MISMATCH'].includes(error.code);
      outcomes[id]={state:blocked?'unavailable':'retry',data:null};update();
    }
  }));}
  finally{if(capabilityController===controller)capabilityController=null;}
}
async function boot(){
  clearProtected();recoveryView=false;managed=null;const controller=beginRead(),seq=routeSequence;navigation();$('#main').innerHTML='<div class="empty" role="status"><h2>Checking secure access…</h2></div>';$('#main').setAttribute('aria-busy','true');
  try{const result=await api.session(controller.signal);if(!validRead(seq,controller))return;
    try{const state=await api.authState(controller.signal);if(!validRead(seq,controller))return;managed=true;rememberAccess(state.data);if(access.state!=='authenticated'){renderAccess();return;}}
    catch(error){if(error.status!==404)throw error;managed=false;}
    if(!validRead(seq,controller))return;session=result.data;$('#user-context').innerHTML=`<strong>${e(managed?'HAMDEE owner':session.name)}</strong><small>${managed?'Owner account':e(session.roles.join(' · '))}</small>`;
    $('#mode-detail').textContent=session.authenticationProvider==='automated-test'?'Automated test identity · Synthetic records only':'Owner access · Saved records';
    const initialRender=render();if(session&&managed)void discoverOperations();await initialRender;
  }catch(error){if(!validRead(seq,controller))return;if(accessLost(error))await showAccessLoss(error);else{clearProtected();showUnavailable('Backend unavailable',error.message);}}
  finally{if(validRead(seq,controller))$('#main').setAttribute('aria-busy','false');}
}
function propertyEmpty(){
  if(!managed)return '<div class="empty"><h2>No authorized properties</h2><p>Create your first basic property or ask an administrator to assign access.</p></div>';
  return filters.q||filters.archiveState!=='active'||filters.cursor?`<div class="empty"><h2>No matching properties</h2><p>Change your search or record status to see saved properties.</p>${btn('Clear filters','clear-property-filters')}</div>`:'<div class="empty"><h2>No properties yet</h2><p>Add your first property to begin your register.</p></div>';
}
function table(rows){return `<div class="table-wrap" tabindex="0" role="region" aria-label="Property records"><table class="data-table"><thead><tr><th scope="col">Property</th><th scope="col">Location</th><th scope="col">Record status</th><th scope="col">Revision</th><th scope="col">Updated</th></tr></thead><tbody>${rows.map(p=>`<tr><td><button class="record-name" data-action="detail" data-id="${e(p.id)}">${e(p.name)}</button><span class="record-sub">${e(p.id)}</span></td><td>${e(p.location||'Not provided')}</td><td><span class="badge ${p.lifecycleStatus==='archived'?'amber':'green'}">${e(p.lifecycleStatus)}</span></td><td>${p.version}</td><td>${e(date(p.updatedAt))}</td></tr>`).join('')}</tbody></table></div>`;}
async function render(){
  const route=window.location.hash.slice(1)||'dashboard',sameProperty=route.startsWith('properties/')&&current?.id===route.split('/')[1];
  staffWorkspace?.resetStaffCollections();resetOwnerOperations();
  resetExpenses(sameProperty);resetRental(sameProperty);invalidateForm();const controller=beginRead(),seq=routeSequence;navigation();if(!session){if(access)renderAccess();else await boot();return;}$('#main').setAttribute('aria-busy','true');
  const main=$('#main');
  main.innerHTML='<div class="empty" role="status"><h2>Loading authorized records…</h2></div>';
  try{
    if(route==='partners'&&managed){
      current=null;page=null;main.innerHTML=heading('Partners & Investments','Contacts, property links and recorded movements')+'<div id="partner-workspace"></div>';
      const module=await import('./partners.js');if(!validRead(seq,controller))return;partnerWorkspace=module;
      await module.renderPartners($('#partner-workspace'),{api,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss});
    }else if(['staff-collections','car-rentals','company','personal-finance'].includes(route)&&managed){
      current=null;page=null;main.innerHTML=heading(nav.find(n=>n[0]===route)[1],'Owner workspace · Saved records only')+'<div id="operations-workspace"></div>';
      if(route==='staff-collections'){const module=await import('./staff-collections.js');if(!validRead(seq,controller))return;staffWorkspace=module;await module.renderStaffCollections($('#operations-workspace'),{api,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss});}
      else{
        const options={api,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss};
        if(route==='car-rentals'){const module=await import('./car-rentals.js');if(!validRead(seq,controller))return;carWorkspace=module;await module.renderCarRentals($('#operations-workspace'),options);}
        else if(route==='personal-finance'){const module=await import('./personal-finance.js');if(!validRead(seq,controller))return;personalWorkspace=module;await module.renderPersonalFinance($('#operations-workspace'),options);}
        else{const module=await import('./company-finance.js');if(!validRead(seq,controller))return;companyWorkspace=module;await module.renderCompanyFinance($('#operations-workspace'),options);}
      }
    }else if(route.startsWith('properties/')){
      const [,id,section='overview']=route.split('/'),propertyRequest=api.get(id,controller.signal);
      let prefetchedRental,prefetchedExpenses;
      if(managed&&rentalSections.includes(section))prefetchedRental=settledRead(api.rentalRead({...rentalReportPeriod(),propertyId:id},controller.signal));
      if(managed&&expenseSections.includes(section)){
        const period=expenseReportPeriod();
        prefetchedExpenses=settledRead(Promise.all([api.expenseRead({...period,propertyId:id},controller.signal),api.rentalRead({...period,propertyId:id},controller.signal)]));
      }
      const result=await propertyRequest;if(!validRead(seq,controller)||!await syncAccess(controller.signal)||!validRead(seq,controller))return;current=result.data;
      const p=current;main.innerHTML=heading(p.name,'Property details, rentals and operating history',btn('Back to properties','back')+(can('update')&&p.lifecycleStatus!=='archived'?btn('Edit property','edit','primary'):'')+(can('archive')&&p.lifecycleStatus!=='archived'?btn('Archive','archive','danger'):'')+(can('restore')&&p.lifecycleStatus==='archived'?btn('Restore','restore','primary'):''))+
        `<section class="panel"><div class="detail-meta"><div><small>Internal ID</small><strong>${e(p.id)}</strong></div><div><small>Record lifecycle</small><strong>${e(p.lifecycleStatus)}</strong></div><div><small>Revision</small><strong>${p.version}</strong></div></div></section><div class="tabs" aria-label="Villa workspace"><button class="tab ${section==='overview'?'active':''}" data-action="overview">Overview</button>${managed?`<button class="tab ${rentalSections.includes(section)?'active':''}" data-action="rental">Rooms &amp; rentals</button><button class="tab ${expenseSections.includes(section)?'active':''}" data-action="property-expenses">Expenses &amp; maintenance</button>`:''}${can('audit')?`<button class="tab ${section==='history'?'active':''}" data-action="audit">Audit history</button>`:''}</div><section class="panel" id="detail-content"><div class="panel-header"><div><h2>Property metadata</h2><p>Archival changes record visibility only.</p></div></div><dl class="summary-list">${[['Name',p.name],['Location',p.location||'Not provided'],['Counterparty reference',p.counterpartyId||'Not assigned'],['Created',date(p.createdAt)],['Created by',p.createdBy],['Updated',date(p.updatedAt)],['Updated by',p.updatedBy],...(p.archivedAt?[['Archived',date(p.archivedAt)],['Archived by',p.archivedBy],['Archive reason',p.archiveReason]]:[])].map(([a,b])=>`<div><dt>${e(a)}</dt><dd>${e(b)}</dd></div>`).join('')}</dl></section>`;
      const options={api,property:p,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss};
      if(managed&&rentalSections.includes(section))await renderRental($('#detail-content'),{...options,section:section==='rental'?null:section,prefetchedRental});
      else if(managed&&expenseSections.includes(section))await renderExpenses($('#detail-content'),{...options,section:section==='expenses'?null:section,prefetchedExpenses});
      else if(section==='history'&&can('audit'))await renderPropertyHistory(p.id,controller,seq);
    }else if(route==='dashboard'&&managed){
      const result=await api.dashboard(controller.signal);if(!validRead(seq,controller)||!await syncAccess(controller.signal)||!validRead(seq,controller))return;current=null;page=null;
      const d=result.data;
      main.innerHTML=heading('Property overview','Your saved properties, rentals and operating costs.',can('create')?btn('Add property','create','primary'):'')+
        `<div class="metrics owner-metadata-metrics">${[['Total properties',d.totalProperties,'All saved records'],['Active properties',d.activeProperties,'Registered metadata records'],['Archived properties',d.archivedProperties,'History preserved']].map(([label,value,note])=>`<div class="metric"><div class="metric-top"><span>${label}</span>${icon('properties')}</div><div class="metric-value">${e(value)}</div><p class="metric-note">${note}</p></div>`).join('')}</div>`+
        `<section class="panel"><div class="panel-header"><div><h2>Recently updated properties</h2><p>Up to ten saved records · Newest updates first</p></div>${btn('View properties','back')}</div>${d.recentProperties.length?table(d.recentProperties):'<div class="empty"><h2>No properties yet</h2><p>Add your first property to begin your register.</p></div>'}</section>`+
        `<p class="muted-help">Collections and recorded costs appear below. Account movements remain in Company Finance and Personal Finance; no distributable profit is inferred.</p>`;
      const rentalTarget=document.createElement('div');rentalTarget.id='rental-dashboard';main.append(rentalTarget);
      const expenseTarget=document.createElement('div');expenseTarget.id='expense-dashboard';main.append(expenseTarget);
      for(const target of [rentalTarget,expenseTarget])target.setAttribute('aria-busy','true');
      // Property counts and recent villas are usable now; slower panels keep
      // their own loading status without holding the entire workspace busy.
      main.setAttribute('aria-busy','false');
      const expenseOptions={api,summaryOnly:true,followRentalPeriod:true,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss};
      await Promise.all([
        renderRentalDashboard(rentalTarget,{api,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss,onReportChange:period=>renderExpenses(expenseTarget,{...expenseOptions,period})}).finally(()=>{if(validRead(seq,controller))rentalTarget.setAttribute('aria-busy','false');}),
        renderExpenses(expenseTarget,{...expenseOptions,period:rentalReportPeriod()}).finally(()=>{if(validRead(seq,controller))expenseTarget.setAttribute('aria-busy','false');})
      ]);
    }else if(['expenses','maintenance','reports'].includes(route)&&managed){
      current=null;page=null;main.innerHTML=heading(route==='reports'?'Monthly property report':route==='maintenance'?'Property maintenance':'Property expenses','Private owner records · Saved property costs and payments.')+'<div id="expense-workspace"></div>';
      await renderExpenses($('#expense-workspace'),{api,summaryOnly:route==='reports',signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss});
    }else if(['tenants','collections','cheques'].includes(route)&&managed){
      current=null;page=null;main.innerHTML=heading(route==='tenants'?'Rooms, tenants & agreements':route==='cheques'?'Cheque register':'Rent collections','Private owner records · Saved room-level records.')+'<div id="rental-workspace"></div>';
      await renderRental($('#rental-workspace'),{api,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss});
    }else if(route==='dashboard'||route==='properties'){
      const result=await api.list(filters,controller.signal);if(!validRead(seq,controller)||!await syncAccess(controller.signal)||!validRead(seq,controller))return;page=result;current=null;
      main.innerHTML=heading(route==='dashboard'?'Property overview':'Properties','Open a property to manage its rooms, tenants and collections.',can('create')?btn('Add property','create','primary'):'')+
        (route==='dashboard'?`<div class="metrics"><div class="metric"><div class="metric-top"><span>Properties on this page</span>${icon('properties')}</div><div class="metric-value">${result.data.length}</div><p class="metric-note">Authorized records · Current filters</p></div>${['Rental income','Partner returns','Company income'].map(t=>`<div class="metric"><div class="metric-top"><span>${t}</span></div><div class="metric-value unavailable-metric">Unavailable</div><p class="metric-note">Financial module not enabled</p></div>`).join('')}</div>`:'')+
        `<section class="panel"><div class="panel-header"><div><h2>Property register</h2><p>No rental, funding or ownership terms are inferred.</p></div></div><form id="filters" class="toolbar"><label class="search-field">${icon('search')}<input name="q" aria-label="Search properties" placeholder="Search name or location…" value="${e(filters.q)}" maxlength="200"></label><select name="archiveState" class="filter-select" aria-label="Record status">${[['active','Active records'],['archived','Archived records'],['all','All records']].map(([v,l])=>`<option value="${v}" ${filters.archiveState===v?'selected':''}>${l}</option>`).join('')}</select><button class="button subtle" type="submit">Apply filters</button></form>${result.data.length?table(result.data):propertyEmpty()}<div class="table-foot"><span>${result.data.length} records on this page</span>${result.nextCursor?btn('Next page','next'):''}${filters.cursor?btn('First page','first'):''}</div></section>`;
    }else{main.innerHTML=heading(nav.find(n=>n[0]===route)?.[1]||'Unavailable','This module is outside the current property-foundation slice.')+unavailable('Module unavailable','The existing demo remains separate. This development workspace does not use sample financial data or simulate operational actions.');}
  }catch(error){if(!validRead(seq,controller))return;if(accessLost(error))await showAccessLoss(error);else showUnavailable(error.status===404?'Property unavailable':error.status===403?'Access restricted':'Unable to load records',error.message);}
  finally{if(validRead(seq,controller))main.setAttribute('aria-busy','false');}
}
async function renderPropertyHistory(id,controller,seq){
  try{const result=await api.audit(id,'',controller.signal);if(current?.id!==id||!validRead(seq,controller)||!await syncAccess(controller.signal)||!validRead(seq,controller))return;$('#detail-content').innerHTML=`<div class="panel-header"><div><h2>Audit history</h2><p>Attributed metadata changes · No confidential payload dumps</p></div></div><div class="table-wrap" tabindex="0" role="region" aria-label="Property audit history"><table class="data-table"><thead><tr>${['Revision','Action','Actor','Reason','Time'].map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${result.data.map(a=>`<tr><td>${a.version}</td><td>${e(a.action)}</td><td>${e(a.actorId)}</td><td>${e(a.reason||'—')}</td><td>${e(date(a.occurredAt))}</td></tr>`).join('')}</tbody></table></div>${result.nextCursor?'<p class="muted-help">More history is available through the paginated API.</p>':''}`;}
  catch(error){if(!validRead(seq,controller))return;if(accessLost(error))await showAccessLoss(error);else $('#detail-content').innerHTML=unavailable('Audit unavailable',error.message);}
}
function propertySection(section){const hash='properties/'+current.id+(section?'/'+section:'');if(window.location.hash==='#'+hash)void render();else window.location.hash=hash;}
function dialog(action){
  trigger=document.activeElement;formContext={action,property:current?{...current}:null};pending=null;
  const p=formContext.property;$('#dialog-title').textContent=action==='create'?'Add property':action==='update'?'Edit property':action==='archive'?'Archive property':'Restore property';
  $('#dialog-subtitle').textContent=['archive','restore'].includes(action)?'Preserve identity and history. This does not close a tenancy or financial period.':'Basic metadata only. Financial settings are not part of this form.';
  $('#dialog-body').innerHTML=['archive','restore'].includes(action)?`<div class="field"><label for="reason">Reason</label><textarea id="reason" name="reason" required maxlength="500"></textarea></div>`:`<div class="form-grid"><div class="field wide"><label for="name">Property name</label><input id="name" name="name" value="${e(p?.name||'')}" required maxlength="200"></div><div class="field wide"><label for="location">Location / address (optional)</label><textarea id="location" name="location" maxlength="500">${e(p?.location||'')}</textarea></div><div class="field wide"><label for="counterpartyId">External counterparty reference (optional)</label><input id="counterpartyId" name="counterpartyId" value="${e(p?.counterpartyId||'')}" placeholder="Existing authorized reference UUID"><small>Detailed counterparty relationships remain pending approval.</small></div></div>`;
  $('#form-error').textContent='';$('#conflict-review').innerHTML='';$('#save-button').textContent=action==='archive'?'Confirm archive':action==='restore'?'Restore property':'Save property';$('#dialog').showModal();
}
function closeDialog(){if($('#save-button').disabled)return;$('#dialog').close();formContext=null;pending=null;trigger?.focus();}
document.addEventListener('submit',async event=>{
  if(['owner-login','owner-recovery'].includes(event.target.id)){
    event.preventDefault();const form=event.target,body=Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[type="password"]').forEach(input=>input.value='');
    await runAccount(form.id==='owner-login'?'login':'recovery',body,form);return;
  }
  if(event.target.id==='filters'){event.preventDefault();const d=Object.fromEntries(new FormData(event.target));filters={...filters,...d,cursor:''};await render();return;}
  if(event.target.id!=='property-form')return;event.preventDefault();
  const c=formContext,generation=authGeneration;if(!c||$('#save-button').disabled)return;
  const d=Object.fromEntries(new FormData(event.target));
  const body=pending?.uncertain?pending.body:['archive','restore'].includes(c.action)?{reason:d.reason}:{name:d.name,location:d.location||null,counterpartyId:d.counterpartyId||null};
  const signature=JSON.stringify([c.action,c.property?.id,c.property?.version,body]);
  if(pending?.signature!==signature)pending={signature,key:crypto.randomUUID(),body,uncertain:false};
  writeController=new window.AbortController();const controller=writeController;
  $('#save-button').disabled=true;$('#property-form').setAttribute('aria-busy','true');$('#form-error').textContent='';$('#feedback').textContent='';
  try{const result=await api.mutate(c.action,c.property?.id,body,pending.key,c.property?.version,controller.signal);if(formContext!==c||generation!==authGeneration||controller.signal.aborted)return;$('#save-button').disabled=false;closeDialog();$('#feedback').textContent='Property '+(c.action==='create'?'created':c.action==='update'?'updated':c.action==='archive'?'archived':'restored')+'.';
    if(window.location.hash==='#properties/'+result.data.id)await render();else window.location.hash='properties/'+result.data.id;
  }catch(error){if(formContext!==c||generation!==authGeneration||controller.signal.aborted)return;if(accessLost(error))await showAccessLoss(error);else{
    pending.uncertain=Boolean(error.uncertain);
    $('#dialog-body').querySelectorAll('input,textarea,select').forEach(input=>input.disabled=pending.uncertain);
    $('#form-error').textContent=error.message+(pending.uncertain?' The save may already have reached the server. Save again to retry the exact submission; closing will not undo a committed change.':'');
    if(error.status===412)$('#conflict-review').innerHTML=btn('Review latest revision','review-latest');
    else if(error.code==='CSRF_REJECTED')$('#conflict-review').innerHTML=btn('Refresh session verification','refresh-proof');
    $('#form-error').focus();}}
  finally{if(formContext===c){$('#save-button').disabled=false;$('#property-form').setAttribute('aria-busy','false');}if(writeController===controller)writeController=null;}
});
document.addEventListener('click',async event=>{
  const destination=event.target.closest('#sidebar a[href^="#"]');
  if(destination){closeNavigation();if(destination.hash===(window.location.hash||'#dashboard')){event.preventDefault();$('#main').focus();}return;}
  const target=event.target.closest('[data-action]');if(!target)return;const action=target.dataset.action;
  if(action==='logout'){await logout();return;}
  if(action==='retry-modules'){await discoverOperations();return;}
  if(action==='retry-view'){await render();return;}
  if(action==='refresh-proof'){await refreshProof();return;}
  if(action==='clear-property-filters'){filters={archiveState:'active',q:'',limit:'50',cursor:''};await render();$('#filters input[name="q"]')?.focus();return;}
  if(action==='access-recovery'){
    if(authController)return;const state=access;clearProtected();if(state){managed=true;rememberAccess(state);}recoveryView=true;renderAccess();$('#recovery-email')?.focus();return;
  }
  if(action==='access-back'){recoveryView=false;await boot();return;}
  if(action==='skip-workspace'){event.preventDefault();$('#main').focus();return;}
  if(action==='nav-open'){$('#sidebar').classList.add('open');$('.workspace').inert=true;document.body.classList.add('navigation-open');target.setAttribute('aria-expanded','true');($('#navigation [aria-current="page"]')||$('#navigation a'))?.focus();return;}
  if(action==='nav-close'){closeNavigation(true);return;}
  if(action==='refresh'){await boot();return;}if(action==='detail'){window.location.hash='properties/'+target.dataset.id;return;}if(action==='back'){window.location.hash='properties';return;}
  if(action==='create'){dialog('create');return;}if(action==='edit'){dialog('update');return;}if(['archive','restore'].includes(action)){dialog(action);return;}if(action==='close'){closeDialog();return;}
  if(action==='next'){filters.cursor=page.nextCursor;await render();return;}if(action==='first'){filters.cursor='';await render();return;}
  if(action==='review-latest'){
    const c=formContext,generation=authGeneration;if(!c)return;
    const controller=beginRead();
    try{const result=await api.get(c.property.id,controller.signal);if(formContext!==c||generation!==authGeneration||controller.signal.aborted)return;if(!await syncAccess(controller.signal)||formContext!==c)return;c.property=result.data;pending=null;$('#dialog-body').querySelectorAll('input,textarea,select').forEach(input=>input.disabled=false);$('#conflict-review').innerHTML=`<p>Latest revision ${result.data.version}: ${e(result.data.name)} · ${e(result.data.location||'No location')}. Your draft remains above. Review it before saving.</p>`;}
    catch(error){if(formContext!==c||generation!==authGeneration||controller.signal.aborted)return;if(accessLost(error))await showAccessLoss(error);else if(error.status===404){current=null;invalidateForm();showUnavailable('Property unavailable',error.message);}else $('#form-error').textContent=error.message;}return;
  }
  if(action==='property-expenses'){
    if(current&&managed)propertySection('expenses');return;
  }
  if(action==='rental'){
    if(current&&managed)propertySection('rental');return;
  }
  if(action==='audit'){
    if(current&&can('audit'))propertySection('history');return;
  }
  if(action==='overview'){if(current)propertySection('');else await render();}
});
$('#dialog').addEventListener('cancel',event=>{if($('#save-button').disabled)event.preventDefault();});
document.addEventListener('keydown',event=>{
  if(!$('#sidebar').classList.contains('open'))return;
  if(event.key==='Escape'){event.preventDefault();closeNavigation(true);return;}
  if(event.key==='Tab'){const controls=[...$('#sidebar').querySelectorAll('a,button')].filter(el=>!el.disabled&&el.getClientRects().length),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
});
window.addEventListener('hashchange',async()=>{closeNavigation();if(!authController||authController.signal.aborted){await render();if(session&&!document.querySelector('dialog[open]'))$('#main').focus();}});
void boot();
