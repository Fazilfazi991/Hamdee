'use strict';
const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { M, fixture, receipt, expense, payment, reportHarness } = require('./agent4-support.cjs');
const range = (start, end) => ({ 'report-start': start, 'report-end': end });
const total = (report, col) => M.sum(report.rows, row => row[report.cols.indexOf(col)]);

describe('Agent 4: actual report function controls (no DOM or export rendering)', () => {
  test('[CONTROL] transaction date boundaries are inclusive and exclude adjacent days', () => {
    const s = fixture(); s.collections = [];
    for (const [date, amount] of [['2026-09-30', 10], ['2026-10-01', 20], ['2026-10-31', 30], ['2026-11-01', 40]]) {
      M.recordCollection(s, receipt({ date, amount }));
    }
    const report = reportHarness(s).report('rent-collection', range('2026-10-01', '2026-10-31'));
    assert.deepEqual(report.rows.map(r => r[0]), ['2026-10-01', '2026-10-31']);
    assert.equal(total(report, 'Amount'), 50);
  });
  test('[CONTROL] property, tenant, method and category filters apply to report rows', () => {
    const s = fixture(); M.recordCollection(s, receipt({ mode: 'Bank Transfer', amount: 70 }));
    const harness = reportHarness(s), base = range('2026-10-01', '2026-10-31');
    const report = harness.report('rent-collection', { ...base, 'report-property': 'qa-p', 'report-tenant': 'qa-t', 'report-mode': 'Bank Transfer', 'report-category': 'Partial Payment' });
    assert.equal(report.rows.length, 1); assert.equal(total(report, 'Amount'), 70);
    assert.equal(harness.report('rent-collection', { ...base, 'report-property': 'qa-unmatched' }).rows.length, 0);
  });
  test('[CONTROL] cash flow includes additional expense once and excludes noncash movements', () => {
    const s = fixture();
    M.addAdditional(s, { layer: 'Property', pid: 'qa-p', kind: 'Expense', amount: 35, date: '2026-10-06', description: 'Synthetic expense', mode: 'Cash' });
    M.recordCollection(s, receipt({ kind: 'Adjustment', mode: 'Adjustment', amount: 100 }));
    M.recordCollection(s, receipt({ kind: 'Carry Forward / Rolling', mode: 'Carry Forward / Rolling', amount: 100, toPeriod: '2026-11' }));
    const report = reportHarness(s).report('cash-flow', range('2026-10-01', '2026-10-31'));
    assert.equal(total(report, 'Money in'), 600); assert.equal(total(report, 'Money out'), 135);
    assert.equal(report.rows.length, 3);
  });
  test('[CONTROL] annual operating income separates capital and internal fees', () => {
    const s = fixture(); s.collections[0].mode = 'Bank Transfer';
    const audit = reportHarness(s).audit('2026');
    assert.equal(audit.totals['Total bank income'], 600);
    assert.equal(audit.totals['Capital contributions'], 2000);
    assert.equal(audit.totals['Company service income'], 500);
  });
  test('[CONTROL] full-month property report reconciles to actual model totals', () => {
    const s = fixture(), report = reportHarness(s).report('property-profit', range('2026-10-01', '2026-10-31'));
    assert.equal(total(report, 'Net return'), M.totals(s, '2026-10').net);
    assert.equal(total(report, 'Recognized income'), 600);
    assert.equal(total(report, 'Operating expenses'), 100);
  });
  test('[CONTROL] cheque register uses instrument date, not collection period', () => {
    const s = fixture(); M.createCheque(s, { pid: 'qa-p', tid: 'qa-t', period: '2026-12', date: '2026-10-06', amount: 10, number: 'QA-CUTOFF', bank: 'Synthetic bank' });
    const h = reportHarness(s);
    assert.equal(h.report('cheque', range('2026-10-01', '2026-10-31')).rows.length, 1);
    assert.equal(h.report('cheque', range('2026-12-01', '2026-12-31')).rows.length, 0);
  });
});

