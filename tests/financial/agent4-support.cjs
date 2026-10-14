'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Optional read-only source selection verifies a peer worktree without copying
// its uncommitted files or merging. Both model and report source use one root.
const sourceRoot = path.join(__dirname, 'reference');
const M = require(path.join(sourceRoot, 'model.cjs'));

// Entirely synthetic, independent of the demo seed and TASK 006's untracked files.
// Values describe a test arrangement, never a proposed production policy.
function fixture() {
  return {
    version: 1,
    settings: { currency: 'SYNTHETIC', incomeBasis: 'Cash', shareBasis: 'Manual', role: 'Owner / Admin' },
    properties: [{ id: 'qa-p', name: 'Synthetic property', ref: 'QA-P', location: 'Synthetic location', startDate: '2026-01-01', status: 'Occupied', rent: 1000, charge: 50, chargeMode: 'Fixed', basis: 'Manual', incomeBasis: 'Cash', partners: [{ id: 'qa-a', share: 50 }, { id: 'qa-b', share: 50 }] }],
    partners: [{ id: 'qa-a', name: 'Synthetic A' }, { id: 'qa-b', name: 'Synthetic B' }],
    tenants: [{ id: 'qa-t', pid: 'qa-p', name: 'Synthetic tenant', phone: '000', start: '2026-01-01', end: '2027-12-31', rent: 1000, deposit: 1000, frequency: 'Monthly', status: 'Active' }],
    investments: [{ id: 'qa-i1', pid: 'qa-p', partnerId: 'qa-a', amount: 1000, date: '2026-01-01' }, { id: 'qa-i2', pid: 'qa-p', partnerId: 'qa-b', amount: 1000, date: '2026-01-01' }],
    collections: [{ id: 'qa-r', pid: 'qa-p', tid: 'qa-t', amount: 600, date: '2026-10-05', period: '2026-10', kind: 'Partial Payment', mode: 'Cash', ref: 'QA-INITIAL' }],
    expenses: [{ id: 'qa-e', pid: 'qa-p', layer: 'Property', classification: 'Operating', amount: 100, date: '2026-10-05', category: 'Maintenance', paidBy: 'Synthetic operator', mode: 'Cash' }],
    vendors: [{ id: 'qa-v', name: 'Synthetic vendor' }],
    cheques: [], jobs: [], additional: [], settlements: [], payments: [], documents: []
  };
}

const receipt = (overrides = {}) => ({ pid: 'qa-p', tid: 'qa-t', period: '2026-10', date: '2026-10-06', amount: 100, kind: 'Partial Payment', mode: 'Cash', ref: 'QA-RECEIPT', ...overrides });
const expense = (overrides = {}) => ({ pid: 'qa-p', layer: 'Property', classification: 'Operating', date: '2026-10-06', amount: 100, category: 'Maintenance', paidBy: 'Synthetic operator', mode: 'Cash', ref: 'QA-INVOICE', ...overrides });
const cheque = (overrides = {}) => ({ pid: 'qa-p', tid: 'qa-t', period: '2026-10', date: '2026-10-06', amount: 400, number: 'QA-CHEQUE', bank: 'Synthetic bank', ...overrides });
const payment = (st, overrides = {}) => ({ sid: st.id, partnerId: 'qa-a', amount: 100, date: '2026-10-06', action: 'Partial Payment', mode: 'Cash', ref: 'QA-PAYMENT', ...overrides });

// Execute the real report functions in memory; do not copy or rewrite formulas.
// The exact unique startup anchor is checked so a UI refactor fails visibly.
// This is a report-function harness, not browser/export-file acceptance.
function reportHarness(s) {
  const source = fs.readFileSync(path.join(sourceRoot, 'legacy-app.cjs'), 'utf8');
  const anchor = "  $('#dialog-form').addEventListener('submit', event => {";
  const start = source.indexOf(anchor);
  assert.ok(start > 0, 'Review report harness after app startup changes');
  assert.equal(source.indexOf(anchor, start + anchor.length), -1, 'Ambiguous app startup anchor');
  const context = vm.createContext({
    window: { HamdeeModel: M },
    localStorage: { getItem: () => JSON.stringify(s) },
    document: { querySelector() { throw new Error('Unexpected DOM access in report-function harness'); } },
    structuredClone
  });
  vm.runInContext(source.slice(0, start) + `
    window.Agent4Reports = {
      report(type, options = {}) {
        route = 'reports/' + type; filters = { [route]: options };
        return buildReport(type);
      },
      audit(year) { route = 'audit'; filters = { audit: { 'audit-year': year } }; return auditValues(); },
      periods: periodsInRange
    };
  })();`, context, { filename: 'hamdee-report-functions.qa.js', timeout: 1000 });
  const api = context.window.Agent4Reports;
  // Normalize VM realm objects to make strict comparisons useful.
  return Object.fromEntries(Object.entries(api).map(([key, fn]) => [key, (...args) => JSON.parse(JSON.stringify(fn(...args)))]));
}

module.exports = { M, fixture, receipt, expense, cheque, payment, reportHarness };
