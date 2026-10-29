import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOwnerQaFixture} from './support/owner-crm-harness';
// Synthetic identities and explicit dates only; no client source records.
type Row=Record<string,any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Fixture=Awaited<ReturnType<typeof createOwnerQaFixture>>;
const base='/api/hamdee/v1';
async function fixture(t:TestContext,migrate=true){const f=await createOwnerQaFixture({migrationFiles:migrate?['011_local_owner_occupancy.up.sql']:[]});t.after(()=>f.close());await f.login();return f;}
async function body(response:Response,status=200):Promise<Row>{const b=await response.json();assert.equal(response.status,status,JSON.stringify(b));return b;}
async function command(f:Fixture,action:string,fields:Row,key=randomUUID()){return f.request('POST',base+'/rental',{action,...fields},{'Idempotency-Key':key});}
async function save(f:Fixture,action:string,fields:Row){return (await body(await command(f,action,fields))).data as Row;}
async function read(f:Fixture,asOf='2026-11-15',propertyId?:string){return (await body(await f.request('GET',base+'/rental?month='+asOf.slice(0,7)+'&asOf='+asOf+(propertyId?'&propertyId='+propertyId:'')))).data as Row;}
async function arrangement(f:Fixture){const p=(await body(await f.request('POST',base+'/properties',{name:'Synthetic owner-confirmed villa'},{'Idempotency-Key':randomUUID()}),201)).data;
 const room=await save(f,'create-room',{propertyId:p.id,code:'UNIT-1'}),tenant=await save(f,'create-tenant',{name:'Synthetic owner-confirmed contact'});return {p,room,tenant};}
function confirm(a:Row,fields:Row={}){return {roomId:a.room.id,tenantId:a.tenant.id,status:'occupied',effectiveDate:'2026-11-01',expectedOccupancyVersion:0,...fields};}
const terms={monthlyRent:'1000',currency:'QAR',dueTerms:'Owner-confirmed fifth of month'};

test('Owner occupancy: historical source confirmation is separate, immutable, duplicate-protected and has no ledger or occupancy effects',async t=>{
 const f=await fixture(t),a=await arrangement(f),key=randomUUID();
 const payload={tenantId:a.tenant.id,sourceSha256:'a'.repeat(64),sourceReference:'Synthetic original page 1 row 2',period:'2026-10',notes:'Source roster understanding only'};
 const contact=(await body(await command(f,'confirm-source-reference',payload,key))).data;
 assert.equal(contact.roomId,null);assert.equal((await body(await command(f,'confirm-source-reference',payload,key))).replay,true);
 await body(await command(f,'confirm-source-reference',payload),409);
 await body(await command(f,'confirm-source-reference',{...payload,notes:'Changed'},key),409);
 await save(f,'confirm-source-reference',{...payload,roomId:a.room.id});
 let state=await read(f);assert.equal(state.sourceConfirmations.length,2);assert.equal(state.rooms[0].occupancy,'unknown');assert.equal(state.rooms[0].occupancyVersion,0);
 assert.equal(state.agreements.length,0);assert.equal(state.dues.length,0);assert.equal(state.collections.length,0);assert.deepEqual(state.summary.currencies,[]);
 const p2=(await body(await f.request('POST',base+'/properties',{name:'Synthetic separate villa'},{'Idempotency-Key':randomUUID()}),201)).data;
 state=await read(f,'2026-11-15',p2.id);assert.equal(state.sourceConfirmations.length,1);assert.equal(state.sourceConfirmations[0].roomId,null);
 await assert.rejects(f.pg!.query('UPDATE hamdee_private.source_roster_confirmations SET notes=$2 WHERE id=$1',[contact.id,'Rewrite']),/append|immutable/i);
});

