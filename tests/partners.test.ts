import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { chromium } from '@playwright/test';
import { partnerFixture, partnerMigration } from './support/partner-fixture';
import { adapter, issuer, up } from './support/fixture';
import { PartnerService, partnerAmount } from '../src/partners';
import { PropertyService } from '../src/service';
import { bindIdentityRecheck } from '../src/auth';
import type { Database } from '../src/database';
import {guardHostedTransaction} from '../src/hosted-database';
type Row = Record<string, unknown>;
const query = { month: '2026-10', asOf: '2026-10-31' };
const code = (expected: string) => (error: unknown) => (error as { code: string }).code === expected;
async function setup(t: TestContext, persistent = false) { const f = await partnerFixture(persistent); t.after(async () => { await f.pg.close(); }); return f; }
async function project(t: TestContext) { const f = await setup(t), p = await f.create(), partner = await f.contact(); await f.link(p.id, partner.id); return { ...f, p, partner }; }

test('Partner amounts: exact decimals, large values and small fractions without currency-scale rounding', () => {
  for (const [input, output] of [['0012.3400', '12.34'], ['0.000000000001', '0.000000000001'], ['9007199254740993.123456789012', '9007199254740993.123456789012']]) assert.equal(partnerAmount(input), output);
  for (const input of ['0', '0.00', '-1', 'NaN', 'Infinity', '1e3', '1,000', '1.0000000000001', '1000000000000000000', 12, null]) assert.throws(() => partnerAmount(input), code('INVALID_PARTNER_AMOUNT'));
});

