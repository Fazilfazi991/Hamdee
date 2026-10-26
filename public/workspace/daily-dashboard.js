import {esc,panel,table,defaultCollectionMonth} from './rental.js';
let current=null;
const today=()=>new Date().toISOString().slice(0,10);
const money=(value,currency)=>value===null||value===undefined?'<span class="badge amber">Not verified</span>':`${esc(currency)} ${esc(value)}`;
const link=(name,path)=>`<a class="button subtle" href="${esc(path)}">${esc(name)}</a>`;
const live=c=>current===c&&!c.controller.signal.aborted&&!c.signal.aborted&&c.isCurrent();
function clear(c){c.controller.abort();c.signal.removeEventListener('abort',c.onAbort);c.target.innerHTML='';if(current===c)current=null;}
export function resetDailyDashboard(){if(current)clear(current);}
export function dailyDashboardMarkup(d){
 const company=d.accounts.company;
 return `<form class="toolbar rental-filters" data-daily-filters><label>Collection month<input type="month" name="month" value="${esc(d.month)}" required></label><label>Balances through<input type="date" name="asOf" value="${esc(d.asOf)}" required></label><button type="submit" class="button subtle">Update daily overview</button></form>`+
 panel('Company cash & bank','Saved company accounts only. Staff-held money, deposits and personal finances remain separately identified.',table(['Company account','Type','Currency','Saved balance'],company.map(row=>[esc(row.name),esc(row.kind),esc(row.currency),money(row.balance,row.currency)]),'Company account balances'),link(d.accounts.companySetupRequired?'Set up company accounts':'Open Company Finance','#company'))+
 (d.accounts.companySetupRequired?'<p class="operations-notice" role="status">Company account setup is required. Confirm the account, currency, opening date and opening amount in Company Finance; no opening balance is assumed.</p>':'')+
 panel('Company funds by currency','Cash, bank and collector custody are separate figures; no combined or distributable-profit balance is inferred.',table(['Currency','Company cash','Company bank','Held by collectors'],d.balances.map(row=>[esc(row.currency),money(row.companyCash,row.currency),money(row.companyBank,row.currency),money(row.staffHeld,row.currency)]),'Company funds by currency'))+
 panel('Monthly rent','Confirmed issued dues and their saved allocations for '+esc(d.month)+'. Earlier advances can be applied explicitly; deposits are not rent income.',table(['Currency','Rent due','Allocated to rent','Outstanding','Unapplied advances','Deposits held','Pending cheques'],d.rent.map(row=>[esc(row.currency),money(row.expected,row.currency),money(row.allocated,row.currency),money(row.outstanding,row.currency),money(row.unappliedAdvances,row.currency),money(row.depositHeld,row.currency),money(row.pendingCheques,row.currency)]),'Daily rent overview'),link('Collect rent in a villa','#properties'))+
 panel('Property expenses','Recorded cost obligations, confirmed payments and pending cheques remain distinct.',table(['Currency','Recorded costs','Paid','Pending cheques'],d.expenses.map(row=>[esc(row.currency),money(row.recorded,row.currency),money(row.paid,row.currency),money(row.pendingCheques,row.currency)]),'Daily property expenses'),link('Open expenses','#expenses'))+
 panel('Staff-held collections','Custody remaining with each collector. A handover moves existing money; it does not create income.',table(['Collector','Currency','Held amount'],d.staff.map(row=>[esc(row.name),esc(row.currency),money(row.balance,row.currency)]),'Daily collector custody'),link('Open Staff Collections','#staff-collections'))+
 panel('Recent rental receipts','Receipt dates and classifications are shown as saved. Deposits, advances and pending cheques are not relabeled as paid rent.',table(['Villa / room','Tenant','Received','Purpose','Method / status','Amount'],d.recentCollections.map(row=>[`<a class="link" href="#properties/${esc(row.propertyId)}/collections">${esc(row.propertyName)} · ${esc(row.roomCode)}</a>`,esc(row.tenantName),esc(row.date),esc(row.kind),esc(row.method)+' · '+esc(row.status),money(row.amount,row.currency)]),'Recent rental receipts'))+
 panel('Upcoming rent dues','Only issued obligations appear here. Historical October amounts do not create new agreements or monthly dues.',table(['Villa / room','Tenant','Rent month','Due date','Due','Allocated','Outstanding'],d.upcomingDues.map(row=>[`<a class="link" href="#properties/${esc(row.propertyId)}/collections">${esc(row.propertyName)} · ${esc(row.roomCode)}</a>`,esc(row.tenantName),esc(row.period),esc(row.dueDate),money(row.amount,row.currency),money(row.paid,row.currency),money(row.outstanding,row.currency)]),'Upcoming rental dues'))+
 `<p class="muted-help">${esc(d.basis)} Personal accounts stay in ${link('Personal Finance','#personal-finance')}.</p>`;
}
function validate(result,c){
 const d=result?.data;
 if(!d||d.month!==c.month||d.asOf!==c.asOf||d.moneyUnit!=='decimal-major-unit-strings'||!d.accounts||!Array.isArray(d.accounts.company)||typeof d.accounts.companySetupRequired!=='boolean'||!['balances','rent','expenses','staff','recentCollections','upcomingDues'].every(key=>Array.isArray(d[key]))||typeof d.basis!=='string')throw new Error('Daily overview is unavailable');
 return d;
}
async function read(c){
 if(!live(c))return;c.target.setAttribute('aria-busy','true');c.target.innerHTML='<div class="empty" role="status">Loading saved daily operations…</div>';
 try{
  const result=await c.api.operationsDashboard({month:c.month,asOf:c.asOf},c.controller.signal);if(!live(c))return;
  if(!await c.verifyAccess()){if(live(c))clear(c);return;}if(!live(c))return;
  c.target.innerHTML=dailyDashboardMarkup(validate(result,c));
  c.target.querySelector('[data-daily-filters]').addEventListener('submit',event=>{event.preventDefault();if(!live(c))return;const fields=new FormData(event.target);c.month=String(fields.get('month'));c.asOf=String(fields.get('asOf'));void read(c);});
 }catch(error){
  if(!live(c))return;if(error.status===401||error.code==='OWNER_ACCESS_DENIED'){clear(c);await c.onAccessLoss(error);return;}
  c.target.innerHTML=panel('Daily overview unavailable','Your villas and existing modules remain available. Retry to load the saved operational figures.','',`<button class="button subtle" type="button" data-daily-retry>Retry daily overview</button>`);c.target.querySelector('[data-daily-retry]').addEventListener('click',()=>{if(live(c))void read(c);});
 }finally{if(live(c))c.target.setAttribute('aria-busy','false');}
}
export async function renderDailyDashboard(target,options){
 resetDailyDashboard();const date=today();
 const c={...options,target,month:options.month||defaultCollectionMonth(date),asOf:options.asOf||date,controller:new window.AbortController(),onAbort:null};
 c.onAbort=()=>clear(c);current=c;c.signal.addEventListener('abort',c.onAbort,{once:true});if(!live(c)){clear(c);return;}await read(c);
}
