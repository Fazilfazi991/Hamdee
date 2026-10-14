import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,issuer } from './support/fixture';
import { LocalPostgresDatabase } from '../src/database';
let f:Awaited<ReturnType<typeof fixture>>;
before(async()=>{f=await fixture();});after(async()=>{await f?.pg.close();});

test('local database URL cannot override its checked host/database or inherit credentials',()=>{
  for(const url of [
    'postgres://u:p@127.0.0.1:5432/hamdee_dev_test?host=remote.invalid',
    'postgres://u:p@127.0.0.1:5432/hamdee_dev_test?database=other_venture',
    'postgres://127.0.0.1:5432/hamdee_dev_test',
    'https://u:p@127.0.0.1:5432/hamdee_dev_test'
  ])assert.throws(()=>new LocalPostgresDatabase(url));
});

test('database refuses a metadata editor using raw SQL to archive a property',async()=>{
  const p=await f.create('ops');
  await assert.rejects(()=>f.pg.transaction(async tx=>{
    await tx.query('SET LOCAL ROLE hamdee_runtime');
    await tx.query("SELECT set_config('hamdee.actor',$1,true),set_config('hamdee.action','update',true)",[f.users.ops.id]);
    await tx.query(`UPDATE hamdee_private.properties SET lifecycle_status='archived',archived_at=clock_timestamp(),archived_by=$2,archive_reason='Not authorized',updated_by=$2,version=version+1 WHERE id=$1`,[p.id,f.users.ops.id]);
  }));
  assert.equal((await f.service.get({issuer:'https://isolated-hamdee-tests.invalid/auth/v1',subject:f.users.ops.subject},p.id)).version,1);
});

test('database refuses a revision advance without its matching revision and audit evidence',async()=>{
  const p=await f.create();
  await assert.rejects(()=>f.pg.transaction(async tx=>{
    await tx.query('SET LOCAL ROLE hamdee_runtime');
    await tx.query("SELECT set_config('hamdee.actor',$1,true),set_config('hamdee.action','update',true)",[f.users.admin.id]);
    await tx.query('UPDATE hamdee_private.properties SET name=$2,version=version+1 WHERE id=$1',[p.id,'No audit']);
  }));
});

test('database rejects archived metadata with a null reason',async()=>{
  const p=await f.create();
  await assert.rejects(()=>f.pg.query(`UPDATE hamdee_private.properties SET lifecycle_status='archived',archived_at=clock_timestamp(),archived_by=$2,archive_reason=NULL WHERE id=$1`,[p.id,f.users.admin.id]));
});

test('invalid or overflowing audit cursors are client errors, not database failures',async()=>{
  const p=await f.create();
  for(const cursor of ['9007199254740993','999999999999999999999999999999999999'])
    assert.equal((await f.request('admin','GET',`/properties/${p.id}/audit?cursor=${cursor}`)).status,400);
});

test('unassigned identities cannot substitute identifiers across all property operations',async()=>{
  const p=await f.create();
  for(const user of ['unassigned','ops','scopedAdmin']){
    for(const [method,suffix,body]of [['GET','',undefined],['GET','/audit',undefined],['PATCH','',{name:'No'}],['POST','/archive',{reason:'No'}],['POST','/restore',{reason:'No'}]]as const){
      const response=await f.request(user,method,'/properties/'+p.id+suffix,body,{'Idempotency-Key':randomUUID(),'If-Match':`"property:${p.id}:1"`});
      assert.equal(response.status,404);
    }
  }
});

test('mutation payload cannot control actor, role, scope, revision or lifecycle',async()=>{
  for(const field of ['createdBy','updatedBy','actorId','role','portfolio','propertyAccess','version','lifecycleStatus']){
    assert.equal((await f.request('admin','POST','/properties',{name:'Synthetic', [field]:f.users.admin.id},{'Idempotency-Key':randomUUID()})).status,422);
  }
});