const migrationFile=(name:string)=>readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
async function hostedPartnerModel(){
  const pg=new PGlite();
  try{
    await pg.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    await pg.exec(await migrationFile('hosted/initial_synthetic_development.sql'));await pg.exec('ALTER ROLE hamdee_backend LOGIN');
    await pg.exec(await migrationFile('hosted/operations_synthetic_development.sql'));await pg.exec(await migrationFile('hosted/car_rental_synthetic_development.sql'));return pg;
  }catch(error){await pg.close();throw error;}
}
test('Proposed partner008 wrapper embeds exact local source; local guard refuses a hosted marker',async t=>{
  const local=(await partnerMigration()).replace(/\r\n/g,'\n'),wrapper=await migrationFile('hosted/partner_records_development.sql'),pieces=wrapper.split('$reviewed_008$');
  assert.equal(pieces.length,3);assert.equal(pieces[1],local);assert.ok(wrapper.includes(createHash('sha256').update(local).digest('hex')));
  const pg=await hostedPartnerModel();t.after(()=>pg.close());await assert.rejects(pg.transaction(tx=>tx.exec(local)),/local HAMDEE schema required/);
  assert.equal((await pg.query<{installed:string|null}>("SELECT to_regclass('hamdee_private.partners') AS installed")).rows[0].installed,null);
});
test('Proposed partner008 wrapper preserves all41 existing rows/roles and grants only six forced-RLS tables, six contact columns and three invoker functions',async t=>{
  const pg=await hostedPartnerModel();t.after(()=>pg.close());const owner=randomUUID(),subject=randomUUID();
  await pg.query("INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,'synthetic',$2,'Synthetic preserved owner',true)",[owner,subject]);
  const before=(await pg.query('SELECT * FROM hamdee_private.app_users ORDER BY id')).rows,roles=(await pg.query('SELECT * FROM pg_roles ORDER BY oid')).rows;
  await pg.exec(await migrationFile('hosted/partner_records_development.sql'));
  assert.deepEqual((await pg.query('SELECT * FROM hamdee_private.app_users ORDER BY id')).rows,before);assert.deepEqual((await pg.query('SELECT * FROM pg_roles ORDER BY oid')).rows,roles);
  assert.equal((await pg.query<{n:number}>("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='hamdee_private'::regnamespace AND relkind='r'")).rows[0].n,47);
  for(const table of ['partners','partner_revisions','property_partners','partner_entries','partner_events','partner_commands']){
    assert.deepEqual((await pg.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',['hamdee_private.'+table])).rows[0],{relrowsecurity:true,relforcerowsecurity:true});
    assert.deepEqual((await pg.query("SELECT has_table_privilege('hamdee_runtime',$1,'SELECT') AS read,has_table_privilege('hamdee_runtime',$1,'INSERT') AS insert,has_table_privilege('hamdee_runtime',$1,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS broad",['hamdee_private.'+table])).rows[0],{read:true,insert:true,broad:false});
  }
  for(const [column,allowed] of [['name',true],['phone',true],['email',true],['notes',true],['version',true],['event_id',true],['id',false],['created_at',false],['created_by',false]])assert.equal((await pg.query<{ok:boolean}>("SELECT has_column_privilege('hamdee_runtime','hamdee_private.partners',$1,'UPDATE') AS ok",[column])).rows[0].ok,allowed);
  for(const name of ['partner_record_owner','guard_partner_profile','require_partner_evidence']){
    const p=(await pg.query<{prosecdef:boolean;proconfig:string[]}>('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure',['hamdee_private.'+name+'()'])).rows[0];assert.equal(p.prosecdef,false);assert.deepEqual(p.proconfig,['search_path=pg_catalog']);
    for(const role of ['anon','authenticated','service_role','hamdee_backend'])assert.equal((await pg.query<{ok:boolean}>('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS ok',[role,'hamdee_private.'+name+'()'])).rows[0].ok,false);
  }
  await assert.rejects(pg.exec(await migrationFile('hosted/partner_records_development.sql')),/unexpected migration state|unsafe required-table/);await pg.exec('ROLLBACK');assert.deepEqual((await pg.query('SELECT * FROM hamdee_private.app_users ORDER BY id')).rows,before);
});
test('Proposed partner008 wrapper rejects wrong project, partial objects and broadened role before changing existing data',async t=>{
  for(const [change,reason] of [["ALTER TABLE hamdee_private.application_identity DROP CONSTRAINT hamdee_development_project;UPDATE hamdee_private.application_identity SET project_ref='other-project'",/dedicated synthetic-development marker/],["CREATE TYPE hamdee_private.partner_unexpected AS ENUM('synthetic')",/existing\/partial partner/],['ALTER ROLE hamdee_runtime LOGIN',/unsafe application role/]] as const){
    const pg=await hostedPartnerModel();try{await pg.exec(change);await assert.rejects(pg.exec(await migrationFile('hosted/partner_records_development.sql')),reason);await pg.exec('ROLLBACK');assert.equal((await pg.query<{installed:string|null}>("SELECT to_regclass('hamdee_private.partners') AS installed")).rows[0].installed,null);}finally{await pg.close();}
  }void t;
});
test('Proposed partner008 refuses a nonbypass schema owner rather than fingerprinting filtered forced-RLS records',async t=>{
  const pg=await hostedPartnerModel();t.after(()=>pg.close());const actor=randomUUID();
  await pg.query("INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,'synthetic','synthetic-nonbypass-proof','Synthetic preserved proof',true)",[actor]);
  await pg.query("INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,'admin',true)",[randomUUID(),actor]);
  const service=new PropertyService(adapter(pg),{issuer:'synthetic',subject:'synthetic-nonbypass-proof'},'synthetic-development');
  await service.mutate({issuer:'synthetic',subject:'synthetic-nonbypass-proof'},{action:'create',body:{name:'Synthetic forced-RLS preservation proof'},key:randomUUID(),requestId:randomUUID()});
  const before=(await pg.query('SELECT * FROM hamdee_private.app_users ORDER BY id')).rows;
  const properties=(await pg.query('SELECT * FROM hamdee_private.properties ORDER BY id')).rows;assert.equal(properties.length,1);
  await pg.exec('CREATE ROLE hamdee_model_schema_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;ALTER SCHEMA hamdee_private OWNER TO hamdee_model_schema_owner;ALTER TABLE hamdee_private.properties OWNER TO hamdee_model_schema_owner;SET ROLE hamdee_model_schema_owner');
  assert.equal((await pg.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.properties')).rows[0].n,0,'Forced RLS can hide real rows even from the table/schema owner');
  const role=(await pg.query<{rolsuper:boolean;rolbypassrls:boolean}>("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false});
  await assert.rejects(pg.exec(await migrationFile('hosted/partner_records_development.sql')),/unfiltered preservation verification requires approved RLS-bypassing schema owner/);await pg.exec('ROLLBACK;RESET ROLE');
  assert.deepEqual((await pg.query('SELECT * FROM hamdee_private.app_users ORDER BY id')).rows,before);
  assert.deepEqual((await pg.query('SELECT * FROM hamdee_private.properties ORDER BY id')).rows,properties);
  assert.equal((await pg.query<{installed:string|null}>("SELECT to_regclass('hamdee_private.partners') AS installed")).rows[0].installed,null);
  assert.deepEqual((await pg.query<{rolsuper:boolean;rolbypassrls:boolean}>("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='hamdee_model_schema_owner'")).rows[0],{rolsuper:false,rolbypassrls:false});
});
test('Proposed hosted008 model executes through restricted LOGIN, SET LOCAL ROLE and current owner guards without posting finance entries',async t=>{
  const pg=await hostedPartnerModel();t.after(()=>pg.close());const actor=randomUUID(),identity={issuer:'https://dytlzfwbgeuhzgzemqsf.supabase.co/auth/v1',subject:randomUUID()};
  await pg.query("INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,'Synthetic hosted model owner',true)",[actor,identity.issuer,identity.subject]);await pg.query("INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,'admin',true)",[randomUUID(),actor]);await pg.exec(await migrationFile('hosted/partner_records_development.sql'));await pg.exec('SET SESSION AUTHORIZATION hamdee_backend');
  const database:Database={transaction:work=>pg.transaction(tx=>guardHostedTransaction({query:async<R>(sql:string,params?:unknown[])=>({rows:(await tx.query<R>(sql,params)).rows})},work))};
  const properties=new PropertyService(database,identity,'synthetic-development'),partners=new PartnerService(properties);const p=await properties.mutate(identity,{action:'create',body:{name:'Synthetic partner hosted model property'},key:randomUUID(),requestId:randomUUID()});const contact=await partners.mutate(identity,{action:'create-partner',name:'Synthetic hosted model partner'},randomUUID(),randomUUID());await partners.mutate(identity,{action:'link-property',propertyId:p.data.id,partnerId:contact.data.id},randomUUID(),randomUUID());await partners.mutate(identity,{action:'record-entry',propertyId:p.data.id,partnerId:contact.data.id,kind:'contribution',entryDate:'2026-10-01',amount:'0.000000000001',currency:'XTS'},randomUUID(),randomUUID());
  assert.equal((await partners.overview(identity,query)).currencies[0].recordedNet,'0.000000000001');assert.equal((await database.transaction(sql=>sql.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.ops_money'))).rows[0].n,0);
});
test('Partner contacts: duplicate names stay distinct; revision preserves old contact snapshot and stale updates reject', async t => {
  const f = await setup(t), a = await f.contact(), b = await f.contact(); assert.notEqual(a.id, b.id);
  const changed = await f.write({ action: 'update-partner', partnerId: a.id, expectedVersion: 1, name: 'Synthetic revised', phone: 'TEST-001', email: 'partner@example.invalid' });
  assert.equal(changed.data.version, 2); assert.equal(changed.status, 200);
  await assert.rejects(f.write({ action: 'update-partner', partnerId: a.id, expectedVersion: 1, name: 'Stale overwrite' }), code('VERSION_CONFLICT'));
  const revisions = (await f.pg.query<{ profile: Row }>('SELECT profile FROM hamdee_private.partner_revisions WHERE partner_id=$1 ORDER BY version', [a.id])).rows;
  assert.equal(revisions.length, 2); assert.equal(revisions[0].profile.name, 'Synthetic investor'); assert.equal(revisions[1].profile.name, 'Synthetic revised');
});
test('Property links: several partners/projects are independent; duplicate or missing/mismatched link rejects', async t => {
  const f = await setup(t), a = await f.create(), b = await f.create('admin', 'Synthetic second property'), p = await f.contact(), q = await f.contact('Synthetic second investor');
  await f.link(a.id, p.id); await f.link(b.id, p.id); await f.link(a.id, q.id);
  await assert.rejects(f.link(a.id, p.id), code('PARTNER_ALREADY_LINKED'));
  await assert.rejects(f.entry(b.id, q.id), code('PARTNER_NOT_LINKED'));
  await assert.rejects(f.entry(randomUUID(), p.id), code('NOT_FOUND'));
  await assert.rejects(f.entry(a.id, randomUUID()), code('NOT_FOUND'));
  const r = await f.partners.overview(f.identity, { ...query, propertyId: String(a.id) }); assert.equal(r.links.length, 2); assert.equal(r.partners.length, 2);
});
test('Recorded movements: withdrawal may exceed contributions; no invented eligibility, profit, currency conversion or capital allocation', async t => {
  const f = await project(t);
  await f.entry(f.p.id, f.partner.id, { amount: '1.23' });
  await f.entry(f.p.id, f.partner.id, { kind: 'withdrawal', amount: '5.678', reference: 'EXPLICIT-WITHDRAWAL' });
  await f.entry(f.p.id, f.partner.id, { amount: '2.00000001', currency: 'XXX' });
  const r = await f.partners.overview(f.identity, query); assert.equal(r.currencies.length, 2);
  const xts = r.currencies.find(c => c.currency === 'XTS')!; assert.equal(xts.recordedNet, '-4.448');
  assert.equal(r.currencies.find(c => c.currency === 'XXX')!.recordedNet, '2.00000001');
  for (const key of ['profit', 'entitlement', 'percentage', 'settlement', 'withdrawalEligible']) assert.equal(key in xts, false);
});
test('Monthly statement: opening/current/future dates, property/partner filters and month-end/as-of cutoffs agree', async t => {
  const f = await project(t), other = await f.create('admin', 'Synthetic other'), second = await f.contact('Synthetic second'); await f.link(other.id, f.partner.id); await f.link(f.p.id, second.id);
  await f.entry(f.p.id, f.partner.id, { entryDate: '2026-09-30', amount: '10' });
  await f.entry(f.p.id, f.partner.id, { entryDate: '2026-10-01', amount: '7.25' });
  await f.entry(f.p.id, f.partner.id, { entryDate: '2026-10-15', amount: '2.25', kind: 'withdrawal' });
  await f.entry(f.p.id, f.partner.id, { entryDate: '2026-10-16', amount: '100' });
  await f.entry(f.p.id, f.partner.id, { entryDate: '2026-11-01', amount: '200' });
  await f.entry(other.id, f.partner.id, { amount: '300' }); await f.entry(f.p.id, second.id, { amount: '400' });
  const r = await f.partners.overview(f.identity, { month: '2026-10', asOf: '2026-10-15', propertyId: String(f.p.id), partnerId: String(f.partner.id) });
  assert.equal(r.summary.length, 1); assert.equal(r.entries.length, 3); const s = r.summary[0];
  assert.equal(s.openingContributions, '10'); assert.equal(s.monthContributions, '7.25'); assert.equal(s.monthWithdrawals, '2.25'); assert.equal(s.recordedNet, '15.00');
  const later = await f.partners.overview(f.identity, { ...query, asOf: '2027-01-01', propertyId: String(f.p.id), partnerId: String(f.partner.id) });
  assert.equal(later.through, '2026-10-31'); assert.equal(later.summary[0].monthContributions, '107.25'); assert.equal(later.entries.length, 4);
});
test('Saved-record cutoff: later backdated entries cannot alter a statement with its recordedThrough pinned', async t => {
  const f = await project(t); await f.entry(f.p.id, f.partner.id, { amount: '10' }); const first = await f.partners.overview(f.identity, query);
  await f.entry(f.p.id, f.partner.id, { amount: '2' });
  const frozen = await f.partners.overview(f.identity, { ...query, recordedThrough: first.recordedThrough });
  assert.equal(frozen.entries.length, 1); assert.equal(frozen.currencies[0].recordedNet, '10');
  const fresh = await f.partners.overview(f.identity, query); assert.equal(fresh.entries.length, 2); assert.equal(fresh.currencies[0].recordedNet, '12');
});
test('Retry safety: same command/key commits once, changed command conflicts, normalized inputs replay', async t => {
  const f = await project(t), key = randomUUID(); const body = { action: 'record-entry', propertyId: f.p.id, partnerId: f.partner.id, entryDate: '2026-10-05', amount: '001.2300', currency: 'XTS', kind: 'contribution' };
  const a = await f.write(body, key), b = await f.write({ ...body, amount: '1.23' }, key); assert.equal(a.data.id, b.data.id); assert.equal(b.replay, true);
  await assert.rejects(f.write({ ...body, amount: '2' }, key), code('IDEMPOTENCY_KEY_REUSED'));
  assert.equal((await f.partners.overview(f.identity, query)).entries.length, 1);
  // Same reference/date/value under a NEW key is a separate explicit record;
  // no unapproved global reference or transaction-identity rule is inferred.
  await f.write(body); assert.equal((await f.partners.overview(f.identity, query)).entries.length, 2);
});
test('Input allowlists: reject financial settings, client authority, impossible dates, missing/invalid currency and invalid query', async t => {
  const f = await project(t);
  for (const extra of [{ profitShare: '50' }, { actorId: randomUUID() }, { allocation: {} }, { status: 'approved' }]) await assert.rejects(f.entry(f.p.id, f.partner.id, extra));
  for (const extra of [{ entryDate: '2026-02-30' }, { currency: '' }, { currency: 'xts' }, { kind: 'profit' }, { amount: '0' }, { notes: 12 }]) await assert.rejects(f.entry(f.p.id, f.partner.id, extra));
  await assert.rejects(f.partners.overview(f.identity, { ...query, month: '2026-13' }));
  await assert.rejects(f.partners.overview(f.identity, { ...query, recordedThrough: '2026-02-30T00:00:00.000Z' }));
  await assert.rejects(f.partners.overview(f.identity, { ...query, entryCursor: 'not-valid-json' }), code('INVALID_CURSOR'));
  await assert.rejects(f.write({ action: 'create-partner', name: '' }));
  await assert.rejects(f.write({ action: 'create-partner', name: 'Synthetic', email: 'not-an-email' }));
});
test('Owner boundary: other subjects/disabled owner/revoked grants reject reads, writes and stored replay', async t => {
  const f = await project(t), key = randomUUID(), body = { action: 'create-partner', name: 'Synthetic protected' }; await f.write(body, key);
  await assert.rejects(f.partners.overview({ issuer, subject: f.users.ops.subject }, query), code('OWNER_ACCESS_DENIED'));
  await f.pg.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1', [f.users.admin.id]);
  await assert.rejects(f.write(body, key), code('UNAUTHENTICATED'));
  await assert.rejects(f.partners.overview(f.identity, query), code('UNAUTHENTICATED'));
  await f.pg.query('UPDATE hamdee_private.app_users SET enabled=true WHERE id=$1', [f.users.admin.id]);
  await f.pg.query('UPDATE hamdee_private.role_assignments SET revoked_at=clock_timestamp() WHERE id=$1', [f.users.admin.assignment]);
  await assert.rejects(f.write(body, key), code('FORBIDDEN'));
});
test('Archived property: history and statements retained; new links/entries blocked, exact committed retry allowed', async t => {
  const f = await project(t), key = randomUUID(), body = { action: 'record-entry', propertyId: f.p.id, partnerId: f.partner.id, kind: 'contribution', entryDate: '2026-10-05', amount: '3', currency: 'XTS' };
  await f.write(body, key);
  await f.ownerProperties.mutate(f.identity, { action: 'archive', id: String(f.p.id), expected: 1, key: randomUUID(), body: { reason: 'Synthetic metadata archive' }, requestId: randomUUID() });
  await assert.rejects(f.entry(f.p.id, f.partner.id), code('PROPERTY_ARCHIVED')); assert.equal((await f.write(body, key)).replay, true);
  const r = await f.partners.overview(f.identity, query); assert.equal(r.entries.length, 1); assert.equal(r.currencies[0].recordedNet, '3');
});
test('Atomicity: audit persistence failure rolls back movement and command receipt; retry succeeds', async t => {
  const f = await project(t), base = adapter(f.pg); let fail = true;
  const db: Database = { transaction: work => base.transaction(sql => work({ query: (statement, params) => {
    if (fail && statement.startsWith('INSERT INTO hamdee_private.partner_events')) throw new Error('Synthetic audit failure'); return sql.query(statement, params);
  } })) };
  const service = new PartnerService(new PropertyService(db, f.identity));
  const body = { action: 'record-entry', propertyId: f.p.id, partnerId: f.partner.id, kind: 'contribution', entryDate: '2026-10-05', amount: '5', currency: 'XTS' }, key = randomUUID();
  await assert.rejects(service.mutate(f.identity, body, key, randomUUID()));
  assert.equal((await f.pg.query('SELECT id FROM hamdee_private.partner_entries')).rows.length, 0);
  assert.equal((await f.pg.query('SELECT key FROM hamdee_private.partner_commands WHERE key=$1', [key])).rows.length, 0);
  fail = false; assert.equal((await service.mutate(f.identity, body, key, randomUUID())).replay, false);
});
test('Late session rejection rolls back an otherwise valid entry, audit and replay result', async t => {
  const f = await project(t); const identity = bindIdentityRecheck(f.identity, async () => { throw new Error('Synthetic expired managed session'); });
  await assert.rejects(f.partners.mutate(identity, { action: 'record-entry', propertyId: f.p.id, partnerId: f.partner.id, kind: 'contribution', entryDate: '2026-10-05', amount: '10', currency: 'XTS' }, randomUUID(), randomUUID()));
  assert.equal((await f.pg.query('SELECT id FROM hamdee_private.partner_entries')).rows.length, 0);
});
test('Storage defense: immutable movements/revisions, same-property link, mandatory audit and contact revision evidence', async t => {
  const f = await project(t); const movement = await f.entry(f.p.id, f.partner.id);
  await assert.rejects(f.pg.query('UPDATE hamdee_private.partner_entries SET amount=999 WHERE id=$1', [movement.data.id]));
  await assert.rejects(f.pg.query('DELETE FROM hamdee_private.partner_entries WHERE id=$1', [movement.data.id]));
  await assert.rejects(f.pg.query('UPDATE hamdee_private.partner_revisions SET profile=$1 WHERE partner_id=$2', ['{}', f.partner.id]));
  await assert.rejects(f.pg.query('UPDATE hamdee_private.partners SET version=version+1 WHERE id=$1', [f.partner.id]));
  await assert.rejects(f.pg.query(`INSERT INTO hamdee_private.partner_entries(id,property_id,partner_id,kind,entry_date,amount,currency,event_id)
    VALUES($1,$2,$3,'contribution','2026-10-05',1,'XTS',$4)`, [randomUUID(), f.p.id, f.partner.id, randomUUID()]));
  const a = adapter(f.pg); await assert.rejects(a.transaction(async sql => {
    await sql.query('SET LOCAL ROLE hamdee_runtime'); await sql.query("SELECT set_config('hamdee.actor',$1,true)", [f.users.ops.id]);
    assert.equal((await sql.query('SELECT id FROM hamdee_private.partner_entries')).rows.length, 0);
    await sql.query(`INSERT INTO hamdee_private.partner_commands(actor_id,key,digest,result) VALUES($1,$2,$3,'{}')`, [f.users.ops.id, randomUUID(), 'a'.repeat(64)]);
  }), code('42501'));
});
test('Pagination: chronological rows and pinned snapshot; totals include rows beyond the page and cursor cannot change scope', async t => {
  const f = await project(t); for (const entryDate of ['2026-10-01', '2026-10-02', '2026-10-03']) await f.entry(f.p.id, f.partner.id, { entryDate, amount: '1' });
  const first = await f.partners.overview(f.identity, { ...query, limit: 2 }); assert.equal(first.entries.length, 2); assert.equal(first.currencies[0].recordedNet, '3'); assert.ok(first.nextEntryCursor);
  await f.entry(f.p.id, f.partner.id, { entryDate: '2026-10-04', amount: '100' });
  const next = await f.partners.overview(f.identity, { ...query, limit: 2, entryCursor: first.nextEntryCursor! }); assert.equal(next.entries.length, 1); assert.equal(next.entries[0].entryDate, '2026-10-03'); assert.equal(next.currencies[0].recordedNet, '3');
  await assert.rejects(f.partners.overview(f.identity, { ...query, propertyId: String(f.p.id), entryCursor: first.nextEntryCursor! }), code('INVALID_CURSOR'));
});
test('Paged partner contacts retain authoritative labels for every statement, link and returned history reference',async t=>{
  const f=await setup(t),p=await f.create();const contacts=Array.from({length:102},(_,i)=>({id:randomUUID(),event_id:randomUUID(),name:'Synthetic paged partner '+i}));
  // Bulk synthetic contacts retain the same deferred audit/revision evidence;
  // this verifies the actual 100-contact boundary without 102 UI submissions.
  await f.ownerProperties.ownerContext(f.identity,async(sql,actorId)=>{
    await sql.query(`INSERT INTO hamdee_private.partners(id,name,created_by,event_id)
      SELECT c.id,c.name,$2,c.event_id FROM jsonb_to_recordset($1::jsonb) c(id uuid,name text,event_id uuid)`,[JSON.stringify(contacts),actorId]);
    await sql.query(`INSERT INTO hamdee_private.partner_events(id,partner_id,entity_id,action,detail,actor_id)
      SELECT event_id,id,id,'create-partner',jsonb_build_object('record',to_jsonb(p)-'event_id','requestId',$3::text),$2
      FROM hamdee_private.partners p WHERE id=ANY($1::uuid[])`,[contacts.map(c=>c.id),actorId,randomUUID()]);
    await sql.query(`INSERT INTO hamdee_private.partner_revisions(partner_id,version,profile,event_id)
      SELECT id,version,to_jsonb(p)-'event_id',event_id FROM hamdee_private.partners p WHERE id=ANY($1::uuid[])`,[contacts.map(c=>c.id)]);
  });
  const firstContacts=await f.partners.overview(f.identity,{...query,limit:100});
  const outside=contacts.find(contact=>!firstContacts.partners.some(row=>row.id===contact.id))!;
  await f.link(p.id,outside.id);await f.entry(p.id,outside.id,{amount:'3.123456789012'});
  const report=await f.partners.overview(f.identity,{...query,limit:100});assert.equal(report.partners.length,100);
  assert.equal(report.partners.some(row=>row.id===outside.id),false);assert.equal(report.partnerLabels[String(outside.id)],outside.name);
  for(const row of [...report.summary,...report.links,...report.history])assert.equal(typeof report.partnerLabels[String(row.partnerId)],'string');
  assert.equal(report.currencies[0].recordedNet,'3.123456789012');assert.ok(report.nextPartnerCursor);
  const limited=await f.partners.overview(f.identity,{...query,partnerId:String(outside.id),limit:1});assert.deepEqual(limited.partnerLabels,{[String(outside.id)]:outside.name});
});
test('Migration guard refuses a nonlocal/absent application marker before creating partner tables', async t => {
  const pg = new PGlite(); t.after(() => pg.close()); await pg.exec(await up()); await pg.exec('DELETE FROM hamdee_private.application_identity');
  await assert.rejects(pg.transaction(async tx => { await tx.exec(await partnerMigration()); }));
  assert.equal((await pg.query<{ table: string | null }>("SELECT to_regclass('hamdee_private.partners')::text AS table")).rows[0].table, null);
});
test('Saved partner records and exact statements survive database close/reopen with the existing owner context', async t => {
  const f = await partnerFixture(true), p = await f.create(), partner = await f.contact(); await f.link(p.id, partner.id); await f.entry(p.id, partner.id, { amount: '9007199254740993.123456789012' });
  await f.pg.close(); const reopened = new PGlite(f.dataDir); t.after(() => reopened.close());
  const service = new PartnerService(new PropertyService(adapter(reopened), f.identity)); const r = await service.overview(f.identity, query);
  assert.equal(r.partners[0].id, partner.id); assert.equal(r.currencies[0].recordedNet, '9007199254740993.123456789012'); assert.equal(r.history.length, 3);
});

// Headless LOCAL browser only. No hosted provider, native/Chrome session or
// credentials are read. Its loopback API is test-only and never exported.
test('Standalone partner UI: desktop/mobile actual service flow, safe rendering, uncertain retry, CSV, focus and session cleanup', async t => {
  const f = await project(t); const p = f.p, partner = f.partner;
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  let lost = true; const calls: { key: string; body: Row }[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith('/test/partners')) {
        if (req.method === 'POST') {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); const key = String(req.headers['idempotency-key']);
          calls.push({ key, body }); const result = await f.write(body, key);
          if (body.action === 'record-entry' && lost) { lost = false; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Synthetic lost response after commit' } })); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
        }
        const params = new URL(req.url!, 'http://localhost').searchParams, q = Object.fromEntries(params);
        const data = await f.partners.overview(f.identity, { ...query, ...q, limit: Number(q.limit ?? 100) });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data })); return;
      }
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic HAMDEE partner verification</title><link rel="stylesheet" href="/shared/styles.css"><link rel="stylesheet" href="/workspace/foundation.css"><body><main id="module" style="padding:16px;min-width:0"></main><script type="module">
          import {renderPartners,resetPartners} from '/workspace/partners.js';
          window.resetPartnerModule=resetPartners;window.allowed=true;window.lostAccess=0;
          const controller=new AbortController();window.testAbort=controller;
          const call=async(method,query,body,key,signal)=>{const r=await fetch('/test/partners'+(query?'?'+new URLSearchParams(query):''),{method,signal,headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Object.assign(new Error(value.error.message),{status:r.status});return value;};
          window.mountPartnerModule=()=>renderPartners(document.querySelector('#module'),{properties:${JSON.stringify([p])},period:${JSON.stringify(query)},signal:controller.signal,isCurrent:()=>true,verifyAccess:async()=>window.allowed,onAccessLoss:async()=>{window.lostAccess++},api:{partnerRead:(q,s)=>call('GET',q,null,null,s),partnerWrite:(b,k,s)=>call('POST',null,b,k,s)}});
          await window.mountPartnerModule();
        </script></body></html>`); return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      if (!/^\/(workspace|shared)\/[\w.-]+$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
      const file = new URL('../public' + url.pathname, import.meta.url); const bytes = await readFile(file);
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(bytes);
    } catch (error) { res.writeHead((error as { status?: number }).status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: (error as Error).message } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number }; await mkdir('evidence', { recursive: true });
  for (const width of [1440, 390]) {
    lost = true;
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(8000); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + address.port); await page.getByRole('heading', { name: 'Partner contacts', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add partner contact', exact: true }).click(); await page.getByLabel('Partner name', { exact: true }).fill('<script>SYNTHETIC</script>'); await page.getByLabel('Email (optional)').fill('synthetic@example.invalid'); await page.getByRole('button', { name: 'Save partner record', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Partner record saved.' }).waitFor(); assert.equal(await page.locator('td').filter({ hasText: '<script>SYNTHETIC</script>' }).count() >= 1, true);
    await page.getByRole('button', { name: 'Record contribution / withdrawal', exact: true }).click();
    await page.getByLabel('Property', { exact: true }).last().selectOption(String(p.id)); await page.getByLabel('Partner', { exact: true }).selectOption(String(partner.id)); await page.getByLabel('Recorded movement').selectOption('contribution');
    await page.getByLabel('Movement date', { exact: true }).fill('2026-10-15'); await page.getByLabel('Exact recorded amount').fill('10.123456'); await page.getByLabel('Explicit currency code').fill('XTS');
    const saveBounds = await page.getByRole('button', { name: 'Save partner record', exact: true }).boundingBox(); assert.ok(saveBounds && saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 900, 'Save remains within the viewport while form fields scroll');
    await page.screenshot({ path: `evidence/partners-form-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Save partner record', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Save again' }).waitFor(); assert.equal(await page.getByLabel('Exact recorded amount').isDisabled(), true);
    const retryBounds = await page.getByRole('button', { name: 'Save partner record', exact: true }).boundingBox(); assert.ok(retryBounds && retryBounds.y >= 0 && retryBounds.y + retryBounds.height <= 900, 'Retry Save remains visible with error feedback');
    await page.screenshot({ path: `evidence/partners-uncertain-${width}.png`, fullPage: true }); await page.getByRole('button', { name: 'Save partner record', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Partner record saved.' }).waitFor();
    const download = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download monthly summary' }).click()]); const filename = await download[0].path();
    const csv = await readFile(filename!, 'utf8'); assert.match(csv, /Net recorded movements \(not profit or available cash\)/); assert.ok(csv.includes(width === 1440 ? '10.123456' : '20.246912'));
    await page.getByRole('button', { name: 'Add partner contact', exact: true }).click(); await page.keyboard.press('Escape'); assert.equal(await page.getByRole('button', { name: 'Add partner contact', exact: true }).evaluate(el => el === document.activeElement), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false); assert.deepEqual(errors, []);
    await page.screenshot({ path: `evidence/partners-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Add partner contact', exact: true }).click(); await page.getByLabel('Partner name', { exact: true }).fill('SYNTHETIC PRIVATE DRAFT');
    await page.evaluate(async () => { const w = window as unknown as { allowed: boolean; mountPartnerModule: () => Promise<void> }; w.allowed = false; await w.mountPartnerModule(); });
    assert.equal(await page.locator('dialog').count(), 0); assert.equal(await page.locator('#module').textContent(), ''); await page.close();
  }
  const entryCalls = calls.filter(c => c.body.action === 'record-entry'); assert.equal(entryCalls[0].key, entryCalls[1].key); assert.deepEqual(entryCalls[0].body, entryCalls[1].body);
  assert.equal(entryCalls[2].key, entryCalls[3].key); assert.deepEqual(entryCalls[2].body, entryCalls[3].body);
  assert.equal((await f.partners.overview(f.identity, query)).entries.length, 2);
});
