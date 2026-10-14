// Characterizations preserve evidence of unsafe demo behavior, NOT acceptance.
// On an approved fix, replace its known-behavior expectation with the approved
// invariant. Do not change product code merely to keep these outputs passing.
'use strict';
const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { M, fixture, receipt, expense, cheque, payment } = require('./agent4-support.cjs');
const period = '2026-10';

describe('Agent 4: existing controls, synthetic fixtures only', () => {
  test('[CONTROL] partial receipts reconcile and excessive normal receipt is atomic', () => {
    const s = fixture();
    M.recordCollection(s, receipt({ amount: 150 }));
    assert.equal(M.received(s, 'qa-p', period), 750);
    assert.equal(M.balance(s, 'qa-p', period), 250);
    const before = structuredClone(s);
    assert.throws(() => M.recordCollection(s, receipt({ amount: 251 })), /exceeds/);
    assert.deepEqual(s, before);
  });
  test('[CONTROL] adjustment and rolling debt change no cash', () => {
    const s = fixture();
    M.recordCollection(s, receipt({ kind: 'Adjustment', mode: 'Adjustment', amount: 100 }));
    M.recordCollection(s, receipt({ kind: 'Carry Forward / Rolling', mode: 'Carry Forward / Rolling', amount: 200, toPeriod: '2026-11' }));
    assert.equal(M.expected(s, 'qa-p', period), 700);
    assert.equal(M.expected(s, 'qa-p', '2026-11'), 1200);
    assert.equal(M.received(s, 'qa-p', period), 600);
    assert.equal(M.balance(s, 'qa-p', period), 100);
  });
  test('[CONTROL] bounced/cancelled cheques create no receipts; finalized action rejects', () => {
    const s = fixture(), c = M.createCheque(s, cheque());
    M.chequeStatus(s, c.id, 'Deposited'); M.chequeStatus(s, c.id, 'Bounced');
    assert.equal(M.received(s, 'qa-p', period), 600);
    M.chequeStatus(s, c.id, 'Cancelled');
    const before = structuredClone(s);
    assert.throws(() => M.chequeStatus(s, c.id, 'Cleared'), /finalized/);
    assert.deepEqual(s, before);
  });
  test('[CONTROL] replacement clears once while original remains finalized', () => {
    const s = fixture(), first = M.createCheque(s, cheque());
    M.chequeStatus(s, first.id, 'Bounced');
    const next = M.createCheque(s, cheque({ number: 'QA-REPLACEMENT' }), first.id);
    M.chequeStatus(s, next.id, 'Deposited'); M.chequeStatus(s, next.id, 'Cleared');
    assert.equal(first.replacementId, next.id); assert.equal(next.originalId, first.id);
    assert.equal(s.collections.filter(r => r.chequeId === next.id).length, 1);
    assert.equal(M.received(s, 'qa-p', period), 1000);
    assert.throws(() => M.chequeStatus(s, next.id, 'Cleared'), /finalized/);
    assert.throws(() => M.chequeStatus(s, first.id, 'Cleared'), /finalized/);
  });
  test('[CONTROL] contribution and company cost stay outside property operating result', () => {
    const s = fixture(), before = M.financial(s, 'qa-p', period);
    M.addInvestment(s, { pid: 'qa-p', partnerId: 'qa-a', amount: 123, date: '2026-10-06' });
    M.addExpense(s, expense({ layer: 'Company', amount: 25 }));
    assert.equal(M.financial(s, 'qa-p', period).net, before.net);
    assert.equal(M.financial(s, 'qa-p', period).invested, 2123);
    assert.equal(M.company(s, period).net, 25);
  });
  test('[CONTROL] maintenance status updates retain one linked cost', () => {
    const s = fixture(), j = M.createJob(s, { pid: 'qa-p', issue: 'Synthetic repair', category: 'General', date: '2026-10-01', vid: 'qa-v', cost: 40 });
    const update = { status: 'Completed', completed: '2026-10-06', vid: 'qa-v', cost: 40, warrantyDays: 30, invoice: 'QA-JOB' };
    M.updateJob(s, j.id, update); M.updateJob(s, j.id, { ...update, status: 'Under Warranty' });
    assert.equal(M.financial(s, 'qa-p', period).expense, 140);
    assert.equal(s.expenses.filter(e => e.id === j.expenseId).length, 1);
    const before = structuredClone(s);
    assert.throws(() => M.updateJob(s, j.id, { ...update, cost: 41 }), /already in/);
    assert.deepEqual(s, before);
  });
  test('[CONTROL] settlement snapshot survives rent, expense, share and fee changes', () => {
    const s = fixture(), st = M.generateSettlement(s, { pid: 'qa-p', period });
    const before = structuredClone(st);
    M.saveTenant(s, { ...s.tenants[0], rent: 1200 }, 'qa-t');
    M.addExpense(s, expense({ amount: 80 }));
    M.saveShares(s, 'qa-p', [{ id: 'qa-a', share: 20 }, { id: 'qa-b', share: 80 }], 'Manual');
    M.saveProperty(s, { ...s.properties[0], charge: 90 }, 'qa-p');
    assert.notEqual(M.financial(s, 'qa-p', period).net, st.net);
    assert.deepEqual(st, before);
    assert.throws(() => M.generateSettlement(s, { pid: 'qa-p', period }), /already exists/);
  });
  test('[CONTROL] carry-forward marks once without cash or new allocation', () => {
    const s = fixture(), st = M.generateSettlement(s, { pid: 'qa-p', period });
    const allocations = structuredClone(st.allocations);
    M.payPartner(s, payment(st, { action: 'Carry Forward' }));
    M.payPartner(s, payment(st, { action: 'Carry Forward' }));
    assert.deepEqual(st.carried, ['qa-a']); assert.deepEqual(st.allocations, allocations);
    assert.equal(s.payments.length, 0); assert.equal(M.settlementDue(s, st), 450);
  });
  test('[CONTROL] partial and final settlement payments reconcile and overpayment rejects atomically', () => {
    const s = fixture(), st = M.generateSettlement(s, { pid: 'qa-p', period });
    M.payPartner(s, payment(st, { amount: 25 }));
    assert.equal(M.settlementDue(s, st), 425);
    M.payPartner(s, payment(st, { amount: 200, action: 'Mark Paid' }));
    const before = structuredClone(s);
    assert.throws(() => M.payPartner(s, payment(st, { amount: 1 })), /exceed/);
    assert.deepEqual(s, before); assert.equal(M.paid(s, st.id, 'qa-a'), 225);
    assert.equal(M.settlementDue(s, st), 225);
  });
  test('[CONTROL] residual allocation conserves cent-sized synthetic amounts', () => {
    for (const amount of [0.01, 0.02, 1.01, 100.01]) {
      const rows = M.allocate(amount, [{ id: 'qa-a', share: 33.33 }, { id: 'qa-b', share: 33.33 }, { id: 'qa-c', share: 33.34 }]);
      assert.equal(M.sum(rows, a => a.amount), amount);
    }
  });
});

