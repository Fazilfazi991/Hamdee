import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { adapter, up } from './support/fixture';
import { createOwnerQaFixture, seedOwnerAppRecords, OTHER_QA_SUBJECT } from './support/owner-crm-harness';
import type { Database } from '../src/database';

// Independent literal expectations for synthetic posted records. These tests
// establish local behavior, not native connection concurrency or hosted Auth.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Fixture = Awaited<ReturnType<typeof createOwnerQaFixture>>;
const base = '/api/hamdee/v1';
const categories = ['landlord', 'kahramaa', 'wifi_utilities', 'maintenance', 'cleaning', 'miscellaneous'];
async function body(response: Response, expected = 200): Promise<Row> { const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value; }
async function deny(response: Response) { const value = await response.json(); assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(value)); assert.equal(value.data, undefined); }
async function fixture(t: TestContext) { const f = await createOwnerQaFixture(); t.after(() => f.close()); await f.login(); return f; }
const write = (f: Fixture, action: string, fields: Row, key: string = randomUUID(), extra: Record<string, string> = {}) => f.request('POST', base + '/expenses', { action, ...fields }, { 'Idempotency-Key': key, ...extra });
async function create(f: Fixture, action: string, fields: Row, key?: string) { return (await body(await write(f, action, fields, key))).data as Row; }
async function read(f: Fixture, month = '2026-10', asOf = '2026-10-15', propertyId?: string) { return (await body(await f.request('GET', base + '/expenses?month=' + month + '&asOf=' + asOf + (propertyId ? '&propertyId=' + propertyId : '')))).data as Row; }
async function property(f: Fixture, name = 'Synthetic expense QA villa') { return (await body(await f.request('POST', base + '/properties', { name }, { 'Idempotency-Key': randomUUID() }), 201)).data as Row; }
async function room(f: Fixture, propertyId: string, code = 'EXP-01') { return (await body(await f.request('POST', base + '/rental', { action: 'create-room', propertyId, code }, { 'Idempotency-Key': randomUUID() }))).data as Row; }
function expense(propertyId: string, overrides: Row = {}) { return { propertyId, category: 'landlord', expenseDate: '2026-10-05', amount: '1000.00', currency: 'QAR', vendorName: 'Synthetic landlord', vendorContact: 'synthetic-vendor@example.invalid', reference: 'SYNTHETIC-INVOICE-' + randomUUID(), notes: 'Synthetic local expense', ...overrides }; }
async function job(f: Fixture, propertyId: string, overrides: Row = {}) { return create(f, 'create-job', { propertyId, workType: 'AC repair', issue: 'Synthetic leaking AC', openedDate: '2026-10-01', vendorName: 'Synthetic maintenance vendor', vendorContact: 'vendor@example.invalid', ...overrides }); }
function completion(overrides: Row = {}) { return { expectedVersion: 1, completedDate: '2026-10-05', workCompleted: 'Synthetic repair completed', actualCost: '250.00', currency: 'QAR', warrantyStartDate: '2026-10-05', warrantyEndDate: '2026-10-31', reference: 'SYNTHETIC-JOB-' + randomUUID(), ...overrides }; }

test('Expense QA: all six categories retain property, vendor, payment and explicit room allocation', async t => {
  const f = await fixture(t), p = await property(f), r = await room(f, p.id);
  for (const category of categories) await create(f, 'record-expense', expense(p.id, { category, roomId: category === 'maintenance' ? r.id : null, amount: '10.25', payment: { method: 'cash', amount: '5.00', paymentDate: '2026-10-05', reference: 'SYNTHETIC-CASH' } }));
  const state = await read(f); assert.equal(state.expenses.length, 6); assert.equal(state.payments.length, 6);
  assert.deepEqual(new Set(state.expenses.map((e: Row) => e.category)), new Set(categories));
  for (const e of state.expenses) { assert.equal(e.amountMinor, '1025'); assert.equal(e.paidMinor, '500'); assert.equal(e.outstandingMinor, '525'); assert.equal(e.vendorContact, 'synthetic-vendor@example.invalid'); assert.equal(e.propertyId, p.id); }
  assert.equal(state.expenses.find((e: Row) => e.category === 'maintenance').roomId, r.id);
  assert.equal(state.expenses.find((e: Row) => e.category === 'landlord').roomId, null);
});

