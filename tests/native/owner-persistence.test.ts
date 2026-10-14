import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { LocalPostgresDatabase } from '../../src/database';
import { up } from '../support/fixture';
import { createOwnerQaFixture, ownerNativeConnection, seedOwnerAppRecords, OwnerCookieJar, ownerQaInputs, startOwnerAppProcess, OWNER_QA_FACTOR } from '../support/owner-crm-harness';

const connection = process.env.HAMDEE_OWNER_NATIVE_TEST_URL;
const native = { skip: connection ? false : 'BLOCKED: no explicitly owned disposable native owner database supplied' };
let owner: Pool, a: LocalPostgresDatabase, b: LocalPostgresDatabase, backendConnection: string;
before(async () => {
  if (!connection) return;
  const config = ownerNativeConnection(connection, process.env.HAMDEE_OWNER_NATIVE_TEST_CONFIRM || '');
  owner = new Pool({ ...config, max: 1 }); owner.on('error', () => {});
  assert.equal((await owner.query("SELECT 1 FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres',$1)", [config.database])).rowCount, 0);
  assert.equal((await owner.query("SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'")).rowCount, 0);
  assert.equal((await owner.query("SELECT 1 FROM pg_roles WHERE rolname IN ('hamdee_runtime','hamdee_owner_qa_backend')")).rowCount, 0);
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query(await up());
    const password = randomBytes(32).toString('hex');
    await client.query(`CREATE ROLE hamdee_owner_qa_backend LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
    await client.query('GRANT hamdee_runtime TO hamdee_owner_qa_backend'); await seedOwnerAppRecords(client); await client.query('COMMIT');
    const url = new URL(connection); url.username = 'hamdee_owner_qa_backend'; url.password = password; backendConnection = url.toString();
    a = new LocalPostgresDatabase(backendConnection, () => {}); b = new LocalPostgresDatabase(backendConnection, () => {});
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
after(async () => { await a?.close(); await b?.close(); await owner?.end(); });
const base = '/api/hamdee/v1';
async function value(response: Response, status: number) { const json = await response.json(); assert.equal(response.status, status, JSON.stringify(json)); return json; }

test('Owner native: actual least-privilege backend and independent physical connections', native, async () => {
  const rows = await Promise.all([a, b].map(db => db.transaction(async sql => (await sql.query<{ pid: number; superuser: boolean; bypass: boolean }>(
    'SELECT pg_backend_pid() AS pid,rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=session_user')).rows[0])));
  assert.notEqual(rows[0].pid, rows[1].pid); for (const row of rows) { assert.equal(row.superuser, false); assert.equal(row.bypass, false); }
});
test('Owner native: identical concurrent commands commit one property and replay once', native, async () => {
  const x = await createOwnerQaFixture({ database: a }), y = await createOwnerQaFixture({ database: b }); await x.login(); await y.login();
  const key = randomUUID(), payload = { name: 'Synthetic native identical ' + randomUUID() };
  const responses = await Promise.all([x, y].map(f => f.request('POST', base + '/properties', payload, { 'Idempotency-Key': key })));
  const data = await Promise.all(responses.map(response => value(response, 201))); assert.equal(data[0].data.id, data[1].data.id);
  assert.equal(responses.filter(response => response.headers.get('Idempotent-Replay') === 'true').length, 1);
  assert.equal((await owner.query('SELECT id FROM hamdee_private.properties WHERE name=$1', [payload.name])).rowCount, 1);
});
test('Owner native: concurrent version edits have one winner and preserve all relational history', native, async () => {
  const x = await createOwnerQaFixture({ database: a }), y = await createOwnerQaFixture({ database: b }); await x.login(); await y.login();
  const p = (await value(await x.request('POST', base + '/properties', { name: 'Synthetic edit race' }, { 'Idempotency-Key': randomUUID() }), 201)).data;
  const responses = await Promise.all([x, y].map((f, i) => f.request('PATCH', base + '/properties/' + p.id, { name: 'Synthetic native winner ' + i }, { 'Idempotency-Key': randomUUID(), 'If-Match': `"property:${p.id}:1"` })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 412]);
  assert.equal((await owner.query('SELECT version FROM hamdee_private.properties WHERE id=$1', [p.id])).rows[0].version, 2);
  assert.equal((await owner.query('SELECT id FROM hamdee_private.audit_events WHERE property_id=$1', [p.id])).rowCount, 2);
});
test('Owner native: actual database audit failure rolls back and same command safely retries', native, async () => {
  const f = await createOwnerQaFixture({ database: a }); await f.login(); const key = randomUUID(), name = 'Synthetic native rollback ' + randomUUID();
  await owner.query("CREATE FUNCTION hamdee_private.owner_native_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic native audit failure'; END $$; CREATE TRIGGER owner_native_fail_audit BEFORE INSERT ON hamdee_private.audit_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.owner_native_fail_audit();");
  try { await value(await f.request('POST', base + '/properties', { name }, { 'Idempotency-Key': key }), 503); }
  finally { await owner.query('DROP TRIGGER owner_native_fail_audit ON hamdee_private.audit_events; DROP FUNCTION hamdee_private.owner_native_fail_audit();'); }
  assert.equal((await owner.query('SELECT id FROM hamdee_private.properties WHERE name=$1', [name])).rowCount, 0);
  assert.equal((await owner.query('SELECT key FROM hamdee_private.commands WHERE key=$1', [key])).rowCount, 0);
  await value(await f.request('POST', base + '/properties', { name }, { 'Idempotency-Key': key }), 201);
});
test('Owner native: actual app-process restart/new session preserves saved property/audit/dashboard', native, async () => {
  const inputs = ownerQaInputs(); let app = await startOwnerAppProcess(backendConnection); const firstPid = app.pid;
  let jar = new OwnerCookieJar();
  const request = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(app.url + route, { method, headers: { Cookie: jar.header(), Origin: app.url, 'X-Hamdee-CSRF': jar.csrfToken, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    await jar.accept(response); return response;
  };
  const login = async () => {
    await value(await request('GET', '/api/hamdee/auth/state'), 200);
    await value(await request('POST', '/api/hamdee/auth/login', { email: inputs.email, password: inputs.password }), 200);
    await value(await request('POST', '/api/hamdee/auth/mfa/enroll', {}), 200);
    await value(await request('POST', '/api/hamdee/auth/mfa/verify', { factorId: OWNER_QA_FACTOR, code: inputs.validTotp }), 200);
  };
  try {
    await login(); const p = (await value(await request('POST', base + '/properties', { name: inputs.propertyName }, { 'Idempotency-Key': randomUUID() }), 201)).data;
    await value(await request('PATCH', base + '/properties/' + p.id, { name: 'Synthetic process persisted' }, { 'Idempotency-Key': randomUUID(), 'If-Match': `"property:${p.id}:1"` }), 200);
    await value(await request('POST', base + `/properties/${p.id}/archive`, { reason: inputs.archiveReason }, { 'Idempotency-Key': randomUUID(), 'If-Match': `"property:${p.id}:2"` }), 200);
    await value(await request('POST', base + `/properties/${p.id}/restore`, { reason: inputs.restoreReason }, { 'Idempotency-Key': randomUUID(), 'If-Match': `"property:${p.id}:3"` }), 200);
    await app.close(); app = await startOwnerAppProcess(backendConnection); assert.notEqual(app.pid, firstPid); jar = new OwnerCookieJar(); await login();
    const restored = (await value(await request('GET', base + '/properties/' + p.id), 200)).data;
    assert.equal(restored.version, 4); assert.equal(restored.createdAt, p.createdAt); assert.equal(restored.name, 'Synthetic process persisted');
    assert.equal((await value(await request('GET', base + `/properties/${p.id}/audit`), 200)).data.length, 4);
    assert.ok((await value(await request('GET', base + '/dashboard'), 200)).data.totalProperties > 0);
    // Node's test runner does not forward arbitrary test-worker IPC. Use only
    // a temporary private file in the launcher's uniquely owned ignored data
    // directory; the launcher consumes/unlinks it without logging credentials.
    const witnessFile = process.env.HAMDEE_OWNER_NATIVE_WITNESS_FILE;
    if (witnessFile) {
      const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
      const parent = await realpath(path.dirname(witnessFile));
      assert.ok(parent.startsWith(path.join(root, '.test-data', 'owner-native') + path.sep));
      assert.equal(path.basename(witnessFile), 'owner-witness.private.json');
      assert.equal(path.basename(parent), new URL(connection!).pathname.slice('/hamdee_dev_owner_qa_'.length));
      await writeFile(witnessFile, JSON.stringify({ backendConnection,
        witness: { id: p.id, version: 4, name: restored.name, createdAt: p.createdAt, previousAppPid: app.pid } }), { mode: 0o600 });
    }
    console.log('OWNER_NATIVE_PERSISTED', JSON.stringify({ id: p.id, version: 4, appRestarted: true }));
  } finally { await app.close(); }
});
