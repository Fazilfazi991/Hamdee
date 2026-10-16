// Disposable hosted-schema MODEL only. No remote provider/database operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {guardHostedTransaction} from '../src/hosted-database';
import {PropertyService} from '../src/service';
import {CarRentalService,combinedReceiptSourceReader} from '../src/car-rentals';
import {CompanyFinanceService} from '../src/company-finance';
import type {Database,Sql} from '../src/database';
const file=(name:string)=>readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
const wrapper=()=>file('hosted/car_rental_synthetic_development.sql');
const digest=(text:string)=>createHash('sha256').update(text.replace(/\r\n/g,'\n')).digest('hex');
const pin='9baa4297ceffab72b45265ad7baadd799e3512e7d67049054914d2a63df07f59';
async function model(){const pg=new PGlite();try{
 await pg.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY)');
 await pg.exec(await file('hosted/initial_synthetic_development.sql'));await pg.exec('ALTER ROLE hamdee_backend LOGIN');await pg.exec(await file('hosted/operations_synthetic_development.sql'));return pg;
}catch(e){await pg.close();throw e;}}
async function carCount(pg:PGlite){return (await pg.query<{n:number}>("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='hamdee_private'::regnamespace AND left(relname,4)='car_'")).rows[0].n;}
async function refuses(pg:PGlite,sql:string,reason:RegExp){await assert.rejects(pg.exec(sql),reason);await pg.exec('ROLLBACK');}
const rolesSql='SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles ORDER BY rolname';

test('Proposed car wrapper pins unchanged hosted001-004/006 and embeds exact local007 with its local guard preserved',async()=>{
 assert.equal(digest(await file('hosted/initial_synthetic_development.sql')),'add4e2ac7142c1fce34a63ffbcd0e8bb87fd105cc8da8709c684364031883264');
 assert.equal(digest(await file('006_local_operations_records.up.sql')),'d1236225e3f34dcae489d593419f9e6a2999208d45e23e112f2cb4f1e814b0e0');
 const sql=await wrapper(),local=await file('007_local_car_rentals.up.sql'),embedded=sql.split('$reviewed_007$');assert.equal(embedded.length,3);assert.equal(embedded[1].replace(/\r\n/g,'\n'),local.replace(/\r\n/g,'\n'));assert.equal(digest(local),pin);assert.match(sql,/EXECUTE replace\(reviewed_source,source_guard,hosted_guard\)/);
 const pg=await model();try{await assert.rejects(pg.transaction(tx=>tx.exec(local)),/disposable local HAMDEE operations schema required/);assert.equal(await carCount(pg),0);}finally{await pg.close();}
});