test('Expense QA: cash and bank partials pay an expense while cheque remains pending with no clearance', async t => {
  const f = await fixture(t), p = await property(f), e = await create(f, 'record-expense', expense(p.id));
  await create(f, 'record-payment', { expenseId: e.id, method: 'cash', amount: '200.00', paymentDate: '2026-10-06' });
  const cheque = await create(f, 'record-payment', { expenseId: e.id, method: 'cheque', amount: '800.00', paymentDate: '2026-10-07', reference: 'SYNTHETIC-CHEQUE' });
  assert.equal(cheque.status, 'pending'); let selected = (await read(f)).expenses[0]; assert.equal(selected.paidMinor, '20000'); assert.equal(selected.pendingChequeMinor, '80000'); assert.equal(selected.outstandingMinor, '80000');
  await create(f, 'record-payment', { expenseId: e.id, method: 'bank', amount: '800.00', paymentDate: '2026-10-08', reference: 'SYNTHETIC-BANK' });
  selected = (await read(f)).expenses[0]; assert.equal(selected.paidMinor, '100000'); assert.equal(selected.outstandingMinor, '0');
  await deny(await write(f, 'record-payment', { expenseId: e.id, method: 'cash', amount: '0.01', paymentDate: '2026-10-09' }));
  await deny(await write(f, 'clear-cheque', { paymentId: cheque.id }));
});

test('Expense QA: duplicate invoice and command replay cannot double expense; same reference elsewhere is independent', async t => {
  const f = await fixture(t), p = await property(f), other = await property(f, 'Synthetic other expense villa'), fields = expense(p.id), key = randomUUID();
  const first = await create(f, 'record-expense', fields, key), replay = await body(await write(f, 'record-expense', fields, key));
  assert.equal(replay.data.id, first.id); assert.equal(replay.replay, true);
  await deny(await write(f, 'record-expense', fields));
  await deny(await write(f, 'record-expense', { ...fields, amount: '1001.00' }, key));
  await create(f, 'record-expense', { ...fields, propertyId: other.id }); assert.equal((await read(f)).expenses.length, 2);
});

test('Expense QA: competing distinct payments cannot exceed an expense and identical concurrent retry saves once', async t => {
  const f = await fixture(t), p = await property(f), e = await create(f, 'record-expense', expense(p.id));
  const fields = { expenseId: e.id, method: 'cash', amount: '600.00', paymentDate: '2026-10-06' };
  let responses = await Promise.all([write(f, 'record-payment', fields), write(f, 'record-payment', fields)]);
  assert.equal(responses.filter(r => r.ok).length, 1); assert.equal(responses.filter(r => r.status >= 400 && r.status < 500).length, 1);
  const key = randomUUID(); responses = await Promise.all([write(f, 'record-payment', { ...fields, amount: '400.00' }, key), write(f, 'record-payment', { ...fields, amount: '400.00' }, key)]);
  const values = await Promise.all(responses.map(r => body(r))); assert.equal(values[0].data.id, values[1].data.id);
  const state = await read(f); assert.equal(state.payments.length, 2); assert.equal(state.expenses[0].paidMinor, '100000');
});

test('Expense QA: rooms must belong to property; archived properties retain records but reject writes', async t => {
  const f = await fixture(t), p = await property(f), other = await property(f, 'Synthetic other room villa'), r = await room(f, other.id);
  await deny(await write(f, 'record-expense', expense(p.id, { roomId: r.id }))); await deny(await write(f, 'create-job', { propertyId: p.id, roomId: r.id, workType: 'AC', issue: 'Synthetic issue', openedDate: '2026-10-01' }));
  const e = await create(f, 'record-expense', expense(p.id)), j = await job(f, p.id), before = await read(f);
  await body(await f.request('POST', base + '/properties/' + p.id + '/archive', { reason: 'Synthetic expense archive' }, { 'Idempotency-Key': randomUUID(), 'If-Match': `"property:${p.id}:1"` }));
  await deny(await write(f, 'record-expense', expense(p.id))); await deny(await write(f, 'record-payment', { expenseId: e.id, method: 'cash', amount: '1.00', paymentDate: '2026-10-10' }));
  await deny(await write(f, 'complete-job', { jobId: j.id, ...completion() }));
  const after = await read(f); assert.deepEqual(after.expenses, before.expenses); assert.deepEqual(after.jobs, before.jobs);
});

