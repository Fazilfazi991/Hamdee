import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { guardHostedTransaction } from '../src/hosted-database';
import type { Database, Sql } from '../src/database';
import { PropertyService } from '../src/service';
import { StaffCollectionsService } from '../src/staff-collections';
import { CompanyFinanceService, type OperationRow } from '../src/company-finance';

const file = (name: string) => readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
const initial = () => file('hosted/initial_synthetic_development.sql');
const wrapper = () => file('hosted/operations_synthetic_development.sql');
const local = () => file('006_local_operations_records.up.sql');
const digest = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const pin = 'd1236225e3f34dcae489d593419f9e6a2999208d45e23e112f2cb4f1e814b0e0';

// Provider schemas and LOGIN activation are disposable models, never remote setup.
async function model() {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001');`);
    await pg.exec(await initial());
    await pg.exec('ALTER ROLE hamdee_backend LOGIN');
    return pg;
  } catch (error) { await pg.close(); throw error; }
}
async function operationsCount(pg: PGlite) {
  return (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class
    WHERE relnamespace='hamdee_private'::regnamespace AND left(relname,4)='ops_'`)).rows[0].n;
}
async function refuses(pg: PGlite, sql: string, reason: RegExp) {
  await assert.rejects(pg.exec(sql), reason);
  // A stop-on-error SQL client must roll back the aborted transaction explicitly.
  await pg.exec('ROLLBACK');
}

test('wrapper pins approved foundation and embeds byte-equivalent local006; local guard stays closed', async () => {
  // Approved initial wrapper: raw CRLF SHA256 e00dbaff...; portable LF pin below.
  assert.equal(digest(await initial()), 'add4e2ac7142c1fce34a63ffbcd0e8bb87fd105cc8da8709c684364031883264');
  const sql = await wrapper(), source = await local();
  const embedded = sql.split('$reviewed_006$');
  assert.equal(embedded.length, 3);
  assert.equal(embedded[1].replace(/\r\n/g, '\n'), source.replace(/\r\n/g, '\n'));
  assert.equal(digest(embedded[1]), pin);
  assert.match(sql, /EXECUTE replace\(reviewed_source,source_guard,hosted_guard\)/);
  const pg = await model();
  try {
    await assert.rejects(pg.transaction(tx => tx.exec(source)), /disposable local HAMDEE schema required/);
    assert.equal(await operationsCount(pg), 0);
  } finally { await pg.close(); }
});

test('whole wrapper installs twelve empty forced-RLS tables and eight invoker functions without auth users or role changes', async () => {
  const pg = await model();
  try {
    const roleSql = `SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication
      FROM pg_roles ORDER BY rolname`;
    const roles = (await pg.query(roleSql)).rows;
    const marker = (await pg.query('SELECT * FROM hamdee_private.application_identity')).rows;
    await pg.exec(await wrapper());
    const tables = (await pg.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relnamespace='hamdee_private'::regnamespace AND relkind='r' AND left(relname,4)='ops_'`)).rows;
    assert.equal(tables.length, 12);
    assert.ok(tables.every(r => r.relrowsecurity && r.relforcerowsecurity));
    const functions = (await pg.query<{ prosecdef: boolean; proconfig: string[] }>(`SELECT prosecdef,proconfig FROM pg_proc WHERE pronamespace='hamdee_private'::regnamespace
      AND (left(proname,4)='ops_' OR left(proname,10) IN ('check_ops_','guard_ops_'))`)).rows;
    assert.equal(functions.length, 8);
    assert.ok(functions.every(r => !r.prosecdef && JSON.stringify(r.proconfig) === '["search_path=pg_catalog"]'));
    assert.deepEqual((await pg.query(roleSql)).rows, roles);
    assert.deepEqual((await pg.query('SELECT * FROM hamdee_private.application_identity')).rows, marker);
    assert.deepEqual((await pg.query('SELECT * FROM auth.users')).rows, [{ id: '00000000-0000-4000-8000-000000000001' }]);
    const privileges = (await pg.query<{ forbidden: boolean; edit: boolean; id_edit: boolean }>(`SELECT has_table_privilege('hamdee_runtime','hamdee_private.ops_money','DELETE,UPDATE,TRUNCATE') AS forbidden,
      has_column_privilege('hamdee_runtime','hamdee_private.ops_collectors','name','UPDATE') AS edit,
      has_column_privilege('hamdee_runtime','hamdee_private.ops_collectors','id','UPDATE') AS id_edit`)).rows[0];
    assert.deepEqual(privileges, { forbidden: false, edit: true, id_edit: false });
    for (const role of ['anon', 'authenticated', 'service_role', 'hamdee_backend']) {
      assert.equal((await pg.query<{ allowed: boolean }>(`SELECT has_schema_privilege($1,'hamdee_private','USAGE') AS allowed`, [role])).rows[0].allowed, false);
    }
  } finally { await pg.close(); }
});

