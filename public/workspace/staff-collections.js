// Owner-managed collector/custody workspace. HTTP binding waits for the frozen
// backend contract; an unavailable module never supplies seed money or writes.
import { table,panel } from './rental.js';
let generation=0,dialogState=null,writeController=null,workspaceContext=null,readController=null;
const today=()=>new Date().toISOString().slice(0,10);
let period={month:today().slice(0,7),asOf:today(),collectorId:''};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const field=(name,label,value='',type='text',required=true,extra='')=>`<div class="field"><label for="staff-${name}">${label}</label><input id="staff-${name}" name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${extra}></div>`;
const select=(name,label,options,value='',required=true)=>`<div class="field"><label for="staff-${name}">${label}</label><select id="staff-${name}" name="${name}" ${required?'required':''}><option value="">Choose…</option>${options.map(([id,text])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(text)}</option>`).join('')}</select></div>`;
const notes=value=>field('notes','Notes (optional)',value,'text',false,'maxlength="1000"');
const confirmation=(name,label)=>`<div class="field wide"><label class="operations-confirmation"><input type="checkbox" name="${name}" value="true" required> ${label}</label></div>`;
const receiptKey=row=>`${row.kind}:${row.id}`;
const receiptOptions=rows=>rows.filter(row=>!row.linked).map(row=>[receiptKey(row),`${[row.propertyLabel,row.roomLabel,row.customerLabel,row.classification].filter(Boolean).join(' · ')} · ${row.date} · ${row.currency} ${row.amount} · ${row.method} · ${row.id}`]);
const mergeReceipts=(previous,incoming)=>[...new Map([...previous,...incoming].map(row=>[receiptKey(row),row])).values()];
function receiptPage(result,asOf){
  const page=result?.data,nextCursor=page?.nextCursor??null;
  if(page?.moneyUnit!=='decimal-major-unit-strings'||!Array.isArray(page.data)||page.asOf!==asOf||typeof page.hasMore!=='boolean'||(nextCursor!==null&&(typeof nextCursor!=='string'||!nextCursor))||page.hasMore!==Boolean(nextCursor))throw new Error('Unsupported receipt page. Your loaded choices are retained; check the service before loading more.');
  return {...page,nextCursor};
}
const receiptStatus=(receipts,paging)=>`${receipts.length} receipt records loaded; ${receipts.filter(row=>!row.linked).length} eligible to link. ${paging.hasMore?'More receipts are available.':'All receipts loaded for this cutoff.'}`;

// Frozen v1 command field preparation. Controls are exposed only after the
// Coordinator confirms the overview envelope and money representation.
export function staffCommandForm(action,record={},choices={collectors:[],receipts:[],accounts:[]}){
  const collectors=choices.collectors.map(row=>[row.id,row.name]);
  const accounts=choices.accounts.filter(row=>row.scope==='company').map(row=>[row.id,`${row.name} · ${row.kind} · ${row.currency}`]);
  const collector=()=>select('collectorId','Collector',collectors,record.collectorId);
  const account=(required=true)=>select('accountId','Company cash / bank account',accounts,record.accountId,required);
  const amount=()=>field('amount','Handover amount',record.amount||'','text',true,'inputmode="decimal" pattern="[0-9]{1,18}(\\.[0-9]{1,12})?"');
  const currency=()=>field('currency','Account currency',record.currency||'','text',true,'readonly maxlength="3" pattern="[A-Z]{3}"');
  let title,body,hidden={};
  if(action==='create-collector'||action==='update-collector'){
    title=action==='create-collector'?'Add collector':'Edit collector';
    if(action==='update-collector')hidden={collectorId:record.id,expectedVersion:record.version};
    body=field('name','Collector name',record.name||'','text',true,'maxlength="200"')+field('phone','Phone / contact (optional)',record.phone||'','tel',false,'maxlength="60"')+notes(record.notes||'')+'<p class="muted-help">A collector is a business record managed by the owner. This does not create a CRM account.</p>';
  }else if(action==='create-account'){
    title='Add company cash / bank account';hidden={scope:'company'};
    body=field('name','Account name','','text',true,'maxlength="200"')+select('kind','Account type',[['cash','Company cash'],['bank','Company bank']])+field('currency','Currency','','text',true,'maxlength="3" pattern="[A-Z]{3}"')+
      field('openingDate','Opening balance date','','date')+field('openingAmount','Owner-confirmed opening balance','','text',true,'inputmode="decimal" pattern="[0-9]{1,18}(\\.[0-9]{1,12})?"')+
      confirmation('ownerConfirmedOpening','I confirm this account’s opening amount and date, including an explicit zero if appropriate.')+notes('')+'<p class="muted-help">Enter the actual opening balance. No suggested balance or receipt income is created.</p>';
  }else if(action==='record-collection'){
    title='Link collected receipt';
    body=collector()+select('sourceReceipt','Original receipt',receiptOptions(choices.receipts))+
      '<div class="field wide" id="staff-receipt-paging"><p class="muted-help" id="staff-receipt-page-status" role="status"></p><button type="button" class="button subtle" id="staff-load-receipts">Load more receipts</button><p id="staff-receipt-page-error" role="alert"></p></div>'+
      '<div class="field wide"><p class="muted-help" id="staff-receipt-detail">Select an existing receipt to review its original date, amount and payment method. This link does not create income.</p></div>'+
      select('disposition','Where is the money?',[['collector-held','Held by collector'],['company-direct','Already received by company']])+`<div id="staff-company-account" hidden>${account(false)}</div>`+
      confirmation('ownerConfirmedDisposition','I confirm where this receipt is held.')+notes('');
  }else if(action==='handover'||action==='correct-handover'){
    title=action==='handover'?'Record handover':'Correct handover';
    if(action==='correct-handover')hidden={handoverId:record.id};
    body=(action==='handover'?collector():'')+account()+amount()+currency()+field('handedOn','Handover date',record.businessDate||'','date')+field('reference','New unique handover reference',action==='handover'?record.reference||'':'','text',true,'maxlength="200"')+
      (action==='correct-handover'?field('reason','Correction reason','','text',true,'maxlength="500"'):'')+notes(record.notes||'')+'<p class="muted-help">A full or partial handover transfers existing money to company cash/bank. It does not create income. Pending cheques cannot be handed over. References must be unique for the collector across currencies; corrections require a new reference.</p>';
  }else if(action==='reverse-collection'||action==='reverse-handover'){
    title=action==='reverse-collection'?'Reverse collection link':'Reverse handover';
    hidden=action==='reverse-collection'?{collectionId:record.id}:{handoverId:record.id};
    body=field('reversedOn','Reversal date','','date')+field('reason','Reason','','text',true,'maxlength="500"')+'<p class="muted-help">The original record and this correction remain in history. Review the affected receipt and custody balance before confirming.</p>';
  }else return null;
  return {title,body:`<div class="form-grid rental-form-grid">${body}</div>`,hidden};
}
const alive=state=>dialogState===state&&state.generation===generation&&!state.options.signal?.aborted&&state.options.isCurrent();
function closeCommand(force=false){
  if(writeController&&!force)return;
  const state=dialogState;state?.pageController?.abort();document.querySelector('#staff-dialog')?.remove();dialogState=null;
  if(!force&&state?.options.trigger?.isConnected)state.options.trigger.focus();
}
export function resetStaffCollections(preservePeriod=false){generation++;readController?.abort();readController=null;workspaceContext=null;writeController?.abort();writeController=null;closeCommand(true);if(!preservePeriod)period={month:today().slice(0,7),asOf:today(),collectorId:''};}

export function openStaffCommand(action,record,options){
  if(options.signal?.aborted||!options.isCurrent()||writeController)return;
  const prepared=staffCommandForm(action,record,options.choices);if(!prepared)return;
  closeCommand();const state={action,prepared,options,generation,pending:null,pageController:null};dialogState=state;
  const dialog=document.createElement('dialog');dialog.id='staff-dialog';dialog.setAttribute('aria-labelledby','staff-dialog-title');
  dialog.innerHTML=`<form id="staff-form"><header class="dialog-header"><div><span class="eyebrow">HAMDEE STAFF COLLECTIONS</span><h2 id="staff-dialog-title">${prepared.title}</h2></div><button type="button" class="icon-button" data-staff-close aria-label="Close collection dialog">×</button></header><div class="rental-dialog-body">${prepared.body}</div><p id="staff-error" role="alert" tabindex="-1"></p><div id="staff-recovery"></div><footer id="dialog-footer"><button type="button" class="button subtle" data-staff-close>Cancel</button><button class="button primary" type="submit" id="staff-save">Save record</button></footer></form>`;
  document.body.append(dialog);
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeCommand();});
  dialog.querySelectorAll('[data-staff-close]').forEach(button=>button.addEventListener('click',()=>closeCommand()));
  if(action==='record-collection'){
    const paging=options.receiptPaging||{hasMore:false,nextCursor:null};
    const load=dialog.querySelector('#staff-load-receipts');load.hidden=!paging.hasMore;
    dialog.querySelector('#staff-receipt-page-status').textContent=receiptStatus(options.choices.receipts,paging);
    load.addEventListener('click',()=>{void loadReceiptPage(state,dialog,paging);});
  }
  dialog.addEventListener('change',event=>{
    if(!alive(state)||state.pending?.uncertain)return;
    const disposition=dialog.querySelector('[name="disposition"]'),account=dialog.querySelector('[name="accountId"]');
    const receipt=options.choices.receipts.find(row=>`${row.kind}:${row.id}`===dialog.querySelector('[name="sourceReceipt"]')?.value);
    if(receipt){
      const pending=receipt.status==='pending'||receipt.method==='cheque';
      dialog.querySelector('#staff-receipt-detail').textContent=`Original receipt: ${receipt.date} · ${receipt.currency} ${receipt.amount} · ${receipt.method} · ${receipt.classification}. ${pending?'Pending cheque: this amount cannot be handed over.':'This link does not create income.'}`;
      disposition.required=!pending;disposition.disabled=pending||receipt.disposition!=='unassigned';disposition.parentElement.hidden=pending;
      const confirm=dialog.querySelector('[name="ownerConfirmedDisposition"]');confirm.required=!pending;confirm.closest('.field').hidden=pending;
      if(event.target.name==='sourceReceipt'){
        disposition.value=receipt.disposition==='unassigned'?'':receipt.disposition;
        account.innerHTML='<option value="">Choose…</option>'+options.choices.accounts.filter(row=>row.scope==='company'&&row.currency===receipt.currency).map(row=>`<option value="${esc(row.id)}">${esc(row.name)} · ${esc(row.kind)} · ${esc(row.currency)}</option>`).join('');
        account.value=receipt.accountId||receipt.companyAccountId||'';
      }
    }
    if(disposition&&account){const direct=disposition.value==='company-direct'&&receipt?.status!=='pending'&&receipt?.method!=='cheque';dialog.querySelector('#staff-company-account').hidden=!direct;account.required=direct;if(!direct)account.value='';}
    if(!disposition&&account){const selected=options.choices.accounts.find(row=>row.id===account.value);dialog.querySelector('[name="currency"]').value=selected?.currency||'';}
  });
  dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();void saveCommand(state,event.target);});
  dialog.showModal();
}
async function loadReceiptPage(state,dialog,paging){
  if(!alive(state)||writeController||state.pending?.uncertain||state.pageController||!paging.nextCursor)return;
  const cursor=paging.nextCursor,controller=new window.AbortController();state.pageController=controller;
  const signal=window.AbortSignal.any([state.options.signal,controller.signal]),load=dialog.querySelector('#staff-load-receipts'),save=dialog.querySelector('#staff-save'),error=dialog.querySelector('#staff-receipt-page-error'),status=dialog.querySelector('#staff-receipt-page-status');
  load.disabled=true;save.disabled=true;error.textContent='';status.textContent='Loading more saved receipts…';dialog.querySelector('#staff-receipt-paging').setAttribute('aria-busy','true');
  try{
    const result=await state.options.api.staffReceipts({...state.options.receiptFilters,cursor},signal);
    if(!alive(state)||signal.aborted||!await state.options.verifyAccess()||!alive(state)||signal.aborted)return;
    const page=receiptPage(result,state.options.receiptFilters.asOf);
    if(page.nextCursor===cursor)throw new Error('The receipt service did not advance its page. Your loaded choices and draft are retained.');
    const selected=dialog.querySelector('[name="sourceReceipt"]'),value=selected.value;
    const merged=mergeReceipts(state.options.choices.receipts,page.data);state.options.choices.receipts=merged;
    paging.nextCursor=page.nextCursor;paging.hasMore=page.hasMore;
    selected.innerHTML='<option value="">Choose…</option>'+receiptOptions(merged).map(([id,text])=>`<option value="${esc(id)}">${esc(text)}</option>`).join('');selected.value=value;
    if(value&&!selected.value){error.textContent='The selected receipt is now linked. Your other draft fields remain; choose another original receipt.';dialog.querySelector('#staff-receipt-detail').textContent='Select another existing receipt to review its original date, amount and payment method.';}
    state.options.onReceiptPage?.(merged);status.textContent=receiptStatus(merged,paging);load.hidden=!paging.hasMore;
    if(load.hidden)selected.focus();
  }catch(cause){
    if(!alive(state)||signal.aborted)return;
    if(cause.status===401||(cause.status===403&&cause.code!=='CSRF_REJECTED')||cause.code==='OWNER_ACCESS_DENIED'){await state.options.onAccessLoss(cause);return;}
    status.textContent=receiptStatus(state.options.choices.receipts,paging);error.textContent=cause.message+' Your draft and loaded receipts are retained. Use Load more receipts to retry.';
  }finally{if(state.pageController===controller)state.pageController=null;if(alive(state)){load.disabled=false;save.disabled=false;dialog.querySelector('#staff-receipt-paging').setAttribute('aria-busy','false');}}
}
async function saveCommand(state,form){
  if(!alive(state)||writeController||state.pageController)return;
  let body={action:state.action,...state.prepared.hidden,...Object.fromEntries(new FormData(form))};
  if(state.pending?.uncertain)body=state.pending.body;
  else if(body.action==='record-collection'){
    const receipt=state.options.choices.receipts.find(row=>`${row.kind}:${row.id}`===body.sourceReceipt);
    if(!receipt)return;
    body.sourceKind=receipt.kind;body.sourceId=receipt.id;delete body.sourceReceipt;
    if(receipt.disposition!=='unassigned')body.disposition=receipt.disposition;
    if(receipt.status==='pending'||receipt.method==='cheque')delete body.disposition;
    body.ownerConfirmedDisposition=body.ownerConfirmedDisposition==='true';if(body.disposition!=='company-direct')delete body.accountId;
  }
  else if(body.action==='create-account')body.ownerConfirmedOpening=body.ownerConfirmedOpening==='true';
  const signature=JSON.stringify(body);if(state.pending?.signature!==signature)state.pending={signature,key:crypto.randomUUID(),body,uncertain:false};
  const controller=new window.AbortController();writeController=controller;
  const button=form.querySelector('#staff-save'),error=form.querySelector('#staff-error'),recovery=form.querySelector('#staff-recovery');
  button.disabled=true;const load=form.querySelector('#staff-load-receipts');if(load)load.disabled=true;form.setAttribute('aria-busy','true');error.textContent='';recovery.innerHTML='';
  try{
    const write=body.action==='create-account'?'financeWrite':'staffWrite';
    await state.options.api[write](body,state.pending.key,controller.signal);
    if(!alive(state)||controller.signal.aborted||!await state.options.verifyAccess()||!alive(state))return;
    writeController=null;closeCommand();await state.options.onSaved(state.action);
  }catch(cause){
    if(!alive(state)||controller.signal.aborted)return;
    if(cause.status===401||(cause.status===403&&cause.code!=='CSRF_REJECTED')||cause.code==='OWNER_ACCESS_DENIED'){await state.options.onAccessLoss(cause);return;}
    state.pending.uncertain=Boolean(cause.uncertain);
    form.querySelectorAll('input,select').forEach(input=>input.disabled=state.pending.uncertain);
    error.textContent=cause.message+(state.pending.uncertain?' The save may have reached the server. Save again to confirm the exact submission; closing will not undo a committed change.':'');
    if(cause.status===409||cause.status===412)error.textContent+=' Review the latest saved records before trying a changed submission.';
    if(cause.status===412&&state.action==='update-collector'){
      const review=document.createElement('button');review.type='button';review.className='button subtle';review.textContent='Review latest collector revision';recovery.append(review);
      review.addEventListener('click',async()=>{
        if(!alive(state))return;review.disabled=true;
        try{
          const result=await state.options.api.staffRead({month:period.month,asOf:period.asOf,collectorId:state.prepared.hidden.collectorId},state.options.signal);
          if(!alive(state)||!await state.options.verifyAccess()||!alive(state))return;
          const latest=result.data?.collectors?.find(row=>row.id===state.prepared.hidden.collectorId);
          if(!latest||!Number.isSafeInteger(latest.version))throw new Error('The latest collector revision is unavailable. Retain your draft and refresh the workspace.');
          state.prepared.hidden.expectedVersion=latest.version;state.pending=null;
          error.textContent=`Latest revision ${latest.version}: ${latest.name} · Contact: ${latest.phone||'none'} · Notes: ${latest.notes||'none'}. Your draft remains above. Review these saved details and your draft before saving explicitly.`;
          recovery.innerHTML='';error.focus();
        }catch(failure){if(alive(state)){error.textContent=failure.message;review.disabled=false;}}
      });
    }
    if(cause.code==='CSRF_REJECTED'){
      const renew=document.createElement('button');renew.type='button';renew.className='button subtle';renew.textContent='Renew session verification';recovery.append(renew);
      renew.addEventListener('click',async()=>{if(!alive(state))return;renew.disabled=true;try{if(await (state.options.renewAccess||state.options.verifyAccess)()&&alive(state)){error.textContent='Session verified. Review your draft and save explicitly.';recovery.innerHTML='';error.focus();}}catch(failure){if(alive(state)){error.textContent=failure.message;renew.disabled=false;}}});
    }
    error.focus();
  }finally{if(writeController===controller)writeController=null;if(button.isConnected){button.disabled=false;if(load)load.disabled=Boolean(state.pending?.uncertain);form.setAttribute('aria-busy','false');}}
}
const active=c=>workspaceContext===c&&c.generation===generation&&!c.signal.aborted&&c.isCurrent();
const button=(label,action,id='',primary=false,disabled=false)=>`<button type="button" class="button ${primary?'primary':'subtle'}" data-staff-action="${action}" data-id="${esc(id)}" ${disabled?'disabled':''}>${esc(label)}</button>`;
const money=(value,currency)=>value===undefined?'Unavailable':`${esc(currency)} ${esc(value)}`;
const receiptLabel=r=>[r.propertyLabel,r.roomLabel,r.customerLabel,r.classification].filter(Boolean).join(' · ')||r.kind;
function unavailable(target,message){
  target.innerHTML=panel('Staff Collections unavailable',esc(message),'<div class="panel-body"><p>Collector records are managed by the owner and do not provide sign-in access. Collections link to saved receipts; handovers transfer custody to company cash or bank without creating income.</p><p>Balances and statements appear only after the service confirms saved records.</p></div>');
}
function draw(c){
  const d=c.data,collector=id=>d.collectors.find(row=>row.id===id)?.name||id,account=id=>c.accounts.find(row=>row.id===id)?.name||id;
  const filters=`<form class="toolbar rental-filters" id="staff-filters"><label>Statement month<input name="month" type="month" value="${esc(period.month)}" required></label><label>Balance cutoff<input name="asOf" type="date" value="${esc(period.asOf)}" required></label><label>Collector<select name="collectorId"><option value="">All collectors</option>${d.collectors.map(row=>`<option value="${esc(row.id)}" ${period.collectorId===row.id?'selected':''}>${esc(row.name)}</option>`).join('')}</select></label><button class="button subtle" type="submit">Apply staff filters</button></form>`;
  c.target.innerHTML=filters+
    panel('Collectors','Owner-managed business records. Collectors do not receive sign-in access.',table(['Name','Contact','Notes','Revision','Actions'],d.collectors.map(row=>[esc(row.name),esc(row.phone||'—'),esc(row.notes||'—'),esc(row.version),button('Edit collector','update-collector',row.id)]),'Collector register'),button('Add collector','create-collector','',true))+
    panel('Custody balances',`Saved balances through ${esc(d.asOf)}. Direct-company receipts and pending cheques remain separate; currencies are never combined.`,table(['Collector','Currency','Collected into custody','Direct to company','Pending cheques','Handed over','Remaining held'],d.totals.map(row=>[esc(collector(row.collectorId)),esc(row.currency),money(row.received,row.currency),money(row.companyDirect,row.currency),money(row.pending,row.currency),money(row.handedOver,row.currency),money(row.balance,row.currency)]),'Collector custody balances'))+
    panel('Linked collections','Original receipt date, amount and payment method are authoritative. Linking a receipt does not create income.',table(['Collector','Original receipt','Date','Amount','Method','Custody','Status','Actions'],d.collections.map(row=>[esc(collector(row.collectorId)),`${esc(receiptLabel(row.source))}<br><small>${esc(row.source.kind)} · ${esc(row.source.id)}</small>`,esc(row.businessDate),money(row.amount,row.currency),esc(row.method),esc(row.disposition),row.reversed?'Reversed':'Recorded',row.reversed?'':button('Reverse link','reverse-collection',row.id)]),'Linked collection receipts'),button('Link collected receipt','record-collection','',true,!d.collectors.length||(!c.receipts.some(row=>!row.linked)&&!c.receiptPaging.hasMore)))+
    `<p id="staff-receipt-list-status" class="operations-notice" role="status" ${!c.receiptIssue&&!c.receiptPaging.hasMore?'hidden':''}>${c.receiptIssue?`Receipt choices unavailable: ${esc(c.receiptIssue)} Refresh the workspace before linking a receipt.`:'More saved receipts are available. Open Link collected receipt and use Load more receipts; do not recreate an existing receipt.'}</p>`+
    panel('Handovers','Full or partial transfers to company cash/bank. A handover never creates income.',table(['Collector','Company account','Date','Amount','Reference','Status / replaces','Actions'],d.handovers.map(row=>[esc(collector(row.collectorId)),esc(account(row.accountId)),esc(row.businessDate),money(row.amount,row.currency),esc(row.reference),esc(row.reversed?'Reversed':row.replacesHandoverId?'Correction of '+row.replacesHandoverId:'Recorded'),row.reversed?'':button('Correct handover','correct-handover',row.id)+button('Reverse handover','reverse-handover',row.id)]),'Collector handovers'),button('Record handover','handover','',true,!d.collectors.length||!c.accounts.length))+
    panel('Company handover accounts','Only owner-confirmed company cash/bank accounts can receive handovers.',table(['Account','Type','Currency','Opening date','Confirmed opening'],c.accounts.map(row=>[esc(row.name),esc(row.kind),esc(row.currency),esc(row.openingDate),money(row.openingAmount,row.currency)]),'Company handover accounts'),button('Add company account','create-account','',false,Boolean(c.accountIssue)))+
    (c.accountIssue?`<p class="operations-notice" role="status">Company accounts unavailable: ${esc(c.accountIssue)} Handovers cannot be submitted until accounts load.</p>`:'')+
    panel('Monthly statement',`Saved custody movements for ${esc(d.month)} through ${esc(d.asOf)}.`,table(['Collector','Currency','Collected into custody','Handed over'],d.totals.map(row=>[esc(collector(row.collectorId)),esc(row.currency),money(row.monthReceived,row.currency),money(row.monthHandedOver,row.currency)]),'Monthly collector statement'))+
    panel('Daily statement','Recorded end-of-day custody balances for the selected month, including saved corrections.',table(['Date','Collector','Currency','Collected into custody','Handed over','End-of-day held'],d.daily.filter(row=>row.date.slice(0,7)===d.month).map(row=>[esc(row.date),esc(collector(row.collectorId)),esc(row.currency),money(row.received,row.currency),money(row.handedOver,row.currency),money(row.balance,row.currency)]),'Daily collector statement'))+
    panel('Correction and change history','Original records remain visible. Attributed changes and reasons come from the service.',table(['Action','Time','Actor','Record / original','Reason'],d.history.map(row=>[esc(row.action),esc(row.occurredAt),esc(row.actorId),esc(row.detail?.data?.originalId||row.detail?.data?.id||'—'),esc(row.detail?.data?.reason||'—')]),'Staff collection history'))+
    `<p class="muted-help">${esc(d.basis)}</p>`;
  c.target.querySelector('#staff-filters').addEventListener('submit',event=>{event.preventDefault();if(!active(c))return;period={...Object.fromEntries(new FormData(event.target))};void renderStaffCollections(c.target,c);});
  c.target.querySelectorAll('[data-staff-action]').forEach(control=>control.addEventListener('click',()=>{
    if(!active(c))return;const action=control.dataset.staffAction,id=control.dataset.id;
    const record=action==='update-collector'?d.collectors.find(row=>row.id===id):action==='reverse-collection'?d.collections.find(row=>row.id===id):d.handovers.find(row=>row.id===id);
    openStaffCommand(action,record||{},{...c,choices:{collectors:d.collectors,receipts:c.receipts,accounts:c.accounts},trigger:control,onReceiptPage:merged=>{
      if(!active(c))return;c.receipts=merged;
      const notice=c.target.querySelector('#staff-receipt-list-status');notice.hidden=!c.receiptPaging.hasMore;notice.textContent='More saved receipts are available. Open Link collected receipt and use Load more receipts; do not recreate an existing receipt.';
      c.target.querySelector('[data-staff-action="record-collection"]').disabled=!d.collectors.length||(!c.receipts.some(row=>!row.linked)&&!c.receiptPaging.hasMore);
    },onSaved:async()=>{
      await renderStaffCollections(c.target,c);
      if(workspaceContext&&active(workspaceContext)){
        document.querySelector('#feedback').textContent='Staff collection record saved.';
        const focus=c.target.querySelector(`[data-staff-action="${action}"][data-id="${id}"]`)||c.target.querySelector('[data-staff-action="create-collector"]');focus?.focus();
      }
    }});
  }));
}
export async function renderStaffCollections(target,options){
  if(options.signal?.aborted||!options.isCurrent())return;
  readController?.abort();const controller=new window.AbortController();readController=controller;
  const c={...options,target,generation,receiptFilters:{asOf:period.asOf,...(options.receiptFilters?.propertyId?{propertyId:options.receiptFilters.propertyId}:{})},receiptPaging:{hasMore:false,nextCursor:null}};workspaceContext=c;
  options.signal.addEventListener('abort',()=>{if(workspaceContext===c)resetStaffCollections(true);},{once:true,signal:controller.signal});
  target.setAttribute('aria-busy','true');
  target.innerHTML='<div class="empty" role="status">Loading saved collectors, receipts and custody balances…</div>';
  const signal=window.AbortSignal.any([options.signal,controller.signal]);
  try{
    const [overview,receipts,accounts]=await Promise.allSettled([
      c.api.staffRead({month:period.month,asOf:period.asOf,...(period.collectorId?{collectorId:period.collectorId}:{})},signal),
      c.api.staffReceipts(c.receiptFilters,signal),c.api.financeRead({month:period.month,asOf:period.asOf},signal)
    ]);
    if(!active(c)||signal.aborted)return;
    for(const result of [overview,receipts,accounts])if(result.status==='rejected'&&(result.reason.status===401||(result.reason.status===403&&result.reason.code!=='CSRF_REJECTED')||result.reason.code==='OWNER_ACCESS_DENIED')){await c.onAccessLoss(result.reason);return;}
    if(overview.status==='rejected')throw overview.reason;
    if(!await c.verifyAccess()||!active(c)||signal.aborted)return;
    c.data=overview.value.data;
    if(c.data?.moneyUnit!=='decimal-major-unit-strings'||!['collectors','collections','handovers','totals','daily','history'].every(key=>Array.isArray(c.data[key])))throw new Error('The collection service returned an unsupported record format. Check the service before recording money.');
    c.receipts=[];c.receiptIssue=null;
    if(receipts.status==='fulfilled'){
      try{const page=receiptPage(receipts.value,c.receiptFilters.asOf);c.receipts=mergeReceipts([],page.data);c.receiptPaging={hasMore:page.hasMore,nextCursor:page.nextCursor};}catch(failure){c.receiptIssue=failure.message;}
    }else c.receiptIssue=receipts.reason.message;
    if(accounts.status==='fulfilled'&&Array.isArray(accounts.value.data?.accounts))c.accounts=accounts.value.data.accounts.filter(row=>row.scope==='company');
    else{c.accounts=[];c.accountIssue=accounts.status==='rejected'?accounts.reason.message:'Unsupported company account format.';}
    draw(c);
  }catch(error){if(!active(c)||signal.aborted)return;if(error.status===401||(error.status===403&&error.code!=='CSRF_REJECTED')||error.code==='OWNER_ACCESS_DENIED')await c.onAccessLoss(error);else unavailable(target,error.message);}
  finally{if(active(c)&&!signal.aborted)target.setAttribute('aria-busy','false');if(readController===controller)readController=null;}
}
