import {esc,defaultCollectionMonth} from './rental.js';
let current=null;
const today=()=>new Date().toISOString().slice(0,10),amount=/^-?\d+(?:\.\d+)?$/;
const monthName=value=>new Date(value+'-01T00:00:00Z').toLocaleDateString('en-GB',{month:'short',year:'numeric',timeZone:'UTC'});
const shortMonthName=value=>new Date(value+'-01T00:00:00Z').toLocaleDateString('en-GB',{month:'short',timeZone:'UTC'}).slice(0,3)+value.slice(2,4);
const dateName=value=>value?new Date(value+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'}):null;
const icon=name=>typeof window.icon==='function'?window.icon(({'arrow-right':'arrow',refresh:'arrow',expenses:'document'})[name]||name):'';
const live=c=>current===c&&!c.controller.signal.aborted&&!c.signal.aborted&&c.isCurrent();
const verified=value=>typeof value==='string'&&amount.test(value);
export function formatOverviewAmount(value){
 if(!verified(value))return 'Not verified';
 const [whole,fraction]=value.split('.');
 return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+(fraction===undefined?'00':fraction.padEnd(2,'0'));
}
const money=(value,currency)=>verified(value)?`<span class="overview-money"><span class="overview-currency">${esc(currency)}</span> ${esc(formatOverviewAmount(value))}</span>`:'<span class="overview-unverified" aria-label="Not verified" title="Not verified · setup required">—</span>';
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
 return `<section class="overview-chart-card" aria-labelledby="overview-collection-title"><div class="overview-card-heading"><div><span class="overview-chart-kicker">RENT COLLECTIONS</span><h2 id="overview-collection-title">Collection Status</h2><p>Issued rent dues · ${esc(monthName(period))} <b class="overview-issued-value">${money(r?.expected,currency)}</b></p></div><a class="overview-detail-link" href="#collections" aria-label="Open rent collections">${icon('arrow-right')}</a></div><div class="overview-donut-content"><div class="overview-donut${hasDue?'':' overview-chart-empty'}"><svg viewBox="0 0 180 180" role="img" aria-label="${esc(label)}"><circle class="overview-donut-track" cx="90" cy="90" r="68"/>${hasDue?`<circle class="overview-donut-allocated" cx="90" cy="90" r="68" pathLength="100" stroke-dasharray="${share} 100" transform="rotate(-90 90 90)"/>`:''}</svg><div class="overview-donut-center"><small>${hasDue?'Allocated to rent':esc(monthName(period))}</small><strong>${hasDue?esc(formatOverviewAmount(r.allocated)):'No dues'}</strong><span>${hasDue?esc(currency):'confirmed yet'}</span></div></div><dl class="overview-donut-legend"><div><dt><i class="overview-dot allocated"></i>Allocated to rent</dt><dd>${money(r?.allocated,currency)}</dd></div><div><dt><i class="overview-dot pending"></i>Outstanding rent</dt><dd>${money(r?.outstanding,currency)}</dd></div>${hasDue?overdueStatus(row.operations,currency):'<p class="overview-empty-note"><span class="overview-sr-only">No confirmed issued dues. </span><a href="#properties">Confirm room terms →</a></p>'}</dl></div><div class="overview-rental-separation"><span>Unallocated advances <b>${money(r?.unappliedAdvances,currency)}</b></span><span>Deposits held <b>${money(r?.depositHeld,currency)}</b></span></div></section>`;
}
function activityChart(row,currency,basis){
 const points=row?.trend||[],count=points.length;
 if(!count)return `<section class="overview-chart-card overview-activity-card" aria-labelledby="overview-activity-title"><div class="overview-card-heading"><div><span class="overview-chart-kicker">SAVED ACTIVITY</span><h2 id="overview-activity-title">Recorded Activity</h2><p>Collections &amp; expenses</p></div>${chartLink('#reports','Open monthly reports')}</div><div class="overview-activity-empty"><svg viewBox="0 0 360 180" role="img" aria-label="No recorded activity. No financial values are plotted."><path class="overview-empty-grid" d="M20 28H340M20 68H340M20 108H340M20 148H340"/><text x="180" y="92" text-anchor="middle">No entries yet</text></svg><a href="#properties">Record a collection ${icon('arrow-right')}</a></div><div class="overview-activity-legend"><span><i class="overview-dot allocated"></i>Collections</span><span><i class="overview-dot cost"></i>Expenses</span></div></section>`;
 const history=count>=2,max=Math.max(...points.flatMap(point=>[visualNumber(point.collections)||0,visualNumber(point.expenses)||0]),1);
 const maxValue=points.flatMap(point=>[point.collections,point.expenses]).sort((a,b)=>(visualNumber(b)||0)-(visualNumber(a)||0))[0];
 const description=points.map(point=>`${monthName(point.month)}: ${currency} ${formatOverviewAmount(point.collections)} cash/bank receipts; ${currency} ${formatOverviewAmount(point.expenses)} recorded costs.`).join(' ');
 const width=360,height=180,left=32,right=12,top=18,bottom=38,plotHeight=height-top-bottom,step=(width-left-right)/count,barWidth=Math.min(26,step/3);
 return `<section class="overview-chart-card overview-activity-card" aria-labelledby="overview-activity-title"><div class="overview-card-heading"><div><span class="overview-chart-kicker">${history?'MONTHLY TREND':'SAVED ACTIVITY'}</span><h2 id="overview-activity-title">${history?'Monthly Collections vs Expenses':'Recorded Activity'}</h2><p>${history?count+' activity months': '1 available month · '+esc(monthName(points[0].month))}</p></div>${chartLink('#reports','Open monthly reports')}</div><div class="overview-activity-scale">${esc(currency)} · top ${esc(formatOverviewAmount(maxValue))}</div><svg class="overview-activity-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${history?'Monthly':'Single-month recorded'} cash/bank receipts and recorded property and vehicle costs in ${esc(currency)}" aria-describedby="overview-activity-description"><desc id="overview-activity-description">${esc(description)}</desc><line class="overview-chart-baseline" x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}"/>${points.map((point,index)=>{
  const x=left+step*(index+.5),receipts=visualNumber(point.collections)||0,costs=visualNumber(point.expenses)||0,rh=receipts/max*plotHeight,ch=costs/max*plotHeight;
  return `<g><rect class="overview-bar-receipts" x="${x-barWidth-2}" y="${height-bottom-rh}" width="${barWidth}" height="${rh}" rx="3"><title>${esc(monthName(point.month))} · ${esc(currency)} ${esc(formatOverviewAmount(point.collections))} cash/bank receipts</title></rect><rect class="overview-bar-expenses" x="${x+2}" y="${height-bottom-ch}" width="${barWidth}" height="${ch}" rx="3"><title>${esc(monthName(point.month))} · ${esc(currency)} ${esc(formatOverviewAmount(point.expenses))} recorded costs</title></rect><text class="overview-activity-month" x="${x}" y="${height-10}" text-anchor="middle">${esc(shortMonthName(point.month))}</text></g>`;
 }).join('')}</svg><div class="overview-activity-legend"><span><i class="overview-dot allocated"></i>Cash/bank receipts</span><span><i class="overview-dot cost"></i>Property &amp; vehicle costs</span></div><details class="overview-monthly-values"><summary>Exact monthly values</summary><ul>${points.map(point=>`<li><strong>${esc(monthName(point.month))}</strong><span>Cash/bank receipts ${money(point.collections,currency)}</span><span>Recorded costs ${money(point.expenses,currency)}</span></li>`).join('')}</ul></details><p class="overview-sr-only">${esc(basis.trendCollections)} ${esc(basis.expenses)}</p></section>`;
}
const chartLink=(path,label)=>`<a class="overview-detail-link" href="${path}" aria-label="${label}">${icon('arrow-right')}</a>`;
function fundsChart(row,currency,asOf){
 const values=[{label:'Cash',full:'Company cash',value:row?.companyCash,kind:'cash',path:'#company'},{label:'Bank',full:'Company bank',value:row?.companyBank,kind:'bank',path:'#company'},{label:'Staff-held',full:'Held by collectors',value:row?.operations?.staffHeld,kind:'staff',path:'#staff-collections'}];
 const coordinate=value=>{const n=verified(value)?Number(value):NaN;return Number.isFinite(n)?n:null;};
 const numbers=values.map(item=>coordinate(item.value)),hasValues=numbers.some(n=>n!==null),hasNegative=numbers.some(n=>n!==null&&n<0),hasPositive=numbers.some(n=>n!==null&&n>0),max=Math.max(...numbers.map(n=>Math.abs(n??0)),1);
 const top=14,bottom=146,zero=hasNegative?(hasPositive?80:top):bottom,width=360,height=166;
 const description=values.map(item=>item.full+': '+(verified(item.value)?currency+' '+formatOverviewAmount(item.value):'Not verified')).join('; ')+'. Separate money locations, not income or available profit.';
 return `<section class="overview-chart-card overview-funds-card" aria-labelledby="overview-funds-title"><div class="overview-card-heading"><div><span class="overview-chart-kicker">MONEY LOCATIONS</span><h2 id="overview-funds-title">Company Funds</h2><p>Separate balances · ${esc(dateName(asOf))}</p></div>${chartLink('#company','Open Company Finance')}</div><div class="overview-fund-values">${values.map(item=>`<a href="${item.path}" aria-label="${esc(item.full)}: ${esc(verified(item.value)?currency+' '+formatOverviewAmount(item.value):'Not verified')}"><small><i class="overview-fund-key ${item.kind}"></i>${item.label}</small><strong>${money(item.value,currency)}</strong></a>`).join('')}</div><svg class="overview-vertical-funds" viewBox="0 0 ${width} ${height}" role="img" aria-label="Company cash, company bank and staff-held balances in ${esc(currency)}" aria-describedby="overview-funds-description"><desc id="overview-funds-description">${esc(description)}</desc>${hasValues?`<line class="overview-funds-axis" x1="22" y1="${zero}" x2="346" y2="${zero}"/><text class="overview-funds-zero-label" x="4" y="${zero+5}">0</text>`:'<path class="overview-empty-grid" d="M22 26H346M22 66H346M22 106H346M22 146H346"/>'}${values.map((item,index)=>{
  const n=numbers[index],x=45+index*108,available=n!==null&&n<0?bottom-zero:zero-top,h=n===null?0:Math.abs(n)/max*available,y=n!==null&&n<0?zero:zero-h;
  return `<g class="overview-funds-column ${item.kind}${n!==null&&n<0?' negative':''}">${n===null?`<rect class="overview-placeholder-track" x="${x}" y="${top}" width="50" height="${bottom-top}" rx="6"/><text class="overview-funds-unknown" x="${x+25}" y="${top+75}" text-anchor="middle">—</text>`:`<rect x="${x}" y="${y}" width="50" height="${h}" rx="4"><title>${esc(item.full)} · ${esc(currency)} ${esc(formatOverviewAmount(item.value))}${n<0?' · negative balance':''}</title></rect>`}</g>`;
 }).join('')}</svg><p class="overview-funds-note">${hasNegative?'<span class="overview-negative-note">Negative balance shown below zero.</span> ':''}${hasValues?'Separate balances · not income or profit.':'<a href="#company">Set opening balances →</a>'}</p></section>`;
}