test('Owner occupancy: explicit dated states preserve history and unknown differs from proved vacancy',async t=>{
 const f=await fixture(t),a=await arrangement(f),key=randomUUID(),payload=confirm(a);
 const first=(await body(await command(f,'confirm-occupancy',payload,key))).data;assert.equal(first.internalAgreementId,null);
 assert.equal((await body(await command(f,'confirm-occupancy',payload,key))).replay,true);
 assert.equal((await read(f,'2026-10-31')).rooms[0].occupancy,'unknown');
 let state=await read(f);assert.equal(state.rooms[0].occupancy,'occupied');assert.equal(state.rooms[0].currentTenantId,a.tenant.id);assert.equal(state.agreements.length,0);
 await body(await command(f,'confirm-occupancy',confirm(a,{expectedOccupancyVersion:0})),412);
 await body(await command(f,'confirm-occupancy',confirm(a,{expectedOccupancyVersion:1,effectiveDate:'2026-10-31'})),409);
 await save(f,'confirm-occupancy',{roomId:a.room.id,status:'vacant',effectiveDate:'2026-11-20',expectedOccupancyVersion:1});
 assert.equal((await read(f)).rooms[0].occupancy,'occupied');
 state=await read(f,'2026-11-21');assert.equal(state.rooms[0].occupancy,'vacant');assert.equal(state.rooms[0].currentTenantId,null);assert.equal(state.summary.vacantRooms,1);assert.equal(state.rooms[0].occupancyHistory.length,2);
 await save(f,'confirm-occupancy',{roomId:a.room.id,status:'unknown',effectiveDate:'2026-11-22',expectedOccupancyVersion:2});
 assert.equal((await read(f,'2026-11-23')).summary.unverifiedRooms,1);
 assert.equal((await read(f)).dues.length,0);
});

test('Owner occupancy: direct confirmed terms support collection by room/tenant/month, unknown deposit is NULL and receipt/refund safeguards persist',async t=>{
 const f=await fixture(t),a=await arrangement(f);
 const c=await save(f,'confirm-occupancy',confirm(a,{terms}));assert.ok(c.internalAgreementId);
 let state=await read(f);assert.equal(state.agreements.length,1);assert.equal(state.agreements[0].startDate,'2026-11-01');assert.equal(state.agreements[0].depositRequiredMinor,null);assert.equal(state.dues.length,0);
 const scope={roomId:a.room.id,tenantId:a.tenant.id,period:'2026-11'};
 await body(await command(f,'issue-due',{...scope,dueDate:'2026-11-05',amount:'999'}),409);
 const d=await save(f,'issue-due',{...scope,dueDate:'2026-11-05',amount:'1000'});
 const key=randomUUID(),receipt={...scope,kind:'rent',method:'cash',amount:'250',receivedDate:'2026-11-06',allocations:[{dueId:d.id,amount:'250'}]};
 await body(await command(f,'record-collection',receipt,key));assert.equal((await body(await command(f,'record-collection',receipt,key))).replay,true);
 await body(await command(f,'record-collection',{...receipt,amount:'1000',allocations:[{dueId:d.id,amount:'1000'}]}),409);
 await save(f,'record-collection',{...scope,kind:'deposit',method:'bank',amount:'500',receivedDate:'2026-11-06'});
 await save(f,'refund-deposit',{...scope,method:'cash',amount:'100',receivedDate:'2026-11-07'});
 await body(await command(f,'refund-deposit',{...scope,method:'cash',amount:'400.01',receivedDate:'2026-11-08'}),409);
 state=await read(f);assert.equal(state.dues[0].paidMinor,'25000');assert.equal(state.dues[0].outstandingMinor,'75000');assert.equal(state.dues[0].snapshot.agreement.depositRequiredMinor,null);
 assert.equal(state.summary.currencies[0].depositMinor,'40000');assert.equal(state.collections.length,3);
 await body(await command(f,'confirm-occupancy',confirm(a,{expectedOccupancyVersion:1,terms:{...terms,monthlyRent:'999'}})),409);
 await save(f,'confirm-occupancy',confirm(a,{expectedOccupancyVersion:1,terms}));assert.equal((await read(f)).agreements.length,1);
 // Legacy explicit internal-ID API retains its owner-entered exception semantics.
 const legacy=await save(f,'issue-due',{agreementId:c.internalAgreementId,period:'2026-12',dueDate:'2026-12-05',amount:'25'});assert.equal(legacy.amountMinor,'2500');
});