test('Proposed whole car wrapper installs five empty forced-RLS tables/five invoker functions, preserves all base rows/catalog/roles, and limits grants',async()=>{
 const pg=await model();try{
 const id=randomUUID();await pg.query("INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,'synthetic','synthetic','Synthetic preserved',true)",[id]);
 await pg.query("INSERT INTO hamdee_private.ops_events(id,actor_id,action,detail) VALUES($1,$2,'synthetic-preserved','{}')",[randomUUID(),id]);
 const roles=(await pg.query(rolesSql)).rows,marker=(await pg.query('SELECT * FROM hamdee_private.application_identity')).rows;
 const catalogSql="SELECT oid,relname,relowner,relacl,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='hamdee_private'::regnamespace ORDER BY oid";
 const before=(await pg.query<{oid:number}>(catalogSql)).rows;await pg.exec(await wrapper());
 const after=(await pg.query<{oid:number}>(catalogSql)).rows;assert.deepEqual(after.filter(r=>before.some(b=>b.oid===r.oid)),before);
 const tables=(await pg.query<{relrowsecurity:boolean;relforcerowsecurity:boolean}>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='hamdee_private'::regnamespace AND relkind='r' AND left(relname,4)='car_'")).rows;assert.equal(tables.length,5);assert.ok(tables.every(t=>t.relrowsecurity&&t.relforcerowsecurity));
 const functions=(await pg.query<{prosecdef:boolean;proconfig:string[]}>("SELECT prosecdef,proconfig FROM pg_proc WHERE pronamespace='hamdee_private'::regnamespace AND (left(proname,10)='guard_car_' OR left(proname,10)='check_car_')")).rows;assert.equal(functions.length,5);assert.ok(functions.every(f=>!f.prosecdef&&JSON.stringify(f.proconfig)==='["search_path=pg_catalog"]'));
 assert.deepEqual((await pg.query(rolesSql)).rows,roles);assert.deepEqual((await pg.query('SELECT * FROM hamdee_private.application_identity')).rows,marker);assert.equal((await pg.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.ops_events')).rows[0].n,1);
 assert.deepEqual((await pg.query("SELECT has_column_privilege('hamdee_runtime','hamdee_private.car_vehicles','registration','UPDATE') AS metadata,has_column_privilege('hamdee_runtime','hamdee_private.car_vehicles','id','UPDATE') AS identity,has_table_privilege('hamdee_runtime','hamdee_private.car_receipts','UPDATE,DELETE,TRUNCATE') AS immutable")).rows[0],{metadata:true,identity:false,immutable:false});
 for(const role of ['anon','authenticated','service_role','hamdee_backend'])assert.equal((await pg.query<{allowed:boolean}>("SELECT has_schema_privilege($1,'hamdee_private','USAGE') AS allowed",[role])).rows[0].allowed,false);
 }finally{await pg.close();}
});

test('Hosted car model works through restricted backend LOGIN/SET LOCAL ROLE, preserving car-source cash placement and scoped balances',async()=>{
 const pg=await model();try{
 const identity={issuer:'https://dytlzfwbgeuhzgzemqsf.supabase.co/auth/v1',subject:randomUUID()},actor=randomUUID();await pg.query("INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,'Synthetic owner',true)",[actor,identity.issuer,identity.subject]);await pg.query("INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,'admin',true)",[randomUUID(),actor]);
 await pg.exec(await wrapper());await pg.exec('SET SESSION AUTHORIZATION hamdee_backend');
 const database:Database={transaction:<T>(work:(sql:Sql)=>Promise<T>)=>pg.transaction(tx=>guardHostedTransaction({query:async<R>(sql:string,params?:unknown[])=>({rows:(await tx.query<R>(sql,params)).rows})},work))};
 const properties=new PropertyService(database,identity,'synthetic-development'),cars=new CarRentalService(properties),finance=new CompanyFinanceService(properties,combinedReceiptSourceReader,'company');
 const car=(body:unknown)=>cars.mutate(identity,body,randomUUID(),randomUUID()).then(r=>r.data);
 const v=await car({action:'create-vehicle',registration:'SYN-HOSTED-MODEL',make:'Synthetic',model:'Synthetic',status:'active'});
 const a=await car({action:'create-agreement',vehicleId:v.id,agreementKey:randomUUID(),customerName:'Synthetic',startDate:'2026-10-01',endDate:'2026-10-31',agreedAmount:'100',currency:'XTS',billingPeriod:'Explicit total'});
 const receipt=await car({action:'record-collection',agreementId:a.id,receiptKey:randomUUID(),receivedDate:'2026-10-15',amount:'40',currency:'XTS',method:'cash'});
 const account=(await finance.mutate(identity,{action:'create-account',name:'Synthetic',scope:'company',kind:'cash',currency:'XTS',openingDate:'2026-10-01',openingAmount:'0',ownerConfirmedOpening:true},randomUUID(),randomUUID())).data;
 await finance.mutate(identity,{action:'receive',accountId:account.id,sourceKind:'car-rental',sourceId:receipt.id,ownerConfirmedDisposition:true},randomUUID(),randomUUID());
 const query={month:'2026-10',asOf:'2026-10-31'};assert.equal((await cars.overview(identity,query)).balances[0].outstandingAmount,'60');assert.equal((await finance.overview(identity,query)).totals[0].balance,'40');
 await assert.rejects(database.transaction(sql=>sql.query('DELETE FROM hamdee_private.car_receipts')),/permission denied/);await assert.rejects(database.transaction(sql=>sql.query('CREATE TABLE hamdee_private.unauthorized_car(id integer)')),/permission denied/);
 }finally{await pg.close();}
});

test('Car wrapper refuses wrong marker, missing006 and privilege/role drift before installation',async t=>{
 const cases:[string,string,RegExp][]=[
 ['wrong project',"ALTER TABLE hamdee_private.application_identity DROP CONSTRAINT hamdee_development_project;UPDATE hamdee_private.application_identity SET project_ref='wrong-project'",/dedicated synthetic-development marker/],
 ['missing006','DROP TABLE hamdee_private.ops_commands CASCADE',/hosted001-004\+006 objects/],
 ['runtime LOGIN','ALTER ROLE hamdee_runtime LOGIN',/unsafe application role/],
 ['runtime bypass','ALTER ROLE hamdee_runtime BYPASSRLS',/unsafe application role/],
 ['provider schema','GRANT USAGE ON SCHEMA hamdee_private TO anon',/unsafe schema\/database/],
 ['base RLS drift','ALTER TABLE hamdee_private.ops_receipts NO FORCE ROW LEVEL SECURITY',/privileges\/RLS/],
 ['unexpected update','GRANT UPDATE(id) ON hamdee_private.ops_collectors TO hamdee_runtime',/unexpected runtime update/],
 ['public function','GRANT EXECUTE ON FUNCTION hamdee_private.rental_owner() TO PUBLIC',/unsafe private function/]
 ];
 for(const [name,change,reason] of cases)await t.test(name,async()=>{const pg=await model();try{await pg.exec(change);await refuses(pg,await wrapper(),reason);assert.equal(await carCount(pg),0);}finally{await pg.close();}});
});

test('Car wrapper rejects partial tables/types/functions and repeat application without overwriting data',async t=>{
 const cases:[string,string,string][]=[
 ['table','CREATE TABLE hamdee_private.car_receipts(id integer);INSERT INTO hamdee_private.car_receipts VALUES(7)','SELECT id FROM hamdee_private.car_receipts'],
 ['type',"CREATE TYPE hamdee_private.car_receipts AS ENUM('preserve')","SELECT 'preserve'::hamdee_private.car_receipts AS id"],
 ['function',"CREATE FUNCTION hamdee_private.check_car_vehicle() RETURNS integer LANGUAGE sql AS 'SELECT 7'",'SELECT hamdee_private.check_car_vehicle() AS id']
 ];
 for(const [name,change,query] of cases)await t.test(name,async()=>{const pg=await model();try{await pg.exec(change);const before=(await pg.query(query)).rows;await refuses(pg,await wrapper(),/existing\/partial|unsafe required-table|unsafe private function/);assert.deepEqual((await pg.query(query)).rows,before);assert.equal((await pg.query<{table:string|null}>("SELECT to_regclass('hamdee_private.car_agreements')::text AS table")).rows[0].table,null);}finally{await pg.close();}});
 const pg=await model();try{await pg.exec(await wrapper());const before=await carCount(pg);await refuses(pg,await wrapper(),/existing\/partial car/);assert.equal(await carCount(pg),before);}finally{await pg.close();}
});

test('Car wrapper checksum tampering and unexpected default grants roll back all car objects and preserve006',async()=>{
 const pg=await model();try{
 await refuses(pg,(await wrapper()).replace('Generic, manually numbered DISPOSABLE LOCAL ONLY.','TAMPERED local source.'),/digest\/guard mismatch/);assert.equal(await carCount(pg),0);
 await pg.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA hamdee_private GRANT SELECT ON TABLES TO anon');await refuses(pg,await wrapper(),/unsafe required-table privileges\/RLS/);assert.equal(await carCount(pg),0);assert.equal((await pg.query<{n:number}>("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace='hamdee_private'::regnamespace AND proname='guard_car_vehicle'")).rows[0].n,0);
 assert.equal((await pg.query<{n:number}>("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='hamdee_private'::regnamespace AND relkind='r' AND left(relname,4)='ops_'")).rows[0].n,12);
 await pg.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA hamdee_private REVOKE SELECT ON TABLES FROM anon');await pg.exec(await wrapper());assert.ok(await carCount(pg)>5);
 }finally{await pg.close();}
});
