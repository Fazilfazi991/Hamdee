import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createHandler,type OperationsApiService} from '../src/http';
import {PropertyService} from '../src/service';
import {CompanyFinanceService} from '../src/company-finance';
import {createOwnerQaFixture,seedOwnerAppRecords} from './support/owner-crm-harness';
import {fixture as identityFixture,up,adapter} from './support/fixture';

const base='/api/hamdee/v1',period='month=2026-10&asOf=2026-10-16';
const migrationFiles=['006_local_operations_records.up.sql'];
async function response(r:Response,status:number,code?:string){
  const body=await r.json();assert.equal(r.status,status,JSON.stringify(body));
  assert.equal(r.headers.get('Cache-Control'),'private, no-store');assert.equal(r.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(r.headers.get('X-Request-Id'),body.requestId);if(code)assert.equal(body.error?.code,code);return body;
}
async function transport(t:TestContext){
  const calls:{kind:string;input:unknown;key?:string;requestId?:string}[]=[],flags={replay:false,invalidResult:false};
  const module:OperationsApiService={
    async overview(_identity,query){calls.push({kind:'overview',input:query});return {marker:'SYNTHETIC_TRANSPORT_ONLY',query};},
    async receipts(_identity,query){calls.push({kind:'receipts',input:query});return {receipts:[],query};},
    async mutate(_identity,input,key,requestId){calls.push({kind:'command',input,key,requestId});
      return flags.invalidResult?{privateCanary:'SYNTHETIC_NOT_A_PUBLIC_RESPONSE'}:{data:{id:'44440000-5555-4555-8555-555555555555'},replay:flags.replay};}
  };
  const f=await createOwnerQaFixture({operationsFactory:()=>({staffCollections:module,companyFinance:module})});
  t.after(()=>f.close());await f.login();return {f,calls,flags,module};
}

test('Operations API: frozen staff, receipt-picker and finance paths preserve explicit filters and replay transport',async t=>{
  const {f,calls,flags}=await transport(t),collectorId=randomUUID(),accountId=randomUUID(),propertyId=randomUUID();
  const overview=await response(await f.request('GET',base+'/staff-collections?'+period+'&collectorId='+collectorId),200);
  assert.deepEqual(overview.data.query,{month:'2026-10',asOf:'2026-10-16',collectorId});
  await response(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-16&propertyId='+propertyId),200);
  assert.deepEqual(calls.at(-1)?.input,{asOf:'2026-10-16',propertyId});
  await response(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-16&cursor=c3ludGhldGlj'),200);
  assert.deepEqual(calls.at(-1)?.input,{asOf:'2026-10-16',cursor:'c3ludGhldGlj'});
  await response(await f.request('GET',base+'/company-finance?'+period+'&accountId='+accountId),200);
  assert.deepEqual(calls.at(-1)?.input,{month:'2026-10',asOf:'2026-10-16',accountId});
  const key=randomUUID(),body={action:'create-collector',name:'Synthetic collector'};
  const first=await response(await f.request('POST',base+'/staff-collections/commands',body,{'Idempotency-Key':key}),200);
  assert.equal(first.replay,false);assert.equal(calls.at(-1)?.key,key);assert.deepEqual(calls.at(-1)?.input,body);
  assert.equal(calls.at(-1)?.requestId,first.requestId);flags.replay=true;
  const retry=await f.request('POST',base+'/staff-collections/commands',body,{'Idempotency-Key':key});
  assert.equal(retry.headers.get('Idempotent-Replay'),'true');assert.equal((await response(retry,200)).replay,true);
  assert.equal(calls.at(-1)?.key,key);
});

test('Operations API: ambiguous filters, invalid dates, wrong methods and paths never invoke a module',async t=>{
  const {f,calls}=await transport(t);
  for(const query of ['',period+'&month=2026-11',period+'&asOf=2026-10-17',period+'&amount=1',
    'month=2026-13&asOf=2026-10-16','month=2026-10&asOf=2026-02-30',period+'&collectorId=',period+'&collectorId=not-a-uuid'])
    await response(await f.request('GET',base+'/staff-collections?'+query),400,'INVALID_QUERY');
  await response(await f.request('GET',base+'/staff-collections/receipts?'+period),400,'INVALID_QUERY');
  for(const cursor of ['','bad!cursor','a'.repeat(513),'x&cursor=y'])
    await response(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-16&cursor='+cursor),400,'INVALID_QUERY');
  await response(await f.request('GET',base+'/company-finance?'+period+'&collectorId='+randomUUID()),400,'INVALID_QUERY');
  await response(await f.request('GET',base+'/staff-collections/private?'+period),404,'NOT_FOUND');
  await response(await f.request('GET',base+'/staff-collections/commands'),405,'METHOD_NOT_ALLOWED');
  await response(await f.request('POST',base+'/staff-collections',{}),405,'METHOD_NOT_ALLOWED');
  await response(await f.request('DELETE',base+'/staff-collections'),405,'METHOD_NOT_ALLOWED');
  assert.equal(calls.length,0);
});

test('Operations API: existing owner CSRF, JSON, size and UUID requirements precede module commands',async t=>{
  const {f,calls}=await transport(t),body={action:'create-collector',name:'Synthetic collector'},key=randomUUID();
  await response(await f.request('POST',base+'/staff-collections/commands',body,{'Idempotency-Key':key,'X-Hamdee-CSRF':''}),403,'CSRF_REJECTED');
  await response(await f.request('POST',base+'/staff-collections/commands',body,{'Idempotency-Key':key,Origin:'https://foreign.invalid'}),403,'CSRF_REJECTED');
  await response(await f.request('POST',base+'/staff-collections/commands',body,{'Idempotency-Key':''}),400,'IDEMPOTENCY_KEY_REQUIRED');
  await response(await f.request('POST',base+'/staff-collections/commands?month=2026-10',body,{'Idempotency-Key':key}),400,'INVALID_QUERY');
  await response(await f.request('POST',base+'/staff-collections/commands',body,{'Idempotency-Key':key,'Content-Type':'text/plain'}),415,'JSON_REQUIRED');
  await response(await f.request('POST',base+'/staff-collections/commands',{...body,notes:'x'.repeat(17_000)},{'Idempotency-Key':key}),413,'PAYLOAD_TOO_LARGE');
  const malformed=new Request(f.options.policy.origin+base+'/staff-collections/commands',{method:'POST',body:'{',
    headers:{Cookie:f.jar.header(),Origin:f.options.policy.origin,'X-Hamdee-CSRF':f.jar.csrfToken,'Content-Type':'application/json','Idempotency-Key':key}});
  await response(await f.app().handleProperties(malformed),400,'INVALID_JSON');assert.equal(calls.length,0);
});

test('Operations API: anonymous, expired, disabled and removed owner membership cannot reach a module',async t=>{
  const {f,calls}=await transport(t);await f.auth('POST','logout',{});
  await response(await f.request('GET',base+'/staff-collections?'+period),401,'UNAUTHENTICATED');
  await f.login();f.clock.advance(f.inputs.idleMilliseconds);
  await response(await f.request('GET',base+'/staff-collections?'+period),401,'UNAUTHENTICATED');
  await f.login();await f.pg!.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[f.member!.id]);
  await response(await f.request('GET',base+'/staff-collections?'+period),401);
  await f.pg!.query('UPDATE hamdee_private.app_users SET enabled=true WHERE id=$1',[f.member!.id]);await f.login();
  await f.pg!.query('UPDATE hamdee_private.role_assignments SET portfolio=false WHERE id=$1',[f.member!.assignment]);
  await response(await f.request('GET',base+'/staff-collections?'+period),403);assert.equal(calls.length,0);
});

test('Operations API: new modules fail closed independently of existing activation and never invent a response',async t=>{
  const f=await createOwnerQaFixture({operationsFactory:()=>({})});t.after(()=>f.close());await f.login();
  await response(await f.request('GET',base+'/staff-collections?'+period),503,'CONFIGURATION_UNAVAILABLE');
  await response(await f.request('GET',base+'/car-rentals?'+period),503,'CONFIGURATION_UNAVAILABLE');
  await response(await f.request('GET',base+'/dashboard'),200);
  const {f:g,flags}=await transport(t);flags.invalidResult=true;
  const denied=await response(await g.request('POST',base+'/staff-collections/commands',{action:'create-collector',name:'Synthetic collector'},{'Idempotency-Key':randomUUID()}),503,'CONFIGURATION_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(denied),/SYNTHETIC_NOT_A_PUBLIC_RESPONSE|privateCanary/);
});

test('Operations API: no existing nonportfolio or nonowner role gains operational access',async t=>{
  const f=await identityFixture();t.after(()=>f.pg.close());let calls=0;
  const module:OperationsApiService={async overview(){calls++;return {};},async mutate(){calls++;return {data:{},replay:false};}};
  const handle=createHandler(f.provider,f.service,()=>{},{staffCollections:module});
  for(const name of ['ops','finance','reader','unassigned','disabled','scopedAdmin']){
    const r=await handle(new Request('http://127.0.0.1:4181'+base+'/staff-collections?'+period,{headers:{Authorization:'Bearer '+f.users[name].token}}));
    assert.ok([401,403].includes(r.status));assert.equal((await r.json()).data,undefined);
  }
  assert.equal(calls,0);
});

test('Operations fixture: old migrations stay default and additional migration names cannot escape or repeat',async()=>{
  await assert.rejects(()=>up(['../../private.sql']));await assert.rejects(()=>up(['001_property_foundation.up.sql']));
  assert.doesNotMatch(await up(),/ops_collectors|ops_accounts/);
});

async function actual(t:TestContext){
  const f=await createOwnerQaFixture({migrationFiles});t.after(()=>f.close());await f.login();return f;
}
async function command(f:Awaited<ReturnType<typeof createOwnerQaFixture>>,module:string,body:unknown,key=randomUUID(),expected=200){
  const raw=await f.request('POST',base+'/'+module+'/commands',body,{'Idempotency-Key':key});
  return {raw,body:await response(raw,expected)};
}
async function funded(f:Awaited<ReturnType<typeof createOwnerQaFixture>>){
  const collector=(await command(f,'staff-collections',{action:'create-collector',name:'Synthetic API collector',phone:'TEST-ONLY'})).body.data;
  const account=(await command(f,'company-finance',{action:'create-account',name:'Synthetic company cash',scope:'company',kind:'cash',currency:'XTS',
    openingDate:'2026-10-01',openingAmount:'0',ownerConfirmedOpening:true})).body.data;
  const receipt=(await command(f,'company-finance',{action:'create-classified-receipt',receiptKey:randomUUID(),classification:'synthetic-other-receipt',
    receivedOn:'2026-10-15',amount:'100',currency:'XTS',method:'cash'})).body.data;
  return {collector,account,receipt};
}

test('Operations API: actual source receipt, collector custody and company handover reconcile without a second income receipt',async t=>{
  const f=await actual(t),{collector,account,receipt}=await funded(f);
  const choices=(await response(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-16'),200)).data;
  assert.equal(choices.moneyUnit,'decimal-major-unit-strings');assert.equal(choices.data[0].id,receipt.id);assert.equal(choices.data[0].amount,'100');
  assert.equal(choices.data[0].linked,false);assert.equal(choices.hasMore,false);
  const link={action:'record-collection',collectorId:collector.id,sourceKind:'classified-receipt',sourceId:receipt.id,
    disposition:'collector-held',ownerConfirmedDisposition:true},key=randomUUID();
  await command(f,'staff-collections',{...link,amount:'9999'},randomUUID(),422);
  const saved=await command(f,'staff-collections',link,key);assert.equal(saved.body.data.amount,'100');assert.equal(saved.body.data.source.date,'2026-10-15');
  const retry=await command(f,'staff-collections',link,key);assert.equal(retry.raw.headers.get('Idempotent-Replay'),'true');assert.deepEqual(retry.body.data,saved.body.data);
  await command(f,'staff-collections',link,randomUUID(),409);
  const handover={action:'handover',collectorId:collector.id,accountId:account.id,amount:'30',currency:'XTS',handedOn:'2026-10-16',reference:'SYNTHETIC-API-'+randomUUID()};
  const transfer=(await command(f,'staff-collections',handover)).body.data;
  await command(f,'staff-collections',handover,randomUUID(),409);
  await command(f,'staff-collections',{...handover,amount:'80',reference:'SYNTHETIC-OVER-'+randomUUID()},randomUUID(),409);
  const staff=(await response(await f.request('GET',base+'/staff-collections?'+period),200)).data;
  assert.equal(staff.moneyUnit,'decimal-major-unit-strings');assert.equal(staff.totals[0].received,'100');assert.equal(staff.totals[0].handedOver,'30');assert.equal(staff.totals[0].balance,'70');
  const finance=(await response(await f.request('GET',base+'/company-finance?'+period),200)).data;
  assert.equal(finance.totals[0].receipts,'0');assert.equal(finance.totals[0].transfersIn,'30');assert.equal(finance.totals[0].balance,'30');
  await command(f,'staff-collections',{action:'correct-handover',handoverId:transfer.id,accountId:account.id,amount:'25',currency:'XTS',
    handedOn:'2026-10-16',reference:'SYNTHETIC-CORRECT-'+randomUUID(),reason:'Synthetic confirmed correction'});
  const corrected=(await response(await f.request('GET',base+'/staff-collections?'+period),200)).data;
  assert.equal(corrected.handovers.length,2);assert.equal(corrected.totals[0].handedOver,'25');assert.equal(corrected.totals[0].balance,'75');
  assert.equal(corrected.handovers.find((h:{id:string})=>h.id===transfer.id).reversed,true);
  const edited=await command(f,'staff-collections',{action:'update-collector',collectorId:collector.id,expectedVersion:1,name:'Synthetic revised API collector'});
  assert.equal(edited.body.data.version,2);
  await command(f,'staff-collections',{action:'update-collector',collectorId:collector.id,expectedVersion:1,name:'Synthetic stale overwrite'},randomUUID(),412);
  assert.equal((await f.pg!.query<{count:number}>('SELECT count(*)::int AS count FROM hamdee_private.app_users')).rows[0].count,1);
  assert.equal((await f.pg!.query<{count:number}>('SELECT count(*)::int AS count FROM hamdee_private.role_assignments')).rows[0].count,1);
});

test('Operations API: actual audit failure rolls back handover, paired ledger and command; exact-key retry saves once',async t=>{
  const f=await actual(t),{collector,account,receipt}=await funded(f);
  await command(f,'staff-collections',{action:'record-collection',collectorId:collector.id,sourceKind:'classified-receipt',sourceId:receipt.id,
    disposition:'collector-held',ownerConfirmedDisposition:true});
  const counts=async()=>{
    const values=[];for(const table of ['ops_transfers','ops_money','ops_events','ops_commands'])
      values.push((await f.pg!.query<{count:number}>(`SELECT count(*)::int AS count FROM hamdee_private.${table}`)).rows[0].count);
    return values;
  };
  const before=await counts();
  await f.pg!.exec("CREATE FUNCTION hamdee_private.operations_api_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic operations audit failure'; END $$; CREATE TRIGGER operations_api_fail_event BEFORE INSERT ON hamdee_private.ops_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.operations_api_fail_event();");
  const body={action:'handover',collectorId:collector.id,accountId:account.id,amount:'30',currency:'XTS',handedOn:'2026-10-16',reference:'SYNTHETIC-ROLLBACK-'+randomUUID()},key=randomUUID();
  await command(f,'staff-collections',body,key,503);assert.deepEqual(await counts(),before);
  await f.pg!.exec('DROP TRIGGER operations_api_fail_event ON hamdee_private.ops_events; DROP FUNCTION hamdee_private.operations_api_fail_event();');
  const saved=await command(f,'staff-collections',body,key),retry=await command(f,'staff-collections',body,key);
  assert.deepEqual(saved.body.data,retry.body.data);assert.equal(retry.body.replay,true);
  const after=await counts();assert.deepEqual(after,before.map((n,i)=>n+(i===1?2:1)));
});

test('Operations API: unavailable optional migration does not block owner login, dashboard or property writes',async t=>{
  const f=await createOwnerQaFixture();t.after(()=>f.close());await f.login();
  await response(await f.request('GET',base+'/staff-collections?'+period),503);
  await response(await f.request('GET',base+'/company-finance?'+period),503);
  await response(await f.request('GET',base+'/dashboard'),200);
  await response(await f.request('POST',base+'/properties',{name:'Synthetic activation remains independent'},{'Idempotency-Key':randomUUID()}),201);
});

test('Operations API: collector records and balances survive database reopen and fresh owner login',async t=>{
  const directory=path.resolve('.test-data','operations-api-'+randomUUID());await mkdir(directory,{recursive:true});
  let pg=new PGlite(directory);t.after(async()=>{if(!pg.closed)await pg.close();});
  await pg.exec(await up(migrationFiles));await seedOwnerAppRecords(pg);
  const f=await createOwnerQaFixture({database:adapter(pg),pg});await f.login();const {collector,account,receipt}=await funded(f);
  await command(f,'staff-collections',{action:'record-collection',collectorId:collector.id,sourceKind:'classified-receipt',sourceId:receipt.id,
    disposition:'collector-held',ownerConfirmedDisposition:true});
  await command(f,'staff-collections',{action:'handover',collectorId:collector.id,accountId:account.id,amount:'30',currency:'XTS',handedOn:'2026-10-16',reference:'SYNTHETIC-REOPEN-'+randomUUID()});
  await pg.close();pg=new PGlite(directory);
  const reopened=await createOwnerQaFixture({database:adapter(pg),pg});await reopened.login();
  const staff=(await response(await reopened.request('GET',base+'/staff-collections?'+period),200)).data;
  const finance=(await response(await reopened.request('GET',base+'/company-finance?'+period),200)).data;
  assert.equal(staff.collectors[0].id,collector.id);assert.equal(staff.collections.length,1);assert.equal(staff.handovers.length,1);
  assert.equal(staff.totals[0].balance,'70');assert.equal(finance.totals[0].balance,'30');
});

test('Operations API: actual receipt keyset pages reach the newest record after100 and reject changed-filter or repeated cursors',{timeout:60_000},async t=>{
  const f=await actual(t),identity=f.options.policy.owner,finance=new CompanyFinanceService(new PropertyService(f.database,identity));
  let newestId='';
  for(let i=0;i<101;i++){
    const receivedOn=new Date(Date.UTC(2026,0,1)+i*86_400_000).toISOString().slice(0,10);
    const saved=await finance.mutate(identity,{action:'create-classified-receipt',receiptKey:randomUUID(),classification:'synthetic-pagination-receipt',
      receivedOn,amount:'1',currency:'XTS',method:'cash'},randomUUID(),randomUUID());newestId=String(saved.data.id);
  }
  const first=(await response(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-16'),200)).data;
  assert.equal(first.data.length,100);assert.equal(first.hasMore,true);assert.equal(typeof first.nextCursor,'string');
  const second=(await response(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-16&cursor='+encodeURIComponent(first.nextCursor)),200)).data;
  assert.equal(second.data.length,1);assert.equal(second.data[0].id,newestId);assert.equal(second.hasMore,false);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.data,...second.data].map((r:{kind:string;id:string})=>r.kind+':'+r.id)).size,101);
  await response(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-17&cursor='+first.nextCursor),400,'INVALID_RECEIPT_CURSOR');
  await response(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-16&cursor='+first.nextCursor+'&cursor='+first.nextCursor),400,'INVALID_QUERY');
  await response(await f.request('GET',base+'/staff-collections/receipts?asOf=2026-10-16&cursor=eA'),400,'INVALID_RECEIPT_CURSOR');
});
