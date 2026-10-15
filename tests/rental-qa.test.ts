import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { adapter, up } from './support/fixture';
import { createOwnerQaFixture, seedOwnerAppRecords, OTHER_QA_SUBJECT } from './support/owner-crm-harness';
import type { Database } from '../src/database';

// Independent synthetic acceptance: expected balances are literals from the
// owner-entered receipts, not copies of implementation arithmetic.
const base = '/api/hamdee/v1';
type Fixture = Awaited<ReturnType<typeof createOwnerQaFixture>>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function result(response: Response, expected = 200): Promise<Row> {
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
async function write(f: Fixture, action: string, fields: Row, key = randomUUID(), headers: Record<string, string> = {}) {
  return f.request('POST', base + '/rental', { action, ...fields }, { 'Idempotency-Key': key, ...headers });
}
async function create(f: Fixture, action: string, fields: Row) {
  const response = await write(f, action, fields); const body = await response.json();
  assert.ok(response.status === 200 || response.status === 201, JSON.stringify(body)); return body.data as Row;
}
async function read(f: Fixture, month = '2026-10', asOf = '2026-10-15', propertyId?: string) {
  return (await result(await f.request('GET', base + '/rental?month=' + month + '&asOf=' + asOf + (propertyId ? '&propertyId=' + propertyId : '')))).data as Row;
}
async function fixture(t: TestContext) { const f = await createOwnerQaFixture(); t.after(() => f.close()); await f.login(); return f; }
async function property(f: Fixture, name = 'Synthetic rental QA villa') {
  return (await result(await f.request('POST', base + '/properties', { name }, { 'Idempotency-Key': randomUUID() }), 201)).data as Row;
}
async function arrangement(f: Fixture, code = 'QA-01', rent = '1000.00', currency = 'QAR') {
  const p = await property(f), room = await create(f, 'create-room', { propertyId: p.id, code, label: 'Synthetic room' });
  const tenant = await create(f, 'create-tenant', { name: 'Synthetic tenant QA', phone: '+00000000000', email: 'tenant@example.invalid', notes: 'Synthetic contact only' });
  const agreement = await create(f, 'create-agreement', { roomId: room.id, tenantId: tenant.id, monthlyRent: rent, currency, depositRequired: '500.00', dueTerms: 'Owner enters the exact monthly due date', startDate: '2026-10-01', endDate: null });
  return { p, room, tenant, agreement };
}
async function due(f: Fixture, agreementId: string, period = '2026-10', amount = '1000.00') {
  return create(f, 'issue-due', { agreementId, period, dueDate: period + '-05', amount });
}
async function denied(response: Response) { const body = await response.json(); assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(body)); assert.equal(body.data, undefined); }

test('Rental QA: property-scoped normalized room uniqueness, occupancy and room edit history', async t => {
  const f = await fixture(t), a = await arrangement(f), b = await property(f, 'Synthetic second villa');
  await denied(await write(f, 'create-room', { propertyId: a.p.id, code: ' qa-01 ' }));
  await create(f, 'create-room', { propertyId: b.id, code: 'qa-01' });
  await create(f, 'create-room', { propertyId: a.p.id, code: 'QA-02' });
  const state = await read(f); assert.equal(state.summary.totalRooms, 3); assert.equal(state.summary.occupiedRooms, 1); assert.equal(state.summary.vacantRooms, 2);
  assert.equal(state.rooms.find((r: Row) => r.id === a.room.id).occupancy, 'occupied');
  await create(f, 'update-room', { roomId: a.room.id, expectedVersion: 1, code: 'QA-01', label: 'Synthetic changed label' });
  await denied(await write(f, 'update-room', { roomId: a.room.id, expectedVersion: 1, code: 'QA-03' }));
  const changed = await read(f); assert.ok(changed.history.length >= state.history.length + 1);
  assert.equal(changed.rooms.find((r: Row) => r.id === a.room.id).version, 2);
});