function operational(label,value,currency,note,path,glyph){
 return `<a class="overview-operation" href="${path}"><span class="overview-operation-icon">${icon(glyph)}</span><span class="overview-operation-copy"><span>${esc(label)}</span><strong>${money(value,currency)}</strong><small>${esc(note)}</small></span><span class="overview-operation-arrow" aria-hidden="true">↗</span></a>`;
}
function pendingCheques(o,currency){
 return `<div class="overview-operation"><span class="overview-operation-icon">${icon('cheques')}</span><span class="overview-operation-copy"><span>Pending cheques</span><strong>${money(o?.pendingCheques,currency)}</strong><small title="Incoming rent and car cheques through the reporting cutoff"><a href="#cheques">Rent ${money(o?.pendingRentCheques,currency)}</a> · <a href="#car-rentals">Car ${money(o?.pendingCarCheques,currency)}</a></small></span></div>`;
}
export function dailyDashboardMarkup(d,selectedCurrency=''){
 const rows=d.overview?.currencies||[],basis=d.overview?.basis||{},row=currencyRow(rows,selectedCurrency),currency=row?.currency||'',o=row?.operations;
 const upcomingNote=o?.upcomingCount?`${o.upcomingCount} issued ${o.upcomingCount===1?'due':'dues'} · next ${dateName(o.nextDueDate)||'date not verified'}`:row?.rent?.expected===null||!row?'Confirm issued rent terms':'No upcoming issued dues';
 const needsSetup=!row||[row.totalCollected,row.pendingCollection,row.companyCash,row.companyBank].some(value=>!verified(value));
 return `<div class="business-overview"><header class="overview-header"><div><span class="eyebrow">HAMDEE · DAILY OPERATIONS</span><h1>Business Overview</h1></div><a class="overview-primary-action" href="#properties">${icon('plus')}Record collection</a></header><form class="overview-filters" data-daily-filters aria-label="Business overview filters"><label>Month<input aria-label="Reporting month" type="month" name="month" value="${esc(d.month)}" required></label><label>Currency<select name="currency" aria-label="Reporting currency" ${rows.length?'':'disabled'}>${rows.length?rows.map(r=>`<option value="${esc(r.currency)}" ${r===row?'selected':''}>${esc(r.currency)}</option>`).join(''):'<option>Not set</option>'}</select></label><label>As of<input aria-label="Reporting cutoff" type="date" name="asOf" value="${esc(d.asOf)}" required></label><button type="submit" class="overview-update" aria-label="Update business overview">${icon('refresh')}<span>Update</span></button><span class="overview-live-badge"><i></i>Saved records</span></form>${needsSetup?'<aside class="overview-setup-notice" aria-label="Financial setup required"><span>'+icon('info')+'<strong>Finish your setup</strong><span>Unconfirmed figures appear as —.</span></span><nav aria-label="Complete financial setup"><a href="#properties">Confirm rent terms →</a><a href="#company">Set opening balances →</a></nav></aside>':''}<section class="overview-kpis" aria-label="Financial overview">${kpi('Total Collected',row?.totalCollected,currency,'Allocated to issued rent dues','#collections','collections',true)}${kpi('Pending Collection',row?.pendingCollection,currency,'Issued rent still outstanding','#collections','clock')}${kpi('Company Cash in Hand',row?.companyCash,currency,'Confirmed company cash','#company','wallet')}${kpi('Company Bank Balance',row?.companyBank,currency,'Confirmed company accounts','#company','company')}${kpi('Monthly Expenses',row?.monthlyExpenses,currency,'Recorded property & vehicle costs','#expenses','expenses')}</section><div class="overview-charts overview-three-charts">${collectionChart(row,currency,d.month)}${fundsChart(row,currency,d.asOf)}${activityChart(row,currency,basis)}</div><section class="overview-operations" aria-label="Operational indicators">${operational('Car rental collections',o?.carCollected,currency,'Cash/bank receipts · selected month','#car-rentals','briefcase')}${operational('Money held by staff',o?.staffHeld,currency,'Custody balance','#staff-collections','partners')}${pendingCheques(o,currency)}${operational('Upcoming rent dues',o?.upcomingAmount,currency,upcomingNote,'#collections','calendar')}</section><div class="overview-footnote"><span>${icon('lock')}Personal finance stays separate.</span><details><summary>Reporting basis</summary><div><p><strong>Total Collected:</strong> ${esc(basis.totalCollected||'Confirm issued rental dues before totals are available.')}</p><p><strong>Trend:</strong> ${esc(basis.trendCollections||'Original saved cash/bank rent and car receipts by actual receipt date; no advances, deposits, transfers or handovers.')}</p><p><strong>Expenses:</strong> ${esc(basis.expenses||'Recorded property and vehicle costs by expense date, not distributable profit.')}</p><p><strong>Balances:</strong> ${esc(basis.balances||'Confirmed company account openings and saved movements; no opening balance is assumed.')}</p><a href="#company">${d.accounts?.companySetupRequired?'Set up company accounts':'Open Company Finance'}</a> · <a href="#reports">Monthly reports</a></div></details></div></div>`;
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
 c.target.innerHTML=dailyDashboardMarkup(d,c.currency);
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

}
async function read(c){
 if(!live(c))return;c.target.setAttribute('aria-busy','true');c.target.innerHTML='<div class="overview-loading" role="status"><span class="eyebrow">HAMDEE · DAILY OPERATIONS</span><h1>Business Overview</h1><p>Loading saved business figures…</p></div>';
 try{
  const result=await c.api.operationsDashboard({month:c.month,asOf:c.asOf},c.controller.signal);if(!live(c))return;
  if(!await c.verifyAccess()){if(live(c))clear(c);return;}if(!live(c))return;
  paint(c,validate(result,c));
 }catch(error){
  if(!live(c))return;if(error.status===401||(error.status===403&&error.code!=='CSRF_REJECTED')||error.code==='OWNER_ACCESS_DENIED'){clear(c);await c.onAccessLoss(error);return;}
  c.target.innerHTML='<section class="overview-loading" role="status"><span class="eyebrow">HAMDEE · DAILY OPERATIONS</span><h1>Business Overview</h1><h2>Saved overview unavailable</h2><p>Your villas and existing modules remain available. No unverified balances are shown.</p><button class="button subtle" type="button" data-daily-retry>Retry business overview</button><a class="button subtle" href="#properties">Open Villas &amp; Properties</a></section>';c.target.querySelector('[data-daily-retry]').addEventListener('click',()=>{if(live(c))void read(c);});
 }finally{if(live(c))c.target.setAttribute('aria-busy','false');}
}
export async function renderDailyDashboard(target,options){
 resetDailyDashboard();const date=today();
 const c={...options,target,month:options.month||defaultCollectionMonth(date),asOf:options.asOf||date,currency:options.currency||'',controller:new window.AbortController(),onAbort:null};
 c.onAbort=()=>clear(c);current=c;c.signal.addEventListener('abort',c.onAbort,{once:true});if(!live(c)){clear(c);return;}await read(c);
}
