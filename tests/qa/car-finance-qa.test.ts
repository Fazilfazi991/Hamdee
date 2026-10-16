import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOwnerQaFixture } from '../support/owner-crm-harness';

// Prepared against the frozen DTO contract. Execute only after a complete,
// reviewed backend source/migration binding. Disposable local data only.
type Fixture = Awaited<ReturnType<typeof createOwnerQaFixture>>;
const base = '/api/hamdee/v1', migrations = ['006_local_operations_records.up.sql', '007_local_car_rentals.up.sql'];
async function setup(t: TestContext, car = true) {
  const f = await createOwnerQaFixture({ migrationFiles: car ? migrations : migrations.slice(0, 1) });
  t.after(() => f.close()); await f.login(); return f;
}
async function result(response: Response, status = 200, code?: string) {
  const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  if (code) assert.equal(body.error.code, code); return body;
}
async function command(f: Fixture, module: string, body: unknown, key = randomUUID(), status = 200, code?: string) {
  return result(await f.request('POST', base + '/' + module + '/commands', body, { 'Idempotency-Key': key }), status, code);
}
async function view(f: Fixture, module: string, cutoff = '2026-10-31') {
  return (await result(await f.request('GET', base + '/' + module + '?month=2026-10&asOf=' + cutoff))).data;
}
async function account(f: Fixture, scope: 'company' | 'personal', currency = 'QAR', openingAmount = '0') {
  return (await command(f, scope + '-finance', { action: 'create-account', scope, currency, openingAmount, openingDate: '2026-10-01',
    ownerConfirmedOpening: true, kind: 'cash', name: 'Synthetic independent ' + scope + ' ' + currency })).data;
}
async function vehicle(f: Fixture, status = 'active') {
  return (await command(f, 'car-rentals', { action: 'create-vehicle', registration: 'SYNTHETIC-' + randomUUID().slice(0, 8),
    make: 'Synthetic independent make', model: 'Synthetic independent model', status })).data;
}
function agreement(vehicleId: string, startDate = '2026-10-01', endDate = '2026-10-31') {
  return { action: 'create-agreement', vehicleId, agreementKey: randomUUID(), customerName: 'Synthetic independent customer',
    customerContact: 'qa@example.invalid', startDate, endDate, agreedAmount: '10', currency: 'QAR', billingPeriod: 'Explicit total for this whole term; no inferred rate' };
}

test('Independent finance: explicit zero, exact fractions, scoped transfer and cutoff reconcile without income or currency aggregation', async t => {
  const f = await setup(t), invalid = { action: 'create-account', scope: 'company', currency: 'QAR', kind: 'cash', name: 'Synthetic invalid opening', openingDate: '2026-10-01', openingAmount: '0' };
  await command(f, 'company-finance', invalid, randomUUID(), 409, 'OPENING_UNCONFIRMED');
  await command(f, 'company-finance', { ...invalid, ownerConfirmedOpening: false }, randomUUID(), 409, 'OPENING_UNCONFIRMED');
  const c = await account(f, 'company', 'QAR', '10.000000000001'), p = await account(f, 'personal'), usd = await account(f, 'company', 'USD', '2');
  const transfer = { action: 'transfer', fromAccountId: c.id, toAccountId: p.id, transferredOn: '2026-10-16', amount: '7', reference: 'SYNTHETIC-INDEPENDENT-TRANSFER' }, key = randomUUID();
  await command(f, 'company-finance', transfer, key); assert.equal((await command(f, 'company-finance', transfer, key)).replay, true);
  await command(f, 'company-finance', { ...transfer, amount: '8' }, key, 409, 'IDEMPOTENCY_KEY_REUSED');
  await command(f, 'personal-finance', transfer, key, 409, 'IDEMPOTENCY_KEY_REUSED');
  await command(f, 'company-finance', { ...transfer, toAccountId: usd.id }, randomUUID(), 409);
  const before = await view(f, 'company-finance', '2026-10-15'), company = await view(f, 'company-finance'), personal = await view(f, 'personal-finance');
  const total = (data: typeof company, id: string) => data.totals.find((row: { accountId: string }) => row.accountId === id);
  assert.equal(total(before, c.id).balance, '10.000000000001'); assert.equal(total(company, c.id).balance, '3.000000000001');
  assert.equal(total(company, usd.id).balance, '2'); assert.equal(total(personal, p.id).balance, '7');
  assert.equal(total(company, c.id).receipts, '0'); assert.equal(total(personal, p.id).receipts, '0');
  assert.deepEqual(personal.accounts.map((row: { id: string }) => row.id), [p.id]); assert.equal(personal.transferAccounts.length, 3);
  await result(await f.request('GET', base + '/personal-finance?month=2026-10&asOf=2026-10-31&accountId=' + c.id), 409, 'ACCOUNT_SCOPE_MISMATCH');
});

