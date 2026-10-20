import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../src/errors';
import { createOwnerQaFixture } from '../support/owner-crm-harness';

const base='/api/hamdee/v1/partners', query='?month=2026-10&asOf=2026-10-31';
type Row=Record<string,unknown>;
async function fixture(t:TestContext){
  const f=await createOwnerQaFixture({migrationFiles:['008_local_partner_records.up.sql']});
  t.after(()=>f.close());return f;
}
async function command(f:Awaited<ReturnType<typeof fixture>>,body:Row,key=randomUUID()){
  const response=await f.request('POST',base+'/commands',body,{'Idempotency-Key':key});
  const result=await response.json();assert.equal(response.status,201,JSON.stringify(result));return result.data as Row;
}
async function project(f:Awaited<ReturnType<typeof fixture>>){
  await f.login();
  const response=await f.request('POST','/api/hamdee/v1/properties',{name:'SYNTHETIC independent partner property'},{'Idempotency-Key':randomUUID()});
  assert.equal(response.status,201);const property=(await response.json()).data as Row;
  const partner=await command(f,{action:'create-partner',name:'SYNTHETIC independent partner'});
  await command(f,{action:'link-property',propertyId:property.id,partnerId:partner.id});
  const movement={action:'record-entry',propertyId:property.id,partnerId:partner.id,kind:'contribution',entryDate:'2026-10-01',amount:'10',currency:'XTS'};
  return {property,partner,movement};
}

test('Independent partner HTTP: managed owner, CSRF, origin, exact allowlists and private responses',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('GET',base+query)).status,401);
  await f.login();
  const body={action:'create-partner',name:'SYNTHETIC protected contact'};
  const csrf=await f.request('POST',base+'/commands',body,{'Idempotency-Key':randomUUID(),'X-Hamdee-CSRF':''});
  assert.equal(csrf.status,403);
  const origin=await f.request('POST',base+'/commands',body,{'Idempotency-Key':randomUUID(),Origin:'https://unauthorized.example.invalid'});
  assert.equal(origin.status,403);
  assert.equal((await f.request('POST',base+'/commands',body)).status,400);
  for(const suffix of ['&month=2026-10','&unexpected=1','&limit=0','&limit=101'])assert.equal((await f.request('GET',base+query+suffix)).status,400);
  assert.equal((await f.request('POST',base+'/commands',{...body,profitShare:'50'},{'Idempotency-Key':randomUUID()})).status,422);
  assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partners')).rows[0].n,0);
  const read=await f.request('GET',base+query);assert.equal(read.status,200);
  assert.equal(read.headers.get('Cache-Control'),'private, no-store');
  assert.equal((await read.json()).data.moneyUnit,'decimal-major-unit-strings');
  const saved=await command(f,body);
  await f.pg!.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[f.member!.id]);
  assert.equal((await f.request('GET',base+query)).status,401);
  assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partners WHERE id=$1',[saved.id])).rows[0].n,1);
});

test('Independent partner statement: pagination retains exact full totals, saved cutoff and currency separation',async t=>{
  const f=await fixture(t),p=await project(f);
  await command(f,{...p.movement,amount:'9007199254740993.123456789012'});
  await command(f,{...p.movement,kind:'withdrawal',entryDate:'2026-10-02',amount:'0.000000000001'});
  await command(f,{...p.movement,currency:'INR',entryDate:'2026-10-03',amount:'2'});
  const first=(await (await f.request('GET',base+query+'&limit=1')).json()).data;
  assert.equal(first.entries.length,1);assert.ok(first.nextEntryCursor);
  const xts=first.currencies.find((r:Row)=>r.currency==='XTS');
  assert.equal(xts.recordedNet,'9007199254740993.123456789011');
  assert.equal(first.currencies.find((r:Row)=>r.currency==='INR').recordedNet,'2');
  for(const field of ['profit','entitlement','settlement','distributableProfit'])assert.equal(field in xts,false);
  await command(f,{...p.movement,amount:'100'});
  const suffix='&limit=1&entryCursor='+encodeURIComponent(first.nextEntryCursor);
  const second=(await (await f.request('GET',base+query+suffix)).json()).data;
  assert.equal(second.recordedThrough,first.recordedThrough);
  assert.equal(second.currencies.find((r:Row)=>r.currency==='XTS').recordedNet,xts.recordedNet);
  const changed=await f.request('GET',base+query+suffix+'&propertyId='+randomUUID());
  assert.equal(changed.status,400);assert.equal((await changed.json()).error.code,'INVALID_CURSOR');
});