test('list pagination, search and audit pages contain only assigned properties',async()=>{
  const own=await f.create(),hidden=await f.create();
  await f.pg.query('INSERT INTO hamdee_private.property_access VALUES($1,$2)',[f.users.finance.assignment,own.id]);
  const page=await f.request('finance','GET','/properties?archiveState=all&limit=1');const result=await page.json();
  assert.deepEqual(result.data.map((p:{id:string})=>p.id),[own.id]);assert.equal(result.nextCursor,null);
  assert.equal((await f.request('finance','GET','/properties/'+hidden.id+'/audit')).status,404);
  assert.equal((await f.request('finance','GET',`/properties/${own.id}/audit?cursor=0&cursor=1`)).status,400);
});

test('counterparty reference cannot disclose or link an unrelated property reference',async()=>{
  const counterparty=randomUUID();await f.pg.query('INSERT INTO hamdee_private.counterparties VALUES($1,$2)',[counterparty,'Synthetic private reference']);
  const response=await f.request('admin','POST','/properties',{name:'Synthetic restricted reference',counterpartyId:counterparty},{'Idempotency-Key':randomUUID()});assert.equal(response.status,201);
  assert.equal((await f.request('ops','POST','/properties',{name:'Synthetic forbidden link',counterpartyId:counterparty},{'Idempotency-Key':randomUUID()})).status,422);
});

test('fresh disablement and scope removal block replay as well as reads',async()=>{
  const p=await f.create('ops'),key=randomUUID(),headers={'Idempotency-Key':key,'If-Match':`"property:${p.id}:1"`};
  assert.equal((await f.request('ops','PATCH','/properties/'+p.id,{name:'Before scope removal'},headers)).status,200);
  await f.pg.query('DELETE FROM hamdee_private.property_access WHERE assignment_id=$1 AND property_id=$2',[f.users.ops.assignment,p.id]);
  assert.equal((await f.request('ops','PATCH','/properties/'+p.id,{name:'Before scope removal'},headers)).status,404);
  await f.pg.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[f.users.ops.id]);
  try{assert.equal((await f.request('ops','GET','/properties')).status,401);}finally{await f.pg.query('UPDATE hamdee_private.app_users SET enabled=true WHERE id=$1',[f.users.ops.id]);}
});

test('creation context cannot rediscover a formerly assigned property',async()=>{
  const p=await f.create('ops');await f.pg.query('DELETE FROM hamdee_private.property_access WHERE assignment_id=$1 AND property_id=$2',[f.users.ops.assignment,p.id]);
  const rows=await f.pg.transaction(async tx=>{await tx.query('SET LOCAL ROLE hamdee_runtime');await tx.query("SELECT set_config('hamdee.actor',$1,true),set_config('hamdee.action','create',true),set_config('hamdee.new_property',$2,true)",[f.users.ops.id,randomUUID()]);return (await tx.query('SELECT id FROM hamdee_private.properties WHERE id=$1',[p.id])).rows;});assert.equal(rows.length,0);
});

test('audit failure rolls back an existing profile change and its revision',async()=>{
  const p=await f.create();await f.pg.exec("CREATE FUNCTION hamdee_private.fail_update_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER fail_update_audit BEFORE INSERT ON hamdee_private.audit_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.fail_update_audit();");
  try{assert.equal((await f.request('admin','PATCH','/properties/'+p.id,{name:'Rollback change'},{'Idempotency-Key':randomUUID(),'If-Match':`"property:${p.id}:1"`})).status,503);
    const current=await f.service.get({issuer,subject:f.users.admin.subject},p.id);assert.equal(current.name,p.name);assert.equal(current.version,1);
    assert.equal((await f.pg.query('SELECT * FROM hamdee_private.property_revisions WHERE property_id=$1',[p.id])).rows.length,1);
  }finally{await f.pg.exec('DROP TRIGGER fail_update_audit ON hamdee_private.audit_events; DROP FUNCTION hamdee_private.fail_update_audit();');}
});