test('Expense QA: maintenance completion creates one cost expense, immutable cost and attributable job history', async t => {
  const f = await fixture(t), p = await property(f), r = await room(f, p.id), j = await job(f, p.id, { roomId: r.id });
  const edited = await create(f, 'update-job', { jobId: j.id, expectedVersion: 1, issue: 'Synthetic confirmed fault', vendorName: 'Synthetic chosen vendor', notes: 'Synthetic diagnosis' }); assert.equal(edited.version, 2);
  await deny(await write(f, 'update-job', { jobId: j.id, expectedVersion: 1, notes: 'Synthetic stale edit' }));
  const key = randomUUID(), fields = { jobId: j.id, ...completion({ expectedVersion: 2, payment: { method: 'bank', amount: '100.00', paymentDate: '2026-10-05' } }) };
  const completed = await create(f, 'complete-job', fields, key); assert.equal(completed.status, 'completed'); assert.equal(completed.version, 3); assert.equal(completed.actualCostMinor, '25000'); assert.ok(completed.costExpenseId);
  const replay = await create(f, 'complete-job', fields, key); assert.equal(replay.costExpenseId, completed.costExpenseId);
  await deny(await write(f, 'complete-job', { ...fields, expectedVersion: 3 }));
  await deny(await write(f, 'record-expense', expense(p.id, { category: 'maintenance', maintenanceJobId: j.id })));
  let state = await read(f); assert.equal(state.expenses.length, 1); assert.equal(state.expenses[0].maintenanceJobId, j.id); assert.equal(state.expenses[0].roomId, r.id); assert.equal(state.expenses[0].paidMinor, '10000');
  await create(f, 'update-warranty', { jobId: j.id, expectedVersion: 3, warrantyStartDate: '2026-10-05', warrantyEndDate: '2026-11-30', notes: 'Synthetic revised warranty evidence' });
  state = await read(f); assert.equal(state.expenses[0].amountMinor, '25000'); assert.equal(state.jobs[0].version, 4); assert.ok(state.history.length >= 4);
  await deny(await write(f, 'update-job', { jobId: j.id, expectedVersion: 4, issue: 'Synthetic completed work rewrite' }));
});

test('Expense QA: competing maintenance completions cannot post a second linked cost', async t => {
  const f = await fixture(t), p = await property(f), j = await job(f, p.id), fields = { jobId: j.id, ...completion() };
  const responses = await Promise.all([write(f, 'complete-job', fields), write(f, 'complete-job', fields)]);
  assert.equal(responses.filter(r => r.ok).length, 1); assert.equal(responses.filter(r => r.status >= 400 && r.status < 500).length, 1);
  const state = await read(f); assert.equal(state.expenses.length, 1); assert.equal(state.jobs[0].version, 2); assert.equal(state.jobs[0].costExpenseId, state.expenses[0].id);
});

