// Synthetic, repeatable demonstration commands. Never reads a client export,
// environment variable, real account or hosted connection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
// The same synthetic command list can use a local fixture or a separately
// reviewed, owner-authenticated managed-provider API transport. This interface
// performs no network/auth/database construction and accepts no credentials.
export interface DemoCommandTransport {
  login(): Promise<unknown>;
  request(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}
// Dynamic API record views are intentionally used by this test-owned seeder.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
export const DEMO_PERIOD = { month: '2026-10', asOf: '2026-10-31' };
export function demoKey(label: string) {
  const h = createHash('sha256').update('HAMDEE-ISOLATED-DEMO-v1:' + label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export async function seedDemoDataset(f: DemoCommandTransport) {
  await f.login();
  const write = async (module: string, label: string, body: Row, status = 200) => {
    const response = await f.request('POST', '/api/hamdee/v1/' + module, body, { 'Idempotency-Key': demoKey(label) });
    const result = await response.json(); assert.equal(response.status, status, label + ': ' + JSON.stringify(result));
    return result.data as Row;
  };
  const rental = (label: string, body: Row) => write('rental', label, body);
  const staff = (label: string, body: Row) => write('staff-collections/commands', label, body);
  const car = (label: string, body: Row) => write('car-rentals/commands', label, body);
  const finance = (label: string, body: Row, personal = false) => write((personal ? 'personal' : 'company') + '-finance/commands', label, body);
  const expense = (label: string, body: Row) => write('expenses', label, body);
  const partner = (label: string, body: Row) => write('partners/commands', label, body, 201);
  const property = await write('properties', 'villa', { name: 'DEMO Villa — training only', location: 'DEMO synthetic location; no client records' }, 201);
  const rooms: Row[] = [], tenants: Row[] = [], agreements: Row[] = [], dues: Row[] = [], receipts: Row[] = [];
  for (let i = 1; i <= 3; i++) {
    const room = await rental('room-' + i, { action: 'create-room', propertyId: property.id, code: 'DEMO-' + String(i).padStart(2, '0'), label: 'DEMO room ' + i }); rooms.push(room);
    const tenant = await rental('tenant-' + i, { action: 'create-tenant', name: 'DEMO Resident ' + i, email: 'resident' + i + '@example.invalid', notes: 'DEMO synthetic contact, not a client' }); tenants.push(tenant);
    const agreement = await rental('agreement-' + i, { action: 'create-agreement', roomId: room.id, tenantId: tenant.id, monthlyRent: '1000', currency: 'XTS', depositRequired: '500', dueTerms: 'DEMO explicitly due on 5 October; no proration', startDate: '2026-10-01', endDate: '2026-10-31' }); agreements.push(agreement);
    const due = await rental('due-' + i, { action: 'issue-due', agreementId: agreement.id, period: '2026-10', dueDate: '2026-10-05', amount: '1000' }); dues.push(due);
    if (i <= 2) receipts.push(await rental('rent-' + i, { action: 'record-collection', agreementId: agreement.id, kind: 'rent', amount: i === 1 ? '1000' : '400', method: 'cash', receivedDate: '2026-10-05', reference: 'DEMO-RENT-' + i, allocations: [{ dueId: due.id, amount: i === 1 ? '1000' : '400' }] }));
  }
  // A separate historical-only example demonstrates that an October source
  // occupant does not establish current tenancy or generate agreements/dues.
  rooms.push(await rental('historical-room', { action: 'create-room', propertyId: property.id, code: 'DEMO-04', label: 'DEMO historical snapshot; current occupancy not verified' }));
  tenants.push(await rental('historical-tenant', { action: 'create-tenant', name: 'DEMO Historical Resident', email: 'historical@example.invalid',
    notes: 'October2026 source snapshot only. Occupancy and agreement terms unverified. DEMO Villa — training only / DEMO-04 (SL 1, PDF p1; AMOUNT=1000; R DATE=5). Raw tenant field: DEMO Historical Resident' }));
  await rental('advance', { action: 'record-collection', agreementId: agreements[0].id, kind: 'advance', amount: '200', method: 'bank', receivedDate: '2026-10-06', reference: 'DEMO-UNALLOCATED-ADVANCE' });
  await rental('deposit', { action: 'record-collection', agreementId: agreements[0].id, kind: 'deposit', amount: '500', method: 'bank', receivedDate: '2026-10-06', reference: 'DEMO-SECURITY-DEPOSIT-NOT-INCOME' });
  await rental('cheque', { action: 'record-collection', agreementId: agreements[2].id, kind: 'rent', amount: '600', method: 'cheque', receivedDate: '2026-10-07', reference: 'DEMO-PENDING-CHEQUE-NOT-CLEARED' });
  const collectors: Row[] = [];
  for (const name of ['North', 'South']) collectors.push(await staff('collector-' + name, { action: 'create-collector', name: 'DEMO Collector ' + name, notes: 'DEMO contact only; no staff login' }));
  const accounts: Row[] = [];
  for (const scope of ['company', 'personal']) for (const kind of ['cash', 'bank']) accounts.push(await finance('account-' + scope + '-' + kind, { action: 'create-account', name: `DEMO ${scope} ${kind} — XTS only`, scope, kind, currency: 'XTS', openingDate: '2026-10-01', openingAmount: '0', ownerConfirmedOpening: true, notes: 'DEMO explicit zero; not a verified business balance or bank account' }, scope === 'personal'));
  for (let i = 0; i < receipts.length; i++) await staff('rent-custody-' + i, { action: 'record-collection', collectorId: collectors[i].id, sourceKind: 'property-rent', sourceId: receipts[i].id, disposition: 'collector-held', ownerConfirmedDisposition: true, notes: 'DEMO source-linked rent custody' });
  const vehicles: Row[] = [], carAgreements: Row[] = [], carReceipts: Row[] = [];
  for (const [i, model] of ['Yaris', 'Camry', 'Corolla'].entries()) {
    const v = await car('vehicle-' + model, { action: 'create-vehicle', registration: 'DEMO-ONLY-' + (i + 1), make: 'DEMO Toyota', model, status: 'active', notes: 'DEMO synthetic registration; not a real vehicle' }); vehicles.push(v);
    const a = await car('car-agreement-' + model, { action: 'create-agreement', vehicleId: v.id, agreementKey: demoKey('car-term-' + model), customerName: 'DEMO Driver ' + (i + 1), customerContact: 'driver' + (i + 1) + '@example.invalid', startDate: '2026-10-01', endDate: '2026-10-31', agreedAmount: '1200', currency: 'XTS', billingPeriod: 'DEMO explicit whole-term amount', notes: 'DEMO no proration or guarantee' }); carAgreements.push(a);
    if (i < 2) carReceipts.push(await car('car-receipt-' + model, { action: 'record-collection', agreementId: a.id, receiptKey: demoKey('car-receipt-key-' + model), receivedDate: '2026-10-08', amount: i === 0 ? '1200' : '500', currency: 'XTS', method: i === 0 ? 'cash' : 'bank', reference: 'DEMO-CAR-' + model }));
    await car('vehicle-expense-' + model, { action: i === 0 ? 'record-maintenance' : 'record-expense', vehicleId: v.id, expenseKey: demoKey('car-expense-key-' + model), expenseDate: '2026-10-09', amount: '50', currency: 'XTS', description: 'DEMO maintenance/service ' + model, vendorName: 'DEMO Vehicle service vendor', reference: 'DEMO-SERVICE-' + model });
  }
  await staff('car-custody', { action: 'record-collection', collectorId: collectors[0].id, sourceKind: 'car-rental', sourceId: carReceipts[0].id, disposition: 'collector-held', ownerConfirmedDisposition: true });
  await finance('car-direct-bank', { action: 'receive', accountId: accounts[1].id, sourceKind: 'car-rental', sourceId: carReceipts[1].id, ownerConfirmedDisposition: true });
  await staff('handover-partial', { action: 'handover', collectorId: collectors[0].id, accountId: accounts[0].id, amount: '1500', currency: 'XTS', handedOn: '2026-10-10', reference: 'DEMO-PARTIAL-HANDOVER' });
  await staff('handover-full', { action: 'handover', collectorId: collectors[1].id, accountId: accounts[0].id, amount: '400', currency: 'XTS', handedOn: '2026-10-10', reference: 'DEMO-FULL-HANDOVER' });
  const personalReceipt = await finance('personal-income-source', { action: 'create-classified-receipt', receiptKey: demoKey('personal-receipt'), classification: 'DEMO-personal-income', receivedOn: '2026-10-10', amount: '300', currency: 'XTS', method: 'cash', reference: 'DEMO-PERSONAL-INCOME', notes: 'DEMO source, explicitly personal; not company income' }, true);
  await finance('personal-income', { action: 'receive', accountId: accounts[2].id, sourceKind: 'classified-receipt', sourceId: personalReceipt.id, ownerConfirmedDisposition: true }, true);
  await finance('company-transfer', { action: 'transfer', fromAccountId: accounts[0].id, toAccountId: accounts[1].id, transferredOn: '2026-10-11', amount: '500', reference: 'DEMO-COMPANY-CASH-TO-BANK' });
  await finance('personal-transfer', { action: 'transfer', fromAccountId: accounts[2].id, toAccountId: accounts[3].id, transferredOn: '2026-10-11', amount: '100', reference: 'DEMO-PERSONAL-CASH-TO-BANK' }, true);
  await finance('company-cost', { action: 'expense', accountId: accounts[0].id, expenseKey: demoKey('company-cost-key'), paidOn: '2026-10-12', amount: '100', reference: 'DEMO-OFFICE-COST', notes: 'DEMO company-only office supplies; separate from property costs' });
  await finance('personal-cost', { action: 'expense', accountId: accounts[2].id, expenseKey: demoKey('personal-cost-key'), paidOn: '2026-10-12', amount: '25', reference: 'DEMO-PERSONAL-COST' }, true);
  for (const [category, amount] of [['landlord', '500'], ['kahramaa', '100'], ['wifi_utilities', '60'], ['cleaning', '40']]) await expense('property-cost-' + category, { action: 'record-expense', propertyId: property.id, category, expenseDate: '2026-10-12', amount, currency: 'XTS', vendorName: 'DEMO ' + category + ' vendor', reference: 'DEMO-INVOICE-' + category, notes: 'DEMO property cost; no duplicate company-ledger posting', payment: { method: 'cash', amount, paymentDate: '2026-10-12', reference: 'DEMO-PAID-' + category } });
  const job = await expense('maintenance-job', { action: 'create-job', propertyId: property.id, roomId: rooms[0].id, workType: 'DEMO AC service', issue: 'DEMO scheduled filter replacement', openedDate: '2026-10-11', vendorName: 'DEMO Maintenance vendor' });
  await expense('maintenance-complete', { action: 'complete-job', jobId: job.id, expectedVersion: 1, completedDate: '2026-10-12', workCompleted: 'DEMO filter replaced', actualCost: '75', currency: 'XTS', warrantyStartDate: '2026-10-12', warrantyEndDate: '2026-11-12', reference: 'DEMO-MAINTENANCE-ONCE', payment: { method: 'cash', amount: '75', paymentDate: '2026-10-12', reference: 'DEMO-MAINTENANCE-PAID' } });
  const investor = await partner('partner', { action: 'create-partner', name: 'DEMO Investor', email: 'investor@example.invalid', notes: 'DEMO contribution history only, no profit or returns' });
  await partner('partner-link', { action: 'link-property', propertyId: property.id, partnerId: investor.id, notes: 'DEMO property link' });
  for (const [kind, amount, entryDate] of [['contribution', '5000', '2026-10-01'], ['withdrawal', '500', '2026-10-15']]) await partner('partner-' + kind, { action: 'record-entry', partnerId: investor.id, propertyId: property.id, kind, amount, currency: 'XTS', entryDate, reference: 'DEMO-PARTNER-' + kind, notes: 'DEMO explicit movement; not income or distributable profit' });
  return { property, rooms, tenants, agreements, dues, receipts, collectors, accounts, vehicles, carAgreements, carReceipts, investor, job };
}

export async function demoOverview(f: DemoCommandTransport, module: string) {
  const response = await f.request('GET', `/api/hamdee/v1/${module}?month=${DEMO_PERIOD.month}&asOf=${DEMO_PERIOD.asOf}`);
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.data as Row;
}
