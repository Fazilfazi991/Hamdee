// TASK 002: characterization only. This file deliberately reproduces unsafe
// demo behavior; passing these checks is NOT production financial acceptance.
// Run the existing control suite separately: node scripts/hamdee-crm/model.test.cjs
// Run this suite: node --test scripts/hamdee-crm/production-baseline.test.cjs
// No network, storage, credentials, or hosted records are used.
// When an approved fix lands, convert its characterization into an acceptance
// invariant. Do not preserve the unsafe output as a product requirement.
'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const M = require('./reference/model.cjs');

const BASELINE_REVISION = '79525ec84eeed7e2bb7a6f3526bf142dde4cf175';
process.stdout.write(`HAMDEE characterization baseline: ${BASELINE_REVISION}\n`);
process.stdout.write('PRODUCTION READINESS: BLOCKED. Known-defect assertions confirm existing behavior, not correctness.\n');

const collection = (overrides = {}) => ({
  pid: 'p3', tid: 't3', period: M.PERIOD, date: M.TODAY,
  amount: 100, mode: 'Cash', kind: 'Partial Payment',
  by: 'Synthetic baseline test', ref: 'SYNTHETIC-BASELINE', ...overrides
});

describe('Known defects and limitations: reproducible characterization, not acceptance', () => {
  test('[KNOWN DEFECT] agreement edit changes a past receivable', () => {
    const s = M.seed(), tenant = s.tenants.find(t => t.id === 't1');
    const historicalDue = M.expected(s, 'p1', '2026-05');
    M.saveTenant(s, { ...tenant, rent: 10000 }, tenant.id);
    assert.equal(historicalDue, 9000);
    assert.equal(M.expected(s, 'p1', '2026-05'), 10000);
    assert.notEqual(M.expected(s, 'p1', '2026-05'), historicalDue);
  });

  test('[KNOWN DEFECT] vacating an agreement erases a past obligation', () => {
    const s = M.seed(), tenant = s.tenants.find(t => t.id === 't1');
    const historicalDue = M.expected(s, 'p1', '2026-05');
    const historicalReceived = M.received(s, 'p1', '2026-05');
    M.saveTenant(s, { ...tenant, status: 'Vacated' }, tenant.id);
    assert.equal(historicalDue, 9000);
    assert.equal(M.expected(s, 'p1', '2026-05'), 0);
    assert.equal(M.received(s, 'p1', '2026-05'), historicalReceived);
  });

  test('[KNOWN LIMITATION] two agreements in one month select only the first', () => {
    const s = M.seed(), tenant = s.tenants.find(t => t.id === 't1');
    M.saveTenant(s, { ...tenant, end: '2026-10-10' }, tenant.id);
    const successor = M.saveTenant(s, {
      ...tenant, name: 'Synthetic successor', start: '2026-10-11',
      end: '2027-10-10', rent: 12000
    });
    const octoberAgreements = s.tenants.filter(t => t.pid === 'p1'
      && t.start <= '2026-10-31' && t.end >= '2026-10-01');
    assert.equal(octoberAgreements.length, 2);
    assert.notEqual(successor.id, tenant.id);
    assert.equal(M.activeTenant(s, 'p1', M.PERIOD).id, tenant.id);
    assert.equal(M.expected(s, 'p1', M.PERIOD), 9000);
    // No replacement amount is prescribed: proration/cadence requires approval.
  });

  test('[KNOWN DEFECT] advance has no separate future-credit allocation', () => {
    const s = M.seed(), before = M.financial(s, 'p1', M.PERIOD);
    const futureBalance = M.balance(s, 'p1', '2026-11');
    const receipt = M.recordCollection(s, collection({
      pid: 'p1', tid: 't1', amount: 18000, kind: 'Advance'
    }));
    assert.equal(receipt.kind, 'Advance');
    assert.equal(before.received, 9000);
    assert.equal(M.received(s, 'p1', M.PERIOD), 27000);
    assert.equal(M.financial(s, 'p1', M.PERIOD).net, before.net + 18000);
    assert.equal(M.balance(s, 'p1', '2026-11'), futureBalance);
    assert.equal(futureBalance, 9000);
    // Recognition timing and credit-application rules remain undecided.
  });

  test('[KNOWN DEFECT] cheque clears after the period is already fully paid', () => {
    const s = M.seed();
    assert.equal(M.balance(s, 'p1', M.PERIOD), 0);
    const cheque = M.createCheque(s, {
      pid: 'p1', tid: 't1', period: M.PERIOD, date: M.TODAY,
      amount: 9000, number: 'SYNTHETIC-EXCESS', bank: 'Synthetic Bank'
    });
    M.chequeStatus(s, cheque.id, 'Deposited');
    M.chequeStatus(s, cheque.id, 'Cleared');
    assert.equal(M.received(s, 'p1', M.PERIOD), 18000);
    assert.equal(M.balance(s, 'p1', M.PERIOD), 0);
    assert.equal(M.expected(s, 'p1', M.PERIOD), 9000);
    // Clearance may be legitimate; excess must not silently become allocated rent.
  });

  test('[KNOWN DEFECT] future contribution changes past contribution shares', () => {
    const s = M.seed(), property = s.properties.find(p => p.id === 'p1');
    M.saveShares(s, property.id, property.partners.map(p => ({ ...p })), 'Contribution');
    const before = M.financial(s, property.id, '2026-05').shares;
    M.addInvestment(s, {
      pid: property.id, partnerId: 'a1', date: '2026-12-01',
      amount: 180000, type: 'Additional contribution'
    });
    const after = M.financial(s, property.id, '2026-05').shares;
    assert.equal(before.find(p => p.id === 'a1').share, 50);
    assert.equal(after.find(p => p.id === 'a1').share, 75);
    assert.notDeepEqual(after, before);
  });

  test('[KNOWN DEFECT] replaying the same receipt payload inserts twice', () => {
    const s = M.seed(), payload = collection();
    const before = M.received(s, payload.pid, payload.period);
    const first = M.recordCollection(s, { ...payload });
    const replay = M.recordCollection(s, { ...payload });
    assert.notEqual(first.id, replay.id);
    assert.equal(s.collections.filter(c => c.ref === payload.ref).length, 2);
    assert.equal(M.received(s, payload.pid, payload.period), before + 200);
    // A reference alone is not declared universally unique; identity is a policy gate.
  });

  test('[KNOWN DEFECT] manual expense can duplicate maintenance-generated cost', () => {
    const s = M.seed(), before = M.financial(s, 'p3', M.PERIOD).expense;
    M.updateJob(s, 'j2', {
      vid: 'v3', cost: 450, status: 'Completed', completed: M.TODAY,
      warrantyDays: 30, invoice: 'SYNTHETIC-INVOICE'
    });
    const job = s.jobs.find(j => j.id === 'j2');
    assert.ok(job.expenseId);
    M.addExpense(s, {
      layer: 'Property', pid: 'p3', date: M.TODAY, category: 'Maintenance',
      classification: 'Operating', paidBy: 'Synthetic test', amount: 450,
      ref: 'SYNTHETIC-INVOICE', notes: 'Synthetic duplicate of the same work'
    });
    assert.equal(M.financial(s, 'p3', M.PERIOD).expense, before + 900);
    assert.equal(s.expenses.filter(e => e.ref === 'SYNTHETIC-INVOICE').length, 2);
  });

  test('[KNOWN LIMITATION] cash-at-confirmation guard remains stale after receipt', () => {
    const s = M.seed();
    s.settlements = s.settlements.filter(st => st.pid !== 'p3');
    s.properties.find(p => p.id === 'p3').incomeBasis = 'Accrual';
    const settlement = M.generateSettlement(s, { pid: 'p3', period: M.PERIOD });
    M.recordCollection(s, collection({ amount: 1500 }));
    const current = M.financial(s, 'p3', M.PERIOD);
    assert.equal(settlement.cash, 6500);
    assert.equal(current.received, 8000);
    assert.equal(settlement.net, 6600);
    assert.equal(current.received - current.expense - current.charge, settlement.net);
    assert.throws(() => M.payPartner(s, {
      sid: settlement.id, partnerId: settlement.allocations[0].partnerId,
      amount: 100, date: M.TODAY, action: 'Partial Payment', mode: 'Bank Transfer'
    }), /available cash/);
  });

  test('[KNOWN DEFECT] impossible calendar date accepted by the model', () => {
    const s = M.seed();
    const contribution = M.addInvestment(s, {
      pid: 'p1', partnerId: 'a1', date: '2026-02-31',
      amount: 100, type: 'Synthetic date check'
    });
    assert.equal(contribution.date, '2026-02-31');
  });

  test('[KNOWN DEFECT] positive sub-cent input creates a zero monetary entry', () => {
    const s = M.seed();
    const receipt = M.recordCollection(s, collection({ amount: 0.001 }));
    assert.equal(receipt.amount, 0);
    assert.ok(s.collections.some(c => c.id === receipt.id));
  });
});

describe('Decision gates: no financial defaults or acceptance amounts invented', () => {
  test.todo('[DECISION NEEDED] rent cadence, within-month changes, proration and amendment effective dates');
  test.todo('[DECISION NEEDED] advance recognition, unapplied credit, allocation order and refunds');
  test.todo('[DECISION NEEDED] excess cheque receipts, replacement amount differences and allocation');
  test.todo('[DECISION NEEDED] contribution/share effective dates, participation changes and losses');
  test.todo('[DECISION NEEDED] receipt idempotency identity and duplicate invoice scope/exceptions');
  test.todo('[DECISION NEEDED] settlement liquidity, approval, correction and outgoing payment finality');
  test.todo('[DECISION NEEDED] currency, monetary scale, supported bounds and rounding');
  test.todo('[DECISION NEEDED] fee calculation/recognition, vacancy treatment and deposit lifecycle');
});
