import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Database, Sql } from '../src/database';
import { OTHER_QA_SUBJECT } from './support/owner-crm-harness';
import { createStaffQaFixture, STAFF_BASE, FINANCE_BASE, qaBody, qaDenied, assertMajor,
  staffWrite, financeWrite, staffRead, financeRead, seedPropertyReceipt, type StaffQaFixture, type QaRecord } from './support/staff-qa-fixture';

// Prepared against the frozen v1 contract; execute only after Coordinator's
// complete service/schema/HTTP freeze is bound into this isolated worktree.
async function fixture(t: TestContext, options: Parameters<typeof createStaffQaFixture>[0] = {}) {
  const f = await createStaffQaFixture(options); t.after(() => f.close()); await f.login(false); return f;
}
const collect = async (f: StaffQaFixture, body: QaRecord, key?: string) => (await qaBody(await staffWrite(f, body, key))).data as QaRecord;
const finance = async (f: StaffQaFixture, body: QaRecord, key?: string) => (await qaBody(await financeWrite(f, body, key))).data as QaRecord;
const collector = (f: StaffQaFixture, name = 'Synthetic collector ' + randomUUID()) => collect(f, { action: 'create-collector', name, phone: '+00000000000', notes: 'Synthetic local collector record only' });
const account = (f: StaffQaFixture, currency = 'QAR', kind = 'cash', opening = '0.00', scope = 'company') => finance(f, {
  action: 'create-account', name: 'Synthetic company ' + randomUUID(), scope, kind, currency, openingDate: '2026-10-01', openingAmount: opening, ownerConfirmedOpening: true
});
const source = (f: StaffQaFixture, amount = '300.00', currency = 'QAR', method = 'cash', receivedOn = '2026-10-16') => finance(f, {
  action: 'create-classified-receipt', receiptKey: randomUUID(), classification: 'synthetic-other', receivedOn, amount, currency, method, reference: 'SYNTHETIC-SOURCE-' + randomUUID()
});
const attach = (f: StaffQaFixture, collectorId: string, sourceId: string, sourceKind = 'classified-receipt', extra: QaRecord = {}, key?: string) => collect(f, {
  action: 'record-collection', collectorId, sourceKind, sourceId, disposition: 'collector-held', ownerConfirmedDisposition: true, ...extra
}, key);
const handover = (f: StaffQaFixture, collectorId: string, accountId: string, amount: string, extra: QaRecord = {}, key?: string) => collect(f, {
  action: 'handover', collectorId, accountId, amount, currency: 'QAR', handedOn: '2026-10-16', reference: 'SYNTHETIC-HANDOVER-' + randomUUID(), ...extra
}, key);
function collectorTotal(state: QaRecord, id: string, currency = 'QAR'): QaRecord { const r = state.totals.find((v: QaRecord) => v.collectorId === id && v.currency === currency); assert.ok(r); return r; }
function accountTotal(state: QaRecord, id: string): QaRecord { const r = state.totals.find((v: QaRecord) => v.accountId === id); assert.ok(r); return r; }