test('Independent partner rollback: late managed-session rejection leaves no movement, audit or replay receipt',async t=>{
  const f=await fixture(t),p=await project(f),key=randomUUID();
  const before=(await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partner_events')).rows[0].n;
  const original=f.fake.provider.verifySession;let checks=0;
  f.fake.provider.verifySession=async tokens=>{
    if(++checks===3)throw new ApiError(401,'UNAUTHENTICATED','Synthetic independent late provider denial.');
    return original(tokens);
  };
  // The application deliberately captures bound provider methods at construction.
  f.rebuildApplication();
  const response=await f.request('POST',base+'/commands',p.movement,{'Idempotency-Key':key});
  assert.equal(response.status,401);assert.equal(checks,3);
  assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partner_entries')).rows[0].n,0);
  assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partner_events')).rows[0].n,before);
  assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partner_commands WHERE key=$1',[key])).rows[0].n,0);
});

test('Independent partner SQL: forced RLS, invoker helpers and restricted contact-column grants survive disabled membership',async t=>{
  const f=await fixture(t);await f.login();await command(f,{action:'create-partner',name:'SYNTHETIC SQL protected contact'});
  const tables=['partners','partner_revisions','property_partners','partner_entries','partner_events','partner_commands'];
  for(const table of tables){
    const row=(await f.pg!.query<{rls:boolean;forced:boolean;read:boolean;insert:boolean;remove:boolean;update:boolean}>(`SELECT c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
      has_table_privilege('hamdee_runtime',c.oid,'SELECT') AS read,has_table_privilege('hamdee_runtime',c.oid,'INSERT') AS insert,
      has_table_privilege('hamdee_runtime',c.oid,'DELETE') AS remove,has_table_privilege('hamdee_runtime',c.oid,'UPDATE') AS update
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hamdee_private' AND c.relname=$1`,[table])).rows[0];
    assert.deepEqual(row,{rls:true,forced:true,read:true,insert:true,remove:false,update:false});
  }
  for(const [column,allowed] of [['name',true],['phone',true],['email',true],['notes',true],['version',true],['event_id',true],['id',false],['created_by',false],['created_at',false]] as const){
    assert.equal((await f.pg!.query<{allowed:boolean}>("SELECT has_column_privilege('hamdee_runtime','hamdee_private.partners',$1,'UPDATE') AS allowed",[column])).rows[0].allowed,allowed);
  }
  const helpers=['partner_record_owner','guard_partner_profile','require_partner_evidence'];
  assert.equal((await f.pg!.query<{n:number}>(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hamdee_private' AND p.proname=ANY($1::text[]) AND p.prosecdef`,[helpers])).rows[0].n,0);
  assert.equal((await f.pg!.query<{n:number}>(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='hamdee_private'
    AND p.proname=ANY($1::text[]) AND a.grantee=0 AND a.privilege_type='EXECUTE'`,[helpers])).rows[0].n,0);
  await f.pg!.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[f.member!.id]);
  const denied=await f.pg!.transaction(async sql=>{
    await sql.exec('SET LOCAL ROLE hamdee_runtime');await sql.query("SELECT set_config('hamdee.actor',$1,true)",[f.member!.id]);
    return (await sql.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partners')).rows[0].n;
  });assert.equal(denied,0);
  await assert.rejects(f.pg!.transaction(async sql=>{
    await sql.exec('SET LOCAL ROLE hamdee_runtime');await sql.query("SELECT set_config('hamdee.actor',$1,true)",[f.member!.id]);
    await sql.query("INSERT INTO hamdee_private.partner_commands(actor_id,key,digest,result) VALUES($1,$2,$3,'{}')",[f.member!.id,randomUUID(),'a'.repeat(64)]);
  }),error=>(error as {code:string}).code==='42501');
});

test('Independent partner concurrent HTTP retries converge and stale edits do not overwrite the winner (serialized local adapter)',async t=>{
  const f=await fixture(t);await f.login();const key=randomUUID(),body={action:'create-partner',name:'SYNTHETIC simultaneous retry'};
  const responses=await Promise.all(Array.from({length:4},()=>f.request('POST',base+'/commands',body,{'Idempotency-Key':key})));
  assert.deepEqual(responses.map(r=>r.status),[201,201,201,201]);
  const values=await Promise.all(responses.map(r=>r.json()));assert.equal(new Set(values.map(r=>r.data.id)).size,1);
  assert.equal(values.filter(r=>!r.replay).length,1);
  const partnerId=values[0].data.id;
  const changed=await f.request('POST',base+'/commands',{...body,name:'SYNTHETIC changed retry'},{'Idempotency-Key':key});assert.equal(changed.status,409);
  const edits=await Promise.all(['A','B'].map(suffix=>f.request('POST',base+'/commands',{action:'update-partner',partnerId,expectedVersion:1,name:'SYNTHETIC winner '+suffix},{'Idempotency-Key':randomUUID()})));
  assert.deepEqual(edits.map(r=>r.status).sort(),[200,412]);
  assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partners')).rows[0].n,1);
  assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.partner_revisions')).rows[0].n,2);
});