test('Rental QA: renewal preserves tenant/agreement history and old due snapshot', async t => {
  const f = await fixture(t), a = await arrangement(f), oldDue = await due(f, a.agreement.id);
  await denied(await write(f, 'create-agreement', { roomId: a.room.id, tenantId: a.tenant.id, monthlyRent: '1200.00', currency: 'QAR', depositRequired: '0.00', dueTerms: 'Explicit dates', startDate: '2026-10-20', endDate: null }));
  await create(f, 'end-agreement', { agreementId: a.agreement.id, expectedVersion: 1, endDate: '2026-10-31' });
  const nextTenant = await create(f, 'create-tenant', { name: 'Synthetic next occupant' });
  const renewal = await create(f, 'create-agreement', { roomId: a.room.id, tenantId: nextTenant.id, monthlyRent: '1250.00', currency: 'QAR', depositRequired: '0.00', dueTerms: 'Explicit renewed terms', startDate: '2026-11-01', endDate: null, previousAgreementId: a.agreement.id });
  await due(f, renewal.id, '2026-11', '1250.00');
  const state = await read(f), october = state.dues.find((r: Row) => r.id === oldDue.id);
  assert.equal(october.amountMinor, '100000'); assert.equal(october.agreementId, a.agreement.id);
  assert.ok(october.snapshot); assert.equal(state.tenants.length, 2); assert.equal(state.agreements.length, 2);
  assert.equal(state.agreements.find((r: Row) => r.id === renewal.id).previousAgreementId, a.agreement.id);
  assert.equal((await read(f, '2026-11', '2026-11-15')).summary.occupiedRooms, 1);
});

test('Rental QA: partial cash and bank receipts reconcile exact due, while cheque stays pending', async t => {
  const f = await fixture(t), a = await arrangement(f), d = await due(f, a.agreement.id);
  await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'rent', method: 'cash', amount: '250.00', receivedDate: '2026-10-06', allocations: [{ dueId: d.id, amount: '250.00' }] });
  let state = await read(f), selected = state.dues.find((r: Row) => r.id === d.id);
  assert.equal(selected.status, 'partial'); assert.equal(selected.paidMinor, '25000'); assert.equal(selected.outstandingMinor, '75000');
  const cheque = await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'rent', method: 'cheque', amount: '750.00', receivedDate: '2026-10-07', reference: 'SYNTHETIC-CHEQUE-01' });
  assert.equal(cheque.status, 'pending'); state = await read(f); selected = state.dues.find((r: Row) => r.id === d.id);
  assert.equal(selected.paidMinor, '25000'); assert.equal(state.summary.currencies[0].chequePendingMinor, '75000');
  await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'rent', method: 'bank', amount: '750.00', receivedDate: '2026-10-08', reference: 'SYNTHETIC-BANK-01', allocations: [{ dueId: d.id, amount: '750.00' }] });
  state = await read(f); selected = state.dues.find((r: Row) => r.id === d.id);
  assert.equal(selected.status, 'paid'); assert.equal(selected.paidMinor, '100000'); assert.equal(selected.outstandingMinor, '0');
  assert.equal(state.summary.currencies[0].collectedMinor, '100000');
  await denied(await write(f, 'clear-cheque', { collectionId: cheque.id }));
});

test('Rental QA: deposits and advances remain separate; only explicit advance allocation pays rent', async t => {
  const f = await fixture(t), a = await arrangement(f), d = await due(f, a.agreement.id);
  const advance = await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'advance', method: 'cash', amount: '300.00', receivedDate: '2026-10-01' });
  await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'deposit', method: 'bank', amount: '500.00', receivedDate: '2026-10-01' });
  let state = await read(f), c = state.summary.currencies[0];
  assert.equal(c.collectedMinor, '0'); assert.equal(c.outstandingMinor, '100000'); assert.equal(c.advanceMinor, '30000'); assert.equal(c.depositMinor, '50000');
  await create(f, 'allocate-advance', { collectionId: advance.id, dueId: d.id, amount: '200.00', allocationDate: '2026-10-10' });
  state = await read(f); c = state.summary.currencies[0];
  assert.equal(c.collectedMinor, '20000'); assert.equal(c.outstandingMinor, '80000'); assert.equal(c.advanceMinor, '10000'); assert.equal(c.depositMinor, '50000');
  await denied(await write(f, 'allocate-advance', { collectionId: advance.id, dueId: d.id, amount: '100.01', allocationDate: '2026-10-10' }));
  await create(f, 'refund-deposit', { agreementId: a.agreement.id, amount: '125.00', method: 'cash', receivedDate: '2026-10-10' });
  c = (await read(f)).summary.currencies[0]; assert.equal(c.depositMinor, '37500'); assert.equal(c.collectedMinor, '20000');
  await denied(await write(f, 'refund-deposit', { agreementId: a.agreement.id, amount: '375.01', method: 'bank', receivedDate: '2026-10-11' }));
});