test('Simplified rent dues cannot be dated outside the confirmed term effective dates',async t=>{
 const f=await fixture(t),a=await arrangement(f);
 await save(f,'confirm-occupancy',confirm(a,{effectiveDate:'2026-11-20',terms}));
 const beforeStart=await command(f,'issue-due',{roomId:a.room.id,tenantId:a.tenant.id,period:'2026-11',dueDate:'2026-11-01',amount:'1000'});
 assert.ok(beforeStart.status>=400,'A due before the confirmed start must be rejected');
 const secondRoom=await save(f,'create-room',{propertyId:a.p.id,code:'UNIT-2'});
 await save(f,'confirm-occupancy',{roomId:secondRoom.id,tenantId:a.tenant.id,status:'occupied',effectiveDate:'2026-12-01',expectedOccupancyVersion:0,terms:{...terms,endDate:'2026-12-04'}});
 const afterEnd=await command(f,'issue-due',{roomId:secondRoom.id,tenantId:a.tenant.id,period:'2026-12',dueDate:'2026-12-05',amount:'1000'});
 assert.ok(afterEnd.status>=400,'A due after the confirmed end must be rejected');
 assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.rent_dues')).rows[0].n,0);
 await save(f,'issue-due',{roomId:a.room.id,tenantId:a.tenant.id,period:'2026-11',dueDate:'2026-11-20',amount:'1000'});
 await save(f,'issue-due',{roomId:secondRoom.id,tenantId:a.tenant.id,period:'2026-12',dueDate:'2026-12-04',amount:'1000'});
 assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.rent_dues')).rows[0].n,2);
});

test('Owner occupancy: changed tenants require explicit old-term ending, preserve old dues and never resurrect ended occupancy',async t=>{
 const f=await fixture(t),a=await arrangement(f),old=await save(f,'confirm-occupancy',confirm(a,{terms:{...terms,depositRequired:'0'}}));
 const scope={roomId:a.room.id,tenantId:a.tenant.id,period:'2026-11'},d=await save(f,'issue-due',{...scope,dueDate:'2026-11-05',amount:'1000'});
 const next=await save(f,'create-tenant',{name:'Synthetic replacement tenant'});
 await body(await command(f,'confirm-occupancy',confirm(a,{tenantId:next.id,effectiveDate:'2026-11-16',expectedOccupancyVersion:1,terms})),409);
 await save(f,'end-agreement',{...scope,expectedVersion:1,endDate:'2026-11-15'});
 assert.equal((await read(f,'2026-11-16')).rooms[0].occupancy,'unknown');
 await save(f,'confirm-occupancy',confirm(a,{tenantId:next.id,effectiveDate:'2026-11-16',expectedOccupancyVersion:1,terms:{...terms,monthlyRent:'1200',depositRequired:'0'}}));
 let state=await read(f,'2026-11-17');assert.equal(state.rooms[0].currentTenantId,next.id);assert.equal(state.rooms[0].occupancyHistory.length,2);assert.equal(state.dues[0].id,d.id);assert.equal(state.dues[0].agreementId,old.internalAgreementId);assert.equal(state.dues[0].amountMinor,'100000');
 await body(await command(f,'record-collection',{roomId:a.room.id,tenantId:a.tenant.id,period:'2026-12',kind:'advance',method:'cash',amount:'10',receivedDate:'2026-12-01'}),409);
 // Same tenant can have two non-overlapping terms within one month. Never pick one silently.
 await save(f,'end-agreement',{agreementId:state.agreements.find((x:Row)=>x.tenantId===next.id).id,expectedVersion:1,endDate:'2026-11-20'});
 await save(f,'create-agreement',{roomId:a.room.id,tenantId:next.id,...terms,depositRequired:'0',startDate:'2026-11-21',endDate:null});
 await body(await command(f,'issue-due',{roomId:a.room.id,tenantId:next.id,period:'2026-11',dueDate:'2026-11-25',amount:'100'}),409);
 state=await read(f,'2026-11-30');assert.equal(state.rooms[0].currentTenantId,next.id);assert.equal(state.dues.length,1);
});

