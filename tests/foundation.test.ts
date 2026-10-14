import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { fixture, adapter, up, issuer } from './support/fixture';
import { PropertyService } from '../src/service';
import { capabilities } from '../src/permissions';
import { SupabaseIdentityProvider } from '../src/auth';
import { unavailable } from '../src/http';
import { LocalPostgresDatabase } from '../src/database';
let f:Awaited<ReturnType<typeof fixture>>;
const pre=(p:{id:string;version:number},key=randomUUID())=>({'Idempotency-Key':key,'If-Match':`"property:${p.id}:${p.version}"`});
before(async()=>{f=await fixture();});after(async()=>{await f?.pg.close();});
test('missing, invalid, expired and disabled identities are rejected',async()=>{
  for(const user of [null,'bad-token','disabled',f.provider.issue(f.users.admin.subject,issuer,0)])assert.equal((await f.request(user,'GET','/properties')).status,401);
});
test('another issuer or unknown subject cannot become a HAMDEE member',async()=>{
  for(const token of [f.provider.issue(f.users.admin.subject,'https://other-venture.invalid'),f.provider.issue(randomUUID())])assert.equal((await f.request(token,'GET','/properties')).status,401);
});
test('SDK identity abstraction uses server getUser and discards client role claims',async()=>{
  let called='';const provider=new SupabaseIdentityProvider({auth:{getUser:async token=>{called=token;return {data:{user:{id:f.users.admin.subject}},error:null};}}},issuer);
  const identity=await provider.validate(new Request('http://local',{headers:{Authorization:'Bearer opaque',Role:'admin'}}));
  assert.equal(called,'opaque');assert.deepEqual(identity,{issuer,subject:f.users.admin.subject});
  const broken=new SupabaseIdentityProvider({auth:{getUser:async()=>({data:{user:null},error:'private provider failure'})}},issuer);
  await assert.rejects(()=>broken.validate(new Request('http://local',{headers:{Authorization:'Bearer invalid'}})),/authorized account/);
});
test('database permission catalog matches the centralized role map',async()=>{
  for(const [role,expected]of Object.entries(capabilities)){
    const rows=(await f.pg.query<{capability:string}>('SELECT capability FROM hamdee_private.role_permissions WHERE role=$1',[role])).rows;
    assert.deepEqual(rows.map(r=>r.capability).sort(),[...expected].sort());
  }
});
test('admin creates metadata and another validated session retrieves it',async()=>{
  const p=await f.create();const token=f.provider.issue(f.users.admin.subject);
  const result=await f.request(token,'GET','/properties/'+p.id);assert.equal(result.status,200);assert.equal((await result.json()).data.id,p.id);
  assert.equal(p.version,1);assert.equal(p.lifecycleStatus,'registered');assert.equal(p.createdBy,f.users.admin.id);assert.equal(p.location,null);
});
test('scoped operations creation grants only its own new property, then edit persists',async()=>{
  const own=await f.create('ops');const other=await f.create();
  assert.equal((await f.request('ops','GET','/properties/'+other.id)).status,404);
  const result=await f.request('ops','PATCH','/properties/'+own.id,{name:'Synthetic edited'},pre(own));assert.equal(result.status,200);
  const reload=await f.request('ops','GET','/properties/'+own.id);assert.equal((await reload.json()).data.name,'Synthetic edited');
  assert.equal((await f.pg.query('SELECT * FROM hamdee_private.property_access WHERE assignment_id=$1 AND property_id=$2',[f.users.ops.assignment,own.id])).rows.length,1);
});
test('finance and read-only can read assigned records, cannot modify or escalate roles',async()=>{
  const p=await f.create();
  for(const user of ['finance','reader']){
    await f.pg.query('INSERT INTO hamdee_private.property_access VALUES($1,$2)',[f.users[user].assignment,p.id]);
    assert.equal((await f.request(user,'GET','/properties/'+p.id)).status,200);
    assert.equal((await f.request(user,'GET','/properties/'+p.id+'/audit')).status,user==='finance'?200:403);
    assert.equal((await f.request(user,'PATCH','/properties/'+p.id,{name:'No'},pre(p))).status,403);
    assert.equal((await f.request(user,'POST','/properties',{name:'No'},{'Idempotency-Key':randomUUID(),Role:'admin'})).status,403);
  }
  assert.equal((await f.request('ops','POST','/properties',{name:'No',role:'admin'},{'Idempotency-Key':randomUUID()})).status,422);
});
test('no implicit admin portfolio scope and no unassigned record or audit access',async()=>{
  const p=await f.create();
  for(const user of ['unassigned','scopedAdmin']){
    assert.equal((await f.request(user,'GET','/properties/'+p.id)).status,404);
    assert.equal((await f.request(user,'GET','/properties/'+p.id+'/audit')).status,404);
    const result=await f.request(user,'GET','/properties?archiveState=all');assert.deepEqual((await result.json()).data,[]);
  }
});
test('empty cursor from a browser filter means the first page',async()=>{
  assert.equal((await f.request('admin','GET','/properties?archiveState=active&q=&limit=50&cursor=')).status,200);
});
test('role scope cannot combine a reader assignment with an unrelated editor grant',async()=>{
  const a=await f.create(),b=await f.create(),assignment=randomUUID();
  await f.pg.query('INSERT INTO hamdee_private.role_assignments VALUES($1,$2,$3,false,NULL)',[assignment,f.users.reader.id,'operations']);
  await f.pg.query('INSERT INTO hamdee_private.property_access VALUES($1,$2),($3,$4)',[f.users.reader.assignment,a.id,assignment,b.id]);
  assert.equal((await f.request('reader','PATCH','/properties/'+a.id,{name:'Denied'},pre(a))).status,403);
  assert.equal((await f.request('reader','PATCH','/properties/'+b.id,{name:'Allowed'},pre(b))).status,200);
});
test('duplicate and concurrent duplicate creates yield exactly one durable result',async()=>{
  const key=randomUUID();const responses=await Promise.all([1,2].map(()=>f.request('admin','POST','/properties',{name:'Synthetic repeated'},{'Idempotency-Key':key})));
  assert.deepEqual(responses.map(r=>r.status),[201,201]);
  const a=await responses[0].json(),b=await responses[1].json();assert.equal(a.data.id,b.data.id);
  assert.equal((await f.pg.query('SELECT * FROM hamdee_private.audit_events WHERE property_id=$1',[a.data.id])).rows.length,1);
  const changed=await f.request('admin','POST','/properties',{name:'Changed'},{'Idempotency-Key':key});assert.equal(changed.status,409);
});
test('accepted update retries replay before version comparison; altered preconditions conflict',async()=>{
  const p=await f.create(),headers=pre(p);const route='/properties/'+p.id;
  assert.equal((await f.request('admin','PATCH',route,{name:'Synthetic retry'},headers)).status,200);
  const retry=await f.request('admin','PATCH',route,{name:'Synthetic retry'},headers);assert.equal(retry.status,200);assert.equal(retry.headers.get('Idempotent-Replay'),'true');
  const mismatch=await f.request('admin','PATCH',route,{name:'Synthetic retry'},{...headers,'If-Match':`"property:${p.id}:2"`});assert.equal(mismatch.status,409);
});
test('concurrent different edits detect stale revision with one commit',async()=>{
  const p=await f.create();const responses=await Promise.all(['A','B'].map(name=>f.request('admin','PATCH','/properties/'+p.id,{name},pre(p))));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,412]);
  const after=await f.request('admin','GET','/properties/'+p.id);assert.equal((await after.json()).data.version,2);
});
test('audit insertion failure rolls back property, revision and command',async()=>{
  const before=(await f.pg.query<{count:number}>('SELECT count(*)::int AS count FROM hamdee_private.properties')).rows[0].count;
  await f.pg.exec(`CREATE FUNCTION hamdee_private.test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END $$;
    CREATE TRIGGER test_fail BEFORE INSERT ON hamdee_private.audit_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.test_fail_audit();`);
  const key=randomUUID();assert.equal((await f.request('admin','POST','/properties',{name:'Rollback'},{'Idempotency-Key':key})).status,503);
  assert.equal((await f.pg.query<{count:number}>('SELECT count(*)::int AS count FROM hamdee_private.properties')).rows[0].count,before);
  assert.equal((await f.pg.query('SELECT * FROM hamdee_private.commands WHERE key=$1',[key])).rows.length,0);
  await f.pg.exec('DROP TRIGGER test_fail ON hamdee_private.audit_events; DROP FUNCTION hamdee_private.test_fail_audit();');
  assert.equal((await f.request('admin','POST','/properties',{name:'Rollback'},{'Idempotency-Key':key})).status,201);
});
test('archive/restore retain identity, actor, reasons and history',async()=>{
  const p=await f.create();const archived=await f.request('admin','POST','/properties/'+p.id+'/archive',{reason:'Synthetic review'},pre(p));assert.equal(archived.status,200);
  const a=(await archived.json()).data;assert.equal(a.id,p.id);assert.equal(a.archivedBy,f.users.admin.id);assert.equal(a.archiveReason,'Synthetic review');
  assert.equal((await f.request('admin','GET','/properties/'+p.id)).status,200);
  const list=await f.request('admin','GET','/properties?archiveState=active&limit=100');assert.ok(!(await list.json()).data.some((x:{id:string})=>x.id===p.id));
  const restored=await f.request('admin','POST','/properties/'+p.id+'/restore',{reason:'Synthetic restore'},pre(a));assert.equal(restored.status,200);
  const r=(await restored.json()).data;assert.equal(r.id,p.id);assert.equal(r.version,3);assert.equal(r.createdAt,p.createdAt);assert.equal(r.archivedAt,null);
  const audit=await f.request('admin','GET','/properties/'+p.id+'/audit');assert.deepEqual((await audit.json()).data.map((x:{action:string})=>x.action),['create','archive','restore']);
});
test('unauthorized archive and operations audit denied on direct requests',async()=>{
  const p=await f.create('ops');assert.equal((await f.request('ops','POST','/properties/'+p.id+'/archive',{reason:'No'},pre(p))).status,403);
  assert.equal((await f.request('ops','GET','/properties/'+p.id+'/audit')).status,403);
});
test('invalid metadata, server fields, finance values and invalid references rejected',async()=>{
  for(const body of [{name:''},{name:'x'.repeat(201)},{name:'x',rent:10},{name:'x',id:randomUUID()},{name:'x',location:4},{name:'x',counterpartyId:randomUUID()}]){
    assert.equal((await f.request('admin','POST','/properties',body,{'Idempotency-Key':randomUUID()})).status,422);
  }
});
test('missing keys, revisions, bad origin, oversized body and bad queries fail safely',async()=>{
  const p=await f.create();assert.equal((await f.request('admin','POST','/properties',{name:'X'})).status,400);
  assert.equal((await f.request('admin','PATCH','/properties/'+p.id,{name:'X'},{'Idempotency-Key':randomUUID()})).status,428);
  assert.equal((await f.request('admin','PATCH','/properties/'+p.id,{name:'X'},{...pre(p),Origin:'https://other.invalid'})).status,403);
  assert.equal((await f.request('admin','POST','/properties',{name:'x'.repeat(20000)},{'Idempotency-Key':randomUUID()})).status,413);
  assert.equal((await f.request('admin','GET','/properties?limit=0')).status,400);
});
test('database RLS denies raw access and append-only audit mutation',async()=>{
  const rows=await f.pg.transaction(async tx=>{await tx.query('SET LOCAL ROLE hamdee_runtime');await tx.query("SELECT set_config('hamdee.actor',$1,true)",[f.users.unassigned.id]);return (await tx.query('SELECT * FROM hamdee_private.properties')).rows;});assert.equal(rows.length,0);
  await assert.rejects(()=>f.pg.query('DELETE FROM hamdee_private.audit_events'),/append-only/);
});
test('fresh role revocation or disablement denies access and replay',async()=>{
  const p=await f.create('ops'),headers=pre(p);await f.request('ops','PATCH','/properties/'+p.id,{name:'Before revocation'},headers);
  await f.pg.query('UPDATE hamdee_private.role_assignments SET revoked_at=clock_timestamp() WHERE id=$1',[f.users.ops.assignment]);
  assert.equal((await f.request('ops','PATCH','/properties/'+p.id,{name:'Before revocation'},headers)).status,404);
  await f.pg.query('UPDATE hamdee_private.role_assignments SET revoked_at=NULL WHERE id=$1',[f.users.ops.assignment]);
});
test('missing environment marker fails closed; no shared venture environment lookup',async()=>{
  await f.pg.query('DELETE FROM hamdee_private.application_identity');assert.equal((await f.request('admin','GET','/properties')).status,503);
  await f.pg.query("INSERT INTO hamdee_private.application_identity VALUES(true,'hamdee','local-test')");
  process.env.SUPABASE_URL='https://another-venture.invalid';
  try{assert.equal((await unavailable()).status,503);}finally{delete process.env.SUPABASE_URL;}
});
test('native PostgreSQL adapter rejects remote hosts and other venture database names before connecting',()=>{
  for(const url of ['postgres://u:p@db.remote.invalid/hamdee_dev_test','postgres://u:p@127.0.0.1/another_venture'])
    assert.throws(()=>new LocalPostgresDatabase(url),/dedicated local HAMDEE/);
});
test('migration down/up runs only on disposable schema and relational FKs reject orphans',async()=>{
  const pg=new PGlite();try{
    await pg.exec(await up());await assert.rejects(()=>pg.query('INSERT INTO hamdee_private.property_access VALUES($1,$2)',[randomUUID(),randomUUID()]));
    await pg.exec(await readFile(new URL('../migrations/001_property_foundation.down.sql',import.meta.url),'utf8'));
    await pg.exec(await up());assert.equal((await pg.query('SELECT * FROM hamdee_private.app_users')).rows.length,0);
  }finally{await pg.close();}
});
test('on-disk PostgreSQL WASM persistence survives close and reopen',async()=>{
  const disk=await fixture(true),p=await disk.create();const identity={issuer,subject:disk.users.admin.subject};await disk.pg.close();
  const reopened=new PGlite(disk.dataDir);try{const service=new PropertyService(adapter(reopened));assert.equal((await service.get(identity,p.id)).id,p.id);}finally{await reopened.close();}
});