test('hosted transaction adapter and frozen property/operations services work under backend LOGIN and SET LOCAL ROLE', async () => {
  const pg = await model();
  try {
    const id = randomUUID(), subject = randomUUID();
    const identity = { issuer: 'https://dytlzfwbgeuhzgzemqsf.supabase.co/auth/v1', subject };
    await pg.query(`INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,'Synthetic owner',true)`, [id, identity.issuer, subject]);
    await pg.query(`INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,'admin',true)`, [randomUUID(), id]);
    await pg.exec(await wrapper());
    await pg.exec('SET SESSION AUTHORIZATION hamdee_backend');
    const database: Database = { transaction: <T>(work: (sql: Sql) => Promise<T>) => pg.transaction(tx =>
      guardHostedTransaction({ query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await tx.query<R>(sql, params)).rows }) }, work)) };
    const properties = new PropertyService(database, identity, 'synthetic-development');
    const before = await properties.dashboard(identity);
    assert.equal(before.totalProperties, 0);
    await properties.mutate(identity, { action: 'create', key: randomUUID(), body: { name: 'Synthetic preserved property' }, requestId: randomUUID() });
    assert.equal((await properties.dashboard(identity)).totalProperties, 1);
    const staff = new StaffCollectionsService(properties), finance = new CompanyFinanceService(properties);
    const staffWrite = async (body: unknown) => (await staff.mutate(identity, body, randomUUID(), randomUUID())).data as unknown as OperationRow;
    const financeWrite = async (body: unknown) => (await finance.mutate(identity, body, randomUUID(), randomUUID())).data as unknown as OperationRow;
    const collector = await staffWrite({ action: 'create-collector', name: 'Synthetic collector', phone: '', notes: '' });
    const account = await financeWrite({ action: 'create-account', name: 'Synthetic cash', scope: 'company', kind: 'cash', currency: 'XTS', openingDate: '2026-10-01', openingAmount: '0', ownerConfirmedOpening: true });
    const receipt = await financeWrite({ action: 'create-classified-receipt', receiptKey: randomUUID(), classification: 'synthetic-test', receivedOn: '2026-10-15', amount: '100', currency: 'XTS', method: 'cash', reference: 'SYNTHETIC' });
    await staffWrite({ action: 'record-collection', collectorId: collector.id, sourceKind: 'classified-receipt', sourceId: receipt.id, disposition: 'collector-held', ownerConfirmedDisposition: true });
    await staffWrite({ action: 'handover', collectorId: collector.id, accountId: account.id, amount: '30', currency: 'XTS', handedOn: '2026-10-16', reference: 'SYNTHETIC' });
    const totals = (await finance.overview(identity, { month: '2026-10', asOf: '2026-10-16' })).totals;
    assert.equal(totals[0].balance, '30');
    assert.equal(totals[0].receipts, '0');
    await assert.rejects(staffWrite({ action: 'handover', collectorId: collector.id, accountId: account.id, amount: '100', currency: 'XTS', handedOn: '2026-10-16', reference: 'SYNTHETIC-OVERDRAW' }));
    assert.equal((await finance.overview(identity, { month: '2026-10', asOf: '2026-10-16' })).totals[0].balance, '30');
    await assert.rejects(database.transaction(sql => sql.query('DELETE FROM hamdee_private.ops_money')), /permission denied/);
    await assert.rejects(database.transaction(sql => sql.query('CREATE TABLE hamdee_private.unauthorized(id integer)')), /permission denied/);
    await assert.rejects(staff.overview({ ...identity, subject: randomUUID() }, { month: '2026-10', asOf: '2026-10-16' }));
  } finally { await pg.close(); }
});

test('wrong/missing dedicated marker is refused, with no partial installation', async t => {
  for (const [column, value] of [['project_ref', 'other-project'], ['environment', 'production'], ['data_class', 'real_data']] as const) {
    await t.test(column, async () => {
      const pg = await model();
      try {
        await pg.exec(`ALTER TABLE hamdee_private.application_identity DROP CONSTRAINT hamdee_development_project,
          DROP CONSTRAINT hamdee_development_environment,DROP CONSTRAINT hamdee_development_data`);
        await pg.query(`UPDATE hamdee_private.application_identity SET ${column}=$1`, [value]);
        await refuses(pg, await wrapper(), /dedicated synthetic-development marker required/);
        assert.equal(await operationsCount(pg), 0);
      } finally { await pg.close(); }
    });
  }
  await t.test('missing singleton', async () => {
    const pg = await model();
    try {
      await pg.exec('DELETE FROM hamdee_private.application_identity');
      await refuses(pg, await wrapper(), /dedicated synthetic-development marker required/);
      assert.equal(await operationsCount(pg), 0);
    } finally { await pg.close(); }
  });
});

