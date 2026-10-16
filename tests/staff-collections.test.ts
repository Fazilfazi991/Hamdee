import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { operationsFixture,seedRentReceiptChoices,seedClassifiedReceiptChoices } from './support/operations-fixture';
import { adapter,issuer } from './support/fixture';
import { PropertyService } from '../src/service';
import { StaffCollectionsService } from '../src/staff-collections';
import { localReceiptReader,type ReceiptSourceReader } from '../src/company-finance';
import { bindIdentityRecheck } from '../src/auth';
import type { Database } from '../src/database';
const query={month:'2026-10',asOf:'2026-10-31'};
const code=(expected:string)=>(e:unknown)=>(e as {code:string}).code===expected;
async function setup(t:TestContext){const f=await operationsFixture();t.after(()=>f.pg.close());return f;}
async function funded(t:TestContext){const f=await setup(t),c=await f.collector(),a=await f.account(),r=await f.receipt();await f.collect(c.id,r.id);return {...f,c,a,r};}

test('Staff collector is a contact with versioned immutable history, never a user; stale revisions and nonowner reject',async t=>{
 const f=await setup(t),c=await f.collector();const count=(await f.pg.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.app_users')).rows[0].n;
 await f.writeStaff({action:'update-collector',collectorId:c.id,expectedVersion:1,name:'Synthetic revised'});
 await assert.rejects(f.writeStaff({action:'update-collector',collectorId:c.id,expectedVersion:1,name:'Stale'}),code('VERSION_CONFLICT'));
 const r=(await f.pg.query<{profile:{name:string}}>('SELECT profile FROM hamdee_private.ops_collector_revisions WHERE collector_id=$1 ORDER BY version',[c.id])).rows;
 assert.equal(r.length,2);assert.equal(r[0].profile.name,'Synthetic collector');assert.equal(r[1].profile.name,'Synthetic revised');
 assert.equal((await f.pg.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.app_users')).rows[0].n,count);
 await assert.rejects(f.staff.overview({issuer,subject:f.users.ops.subject},query),code('OWNER_ACCESS_DENIED'));
});
test('Staff full/partial handovers conserve custody and company funds without counting handovers as receipt income',async t=>{
 const f=await funded(t);await f.handover(f.c.id,f.a.id,{amount:'30'});await f.handover(f.c.id,f.a.id,{amount:'70',handedOn:'2026-10-17'});
 const s=await f.staff.overview(f.identity,query);assert.equal(s.totals[0].received,'100');assert.equal(s.totals[0].handedOver,'100');assert.equal(s.totals[0].balance,'0');assert.equal(s.daily[0].balance,'100');assert.equal(s.daily[1].balance,'70');assert.equal(s.daily[2].balance,'0');
 const a=await f.finance.overview(f.identity,query);assert.equal(a.totals[0].receipts,'0');assert.equal(a.totals[0].transfersIn,'100');assert.equal(a.totals[0].balance,'100');assert.equal(s.moneyUnit,'decimal-major-unit-strings');
});
test('Bank receipt needs actual disposition confirmation; direct-company funds never become collector cash or get handed over again',async t=>{
 const f=await setup(t),c=await f.collector(),a=await f.account({kind:'bank'}),r=await f.receipt({method:'bank'});
 await assert.rejects(f.writeStaff({action:'record-collection',collectorId:c.id,sourceKind:'classified-receipt',sourceId:r.id}),code('DISPOSITION_REQUIRED'));
 await f.collect(c.id,r.id,{disposition:'company-direct',accountId:a.id});const s=await f.staff.overview(f.identity,query);
 assert.equal(s.totals[0].balance,'0');assert.equal(s.totals[0].companyDirect,'100');assert.equal(s.totals[0].received,'0');
 await assert.rejects(f.handover(c.id,a.id,{amount:'1'}),code('INSUFFICIENT_FUNDS'));
 assert.equal((await f.finance.overview(f.identity,query)).totals[0].receipts,'100');
});
test('Already-accounted direct-company source can be attributed to a collector without another account receipt',async t=>{
 const f=await setup(t),c=await f.collector(),a=await f.account({kind:'bank'}),r=await f.receipt({method:'bank'});
 await f.writeFinance({action:'receive',accountId:a.id,sourceKind:'classified-receipt',sourceId:r.id,ownerConfirmedDisposition:true});
 await f.collect(c.id,r.id,{disposition:'company-direct',accountId:a.id});const astate=await f.finance.overview(f.identity,query);
 assert.equal(astate.totals[0].receipts,'100');assert.equal(astate.entries.filter(e=>e.entryKind==='receipt').length,1);
 await assert.rejects(f.collect(c.id,r.id),code('DUPLICATE_COLLECTION'));
 await assert.rejects(f.writeFinance({action:'reverse',entryId:astate.entries.find(e=>e.entryKind==='receipt')!.id,reversedOn:'2026-10-16',reason:'Correct destination'}),code('COLLECTION_LINKED'));
});
test('Verified direct-company location cannot be overridden by client custody fields',async t=>{
 const f=await setup(t),c=await f.collector(),a=await f.account({kind:'bank'}),r=await f.receipt({method:'bank'});
 const reader:ReceiptSourceReader={...localReceiptReader,read:async(sql,kind,sourceId)=>{const row=await localReceiptReader.read(sql,kind,sourceId);return row?{...row,disposition:'company-direct',accountId:String(a.id)}:null;}};
 const service=new StaffCollectionsService(f.properties,reader);
 await assert.rejects(service.mutate(f.identity,{action:'record-collection',collectorId:c.id,sourceKind:'classified-receipt',sourceId:r.id,disposition:'collector-held',ownerConfirmedDisposition:true},randomUUID(),randomUUID()),code('SOURCE_LOCATION_MISMATCH'));
});
test('Pending cheque custody is listed separately and cannot fund any handover',async t=>{
 const f=await setup(t),c=await f.collector(),a=await f.account(),r=await f.receipt({method:'cheque'});await f.collect(c.id,r.id);
 const s=await f.staff.overview(f.identity,query);assert.equal(s.totals[0].pending,'100');assert.equal(s.totals[0].balance,'0');assert.equal(s.collections[0].disposition,'pending');
 await assert.rejects(f.handover(c.id,a.id),code('INSUFFICIENT_FUNDS'));assert.equal((await f.finance.overview(f.identity,query)).totals[0].balance,'0');
});
test('Actual property rent/advance/deposit receipts preserve authoritative amount, classification and property/room/tenant metadata',async t=>{
 const f=await setup(t),c=await f.collector();
 for(const kind of ['rent','advance','deposit']){const r=await f.rentSource(kind);await f.collect(c.id,r.id,{sourceKind:'property-rent'});}
 const s=await f.staff.overview(f.identity,query);assert.deepEqual(new Set(s.collections.map(c=>c.classification)),new Set(['rent','advance','deposit']));assert.equal(s.totals[0].received,'300');
 for(const c of s.collections){assert.equal(c.amount,'100');assert.ok(c.source.propertyId&&c.source.roomId&&c.source.agreementId&&c.source.tenantId);assert.equal(c.source.customerLabel,'Synthetic tenant');}
 await assert.rejects(f.writeStaff({action:'record-collection',collectorId:c.id,sourceKind:'classified-receipt',sourceId:randomUUID(),amount:'999'}),code('INVALID_OPERATION'));
 const choices=await f.staff.receipts(f.identity,{asOf:'2026-10-31'});assert.equal(choices.data.length,3);assert.equal(choices.data.every(r=>r.linked),true);
});
test('Staff replay/source/link/handover duplicate identities are durable and fresh permissions still apply',async t=>{
 const f=await funded(t),key=randomUUID(),b={action:'handover',collectorId:f.c.id,accountId:f.a.id,amount:'10',currency:'XTS',handedOn:'2026-10-16',reference:'UNIQUE-HANDOVER'};
 const one=await f.staff.mutate(f.identity,b,key,randomUUID()),two=await f.staff.mutate(f.identity,b,key,randomUUID());assert.equal(one.data.id,two.data.id);assert.equal(two.replay,true);
 await assert.rejects(f.writeStaff(b),code('DUPLICATE_HANDOVER'));await assert.rejects(f.writeStaff({...b,amount:'11'},key),code('IDEMPOTENCY_KEY_REUSED'));
 await assert.rejects(f.collect(f.c.id,f.r.id),code('DUPLICATE_COLLECTION'));
 await f.pg.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[f.users.admin.id]);await assert.rejects(f.writeStaff(b,key),code('UNAUTHENTICATED'));
});
test('PGlite competing handovers cannot overdraw custody; this is not independent native-session evidence',async t=>{
 const f=await funded(t);const results=await Promise.allSettled([f.handover(f.c.id,f.a.id,{amount:'70'}),f.handover(f.c.id,f.a.id,{amount:'70'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.staff.overview(f.identity,query)).totals[0].balance,'30');
});
test('Handover correction reverses the original pair and records a new linked amount without replacing history',async t=>{
 const f=await funded(t),h=await f.handover(f.c.id,f.a.id,{amount:'40'});
 const reason='Synthetic input correction',key=randomUUID(),body={action:'correct-handover',handoverId:h.id,accountId:f.a.id,amount:'20',currency:'XTS',handedOn:'2026-10-17',reference:'CORRECTED-HANDOVER',reason,notes:'Separate replacement notes'};
 const corrected=await f.staff.mutate(f.identity,body,key,randomUUID());
 assert.equal((corrected.data as unknown as {reason:string}).reason,reason);
 const s=await f.staff.overview(f.identity,query);assert.equal(s.totals[0].handedOver,'20');assert.equal(s.totals[0].balance,'80');assert.equal(s.handovers.length,2);assert.equal(s.handovers.find(r=>r.id===h.id)!.reversed,true);assert.ok(s.handovers.some(r=>r.replacesHandoverId===h.id));
 const event=s.history.find(row=>row.action==='staff:correct-handover')!;
 const data=(event.detail as {data:{id:string;reason:string;notes:string;replacesHandoverId:string}}).data;
 assert.equal(data.id,corrected.data.id);assert.equal(data.reason,reason);assert.equal(data.notes,body.notes);assert.equal(data.replacesHandoverId,h.id);
 const filtered=await f.staff.overview(f.identity,{...query,collectorId:String(f.c.id)});assert.ok(filtered.history.some(row=>row.id===event.id));
 const replay=await f.staff.mutate(f.identity,body,key,randomUUID());assert.equal(replay.replay,true);assert.deepEqual(replay.data,corrected.data);
 assert.equal((await f.staff.overview(f.identity,query)).history.filter(row=>row.action==='staff:correct-handover').length,1);
 const earlier=await f.staff.overview(f.identity,{...query,asOf:'2026-10-16'});assert.equal(earlier.totals[0].handedOver,'40');assert.equal(earlier.handovers[0].reversed,false);
 assert.equal((await f.finance.overview(f.identity,query)).totals[0].balance,'20');await assert.rejects(f.writeStaff({action:'reverse-handover',handoverId:h.id,reversedOn:'2026-10-18',reason:'Duplicate reversal'}),code('ALREADY_REVERSED'));
});
test('Collection reversal cannot erase handed-over custody; reversing handover first permits auditable reassignment',async t=>{
 const f=await funded(t),h=await f.handover(f.c.id,f.a.id,{amount:'100'}),s=await f.staff.overview(f.identity,query),collectionId=s.collections[0].id;
 await assert.rejects(f.writeStaff({action:'reverse-collection',collectionId,reversedOn:'2026-10-17',reason:'Synthetic correction'}),code('INSUFFICIENT_FUNDS'));
 await f.writeStaff({action:'reverse-handover',handoverId:h.id,reversedOn:'2026-10-17',reason:'Undo mistaken handover'});
 await f.writeStaff({action:'reverse-collection',collectionId,reversedOn:'2026-10-17',reason:'Correct collector attribution'});
 assert.equal((await f.staff.overview(f.identity,query)).totals[0].balance,'0');
 const second=await f.collector();await f.collect(second.id,f.r.id);assert.equal((await f.staff.overview(f.identity,{...query,collectorId:String(second.id)})).totals[0].balance,'100');
 assert.equal((await f.staff.overview(f.identity,{...query,asOf:'2026-10-16',collectorId:String(second.id)})).totals.length,0,'Corrected placement cannot duplicate historical custody before the original reversal');
 const filtered=await f.staff.overview(f.identity,{...query,collectorId:String(f.c.id)});assert.ok(filtered.history.some(r=>r.action==='staff:reverse-collection'));
});
test('Daily/date/currency boundaries prevent borrowing future receipts or another currency',async t=>{
 const f=await setup(t),c=await f.collector(),a=await f.account(),r=await f.receipt({receivedOn:'2026-10-20'});await f.collect(c.id,r.id);
 await assert.rejects(f.handover(c.id,a.id,{handedOn:'2026-10-19'}),code('INSUFFICIENT_FUNDS'));
 assert.equal((await f.staff.overview(f.identity,{...query,asOf:'2026-10-19'})).totals.length,0);
 const other=await f.account({currency:'XXX'});await assert.rejects(f.handover(c.id,other.id,{handedOn:'2026-10-21',currency:'XXX'}),code('INSUFFICIENT_FUNDS'));
 await f.handover(c.id,a.id,{handedOn:'2026-10-21'});assert.equal((await f.staff.overview(f.identity,{...query,asOf:'2026-10-20'})).totals[0].balance,'100');
});
test('Audit or late session failure rolls back source claim, collection, cash, history and command',async t=>{
 const f=await setup(t),c=await f.collector(),r=await f.receipt(),base=adapter(f.pg);let fail=true;
 const db:Database={transaction:work=>base.transaction(sql=>work({query:(statement,params)=>{if(fail&&statement.startsWith('INSERT INTO hamdee_private.ops_events'))throw new Error('Synthetic audit failure');return sql.query(statement,params);}}))};
 const service=new StaffCollectionsService(new PropertyService(db,f.identity)),b={action:'record-collection',collectorId:c.id,sourceKind:'classified-receipt',sourceId:r.id,disposition:'collector-held',ownerConfirmedDisposition:true},key=randomUUID();
 await assert.rejects(service.mutate(f.identity,b,key,randomUUID()));assert.equal((await f.pg.query('SELECT id FROM hamdee_private.ops_claims')).rows.length,0);assert.equal((await f.pg.query('SELECT id FROM hamdee_private.ops_money')).rows.length,0);
 fail=false;await service.mutate(f.identity,b,key,randomUUID());
 const late=bindIdentityRecheck(f.identity,async()=>{throw new Error('Synthetic session loss');});await assert.rejects(f.staff.mutate(late,{action:'create-collector',name:'Must rollback'},randomUUID(),randomUUID()));
 assert.equal((await f.pg.query("SELECT id FROM hamdee_private.ops_collectors WHERE name='Must rollback'")).rows.length,0);
});
test('Posted custody/history cannot be edited/deleted and contact revisions cannot skip evidence',async t=>{
 const f=await funded(t);await assert.rejects(f.pg.exec('UPDATE hamdee_private.ops_money SET delta=0'));await assert.rejects(f.pg.exec('DELETE FROM hamdee_private.ops_collections'));await assert.rejects(f.pg.exec('DELETE FROM hamdee_private.ops_events'));
 await assert.rejects(f.pg.query('UPDATE hamdee_private.ops_collectors SET version=version+1 WHERE id=$1',[f.c.id]));
});
test('Staff records, corrected handover reason/replay, company transfer pairs and daily balances survive PGlite disk close/reopen',async t=>{
 const f=await operationsFixture(true),c=await f.collector(),a=await f.account(),r=await f.receipt();await f.collect(c.id,r.id);const h=await f.handover(c.id,a.id);
 const key=randomUUID(),body={action:'correct-handover',handoverId:h.id,accountId:a.id,amount:'20',currency:'XTS',handedOn:'2026-10-17',reference:'SYNTHETIC-PERSISTED-CORRECTION',reason:'Synthetic persisted correction reason'};
 const corrected=await f.staff.mutate(f.identity,body,key,randomUUID());await f.pg.close();
 const pg=new PGlite(f.dataDir);t.after(()=>pg.close());const service=new StaffCollectionsService(new PropertyService(adapter(pg),f.identity));const s=await service.overview(f.identity,query);assert.equal(s.totals[0].balance,'80');assert.equal(s.collections.length,1);assert.equal(s.handovers.length,2);
 const data=(s.history.find(row=>row.action==='staff:correct-handover')!.detail as {data:{reason:string;replacesHandoverId:string}}).data;
 assert.equal(data.reason,body.reason);assert.equal(data.replacesHandoverId,h.id);
 const replay=await service.mutate(f.identity,body,key,randomUUID());assert.equal(replay.replay,true);assert.deepEqual(replay.data,corrected.data);assert.equal((replay.data as unknown as {reason:string}).reason,body.reason);
 const after=await service.overview(f.identity,query);assert.equal(after.handovers.length,2);assert.equal(after.totals[0].balance,'80');assert.equal(after.history.filter(row=>row.action==='staff:correct-handover').length,1);
});

test('Receipt pagination: 200+ property/mixed-source records remain selectable without missing/duplicate keys; exact filter-bound cursors',async t=>{
 const f=await setup(t),base=await f.rentSource(),other=await f.rentSource('deposit');
 const seeded=await seedRentReceiptChoices(f,base,204),classified=await seedClassifiedReceiptChoices(f,String(base.id));
 await f.receipt({receivedOn:'2026-11-01'}); // outside the unchanged asOf filter
 const expected=[{kind:'property-rent',id:String(base.id),date:'2026-10-15'},{kind:'property-rent',id:String(other.id),date:'2026-10-15'},...seeded,...classified];
 const key=(r:{kind:string;date:string;id:string})=>`${r.kind}|${r.date}|${r.id}`;
 const first=await f.staff.receipts(f.identity,{asOf:'2026-10-31'});assert.equal(first.data.length,100);assert.equal(first.hasMore,true);assert.ok(first.nextCursor);
 // A newer same-kind receipt beyond the current position is reachable too.
 const latest=await seedRentReceiptChoices(f,base,1,'2026-10-31');expected.push(...latest);
 const all=[...first.data];let cursor:string|null=first.nextCursor;let pages=1;
 while(cursor){const page=await f.staff.receipts(f.identity,{asOf:'2026-10-31',cursor});assert.equal(page.hasMore,page.nextCursor!==null);assert.ok(page.data.length>0&&page.data.length<=100);all.push(...page.data);cursor=page.nextCursor;assert.ok(++pages<=4);}
 assert.equal(all.length,209);assert.equal(new Set(all.map(key)).size,209);assert.deepEqual(all.map(key),expected.map(key).sort());assert.ok(all.some(r=>r.id===latest[0].id));
 assert.equal(all.filter(r=>r.id===base.id).length,2,'Same UUID in distinct authoritative source kinds must not be dropped');
 assert.equal(all.find(r=>r.id===classified[1].id)!.status,'pending','Paging preserves pending cheque state');
 const repeat=await f.staff.receipts(f.identity,{asOf:'2026-10-31',cursor:first.nextCursor!});assert.deepEqual(repeat.data.map(key),all.slice(100,200).map(key));
 const propertyId=String(base.propertyId),filtered=[];let propertyCursor:string|undefined;
 do{const page=await f.staff.receipts(f.identity,{asOf:'2026-10-31',propertyId:propertyId.toUpperCase(),cursor:propertyCursor});filtered.push(...page.data);propertyCursor=page.nextCursor??undefined;}while(propertyCursor);
 assert.equal(filtered.length,206);assert.equal(filtered.every(r=>r.propertyId===propertyId&&r.kind==='property-rent'),true);
 const early=await f.staff.receipts(f.identity,{asOf:'2026-09-30'});assert.deepEqual(early.data,[]);assert.equal(early.nextCursor,null);assert.equal(early.hasMore,false);
 const payload=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString('utf8'));
 const token=(change:Record<string,unknown>)=>Buffer.from(JSON.stringify({...payload,...change})).toString('base64url');
 const invalid=[first.nextCursor!+'=','!','a'.repeat(513),token({version:2}),token({date:'2026-02-30'}),token({date:'2026-11-01'}),token({date:'2026-10-14'}),token({id:randomUUID()}),token({kind:'unknown'}),token({extra:true}),
  Buffer.from(JSON.stringify(payload).replace('{','{"version":1,')).toString('base64url')];
 for(const invalidCursor of invalid)await assert.rejects(f.staff.receipts(f.identity,{asOf:'2026-10-31',cursor:invalidCursor}),code('INVALID_RECEIPT_CURSOR'));
 await assert.rejects(f.staff.receipts(f.identity,{asOf:'2026-10-15',cursor:first.nextCursor!}),code('INVALID_RECEIPT_CURSOR'));
 await assert.rejects(f.staff.receipts(f.identity,{asOf:'2026-10-31',propertyId,cursor:first.nextCursor!}),code('INVALID_RECEIPT_CURSOR'));
 await f.pg.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[f.users.admin.id]);
 await assert.rejects(f.staff.receipts(f.identity,{asOf:'2026-10-31',cursor:first.nextCursor!}),code('UNAUTHENTICATED'));
});
test('Receipt paging fails visibly if a custom source adapter ignores the cursor instead of silently dropping rows',async t=>{
 const f=await setup(t),r=await f.receipt();
 const reader:ReceiptSourceReader={...localReceiptReader,list:async sql=>{const value=await localReceiptReader.read(sql,'classified-receipt',String(r.id));return Array(101).fill(value);}};
 const service=new StaffCollectionsService(f.properties,reader);
 await assert.rejects(service.receipts(f.identity,{asOf:'2026-10-31'}),code('SOURCE_PAGE_INVALID'));
 const ignored:ReceiptSourceReader={...localReceiptReader,list:async sql=>{const value=await localReceiptReader.read(sql,'classified-receipt',String(r.id));assert.ok(value);return [value];}};
 const cursor=Buffer.from(JSON.stringify({version:1,asOf:'2026-10-31',propertyId:null,kind:'classified-receipt',date:'2026-10-15',id:r.id})).toString('base64url');
 await assert.rejects(new StaffCollectionsService(f.properties,ignored).receipts(f.identity,{asOf:'2026-10-31',cursor}),code('SOURCE_PAGE_INVALID'));
});