test('Expense QA: repeated work warns only for matching property/room/type and never waives cost automatically', async t => {
  const f = await fixture(t), p = await property(f), r = await room(f, p.id), r2 = await room(f, p.id, 'EXP-02'), old = await job(f, p.id, { roomId: r.id });
  await create(f, 'complete-job', { jobId: old.id, ...completion() });
  const repeated = await job(f, p.id, { roomId: r.id, workType: ' ac REPAIR ', openedDate: '2026-10-10' });
  const otherRoom = await job(f, p.id, { roomId: r2.id, openedDate: '2026-10-10' });
  const state = await read(f), warning = state.jobs.find((j: Row) => j.id === repeated.id).repeatWarnings;
  assert.equal(warning.length, 1); assert.equal(warning[0].jobId, old.id); assert.equal(warning[0].withinWarranty, true); assert.equal(warning[0].vendorName, 'Synthetic maintenance vendor');
  assert.equal(state.jobs.find((j: Row) => j.id === otherRoom.id).repeatWarnings.length, 0);
  const completed = await create(f, 'complete-job', { jobId: repeated.id, ...completion({ completedDate: '2026-10-11', actualCost: '25.00', warrantyStartDate: null, warrantyEndDate: null }) });
  assert.equal(completed.actualCostMinor, '2500'); assert.equal((await read(f)).expenses.length, 2);
  const expired = await job(f, p.id, { roomId: r.id, openedDate: '2026-11-01' });
  const expiredWarnings = (await read(f)).jobs.find((row: Row) => row.id === expired.id).repeatWarnings;
  assert.equal(expiredWarnings.length, 2); assert.ok(expiredWarnings.every((warning: Row) => warning.withinWarranty === false));
});

test('Expense QA: explicit zero-cost completion and cancellation have no invented charge or warranty waiver', async t => {
  const f = await fixture(t), p = await property(f), j = await job(f, p.id), cancelled = await job(f, p.id, { workType: 'Synthetic painting' });
  assert.equal(j.actualCostMinor, null);
  const done = await create(f, 'complete-job', { jobId: j.id, ...completion({ actualCost: '0.00', warrantyStartDate: null, warrantyEndDate: null }) });
  assert.equal(done.actualCostMinor, '0'); assert.equal(done.status, 'completed');
  const stopped = await create(f, 'cancel-job', { jobId: cancelled.id, expectedVersion: 1, reason: 'Synthetic owner cancelled work' }); assert.equal(stopped.status, 'cancelled');
  await deny(await write(f, 'complete-job', { jobId: cancelled.id, ...completion({ expectedVersion: 2 }) }));
  const state = await read(f); assert.equal(state.payments.length, 0); assert.equal(state.expenses.length, 1); assert.equal(state.expenses[0].amountMinor, '0'); assert.equal(state.expenses[0].id, done.costExpenseId); assert.ok(state.history.length >= 4);
});

test('Expense QA: invalid money, dates, currency, category and incomplete warranty fail without writes', async t => {
  const f = await fixture(t), p = await property(f), j = await job(f, p.id);
  for (const amount of ['0', '-1.00', '1.001', '1e3', 'NaN', '10000000000.00', 1]) await deny(await write(f, 'record-expense', expense(p.id, { amount })));
  for (const overrides of [{ category: 'partner_profit' }, { currency: 'qar' }, { currency: 'QARA' }, { expenseDate: '2026-02-30' }, { expenseDate: '2026-10-05T00:00:00Z' }, { roomId: false }, { roomId: 0 }]) await deny(await write(f, 'record-expense', expense(p.id, overrides)));
  for (const overrides of [{ completedDate: '2026-09-30' }, { warrantyEndDate: null }, { warrantyStartDate: '2026-11-01', warrantyEndDate: '2026-10-31' }, { warrantyStartDate: false, warrantyEndDate: false }, { warrantyStartDate: 0, warrantyEndDate: 0 }]) await deny(await write(f, 'complete-job', { jobId: j.id, ...completion(overrides) }));
  assert.equal((await read(f)).expenses.length, 0); assert.equal((await read(f)).jobs[0].status, 'open');
});

test('Expense QA: future payment remains unpaid in earlier as-of view', async t => {
  const f = await fixture(t), p = await property(f), e = await create(f, 'record-expense', expense(p.id));
  await create(f, 'record-payment', { expenseId: e.id, method: 'bank', amount: '1000.00', paymentDate: '2026-10-31' });
  const earlier = (await read(f)).expenses[0]; assert.equal(earlier.paidMinor, '0'); assert.equal(earlier.outstandingMinor, '100000');
  const later = (await read(f, '2026-10', '2026-10-31')).expenses[0]; assert.equal(later.paidMinor, '100000'); assert.equal(later.outstandingMinor, '0');
});