test('Staff QA: collector edit/version/history creates no login identity or role', async t => {
  const f = await fixture(t), c = await collector(f, 'Synthetic original collector');
  assert.equal(c.version, 1); const changed = await collect(f, { action: 'update-collector', collectorId: c.id, expectedVersion: 1, name: 'Synthetic edited collector', notes: 'Synthetic edit reason' });
  assert.equal(changed.id, c.id); assert.equal(changed.version, 2); assert.equal(changed.name, 'Synthetic edited collector');
  await qaDenied(await staffWrite(f, { action: 'update-collector', collectorId: c.id, expectedVersion: 1, name: 'Synthetic stale overwrite' }));
  const state = await staffRead(f); assert.equal(state.collectors[0].name, 'Synthetic edited collector');
  assert.ok(state.history.some((e: QaRecord) => e.action === 'staff:create-collector'));
  assert.ok(state.history.some((e: QaRecord) => e.action === 'staff:update-collector'));
  assert.equal((await f.pg.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.app_users')).rows[0].n, 1);
  assert.equal((await f.pg.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.role_assignments')).rows[0].n, 1);
});

test('Staff QA: property reference carries authoritative amount/currency/tenant and cannot be mass-assigned', async t => {
  const f = await fixture(t), c = await collector(f), p = await seedPropertyReceipt(f, { amount: '240.00' });
  const choices = (await qaBody(await f.request('GET', STAFF_BASE + '/receipts?asOf=2026-10-16&propertyId=' + p.property.id))).data;
  const receipt = choices.data.find((r: QaRecord) => r.id === p.collection.id); assert.ok(receipt);
  assert.equal(receipt.propertyId, p.property.id); assert.equal(receipt.tenantId, p.tenant.id); assertMajor(receipt.amount, '240.00'); assert.equal(receipt.currency, 'QAR');
  await qaDenied(await staffWrite(f, { action: 'record-collection', collectorId: c.id, sourceKind: 'property-rent', sourceId: p.collection.id, disposition: 'collector-held', ownerConfirmedDisposition: true, amount: '99999.00', currency: 'USD' }));
  const linked = await attach(f, c.id, p.collection.id, 'property-rent');
  assertMajor(linked.amount, '240.00'); assert.equal(linked.source.propertyId, p.property.id); assert.equal(linked.source.tenantId, p.tenant.id);
  assertMajor(collectorTotal(await staffRead(f), c.id).balance, '240.00');
  await qaDenied(await staffWrite(f, { action: 'record-collection', collectorId: c.id, sourceKind: 'car-rental', sourceId: randomUUID(), disposition: 'collector-held', ownerConfirmedDisposition: true }));
});

test('Staff QA: duplicate source and changed-key payload cannot double receipts or move them between collectors', async t => {
  const f = await fixture(t), a = await collector(f), b = await collector(f), s = await source(f), key = randomUUID();
  const original = await attach(f, a.id, s.id, 'classified-receipt', {}, key);
  const replay = await qaBody(await staffWrite(f, { action: 'record-collection', collectorId: a.id, sourceKind: 'classified-receipt', sourceId: s.id, disposition: 'collector-held', ownerConfirmedDisposition: true }, key));
  assert.equal(replay.replay, true); assert.equal(replay.data.id, original.id);
  await qaDenied(await staffWrite(f, { action: 'record-collection', collectorId: b.id, sourceKind: 'classified-receipt', sourceId: s.id, disposition: 'collector-held', ownerConfirmedDisposition: true }));
  await qaDenied(await staffWrite(f, { action: 'record-collection', collectorId: b.id, sourceKind: 'classified-receipt', sourceId: s.id, disposition: 'collector-held', ownerConfirmedDisposition: true }, key));
  const state = await staffRead(f); assert.equal(state.collections.length, 1); assertMajor(collectorTotal(state, a.id).balance, '300.00');
});

test('Staff QA: classified receipt identity and command replay preserve one authoritative source', async t => {
  const f = await fixture(t), c = await collector(f), key = randomUUID(), fields = { action: 'create-classified-receipt', receiptKey: randomUUID(),
    classification: 'synthetic-other', receivedOn: '2026-10-16', amount: '90.25', currency: 'QAR', method: 'cash', reference: 'SYNTHETIC-CLASSIFIED-IDENTITY' };
  const first = await finance(f, fields, key), replay = await qaBody(await financeWrite(f, fields, key));
  assert.equal(replay.data.id, first.id); assert.equal(replay.replay, true);
  await qaDenied(await financeWrite(f, fields)); await qaDenied(await financeWrite(f, { ...fields, amount: '91.25' }));
  await attach(f, c.id, first.id); const state = await staffRead(f); assert.equal(state.collections.length, 1); assertMajor(collectorTotal(state, c.id).balance, '90.25');
  assert.equal((await financeRead(f)).entries.length, 0);
});

test('Staff QA: partial then full handover reconciles custody and company transfers without new income', async t => {
  const f = await fixture(t), c = await collector(f), a = await account(f), s = await source(f);
  await attach(f, c.id, s.id); await handover(f, c.id, a.id, '125.00');
  let total = collectorTotal(await staffRead(f), c.id); assertMajor(total.received, '300.00'); assertMajor(total.handedOver, '125.00'); assertMajor(total.balance, '175.00');
  let ledger = accountTotal(await financeRead(f), a.id); assertMajor(ledger.receipts, '0.00'); assertMajor(ledger.transfersIn, '125.00'); assertMajor(ledger.balance, '125.00');
  await handover(f, c.id, a.id, '175.00'); total = collectorTotal(await staffRead(f), c.id); assertMajor(total.balance, '0.00'); assertMajor(total.handedOver, '300.00');
  ledger = accountTotal(await financeRead(f), a.id); assertMajor(ledger.balance, '300.00'); assertMajor(ledger.receipts, '0.00');
});

test('Staff QA: duplicate reference, other collector and excessive handovers have no partial effects', async t => {
  const f = await fixture(t), c = await collector(f), other = await collector(f), a = await account(f), s = await source(f);
  await attach(f, c.id, s.id); await handover(f, c.id, a.id, '100.00', { reference: 'SYNTHETIC-UNIQUE-HANDOVER' });
  const before = await staffRead(f), ledger = await financeRead(f);
  for (const fields of [{ collectorId: c.id, amount: '100.00', reference: 'SYNTHETIC-UNIQUE-HANDOVER' }, { collectorId: c.id, amount: '200.01', reference: 'SYNTHETIC-TOO-MUCH' }, { collectorId: other.id, amount: '1.00', reference: 'SYNTHETIC-NO-BORROWING' }])
    await qaDenied(await staffWrite(f, { action: 'handover', accountId: a.id, currency: 'QAR', handedOn: '2026-10-16', ...fields }));
  assert.deepEqual(await staffRead(f), before); assert.deepEqual(await financeRead(f), ledger);
});

test('Staff QA: correction preserves superseded handover and nets both ledgers exactly once', async t => {
  const f = await fixture(t), c = await collector(f), a = await account(f), s = await source(f); await attach(f, c.id, s.id);
  const old = await handover(f, c.id, a.id, '200.00');
  const corrected = await collect(f, { action: 'correct-handover', handoverId: old.id, accountId: a.id, amount: '150.00', currency: 'QAR', handedOn: '2026-10-16', reference: 'SYNTHETIC-CORRECTED', reason: 'Synthetic recorded amount correction' });
  assert.equal(corrected.replacesHandoverId, old.id); const state = await staffRead(f);
  assert.equal(state.handovers.length, 2); assert.equal(state.handovers.find((h: QaRecord) => h.id === old.id).reversed, true);
  assertMajor(collectorTotal(state, c.id).handedOver, '150.00'); assertMajor(collectorTotal(state, c.id).balance, '150.00');
  const ledger = await financeRead(f); assertMajor(accountTotal(ledger, a.id).balance, '150.00');
  assert.ok(state.history.some((e: QaRecord) => e.action === 'staff:correct-handover'));
  const linkedEntry = ledger.entries.find((e: QaRecord) => e.entryKind === 'handover-in' && e.transferId === corrected.id); assert.ok(linkedEntry);
  await qaDenied(await financeWrite(f, { action: 'reverse', entryId: linkedEntry.id, reversedOn: '2026-10-16', reason: 'Synthetic invalid bypass of staff correction' }));
});

test('Staff QA: collection reversal cannot invalidate a dependent handover; explicit reverse ordering is audited', async t => {
  const f = await fixture(t), c = await collector(f), a = await account(f), s = await source(f), collection = await attach(f, c.id, s.id), h = await handover(f, c.id, a.id, '200.00');
  const before = await staffRead(f);
  await qaDenied(await staffWrite(f, { action: 'reverse-collection', collectionId: collection.id, reversedOn: '2026-10-16', reason: 'Synthetic dependent reversal attempt' })); assert.deepEqual(await staffRead(f), before);
  await collect(f, { action: 'reverse-handover', handoverId: h.id, reversedOn: '2026-10-16', reason: 'Synthetic undo transfer first' });
  await collect(f, { action: 'reverse-collection', collectionId: collection.id, reversedOn: '2026-10-16', reason: 'Synthetic reverse custody record' });
  const final = await staffRead(f); assertMajor(collectorTotal(final, c.id).balance, '0.00'); assertMajor(accountTotal(await financeRead(f), a.id).balance, '0.00');
  assert.equal(final.collections[0].reversed, true); assert.equal(final.handovers[0].reversed, true);
});

test('Staff QA: direct company bank receipt creates no held cash or handover entitlement', async t => {
  const f = await fixture(t), c = await collector(f), bank = await account(f, 'QAR', 'bank'), s = await source(f, '200.00', 'QAR', 'bank');
  await qaDenied(await staffWrite(f, { action: 'record-collection', collectorId: c.id, sourceKind: 'classified-receipt', sourceId: s.id }));
  await attach(f, c.id, s.id, 'classified-receipt', { disposition: 'company-direct', accountId: bank.id });
  const total = collectorTotal(await staffRead(f), c.id); assertMajor(total.companyDirect, '200.00'); assertMajor(total.balance, '0.00'); assertMajor(total.received, '0.00');
  assertMajor(accountTotal(await financeRead(f), bank.id).receipts, '200.00');
  await qaDenied(await staffWrite(f, { action: 'handover', collectorId: c.id, accountId: bank.id, amount: '1.00', currency: 'QAR', handedOn: '2026-10-16', reference: 'SYNTHETIC-DIRECT-NOT-HELD' }));
});

test('Staff QA: pending cheques are tracked separately and cannot clear cash into company accounts', async t => {
  const f = await fixture(t), c = await collector(f), a = await account(f), p = await seedPropertyReceipt(f, { method: 'cheque', amount: '200.00' });
  const linked = await attach(f, c.id, p.collection.id, 'property-rent'); assert.equal(linked.disposition, 'pending');
  const total = collectorTotal(await staffRead(f), c.id); assertMajor(total.pending, '200.00'); assertMajor(total.balance, '0.00');
  await qaDenied(await staffWrite(f, { action: 'handover', collectorId: c.id, accountId: a.id, amount: '1.00', currency: 'QAR', handedOn: '2026-10-16', reference: 'SYNTHETIC-PENDING-NOT-CASH' }));
  await qaDenied(await financeWrite(f, { action: 'receive', accountId: a.id, sourceKind: 'property-rent', sourceId: p.collection.id, ownerConfirmedDisposition: true }));
  assertMajor(accountTotal(await financeRead(f), a.id).balance, '0.00');
});

test('Staff QA: deposit and advance custody never becomes rent collected or changes original rental totals', async t => {
  const f = await fixture(t), c = await collector(f), deposit = await seedPropertyReceipt(f, { kind: 'deposit', amount: '500.00' }), advance = await seedPropertyReceipt(f, { kind: 'advance', amount: '300.00' });
  const rentalPath = '/api/hamdee/v1/rental?month=2026-10&asOf=2026-10-16', before = (await qaBody(await f.request('GET', rentalPath))).data;
  await attach(f, c.id, deposit.collection.id, 'property-rent'); await attach(f, c.id, advance.collection.id, 'property-rent');
  const after = (await qaBody(await f.request('GET', rentalPath))).data; assert.deepEqual(after, before);
  assert.equal(after.summary.currencies[0].collectedMinor, '0'); assert.equal(after.summary.currencies[0].depositMinor, '50000'); assert.equal(after.summary.currencies[0].advanceMinor, '30000');
  const records = (await staffRead(f)).collections; assert.deepEqual(new Set(records.map((r: QaRecord) => r.classification)), new Set(['deposit', 'advance']));
});

test('Staff QA: currency separation and collector-wide reference uniqueness hold without conversion', async t => {
  const f = await fixture(t), c = await collector(f), qar = await account(f), usd = await account(f, 'USD');
  await attach(f, c.id, (await source(f, '50.00', 'QAR')).id); await attach(f, c.id, (await source(f, '999.00', 'USD')).id);
  await qaDenied(await staffWrite(f, { action: 'handover', collectorId: c.id, accountId: qar.id, amount: '50.01', currency: 'QAR', handedOn: '2026-10-16', reference: 'SYNTHETIC-NO-FX' }));
  await handover(f, c.id, qar.id, '50.00', { reference: 'SYNTHETIC-CROSS-CURRENCY-REF' });
  await qaDenied(await staffWrite(f, { action: 'handover', collectorId: c.id, accountId: usd.id, amount: '1.00', currency: 'USD', handedOn: '2026-10-16', reference: 'SYNTHETIC-CROSS-CURRENCY-REF' }));
  await handover(f, c.id, usd.id, '7.00', { currency: 'USD' });
  const state = await staffRead(f); assertMajor(collectorTotal(state, c.id, 'QAR').balance, '0.00'); assertMajor(collectorTotal(state, c.id, 'USD').balance, '992.00');
});

test('Staff QA: explicit day/month cutoffs preserve cumulative and period figures', async t => {
  const f = await fixture(t), c = await collector(f), a = await account(f);
  for (const [amount, receivedOn] of [['200.00', '2026-10-15'], ['300.00', '2026-10-16'], ['400.00', '2026-11-01']]) await attach(f, c.id, (await source(f, amount, 'QAR', 'cash', receivedOn)).id);
  await handover(f, c.id, a.id, '100.00');
  const earlier = collectorTotal(await staffRead(f, '2026-10', '2026-10-15'), c.id); assertMajor(earlier.balance, '200.00');
  const october = await staffRead(f), total = collectorTotal(october, c.id); assertMajor(total.monthReceived, '500.00'); assertMajor(total.balance, '400.00');
  const daily = october.daily.find((r: QaRecord) => r.collectorId === c.id && r.date === '2026-10-16'); assertMajor(daily.received, '300.00'); assertMajor(daily.handedOver, '100.00'); assertMajor(daily.balance, '400.00');
  const november = collectorTotal(await staffRead(f, '2026-11', '2026-11-01'), c.id); assertMajor(november.monthReceived, '400.00'); assertMajor(november.monthHandedOver, '0.00'); assertMajor(november.balance, '800.00');
});

test('Staff QA: concurrent identical retry posts once; competing distinct handovers cannot overdraw', async t => {
  const f = await fixture(t), c = await collector(f), a = await account(f); await attach(f, c.id, (await source(f)).id);
  const key = randomUUID(), body = { action: 'handover', collectorId: c.id, accountId: a.id, amount: '100.00', currency: 'QAR', handedOn: '2026-10-16', reference: 'SYNTHETIC-CONCURRENT-RETRY' };
  const replies = await Promise.all([staffWrite(f, body, key), staffWrite(f, body, key)]), results = await Promise.all(replies.map(r => qaBody(r)));
  assert.equal(results[0].data.id, results[1].data.id); assert.equal(results.filter(r => r.replay).length, 1);
  const races = await Promise.all(['one', 'two'].map(reference => staffWrite(f, { ...body, amount: '150.00', reference: 'SYNTHETIC-RACE-' + reference })));
  assert.deepEqual(races.map(r => r.status).sort(), [200, 409]); assertMajor(collectorTotal(await staffRead(f), c.id).balance, '50.00'); assertMajor(accountTotal(await financeRead(f), a.id).balance, '250.00');
});

test('Staff QA: failure after writes rolls back transfer/ledger/audit/command and same-key retry succeeds', async t => {
  let fail = false;
  const decorateDatabase = (database: Database): Database => ({ transaction(work) { return database.transaction(async sql => {
    let wrote = false;
    const watched: Sql = { async query<T>(text: string, values?: unknown[]) { const result = await sql.query<T>(text, values); if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)) wrote = true; return result; } };
    const result = await work(watched); if (fail && wrote) { fail = false; throw new Error('Synthetic staff post-write rollback'); } return result;
  }); } });
  const f = await fixture(t, { decorateDatabase }), c = await collector(f), a = await account(f); await attach(f, c.id, (await source(f)).id);
  const before = await staffRead(f), ledger = await financeRead(f), key = randomUUID(), body = { action: 'handover', collectorId: c.id, accountId: a.id, amount: '100.00', currency: 'QAR', handedOn: '2026-10-16', reference: 'SYNTHETIC-ROLLBACK' };
  fail = true; await qaBody(await staffWrite(f, body, key), 503); assert.equal(fail, false);
  assert.deepEqual(await staffRead(f), before); assert.deepEqual(await financeRead(f), ledger);
  await qaBody(await staffWrite(f, body, key)); assertMajor(collectorTotal(await staffRead(f), c.id).balance, '200.00');
});

test('Staff QA: disk reopen and a fresh owner session retain collector, receipt, handover, audit and ledger', async t => {
  const directory = path.resolve('.test-data', 'staff-qa-' + randomUUID()), f = await fixture(t, { directory }), c = await collector(f), a = await account(f);
  await attach(f, c.id, (await source(f)).id); await handover(f, c.id, a.id, '125.00'); const before = await staffRead(f), ledger = await financeRead(f); await f.close();
  const reopened = await fixture(t, { directory, initialize: false }); assert.deepEqual(await staffRead(reopened), before); assert.deepEqual(await financeRead(reopened), ledger);
  assert.equal(reopened.fake.facts.calls.mfa, 0); assert.equal(reopened.fake.facts.calls.signIn, 1);
});

test('Staff QA: owner/CSRF/origin/expiry/disablement remain enforced and staff login routes stay absent', async t => {
  const f = await createStaffQaFixture(); t.after(() => f.close());
  for (const route of [STAFF_BASE, STAFF_BASE + '/receipts', FINANCE_BASE]) await qaDenied(await f.request('GET', route + '?month=2026-10&asOf=2026-10-16'));
  await f.login(false);
  for (const headers of [{ 'X-Hamdee-CSRF': '' }, { Origin: 'https://foreign.example.invalid' }] as Record<string, string>[]) await qaDenied(await staffWrite(f, { action: 'create-collector', name: 'Synthetic denied collector' }, randomUUID(), headers));
  assert.equal((await staffRead(f)).collectors.length, 0);
  for (const route of ['staff/login', 'staff/signup', 'invitation']) await qaBody(await f.auth('POST', route, {}), 404);
  f.clock.advance(f.inputs.idleMilliseconds); await qaDenied(await f.request('GET', STAFF_BASE)); await f.login(false);
  await f.pg.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1', [f.member.id]); await qaDenied(await f.request('GET', STAFF_BASE));
  const wrong = await fixture(t); wrong.fake.facts.subject = OTHER_QA_SUBJECT; await wrong.auth('GET', 'state'); await qaDenied(await wrong.auth('POST', 'login', { email: wrong.inputs.email, password: wrong.inputs.password }));
});

test('Staff QA: explicit opening confirmation and exact decimals prevent fabricated or rounded balances', async t => {
  const f = await fixture(t);
  await qaDenied(await financeWrite(f, { action: 'create-account', name: 'Synthetic unconfirmed account', scope: 'company', kind: 'cash', currency: 'QAR', openingDate: '2026-10-01', openingAmount: '100.00' }));
  assert.equal((await financeRead(f)).accounts.length, 0);
  const c = await collector(f), a = await account(f); for (const amount of ['0.1', '0.2']) await attach(f, c.id, (await source(f, amount)).id);
  await handover(f, c.id, a.id, '0.3'); assertMajor(collectorTotal(await staffRead(f), c.id).balance, '0'); assertMajor(accountTotal(await financeRead(f), a.id).balance, '0.3');
});
