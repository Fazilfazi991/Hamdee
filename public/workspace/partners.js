// Isolated owner workspace. Coordinator supplies verified API/session callbacks;
// this module registers no route, reads no browser storage and seeds no records.
// API: partnerRead(query, signal) -> {data: overview};
// partnerWrite(body, idempotencyKey, signal) -> committed result.
import {esc,table,panel,field as sharedField,select as sharedSelect} from './rental.js';
const today=()=>new Date().toISOString().slice(0,10);
const field=(name,label,type='text',value='',required=true,extra='')=>sharedField(name,label,type,value,required,extra,'partner');
const select=(name,label,values,selected='',required=true)=>sharedSelect(name,label,values,selected,required,'partner');
const button=(label,action,id='',primary=false)=>`<button type="button" class="button ${primary?'primary':'subtle'}" data-partner-action="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
// Owner intent: record and review property-linked contributions in the existing
// compact HAMDEE ledger. White panels, brass actions, Inter and native dialogs
// preserve its hierarchy and 4px rhythm; no new theme or motion is introduced.
const note='Recorded movements are not profit or available cash. Company and personal accounts are not posted automatically. Currencies remain separate.';
const money=(amount,currency)=>`${esc(currency)} ${esc(amount)}`;
let context=null,generation=0;
const alive=c=>context===c&&c.generation===generation&&!c.local.signal.aborted&&!c.signal.aborted&&c.isCurrent();
function message(error){return error.status&&error.status<500?error.message:'The operation could not be confirmed. Retry the same submission.';}
export function resetPartners(){
  generation++;const c=context;context=null;if(!c)return;c.local.abort();c.writer?.abort();
  c.dialog?.close();c.dialog?.remove();c.state=null;
  if(c.target.dataset.partnerWorkspace===String(c.generation)){c.target.replaceChildren();delete c.target.dataset.partnerWorkspace;}
}
async function accessLoss(c,error){if(context===c){resetPartners();await c.onAccessLoss(error);}}
async function verified(c){if(!alive(c))return false;const allowed=await c.verifyAccess();if(!alive(c))return false;if(!allowed){await accessLoss(c,{status:401,message:'Sign in with the authorized owner account.'});return false;}return true;}
export async function renderPartners(target,options){
  resetPartners();
  const c={...options,target,generation,local:new window.AbortController(),sequence:0,state:null,writer:null,dialog:null,
    report:{month:today().slice(0,7),asOf:today(),propertyId:options.property?.id||'',partnerId:'',...options.period},entryCursor:'',partnerCursor:'',contacts:new Map(),properties:options.properties||[]};
  context=c;target.dataset.partnerWorkspace=String(generation);
  if(c.signal.aborted){resetPartners();return;}
  c.signal.addEventListener('abort',()=>{if(context===c)resetPartners();},{once:true,signal:c.local.signal});
  target.addEventListener('click',event=>click(c,event),{signal:c.local.signal});
  target.addEventListener('submit',event=>filter(c,event),{signal:c.local.signal});
  await load(c);
}
async function load(c){
  const sequence=++c.sequence;c.target.innerHTML='<div class="empty" role="status">Loading saved partner records…</div>';
  try{
    const query={month:c.report.month,asOf:c.report.asOf,...(c.report.propertyId?{propertyId:c.report.propertyId}:{}),...(c.report.partnerId?{partnerId:c.report.partnerId}:{}),
      ...(c.entryCursor?{entryCursor:c.entryCursor,recordedThrough:c.recordedThrough}:{}),limit:100};
    const primary=c.api.partnerRead(query,c.local.signal),needsCatalog=Boolean(c.report.propertyId||c.report.partnerId||c.entryCursor||c.partnerCursor);
    const catalogRead=needsCatalog?c.api.partnerRead({month:c.report.month,asOf:c.report.asOf,limit:100,...(c.partnerCursor?{partnerCursor:c.partnerCursor}:{})},c.local.signal):primary;
    const propertyRead=c.properties.length||c.property||!c.api.list?Promise.resolve(c.properties):loadProperties(c);
    const [read,catalog,properties]=await Promise.all([primary,catalogRead,propertyRead]);
    if(!alive(c)||sequence!==c.sequence||!await verified(c)||!alive(c)||sequence!==c.sequence)return;
    c.data=read.data;c.catalog=catalog.data;c.properties=properties;c.recordedThrough=c.data.recordedThrough;
    for(const contact of [...c.data.partners,...c.catalog.partners])c.contacts.set(contact.id,contact);
    paint(c);
  }catch(error){if(!alive(c)||sequence!==c.sequence)return;if([401,403].includes(error.status))await accessLoss(c,error);else c.target.innerHTML=panel('Partner records unavailable',esc(message(error)),button('Retry loading','retry'));}
}
async function loadProperties(c){
  const rows=[],seen=new Set();let cursor='';
  do{const result=await c.api.list({archiveState:'all',q:'',limit:100,cursor},c.local.signal);if(!alive(c))return [];rows.push(...result.data);cursor=result.nextCursor||'';
    if(cursor&&seen.has(cursor))throw new Error('The property register repeated a page. Retry loading.');seen.add(cursor);
  }while(cursor);return rows;
}
function paint(c){
  const property=id=>c.properties.find(p=>p.id===id)?.name||id;
  const partner=id=>c.data.partnerLabels?.[id]||c.contacts.get(id)?.name||id;
  const historyDetail=event=>{const r=event.detail.record;return event.action==='record-entry'?[r.kind,`${r.currency} ${r.amount}`,r.entry_date,r.reference,r.notes,event.detail.legitimateRepeat?'Separate legitimate repeat confirmed':''].filter(Boolean).map(esc).join('<br>'):event.action==='correct-entry'?[r.replacement_entry_id?'Original retained and replaced':'Original retained and voided',r.reason].map(esc).join('<br>'):event.action==='link-property'?esc(r.notes||'Property association recorded'):[`Contact revision ${r.version}`,r.name,r.phone,r.email,r.notes].filter(Boolean).map(esc).join('<br>');};
  const properties=c.properties.map(p=>[p.id,p.name]);
  const choices=[...c.contacts.values()].map(p=>[p.id,p.name]);if(c.report.partnerId&&!choices.some(([id])=>id===c.report.partnerId))choices.push([c.report.partnerId,partner(c.report.partnerId)]);
  const filterSelect=(name,label,values,selected,all)=>`<label>${esc(label)}<select name="${name}"><option value="">${all}</option>${values.map(([id,name])=>`<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(name)}</option>`).join('')}</select></label>`;
  const filters=`<form class="toolbar rental-filters" data-partner-filter><label>Movement month<input name="month" type="month" required value="${esc(c.report.month)}"></label><label>Through date<input name="asOf" type="date" required value="${esc(c.report.asOf)}"></label>${c.property?'':filterSelect('propertyId','Property',properties,c.report.propertyId,'All properties')}${filterSelect('partnerId','Partner statement',choices,c.report.partnerId,'All partners')}<button class="button subtle" type="submit">Apply statement filters</button></form>`;
  const styles=`<style>
    [data-partner-workspace] .partner-help{padding:16px 20px;color:var(--muted);font-size:12px;line-height:1.7;overflow-wrap:anywhere}
    [data-partner-workspace] .data-table td{overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
    [data-partner-workspace] .head-actions{flex-wrap:wrap}
    .partner-record-dialog{max-width:min(680px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:hidden}
    .partner-record-dialog>form{display:flex;flex-direction:column;max-height:calc(100dvh - 32px)}
    .partner-record-dialog .dialog-header,.partner-record-dialog footer,.partner-record-dialog [role=alert],.partner-record-dialog [data-partner-conflict]{flex-shrink:0}
    .partner-record-dialog .rental-dialog-body{min-height:0;max-height:none;overflow:auto;flex:1 1 auto}
    .partner-record-dialog footer{display:flex;flex-wrap:wrap;gap:12px;padding:20px;justify-content:flex-end}
    .partner-record-dialog [role=alert]{color:var(--rose);padding:0 24px;overflow-wrap:anywhere}
    .partner-record-dialog .partner-help{padding:12px 24px;color:var(--muted);font-size:12px;line-height:1.7}
    .partner-record-dialog .field input,.partner-record-dialog .field select{min-height:44px}
    .partner-record-dialog .field{min-width:0}.partner-record-dialog .form-grid{padding:20px}.partner-record-dialog button{min-height:44px}
    @media(max-width:600px){.partner-record-dialog .form-grid{grid-template-columns:1fr}[data-partner-workspace] .rental-filters{align-items:stretch}}
  </style>`;
  c.target.innerHTML=styles+`<p class="partner-help">${note}</p><p id="partner-feedback" class="partner-help" role="status"></p>`+filters+
    panel(c.report.partnerId?'Partner statement':'Monthly partner movements',`Movements through ${esc(c.data.through)}. Refresh to include newly recorded entries.`,
      table(['Property','Partner','Currency','Before this month: contributions','Before this month: withdrawals','This month: contributions','This month: withdrawals','Through date: contributions','Through date: withdrawals','Net recorded movements'],
        c.data.summary.map(r=>[esc(property(r.propertyId)),esc(partner(r.partnerId)),esc(r.currency),...['openingContributions','openingWithdrawals','monthContributions','monthWithdrawals','contributionsToDate','withdrawalsToDate','recordedNet'].map(k=>esc(r[k]))]),'Property-specific partner statement'),button('Download monthly summary','download'))+
    panel('Currency totals','Recorded movements only, within the selected property/partner filters.',table(['Currency','This month: contributions','This month: withdrawals','Through date: contributions','Through date: withdrawals','Net recorded movements'],c.data.currencies.map(r=>[esc(r.currency),...['monthContributions','monthWithdrawals','contributionsToDate','withdrawalsToDate','recordedNet'].map(k=>esc(r[k]))]),'Separate currency totals'))+
    panel('Partner contacts','Contacts are business records without logins. Similar names remain separate identities.',table(['Partner','Phone','Email','Notes','Revision','Actions'],c.catalog.partners.map(p=>[esc(p.name),esc(p.phone||'—'),esc(p.email||'—'),esc(p.notes||'—'),esc(p.version),button('Edit contact','update-partner',p.id)]),'Partner contact register')+
      `<div class="table-foot"><span>Contact page — use the next page for additional contact choices.</span>${c.catalog.nextPartnerCursor?button('Next contacts','next-contacts'):''}${c.partnerCursor?button('First contacts','first-contacts'):''}</div>`,button('Add partner contact','create-partner','',true))+
    panel('Property links','A link identifies the project association. It creates no share, entitlement or automatic allocation.',table(['Property','Partner','Linked','Notes'],c.data.links.map(l=>[esc(property(l.propertyId)),esc(partner(l.partnerId)),esc(l.createdAt),esc(l.notes||'—')]),'Partner property links'),button('Link partner to property','link-property'))+
    panel('Contribution and withdrawal history','Original entries are preserved. Statements use effective entries only; corrections retain their reason and replacement link.',
      table(['Movement date','Property','Partner','Type','Amount','Reference','Notes','Recorded','Status / correction'],c.data.entries.map(e=>[esc(e.entryDate),esc(property(e.propertyId)),esc(partner(e.partnerId)),esc(e.kind),money(e.amount,e.currency),esc(e.reference||'—'),esc(e.notes||'—'),esc(e.recordedAt),e.effective===false?'Corrected · Original retained':button('Void entry','void-entry',e.id)+button('Replace entry','replace-entry',e.id)]),'Partner movement history')+
      `<div class="table-foot"><span>${c.data.entries.length} entries on this page</span>${c.data.nextEntryCursor?button('Next entries','next-entries'):''}${c.entryCursor?button('First entries','first-entries'):''}</div>`,button('Record contribution / withdrawal','record-entry','',true))+
    panel('Change history','Previous contact details, property links and recorded movements remain available.',table(['Action','Partner','Property','Recorded details','Recorded'],c.data.history.map(e=>[esc(({'create-partner':'Contact added','update-partner':'Contact updated','link-property':'Property linked','record-entry':'Movement recorded','correct-entry':'Entry corrected'})[e.action]||e.action),esc(partner(e.partnerId)),esc(e.propertyId?property(e.propertyId):'Contact record'),historyDetail(e),esc(e.occurredAt)]),'Partner change history')+(c.data.historyHasMore?'<p class="partner-help">Showing the most recent changes. More contribution and withdrawal entries are available above.</p>':''));
}
async function click(c,event){
  const trigger=event.target.closest('[data-partner-action]');if(!trigger||!alive(c))return;const action=trigger.dataset.partnerAction;
  if(action==='retry'){await load(c);return;}
  if(action==='next-contacts'||action==='first-contacts'){c.partnerCursor=action==='next-contacts'?c.catalog.nextPartnerCursor:'';await load(c);return;}
  if(action==='next-entries'||action==='first-entries'){c.entryCursor=action==='next-entries'?c.data.nextEntryCursor:'';await load(c);return;}
  if(action==='download'){download(c);return;}
  open(c,action,trigger.dataset.id,trigger);
}
async function filter(c,event){
  if(!event.target.matches('[data-partner-filter]')||!alive(c))return;event.preventDefault();
  c.report={...c.report,...Object.fromEntries(new FormData(event.target))};c.entryCursor='';await load(c);
}
function close(c){if(c.writer)return;const trigger=c.state?.trigger;c.dialog?.close();c.dialog?.remove();c.dialog=null;c.state=null;trigger?.focus();}
function open(c,action,id,trigger){
  if(c.writer)return;close(c);const contact=c.catalog.partners.find(p=>p.id===id);
  const active=c.properties.filter(p=>p.lifecycleStatus==='registered'),partners=[...c.contacts.values()].map(p=>[p.id,p.name]);
  let body,title;const hidden={};
  if(action==='create-partner'||action==='update-partner'){
    if(action==='update-partner'&&!contact)return;title=contact?'Edit partner contact':'Add partner contact';
    if(contact)Object.assign(hidden,{partnerId:contact.id,expectedVersion:contact.version});
    body=field('name','Partner name','text',contact?.name||'',true,'maxlength="200"')+field('phone','Phone (optional)','tel',contact?.phone||'',false,'maxlength="60"')+field('email','Email (optional)','email',contact?.email||'',false,'maxlength="254"')+field('notes','Notes (optional)','text',contact?.notes||'',false,'maxlength="2000"');
  }else if(action==='link-property'||action==='record-entry'){
    title=action==='link-property'?'Link partner to property':'Record contribution / withdrawal';
    body=select('propertyId','Property',active.map(p=>[p.id,p.name]),c.report.propertyId)+select('partnerId','Partner',partners,c.report.partnerId);
    if(action==='record-entry')body+=select('kind','Recorded movement',[['contribution','Contribution'],['withdrawal','Withdrawal']])+
      field('entryDate','Movement date','date','')+field('amount','Exact recorded amount','text','',true,'inputmode="decimal" pattern="[0-9]{1,18}(\\.[0-9]{1,12})?"')+
      field('currency','Explicit currency code','text','',true,'pattern="[A-Z]{3}" maxlength="3" placeholder="e.g. QAR"')+
      field('reference','Reference (optional)','text','',false,'maxlength="200"');
    body+=field('notes','Notes (optional)','text','',false,'maxlength="2000"');
  }else if(action==='void-entry'||action==='replace-entry'){
    const entry=c.data.entries.find(e=>e.id===id);if(!entry||entry.effective===false)return;const replace=action==='replace-entry';title=replace?'Replace recorded movement':'Void recorded movement';action='correct-entry';
    Object.assign(hidden,{entryId:entry.id,replacement:replace?true:null});
    body=`<p class="partner-help">Original retained: ${esc(entry.kind)} · ${esc(entry.entryDate)} · ${money(entry.amount,entry.currency)} · ${esc(entry.reference||'No reference')}. ${replace?'The replacement uses this same property and partner.':'This removes its effect from a refreshed statement without creating an opposite movement.'}</p>`+
      field('reason','Correction reason','text','',true,'maxlength="2000"');
    if(replace)body+=select('kind','Correct movement type',[['contribution','Contribution'],['withdrawal','Withdrawal']],entry.kind)+field('entryDate','Correct movement date','date',entry.entryDate)+field('amount','Correct recorded amount','text',entry.amount,true,'inputmode="decimal"')+field('currency','Correct currency code','text',entry.currency,true,'pattern="[A-Z]{3}" maxlength="3"')+field('reference','Correct reference (optional)','text',entry.reference||'',false,'maxlength="200"')+field('notes','Correct notes (optional)','text',entry.notes||'',false,'maxlength="2000"');
  }else return;
  const d=document.createElement('dialog');d.className='partner-record-dialog';d.setAttribute('aria-labelledby','partner-dialog-title');
  d.innerHTML=`<form data-partner-write><header class="dialog-header"><div><span class="eyebrow">HAMDEE PARTNER RECORDS</span><h2 id="partner-dialog-title">${title}</h2></div><button type="button" class="icon-button" data-partner-close aria-label="Close partner form">×</button></header><div class="rental-dialog-body"><p class="partner-help">${action==='record-entry'?note+' Link the partner to this property first. Amounts are stored exactly without rounding; no default currency.':'Saved record changes retain history. This creates no login or financial entitlement.'}</p><div class="form-grid">${body}</div></div><p data-partner-error role="alert" tabindex="-1"></p><div data-partner-conflict></div><footer><button class="button subtle" type="button" data-partner-close>Cancel</button><button class="button primary" type="submit">Save partner record</button></footer></form>`;
  c.dialog=d;c.state={action,hidden,trigger,pending:null};document.body.append(d);d.showModal();
  d.addEventListener('cancel',event=>{event.preventDefault();close(c);},{signal:c.local.signal});
  d.addEventListener('click',event=>{if(event.target.closest('[data-partner-close]'))close(c);},{signal:c.local.signal});
  d.addEventListener('submit',event=>save(c,event),{signal:c.local.signal});
}
async function save(c,event){
  event.preventDefault();if(!alive(c)||c.writer||!c.state)return;const state=c.state;
  let body={action:state.action,...state.hidden,...Object.fromEntries(new FormData(event.target))};
  if(state.action==='correct-entry'){
    const fields=Object.fromEntries(new FormData(event.target));body={action:state.action,entryId:state.hidden.entryId,reason:fields.reason,replacement:state.hidden.replacement===null?null:{kind:fields.kind,entryDate:fields.entryDate,amount:fields.amount,currency:fields.currency,reference:fields.reference,notes:fields.notes},...(fields.legitimateRepeat?{legitimateRepeat:fields.legitimateRepeat==='true'}:{})};
  }else if('legitimateRepeat' in body)body.legitimateRepeat=body.legitimateRepeat==='true';
  if(state.pending?.uncertain)body=state.pending.body;
  const signature=JSON.stringify(body);if(state.pending?.signature!==signature)state.pending={body,key:crypto.randomUUID(),signature,uncertain:false};
  const controller=new window.AbortController();c.writer=controller;const submit=event.target.querySelector('[type=submit]'),error=event.target.querySelector('[data-partner-error]');submit.disabled=true;error.textContent='';
  try{
    await c.api.partnerWrite(state.pending.body,state.pending.key,controller.signal);
    if(!alive(c)||c.state!==state||controller.signal.aborted||!await verified(c)||!alive(c))return;
    c.writer=null;close(c);c.entryCursor='';await load(c);if(alive(c)){const feedback=c.target.querySelector('#partner-feedback');if(feedback)feedback.textContent='Partner record saved.';c.target.querySelector(`[data-partner-action="${state.action}"]`)?.focus();}
  }catch(cause){
    if(!alive(c)||c.state!==state||controller.signal.aborted)return;
    if(cause.code==='CSRF_REJECTED'){
      state.needsProof=true;error.textContent='Session verification expired. Verify your session, then save this draft explicitly.';error.focus();
      const region=event.target.querySelector('[data-partner-conflict]');region.replaceChildren();const verify=document.createElement('button');verify.type='button';verify.className='button subtle';verify.textContent='Verify session';region.append(verify);
      verify.addEventListener('click',async()=>{verify.disabled=true;try{if(!await verified(c)||c.state!==state)return;state.needsProof=false;submit.disabled=false;region.replaceChildren();error.textContent='Session verification renewed. Review your draft, then save explicitly.';}catch(failure){if(!alive(c))return;error.textContent=message(failure);verify.disabled=false;}},{signal:c.local.signal});return;
    }
    if(cause.code==='DUPLICATE_PARTNER_ENTRY'){
      const region=event.target.querySelector('[data-partner-conflict]');
      if(!region.querySelector('[name="legitimateRepeat"]'))region.innerHTML='<label class="operations-confirmation"><input type="checkbox" name="legitimateRepeat" value="true"> I confirm this is a separate legitimate movement with the same details.</label>';
      error.textContent=cause.message+' Review the existing history. Confirm the separate movement only when appropriate, then save explicitly.';error.focus();return;
    }
    if([401,403].includes(cause.status)){await accessLoss(c,cause);return;}
    state.pending.uncertain=!!cause.uncertain||!cause.status||cause.status>=500;
    event.target.querySelectorAll('input,select').forEach(input=>input.disabled=state.pending.uncertain);
    error.textContent=message(cause)+(state.pending.uncertain?' Save again to confirm this exact submission.':'');error.focus();
    if(cause.status===412){
      const region=event.target.querySelector('[data-partner-conflict]');region.replaceChildren();const review=document.createElement('button');review.type='button';review.className='button subtle';review.textContent='Review current contact revision';region.append(review);
      review.addEventListener('click',async()=>{
        review.disabled=true;try{
          const current=await c.api.partnerRead({month:c.report.month,asOf:c.report.asOf,partnerId:state.hidden.partnerId,limit:1},c.local.signal);
          if(!alive(c)||c.state!==state||!await verified(c)||!alive(c))return;const latest=current.data.partners[0];
          if(!latest)throw Object.assign(new Error('Partner not found.'),{status:404});
          region.replaceChildren();const comparison=document.createElement('p');comparison.className='partner-help';comparison.textContent=`Current revision ${latest.version}: ${latest.name} · ${latest.phone||'No phone'} · ${latest.email||'No email'}. Your draft is retained. Review before using this revision.`;region.append(comparison);
          const use=document.createElement('button');use.type='button';use.className='button subtle';use.textContent='Use current revision for this draft';region.append(use);
          use.addEventListener('click',()=>{if(!alive(c)||c.state!==state)return;state.hidden.expectedVersion=latest.version;state.pending=null;region.textContent='Current revision selected. Review your draft, then Save partner record.';},{once:true});
        }catch(cause){if(!alive(c)||c.state!==state)return;if([401,403].includes(cause.status))await accessLoss(c,cause);else{error.textContent=message(cause);review.disabled=false;}}
      },{signal:c.local.signal});
    }
  }finally{if(c.writer===controller)c.writer=null;if(submit.isConnected)submit.disabled=Boolean(state.needsProof);}
}
function download(c){
  const property=id=>c.properties.find(p=>p.id===id)?.name||id,partner=id=>c.data.partnerLabels?.[id]||c.contacts.get(id)?.name||id;
  const headers=['Property','Partner','Currency','Before this month: contributions','Before this month: withdrawals','This month: contributions','This month: withdrawals','Through date: contributions','Through date: withdrawals','Net recorded movements (not profit or available cash)','Through date','Statement prepared through'];
  const rows=c.data.summary.map(r=>[property(r.propertyId),partner(r.partnerId),r.currency,...['openingContributions','openingWithdrawals','monthContributions','monthWithdrawals','contributionsToDate','withdrawalsToDate','recordedNet'].map(k=>r[k]),c.data.through,c.data.recordedThrough]);
  const cell=value=>{let s=String(value??'');if(/^[\s]*[=+@-]/.test(s)&&! /^-?\d+(\.\d+)?$/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const blob=new window.Blob(['\ufeff'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=window.URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`HAMDEE-partner-records-${c.report.month}.csv`;a.click();window.setTimeout(()=>window.URL.revokeObjectURL(url),0);
}