test('Expense QA: monthly property/category/currency summaries exclude deposits and advances from comparison', async t => {
  const f = await fixture(t), p = await property(f), other = await property(f, 'Synthetic separate summary villa'), r = await room(f, p.id);
  const rentalWrite = async (action: string, fields: Row) => (await body(await f.request('POST', base + '/rental', { action, ...fields }, { 'Idempotency-Key': randomUUID() }))).data as Row;
  const tenant = await rentalWrite('create-tenant', { name: 'Synthetic expense-summary tenant' });
  const agreement = await rentalWrite('create-agreement', { roomId: r.id, tenantId: tenant.id, monthlyRent: '1000.00', currency: 'QAR', depositRequired: '500.00', dueTerms: 'Explicit owner-entered due', startDate: '2026-10-01', endDate: null });
  const due = await rentalWrite('issue-due', { agreementId: agreement.id, period: '2026-10', dueDate: '2026-10-05', amount: '1000.00' });
  await rentalWrite('record-collection', { agreementId: agreement.id, kind: 'rent', method: 'cash', amount: '400.00', receivedDate: '2026-10-05', allocations: [{ dueId: due.id, amount: '400.00' }] });
  await rentalWrite('record-collection', { agreementId: agreement.id, kind: 'deposit', method: 'bank', amount: '500.00', receivedDate: '2026-10-05' });
  await rentalWrite('record-collection', { agreementId: agreement.id, kind: 'advance', method: 'cash', amount: '200.00', receivedDate: '2026-10-05' });
  for (const category of categories) await create(f, 'record-expense', expense(p.id, { category, amount: '10.00', payment: { method: 'cash', amount: '5.00', paymentDate: '2026-10-06' } }));
  const prior = await create(f, 'record-expense', expense(p.id, { expenseDate: '2026-09-05', amount: '50.00' }));
  await create(f, 'record-payment', { expenseId: prior.id, method: 'bank', amount: '25.00', paymentDate: '2026-10-06' });
  await create(f, 'record-expense', expense(p.id, { currency: 'USD', amount: '50.00' }));
  await create(f, 'record-expense', expense(other.id, { category: 'cleaning', amount: '25.00' }));
  await create(f, 'record-expense', expense(p.id, { expenseDate: '2026-10-31', amount: '100.00' }));
  const state = await read(f), selected = state.summary.properties.find((s: Row) => s.propertyId === p.id && s.currency === 'QAR');
  assert.equal(selected.dueMinor, '100000'); assert.equal(selected.collectedMinor, '40000'); assert.equal(selected.outstandingMinor, '60000');
  assert.equal(selected.expenseMinor, '6000'); assert.equal(selected.paidExpenseMinor, '5500'); assert.equal(selected.comparisonMinor, '34000'); assert.equal(selected.depositMinor, '50000'); assert.equal(selected.advanceMinor, '20000');
  assert.equal(selected.categories.length, 6); for (const category of categories) assert.equal(selected.categories.find((c: Row) => c.category === category).amountMinor, '1000');
  const totals = state.summary.currencies.find((s: Row) => s.currency === 'QAR'); assert.equal(totals.expenseMinor, '8500'); assert.equal(totals.comparisonMinor, '31500');
  assert.equal(state.summary.currencies.find((s: Row) => s.currency === 'USD').expenseMinor, '5000');
  const filtered = await read(f, '2026-10', '2026-10-15', p.id); assert.ok(filtered.expenses.every((e: Row) => e.propertyId === p.id)); assert.equal(filtered.summary.currencies.find((s: Row) => s.currency === 'QAR').expenseMinor, '6000');
});