test('Rental QA: exact command retry and concurrent attempts cannot duplicate a receipt or monthly due', async t => {
  const f = await fixture(t), a = await arrangement(f), d = await due(f, a.agreement.id);
  await denied(await write(f, 'issue-due', { agreementId: a.agreement.id, period: '2026-10', dueDate: '2026-10-05', amount: '1000.00' }));
  const key = randomUUID(), fields = { agreementId: a.agreement.id, kind: 'rent', method: 'cash', amount: '100.00', receivedDate: '2026-10-06', allocations: [{ dueId: d.id, amount: '100.00' }] };
  const responses = await Promise.all([write(f, 'record-collection', fields, key), write(f, 'record-collection', fields, key)]);
  for (const response of responses) assert.ok(response.status === 200 || response.status === 201, await response.clone().text());
  const bodies = await Promise.all(responses.map(r => r.json())); assert.equal(bodies[0].data.id, bodies[1].data.id);
  await denied(await write(f, 'record-collection', { ...fields, amount: '101.00', allocations: [{ dueId: d.id, amount: '101.00' }] }, key));
  const state = await read(f); assert.equal(state.collections.length, 1); assert.equal(state.dues[0].paidMinor, '10000');
});

test('Rental QA: cross-agreement allocation, overpayment and inconsistent receipt totals have no effects', async t => {
  const f = await fixture(t), a = await arrangement(f), b = await arrangement(f, 'QA-02'), d = await due(f, a.agreement.id), other = await due(f, b.agreement.id);
  const state = await read(f);
  for (const fields of [
    { amount: '100.00', allocations: [{ dueId: other.id, amount: '100.00' }] },
    { amount: '1000.01', allocations: [{ dueId: d.id, amount: '1000.01' }] },
    { amount: '100.00', allocations: [{ dueId: d.id, amount: '99.99' }] },
    { amount: '100.00', allocations: [{ dueId: d.id, amount: '50.00' }, { dueId: randomUUID(), amount: '50.00' }] }
  ]) await denied(await write(f, 'record-collection', { agreementId: a.agreement.id, kind: 'rent', method: 'cash', receivedDate: '2026-10-10', ...fields }));
  const after = await read(f); assert.deepEqual(after.collections, state.collections); assert.deepEqual(after.allocations, state.allocations); assert.deepEqual(after.summary, state.summary);
});

test('Rental QA: distinct competing payments cannot jointly over-allocate a due', async t => {
  const f = await fixture(t), a = await arrangement(f), d = await due(f, a.agreement.id);
  const fields = { agreementId: a.agreement.id, kind: 'rent', method: 'cash', amount: '600.00', receivedDate: '2026-10-10', allocations: [{ dueId: d.id, amount: '600.00' }] };
  const responses = await Promise.all([write(f, 'record-collection', fields), write(f, 'record-collection', fields)]);
  assert.equal(responses.filter(r => r.ok).length, 1); assert.equal(responses.filter(r => r.status >= 400 && r.status < 500).length, 1);
  const state = await read(f); assert.equal(state.collections.length, 1); assert.equal(state.dues[0].paidMinor, '60000'); assert.equal(state.dues[0].outstandingMinor, '40000');
  // PGlite serializes transactions. Native separate-connection lock behavior
  // remains an additional acceptance gate, not established by this test.
});

test('Rental QA: explicit dates and decimal amounts reject invalid values without proration or automatic dues', async t => {
  const f = await fixture(t), a = await arrangement(f);
  assert.equal((await read(f)).dues.length, 0);
  for (const amount of ['0', '-1.00', 'NaN', '1e3', '1.001', '10000000000.00', 1000]) await denied(await write(f, 'issue-due', { agreementId: a.agreement.id, period: '2026-10', dueDate: '2026-10-05', amount }));
  for (const dueDate of ['2026-10-32', '2026-11-01', '2026-02-30', '2026-10-05T00:00:00Z']) await denied(await write(f, 'issue-due', { agreementId: a.agreement.id, period: '2026-10', dueDate, amount: '1000.00' }));
  await create(f, 'issue-due', { agreementId: a.agreement.id, period: '2026-10', dueDate: '2026-10-31', amount: '900.25' });
  assert.equal((await read(f)).dues[0].amountMinor, '90025');
});