test('Owner occupancy: concurrent stale confirmations, failed terms transaction, missing schema and unauthorized requests fail safely',async t=>{
 const f=await fixture(t),a=await arrangement(f);
 await body(await command(f,'confirm-occupancy',confirm(a,{terms,notes:'x'.repeat(1001)})),422);
 let state=await read(f);assert.equal(state.agreements.length,0);assert.equal(state.rooms[0].occupancyHistory.length,0);
 const results=await Promise.all([command(f,'confirm-occupancy',confirm(a)),command(f,'confirm-occupancy',confirm(a))]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);
 state=await read(f);assert.equal(state.rooms[0].occupancyHistory.length,1);
 await body(await command(f,'confirm-occupancy',confirm(a,{expectedOccupancyVersion:1,status:'vacant'})),422);
 await body(await f.request('POST',base+'/rental',{action:'confirm-occupancy',...confirm(a)},{Origin:'https://untrusted.invalid','Idempotency-Key':randomUUID()}),403);
 await body(await f.auth('POST','logout',{}));
 assert.ok((await f.request('GET',base+'/rental')).status>=400);
});

test('Owner occupancy: pre-migration reads remain compatible and new writes fail closed',async t=>{
 const f=await fixture(t,false),a=await arrangement(f);const state=await read(f);assert.equal(state.occupancyAvailable,false);assert.equal(state.rooms[0].occupancy,'unknown');
 await body(await command(f,'confirm-occupancy',confirm(a)),503);
 await f.request('POST','/api/hamdee/auth/logout',{});
 const response=await f.request('GET',base+'/rental');assert.ok(response.status===401||response.status===403);
});

test('Owner occupancy: private tables force owner row security, immutable history and least-privilege runtime access',async t=>{
 const f=await fixture(t),a=await arrangement(f),confirmation=await save(f,'confirm-occupancy',confirm(a));
 const flags=(await f.pg!.query<Row>(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
  has_table_privilege('hamdee_runtime',c.oid,'SELECT') AS can_read,has_table_privilege('hamdee_runtime',c.oid,'INSERT') AS can_insert,
  has_table_privilege('hamdee_runtime',c.oid,'UPDATE') AS can_update,has_table_privilege('hamdee_runtime',c.oid,'DELETE') AS can_delete
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hamdee_private' AND c.relname IN ('room_occupancy_confirmations','source_roster_confirmations')`)).rows;
 assert.equal(flags.length,2);for(const row of flags){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);assert.equal(row.can_read,true);assert.equal(row.can_insert,true);assert.equal(row.can_update,false);assert.equal(row.can_delete,false);}
 const publicGrants=(await f.pg!.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE n.nspname='hamdee_private' AND c.relname IN ('room_occupancy_confirmations','source_roster_confirmations') AND a.grantee=0`)).rows;assert.equal(publicGrants.length,0);
 await f.pg!.transaction(async tx=>{await tx.exec('SET LOCAL ROLE hamdee_runtime');await tx.query("SELECT set_config('hamdee.actor_id','',true)");assert.equal((await tx.query('SELECT * FROM hamdee_private.room_occupancy_confirmations')).rows.length,0);});
 await assert.rejects(f.pg!.query('DELETE FROM hamdee_private.room_occupancy_confirmations WHERE id=$1',[confirmation.id]),/append|immutable/i);
 // Database guard also prevents a runtime writer from skipping a confirmation revision.
 await assert.rejects(f.pg!.query(`INSERT INTO hamdee_private.room_occupancy_confirmations(id,property_id,room_id,tenant_id,status,effective_date,version,event_id)
  SELECT $1,property_id,room_id,tenant_id,status,effective_date,version+2,event_id FROM hamdee_private.room_occupancy_confirmations WHERE id=$2`,[randomUUID(),confirmation.id]),/sequential occupancy/i);
});
