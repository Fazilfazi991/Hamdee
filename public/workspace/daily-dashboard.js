import {esc,defaultCollectionMonth} from './rental.js';
let current=null;
const today=()=>new Date().toISOString().slice(0,10),amount=/^-?\d+(?:\.\d+)?$/;
const monthName=value=>new Date(value+'-01T00:00:00Z').toLocaleDateString('en-GB',{month:'short',year:'numeric',timeZone:'UTC'});
const shortMonthName=value=>new Date(value+'-01T00:00:00Z').toLocaleDateString('en-GB',{month:'short',year:'2-digit',timeZone:'UTC'});
const dateName=value=>value?new Date(value+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'}):null;
const icon=name=>typeof window.icon==='function'?window.icon(({'arrow-right':'arrow',refresh:'arrow',expenses:'document'})[name]||name):'';
const live=c=>current===c&&!c.controller.signal.aborted&&!c.signal.aborted&&c.isCurrent();
const verified=value=>typeof value==='string'&&amount.test(value);
export function formatOverviewAmount(value){
 if(!verified(value))return 'Not verified';
 const [whole,fraction]=value.split('.');
 return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+(fraction===undefined?'00':fraction.padEnd(2,'0'));
}
const money=(value,currency)=>verified(value)?`<span class="overview-money"><span class="overview-currency">${esc(currency)}</span> ${esc(formatOverviewAmount(value))}</span>`:'<span class="overview-unverified">Not verified</span>';
const visualNumber=value=>{const n=verified(value)?Number(value):NaN;return Number.isFinite(n)&&n>=0?n:null;};
const currencyRow=(rows,selected)=>rows.find(row=>row.currency===selected)||rows.find(row=>verified(row.rent?.expected))||rows[0];
function clear(c){c.controller.abort();c.signal.removeEventListener('abort',c.onAbort);c.target.innerHTML='';if(current===c)current=null;}
export function resetDailyDashboard(){if(current)clear(current);}
function kpi(label,value,currency,note,path,glyph,primary=false){
 return `<a class="overview-kpi${primary?' overview-kpi-primary':''}" href="${path}" aria-label="${esc(label)}: ${esc(verified(value)?currency+' '+formatOverviewAmount(value):'Not verified')}. ${esc(note)}"><span class="overview-kpi-label">${esc(label)}${icon(glyph)}</span><strong>${money(value,currency)}</strong><span class="overview-kpi-note">${esc(note)}</span></a>`;
}
function overdueStatus(o,currency){
 if(o?.overdueCount>0&&verified(o.overdueAmount))return `<div class="overview-overdue"><dt>${icon('warning')}Overdue rent</dt><dd>${money(o.overdueAmount,currency)}<small>${esc(o.overdueCount)} ${o.overdueCount===1?'due':'dues'} · since ${esc(dateName(o.oldestOverdueDate)||'date not verified')}</small></dd></div>`;
 return verified(o?.overdueAmount)?'<p class="overview-current-note">No overdue dues at this cutoff</p>':'';
}
function collectionChart(row,currency,period){
 const r=row?.rent,expected=visualNumber(r?.expected),allocated=visualNumber(r?.allocated),outstanding=visualNumber(r?.outstanding);
 const hasDue=expected!==null&&expected>0&&allocated!==null&&outstanding!==null;
 // Ratios only position SVG marks; displayed money stays the exact server string.
 const share=hasDue?Math.min(100,Math.max(0,allocated/expected*100)):0;
 const label=hasDue?`${currency} ${formatOverviewAmount(r.allocated)} allocated and ${formatOverviewAmount(r.outstanding)} outstanding against ${formatOverviewAmount(r.expected)} issued rent dues.`:'No confirmed issued rent dues for this month and currency.';
 return `<section class="overview-chart-card" aria-labelledby="overview-collection-title"><div class="overview-card-heading"><div><h2 id="overview-collection-title">Collection Status</h2><p>Issued rent dues · ${esc(monthName(period))}</p></div><a class="overview-detail-link" href="#collections" aria-label="Open rent collections">${icon('arrow-right')}</a></div><div class="overview-donut-content"><div class="overview-donut"><svg viewBox="0 0 180 180" role="img" aria-label="${esc(label)}"><circle class="overview-donut-track" cx="90" cy="90" r="68"/><circle class="overview-donut-allocated" cx="90" cy="90" r="68" pathLength="100" stroke-dasharray="${share} 100" transform="rotate(-90 90 90)"/></svg><div class="overview-donut-center"><small>${hasDue?'Allocated to rent':'Rent terms'}</small><strong>${hasDue?esc(formatOverviewAmount(r.allocated)):'Not verified'}</strong><span>${hasDue?esc(currency):'Confirm issued dues'}</span></div></div><dl class="overview-donut-legend"><div><dt><i class="overview-dot allocated"></i>Issued rent</dt><dd>${money(r?.expected,currency)}</dd></div><div><dt><i class="overview-dot pending"></i>Outstanding rent</dt><dd>${money(r?.outstanding,currency)}</dd></div>${hasDue?overdueStatus(row.operations,currency):'<p class="overview-empty-note">No confirmed issued dues. <a href="#properties">Confirm room terms</a> to begin.</p>'}</dl></div><div class="overview-rental-separation"><span>Unallocated advances <b>${money(r?.unappliedAdvances,currency)}</b></span><span>Deposits held <b>${money(r?.depositHeld,currency)}</b></span></div></section>`;
}
function trendChart(row,currency,basis){
 const trend=row?.trend||[],ready=row?.trendReady===true&&trend.length>=2;
 let content='<div class="overview-trend-empty"><span class="overview-empty-icon">'+icon('reports')+'</span><strong>Not enough verified history</strong><p>Saved cash/bank receipts and recorded costs appear when at least two months have activity.</p></div>';
 if(ready){
  const max=Math.max(...trend.flatMap(point=>[visualNumber(point.collections)||0,visualNumber(point.expenses)||0]),1);
  const scaleValue=trend.flatMap(point=>[point.collections,point.expenses]).sort((a,b)=>(visualNumber(b)||0)-(visualNumber(a)||0))[0];
  const exactValues=trend.map(point=>`${monthName(point.month)}: ${currency} ${formatOverviewAmount(point.collections)} cash/bank collections; ${currency} ${formatOverviewAmount(point.expenses)} recorded costs.`).join(' ');
  const width=560,height=172,left=16,right=12,top=30,bottom=36,chartHeight=height-top-bottom,step=(width-left-right)/trend.length,barWidth=Math.min(24,step/3);
  content=`<svg class="overview-bar-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly cash and bank collections versus recorded property and vehicle costs in ${esc(currency)}. Months with no source activity are omitted." aria-describedby="overview-trend-values"><desc id="overview-trend-values">${esc(exactValues)}</desc><text class="overview-chart-scale" x="${left}" y="20">${esc(currency)} · top ${esc(formatOverviewAmount(scaleValue))}</text><line class="overview-chart-baseline" x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}"/><text class="overview-chart-scale" x="${left}" y="${height-bottom+15}">0</text>${trend.map((point,index)=>{
   const x=left+step*(index+.5),collected=visualNumber(point.collections)||0,expenses=visualNumber(point.expenses)||0,ch=collected/max*chartHeight,eh=expenses/max*chartHeight;
   return `<g><rect class="overview-bar-receipts" x="${x-barWidth-2}" y="${height-bottom-ch}" width="${barWidth}" height="${ch}" rx="3"><title>${esc(monthName(point.month))}: ${esc(currency)} ${esc(formatOverviewAmount(point.collections))} cash/bank collections</title></rect><rect class="overview-bar-expenses" x="${x+2}" y="${height-bottom-eh}" width="${barWidth}" height="${eh}" rx="3"><title>${esc(monthName(point.month))}: ${esc(currency)} ${esc(formatOverviewAmount(point.expenses))} recorded property &amp; vehicle costs</title></rect><text class="overview-chart-month overview-chart-month-full" x="${x}" y="${height-12}" text-anchor="middle">${esc(monthName(point.month))}</text><text class="overview-chart-month overview-chart-month-short" x="${x}" y="${height-12}" text-anchor="middle" aria-hidden="true">${esc(shortMonthName(point.month))}</text></g>`;
  }).join('')}</svg><details class="overview-monthly-values"><summary>View monthly values</summary><ul>${trend.map(point=>`<li><strong>${esc(monthName(point.month))}</strong><span>Cash/bank collections ${money(point.collections,currency)}</span><span>Recorded costs ${money(point.expenses,currency)}</span></li>`).join('')}</ul></details>`;
 }
 return `${content}<div class="overview-trend-footer"><span><i class="overview-dot allocated"></i>Cash/bank collections</span><span><i class="overview-dot cost"></i>Recorded costs</span><small>${ready?'Activity months only · '+esc(currency):'No invented prior-month figures'}</small></div><p class="overview-sr-only">${esc(basis.trendCollections)} ${esc(basis.expenses)}</p>`;
}
function fundsComparison(row,currency){
 const locations=[['Company cash',row?.companyCash,'#company','cash'],['Company bank',row?.companyBank,'#company','bank'],['Held by collectors',row?.operations?.staffHeld,'#staff-collections','staff']];
 const position=value=>{const n=verified(value)?Number(value):NaN;return Number.isFinite(n)?n:null;};
 const max=Math.max(...locations.map(([,value])=>Math.abs(position(value)??0)),1);
 return `<div class="overview-funds-comparison" aria-label="Separate company cash, company bank and collector custody balances">${locations.map(([label,value,path,kind])=>{
  const n=position(value),width=n===null?0:Math.min(148,Math.abs(n)/max*148),x=n!==null&&n<0?150-width:150;
  return `<a class="overview-funds-row" href="${path}"><span class="overview-funds-label">${esc(label)}</span><strong>${money(value,currency)}</strong><svg class="overview-funds-bar ${kind}${n!==null&&n<0?' negative':''}" viewBox="0 0 300 12" aria-hidden="true"><line class="overview-funds-track" x1="2" y1="6" x2="298" y2="6"/><line class="overview-funds-zero" x1="150" y1="0" x2="150" y2="12"/>${n===null?'':`<rect x="${x}" y="3" width="${width}" height="6" rx="3"/>`}</svg>${n!==null&&n<0?'<small>Negative balance</small>':''}</a>`;
 }).join('')}</div><p class="overview-funds-note">Separate locations · not income or available profit.</p>`;
}
function comparisonChart(row,currency,basis,asOf,requestedView){
 const ready=row?.trendReady===true&&row.trend.length>=2,view=ready&&requestedView==='trend'?'trend':'funds';
 return `<section class="overview-chart-card overview-comparison-card" aria-labelledby="overview-comparison-title"><div class="overview-card-heading"><div><h2 id="overview-comparison-title">${view==='trend'?'Monthly Collections vs Expenses':'Company Funds'}</h2><p>${view==='trend'?'Receipt-date cash/bank collections · recorded costs':'Cash, bank & collector custody · '+esc(dateName(asOf))}</p></div><div class="overview-chart-switch" role="group" aria-label="Comparison view" data-chart-switch><button type="button" data-overview-view="funds" aria-pressed="${view==='funds'}">Funds</button><button type="button" data-overview-view="trend" aria-pressed="${view==='trend'}" ${ready?'':'disabled'} title="${ready?'View saved monthly collections and costs':'Requires at least two activity months'}">Monthly trend</button></div></div>${view==='trend'?trendChart(row,currency,basis):fundsComparison(row,currency)}${ready?'':'<span class="overview-history-note">Monthly trend needs two activity months.</span>'}</section>`;
}
function operational(label,value,currency,note,path,glyph){
 return `<a class="overview-operation" href="${path}"><span class="overview-operation-icon">${icon(glyph)}</span><span class="overview-operation-copy"><span>${esc(label)}</span><strong>${money(value,currency)}</strong><small>${esc(note)}</small></span><span class="overview-operation-arrow" aria-hidden="true">↗</span></a>`;
}
function pendingCheques(o,currency){
 return `<div class="overview-operation"><span class="overview-operation-icon">${icon('cheques')}</span><span class="overview-operation-copy"><span>Pending cheques</span><strong>${money(o?.pendingCheques,currency)}</strong><small>Incoming only · through cutoff<br><a href="#cheques">Rent ${money(o?.pendingRentCheques,currency)}</a> · <a href="#car-rentals">Car ${money(o?.pendingCarCheques,currency)}</a></small></span></div>`;
}
export function dailyDashboardMarkup(d,selectedCurrency='',chartView='funds'){
 const rows=d.overview?.currencies||[],basis=d.overview?.basis||{},row=currencyRow(rows,selectedCurrency),currency=row?.currency||'',o=row?.operations;
 const upcomingNote=o?.upcomingCount?`${o.upcomingCount} issued ${o.upcomingCount===1?'due':'dues'} · next ${dateName(o.nextDueDate)||'date not verified'}`:row?.rent?.expected===null||!row?'Confirm issued rent terms':'No upcoming issued dues';
 return `<div class="business-overview"><header class="overview-header"><div><span class="eyebrow">HAMDEE BUSINESS</span><h1>Business Overview</h1><p>Collections, funds and daily priorities.</p></div><form class="overview-filters" data-daily-filters aria-label="Business overview filters"><label>Month<input aria-label="Reporting month" type="month" name="month" value="${esc(d.month)}" required></label><label>Currency<select name="currency" aria-label="Reporting currency" ${rows.length?'':'disabled'}>${rows.length?rows.map(r=>`<option value="${esc(r.currency)}" ${r===row?'selected':''}>${esc(r.currency)}</option>`).join(''):'<option>No verified currency</option>'}</select></label><label>As of<input aria-label="Reporting cutoff" type="date" name="asOf" value="${esc(d.asOf)}" required></label><button type="submit" class="overview-update" aria-label="Update business overview">${icon('refresh')}<span>Update</span></button></form></header><section class="overview-kpis" aria-label="Financial overview">${kpi('Total Collected',row?.totalCollected,currency,'Allocated to issued rent dues','#collections','collections',true)}${kpi('Pending Collection',row?.pendingCollection,currency,'Issued rent still outstanding','#collections','clock')}${kpi('Company Cash in Hand',row?.companyCash,currency,'Confirmed company cash','#company','wallet')}${kpi('Company Bank Balance',row?.companyBank,currency,'Confirmed company accounts','#company','company')}${kpi('Monthly Expenses',row?.monthlyExpenses,currency,'Recorded property & vehicle costs','#expenses','expenses')}</section><div class="overview-charts">${collectionChart(row,currency,d.month)}${comparisonChart(row,currency,basis,d.asOf,chartView)}</div><section class="overview-operations" aria-label="Operational indicators">${operational('Car rental collections',o?.carCollected,currency,'Recorded receipts · selected month','#car-rentals','briefcase')}${operational('Money held by staff',o?.staffHeld,currency,'Custody balance','#staff-collections','partners')}${pendingCheques(o,currency)}${operational('Upcoming rent dues',o?.upcomingAmount,currency,upcomingNote,'#collections','calendar')}</section><div class="overview-footnote"><span>${icon('lock')}Personal finance stays separate.</span><details><summary>Reporting basis</summary><div><p><strong>Total Collected:</strong> ${esc(basis.totalCollected||'Confirm issued rental dues before totals are available.')}</p><p><strong>Trend:</strong> ${esc(basis.trendCollections||'Original saved cash/bank rent and car receipts by actual receipt date; no advances, deposits, transfers or handovers.')}</p><p><strong>Expenses:</strong> ${esc(basis.expenses||'Recorded property and vehicle costs by expense date, not distributable profit.')}</p><p><strong>Balances:</strong> ${esc(basis.balances||'Confirmed company account openings and saved movements; no opening balance is assumed.')}</p><a href="#company">${d.accounts?.companySetupRequired?'Set up company accounts':'Open Company Finance'}</a> · <a href="#reports">Monthly reports</a></div></details></div></div>`;
}
function validate(result,c){
 const d=result?.data,overview=d?.overview;
 if(!d||d.month!==c.month||d.asOf!==c.asOf||d.moneyUnit!=='decimal-major-unit-strings'||d.overviewVersion!==1||!overview||!Array.isArray(overview.currencies)||!overview.basis||!['totalCollected','trendCollections','expenses','balances'].every(key=>typeof overview.basis[key]==='string'))throw new Error('Business overview is unavailable');
 const keys=new Set();
 for(const row of overview.currencies){
  if(!/^[A-Z]{3}$/.test(row.currency)||keys.has(row.currency)||!row.rent||!row.operations||typeof row.trendReady!=='boolean'||!Array.isArray(row.trend))throw new Error('Business overview is unavailable');keys.add(row.currency);
  const values=[row.totalCollected,row.pendingCollection,row.companyCash,row.companyBank,row.monthlyExpenses,...['expected','allocated','outstanding','unappliedAdvances','depositHeld','pendingCheques'].map(key=>row.rent[key]),...['carCollected','staffHeld','pendingCheques','pendingRentCheques','pendingCarCheques','upcomingAmount'].map(key=>row.operations[key])];
  if(!values.every(value=>value===null||verified(value))||!Number.isSafeInteger(row.operations.upcomingCount)||row.operations.upcomingCount<0||!(row.operations.nextDueDate===null||/^\d{4}-\d{2}-\d{2}$/.test(row.operations.nextDueDate))||!row.trend.every(point=>/^\d{4}-\d{2}$/.test(point.month)&&verified(point.collections)&&verified(point.expenses)))throw new Error('Business overview is unavailable');
  if(['overdueAmount','overdueCount','oldestOverdueDate'].some(key=>Object.hasOwn(row.operations,key))&&
    (!(row.operations.overdueAmount===null||verified(row.operations.overdueAmount))||!Number.isSafeInteger(row.operations.overdueCount)||row.operations.overdueCount<0||!(row.operations.oldestOverdueDate===null||/^\d{4}-\d{2}-\d{2}$/.test(row.operations.oldestOverdueDate))))throw new Error('Business overview is unavailable');
 }
 return d;
}
function paint(c,d,draft=null){
 if(!live(c))return;c.currency=currencyRow(d.overview.currencies,c.currency)?.currency||'';
 const row=currencyRow(d.overview.currencies,c.currency);if(!row?.trendReady||row.trend.length<2)c.chartView='funds';
 c.target.innerHTML=dailyDashboardMarkup(d,c.currency,c.chartView);
 // A view/currency change must not discard unsubmitted date filters or claim
 // that the cached summary belongs to those unsubmitted dates.
 for(const name of ['month','asOf'])if(draft?.get(name))c.target.querySelector(`[name="${name}"]`).value=String(draft.get(name));
 c.target.querySelector('[data-daily-filters]').addEventListener('submit',event=>{event.preventDefault();if(!live(c))return;const fields=new FormData(event.target);c.month=String(fields.get('month'));c.asOf=String(fields.get('asOf'));c.currency=String(fields.get('currency')||'');void read(c);});
 c.target.querySelector('[name="currency"]').addEventListener('change',event=>{
  if(!live(c))return;
  const draft=event.target.form?new FormData(event.target.form):null;
  c.currency=event.target.value;paint(c,d,draft);
  c.target.querySelector('[name="currency"]').focus();
 });
 c.target.querySelector('[data-chart-switch]')?.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-overview-view]');if(!button||!live(c))return;
  const view=button.dataset.overviewView;if(!['funds','trend'].includes(view))return;
  const form=c.target.querySelector('[data-daily-filters]'),draft=form?new FormData(form):null;
  c.chartView=view;paint(c,d,draft);c.target.querySelector(`[data-overview-view="${c.chartView}"]`)?.focus();
 });
}
async function read(c){
 if(!live(c))return;c.target.setAttribute('aria-busy','true');c.target.innerHTML='<div class="overview-loading" role="status"><span class="eyebrow">HAMDEE · DAILY OPERATIONS</span><h1>Business Overview</h1><p>Loading saved business figures…</p></div>';
 try{
  const result=await c.api.operationsDashboard({month:c.month,asOf:c.asOf},c.controller.signal);if(!live(c))return;
  if(!await c.verifyAccess()){if(live(c))clear(c);return;}if(!live(c))return;
  paint(c,validate(result,c));
 }catch(error){
  if(!live(c))return;if(error.status===401||error.code==='OWNER_ACCESS_DENIED'){clear(c);await c.onAccessLoss(error);return;}
  c.target.innerHTML='<section class="overview-loading" role="status"><span class="eyebrow">HAMDEE · DAILY OPERATIONS</span><h1>Business Overview</h1><h2>Saved overview unavailable</h2><p>Your villas and existing modules remain available. No unverified balances are shown.</p><button class="button subtle" type="button" data-daily-retry>Retry business overview</button><a class="button subtle" href="#properties">Open Villas &amp; Properties</a></section>';c.target.querySelector('[data-daily-retry]').addEventListener('click',()=>{if(live(c))void read(c);});
 }finally{if(live(c))c.target.setAttribute('aria-busy','false');}
}
export async function renderDailyDashboard(target,options){
 resetDailyDashboard();const date=today();
 const c={...options,target,month:options.month||defaultCollectionMonth(date),asOf:options.asOf||date,currency:options.currency||'',chartView:options.chartView==='trend'?'trend':'funds',controller:new window.AbortController(),onAbort:null};
 c.onAbort=()=>clear(c);current=c;c.signal.addEventListener('abort',c.onAbort,{once:true});if(!live(c)){clear(c);return;}await read(c);
}
