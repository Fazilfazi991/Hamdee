import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { adapter, up } from './support/fixture';
import { PropertyService } from '../src/service';
import { createHandler } from '../src/http';
import { ApiError } from '../src/errors';
import { SessionServiceError, type SessionIssued } from '../src/security/session-service';
import { authHarness, QA_ORIGIN, QA_SUBJECT_A, QA_SUBJECT_B, type QaRole, type QaGrant } from './support/agent4-auth-harness';
import type { IdentityProvider } from '../src/auth';

async function propertyHarness(t: TestContext, role: QaRole = 'admin', portfolio = true,
  sessionGrants?: readonly QaGrant[], persistent = false) {
  const h = authHarness(sessionGrants || [{ role, scope: { kind: 'portfolio' } }], role === 'admin');
  const directory = persistent ? await mkdtemp(path.join(tmpdir(), 'hamdee-agent4-')) : undefined;
  let pg = new PGlite(directory), closed = false;
  t.after(async () => {
    if (!closed) await pg.close();
    if (directory) {
      const resolved = path.resolve(directory), parent = path.resolve(tmpdir());
      assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('hamdee-agent4-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  await pg.exec(await up());
  const actorId = randomUUID(), assignment = randomUUID(), bootstrapId = randomUUID();
  await pg.query('INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,$4,true)', [actorId, h.binding.issuer, QA_SUBJECT_A, 'Synthetic Agent4 actor']);
  await pg.query('INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,$3,$4)', [assignment, actorId, role, portfolio]);
  await pg.query('INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,$4,true)', [bootstrapId, h.binding.issuer, QA_SUBJECT_B, 'Synthetic Agent4 setup actor']);
  await pg.query("INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,'admin',true)", [randomUUID(), bootstrapId]);
  let service = new PropertyService(adapter(pg));
  const provider: IdentityProvider = {
    kind: 'agent4-offline-session-composition',
    async validate(request) {
      try {
        const active = await h.service.authorize({ handle: request.headers.get('x-qa-handle') || '', action: null,
          mutation: ['GET', 'HEAD'].includes(request.method) ? null : {
            origin: request.headers.get('origin'), csrfToken: request.headers.get('x-qa-csrf'), limiterKey: 'SYNTHETIC_SERVER_DERIVED_KEY'
          } });
        return { issuer: active.identity.binding.issuer, subject: active.identity.subject };
      } catch (error) {
        if (error instanceof SessionServiceError) throw new ApiError(error.status, error.code, 'Synthetic session access denied.');
        throw error;
      }
    }
  };
  let handle = createHandler(provider, service, () => {});
  const issued = await h.login();
  const request = (method: string, route: string, body?: unknown, headers: Record<string, string> = {}, session: SessionIssued = issued) =>
    handle(new Request(QA_ORIGIN + '/api/hamdee/v1' + route, { method, headers: {
      Origin: QA_ORIGIN, 'Content-Type': 'application/json', 'x-qa-handle': session.handle, 'x-qa-csrf': session.csrfToken, ...headers
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const seedProperty = async (name = 'Synthetic scoped property') => (await service.mutate({ issuer: h.binding.issuer, subject: QA_SUBJECT_B }, {
    action: 'create', key: randomUUID(), requestId: randomUUID(), body: { name }
  })).data;
  const assign = async (id: unknown, assignmentId = assignment) => { await pg.query('INSERT INTO hamdee_private.property_access(assignment_id,property_id) VALUES($1,$2)', [assignmentId, id]); };
  const reopen = async () => {
    assert.ok(directory); await pg.close(); closed = true;
    pg = new PGlite(directory); closed = false; await pg.waitReady;
    service = new PropertyService(adapter(pg)); handle = createHandler(provider, service, () => {});
  };
  return { h, issued, request, seedProperty, assign, actorId, assignment, db: () => pg, reopen };
}
const version = (id: unknown, value: number) => ({ 'X-Hamdee-Property-Revision': `"property:${id}:${value}"`, 'Idempotency-Key': randomUUID() });
async function expectStatus(response: Response, status: number) {
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
}

test('Agent4 CP2 property: login-authorized create/edit/archive/restore persists after local DB reopen/new session', async t => {
  const f = await propertyHarness(t, 'admin', true, undefined, true);
  const created = (await expectStatus(await f.request('POST', '/properties', { name: 'Synthetic persistent property' }, { 'Idempotency-Key': randomUUID() }), 201)).data;
  const id = created.id;
  await expectStatus(await f.request('PATCH', '/properties/' + id, { name: 'Synthetic updated property' }, version(id, 1)), 200);
  await expectStatus(await f.request('POST', `/properties/${id}/archive`, { reason: 'Synthetic archive reason' }, version(id, 2)), 200);
  assert.equal((await expectStatus(await f.request('GET', '/properties'), 200)).data.length, 0);
  await expectStatus(await f.request('POST', `/properties/${id}/restore`, { reason: 'Synthetic restore reason' }, version(id, 3)), 200);
  await f.reopen(); const newSession = await f.h.login();
  const restored = (await expectStatus(await f.request('GET', '/properties/' + id, undefined, {}, newSession), 200)).data;
  assert.equal(restored.id, id); assert.equal(restored.version, 4); assert.equal(restored.lifecycleStatus, 'registered');
  assert.equal(restored.name, 'Synthetic updated property'); assert.equal(restored.createdAt, created.createdAt);
  const audit = await expectStatus(await f.request('GET', `/properties/${id}/audit`, undefined, {}, newSession), 200);
  assert.equal(audit.data.length, 4);
});
test('Agent4 CP2 property: database capability matrix denies writes beyond each role despite broad lifecycle grants', async t => {
  for (const role of ['operations', 'finance', 'read_only'] as const) {
    const f = await propertyHarness(t, role), p = await f.seedProperty();
    await expectStatus(await f.request('GET', '/properties/' + p.id), 200);
    await expectStatus(await f.request('PATCH', '/properties/' + p.id, { name: 'Synthetic edit' }, version(p.id, 1)), role === 'operations' ? 200 : 403);
    await expectStatus(await f.request('POST', `/properties/${p.id}/archive`, { reason: 'Synthetic reason' }, version(p.id, role === 'operations' ? 2 : 1)), 403);
    await expectStatus(await f.request('GET', `/properties/${p.id}/audit`), role === 'finance' ? 200 : 403);
    await expectStatus(await f.request('POST', '/properties', { name: 'Synthetic creator' }, { 'Idempotency-Key': randomUUID() }), role === 'operations' ? 201 : 403);
  }
});
test('Agent4 CP2 property: assigned access cannot reveal hidden IDs, search rows or audit', async t => {
  const f = await propertyHarness(t, 'read_only', false), visible = await f.seedProperty('Synthetic visible'), hidden = await f.seedProperty('Synthetic hidden');
  await f.assign(visible.id);
  await expectStatus(await f.request('GET', '/properties/' + visible.id), 200);
  const detail = await expectStatus(await f.request('GET', '/properties/' + hidden.id), 404);
  assert.equal(detail.error.code, 'NOT_FOUND');
  await expectStatus(await f.request('GET', `/properties/${hidden.id}/audit`), 404);
  const list = await expectStatus(await f.request('GET', '/properties?q=Synthetic'), 200);
  assert.deepEqual(list.data.map((row: { id: string }) => row.id), [visible.id]);
});
test('Agent4 CP2 property: unrelated operations grant cannot elevate assigned read-only scope', async t => {
  const f = await propertyHarness(t, 'read_only', false), p = await f.seedProperty(); await f.assign(p.id);
  await f.db().query("INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,'operations',false)", [randomUUID(), f.actorId]);
  await expectStatus(await f.request('GET', '/properties/' + p.id), 200);
  await expectStatus(await f.request('PATCH', '/properties/' + p.id, { name: 'Synthetic escalation' }, version(p.id, 1)), 403);
});
test('Agent4 CP2 property: scoped Admin has no implicit portfolio despite lifecycle portfolio grant', async t => {
  const f = await propertyHarness(t, 'admin', false), p = await f.seedProperty();
  await expectStatus(await f.request('GET', '/properties/' + p.id), 404);
  await expectStatus(await f.request('POST', '/properties', { name: 'Synthetic unauthorized create' }, { 'Idempotency-Key': randomUUID() }), 403);
  await f.assign(p.id); await expectStatus(await f.request('GET', '/properties/' + p.id), 200);
});
test('Agent4 CP2 property: committed replay obeys fresh DB membership and revoked scope', async t => {
  const f = await propertyHarness(t, 'operations', false), key = randomUUID(), payload = { name: 'Synthetic replay' };
  const first = await expectStatus(await f.request('POST', '/properties', payload, { 'Idempotency-Key': key }), 201);
  const replay = await f.request('POST', '/properties', payload, { 'Idempotency-Key': key });
  assert.equal(replay.headers.get('Idempotent-Replay'), 'true'); await expectStatus(replay, 201);
  await f.db().query('DELETE FROM hamdee_private.property_access WHERE assignment_id=$1 AND property_id=$2', [f.assignment, first.data.id]);
  await expectStatus(await f.request('POST', '/properties', payload, { 'Idempotency-Key': key }), 404);
  await f.db().query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1', [f.actorId]);
  await expectStatus(await f.request('GET', '/properties'), 401);
});
test('Agent4 CP2 property: payload/header roles cannot elevate database grants; hidden counterparty rejects', async t => {
  const f = await propertyHarness(t, 'operations', false), p = await f.seedProperty(); await f.assign(p.id);
  const hiddenContact = randomUUID(); await f.db().query('INSERT INTO hamdee_private.counterparties(id,display_name) VALUES($1,$2)', [hiddenContact, 'Synthetic hidden contact']);
  await expectStatus(await f.request('PATCH', '/properties/' + p.id, { name: 'Synthetic update', role: 'admin' }, { ...version(p.id, 1), 'x-role': 'admin', 'x-actor-id': QA_SUBJECT_B }), 422);
  await expectStatus(await f.request('PATCH', '/properties/' + p.id, { name: 'Synthetic update', counterpartyId: hiddenContact }, version(p.id, 1)), 422);
  await expectStatus(await f.request('POST', `/properties/${p.id}/archive`, { reason: 'Synthetic attempt' }, { ...version(p.id, 1), 'x-role': 'admin' }), 403);
});
test('Agent4 CP2 property: command payload conflict and stale revision preserve metadata', async t => {
  const f = await propertyHarness(t), key = randomUUID();
  const created = (await expectStatus(await f.request('POST', '/properties', { name: 'Synthetic command' }, { 'Idempotency-Key': key }), 201)).data;
  await expectStatus(await f.request('POST', '/properties', { name: 'Synthetic changed payload' }, { 'Idempotency-Key': key }), 409);
  await expectStatus(await f.request('PATCH', '/properties/' + created.id, { name: 'Synthetic winner' }, version(created.id, 1)), 200);
  await expectStatus(await f.request('PATCH', '/properties/' + created.id, { name: 'Synthetic stale edit' }, version(created.id, 1)), 412);
  assert.equal((await expectStatus(await f.request('GET', '/properties/' + created.id), 200)).data.name, 'Synthetic winner');
});
test('Agent4 CP2 property: injected local audit error rolls back property/history/command atomically', async t => {
  const f = await propertyHarness(t), key = randomUUID();
  await f.db().exec("CREATE FUNCTION hamdee_private.agent4_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit unavailable'; END $$; CREATE TRIGGER agent4_audit_failure BEFORE INSERT ON hamdee_private.audit_events FOR EACH ROW EXECUTE FUNCTION hamdee_private.agent4_fail_audit();");
  await expectStatus(await f.request('POST', '/properties', { name: 'Synthetic rollback' }, { 'Idempotency-Key': key }), 503);
  for (const table of ['properties', 'property_revisions', 'commands']) {
    const result = await f.db().query<{ count: number }>(`SELECT count(*)::int AS count FROM hamdee_private.${table}`); assert.equal(result.rows[0].count, 0);
  }
  await f.db().exec('DROP TRIGGER agent4_audit_failure ON hamdee_private.audit_events; DROP FUNCTION hamdee_private.agent4_fail_audit();');
  await expectStatus(await f.request('POST', '/properties', { name: 'Synthetic rollback' }, { 'Idempotency-Key': key }), 201);
});
test('Agent4 CP2 property: missing CSRF, logout and recovery deny before mutation', async t => {
  const f = await propertyHarness(t), payload = { name: 'Synthetic denied mutation' };
  await expectStatus(await f.request('POST', '/properties', payload, { 'Idempotency-Key': randomUUID(), 'x-qa-csrf': '' }), 403);
  await f.h.service.logout(f.h.mutation(f.issued));
  await expectStatus(await f.request('POST', '/properties', payload, { 'Idempotency-Key': randomUUID() }), 401);
  const fresh = await f.h.login(); await f.h.service.startRecovery(f.h.mutation(fresh));
  await expectStatus(await f.request('POST', '/properties', payload, { 'Idempotency-Key': randomUUID() }, fresh), 401);
  assert.equal((await f.db().query<{ count: number }>('SELECT count(*)::int AS count FROM hamdee_private.properties')).rows[0].count, 0);
});
test('Agent4 CP2 property: expired session cannot mutate or replay committed property', async t => {
  const f = await propertyHarness(t), key = randomUUID(), payload = { name: 'Synthetic expired replay' };
  const created = (await expectStatus(await f.request('POST', '/properties', payload, { 'Idempotency-Key': key }), 201)).data;
  f.h.clock.advance(f.h.policy.jwtLifetime);
  await expectStatus(await f.request('POST', '/properties', payload, { 'Idempotency-Key': key }), 401);
  await expectStatus(await f.request('PATCH', '/properties/' + created.id, { name: 'Synthetic expired update' }, version(created.id, 1)), 401);
  const row = await f.db().query<{ name: string; version: number }>('SELECT name,version FROM hamdee_private.properties WHERE id=$1', [created.id]);
  assert.equal(row.rows[0].version, 1); assert.equal(row.rows[0].name, payload.name);
});
test('Agent4 CP2 property: Admin aal1 cannot read/create through existing handler', async t => {
  const f = await propertyHarness(t); f.h.facts.identity = { ...f.h.facts.identity, assurance: 'aal1', factorVerified: false, mfaVerifiedAt: null };
  const low = await f.h.login();
  await expectStatus(await f.request('GET', '/properties', undefined, {}, low), 403);
  await expectStatus(await f.request('POST', '/properties', { name: 'Synthetic aal1 denied' }, { 'Idempotency-Key': randomUUID() }, low), 403);
});