test('Rental QA: dashboard amounts are grouped by currency and property filters isolate records', async t => {
  const f = await fixture(t), a = await arrangement(f), b = await arrangement(f, 'USD-01', '50.00', 'USD');
  await due(f, a.agreement.id); await due(f, b.agreement.id, '2026-10', '50.00');
  const state = await read(f), amounts = new Map(state.summary.currencies.map((c: Row) => [c.currency, c.dueMinor]));
  assert.equal(amounts.get('QAR'), '100000'); assert.equal(amounts.get('USD'), '5000');
  const filtered = await read(f, '2026-10', '2026-10-15', a.p.id);
  assert.equal(filtered.rooms.length, 1); assert.equal(filtered.summary.currencies.length, 1); assert.equal(filtered.summary.currencies[0].currency, 'QAR');
});

test('Rental QA: future-dated rent receipt does not pay an earlier as-of summary', async t => {
  const f = await fixture(t), a = await arrangement(f), d = await due(f, a.agreement.id);
  await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'rent', method: 'bank', amount: '1000.00', receivedDate: '2026-10-31', reference: 'SYNTHETIC-FUTURE-RECEIPT', allocations: [{ dueId: d.id, amount: '1000.00' }] });
  const earlier = await read(f, '2026-10', '2026-10-15');
  assert.equal(earlier.dues[0].paidMinor, '0'); assert.equal(earlier.dues[0].outstandingMinor, '100000');
  assert.equal(earlier.summary.currencies[0].collectedMinor, '0'); assert.equal(earlier.summary.currencies[0].outstandingMinor, '100000');
  const later = await read(f, '2026-10', '2026-10-31'); assert.equal(later.dues[0].paidMinor, '100000');
});

test('Rental QA: advance allocation requires an explicit date and changes only that date onward', async t => {
  const f = await fixture(t), a = await arrangement(f), d = await due(f, a.agreement.id);
  const receipt = await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'advance', method: 'bank', amount: '300.00', receivedDate: '2026-10-10' });
  await denied(await write(f, 'allocate-advance', { collectionId: receipt.id, dueId: d.id, amount: '100.00' }));
  await denied(await write(f, 'allocate-advance', { collectionId: receipt.id, dueId: d.id, amount: '100.00', allocationDate: '2026-10-09' }));
  await create(f, 'allocate-advance', { collectionId: receipt.id, dueId: d.id, amount: '200.00', allocationDate: '2026-10-31' });
  const earlier = (await read(f, '2026-10', '2026-10-15')).summary.currencies[0];
  assert.equal(earlier.advanceMinor, '30000'); assert.equal(earlier.collectedMinor, '0'); assert.equal(earlier.outstandingMinor, '100000');
  const later = (await read(f, '2026-10', '2026-10-31')).summary.currencies[0];
  assert.equal(later.advanceMinor, '10000'); assert.equal(later.collectedMinor, '20000'); assert.equal(later.outstandingMinor, '80000');
});

test('Rental QA: deposit refund cannot borrow a future deposit or invalidate a later dated balance', async t => {
  const f = await fixture(t), a = await arrangement(f);
  await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'deposit', method: 'bank', amount: '500.00', receivedDate: '2026-10-31' });
  await denied(await write(f, 'refund-deposit', { agreementId: a.agreement.id, amount: '1.00', method: 'cash', receivedDate: '2026-10-10' }));
  await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'deposit', method: 'cash', amount: '500.00', receivedDate: '2026-10-01' });
  await create(f, 'refund-deposit', { agreementId: a.agreement.id, amount: '400.00', method: 'bank', receivedDate: '2026-10-20' });
  await denied(await write(f, 'refund-deposit', { agreementId: a.agreement.id, amount: '200.00', method: 'cash', receivedDate: '2026-10-10' }));
  const earlier = (await read(f, '2026-10', '2026-10-15')).summary.currencies[0]; assert.equal(earlier.depositMinor, '50000');
  const later = (await read(f, '2026-10', '2026-10-31')).summary.currencies[0]; assert.equal(later.depositMinor, '60000'); assert.equal(later.collectedMinor, '0');
});

