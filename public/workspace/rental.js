// HAMDEE operational views. All records and balances come from the owner API.
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Presentation only: the isolated loopback demo server supplies the marker.
// It cannot select a database, authenticate a user or enable a hosted demo.
export const isIsolatedDemoContext=(hostname,marker)=>['localhost','127.0.0.1','[::1]'].includes(hostname)&&marker==='isolated-local';
const today=()=>new Date().toISOString().slice(0,10);
export const defaultCollectionMonth=(date=today())=>date.slice(0,7)<'2026-11'?'2026-11':date.slice(0,7);
export const decimal=v=>{const n=BigInt(v??0);return `${n/100n}.${String(n%100n).padStart(2,'0')}`;};
const cash=(v,currency)=>`${esc(currency)} ${esc(decimal(v))}`;
const action=(label,name,id='',primary=false)=>`<button type="button" class="button ${primary?'primary':'subtle'}" data-rental-action="${name}" data-id="${esc(id)}">${esc(label)}</button>`;
export const table=(headers,rows,label)=>`<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(label)}"><table class="data-table"><thead><tr>${headers.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(cells=>`<tr>${cells.map(c=>`<td>${c}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${headers.length}">No saved records yet.</td></tr>`}</tbody></table></div>`;
export const panel=(title,subtitle,body,buttons='')=>`<section class="panel rental-panel"><div class="panel-header"><div><h2>${title}</h2><p>${subtitle}</p></div><div class="head-actions">${buttons}</div></div>${body}</section>`;
let context=null,dialogContext=null,generation=0,writeController=null,report={month:defaultCollectionMonth(),asOf:today(),propertyId:''};
export const rentalReportPeriod=()=>({month:report.month,asOf:report.asOf});
const modal=()=>document.querySelector('#rental-dialog');
export function resetRental(preservePeriod=false){generation++;writeController?.abort();writeController=null;context=null;dialogContext=null;if(!preservePeriod)report={month:defaultCollectionMonth(),asOf:today(),propertyId:''};const d=modal();if(d){d.close();d.innerHTML='';}}
const sectionPanel=(key,...args)=>panel(...args).replace('<section ',`<section data-rental-section="${key}" `);
const sectionLinks=c=>c.property?`<nav class="workflow-nav" aria-label="Villa rental sections">${[['rental','All rentals'],['rooms','Rooms'],['tenants','Tenants'],['agreements','Agreements'],['collections','Collections'],['cheques','Cheques'],['deposits','Deposits']].map(([id,label])=>`<a href="#properties/${esc(c.property.id)}/${id}" ${(c.section||'rental')===id?'aria-current="page"':''}>${label}</a>`).join('')}</nav>`:'';
const alive=c=>context===c&&c.generation===generation&&c.isCurrent()&&!c.signal.aborted;
const filters=dashboard=>`<form class="toolbar rental-filters" data-rental-filter="${dashboard?'dashboard':'records'}"><label>Rent month<input type="month" name="month" value="${esc(report.month)}" required></label><label>Occupancy / balance date<input type="date" name="asOf" value="${esc(report.asOf)}" required></label>${!dashboard&&!context.property?`<label>Property<select name="propertyId"><option value="">All properties</option>${context.properties.map(p=>`<option value="${esc(p.id)}" ${report.propertyId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label>`:''}<button class="button subtle" type="submit">Apply rental filters</button></form>`;
// An absent agreement is not evidence of vacancy. Historical sheet occupants
// remain a month snapshot and never stand in for an accepted dated agreement.
export const historicalOccupants=room=>(room?.historicalOccupants||[]).filter(row=>row.period==='2026-10'&&row.currentOccupancyVerified===false);
export function quickCollectionPlan(data,roomId,period,agreementId=''){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))throw new Error('Choose a valid collection month.');
 const room=data.rooms.find(row=>row.id===roomId);if(!room)throw new Error('Choose a saved room.');
 const last=`${period}-${new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).getUTCDate()}`;
 const agreements=data.agreements.filter(row=>row.roomId===roomId&&row.startDate<=last&&(!row.endDate||row.endDate>=period+'-01'));
 const agreement=agreementId?agreements.find(row=>row.id===agreementId):agreements.length===1?agreements[0]:null;
 const dues=data.dues.filter(row=>row.roomId===roomId&&row.period===period&&(!agreement||row.agreementId===agreement.id));
 const advances=data.collections.filter(row=>row.roomId===roomId&&row.kind==='advance'&&row.status==='recorded'&&(!agreement||row.agreementId===agreement.id));
 return {room,period,agreements,agreement,dues,advances};
}
const agreementAt=(data,roomId)=>data.agreements.find(a=>a.roomId===roomId&&a.startDate<=report.asOf&&(!a.endDate||a.endDate>=report.asOf));
export function occupancyStatus(data,room){return agreementAt(data,room.id)?'occupied':room.occupancy==='vacant'&&room.occupancyVerified===true?'vacant':'unknown';}
const occupancyLabel=status=>status==='occupied'?'Occupied':status==='vacant'?'Vacant':'Occupancy not verified';
const snapshotNames=(data,room)=>historicalOccupants(room).map(row=>data.tenants.find(t=>t.id===row.tenantId)?.name||'Contact not available');
const totals=d=>{
 const states=d.rooms.map(room=>occupancyStatus(d,room));
 const counts=[['Total rooms',d.summary.totalRooms],['Occupied rooms',states.filter(s=>s==='occupied').length],['Vacant rooms',states.filter(s=>s==='vacant').length],['Occupancy not verified',states.filter(s=>s==='unknown').length]];
 return `<div class="metrics owner-metadata-metrics rental-occupancy-metrics">${counts.map(([label,value])=>`<div class="metric"><div class="metric-top"><span>${label}</span></div><div class="metric-value">${value}</div><p class="metric-note">As of ${esc(report.asOf)} · Historical snapshots do not confirm current occupancy.</p></div>`).join('')}</div>`+
 panel('Monthly rent','Issued obligations for the selected month; collections allocated through the balance date. Currencies stay separate.',table(['Currency','Monthly rent due','Rent collected','Outstanding','Unapplied advances','Deposits held','Pending cheques'],d.summary.currencies.map(c=>[esc(c.currency),cash(c.dueMinor,c.currency),cash(c.collectedMinor,c.currency),cash(c.outstandingMinor,c.currency),cash(c.advanceMinor,c.currency),cash(c.depositMinor,c.currency),cash(c.chequePendingMinor,c.currency)]),'Monthly rental summary'));
};
async function load(c){
 const pending=c.prefetchedRental;delete c.prefetchedRental;
 if(pending){const result=await pending;if(!result.ok)throw result.error;return result.value.data;}
 return (await c.api.rentalRead({month:report.month,asOf:report.asOf,...(c.property?{propertyId:c.property.id}:report.propertyId&&!c.dashboard?{propertyId:report.propertyId}:{})},c.signal)).data;
}
export async function renderRentalDashboard(target,options){
 const c={...options,target,dashboard:true,generation};context=c;
 target.innerHTML='<div role="status" class="empty">Loading saved rental balances…</div>';
 try{const data=await load(c);if(!alive(c)||!await c.verifyAccess()||!alive(c))return;c.data=data;target.innerHTML=filters(true)+totals(data);}
 catch(error){if(!alive(c))return;if(error.status===401||error.code==='MFA_REQUIRED'||error.code==='OWNER_ACCESS_DENIED')await c.onAccessLoss(error);else target.innerHTML=panel('Unable to load rental balances',esc(error.message),'','<button type="button" class="button subtle" data-action="retry-view">Retry balances</button>');}
}
export async function renderRental(target,options){
 const c={...options,target,dashboard:false,generation};context=c;
 target.innerHTML='<div class="empty" role="status">Loading rooms, tenants and rent records…</div>';
 try{
  const data=await load(c);let properties=c.property?[c.property]:[];let cursor='';
  // A villa is already fetched and verified by the workspace router. Its scoped
  // records need that villa's label, not another complete property-register read.
  if(!c.property)do{const page=await c.api.list({archiveState:'all',q:'',limit:'100',cursor},c.signal);properties.push(...page.data);cursor=page.nextCursor??'';}while(cursor&&alive(c));
  if(!alive(c)||!await c.verifyAccess()||!alive(c))return;c.properties=properties;c.data=data;
  const room=id=>data.rooms.find(r=>r.id===id),tenant=id=>data.tenants.find(t=>t.id===id),agreement=id=>data.agreements.find(a=>a.id===id);
  const property=id=>properties.find(p=>p.id===id)?.name||id;
  const agreementName=a=>`${property(a.propertyId)} · ${room(a.roomId)?.code||'Room'} · ${tenant(a.tenantId)?.name||'Tenant'} · ${a.startDate}`;
  c.agreementName=agreementName;
  const rooms=data.rooms.map(r=>{const a=agreementAt(data,r.id),status=occupancyStatus(data,r),names=snapshotNames(data,r);return [esc(property(r.propertyId)),esc(r.code),esc(r.label||'—'),`<span class="badge ${status==='occupied'?'green':'amber'}">${esc(occupancyLabel(status))}</span>`,esc(a?tenant(a.tenantId)?.name:'—'),names.length?names.map(esc).join('<br>')+'<span class="record-sub">Historical snapshot · October 2026</span>':r.historicalOccupancyReviewRequired?'Historical source needs review':'No verified source link',action('Collect room rent','quick-room',r.id,true)+action('Edit room','update-room',r.id)+action('Room history','room-history',r.id)];});
  const agreements=data.agreements.map(a=>[esc(room(a.roomId)?.code),esc(tenant(a.tenantId)?.name),esc(a.startDate)+' → '+esc(a.endDate||'Open-ended'),cash(a.monthlyRentMinor,a.currency),esc(a.dueTerms),cash(a.depositRequiredMinor,a.currency),action('Issue monthly due','issue-due',a.id)+action('End agreement','end-agreement',a.id)+(a.endDate?action('Renew agreement','renew-agreement',a.id):'')]);
  const villaTenantIds=c.property&&c.section==='tenants'?new Set([...data.agreements.filter(a=>a.propertyId===c.property.id).map(a=>a.tenantId),...data.rooms.filter(r=>r.propertyId===c.property.id).flatMap(r=>historicalOccupants(r).map(row=>row.tenantId))]):null;
  const displayedTenants=villaTenantIds?data.tenants.filter(t=>villaTenantIds.has(t.id)):data.tenants;
  const dues=data.dues.map(d=>[esc(room(d.roomId)?.code),esc(d.snapshot?.tenantName||tenant(agreement(d.agreementId)?.tenantId)?.name),esc(d.period),esc(d.dueDate),cash(d.amountMinor,d.currency),cash(d.paidMinor,d.currency),cash(d.outstandingMinor,d.currency),`<span class="badge ${d.status==='paid'?'green':'amber'}">${esc(d.status)}</span>`,BigInt(d.outstandingMinor)>0n?action('Collect rent','collect-due',d.id):'']);
  const collections=data.collections.filter(row=>row.receivedDate.slice(0,7)===report.month&&row.receivedDate<=report.asOf&&(c.section!=='cheques'||row.method==='cheque')&&(c.section!=='deposits'||['deposit','deposit_refund'].includes(row.kind))).map(r=>[esc(room(r.roomId)?.code),esc(r.receivedDate),esc(r.kind.replaceAll('_',' ')),esc(r.method),cash(r.amountMinor,r.currency),esc(r.status),esc(r.reference||'—'),r.kind==='advance'&&r.status==='recorded'?action('Apply advance','allocate-advance',r.id):'']);
  const advances=data.collections.filter(row=>row.kind==='advance'&&row.status==='recorded'&&row.receivedDate<=report.asOf).map(row=>[esc(room(row.roomId)?.code),esc(row.receivedDate),esc(tenant(agreement(row.agreementId)?.tenantId)?.name||'Tenant'),cash(row.amountMinor,row.currency),row.availableAdvanceMinor===undefined?'Not verified':cash(row.availableAdvanceMinor,row.currency),row.availableAdvanceMinor!==undefined&&BigInt(row.availableAdvanceMinor)>0n?action('Apply advance','allocate-advance',row.id):'']);
  target.innerHTML=sectionLinks(c)+filters(false)+totals(data)+
   sectionPanel('rooms','Rooms & units','Current occupancy requires a dated agreement or confirmed vacancy. October 2026 occupants are historical source references, not current tenancy or rent dues.',table(['Property','Room code','Label','Status','Current tenant','October 2026 occupant','Actions'],rooms,'Rooms and occupancy'),action('Add room','create-room','',true))+
   sectionPanel('tenants','Tenants',villaTenantIds?'Contacts linked by this villa’s current or past agreements or its October 2026 historical snapshot. A historical link does not create an agreement or confirm current occupancy. All rentals retains the owner contact register.':c.property?'Manage tenant contact details. Historical occupancy remains available in each room.':'Contact records only; tenants do not receive a login.',table(['Name','Phone','Email','Actions'],displayedTenants.map(t=>[esc(t.name),esc(t.phone||'—'),esc(t.email||'—'),action('Edit tenant','update-tenant',t.id)]),'Tenant register'),action('Add tenant','create-tenant','',true))+
   sectionPanel('agreements','Rental agreements','Renewals create a new dated record; prior occupants and obligations remain.',table(['Room','Tenant','Dates','Monthly rent','Due-date terms','Deposit required','Actions'],agreements,'Rental agreements'),action('Add agreement','create-agreement','',true))+
   sectionPanel('dues','Monthly rent dues','Issue explicit amounts and dates. No automatic proration or regenerated historical amounts.',table(['Room','Tenant','Month','Due date','Due','Paid','Pending','Status','Actions'],dues,'Monthly rent dues'),action('Issue monthly due','issue-due','',true))+
   sectionPanel('collections','Collections','Receipts received in the selected month. Cash and bank rent receipts pay selected dues. Cheques remain pending.',table(['Room','Received','Purpose','Method','Amount','Status','Reference','Actions'],collections,'Collection register'),action('Record collection','record-collection','',true)+(c.section==='cheques'?'':action('Refund deposit','refund-deposit')))+
   sectionPanel('advances','Unapplied advances','Earlier receipts remain available across months. Apply an advance explicitly to an issued due; this creates no new cash receipt. Security deposits stay separate.',table(['Room','Originally received','Tenant','Original advance','Available through '+report.asOf,'Action'],advances,'Cross-month advances'));
  const visible={rooms:['rooms'],tenants:['tenants'],agreements:['agreements','dues'],collections:['dues','collections','advances'],cheques:['collections'],deposits:['collections']}[c.section];
  target.querySelectorAll('[data-rental-section]').forEach(section=>section.hidden=Boolean(visible&&!visible.includes(section.dataset.rentalSection)));
 }catch(error){if(!alive(c))return;if(error.status===401||error.code==='MFA_REQUIRED'||error.code==='OWNER_ACCESS_DENIED')await c.onAccessLoss(error);else target.innerHTML=panel('Unable to load rental records',esc(error.message),'','<button type="button" class="button subtle" data-action="retry-view">Retry records</button>');}
}
export const field=(name,label,type='text',value='',required=true,extra='',prefix='rental')=>`<div class="field"><label for="${prefix}-${name}">${label}</label><input id="${prefix}-${name}" name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${extra}></div>`;
export const select=(name,label,values,selected='',required=true,prefix='rental')=>`<div class="field"><label for="${prefix}-${name}">${label}</label><select id="${prefix}-${name}" name="${name}" ${required?'required':''}><option value="">Choose…</option>${values.map(([value,label])=>`<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(label)}</option>`).join('')}</select></div>`;
function quickSummary(c,roomId,period,agreementId='',trigger){
 const plan=quickCollectionPlan(c.data,roomId,period,agreementId),a=plan.agreement;
 c.quick={roomId,period,agreementId:a?.id||''};
 const dueRows=plan.dues.filter(row=>a&&row.agreementId===a.id).map(row=>[esc(row.period),esc(row.dueDate),cash(row.amountMinor,row.currency),cash(row.paidMinor,row.currency),cash(row.outstandingMinor,row.currency),BigInt(row.outstandingMinor)>0n?action('Record payment','collect-due',row.id,true):'<span class="badge green">Paid</span>']);
 const advances=plan.advances.filter(row=>row.receivedDate<=report.asOf&&a&&row.agreementId===a.id).map(row=>[esc(row.receivedDate),cash(row.amountMinor,row.currency),row.availableAdvanceMinor===undefined?'Not verified':cash(row.availableAdvanceMinor,row.currency),row.availableAdvanceMinor!==undefined&&BigInt(row.availableAdvanceMinor)>0n&&plan.dues.some(due=>due.agreementId===a.id&&BigInt(due.outstandingMinor)>0n)?action('Apply advance','allocate-advance',row.id):'Issue an explicit due before allocation']);
 const agreementBody=plan.agreements.length?select('quickAgreement','Verified agreement',plan.agreements.map(row=>[row.id,c.agreementName(row)]),a?.id||'',false)+(!a?'<p class="muted-help">Choose the saved agreement for this room and month. No tenant or amount is inferred.</p>':''):'<p class="operations-notice">No dated agreement is saved for this room and month. October occupant history alone does not confirm the current tenant, rental terms or a rent due.</p>'+action('Confirm agreement terms','quick-agreement',roomId,true);
 const body=`<p class="quick-room-context"><strong>${esc(plan.room.code)}</strong><span>Collection month ${esc(period)} · Balances through ${esc(report.asOf)}</span></p><div class="form-grid rental-form-grid">${agreementBody}</div>`+
 (a?`<p class="quick-room-context">Tenant: <strong>${esc(c.data.tenants.find(row=>row.id===a.tenantId)?.name||'Tenant')}</strong> · Saved agreement ${esc(a.startDate)} to ${esc(a.endDate||'open-ended')}.</p>`+table(['Month','Due date','Due','Allocated','Outstanding','Action'],dueRows,'Selected room rent obligations')+(!plan.dues.some(row=>row.agreementId===a.id)?`<p class="muted-help">No rent due has been issued for ${esc(period)}. Enter the agreed amount and exact due date explicitly.</p>`+action('Prepare monthly due','quick-due',a.id,true):'')+table(['Originally received','Original advance','Available advance','Action'],advances,'Selected room earlier advances'):'')+
 `<p class="muted-help">Every agreement, monthly due and payment requires its own Save record. Deposits are separate from rent. <a class="link" href="#company">Company Finance</a> receives an existing saved receipt only after you select and confirm its cash or bank account.</p>`+action('Change collection month','quick-room',roomId);
 show('Room collection',body,{c,action:'quick-summary',quick:c.quick,trigger,pending:null},trigger);modal().querySelector('#rental-save').hidden=true;
}
function open(name,id,trigger){
 const c=context;if(!c?.data||!alive(c))return;const d=c.data,room=d.rooms.find(r=>r.id===id),tenant=d.tenants.find(t=>t.id===id),a=d.agreements.find(a=>a.id===id),due=d.dues.find(d=>d.id===id),receipt=d.collections.find(r=>r.id===id);
 if(name==='quick-room'||name==='quick-previous'){
  if(!room)return;c.quick={roomId:room.id,period:name==='quick-previous'?'':c.quick?.roomId===room.id?c.quick.period||report.month:report.month,agreementId:''};
  show(name==='quick-previous'?'Add previous room entry':'Choose room collection month',`<p class="quick-room-context"><strong>${esc(room.code)}</strong><span>${name==='quick-previous'?'Choose the original rent month explicitly. The actual receipt date is entered separately; no historical payment is assumed.':'Daily collections start from November 2026. Choose the rental month before recording a payment; the actual receipt date is entered separately.'}</span></p><div class="form-grid rental-form-grid">${field('collectionMonth','Collection month','month',c.quick.period)}</div>${name==='quick-previous'?'':action('Add previous entry','quick-previous',room.id)}`,{c,action:'quick-month',quick:c.quick,trigger,pending:null},trigger);modal().querySelector('#rental-save').textContent='Open selected month';return;
 }
 if(name==='room-history'){
  const events=d.history.filter(e=>e.roomId===id);const stays=d.agreements.filter(a=>a.roomId===id);show('Room history',`<p class="muted-help">${esc(room?.code)} · previous agreements and attributed changes remain. Historical source references do not verify current occupancy or create financial obligations.</p>`+table(['Historical month','Occupant','Source','Source reference'],historicalOccupants(room).map(row=>['October 2026',esc(d.tenants.find(t=>t.id===row.tenantId)?.name||'Contact not available'),esc(row.source),esc(row.sourceReference)]),'Historical occupancy snapshots')+table(['Tenant','Start','End','Monthly rent'],stays.map(a=>[esc(d.tenants.find(t=>t.id===a.tenantId)?.name),esc(a.startDate),esc(a.endDate||'Open-ended'),cash(a.monthlyRentMinor,a.currency)]),'Previous room occupants')+table(['Action','Time','Changes'],events.map(e=>[esc(e.action),esc(e.occurredAt),esc(e.detail?.fields?.join(', '))]),'Room change history'),null,trigger);return;
 }
 const props=c.properties.filter(p=>p.lifecycleStatus==='registered').map(p=>[p.id,p.name]),rooms=d.rooms.filter(r=>props.some(([p])=>p===r.propertyId)).map(r=>[r.id,`${c.properties.find(p=>p.id===r.propertyId)?.name} · ${r.code}`]);
 const tenants=d.tenants.map(t=>[t.id,t.name]),agreements=d.agreements.map(a=>[a.id,c.agreementName(a)]),dues=d.dues.filter(d=>BigInt(d.outstandingMinor)>0n).map(d=>[d.id,`${c.properties.find(p=>p.id===d.propertyId)?.name} · ${d.period} · ${d.snapshot?.roomCode} · ${cash(d.outstandingMinor,d.currency)}`]);
 let body='',title='',actionName=name,hidden={};
 const amount=(value='')=>field('amount','Amount','text',value,true,'inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?"');
 if(name==='create-room'||name==='update-room'){title=room?'Edit room':'Add room';hidden=room?{roomId:room.id,expectedVersion:room.version}:{};body=(!room?select('propertyId','Property',props,c.property?.id||report.propertyId):'')+field('code','Room code','text',room?.code||'',true,'maxlength="40"')+field('label','Room label (optional)','text',room?.label||'',false,'maxlength="200"');}
 else if(name==='create-tenant'||name==='update-tenant'){title=tenant?'Edit tenant':'Add tenant';hidden=tenant?{tenantId:tenant.id,expectedVersion:tenant.version}:{};body=field('name','Tenant name','text',tenant?.name||'',true,'maxlength="200"')+field('phone','Phone (optional)','tel',tenant?.phone||'',false,'maxlength="60"')+field('email','Email (optional)','email',tenant?.email||'',false,'maxlength="254"')+field('notes','Notes (optional)','text',tenant?.notes||'',false,'maxlength="1000"');}
 else if(name==='create-agreement'||name==='renew-agreement'||name==='quick-agreement'){title=name==='renew-agreement'?'Renew agreement':name==='quick-agreement'?'Confirm room agreement terms':'Add agreement';actionName='create-agreement';hidden=name==='renew-agreement'?{previousAgreementId:a.id}:{};body=select('roomId','Room / unit',rooms,name==='quick-agreement'?c.quick?.roomId:a?.roomId)+select('tenantId','Tenant',tenants,a?.tenantId)+field('monthlyRent','Monthly rent','text',a?decimal(a.monthlyRentMinor):'',true,'inputmode="decimal"')+field('currency','Currency','text',a?.currency||'',true,'maxlength="3" pattern="[A-Z]{3}" placeholder="QAR"')+field('dueTerms','Due-date terms','text',a?.dueTerms||'',true,'maxlength="200" placeholder="Enter agreed terms"')+field('depositRequired','Security deposit required','text',a?decimal(a.depositRequiredMinor):name==='quick-agreement'?'':'0.00',true,'inputmode="decimal"')+field('startDate','Agreement start date','date')+field('endDate','Agreement end date (optional)','date','',false)+(name==='quick-agreement'?'<div class="field wide"><label class="operations-confirmation"><input type="checkbox" name="confirmTerms" value="confirmed" required> I confirm this tenant and these agreement terms. Historical room references alone do not establish them.</label></div>':'');}
 else if(name==='end-agreement'){title='End agreement';hidden={agreementId:a.id,expectedVersion:a.version};body=field('endDate','Agreement end date','date',a.endDate||'');}
 else if(name==='issue-due'||name==='quick-due'){title='Issue monthly due';actionName='issue-due';body=select('agreementId','Agreement',agreements,a?.id)+field('period','Rent month','month',c.quick?.period||report.month)+field('dueDate','Exact due date','date')+amount(a?decimal(a.monthlyRentMinor):'')+'<p class="muted-help">Enter the agreed obligation explicitly. No automatic proration or duplicate monthly issue.</p>';}
 else if(name==='record-collection'||name==='collect-due'){title='Record collection';actionName='record-collection';body=select('agreementId','Agreement',agreements,due?.agreementId)+select('kind','Collection purpose',[['rent','Rent'],['advance','Advance'],['deposit','Security deposit']],'rent')+select('method','Payment method',[['cash','Cash'],['bank','Bank'],['cheque','Cheque (pending only)']])+amount(due?decimal(due.outstandingMinor):'')+field('receivedDate','Received date','date',today())+field('reference','Reference (optional)','text','',false,'maxlength="200"')+select('dueId','Allocate rent to due',dues,due?.id,false)+'<p class="muted-help" id="rental-payment-note">Rent paid by cash/bank requires a selected due. Advances and deposits stay separate. Cheques are pending only.</p>';}
 else if(name==='allocate-advance'){title='Apply advance';hidden={collectionId:receipt.id};body=select('dueId','Rent due',dues.filter(([id])=>d.dues.find(d=>d.id===id)?.agreementId===receipt.agreementId))+amount()+field('allocationDate','Allocation date','date',today());}
 else if(name==='refund-deposit'){title='Refund deposit';body=select('agreementId','Agreement',agreements)+select('method','Refund method',[['cash','Cash'],['bank','Bank']])+amount()+field('receivedDate','Refund date','date',today())+field('reference','Reference (optional)','text','',false,'maxlength="200"');}
 if(title){const quick=c.quick&&(name==='quick-agreement'||name==='quick-due'||dialogContext?.action==='quick-summary')?{...c.quick}:null;show(title,`<div class="form-grid rental-form-grid">${body}</div>`,{c,action:actionName,hidden,trigger,pending:null,requiresTermsConfirmation:name==='quick-agreement',...(quick?{quick}:{})},trigger);if(actionName==='record-collection')updateCollectionDue();}
}
// Keep allocation choices aligned with the selected agreement. Amounts remain
// owner-entered; choosing a purpose or payment method never records a receipt.
function updateCollectionDue(){
 const state=dialogContext,form=modal()?.querySelector('form');if(state?.action!=='record-collection'||!form||!alive(state.c))return;
 const agreementId=form.elements.agreementId.value,kind=form.elements.kind.value,method=form.elements.method.value,due=form.elements.dueId,selected=due.value;
 const choices=state.c.data.dues.filter(row=>row.agreementId===agreementId&&BigInt(row.outstandingMinor)>0n);
 due.innerHTML='<option value="">Choose…</option>'+choices.map(row=>`<option value="${esc(row.id)}" ${row.id===selected?'selected':''}>${esc(row.period)} · ${esc(row.snapshot?.roomCode||'Room')} · ${cash(row.outstandingMinor,row.currency)}</option>`).join('');
 const allocated=kind==='rent'&&['cash','bank'].includes(method);due.required=allocated;due.disabled=!allocated;due.closest('.field').hidden=!allocated;
 const note=form.querySelector('#rental-payment-note');note.textContent=kind==='deposit'?'Security deposits stay separate from rent income.':kind==='advance'?'Advances stay unapplied until explicitly allocated to a rent due.':method==='cheque'?'This cheque stays pending. It does not pay a rent due until an approved clearance workflow is available.':allocated&&!choices.length?'No outstanding due for this agreement. Issue the agreed monthly due before recording a cash or bank rent payment.':'Choose the agreement’s outstanding due for cash or bank rent. Partial payments are supported.';
}
function show(title,body,state,trigger){
 let d=modal();if(!d){d=document.createElement('dialog');d.id='rental-dialog';d.setAttribute('aria-labelledby','rental-dialog-title');document.body.append(d);d.addEventListener('cancel',event=>{if(writeController)event.preventDefault();else{dialogContext=null;d.innerHTML='';trigger?.focus();}});}
 dialogContext=state;d.innerHTML=`<form id="rental-form"><header class="dialog-header"><div><span class="eyebrow">HAMDEE RENTAL REGISTER</span><h2 id="rental-dialog-title">${title}</h2></div><button type="button" class="icon-button" data-rental-action="close" aria-label="Close rental dialog">×</button></header><div class="rental-dialog-body">${body}</div><p id="rental-error" role="alert" tabindex="-1"></p><footer id="dialog-footer"><button type="button" class="button subtle" data-rental-action="close">${state?'Cancel':'Close'}</button>${state?'<button type="submit" class="button primary" id="rental-save">Save record</button>':''}</footer></form>`;d.showModal();
}
async function verifySession(button){
 const state=dialogContext;if(!state||writeController||state.verifying||!alive(state.c))return;
 const form=modal()?.querySelector('form'),save=form?.querySelector('#rental-save'),error=form?.querySelector('#rental-error');if(!form||!save||!error)return;
 state.verifying=true;button.disabled=true;save.disabled=true;form.setAttribute('aria-busy','true');error.textContent='Verifying session…';
 try{
  const verified=await state.c.verifyAccess();if(dialogContext!==state||!alive(state.c)||!verified)return;
  state.requiresVerification=false;button.remove();error.textContent='Session verified. Review your draft, then save explicitly.';error.focus();
 }catch(cause){
  if(dialogContext!==state||!alive(state.c))return;
  if(cause.status===401||cause.code==='OWNER_ACCESS_DENIED'){await state.c.onAccessLoss(cause);return;}
  error.textContent=cause.message+' Your draft is retained. Verify session to retry.';error.focus();
 }finally{if(dialogContext===state&&alive(state.c)){state.verifying=false;button.disabled=false;save.disabled=Boolean(state.requiresVerification);form.setAttribute('aria-busy','false');}}
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-rental-action]');if(!button)return;if(button.dataset.rentalAction==='verify-session'){void verifySession(button);return;}if(button.dataset.rentalAction==='close'){if(writeController)return;const trigger=dialogContext?.trigger;modal()?.close();if(modal())modal().innerHTML='';dialogContext=null;trigger?.focus();return;}open(button.dataset.rentalAction,button.dataset.id,button);});
document.addEventListener('change',event=>{if(event.target.closest('#rental-form')&&event.target.name==='quickAgreement'&&dialogContext?.action==='quick-summary'&&!writeController){const state=dialogContext;quickSummary(state.c,state.quick.roomId,state.quick.period,event.target.value,state.trigger);return;}if(event.target.closest('#rental-form')&&['agreementId','kind','method'].includes(event.target.name)&&!writeController&&!dialogContext?.pending?.uncertain)updateCollectionDue();});
document.addEventListener('submit',async event=>{
 if(event.target.matches('[data-rental-filter]')){event.preventDefault();if(!context||!alive(context))return;const c=context;report={...report,...Object.fromEntries(new FormData(event.target))};if(c.dashboard){await renderRentalDashboard(c.target,c);if(context&&alive(context))await c.onReportChange?.(rentalReportPeriod());}else await renderRental(c.target,c);return;}
 if(event.target.id!=='rental-form')return;event.preventDefault();const state=dialogContext;if(!state||writeController||state.verifying||state.requiresVerification||!alive(state.c))return;
 if(state.action==='quick-summary')return;
 if(state.action==='quick-month'){
  if(state.preparing)return;const period=event.target.elements.collectionMonth.value,error=modal().querySelector('#rental-error'),save=modal().querySelector('#rental-save');
  try{quickCollectionPlan(state.c.data,state.quick.roomId,period);}catch(cause){error.textContent=cause.message;return;}
  state.preparing=true;save.disabled=true;error.textContent='Loading the selected room and month…';
  try{
   const result=await state.c.api.rentalRead({month:period,asOf:report.asOf,propertyId:state.c.data.rooms.find(row=>row.id===state.quick.roomId).propertyId},state.c.signal);
   if(dialogContext!==state||!alive(state.c)||!await state.c.verifyAccess()||!alive(state.c))return;
   report={...report,month:period};modal().close();modal().innerHTML='';dialogContext=null;
   await renderRental(state.c.target,{...state.c,quick:{...state.quick,period},prefetchedRental:{ok:true,value:result}});
   if(context&&alive(context))quickSummary(context,state.quick.roomId,period,'',state.trigger);
  }catch(cause){if(dialogContext!==state||!alive(state.c))return;if(cause.status===401||cause.code==='OWNER_ACCESS_DENIED'){await state.c.onAccessLoss(cause);return;}error.textContent='The selected month could not be loaded. Your choice is retained; retry explicitly.';}
  finally{state.preparing=false;if(save.isConnected)save.disabled=false;}return;
 }
 let body={action:state.action,...state.hidden,...Object.fromEntries(new FormData(event.target))};
 if(state.requiresTermsConfirmation&&!event.target.elements.confirmTerms?.checked){document.querySelector('#rental-error').textContent='Confirm the tenant and agreement terms before saving.';return;}
 if(Object.hasOwn(body,'confirmTerms')){if(body.confirmTerms!=='confirmed'){document.querySelector('#rental-error').textContent='Confirm the tenant and agreement terms before saving.';return;}delete body.confirmTerms;}
 if(body.action==='create-agreement'){body.endDate=body.endDate||null;}
 if(body.action==='record-collection'){body.allocations=body.kind==='rent'&&body.method!=='cheque'?[{dueId:body.dueId,amount:body.amount}]:[];delete body.dueId;}
 if(state.pending?.uncertain)body=state.pending.body;
 const signature=JSON.stringify(body);if(state.pending?.signature!==signature)state.pending={signature,key:crypto.randomUUID(),body,uncertain:false};
 const controller=new window.AbortController();writeController=controller;const button=document.querySelector('#rental-save'),error=document.querySelector('#rental-error');button.disabled=true;error.textContent='';
 try{await state.c.api.rentalWrite(body,state.pending.key,controller.signal);if(dialogContext!==state||!alive(state.c)||controller.signal.aborted||!await state.c.verifyAccess()||!alive(state.c))return;
  writeController=null;modal().close();modal().innerHTML='';dialogContext=null;document.querySelector('#feedback').textContent=state.action==='allocate-advance'?'Advance applied to the selected due. No new cash receipt was created.':state.action==='record-collection'?'Receipt saved. Company cash or bank placement is a separate confirmed step in Company Finance.':state.action==='issue-due'?'Monthly rent due saved. No payment has been recorded.':state.action==='create-agreement'?'Agreement terms saved. A rent due and payment still require separate confirmation.':'Rental record saved.';await renderRental(state.c.target,state.c);if(state.quick&&context&&alive(context))quickSummary(context,state.quick.roomId,state.quick.period,state.quick.agreementId,state.trigger);
 }catch(cause){if(dialogContext!==state||!alive(state.c)||controller.signal.aborted)return;if(cause.status===401||cause.code==='MFA_REQUIRED'||cause.code==='OWNER_ACCESS_DENIED'){await state.c.onAccessLoss(cause);return;}
  state.pending.uncertain=state.pending.uncertain||Boolean(cause.uncertain);event.target.querySelectorAll('input,select').forEach(input=>input.disabled=state.pending.uncertain);error.textContent=cause.message+(state.pending.uncertain?' Retry Save record to confirm the same submission.':'');
  if(cause.code==='CSRF_REJECTED'){
   state.requiresVerification=true;error.textContent+=' Verify session, review your retained draft, then save explicitly.';
   let verify=modal().querySelector('[data-rental-action="verify-session"]');if(!verify){verify=document.createElement('button');verify.type='button';verify.className='button subtle';verify.dataset.rentalAction='verify-session';verify.textContent='Verify session';button.before(verify);}
  }
  error.focus();
 }finally{if(writeController===controller)writeController=null;if(button.isConnected)button.disabled=Boolean(state.requiresVerification||state.verifying);}
});
