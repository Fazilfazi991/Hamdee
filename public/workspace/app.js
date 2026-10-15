import { PropertyApi } from './adapter.js';
import { renderRental,renderRentalDashboard,resetRental,rentalReportPeriod } from './rental.js';
import { renderExpenses,resetExpenses } from './expenses.js';
const api=new PropertyApi(),$=s=>document.querySelector(s),icon=window.icon;
const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let session=null,current=null,formContext=null,pending=null,trigger=null,routeSequence=0,authGeneration=0;
let filters={archiveState:'active',q:'',limit:'50',cursor:''},page=null;
let managed=null,access=null,enrollment=null,recoveryView=false,readController=null,writeController=null,authController=null,expiryTimer=null;
// Retain HAMDEE's paper panels, brass actions, Inter and compact 4px rhythm.
// Owner access has one primary action; property metadata keeps its existing hierarchy.
const can=action=>session?.capabilities.includes(action);
const btn=(label,action,css='',id='')=>`<button type="button" class="button ${css}" data-action="${action}" data-id="${e(id)}">${e(label)}</button>`;
const heading=(title,subtitle,actions='')=>`<div class="page-head"><div><span class="eyebrow">HAMDEE PROPERTY REGISTER</span><h1>${e(title)}</h1><p>${e(subtitle)}</p></div><div class="head-actions">${actions}</div></div>`;
const unavailable=(title,message)=>`<section class="panel foundation-unavailable"><span class="eyebrow">PRODUCTION DEVELOPMENT</span><h1>${e(title)}</h1><p>${e(message)}</p>${btn('Retry connection','refresh','primary')}</section>`;
const date=v=>v?new Date(v).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC':'—';
const nav=[['dashboard','Dashboard','dashboard'],['properties','Properties','properties'],['partners','Investment partners','partners'],['tenants','Tenants & agreements','tenants'],['collections','Collections','collections'],['cheques','Cheque desk','cheques'],['expenses','Expenses','expenses'],['maintenance','Maintenance','maintenance'],['vendors','Vendors','vendors'],['company','Company accounts','company'],['settlements','Partner settlements','settlements'],['reports','Reports','reports'],['settings','Settings','settings']];
function invalidateForm(){writeController?.abort();writeController=null;formContext=null;pending=null;$('#dialog').close();$('#dialog-body').innerHTML='';$('#conflict-review').innerHTML='';$('#form-error').textContent='';$('#save-button').disabled=false;$('#property-form').removeAttribute('aria-busy');}
function clearProtected(){resetExpenses();resetRental();authGeneration++;routeSequence++;readController?.abort();authController?.abort();window.clearTimeout(expiryTimer);session=null;current=null;page=null;access=null;enrollment=null;api.csrfToken=null;invalidateForm();$('#user-context').textContent='Not signed in';$('#logout-button').hidden=true;$('#recovery-button').hidden=true;document.querySelectorAll('#recovery-button,.topbar [data-action="refresh"]').forEach(button=>button.disabled=false);$('#feedback').textContent='';$('#mode-detail').textContent='Property and rental records · backend required';}
function beginRead(){readController?.abort();readController=new window.AbortController();routeSequence++;return readController;}
const validRead=(seq,controller)=>seq===routeSequence&&!controller.signal.aborted;
const accessLost=error=>error.status===401||['MFA_REQUIRED','OWNER_ACCESS_DENIED'].includes(error.code);
function showUnavailable(title,message){$('#main').innerHTML=unavailable(title,message);$('#main').setAttribute('aria-busy','false');}
function rememberAccess(data){
  access=api.rememberState(data);window.clearTimeout(expiryTimer);
  if(access.expiresAt!==null){const generation=authGeneration,deadline=access.expiresAt;const expire=()=>{
    if(generation!==authGeneration)return;
    const remaining=deadline-Date.now();
    if(remaining>0){expiryTimer=window.setTimeout(expire,Math.min(remaining,2147483647));return;}
    clearProtected();renderAccess('Your session has expired. Check your session to sign in again.');
  };expiryTimer=window.setTimeout(expire,Math.max(0,Math.min(deadline-Date.now(),2147483647)));}
  $('#logout-button').hidden=!managed||!['authenticated','mfa_required'].includes(access.state);
  $('#recovery-button').hidden=!managed||access.state!=='authenticated';
  return access;
}
function renderAccess(message=''){
  navigation();$('#main').setAttribute('aria-busy','false');$('#user-context').textContent='Not signed in';
  const phase=access?.state||'anonymous';let body,title='Sign-in required',subtitle='Owner access to your property workspace.';
  if(phase==='recovery_pending'){
    title='Recovery preparation';subtitle='Recovery requires authorized review before access can resume.';
    body='<div class="auth-guidance"><h2>Recovery prepared for review</h2><p>No recovery email or text message has been sent. No password or authenticator has been reset. Contact your authorized account operator to review the managed recovery procedure.</p></div>'+btn('Check session','refresh','primary');
  }else if(recoveryView){
    title='Prepare account recovery';subtitle='Prepare the managed recovery process for operator review.';
    body='<p class="auth-guidance">This prepares recovery guidance. It does not send an email, reset a password or bypass your authenticator. A current owner session will be signed out first.</p><form id="owner-recovery" class="auth-form"><div class="field"><label for="recovery-email">Email</label><input id="recovery-email" name="email" type="email" autocomplete="email" required></div><p id="access-error" role="alert" tabindex="-1"></p><button class="button primary" type="submit" '+(!api.csrfToken?'disabled':'')+'>Prepare recovery</button></form>'+btn('Back to sign in','access-back','subtle');
  }else if(phase==='mfa_required'){
    title='Verify your authenticator';subtitle='Owner access requires a verified authenticator code.';
    const factors=(access.factors||[]).filter(f=>f.status==='verified'),factorId=enrollment?.factorId||factors[0]?.id;
    body=(enrollment?'<div class="auth-enrollment"><h2>Set up your authenticator</h2><p>Scan this QR code with your authenticator app, then enter its six-digit code. Keep this setup code private.</p><img id="enrollment-qr" alt="Authenticator setup QR code" width="200" height="200"></div>':'')+
      (factorId?`<form id="owner-mfa" class="auth-form">${factors.length>1&&!enrollment?`<div class="field"><label for="factor-id">Authenticator</label><select id="factor-id" name="factorId">${factors.map((f,i)=>`<option value="${e(f.id)}">Authenticator ${i+1}</option>`).join('')}</select></div>`:`<input type="hidden" name="factorId" value="${e(factorId)}">`}<div class="field"><label for="verification-code">Verification code</label><input id="verification-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required aria-describedby="code-help"><small id="code-help">Enter the current six-digit code from your authenticator.</small></div><p id="access-error" role="alert" tabindex="-1"></p><button class="button primary" type="submit">Verify code</button></form>`:
      '<div class="auth-guidance"><p>Set up an authenticator to protect owner access. Property records stay locked until verification is complete.</p></div><p id="access-error" role="alert" tabindex="-1"></p>'+btn('Set up authenticator','mfa-enroll','primary'))+
      btn('Prepare account recovery','access-recovery','subtle');
  }else{
    body='<form id="owner-login" class="auth-form"><div class="field"><label for="owner-email">Email</label><input id="owner-email" name="email" type="email" autocomplete="username" required></div><div class="field"><label for="owner-password">Password</label><input id="owner-password" name="password" type="password" autocomplete="current-password" required></div><p id="access-error" role="alert" tabindex="-1"></p><button class="button primary" type="submit" '+(!api.csrfToken?'disabled':'')+'>Sign in</button></form><p class="auth-guidance">Access is limited to the configured owner. Partners and tenants do not have logins.</p>'+btn('Prepare account recovery','access-recovery','subtle');
  }
  $('#main').innerHTML=`<section class="panel owner-access"><span class="eyebrow">HAMDEE OWNER ACCESS</span><h1>${title}</h1><p class="auth-subtitle">${subtitle}</p>${message?`<p class="auth-notice" role="status">${e(message)}</p>`:''}${body}<div class="auth-footer">${btn('Check session','refresh','subtle')}</div></section>`;
  if(enrollment&&$('#enrollment-qr')){
    const url=enrollment.qrCodeDataUrl;
    if(typeof url==='string'&&url.length<=524288&&/^data:image\/(svg\+xml|png|jpeg|webp|gif)(;charset=utf-8|;utf8)?(;base64)?,/i.test(url))$('#enrollment-qr').src=url;
    else{$('#enrollment-qr').remove();showAccessError(new Error('The authenticator setup image is unavailable. Check your session before continuing.'));}
  }
}
function showAccessError(error){const target=$('#access-error');if(target){target.textContent=error.message+(error.code==='CSRF_REJECTED'?' Check your session, then submit again.':'');target.focus();}else showUnavailable('Unable to confirm access',error.message);}
function accountBusy(busy){document.querySelectorAll('.owner-access button,#recovery-button,.topbar [data-action="refresh"]').forEach(button=>button.disabled=busy||(!api.csrfToken&&button.type==='submit'));$('.owner-access')?.setAttribute('aria-busy',String(busy));}
async function showAccessLoss(error){
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
      enrollment=null;rememberAccess(result.data);
      if(action==='login'||action==='mfa/verify')window.history.replaceState(null,'',window.location.pathname+window.location.search+'#dashboard');
      authController=null;await boot();return;
    }
    const nextEnrollment=action==='mfa/enroll'?result.data.enrollment:null;
    if(action==='mfa/enroll'&&(!nextEnrollment||typeof nextEnrollment.factorId!=='string'||!nextEnrollment.factorId||typeof nextEnrollment.qrCodeDataUrl!=='string'))throw new Error('The service did not confirm authenticator setup. Check your session before trying again.');
    clearProtected();managed=true;recoveryView=false;rememberAccess(result.data);enrollment=nextEnrollment;renderAccess();
    if(access.state==='mfa_required')$('#verification-code')?.focus();else if(access.state==='anonymous')$('#owner-email')?.focus();
  }catch(error){
    if(generation!==authGeneration||controller.signal.aborted)return;
    if((action==='login'&&accessLost(error))||(action==='mfa/verify'&&error.code==='MFA_REQUIRED'))showAccessError(error);
    else if(accessLost(error))await showAccessLoss(error);
    else showAccessError(error);
  }finally{
    delete body.password;delete body.code;
    if(form?.isConnected)form.querySelectorAll('input[type="password"],input[name="code"]').forEach(input=>input.value='');
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
function navigation(){const route=(window.location.hash.slice(1)||'dashboard').split('/')[0];$('#navigation').innerHTML='<div class="nav-group">WORKSPACE</div>'+nav.map(([id,name,ico])=>`<a class="nav-link ${route===id?'active':''}" href="#${id}" ${route===id?'aria-current="page"':''}>${icon(ico)}<span>${e(name)}</span>${['dashboard','properties','tenants','collections','cheques','expenses','maintenance','reports'].includes(id)?'':'<small>Unavailable</small>'}</a>`).join('');$('#crumb').textContent=nav.find(n=>n[0]===route)?.[1]||'Property detail';}
async function boot(){
  clearProtected();recoveryView=false;managed=null;const controller=beginRead(),seq=routeSequence;navigation();$('#main').innerHTML='<div class="empty" role="status"><h2>Checking secure access…</h2></div>';$('#main').setAttribute('aria-busy','true');
  try{const result=await api.session(controller.signal);if(!validRead(seq,controller))return;
    try{const state=await api.authState(controller.signal);if(!validRead(seq,controller))return;managed=true;rememberAccess(state.data);if(access.state!=='authenticated'){renderAccess();return;}}
    catch(error){if(error.status!==404)throw error;managed=false;}
    if(!validRead(seq,controller))return;session=result.data;$('#user-context').innerHTML=`<strong>${e(session.name)}</strong><small>${managed?'Owner account':e(session.roles.join(' · '))}</small>`;
    $('#mode-detail').textContent=session.authenticationProvider==='automated-test'?'Automated test identity · Synthetic records only':'Authenticated property and rental records · Synthetic development';
    await render();
  }catch(error){if(!validRead(seq,controller))return;if(accessLost(error))await showAccessLoss(error);else{clearProtected();showUnavailable('Backend unavailable',error.message);}}
  finally{if(validRead(seq,controller))$('#main').setAttribute('aria-busy','false');}
}
function table(rows){return `<div class="table-wrap" tabindex="0" role="region" aria-label="Property records"><table class="data-table"><thead><tr><th scope="col">Property</th><th scope="col">Location</th><th scope="col">Record status</th><th scope="col">Revision</th><th scope="col">Updated</th></tr></thead><tbody>${rows.map(p=>`<tr><td><button class="record-name" data-action="detail" data-id="${e(p.id)}">${e(p.name)}</button><span class="record-sub">${e(p.id)}</span></td><td>${e(p.location||'Not provided')}</td><td><span class="badge ${p.lifecycleStatus==='archived'?'amber':'green'}">${e(p.lifecycleStatus)}</span></td><td>${p.version}</td><td>${e(date(p.updatedAt))}</td></tr>`).join('')}</tbody></table></div>`;}
async function render(){
  resetExpenses();resetRental();invalidateForm();const controller=beginRead(),seq=routeSequence;navigation();if(!session){if(access)renderAccess();else await boot();return;}$('#main').setAttribute('aria-busy','true');
  const route=window.location.hash.slice(1)||'dashboard',main=$('#main');
  main.innerHTML='<div class="empty" role="status"><h2>Loading authorized records…</h2></div>';
  try{
    if(route.startsWith('properties/')){
      const id=route.split('/')[1],result=await api.get(id,controller.signal);if(!validRead(seq,controller)||!await syncAccess(controller.signal)||!validRead(seq,controller))return;current=result.data;
      const p=current;main.innerHTML=heading(p.name,'Stable property identity · Metadata only',btn('Back to properties','back')+(can('update')&&p.lifecycleStatus!=='archived'?btn('Edit property','edit','primary'):'')+(can('archive')&&p.lifecycleStatus!=='archived'?btn('Archive','archive','danger'):'')+(can('restore')&&p.lifecycleStatus==='archived'?btn('Restore','restore','primary'):''))+
        `<section class="panel"><div class="detail-meta"><div><small>Internal ID</small><strong>${e(p.id)}</strong></div><div><small>Record lifecycle</small><strong>${e(p.lifecycleStatus)}</strong></div><div><small>Revision</small><strong>${p.version}</strong></div></div></section><div class="tabs"><button class="tab active" data-action="overview">Overview</button>${managed?'<button class="tab" data-action="rental">Rooms &amp; rentals</button>':''}${managed?'<button class="tab" data-action="property-expenses">Expenses &amp; maintenance</button>':''}${['Partners','Funding','Documents'].map(t=>`<button class="tab" disabled title="Not implemented in this slice">${t}</button>`).join('')}${can('audit')?'<button class="tab" data-action="audit">Audit history</button>':''}</div><section class="panel" id="detail-content"><div class="panel-header"><div><h2>Property metadata</h2><p>Archival changes record visibility only.</p></div></div><dl class="summary-list">${[['Name',p.name],['Location',p.location||'Not provided'],['Counterparty reference',p.counterpartyId||'Not assigned'],['Created',date(p.createdAt)],['Created by',p.createdBy],['Updated',date(p.updatedAt)],['Updated by',p.updatedBy],...(p.archivedAt?[['Archived',date(p.archivedAt)],['Archived by',p.archivedBy],['Archive reason',p.archiveReason]]:[])].map(([a,b])=>`<div><dt>${e(a)}</dt><dd>${e(b)}</dd></div>`).join('')}</dl></section>`;
    }else if(route==='dashboard'&&managed){
      const result=await api.dashboard(controller.signal);if(!validRead(seq,controller)||!await syncAccess(controller.signal)||!validRead(seq,controller))return;current=null;page=null;
      const d=result.data;
      main.innerHTML=heading('Property overview','Saved property metadata from your dedicated service.',can('create')?btn('Add property','create','primary'):'')+
        `<div class="metrics owner-metadata-metrics">${[['Total properties',d.totalProperties,'All saved records'],['Active properties',d.activeProperties,'Registered metadata records'],['Archived properties',d.archivedProperties,'History preserved']].map(([label,value,note])=>`<div class="metric"><div class="metric-top"><span>${label}</span>${icon('properties')}</div><div class="metric-value">${e(value)}</div><p class="metric-note">${note}</p></div>`).join('')}</div>`+
        `<section class="panel"><div class="panel-header"><div><h2>Recently updated properties</h2><p>Up to ten saved records · Newest updates first</p></div>${btn('View properties','back')}</div>${d.recentProperties.length?table(d.recentProperties):'<div class="empty"><h2>No authorized properties</h2><p>Add your first property to begin your register.</p></div>'}</section>`+
        `<div class="metrics owner-metadata-metrics">${['Property profit','Partner returns','Company income'].map(label=>`<div class="metric"><div class="metric-top"><span>${label}</span></div><div class="metric-value unavailable-metric">Unavailable</div><p class="metric-note">Financial module not enabled</p></div>`).join('')}</div>`;
      const rentalTarget=document.createElement('div');rentalTarget.id='rental-dashboard';main.append(rentalTarget);
      const expenseTarget=document.createElement('div');expenseTarget.id='expense-dashboard';main.append(expenseTarget);
      const expenseOptions={api,summaryOnly:true,followRentalPeriod:true,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss};
      await renderRentalDashboard(rentalTarget,{api,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss,onReportChange:period=>renderExpenses(expenseTarget,{...expenseOptions,period})});
      if(validRead(seq,controller))await renderExpenses(expenseTarget,{...expenseOptions,period:rentalReportPeriod()});
    }else if(['expenses','maintenance','reports'].includes(route)&&managed){
      current=null;page=null;main.innerHTML=heading(route==='reports'?'Monthly property report':route==='maintenance'?'Property maintenance':'Property expenses','Saved property costs and payments. Synthetic development only.')+'<div id="expense-workspace"></div>';
      await renderExpenses($('#expense-workspace'),{api,summaryOnly:route==='reports',signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss});
    }else if(['tenants','collections','cheques'].includes(route)&&managed){
      current=null;page=null;main.innerHTML=heading(route==='tenants'?'Rooms, tenants & agreements':route==='cheques'?'Cheque register':'Rent collections','Saved room-level records. Synthetic development only.')+'<div id="rental-workspace"></div>';
      await renderRental($('#rental-workspace'),{api,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss});
    }else if(route==='dashboard'||route==='properties'){
      const result=await api.list(filters,controller.signal);if(!validRead(seq,controller)||!await syncAccess(controller.signal)||!validRead(seq,controller))return;page=result;current=null;
      main.innerHTML=heading(route==='dashboard'?'Property overview':'Properties','Authenticated records from the dedicated property service.',can('create')?btn('Add property','create','primary'):'')+
        (route==='dashboard'?`<div class="metrics"><div class="metric"><div class="metric-top"><span>Properties on this page</span>${icon('properties')}</div><div class="metric-value">${result.data.length}</div><p class="metric-note">Authorized records · Current filters</p></div>${['Rental income','Partner returns','Company income'].map(t=>`<div class="metric"><div class="metric-top"><span>${t}</span></div><div class="metric-value unavailable-metric">Unavailable</div><p class="metric-note">Financial module not enabled</p></div>`).join('')}</div>`:'')+
        `<section class="panel"><div class="panel-header"><div><h2>Property register</h2><p>No rental, funding or ownership terms are inferred.</p></div></div><form id="filters" class="toolbar"><label class="search-field">${icon('search')}<input name="q" aria-label="Search properties" placeholder="Search name or location…" value="${e(filters.q)}" maxlength="200"></label><select name="archiveState" class="filter-select" aria-label="Record status">${[['active','Active records'],['archived','Archived records'],['all','All records']].map(([v,l])=>`<option value="${v}" ${filters.archiveState===v?'selected':''}>${l}</option>`).join('')}</select><button class="button subtle" type="submit">Apply filters</button></form>${result.data.length?table(result.data):'<div class="empty"><h2>No authorized properties</h2><p>Create your first basic property or ask an administrator to assign access.</p></div>'}<div class="table-foot"><span>${result.data.length} records on this page</span>${result.nextCursor?btn('Next page','next'):''}${filters.cursor?btn('First page','first'):''}</div></section>`;
    }else{main.innerHTML=heading(nav.find(n=>n[0]===route)?.[1]||'Unavailable','This module is outside the current property-foundation slice.')+unavailable('Module unavailable','The existing demo remains separate. This development workspace does not use sample financial data or simulate operational actions.');}
  }catch(error){if(!validRead(seq,controller))return;if(accessLost(error))await showAccessLoss(error);else showUnavailable(error.status===404?'Property unavailable':error.status===403?'Access restricted':'Unable to load records',error.message);}
  finally{if(validRead(seq,controller))main.setAttribute('aria-busy','false');}
}
function dialog(action){
  trigger=document.activeElement;formContext={action,property:current?{...current}:null};pending=null;
  const p=formContext.property;$('#dialog-title').textContent=action==='create'?'Add property':action==='update'?'Edit property':action==='archive'?'Archive property':'Restore property';
  $('#dialog-subtitle').textContent=['archive','restore'].includes(action)?'Preserve identity and history. This does not close a tenancy or financial period.':'Basic metadata only. Financial settings are not part of this form.';
  $('#dialog-body').innerHTML=['archive','restore'].includes(action)?`<div class="field"><label for="reason">Reason</label><textarea id="reason" name="reason" required maxlength="500"></textarea></div>`:`<div class="form-grid"><div class="field wide"><label for="name">Property name</label><input id="name" name="name" value="${e(p?.name||'')}" required maxlength="200"></div><div class="field wide"><label for="location">Location / address (optional)</label><textarea id="location" name="location" maxlength="500">${e(p?.location||'')}</textarea></div><div class="field wide"><label for="counterpartyId">External counterparty reference (optional)</label><input id="counterpartyId" name="counterpartyId" value="${e(p?.counterpartyId||'')}" placeholder="Existing authorized reference UUID"><small>Detailed counterparty relationships remain pending approval.</small></div></div>`;
  $('#form-error').textContent='';$('#conflict-review').innerHTML='';$('#save-button').textContent=action==='archive'?'Confirm archive':action==='restore'?'Restore property':'Save property';$('#dialog').showModal();
}
function closeDialog(){if($('#save-button').disabled)return;$('#dialog').close();formContext=null;pending=null;trigger?.focus();}
document.addEventListener('submit',async event=>{
  if(['owner-login','owner-mfa','owner-recovery'].includes(event.target.id)){
    event.preventDefault();const form=event.target,body=Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[type="password"],input[name="code"]').forEach(input=>input.value='');
    await runAccount(form.id==='owner-login'?'login':form.id==='owner-mfa'?'mfa/verify':'recovery',body,form);return;
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
  const target=event.target.closest('[data-action]');if(!target)return;const action=target.dataset.action;
  if(action==='logout'){await logout();return;}
  if(action==='mfa-enroll'){await runAccount('mfa/enroll');return;}
  if(action==='refresh-proof'){await refreshProof();return;}
  if(action==='access-recovery'){
    if(authController)return;const state=access;clearProtected();if(state){managed=true;rememberAccess(state);}recoveryView=true;renderAccess();$('#recovery-email')?.focus();return;
  }
  if(action==='access-back'){recoveryView=false;await boot();return;}
  if(action==='nav-open'){$('#sidebar').classList.add('open');target.setAttribute('aria-expanded','true');return;}
  if(action==='nav-close'){$('#sidebar').classList.remove('open');$('.mobile-menu').setAttribute('aria-expanded','false');$('.mobile-menu').focus();return;}
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
    if(!current||!managed)return;const controller=beginRead(),seq=routeSequence,p=current;
    document.querySelectorAll('.tabs .tab').forEach(tab=>tab.classList.toggle('active',tab===target));
    await renderExpenses($('#detail-content'),{api,property:p,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss});return;
  }
  if(action==='rental'){
    if(!current||!managed)return;const controller=beginRead(),seq=routeSequence,p=current;
    document.querySelectorAll('.tabs .tab').forEach(tab=>tab.classList.toggle('active',tab===target));
    await renderRental($('#detail-content'),{api,property:p,signal:controller.signal,isCurrent:()=>validRead(seq,controller),verifyAccess:()=>syncAccess(controller.signal),onAccessLoss:showAccessLoss});return;
  }
  if(action==='audit'){
    if(!current)return;const id=current.id,controller=beginRead(),seq=routeSequence;
    document.querySelectorAll('.tabs .tab').forEach(tab=>tab.classList.toggle('active',tab===target));
    try{const result=await api.audit(id,'',controller.signal);if(current?.id!==id||!validRead(seq,controller)||!await syncAccess(controller.signal)||!validRead(seq,controller))return;$('#detail-content').innerHTML=`<div class="panel-header"><div><h2>Audit history</h2><p>Attributed metadata changes · No confidential payload dumps</p></div></div><div class="table-wrap" tabindex="0" role="region" aria-label="Property audit history"><table class="data-table"><thead><tr><th scope="col">Revision</th><th scope="col">Action</th><th scope="col">Actor</th><th scope="col">Reason</th><th scope="col">Time</th></tr></thead><tbody>${result.data.map(a=>`<tr><td>${a.version}</td><td>${e(a.action)}</td><td>${e(a.actorId)}</td><td>${e(a.reason||'—')}</td><td>${e(date(a.occurredAt))}</td></tr>`).join('')}</tbody></table></div>${result.nextCursor?'<p class="muted-help">More history is available through the paginated API.</p>':''}`;}catch(error){if(!validRead(seq,controller))return;if(accessLost(error))await showAccessLoss(error);else $('#detail-content').innerHTML=unavailable('Audit unavailable',error.message);}return;
  }
  if(action==='overview')await render();
});
$('#dialog').addEventListener('cancel',event=>{if($('#save-button').disabled)event.preventDefault();});
window.addEventListener('hashchange',()=>{$('#sidebar').classList.remove('open');$('.mobile-menu').setAttribute('aria-expanded','false');if(!authController||authController.signal.aborted)void render();});
void boot();