describe('Agent 4: known financial defects/limitations, not approved rules', () => {
  for (const [name, changes, due] of [
    ['rent edit', { rent: 1500 }, 1500],
    ['vacation', { status: 'Vacated' }, 0],
    ['start moved forward', { start: '2026-11-01' }, 0],
    ['end moved backward', { end: '2026-09-30' }, 0]
  ]) test(`[KNOWN F01] ${name} rewrites October obligation and leaves receipts`, () => {
    const s = fixture(); assert.equal(M.expected(s, 'qa-p', period), 1000);
    M.saveTenant(s, { ...s.tenants[0], ...changes }, 'qa-t');
    assert.equal(M.expected(s, 'qa-p', period), due);
    assert.equal(M.received(s, 'qa-p', period), 600);
  });
  test('[KNOWN F02] sequential agreements in one month depend on array order', () => {
    const s = fixture(), t = s.tenants[0];
    M.saveTenant(s, { ...t, end: '2026-10-10' }, t.id);
    M.saveTenant(s, { ...t, name: 'Synthetic successor', start: '2026-10-11', end: '2027-12-31', rent: 1500 });
    assert.equal(M.expected(s, 'qa-p', period), 1000);
    s.tenants.reverse(); assert.equal(M.expected(s, 'qa-p', period), 1500);
  });
  test('[KNOWN F03] annual/quarterly preference still generates monthly amount', () => {
    for (const frequency of ['Quarterly', 'Annual']) {
      const s = fixture(); M.saveTenant(s, { ...s.tenants[0], frequency }, 'qa-t');
      assert.equal(M.expected(s, 'qa-p', period), 1000);
      assert.equal(M.expected(s, 'qa-p', '2026-11'), 1000);
    }
  });
  test('[KNOWN F04] advance increases current cash profit without future credit allocation', () => {
    const s = fixture(), before = M.financial(s, 'qa-p', period);
    const r = M.recordCollection(s, receipt({ amount: 2000, kind: 'Advance' }));
    assert.equal(r.kind, 'Advance'); assert.equal(M.received(s, 'qa-p', period), 2600);
    assert.equal(M.financial(s, 'qa-p', period).net, before.net + 2000);
    assert.equal(M.balance(s, 'qa-p', period), 0);
    assert.equal(M.balance(s, 'qa-p', '2026-11'), 1000);
  });
  test('[KNOWN F05] normal payment arriving after cheque deposit does not limit clearance', () => {
    const s = fixture(), c = M.createCheque(s, cheque());
    M.chequeStatus(s, c.id, 'Deposited'); M.recordCollection(s, receipt({ amount: 400 }));
    M.chequeStatus(s, c.id, 'Cleared');
    assert.equal(M.received(s, 'qa-p', period), 1400);
    assert.equal(M.balance(s, 'qa-p', period), 0);
    assert.equal(M.balance(s, 'qa-p', '2026-11'), 1000);
    assert.equal(s.collections.find(r => r.id === c.receiptId).amount, 400);
  });
  test('[KNOWN F06] replacement permits different amount and period without allocation review', () => {
    const s = fixture(), c = M.createCheque(s, cheque());
    const r = M.createCheque(s, cheque({ number: 'QA-DIFFERENT', amount: 1500, period: '2026-11' }), c.id);
    M.chequeStatus(s, r.id, 'Deposited'); M.chequeStatus(s, r.id, 'Cleared');
    assert.equal(c.status, 'Replaced'); assert.equal(M.received(s, 'qa-p', period), 600);
    assert.equal(M.received(s, 'qa-p', '2026-11'), 1500);
    assert.equal(M.balance(s, 'qa-p', '2026-11'), 0);
  });
  test('[KNOWN F07] future capital changes prior contribution allocation, not frozen settlement', () => {
    const s = fixture(); s.properties[0].basis = 'Contribution';
    const st = M.generateSettlement(s, { pid: 'qa-p', period }), before = structuredClone(st);
    M.addInvestment(s, { pid: 'qa-p', partnerId: 'qa-a', amount: 2000, date: '2027-01-01' });
    assert.deepEqual(M.financial(s, 'qa-p', period).shares.map(a => a.share), [75, 25]);
    assert.equal(M.financial(s, 'qa-p', period).invested, 4000);
    assert.deepEqual(st, before);
  });
  test('[KNOWN F08] newly added unfunded participant receives past manual rights', () => {
    const s = fixture(); s.partners.push({ id: 'qa-c', name: 'Synthetic late participant' });
    M.saveShares(s, 'qa-p', [{ id: 'qa-a', share: 40 }, { id: 'qa-b', share: 40 }, { id: 'qa-c', share: 20 }], 'Manual');
    assert.equal(M.financial(s, 'qa-p', period).allocation.find(a => a.partnerId === 'qa-c').amount, 90);
    assert.equal(s.investments.some(i => i.partnerId === 'qa-c'), false);
  });
  test('[KNOWN F09] duplicate receipt and invoice payloads insert twice', () => {
    const s = fixture(), r1 = M.recordCollection(s, receipt()), r2 = M.recordCollection(s, receipt());
    const e1 = M.addExpense(s, expense()), e2 = M.addExpense(s, expense());
    assert.notEqual(r1.id, r2.id); assert.notEqual(e1.id, e2.id);
    assert.equal(M.received(s, 'qa-p', period), 800); assert.equal(M.financial(s, 'qa-p', period).expense, 300);
  });
  test('[KNOWN F10] manual copy of completed maintenance invoice doubles cost', () => {
    const s = fixture(), j = M.createJob(s, { pid: 'qa-p', issue: 'Synthetic duplicate check', category: 'General', date: '2026-10-01', cost: 40, vid: 'qa-v' });
    M.updateJob(s, j.id, { status: 'Completed', completed: '2026-10-06', cost: 40, vid: 'qa-v', invoice: 'QA-JOB' });
    M.addExpense(s, expense({ amount: 40, ref: 'QA-JOB', vid: 'qa-v' }));
    assert.equal(M.financial(s, 'qa-p', period).expense, 180);
    assert.equal(s.expenses.filter(e => e.ref === 'QA-JOB').length, 2);
    assert.ok(j.expenseId);
  });
  test('[KNOWN F11] confirmed accrual cash guard stays stale after remaining rent collected', () => {
    const s = fixture(); s.properties[0].incomeBasis = 'Accrual';
    const st = M.generateSettlement(s, { pid: 'qa-p', period });
    M.recordCollection(s, receipt({ amount: 400 }));
    assert.equal(st.net, 850); assert.equal(st.cash, 600);
    assert.equal(M.financial(s, 'qa-p', period).received, 1000);
    assert.throws(() => M.payPartner(s, payment(st)), /available cash/);
    assert.equal(s.payments.length, 0);
  });
  test('[KNOWN F12] repeated outgoing payment payload consumes entitlement twice', () => {
    const s = fixture(), st = M.generateSettlement(s, { pid: 'qa-p', period });
    const a = M.payPartner(s, payment(st)), b = M.payPartner(s, payment(st));
    assert.notEqual(a.id, b.id); assert.equal(M.paid(s, st.id, 'qa-a'), 200);
    assert.equal(M.settlementDue(s, st), 250);
  });
  test('[KNOWN F13] past fixed charge changes with current property configuration', () => {
    const s = fixture(); assert.equal(M.financial(s, 'qa-p', period).charge, 50);
    M.saveProperty(s, { ...s.properties[0], charge: 75 }, 'qa-p');
    assert.equal(M.financial(s, 'qa-p', period).charge, 75);
    assert.equal(M.company(s, period).serviceIncome, 75);
  });
  test('[KNOWN F14] impossible date and positive sub-cent entry remain accepted', () => {
    const s = fixture();
    const inv = M.addInvestment(s, { pid: 'qa-p', partnerId: 'qa-a', amount: 1, date: '2026-02-31' });
    const r = M.recordCollection(s, receipt({ amount: 0.001 }));
    assert.equal(inv.date, '2026-02-31'); assert.equal(r.amount, 0);
  });
});

describe('Agent 4: financial acceptance still locked', () => {
  for (const gate of [
    'rent cadence, proration and effective-dated amendments',
    'advances, unapplied credit, allocation order and refunds',
    'cheque excess, replacement differences and reversals',
    'participation effective dates, capital returns and losses',
    'receipt/invoice/payment idempotency identity and duplicate exceptions',
    'settlement approval, liquidity, corrections and payment finality',
    'currency, precision, bounds and residual allocation',
    'report date basis/cutoffs, service fees, vacancy and deposit lifecycle'
  ]) test.todo('[DECISION NEEDED] ' + gate);
});