test('Independent cars: partial dated receipts, pending cheque, one maintenance cost and separate currencies reconcile at two cutoffs', async t => {
  const f = await setup(t), v = await vehicle(f), a = (await command(f, 'car-rentals', agreement(v.id))).data;
  const c = await account(f, 'company', 'QAR', '20');
  const cash = (await command(f, 'car-rentals', { action: 'record-collection', agreementId: a.id, receiptKey: randomUUID(), receivedDate: '2026-10-02', amount: '3.5', currency: 'QAR', method: 'cash' })).data;
  await command(f, 'car-rentals', { action: 'record-collection', agreementId: a.id, receiptKey: randomUUID(), receivedDate: '2026-10-16', amount: '2.25', currency: 'QAR', method: 'bank' });
  await command(f, 'car-rentals', { action: 'record-collection', agreementId: a.id, receiptKey: randomUUID(), receivedDate: '2026-10-10', amount: '4', currency: 'QAR', method: 'cheque' });
  const cost = { action: 'record-maintenance', vehicleId: v.id, expenseKey: randomUUID(), expenseDate: '2026-10-12', amount: '1.125', currency: 'QAR', description: 'Synthetic one maintenance cost' };
  await command(f, 'car-rentals', cost); await command(f, 'car-rentals', { ...cost, action: 'record-expense' }, randomUUID(), 409, 'DUPLICATE_EXPENSE');
  await command(f, 'car-rentals', { ...cost, action: 'record-expense', expenseKey: randomUUID(), amount: '0.25', currency: 'USD' });
  const early = await view(f, 'car-rentals', '2026-10-15'), later = await view(f, 'car-rentals', '2026-10-16');
  assert.equal(early.balances[0].agreedAmount, '10'); assert.equal(early.balances[0].collectedAmount, '3.5'); assert.equal(early.balances[0].outstandingAmount, '6.5');
  assert.equal(later.balances[0].collectedAmount, '5.75'); assert.equal(later.balances[0].outstandingAmount, '4.25'); assert.equal(later.balances[0].pendingChequeAmount, '4');
  assert.deepEqual(early.summary.map((row: { currency: string; recordedComparison: string }) => [row.currency, row.recordedComparison]), [['QAR', '2.375'], ['USD', '-0.25']]);
  assert.equal(early.expenses.length, 2); assert.equal((await view(f, 'company-finance')).totals[0].balance, '20');
  await command(f, 'company-finance', { action: 'receive', accountId: c.id, sourceKind: 'car-rental', sourceId: cash.id, ownerConfirmedDisposition: true });
  assert.equal((await view(f, 'company-finance')).totals[0].balance, '23.5');
  assert.equal((await view(f, 'car-rentals', '2026-10-16')).balances[0].collectedAmount, '5.75');
});

test('Independent cars: inactive rejection, inclusive boundary, next-day rental and immutable active snapshots survive later maintenance', async t => {
  const f = await setup(t), v = await vehicle(f, 'inactive');
  await command(f, 'car-rentals', agreement(v.id), randomUUID(), 409, 'VEHICLE_UNAVAILABLE');
  await command(f, 'car-rentals', { action: 'update-vehicle', vehicleId: v.id, expectedVersion: 1, status: 'active' });
  await command(f, 'car-rentals', agreement(v.id, '2026-10-01', '2026-10-15'));
  await command(f, 'car-rentals', agreement(v.id, '2026-10-15', '2026-10-31'), randomUUID(), 409, 'VEHICLE_UNAVAILABLE');
  await command(f, 'car-rentals', agreement(v.id, '2026-10-16', '2026-10-31'));
  await command(f, 'car-rentals', { action: 'update-vehicle', vehicleId: v.id, expectedVersion: 2, status: 'maintenance' });
  const saved = await view(f, 'car-rentals'); assert.equal(saved.agreements.length, 2);
  for (const row of saved.agreements) assert.equal(row.vehicleSnapshot.status, 'active');
  assert.equal(saved.availability[0].reason, 'maintenance');
  await command(f, 'car-rentals', agreement(v.id, '2026-11-01', '2026-11-30'), randomUUID(), 409, 'VEHICLE_UNAVAILABLE');
});

test('Independent finance: saved command replay and account scope persist across app reconstruction and fresh login', async t => {
  const f = await setup(t), c = await account(f, 'company', 'QAR', '20'), p = await account(f, 'personal'), key = randomUUID();
  const transfer = { action: 'transfer', fromAccountId: c.id, toAccountId: p.id, transferredOn: '2026-10-16', amount: '5', reference: 'SYNTHETIC-RESTART-TRANSFER' };
  const first = await command(f, 'company-finance', transfer, key); f.rebuildApplication(); await f.login();
  const replay = await command(f, 'company-finance', transfer, key); assert.equal(replay.replay, true); assert.deepEqual(replay.data, first.data);
  assert.equal((await view(f, 'company-finance')).totals[0].balance, '15'); assert.equal((await view(f, 'personal-finance')).totals[0].balance, '5');
  assert.equal((await view(f, 'company-finance')).totals[0].receipts, '0');
});

test('Independent compatibility: Staff006 and scoped finance work without Car007; car route fails closed; missing CSRF denies commands', async t => {
  const f = await setup(t, false); await account(f, 'company'); await account(f, 'personal');
  await view(f, 'staff-collections'); await view(f, 'company-finance'); await view(f, 'personal-finance');
  await result(await f.request('GET', base + '/staff-collections/receipts?asOf=2026-10-31'));
  await result(await f.request('GET', base + '/car-rentals?month=2026-10&asOf=2026-10-31'), 503);
  await result(await f.request('POST', base + '/personal-finance/commands', { action: 'create-account' }, { 'Idempotency-Key': randomUUID(), 'X-Hamdee-CSRF': '' }), 403, 'CSRF_REJECTED');
});
