import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOwnerQaFixture } from './support/owner-crm-harness';

const base = '/api/hamdee/v1';
const pre = (id: string, version: number, key = randomUUID()) => ({ 'Idempotency-Key': key, 'If-Match': `"property:${id}:${version}"` });
async function fixture(t: TestContext) { const f = await createOwnerQaFixture(); t.after(() => f.close()); await f.login(); return f; }
async function body(response: Response, status: number) { const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value; }

test('Owner persistence: authoritative dashboard follows create/edit/archive/restore/history', async t => {
  const f = await fixture(t), created = (await body(await f.request('POST', base + '/properties', { name: f.inputs.propertyName }, { 'Idempotency-Key': randomUUID() }), 201)).data;
  const d = (await body(await f.request('GET', base + '/dashboard'), 200)).data;
  assert.equal(d.totalProperties, 1); assert.equal(d.activeProperties, 1); assert.equal(d.archivedProperties, 0);
  assert.deepEqual(d.recentProperties.map((p: { id: string }) => p.id), [created.id]);
  await body(await f.request('PATCH', base + '/properties/' + created.id, { name: 'Synthetic renamed owner property' }, pre(created.id, 1)), 200);
  await body(await f.request('POST', base + `/properties/${created.id}/archive`, { reason: f.inputs.archiveReason }, pre(created.id, 2)), 200);
  const archived = (await body(await f.request('GET', base + '/dashboard'), 200)).data;
  assert.equal(archived.totalProperties, 1); assert.equal(archived.activeProperties, 0); assert.equal(archived.archivedProperties, 1);
  await body(await f.request('POST', base + `/properties/${created.id}/restore`, { reason: f.inputs.restoreReason }, pre(created.id, 3)), 200);
  f.rebuildApplication(); await f.login();
  const restored = (await body(await f.request('GET', base + '/properties/' + created.id), 200)).data;
  assert.equal(restored.id, created.id); assert.equal(restored.createdAt, created.createdAt); assert.equal(restored.version, 4);
  assert.equal(restored.name, 'Synthetic renamed owner property');
  assert.equal((await body(await f.request('GET', base + `/properties/${created.id}/audit`), 200)).data.length, 4);
});
test('Owner persistence: identical retry commits once; changed payload/key conflicts and stale revision rejects', async t => {
  const f = await fixture(t), key = randomUUID(), payload = { name: f.inputs.propertyName };
  const a = await f.request('POST', base + '/properties', payload, { 'Idempotency-Key': key }); const created = (await body(a, 201)).data;
  const replay = await f.request('POST', base + '/properties', payload, { 'Idempotency-Key': key }); await body(replay, 201); assert.equal(replay.headers.get('Idempotent-Replay'), 'true');
  await body(await f.request('POST', base + '/properties', { name: 'Synthetic changed command' }, { 'Idempotency-Key': key }), 409);
  await body(await f.request('PATCH', base + '/properties/' + created.id, { name: 'Synthetic revision winner' }, pre(created.id, 1)), 200);
  await body(await f.request('PATCH', base + '/properties/' + created.id, { name: 'Synthetic stale revision' }, pre(created.id, 1)), 412);
  assert.equal((await body(await f.request('GET', base + '/dashboard'), 200)).data.totalProperties, 1);
});
test('Owner persistence: fresh DB disablement or missing Admin portfolio blocks valid owner MFA', async t => {
  for (const mode of ['disabled', 'grant'] as const) {
    const f = await fixture(t);
    if (mode === 'disabled') await f.pg!.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1', [f.member!.id]);
    else await f.pg!.query('UPDATE hamdee_private.role_assignments SET portfolio=false WHERE id=$1', [f.member!.assignment]);
    const response = await f.request('GET', base + '/dashboard'); const value = await response.json();
    assert.ok([401, 403].includes(response.status), JSON.stringify(value)); assert.equal(value.data, undefined);
  }
});
test('Owner persistence: local audit failure rolls back property/revision/command and safe retry succeeds', async t => {
  const f = await fixture(t), key = randomUUID(), payload = { name: f.inputs.propertyName };
  await f.pg!.exec("CREATE FUNCTION hamdee_private.owner_qa_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic owner audit unavailable'; END $$; CREATE TRIGGER owner_qa_fail_audit BEFORE INSERT ON hamdee_private.audit_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.owner_qa_fail_audit();");
  await body(await f.request('POST', base + '/properties', payload, { 'Idempotency-Key': key }), 503);
  for (const table of ['properties', 'property_revisions', 'audit_events', 'commands']) assert.equal((await f.pg!.query<{ count: number }>(`SELECT count(*)::int AS count FROM hamdee_private.${table}`)).rows[0].count, 0);
  await f.pg!.exec('DROP TRIGGER owner_qa_fail_audit ON hamdee_private.audit_events; DROP FUNCTION hamdee_private.owner_qa_fail_audit();');
  await body(await f.request('POST', base + '/properties', payload, { 'Idempotency-Key': key }), 201);
});
test('Owner persistence: dashboard counts all saved records while recent list is bounded to ten', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) await body(await f.request('POST', base + '/properties', { name: 'Synthetic dashboard property ' + i }, { 'Idempotency-Key': randomUUID() }), 201);
  const dashboard = (await body(await f.request('GET', base + '/dashboard'), 200)).data;
  assert.equal(dashboard.totalProperties, 12); assert.equal(dashboard.activeProperties, 12); assert.equal(dashboard.recentProperties.length, 10);
  assert.equal(new Set(dashboard.recentProperties.map((p: { id: string }) => p.id)).size, 10);
  assert.equal('net' in dashboard, false); assert.equal('rent' in dashboard, false);
});
test('Owner persistence: expired/CSRF-invalid copied requests cannot create hidden effects', async t => {
  const f = await fixture(t), payload = { name: f.inputs.propertyName };
  await body(await f.request('POST', base + '/properties', payload, { 'Idempotency-Key': randomUUID(), 'X-Hamdee-CSRF': '' }), 403);
  f.clock.advance(f.inputs.idleMilliseconds);
  await body(await f.request('POST', base + '/properties', payload, { 'Idempotency-Key': randomUUID() }), 401);
  assert.equal((await f.pg!.query<{ count: number }>('SELECT count(*)::int AS count FROM hamdee_private.properties')).rows[0].count, 0);
});