test('base schema, RLS, role attributes, membership and least-privilege drift fail closed', async t => {
  const cases: [string, string, RegExp][] = [
    ['missing base', 'DROP TABLE hamdee_private.rooms CASCADE', /hosted001-004 objects required/],
    ['RLS removed', 'ALTER TABLE hamdee_private.rent_dues NO FORCE ROW LEVEL SECURITY', /privileges\/RLS/],
    ['runtime LOGIN', 'ALTER ROLE hamdee_runtime LOGIN', /unsafe application role/],
    ['backend inherits', 'ALTER ROLE hamdee_backend INHERIT', /unsafe application role/],
    ['runtime bypass', 'ALTER ROLE hamdee_runtime BYPASSRLS', /unsafe application role/],
    ['extra membership', 'CREATE ROLE unrelated;GRANT unrelated TO hamdee_backend', /unsafe application role/],
    ['membership inherits', 'GRANT hamdee_runtime TO hamdee_backend WITH INHERIT TRUE', /unsafe application role/],
    ['provider schema', 'GRANT USAGE ON SCHEMA hamdee_private TO anon', /unsafe schema\/database privileges/],
    ['runtime DELETE', 'GRANT DELETE ON hamdee_private.rent_dues TO hamdee_runtime', /privileges\/RLS/],
    ['runtime extra UPDATE', 'GRANT UPDATE(id) ON hamdee_private.rooms TO hamdee_runtime', /unexpected runtime update column/],
    ['runtime property INSERT', 'GRANT INSERT(version) ON hamdee_private.properties TO hamdee_runtime', /unexpected runtime property insert/],
    ['provider column grant', 'GRANT SELECT(end_date) ON hamdee_private.rental_agreements TO anon', /privileges\/RLS/],
    ['PUBLIC function', 'GRANT EXECUTE ON FUNCTION hamdee_private.rental_owner() TO PUBLIC', /unsafe private function/],
  ];
  for (const [name, change, reason] of cases) await t.test(name, async () => {
    const pg = await model();
    try {
      await pg.exec(change);
      await refuses(pg, await wrapper(), reason);
      assert.equal(await operationsCount(pg), 0);
    } finally { await pg.close(); }
  });
});

test('partial operations tables, functions and types are refused without overwriting them', async t => {
  const cases: [string, string, string][] = [
    ['table', 'CREATE TABLE hamdee_private.ops_receipts(id integer);INSERT INTO hamdee_private.ops_receipts VALUES(7)', 'SELECT id FROM hamdee_private.ops_receipts'],
    ['function', "CREATE FUNCTION hamdee_private.check_ops_account() RETURNS integer LANGUAGE sql AS 'SELECT 7'", 'SELECT hamdee_private.check_ops_account() AS id'],
    ['type', "CREATE TYPE hamdee_private.ops_money AS ENUM('preserve')", "SELECT 'preserve'::hamdee_private.ops_money AS id"],
  ];
  for (const [name, change, check] of cases) await t.test(name, async () => {
    const pg = await model();
    try {
      await pg.exec(change);
      const existing = (await pg.query(check)).rows;
      // Partials may fail an earlier security check; either way no DDL is applied.
      await refuses(pg, await wrapper(), /existing\/partial|unsafe required-table|unsafe private function/);
      assert.deepEqual((await pg.query(check)).rows, existing);
      assert.equal((await pg.query<{ events: string | null }>(`SELECT to_regclass('hamdee_private.ops_events') AS events`)).rows[0].events, null);
    } finally { await pg.close(); }
  });
});

test('unexpected default grants discovered after DDL roll back every operations object', async () => {
  const pg = await model();
  try {
    await pg.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA hamdee_private GRANT SELECT ON TABLES TO anon');
    await refuses(pg, await wrapper(), /unsafe required-table privileges\/RLS/);
    assert.equal(await operationsCount(pg), 0);
    assert.equal((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace='hamdee_private'::regnamespace AND proname='guard_ops_money'`)).rows[0].n, 0);
    assert.equal((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM auth.users')).rows[0].n, 1);
    await pg.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA hamdee_private REVOKE SELECT ON TABLES FROM anon');
    await pg.exec(await wrapper());
    assert.ok(await operationsCount(pg) > 12);
  } finally { await pg.close(); }
});

test('checksum tampering aborts before DDL; repeat installation refuses rather than resetting data', async () => {
  const pg = await model();
  try {
    const sql = await wrapper();
    await refuses(pg, sql.replace('DISPOSABLE LOCAL ONLY.', 'TAMPERED LOCAL ONLY.'), /digest\/guard mismatch/);
    assert.equal(await operationsCount(pg), 0);
    await pg.exec(sql);
    const id = randomUUID();
    await pg.query(`INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,'synthetic','synthetic','Synthetic',true)`, [id]);
    await pg.query(`INSERT INTO hamdee_private.ops_events(id,actor_id,action,detail) VALUES($1,$2,'synthetic-preserve','{}')`, [randomUUID(), id]);
    await refuses(pg, sql, /existing\/partial operations objects refused/);
    assert.equal((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.ops_events')).rows[0].n, 1);
  } finally { await pg.close(); }
});