describe('Agent 4: report cutoff defects/limitations, not financial acceptance', () => {
  test('[KNOWN R01] mid-month profit includes later same-month receipts and expenses', () => {
    const s = fixture(); M.recordCollection(s, receipt({ date: '2026-10-31', amount: 100 }));
    M.addExpense(s, expense({ date: '2026-10-31', amount: 25 }));
    const h = reportHarness(s), cutoff = range('2026-10-01', '2026-10-07');
    assert.equal(total(h.report('rent-collection', cutoff), 'Amount'), 600);
    const profit = h.report('property-profit', cutoff);
    assert.equal(total(profit, 'Recognized income'), 700);
    assert.equal(total(profit, 'Operating expenses'), 125);
    assert.equal(total(profit, 'Net return'), 525);
  });
  test('[KNOWN R02] October period includes January-posted receipt; dated report excludes it', () => {
    const s = fixture(); M.recordCollection(s, receipt({ date: '2027-01-01', amount: 100 }));
    const h = reportHarness(s), cutoff = range('2026-10-01', '2026-10-31');
    assert.equal(total(h.report('property-income', cutoff), 'Received'), 700);
    assert.equal(total(h.report('rent-collection', cutoff), 'Amount'), 600);
  });
  test('[KNOWN R03] October settlement report includes later payment and changes historic payable', () => {
    const s = fixture(), st = M.generateSettlement(s, { pid: 'qa-p', period: '2026-10' });
    M.payPartner(s, payment(st, { date: '2027-01-01', amount: 100 }));
    const h = reportHarness(s), cutoff = range('2026-10-01', '2026-10-31');
    const settlement = h.report('partner-settlement', cutoff);
    assert.equal(total(settlement, 'Paid'), 100); assert.equal(total(settlement, 'Payable'), 350);
    assert.equal(total(h.report('cash-flow', cutoff), 'Money out'), 100);
  });
  test('[KNOWN R04] selected-period dashboard payable includes other-period settlements and future payments', () => {
    const s = fixture(); M.recordCollection(s, receipt({ period: '2026-11', amount: 600 }));
    const st = M.generateSettlement(s, { pid: 'qa-p', period: '2026-11' });
    assert.equal(M.totals(s, '2026-10').payable, 550);
    M.payPartner(s, payment(st, { date: '2027-01-01', amount: 100 }));
    assert.equal(M.totals(s, '2026-10').payable, 450);
    assert.equal(M.partnerStats(s, 'qa-a').paid, 100);
  });
  test('[KNOWN R05] reversed within-month range still produces monthly profit rows', () => {
    const h = reportHarness(fixture()), cutoff = range('2026-10-20', '2026-10-10');
    assert.equal(h.report('rent-collection', cutoff).rows.length, 0);
    assert.equal(h.report('property-profit', cutoff).rows.length, 1);
  });
  test('[KNOWN R06] multi-year periods silently stop at 60 months', () => {
    const months = reportHarness(fixture()).periods('2020-01-01', '2026-12-31');
    assert.equal(months.length, 60); assert.equal(months.at(-1), '2024-12');
  });
  test('[KNOWN R07] annual cutoff remains fixed demo date and includes full October fee', () => {
    const s = fixture(); M.recordCollection(s, receipt({ date: '2026-10-08', amount: 100 }));
    const audit = reportHarness(s).audit('2026');
    assert.equal(audit.end, '2026-10-07'); assert.equal(audit.totals['Property rental income'], 600);
    assert.equal(audit.totals['Company service income'], 500);
  });
  test('[KNOWN R08] annual operating-expense label includes capital costs excluded from profit', () => {
    const s = fixture(); M.addExpense(s, expense({ amount: 250, classification: 'Capital' }));
    assert.equal(M.financial(s, 'qa-p', '2026-10').expense, 100);
    assert.equal(reportHarness(s).audit('2026').totals['Property operating expenses'], 350);
  });
  test('[KNOWN R09] vacated tenant still reports original deposit held without refund ledger', () => {
    const s = fixture(); M.saveTenant(s, { ...s.tenants[0], status: 'Vacated' }, 'qa-t');
    const report = reportHarness(s).report('deposit', range('2026-10-01', '2026-10-31'));
    assert.equal(total(report, 'Deposit held'), 1000);
    assert.equal(report.rows.length, 1);
  });
});
