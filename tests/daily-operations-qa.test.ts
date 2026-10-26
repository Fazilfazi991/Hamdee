import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {adapter} from './support/fixture';
import {createOwnerQaFixture} from './support/owner-crm-harness';

type Fixture=Awaited<ReturnType<typeof createOwnerQaFixture>>;
type Row=Record<string,any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const base='/api/hamdee/v1';
async function write(f:Fixture,module:string,body:unknown,key:string=randomUUID()) {
  const response=await f.request('POST',base+'/'+module,body,{'Idempotency-Key':key});
  const json=await response.json();assert.ok([200,201].includes(response.status),JSON.stringify(json));return json.data as Row;
}
async function rental(f:Fixture,action:string,fields:Row,key?:string){return write(f,'rental',{action,...fields},key);}
async function read(f:Fixture,module:string,month='2026-11',asOf='2026-11-30'){
  const response=await f.request('GET',base+'/'+module+'?month='+month+'&asOf='+asOf);const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));return json.data as Row;
}

test('Daily QA: October advance pays explicit November due without becoming new November cash; saved records survive database and owner-session restart',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'hamdee-daily-synthetic-'));
  let engine=new PGlite(directory),closed=false;
  const f=await createOwnerQaFixture({pg:engine,migrationFiles:['006_local_operations_records.up.sql']});
  t.after(async()=>{if(!closed)await engine.close();});
  assert.equal((await f.request('GET',base+'/rental?month=2026-11&asOf=2026-11-30')).status,401);
  await f.login();
  const p=await write(f,'properties',{name:'SYNTHETIC November owner villa'});
  const room=await rental(f,'create-room',{propertyId:p.id,code:'QA-NOV-01',label:'Synthetic room'});
  const tenant=await rental(f,'create-tenant',{name:'Synthetic November tenant',phone:'TEST-ONLY'});
  const agreement=await rental(f,'create-agreement',{roomId:room.id,tenantId:tenant.id,monthlyRent:'1000.00',currency:'QAR',depositRequired:'500.00',dueTerms:'Owner-confirmed monthly amount and exact due date; no proration',startDate:'2026-10-01',endDate:null});
  const advance=await rental(f,'record-collection',{agreementId:agreement.id,kind:'advance',method:'cash',amount:'300.00',receivedDate:'2026-10-25',reference:'SYNTHETIC-OCT-ADVANCE'});
  await rental(f,'record-collection',{agreementId:agreement.id,kind:'deposit',method:'cash',amount:'500.00',receivedDate:'2026-10-25',reference:'SYNTHETIC-DEPOSIT'});
  const noDue=await read(f,'rental');assert.equal(noDue.dues.length,0,'Historical/agreement rent never automatically issues a due');
  const c0=noDue.summary.currencies[0];assert.equal(c0.advanceMinor,'30000');assert.equal(c0.depositMinor,'50000');
  assert.equal(noDue.collections.find((x:Row)=>x.id===advance.id).availableAdvanceMinor,'30000');
  const due=await rental(f,'issue-due',{agreementId:agreement.id,period:'2026-11',dueDate:'2026-11-05',amount:'1000.00'});
  const key=randomUUID(),partialInput={agreementId:agreement.id,kind:'rent',method:'cash',amount:'250.00',receivedDate:'2026-11-05',reference:'SYNTHETIC-NOV-PARTIAL',allocations:[{dueId:due.id,amount:'250.00'}]};
  const partial=await rental(f,'record-collection',partialInput,key);assert.equal((await rental(f,'record-collection',partialInput,key)).id,partial.id);
  const account=await write(f,'company-finance/commands',{action:'create-account',name:'SYNTHETIC confirmed company cash',scope:'company',kind:'cash',currency:'QAR',openingDate:'2026-10-01',openingAmount:'0',ownerConfirmedOpening:true});
  for(const receipt of [advance,partial])await write(f,'company-finance/commands',{action:'receive',accountId:account.id,sourceKind:'property-rent',sourceId:receipt.id,ownerConfirmedDisposition:true});
  const allocationKey=randomUUID(),allocation={collectionId:advance.id,dueId:due.id,amount:'200.00',allocationDate:'2026-11-05'};
  const applied=await rental(f,'allocate-advance',allocation,allocationKey);assert.equal((await rental(f,'allocate-advance',allocation,allocationKey)).id,applied.id);
  const repeatCash=await f.request('POST',base+'/company-finance/commands',{action:'receive',accountId:account.id,sourceKind:'property-rent',sourceId:advance.id,ownerConfirmedDisposition:true},{'Idempotency-Key':randomUUID()});assert.equal(repeatCash.status,409);
  const tooMuch=await f.request('POST',base+'/rental',{action:'allocate-advance',...allocation,amount:'100.01'},{'Idempotency-Key':randomUUID()});assert.equal(tooMuch.status,409);
  const verify=async(g:Fixture)=>{
    const r=await read(g,'rental'),c=r.summary.currencies.find((x:Row)=>x.currency==='QAR');
    assert.deepEqual([c.dueMinor,c.collectedMinor,c.outstandingMinor,c.advanceMinor,c.depositMinor],['100000','45000','55000','10000','50000']);
    assert.equal(r.collections.length,3);assert.equal(r.agreements.length,1);assert.equal(r.dues.length,1);assert.equal(r.collections.find((x:Row)=>x.id===advance.id).receivedDate,'2026-10-25');
    assert.equal(r.collections.find((x:Row)=>x.id===advance.id).availableAdvanceMinor,'10000');
    const finance=await read(g,'company-finance');assert.equal(finance.totals[0].balance,'550');assert.equal(finance.totals[0].receipts,'550');
    assert.deepEqual(finance.monthEntries.filter((x:Row)=>x.entryKind==='receipt').map((x:Row)=>x.delta),['250']);
    assert.equal((await read(g,'personal-finance')).accounts.length,0);assert.equal(finance.entries.filter((x:Row)=>x.classification==='deposit').length,0);
    const dashboard=await read(g,'operations-dashboard'),rent=dashboard.rent.find((x:Row)=>x.currency==='QAR'),cash=dashboard.balances.find((x:Row)=>x.currency==='QAR');
    assert.deepEqual([rent.expected,rent.allocated,rent.outstanding,rent.unappliedAdvances,rent.depositHeld],['1000','450','550','100','500']);
    assert.equal(cash.companyCash,'550');assert.equal(cash.companyBank,null);assert.equal(dashboard.accounts.personalSetupRequired,true);assert.deepEqual(dashboard.personalBalances,[]);
    assert.equal(dashboard.recentCollections.length,3);assert.equal(dashboard.recentCollections[0].id,partial.id);assert.equal(dashboard.recentCollections[0].amount,'250');assert.ok(dashboard.recentCollections.some((row:{date:string;kind:string})=>row.date==='2026-10-25'&&row.kind==='advance'));
  };
  await verify(f);
  const oldCookies=f.jar.fork();await f.auth('POST','logout',{});assert.equal((await f.request('GET',base+'/rental?month=2026-11&asOf=2026-11-30',undefined,{},oldCookies)).status,401);
  await f.close();closed=true;engine=new PGlite(directory);closed=false;
  const restarted=await createOwnerQaFixture({database:adapter(engine),pg:engine,provider:f.fake,clock:f.clock});
  assert.equal((await restarted.request('GET',base+'/company-finance?month=2026-11&asOf=2026-11-30')).status,401);assert.equal((await restarted.request('GET',base+'/operations-dashboard?month=2026-11&asOf=2026-11-30')).status,401);await restarted.login();await verify(restarted);
  restarted.rebuildApplication();await verify(restarted);
});