test('Expense QA: owner/MFA/CSRF/expiry/disabled membership and nonowner restrictions apply to expenses', async t => {
  const f = await createOwnerQaFixture(); t.after(() => f.close()); await deny(await f.request('GET', base + '/expenses?month=2026-10&asOf=2026-10-15'));
  await f.login(false); await deny(await f.request('GET', base + '/expenses?month=2026-10&asOf=2026-10-15'));
  await f.login(); const p = await property(f);
  await deny(await write(f, 'record-expense', expense(p.id), randomUUID(), { 'X-Hamdee-CSRF': '' }));
  await deny(await write(f, 'record-expense', expense(p.id), randomUUID(), { Origin: 'https://foreign.example.invalid' })); assert.equal((await read(f)).expenses.length, 0);
  f.clock.advance(f.inputs.idleMilliseconds); await deny(await f.request('GET', base + '/expenses?month=2026-10&asOf=2026-10-15'));
  await f.login(); await f.pg!.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1', [f.member!.id]); await deny(await f.request('GET', base + '/expenses?month=2026-10&asOf=2026-10-15'));
  const other = await createOwnerQaFixture(); t.after(() => other.close()); other.fake.facts.subject = OTHER_QA_SUBJECT;
  await other.auth('GET', 'state'); await deny(await other.auth('POST', 'login', { email: other.inputs.email, password: other.inputs.password }));
});

test('Expense QA: failure after maintenance writes rolls back job, expense, payment and history; same-key retry works', async t => {
  const pg = new PGlite(); t.after(() => pg.close()); await pg.exec(await up()); await seedOwnerAppRecords(pg);
  let inject = false; const actual = adapter(pg), database: Database = { transaction: work => actual.transaction(async sql => {
    let wrote = false; const value = await work({ query: async (query, params) => { if (/\b(?:INSERT|UPDATE|DELETE)\b/i.test(query)) wrote = true; return sql.query(query, params); } });
    if (inject && wrote) throw new Error('SYNTHETIC_EXPENSE_BEFORE_COMMIT_FAILURE'); return value;
  }) };
  const f = await createOwnerQaFixture({ database, pg }); await f.login(); const p = await property(f), j = await job(f, p.id), before = await read(f), key = randomUUID();
  const fields = { jobId: j.id, ...completion({ payment: { method: 'cash', amount: '100.00', paymentDate: '2026-10-05' } }) };
  inject = true; await body(await write(f, 'complete-job', fields, key), 503); inject = false;
  const after = await read(f); assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.expenses, before.expenses); assert.deepEqual(after.payments, before.payments); assert.deepEqual(after.history, before.history);
  await create(f, 'complete-job', fields, key); const retried = await read(f); assert.equal(retried.expenses.length, 1); assert.equal(retried.payments.length, 1); assert.equal(retried.jobs[0].status, 'completed');
});

test('Expense QA: runtime cannot rewrite posted expense/payment/history or skip job revision evidence', async t => {
  const f = await fixture(t), p = await property(f), j = await job(f, p.id);
  await create(f, 'record-expense', expense(p.id, { payment: { method: 'cash', amount: '10.00', paymentDate: '2026-10-05' } })); const before = await read(f);
  for (const statement of ["UPDATE hamdee_private.property_expenses SET amount_minor=1", "UPDATE hamdee_private.expense_payments SET amount_minor=1", "UPDATE hamdee_private.expense_events SET detail='{}'::jsonb", "UPDATE hamdee_private.maintenance_jobs SET notes='Synthetic bypass'", "UPDATE hamdee_private.maintenance_jobs SET version=version+2"]) {
    await assert.rejects(() => f.pg!.transaction(async sql => {
      await sql.exec('SET LOCAL ROLE hamdee_runtime'); await sql.query("SELECT set_config('hamdee.actor',$1,true)", [f.member!.id]); await sql.query(statement);
    }), /permission denied|append.only|immutable|sequential|history|revision/i);
  }
  const after = await read(f); assert.deepEqual(after.expenses, before.expenses); assert.deepEqual(after.payments, before.payments); assert.deepEqual(after.history, before.history); assert.equal(after.jobs.find((row: Row) => row.id === j.id).version, 1);
});

