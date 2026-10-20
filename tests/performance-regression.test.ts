import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { operationsFixture } from './support/operations-fixture';
import { adapter } from './support/fixture';
import { type Database,type Sql } from '../src/database';
import { PropertyService } from '../src/service';
import { StaffCollectionsService } from '../src/staff-collections';
import { createHandler } from '../src/http';
import { bindIdentityRecheck } from '../src/auth';
import { ApiError } from '../src/errors';
import { guardHostedTransaction,HAMDEE_DEVELOPMENT_PROJECT } from '../src/hosted-database';

test('Performance: optional-module preflight validates full owner membership once, retaining operation and live checks',async t=>{
  const f=await operationsFixture();t.after(()=>f.pg.close());
  const db=adapter(f.pg);let transactions=0,statements=0,liveChecks=0;
  const counted:Database={transaction<T>(work:(sql:Sql)=>Promise<T>){transactions++;return db.transaction(sql=>work({
    async query<R>(text:string,params?:unknown[]){statements++;return sql.query<R>(text,params);}
  }));}};
  const identity=bindIdentityRecheck(f.identity,async()=>{liveChecks++;});
  const properties=new PropertyService(counted,f.identity),staff=new StaffCollectionsService(properties);
  const handle=createHandler({validate:async()=>identity},properties,()=>{},{staffCollections:staff});
  const response=await handle(new Request('http://127.0.0.1:4181/api/hamdee/v1/staff-collections?month=2026-10&asOf=2026-10-20'));
  assert.equal(response.status,200);assert.equal(transactions,2);assert.equal(statements,13);assert.equal(liveChecks,2);
  assert.deepEqual((await response.json()).data.collectors,[]);
});

test('Performance: disabled, scoped-admin and non-owner grants are denied before module fields or command body are parsed',async t=>{
  const f=await operationsFixture();t.after(()=>f.pg.close());
  let calls=0;const properties=new PropertyService(adapter(f.pg));
  const module={async overview(){calls++;return {};},async mutate(){calls++;return {data:{},replay:false};}};
  const handle=createHandler(f.provider,properties,()=>{},{staffCollections:module,companyFinance:module,personalFinance:module,carRentals:module});
  for(const name of ['staff-collections','company-finance','personal-finance','car-rentals']){
    for(const user of ['disabled','scopedAdmin','reader','ops','finance']){
      const headers={authorization:'Bearer '+f.users[user].token,origin:'http://127.0.0.1:4181','content-type':'application/json'};
      const get=await handle(new Request('http://127.0.0.1:4181/api/hamdee/v1/'+name+'?month=invalid',{headers}));
      const post=await handle(new Request('http://127.0.0.1:4181/api/hamdee/v1/'+name+'/commands',{method:'POST',headers,body:'{malformed'}));
      assert.equal(get.status,user==='disabled'?401:403);assert.equal(post.status,user==='disabled'?401:403);
    }
  }
  assert.equal(calls,0);
});

test('Performance: owner grant revoked after preflight is checked again by the operational transaction',async t=>{
  const f=await operationsFixture();t.after(()=>f.pg.close());
  const properties=new PropertyService(adapter(f.pg),f.identity),staff=new StaffCollectionsService(properties);
  const handle=createHandler(f.provider,properties,()=>{},{staffCollections:{
    async overview(identity,query){
      await f.pg.query('UPDATE hamdee_private.role_assignments SET revoked_at=clock_timestamp() WHERE id=$1',[f.users.admin.assignment]);
      return staff.overview(identity,query);
    },mutate:staff.mutate.bind(staff)
  }});
  const response=await handle(new Request('http://127.0.0.1:4181/api/hamdee/v1/staff-collections?month=2026-10&asOf=2026-10-20',{
    headers:{authorization:'Bearer '+f.users.admin.token}
  }));
  assert.equal(response.status,403);assert.equal((await response.json()).error.code,'FORBIDDEN');
});

test('Performance: late managed identity rejection still rolls back command, audit and replay records',async t=>{
  const f=await operationsFixture();t.after(()=>f.pg.close());let checks=0;
  const identity=bindIdentityRecheck(f.identity,async()=>{if(++checks===2)throw new ApiError(401,'UNAUTHENTICATED','Sign in with an authorized account.');});
  const properties=new PropertyService(adapter(f.pg),f.identity),staff=new StaffCollectionsService(properties);
  const handle=createHandler({validate:async()=>identity},properties,()=>{},{staffCollections:staff});
  const response=await handle(new Request('http://127.0.0.1:4181/api/hamdee/v1/staff-collections/commands',{
    method:'POST',headers:{origin:'http://127.0.0.1:4181','content-type':'application/json','idempotency-key':randomUUID()},
    body:JSON.stringify({action:'create-collector',name:'Synthetic performance regression collector'})
  }));
  assert.equal(response.status,401);assert.equal(checks,2);
  for(const table of ['ops_collectors','ops_events','ops_commands'])assert.equal((await f.pg.query<{n:number}>(`SELECT count(*)::int AS n FROM hamdee_private.${table}`)).rows[0].n,0);
});

test('Performance: batched hosted settings retain exact limits and transaction-local isolation on commit and rollback',async t=>{
  const pg=new PGlite();t.after(()=>pg.close());
  await pg.exec(`CREATE ROLE hamdee_runtime NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    CREATE ROLE hamdee_backend LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    GRANT hamdee_runtime TO hamdee_backend;
    CREATE SCHEMA hamdee_private;
    CREATE TABLE hamdee_private.application_identity(app_id text,environment text,project_ref text,data_class text);
    INSERT INTO hamdee_private.application_identity VALUES('hamdee','synthetic-development','${HAMDEE_DEVELOPMENT_PROJECT}','synthetic_only');
    GRANT USAGE ON SCHEMA hamdee_private TO hamdee_runtime;
    GRANT SELECT ON hamdee_private.application_identity TO hamdee_runtime;
    SET SESSION AUTHORIZATION hamdee_backend;`);
  const settings=()=>pg.query("SELECT current_user AS role,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('search_path') AS path");
  const before=(await settings()).rows;
  for(const fail of [false,true]){
    let calls=0;
    const run=()=>pg.transaction(tx=>guardHostedTransaction({async query<R>(text:string,params?:unknown[]){calls++;return {rows:(await tx.query<R>(text,params)).rows};}},async sql=>{
      assert.equal(calls,4);
      const row=(await sql.query<{role:string;statement:string;lock:string;idle:string;path:string}>("SELECT current_user AS role,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('search_path') AS path")).rows[0];
      assert.deepEqual(row,{role:'hamdee_runtime',statement:'10s',lock:'3s',idle:'10s',path:'pg_catalog'});
      if(fail)throw new Error('Synthetic rollback');return true;
    }));
    if(fail)await assert.rejects(run,/Synthetic rollback/);else assert.equal(await run(),true);
    assert.deepEqual((await settings()).rows,before);
  }
});
