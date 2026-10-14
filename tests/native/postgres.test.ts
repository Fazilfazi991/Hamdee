import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { LocalPostgresDatabase,localConnectionOptions,type Database,type Sql } from '../../src/database';
import { PropertyService } from '../../src/service';
import { createHandler } from '../../src/http';
import { TestIdentityProvider,issuer } from '../support/fixture';

// Explicit opt-in only. No generic DATABASE_URL, default port, existing service
// discovery, database creation/drop, container start or provider connection.
const connection=process.env.HAMDEE_NATIVE_TEST_URL;
const enabled=!!connection;
const native={skip:enabled?false:'BLOCKED: no explicitly isolated native PostgreSQL test URL supplied'};
let owner:Pool,a:LocalPostgresDatabase,b:LocalPostgresDatabase,backendConnection:string;
const provider=new TestIdentityProvider();
const users:Record<string,{id:string;subject:string;token:string;assignment:string}>={};
let handleA:ReturnType<typeof createHandler>,handleB:ReturnType<typeof createHandler>;
const request=(handle:typeof handleA,user:string,method:string,path:string,body?:unknown,headers:Record<string,string>={})=>handle(new Request('http://127.0.0.1:4181/api/hamdee/v1'+path,{method,headers:{Authorization:'Bearer '+users[user].token,Origin:'http://127.0.0.1:4181','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
const pre=(p:{id:string;version:number},key=randomUUID())=>({'Idempotency-Key':key,'If-Match':`"property:${p.id}:${p.version}"`});
async function create(){const response=await request(handleA,'admin','POST','/properties',{name:'Synthetic native property'},{'Idempotency-Key':randomUUID()});assert.equal(response.status,201);return (await response.json()).data;}

before(async()=>{
  if(!enabled)return;
  assert.equal(process.env.HAMDEE_NATIVE_TEST_CONFIRM,'disposable-local-hamdee','Explicit disposable-instance confirmation required');
  const config=localConnectionOptions(connection!);
  assert.match(config.database,/^hamdee_dev_task005_[a-z0-9_]+$/);
  owner=new Pool({...config,max:1});owner.on('error',()=>{});
  assert.equal((await owner.query("SELECT 1 FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',$1)",[config.database])).rowCount,0,'Refusing a shared cluster with another application database');
  const existing=await owner.query("SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'");
  assert.equal(existing.rowCount,0,'Refusing a nonempty or previously used database');
  assert.equal((await owner.query("SELECT 1 FROM pg_roles WHERE rolname IN ('hamdee_runtime','hamdee_backend_task005')")).rowCount,0,'Refusing a previously used cluster');
  assert.equal((await owner.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','m','S','f')")).rowCount,0);
  const client=await owner.connect();try{
    await client.query('BEGIN');
    for(const file of ['001_property_foundation.up.sql','002_property_hardening.up.sql'])await client.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
    const password=randomBytes(32).toString('hex');
    // Hex-only generated secret; never logged. Dedicated disposable DB login,
    // not an application administrator account or a default credential.
    await client.query(`CREATE ROLE hamdee_backend_task005 LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
    await client.query('GRANT hamdee_runtime TO hamdee_backend_task005');
    const url=new URL(connection!);url.username='hamdee_backend_task005';url.password=password;
    backendConnection=url.toString();
    a=new LocalPostgresDatabase(url.toString(),()=>{});b=new LocalPostgresDatabase(url.toString(),()=>{});
    for(const [name,role,portfolio]of [['admin','admin',true],['admin2','admin',true],['ops','operations',false],['reader','read_only',false],['finance','finance',false]]as const){
      const id=randomUUID(),subject=randomUUID(),assignment=randomUUID();
      await client.query('INSERT INTO hamdee_private.app_users VALUES($1,$2,$3,$4,true)',[id,issuer,subject,'Synthetic native '+name]);
      await client.query('INSERT INTO hamdee_private.role_assignments VALUES($1,$2,$3,$4,NULL)',[assignment,id,role,portfolio]);
      users[name]={id,subject,assignment,token:provider.issue(subject)};
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  handleA=createHandler(provider,new PropertyService(a),()=>{});handleB=createHandler(provider,new PropertyService(b),()=>{});
});
after(async()=>{await a?.close();await b?.close();await owner?.end();});

test('native: migrations, least-privilege login, independent sessions and relational constraints',native,async()=>{
  const pids=await Promise.all([a,b].map(db=>db.transaction(async sql=>(await sql.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid)));
  assert.notEqual(pids[0],pids[1]);
  assert.deepEqual((await Promise.all([a,b].map(db=>db.transaction(async sql=>(await sql.query<{setting:string}>("SELECT current_setting('transaction_isolation') AS setting")).rows[0].setting)))),['read committed','read committed']);
  console.log('Independent native backend PIDs:',pids.join(', '),'; isolation: read committed');
  assert.equal((await a.transaction(sql=>sql.query<{path:string}>("SELECT current_setting('search_path') AS path"))).rows[0].path,'pg_catalog');
  assert.equal((await owner.query("SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole AS elevated FROM pg_roles WHERE rolname='hamdee_backend_task005'")).rows[0].elevated,false);
  await assert.rejects(()=>owner.query('INSERT INTO hamdee_private.property_access VALUES($1,$2)',[randomUUID(),randomUUID()]));
  await assert.rejects(()=>owner.query('INSERT INTO hamdee_private.counterparties VALUES($1,NULL)',[randomUUID()]));
  const id=randomUUID();await owner.query('INSERT INTO hamdee_private.counterparties VALUES($1,$2)',[id,'Synthetic reference']);
  await assert.rejects(()=>owner.query('INSERT INTO hamdee_private.counterparties VALUES($1,$2)',[id,'Duplicate']));
  console.log('Native engine:',(await owner.query('SHOW server_version')).rows[0].server_version,'; independent backend sessions confirmed');
});

test('native: concurrent identical creates and ambiguous-response replay commit once',native,async()=>{
  const key=randomUUID(),headers={'Idempotency-Key':key},body={name:'Synthetic concurrent native create'};
  const responses=await Promise.all([handleA,handleB].map(h=>request(h,'admin','POST','/properties',body,headers)));
  assert.deepEqual(responses.map(r=>r.status),[201,201]);const [x,y]=await Promise.all(responses.map(r=>r.json()));assert.equal(x.data.id,y.data.id);
  const retry=await request(handleB,'admin','POST','/properties',body,headers);assert.equal(retry.headers.get('Idempotent-Replay'),'true');assert.equal((await retry.json()).data.id,x.data.id);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM hamdee_private.audit_events WHERE property_id=$1',[x.data.id])).rows[0].n,1);
  assert.equal((await request(handleA,'admin','POST','/properties',{name:'Changed'},headers)).status,409);
  // Discard the first committed response entirely: the caller has no returned
  // property identity/status and retries the identical operation on pool B.
  const lostKey=randomUUID(),lostHeaders={'Idempotency-Key':lostKey},lostBody={name:'Synthetic discarded native response'};
  await request(handleA,'admin','POST','/properties',lostBody,lostHeaders);
  const recovered=await request(handleB,'admin','POST','/properties',lostBody,lostHeaders);
  assert.equal(recovered.status,201);assert.equal(recovered.headers.get('Idempotent-Replay'),'true');
  const recoveredId=(await recovered.json()).data.id;
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM hamdee_private.properties WHERE name=$1',[lostBody.name])).rows[0].n,1);
  for(const table of ['property_revisions','audit_events'])assert.equal((await owner.query('SELECT count(*)::int AS n FROM hamdee_private.'+table+' WHERE property_id=$1',[recoveredId])).rows[0].n,1);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM hamdee_private.commands WHERE key=$1',[lostKey])).rows[0].n,1);
});

test('native: two authorized actors read one revision before racing independent UPDATE sessions',native,async()=>{
  const p=await create();let arrivals=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const racing=(db:Database):Database=>({transaction:work=>db.transaction(sql=>work({query:async<T>(text:string,params?:unknown[])=>{
    if(text.startsWith('UPDATE hamdee_private.properties')){if(++arrivals===2)release();await gate;}return sql.query<T>(text,params);
  }}))});
  const handlers=[a,b].map(db=>createHandler(provider,new PropertyService(racing(db)),()=>{}));
  const responses=await Promise.all(handlers.map((h,i)=>request(h,i?'admin2':'admin','PATCH','/properties/'+p.id,{name:'Native competing '+i},pre(p))));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,412]);
  assert.equal((await owner.query('SELECT version FROM hamdee_private.properties WHERE id=$1',[p.id])).rows[0].version,2);
});

test('native: audit insertion failure rolls back create and update with retry recovery',native,async()=>{
  const p=await create();await owner.query("CREATE FUNCTION hamdee_private.native_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER native_fail BEFORE INSERT ON hamdee_private.audit_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.native_fail();");
  const key=randomUUID();try{
    assert.equal((await request(handleA,'admin','POST','/properties',{name:'Synthetic native rollback'},{'Idempotency-Key':key})).status,503);
    assert.equal((await request(handleB,'admin','PATCH','/properties/'+p.id,{name:'Must roll back'},pre(p))).status,503);
    assert.equal((await owner.query('SELECT name,version FROM hamdee_private.properties WHERE id=$1',[p.id])).rows[0].version,1);
    assert.equal((await owner.query('SELECT 1 FROM hamdee_private.commands WHERE key=$1',[key])).rowCount,0);
  }finally{await owner.query('DROP TRIGGER native_fail ON hamdee_private.audit_events; DROP FUNCTION hamdee_private.native_fail();');}
  assert.equal((await request(handleB,'admin','POST','/properties',{name:'Synthetic native rollback'},{'Idempotency-Key':key})).status,201);
});

test('native: scoped direct requests, forbidden archive/restore and invalid metadata',native,async()=>{
  const p=await create();
  for(const user of ['ops','reader','finance']){
    assert.equal((await request(handleB,user,'GET','/properties/'+p.id)).status,404);
    await owner.query('INSERT INTO hamdee_private.property_access VALUES($1,$2)',[users[user].assignment,p.id]);
    assert.equal((await request(handleB,user,'POST','/properties/'+p.id+'/archive',{reason:'No'},pre(p))).status,403);
    assert.equal((await request(handleB,user,'POST','/properties/'+p.id+'/restore',{reason:'No'},pre(p))).status,403);
  }
  assert.equal((await request(handleA,'admin','POST','/properties',{name:'Invalid',actor:users.admin.id},{'Idempotency-Key':randomUUID()})).status,422);
});

test('native: archive/restore retain original identity, creation and audit history',native,async()=>{
  const p=await create();const ar=await request(handleA,'admin','POST','/properties/'+p.id+'/archive',{reason:'Synthetic native archive'},pre(p));assert.equal(ar.status,200);const archived=(await ar.json()).data;
  const re=await request(handleB,'admin2','POST','/properties/'+p.id+'/restore',{reason:'Synthetic native restore'},pre(archived));assert.equal(re.status,200);const restored=(await re.json()).data;
  assert.equal(restored.id,p.id);assert.equal(restored.createdAt,p.createdAt);
  assert.equal((await (await request(handleA,'admin','GET','/properties/'+p.id)).json()).data.version,3);
  assert.deepEqual((await owner.query('SELECT actor_id FROM hamdee_private.audit_events WHERE property_id=$1 ORDER BY version',[p.id])).rows.map(r=>r.actor_id),[users.admin.id,users.admin.id,users.admin2.id]);
  assert.deepEqual((await owner.query('SELECT action FROM hamdee_private.audit_events WHERE property_id=$1 ORDER BY version',[p.id])).rows.map(r=>r.action),['create','archive','restore']);
});

test('native: populated 001 schema upgrades to 002 and persists across independent backend pools',native,async()=>{
  const upgradeDatabase='hamdee_dev_task006_upgrade_'+randomUUID().replaceAll('-','');
  assert.match(upgradeDatabase,/^hamdee_dev_task006_upgrade_[0-9a-f]{32}$/);
  await owner.query('CREATE DATABASE "'+upgradeDatabase+'"');
  const adminOptions={...localConnectionOptions(connection!),database:upgradeDatabase,max:1},adminPool=new Pool(adminOptions);adminPool.on('error',()=>{});
  const url=new URL(backendConnection);url.pathname='/'+upgradeDatabase;
  const first=new LocalPostgresDatabase(url.toString(),()=>{}),second=new LocalPostgresDatabase(url.toString(),()=>{});
  try{
    await adminPool.query(await readFile(new URL('../../migrations/001_property_foundation.up.sql',import.meta.url),'utf8'));
    await adminPool.query('INSERT INTO hamdee_private.app_users VALUES($1,$2,$3,$4,true)',[users.admin.id,issuer,users.admin.subject,'Synthetic upgrade user']);
    await adminPool.query("INSERT INTO hamdee_private.role_assignments VALUES($1,$2,'admin',true,NULL)",[randomUUID(),users.admin.id]);
    const identity={issuer,subject:users.admin.subject},service=new PropertyService(first);
    const before=await service.mutate(identity,{action:'create',key:randomUUID(),requestId:randomUUID(),body:{name:'Synthetic native pre-upgrade'}});
    const migrationClient=await adminPool.connect();try{await migrationClient.query('BEGIN');await migrationClient.query(await readFile(new URL('../../migrations/002_property_hardening.up.sql',import.meta.url),'utf8'));await migrationClient.query('COMMIT');}
    catch(error){await migrationClient.query('ROLLBACK');throw error;}finally{migrationClient.release();}
    const nextService=new PropertyService(second);assert.deepEqual(await nextService.get(identity,before.data.id as string),before.data);
    const next=await nextService.mutate(identity,{action:'update',id:before.data.id as string,expected:1,key:randomUUID(),requestId:randomUUID(),body:{name:'Synthetic native post-upgrade'}});
    assert.equal((await service.get(identity,before.data.id as string)).version,2);assert.equal(next.data.createdAt,before.data.createdAt);
    assert.equal((await service.audit(identity,before.data.id as string,50,0)).data.length,2);
    assert.equal((await adminPool.query("SELECT 1 FROM pg_constraint WHERE conname IN ('property_current_revision','revision_requires_audit') AND condeferrable AND convalidated")).rowCount,2);
    await assert.rejects(()=>first.transaction(async sql=>{await sql.query('SET LOCAL ROLE hamdee_runtime');await sql.query("SELECT set_config('hamdee.actor',$1,true),set_config('hamdee.action','update',true)",[users.admin.id]);await sql.query('UPDATE hamdee_private.properties SET version=version+1 WHERE id=$1',[before.data.id]);}));
    assert.equal((await nextService.get(identity,before.data.id as string)).version,2);
  }finally{await first.close();await second.close();await adminPool.end();}
});

test('native: missing/expired identities, actual disablement, client roles and revoked replay fail closed',native,async()=>{
  for(const token of [null,'invalid',provider.issue(users.admin.subject,issuer,0)]){
    const response=await handleA(new Request('http://127.0.0.1:4181/api/hamdee/v1/properties',{headers:token?{Authorization:'Bearer '+token,Role:'admin'}:{Role:'admin'}}));assert.equal(response.status,401);
  }
  const denied=await request(handleA,'reader','POST','/properties',{name:'Cannot escalate'},{'Idempotency-Key':randomUUID(),Role:'admin'});assert.equal(denied.status,403);
  await owner.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1',[users.admin.id]);
  try{assert.equal((await request(handleB,'admin','GET','/properties')).status,401);}finally{await owner.query('UPDATE hamdee_private.app_users SET enabled=true WHERE id=$1',[users.admin.id]);}
  const key=randomUUID(),body={name:'Synthetic scoped replay'},headers={'Idempotency-Key':key};
  const created=await request(handleA,'ops','POST','/properties',body,headers);assert.equal(created.status,201);const p=(await created.json()).data;
  await assert.rejects(()=>a.transaction(async sql=>{await sql.query('SET LOCAL ROLE hamdee_runtime');await sql.query("SELECT set_config('hamdee.actor',$1,true),set_config('hamdee.action','update',true)",[users.ops.id]);await sql.query("UPDATE hamdee_private.properties SET lifecycle_status='archived',archived_at=clock_timestamp(),archived_by=$2,archive_reason='Forbidden native archive',updated_by=$2,version=version+1 WHERE id=$1",[p.id,users.ops.id]);}),/metadata update cannot archive/);
  await owner.query('DELETE FROM hamdee_private.property_access WHERE assignment_id=$1 AND property_id=$2',[users.ops.assignment,p.id]);
  assert.equal((await request(handleB,'ops','POST','/properties',body,headers)).status,404);
  assert.equal((await request(handleB,'ops','GET','/properties/'+p.id)).status,404);
});

test('native: transaction errors and terminated owned connection recover without partial mutation',native,async()=>{
  await assert.rejects(()=>a.transaction(sql=>sql.query('SELECT 1/0')));
  assert.equal((await a.transaction(sql=>sql.query<{n:number}>('SELECT 1 AS n'))).rows[0].n,1);
  const p=await create();let interrupted=false;
  const breaking:Database={transaction:work=>a.transaction(async sql=>{
    const pid=(await sql.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const wrapped:Sql={query:async<T>(text:string,params?:unknown[])=>{const result=await sql.query<T>(text,params);
      if(!interrupted&&text.startsWith('UPDATE hamdee_private.properties')){interrupted=true;await owner.query('SELECT pg_terminate_backend($1)',[pid]);}return result;}};
    return work(wrapped);
  })};
  const key=randomUUID(),headers=pre(p,key),body={name:'Synthetic native recovery'};
  assert.equal((await request(createHandler(provider,new PropertyService(breaking),()=>{}),'admin','PATCH','/properties/'+p.id,body,headers)).status,503);
  assert.equal((await owner.query('SELECT version FROM hamdee_private.properties WHERE id=$1',[p.id])).rows[0].version,1);
  assert.equal((await request(handleA,'admin','PATCH','/properties/'+p.id,body,headers)).status,200);
});