test('Rental QA: confirmed password owner is allowed; missing identity, CSRF, disabled membership and expiry deny', async t => {
  const f = await createOwnerQaFixture(); t.after(() => f.close());
  await denied(await f.request('GET', base + '/rental?month=2026-10&asOf=2026-10-15'));
  await f.login(false); await result(await f.request('GET', base + '/rental?month=2026-10&asOf=2026-10-15'));
  assert.equal(f.fake.facts.calls.mfa, 0); f.fake.facts.emailConfirmed = false;
  await denied(await f.request('GET', base + '/rental?month=2026-10&asOf=2026-10-15')); f.fake.facts.emailConfirmed = true;
  await f.login(); const p = await property(f);
  await denied(await write(f, 'create-room', { propertyId: p.id, code: 'BLOCKED' }, randomUUID(), { 'X-Hamdee-CSRF': '' }));
  assert.equal((await read(f)).rooms.length, 0);
  f.clock.advance(f.inputs.idleMilliseconds); await denied(await f.request('GET', base + '/rental?month=2026-10&asOf=2026-10-15'));
  await f.login(); await f.pg!.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1', [f.member!.id]);
  await denied(await f.request('GET', base + '/rental?month=2026-10&asOf=2026-10-15'));
  const wrong = await createOwnerQaFixture(); t.after(() => wrong.close()); wrong.fake.facts.subject = OTHER_QA_SUBJECT;
  await wrong.auth('GET', 'state'); await denied(await wrong.auth('POST', 'login', { email: wrong.inputs.email, password: wrong.inputs.password }));
});

test('Rental QA: archived property retains history but rejects new rental mutations', async t => {
  const f = await fixture(t), a = await arrangement(f), d = await due(f, a.agreement.id), before = await read(f);
  await result(await f.request('POST', base + '/properties/' + a.p.id + '/archive', { reason: 'Synthetic rental archived property' }, { 'Idempotency-Key': randomUUID(), 'If-Match': `"property:${a.p.id}:1"` }));
  await denied(await write(f, 'create-room', { propertyId: a.p.id, code: 'NO-NEW-ROOM' }));
  await denied(await write(f, 'record-collection', { agreementId: a.agreement.id, kind: 'rent', method: 'cash', amount: '1.00', receivedDate: '2026-10-10', allocations: [{ dueId: d.id, amount: '1.00' }] }));
  const after = await read(f); assert.equal(after.agreements.length, before.agreements.length); assert.deepEqual(after.dues, before.dues); assert.equal(after.history.length, before.history.length);
});

test('Rental QA: runtime SQL cannot rewrite issued dues, recorded receipts or audit events', async t => {
  const f = await fixture(t), a = await arrangement(f), d = await due(f, a.agreement.id);
  await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'rent', method: 'cash', amount: '10.00', receivedDate: '2026-10-10', allocations: [{ dueId: d.id, amount: '10.00' }] });
  const before = await read(f);
  for (const statement of [
    "UPDATE hamdee_private.rent_dues SET amount_minor=1",
    "UPDATE hamdee_private.rent_collections SET amount_minor=1",
    "UPDATE hamdee_private.rental_events SET detail='{}'::jsonb"
  ]) {
    try {
      await f.pg!.transaction(async sql => {
        await sql.exec('SET LOCAL ROLE hamdee_runtime');
        await sql.query("SELECT set_config('hamdee.actor',$1,true)", [f.member!.id]);
        const changed = await sql.query(statement + ' RETURNING id'); assert.equal(changed.rows.length, 0);
      });
    } catch (error) {
      // Permission denial or immutable trigger are both acceptable; never hide
      // an assertion failure caused by a runtime-visible successful rewrite.
      if (error instanceof assert.AssertionError) throw error;
      assert.match(String(error), /permission denied|immutable|append.only|cannot update|row.level security/i);
    }
  }
  const after = await read(f); assert.deepEqual(after.dues, before.dues); assert.deepEqual(after.collections, before.collections); assert.deepEqual(after.history, before.history);
});

