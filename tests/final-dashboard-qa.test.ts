import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOwnerQaFixture} from './support/owner-crm-harness';

// Independent Phase 1/2 acceptance: disposable loopback records only. Rendering
// reads the actual authorized aggregate; it never supplies financial authority.
type Fixture=Awaited<ReturnType<typeof createOwnerQaFixture>>;
type Saved={id:string;[key:string]:unknown};
type Money=string|null;
interface Currency {
 currency:string;totalCollected:Money;pendingCollection:Money;companyCash:Money;companyBank:Money;
 operations:{staffHeld:Money;overdueAmount:Money;overdueCount:number;oldestOverdueDate:string|null;upcomingAmount:Money;upcomingCount:number};
}
interface Overview {overviewVersion:number;month:string;asOf:string;overview:{currencies:Currency[]};[key:string]:unknown}
const base='/api/hamdee/v1';
async function result<T>(response:Response){const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data.data as T;}
async function setup(t:TestContext){const f=await createOwnerQaFixture({migrationFiles:['006_local_operations_records.up.sql']});t.after(()=>f.close());await f.login();return f;}
async function write(f:Fixture,path:string,body:Record<string,unknown>){return result<Saved>(await f.request('POST',base+'/'+path,body,{'Idempotency-Key':randomUUID()}));}
const rental=(f:Fixture,action:string,body:Record<string,unknown>)=>write(f,'rental',{action,...body});
const command=(f:Fixture,module:string,body:Record<string,unknown>)=>write(f,module+'/commands',body);
const overview=(f:Fixture,asOf:string,month='2026-11')=>f.request('GET',base+'/operations-dashboard?month='+month+'&asOf='+asOf).then(result<Overview>);
function currency(d:Overview,code:string){const c=d.overview.currencies.find(row=>row.currency===code);assert.ok(c,'Expected saved business currency '+code);return c;}
async function agreement(f:Fixture,propertyId:string,code:string,currencyCode='XTS'){
 const room=await rental(f,'create-room',{propertyId,code}),tenant=await rental(f,'create-tenant',{name:'SYNTHETIC final QA '+code});
 return rental(f,'create-agreement',{roomId:room.id,tenantId:tenant.id,startDate:'2026-10-01',endDate:null,monthlyRent:'100',currency:currencyCode,depositRequired:'30',dueTerms:'Explicit synthetic due amount/date, no generated proration'});
}
async function account(f:Fixture,scope:string,kind:string,currencyCode:string,openingAmount:string,openingDate='2026-10-01'){
 return command(f,scope+'-finance',{action:'create-account',name:'SYNTHETIC '+scope+' '+kind+' '+currencyCode,scope,kind,currency:currencyCode,openingAmount,openingDate,ownerConfirmedOpening:true});
}
async function snapshot(f:Fixture){
 return Promise.all(['rent_dues','rent_allocations','rent_collections','ops_money','ops_transfers','ops_collections','ops_commands'].map(async table=>
  (await f.pg!.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM hamdee_private.${table} t`)).rows));
}
async function markup(data:Overview){
 // Pure markup only. Temporary DOM adapters are restored before any database
 // or provider operation; they cannot select an owner or deployment identity.
 const descriptors=[['document',Object.getOwnPropertyDescriptor(globalThis,'document')],['window',Object.getOwnPropertyDescriptor(globalThis,'window')]] as const;
 Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:()=>null,addEventListener(){}}});
 Object.defineProperty(globalThis,'window',{configurable:true,value:{AbortController,icon:()=>'<svg aria-hidden="true"></svg>'}});
 try{const daily=await import('../public/workspace/daily-dashboard.js');return daily.dailyDashboardMarkup(data,'XTS');}
 finally{for(const [name,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}}
}

test('Final QA: actual account/custody movements stay separate in funds comparison; November overdue honours allocation date and currency',async t=>{
 const f=await setup(t),property=await write(f,'properties',{name:'SYNTHETIC final dashboard villa'}),a=await agreement(f,property.id,'QA-XTS');
 const due=await rental(f,'issue-due',{agreementId:a.id,period:'2026-11',dueDate:'2026-11-05',amount:'100'});
 const collection=(kind:string,method:string,amount:string,date:string,extra:Record<string,unknown>={})=>rental(f,'record-collection',{agreementId:a.id,kind,method,amount,receivedDate:date,...extra});
 await collection('rent','cash','40','2026-10-26',{allocations:[{dueId:due.id,amount:'40'}]});
 const advance=await collection('advance','cash','20','2026-10-27');await collection('deposit','bank','30','2026-10-28');await collection('rent','cheque','500','2026-11-01');
 await rental(f,'allocate-advance',{collectionId:advance.id,dueId:due.id,amount:'10',allocationDate:'2026-11-06'});
 const cash=await account(f,'company','cash','XTS','100'),bank=await account(f,'company','bank','XTS','200');
 await account(f,'personal','cash','XTS','999');await account(f,'personal','bank','USD','999999');
 await account(f,'company','bank','INR','1000000','2026-12-01');
 const collector=await command(f,'staff-collections',{action:'create-collector',name:'SYNTHETIC final collector'});
 const source=await command(f,'company-finance',{action:'create-classified-receipt',receiptKey:randomUUID(),classification:'SYNTHETIC explicitly classified receipt',receivedOn:'2026-11-01',amount:'50',currency:'XTS',method:'cash'});
 await command(f,'staff-collections',{action:'record-collection',collectorId:collector.id,sourceKind:'classified-receipt',sourceId:source.id,disposition:'collector-held',ownerConfirmedDisposition:true});
 await command(f,'staff-collections',{action:'handover',collectorId:collector.id,accountId:cash.id,amount:'20',currency:'XTS',handedOn:'2026-11-03',reference:'SYNTHETIC-FINAL-HANDOVER'});
 await command(f,'company-finance',{action:'transfer',fromAccountId:cash.id,toAccountId:bank.id,amount:'10',transferredOn:'2026-11-03',reference:'SYNTHETIC-FINAL-TRANSFER'});
 const other=await agreement(f,property.id,'QA-INR','INR'),otherDue=await rental(f,'issue-due',{agreementId:other.id,period:'2026-11',dueDate:'2026-11-04',amount:'300'});
 await rental(f,'record-collection',{agreementId:other.id,kind:'rent',method:'bank',amount:'100',receivedDate:'2026-11-05',allocations:[{dueId:otherDue.id,amount:'100'}]});
 const before=await snapshot(f),fifth=await overview(f,'2026-11-05'),sixth=await overview(f,'2026-11-06'),x=currency(sixth,'XTS'),inr=currency(sixth,'INR');
 assert.deepEqual([currency(fifth,'XTS').totalCollected,currency(fifth,'XTS').pendingCollection],['40','60']);
 assert.deepEqual([currency(fifth,'XTS').operations.overdueAmount,currency(fifth,'XTS').operations.overdueCount],['0',0],'Due today is not overdue');
 assert.deepEqual([x.totalCollected,x.pendingCollection,x.operations.overdueAmount,x.operations.overdueCount,x.operations.oldestOverdueDate],['50','50','50',1,'2026-11-05']);
 assert.deepEqual([x.companyCash,x.companyBank,x.operations.staffHeld],['110','210','30']);
 assert.deepEqual([inr.totalCollected,inr.pendingCollection,inr.operations.overdueAmount],['100','200','200']);
 assert.equal(inr.companyCash,null);assert.equal(inr.companyBank,null,'Future opening cannot become verified current bank funds');
 assert.equal(sixth.overview.currencies.some(row=>row.currency==='USD'),false);
 const html=await markup(sixth),funds=html.split('overview-funds-card')[1]?.split('overview-funds-note')[0];assert.ok(funds);
 for(const value of ['110.00','210.00','30.00'])assert.ok(funds.includes(value));
 assert.match(html,/Company Funds/);assert.match(html,/Overdue rent/);assert.match(html,/1 due · since 5 Nov/);
 assert.match(html,/Separate money locations, not income or available profit/);
 assert.match(html,/Separate balances · not income or profit/);
 assert.doesNotMatch(funds,/Total funds|Available profit:|350\.00|999\.00|999,999/);
 const incomplete=structuredClone(sixth),changed=currency(incomplete,'XTS');changed.companyCash=null;changed.companyBank='-25.123456789012';changed.operations.staffHeld='0';
 const unknown=await markup(incomplete),unknownFunds=unknown.split('overview-funds-card')[1]?.split('overview-funds-note')[0];assert.ok(unknownFunds);
 assert.match(unknownFunds,/Not verified/);assert.match(unknownFunds,/-25\.123456789012/);assert.match(unknownFunds,/bank negative/);assert.match(unknownFunds,/>XTS<\/span> 0\.00/);
 assert.deepEqual(await snapshot(f),before,'Summary reads and presentation do not post financial movements or alter issued history');
});

test('Final QA: overdue totals include every issued unpaid due beyond detail limits and exclude paid, same-day and other-month obligations',async t=>{
 const f=await setup(t),property=await write(f,'properties',{name:'SYNTHETIC final overdue count villa'});
 for(let n=0;n<13;n++){
  const a=await agreement(f,property.id,'FINAL-'+n),due=await rental(f,'issue-due',{agreementId:a.id,period:'2026-11',dueDate:n===12?'2026-11-10':'2026-11-01',amount:'100'});
  if(n===11)await rental(f,'record-collection',{agreementId:a.id,kind:'rent',method:'cash',amount:'100',receivedDate:'2026-11-02',allocations:[{dueId:due.id,amount:'100'}]});
  if(n===0)await rental(f,'issue-due',{agreementId:a.id,period:'2026-10',dueDate:'2026-10-05',amount:'999'});
 }
 const before=await snapshot(f),nov=await overview(f,'2026-11-10'),c=currency(nov,'XTS');
 assert.deepEqual([c.totalCollected,c.pendingCollection],['100','1200']);
 assert.deepEqual([c.operations.overdueAmount,c.operations.overdueCount,c.operations.oldestOverdueDate],['1100',11,'2026-11-01']);
 assert.deepEqual([c.operations.upcomingAmount,c.operations.upcomingCount],['100',1]);
 assert.equal(c.companyCash,null);assert.equal(c.companyBank,null);
 const oct=currency(await overview(f,'2026-11-10','2026-10'),'XTS');assert.equal(oct.operations.overdueAmount,'999');assert.equal(oct.operations.overdueCount,1);
 assert.deepEqual(await snapshot(f),before);
});