test('Expense QA: runtime cannot complete maintenance by borrowing an unrelated existing expense', async t => {
  const f = await fixture(t), p = await property(f), j = await job(f, p.id), e = await create(f, 'record-expense', expense(p.id)), eventId = randomUUID();
  const before = await read(f);
  await assert.rejects(() => f.pg!.transaction(async sql => {
    await sql.exec('SET LOCAL ROLE hamdee_runtime'); await sql.query("SELECT set_config('hamdee.actor',$1,true)", [f.member!.id]);
    await sql.query("INSERT INTO hamdee_private.expense_events(id,property_id,entity_id,action,detail,actor_id) VALUES($1,$2,$3,'complete-job','{}',$4)", [eventId, p.id, j.id, f.member!.id]);
    await sql.query("UPDATE hamdee_private.maintenance_jobs SET status='completed',version=version+1,work_completed='Synthetic bypass',completed_date='2026-10-05',actual_cost_minor=100000,currency='QAR',cost_expense_id=$2,event_id=$3 WHERE id=$1", [j.id, e.id, eventId]);
  }), /cost|match|expense|maintenance/i);
  const after = await read(f); assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.expenses, before.expenses); assert.deepEqual(after.history, before.history);
});

test('Expense QA: expense/payment/job history survives database close/reopen and a fresh application session', async t => {
  const directory = path.resolve('.test-data', 'expense-qa-' + randomUUID()); await mkdir(directory, { recursive: true }); let pg = new PGlite(directory); let closed = false;
  t.after(async () => { if (!closed) await pg.close(); }); await pg.exec(await up()); await seedOwnerAppRecords(pg);
  const f = await createOwnerQaFixture({ database: adapter(pg), pg }); await f.login(); const p = await property(f), j = await job(f, p.id);
  await create(f, 'complete-job', { jobId: j.id, ...completion({ payment: { method: 'bank', amount: '250.00', paymentDate: '2026-10-05' } }) });
  const before = await read(f); await pg.close(); closed = true; pg = new PGlite(directory); closed = false;
  const reopened = await createOwnerQaFixture({ database: adapter(pg), pg }); await reopened.login(); const after = await read(reopened);
  assert.deepEqual(after.expenses, before.expenses); assert.deepEqual(after.payments, before.payments); assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.history, before.history); assert.deepEqual(after.summary, before.summary);
});

test('Expense QA: additive migration preserves rental obligations and property history without reset', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  for (const file of ['001_property_foundation.up.sql', '002_property_hardening.up.sql', '003_local_rental_operations.up.sql']) await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  await seedOwnerAppRecords(pg); const f = await createOwnerQaFixture({ database: adapter(pg), pg }); await f.login(); const p = await property(f), r = await room(f, p.id);
  const rentalWrite = async (action: string, fields: Row) => (await body(await f.request('POST', base + '/rental', { action, ...fields }, { 'Idempotency-Key': randomUUID() }))).data as Row;
  const tenant = await rentalWrite('create-tenant', { name: 'Synthetic pre-expense-migration tenant' });
  const agreement = await rentalWrite('create-agreement', { roomId: r.id, tenantId: tenant.id, monthlyRent: '1000.00', currency: 'QAR', depositRequired: '0.00', dueTerms: 'Synthetic exact due date', startDate: '2026-10-01', endDate: null });
  await rentalWrite('issue-due', { agreementId: agreement.id, period: '2026-10', dueDate: '2026-10-05', amount: '1000.00' });
  const priorProperty = (await body(await f.request('GET', base + '/properties/' + p.id))).data;
  const priorRental = (await body(await f.request('GET', base + '/rental?month=2026-10&asOf=2026-10-15'))).data;
  await pg.transaction(async tx => tx.exec(await readFile(new URL('../migrations/004_local_property_expenses.up.sql', import.meta.url), 'utf8')));
  assert.deepEqual((await body(await f.request('GET', base + '/properties/' + p.id))).data, priorProperty);
  assert.deepEqual((await body(await f.request('GET', base + '/rental?month=2026-10&asOf=2026-10-15'))).data, priorRental);
  await create(f, 'record-expense', expense(p.id, { roomId: r.id })); assert.equal((await read(f)).expenses.length, 1);
});