test('Rental QA: runtime room and tenant updates require a new event and monotonic revision', async t => {
  const f = await fixture(t); await arrangement(f); const before = await read(f);
  for (const statement of [
    "UPDATE hamdee_private.rooms SET label='Synthetic bypass'",
    "UPDATE hamdee_private.tenants SET name='Synthetic bypass'",
    "UPDATE hamdee_private.rooms SET version=version+2",
    "UPDATE hamdee_private.rental_agreements SET version=version+2"
  ]) {
    await assert.rejects(() => f.pg!.transaction(async sql => {
      await sql.exec('SET LOCAL ROLE hamdee_runtime'); await sql.query("SELECT set_config('hamdee.actor',$1,true)", [f.member!.id]); await sql.query(statement);
    }), /revision|event|immutable|permission denied/i);
  }
  const after = await read(f); assert.deepEqual(after.rooms, before.rooms); assert.deepEqual(after.tenants, before.tenants); assert.deepEqual(after.agreements, before.agreements);
});

test('Rental QA: additive migration preserves accepted property data/history and enables rooms without a reset', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  for (const file of ['001_property_foundation.up.sql', '002_property_hardening.up.sql']) await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  await seedOwnerAppRecords(pg); const f = await createOwnerQaFixture({ database: adapter(pg), pg }); await f.login(); const p = await property(f, 'Synthetic pre-rental-migration villa');
  const audit = (await result(await f.request('GET', base + '/properties/' + p.id + '/audit'))).data;
  await pg.transaction(async tx => tx.exec(await readFile(new URL('../migrations/003_local_rental_operations.up.sql', import.meta.url), 'utf8')));
  assert.deepEqual((await result(await f.request('GET', base + '/properties/' + p.id))).data, p);
  assert.deepEqual((await result(await f.request('GET', base + '/properties/' + p.id + '/audit'))).data, audit);
  await create(f, 'create-room', { propertyId: p.id, code: 'UPGRADE-01' }); assert.equal((await read(f)).summary.totalRooms, 1);
});

test('Rental QA: database failure after writes rolls back receipt/history and permits same-key retry', async t => {
  const pg = new PGlite(); t.after(() => pg.close()); await pg.exec(await up()); await seedOwnerAppRecords(pg);
  let inject = false;
  const actual = adapter(pg), database: Database = { transaction: work => actual.transaction(async sql => {
    let wrote = false; const value = await work({ query: async (text, params) => { if (/\b(?:INSERT|UPDATE|DELETE)\b/i.test(text)) wrote = true; return sql.query(text, params); } });
    if (inject && wrote) throw new Error('SYNTHETIC_RENTAL_BEFORE_COMMIT_FAILURE'); return value;
  }) };
  const f = await createOwnerQaFixture({ database, pg }); await f.login(); const a = await arrangement(f), d = await due(f, a.agreement.id), before = await read(f);
  const key = randomUUID(), fields = { agreementId: a.agreement.id, kind: 'rent', method: 'bank', amount: '100.00', receivedDate: '2026-10-10', allocations: [{ dueId: d.id, amount: '100.00' }] };
  inject = true; await result(await write(f, 'record-collection', fields, key), 503); inject = false;
  const after = await read(f); assert.deepEqual(after.collections, before.collections); assert.deepEqual(after.history, before.history); assert.deepEqual(after.dues, before.dues);
  const retry = await write(f, 'record-collection', fields, key);
  assert.ok(retry.ok, await retry.text()); assert.equal((await read(f)).dues[0].paidMinor, '10000');
});

test('Rental QA: persisted records and history survive PGlite database close/reopen and new application session', async t => {
  const directory = path.resolve('.test-data', 'rental-qa-' + randomUUID()); await mkdir(directory, { recursive: true });
  let pg = new PGlite(directory); let closed = false; t.after(async () => { if (!closed) await pg.close(); });
  await pg.exec(await up()); await seedOwnerAppRecords(pg);
  const f = await createOwnerQaFixture({ database: adapter(pg), pg }); await f.login(); const a = await arrangement(f), d = await due(f, a.agreement.id);
  await create(f, 'record-collection', { agreementId: a.agreement.id, kind: 'rent', method: 'cash', amount: '150.00', receivedDate: '2026-10-15', allocations: [{ dueId: d.id, amount: '150.00' }] });
  const before = await read(f); await pg.close(); closed = true; pg = new PGlite(directory); closed = false;
  const reopened = await createOwnerQaFixture({ database: adapter(pg), pg }); await reopened.login(); const after = await read(reopened);
  assert.deepEqual(after.dues, before.dues); assert.deepEqual(after.collections, before.collections); assert.deepEqual(after.history, before.history); assert.deepEqual(after.summary, before.summary);
});