test('Daily QA: imported-style room/contact metadata cannot create an agreement, due or cash; account opening needs explicit owner confirmation',async t=>{
  const f=await createOwnerQaFixture({migrationFiles:['006_local_operations_records.up.sql']});t.after(()=>f.close());await f.login();
  const p=await write(f,'properties',{name:'SYNTHETIC unverified villa'}),room=await rental(f,'create-room',{propertyId:p.id,code:'QA-HISTORY-ONLY'});
  await rental(f,'create-tenant',{name:'Synthetic historical contact',notes:'October 2026 source reference only; current terms unverified.'});
  const r=await read(f,'rental');assert.equal(r.rooms[0].occupancy,'unknown');assert.equal(r.agreements.length,0);assert.equal(r.dues.length,0);assert.equal(r.collections.length,0);
  const missing=await f.request('POST',base+'/rental',{action:'record-collection',agreementId:room.id,kind:'rent',method:'cash',amount:'1000.00',receivedDate:'2026-11-05',allocations:[]},{'Idempotency-Key':randomUUID()});assert.equal(missing.status,404);
  const noOpening=await f.request('POST',base+'/company-finance/commands',{action:'create-account',name:'Synthetic unconfirmed cash',scope:'company',kind:'cash',currency:'QAR',openingDate:'2026-11-01',openingAmount:'0'},{'Idempotency-Key':randomUUID()});assert.equal(noOpening.status,409);
  assert.equal((await read(f,'company-finance')).accounts.length,0);assert.equal((await read(f,'personal-finance')).accounts.length,0);
  const dashboard=await read(f,'operations-dashboard');assert.equal(dashboard.accounts.companySetupRequired,true);assert.equal(dashboard.accounts.personalSetupRequired,true);assert.deepEqual(dashboard.accounts.company,[]);assert.deepEqual(dashboard.accounts.personal,[]);assert.deepEqual(dashboard.balances,[]);assert.deepEqual(dashboard.rent,[]);
  assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.ops_money')).rows[0].n,0);
});
