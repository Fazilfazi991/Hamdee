import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../../src/database';
import { StaffCollectionsService } from '../../src/staff-collections';
import { CompanyFinanceService } from '../../src/company-finance';
import { adapter, up } from './fixture';
import { createOwnerQaFixture, ownerQaInputs, seedOwnerAppRecords } from './owner-crm-harness';

// Independent synthetic support. No deployed env mode, provider/account access
// or hosted URL is accepted. New peer SQL may be used only after its freeze.
export const STAFF_BASE = '/api/hamdee/v1/staff-collections';
export const FINANCE_BASE = '/api/hamdee/v1/company-finance';
export type QaRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export async function qaBody(response: Response, expected = 200): Promise<QaRecord> {
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value));
  assert.equal(response.headers.get('cache-control')?.replaceAll(' ', ''), 'private,no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); return value;
}
export async function qaDenied(response: Response) {
  const value = await response.json(); assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(value));
  assert.equal(value.data, undefined); return value;
}
export function assertMajor(actual: unknown, expected: string) {
  const scaled = (value: unknown) => {
    assert.equal(typeof value, 'string'); const match = (value as string).match(/^(-?)(\d+)(?:\.(\d{1,12}))?$/); assert.ok(match);
    return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 1_000_000_000_000n + BigInt((match[3] || '').padEnd(12, '0')));
  };
  assert.equal(scaled(actual), scaled(expected), `Expected exact major-unit amount ${expected}`);
}
export async function createStaffQaFixture(options: {
  directory?: string; initialize?: boolean; additionalFrozenLocalSql?: string; origin?: string;
  decorateDatabase?: (database: Database) => Database;
} = {}) {
  let directory: string | undefined;
  if (options.directory) {
    directory = path.resolve(options.directory); assert.ok(directory.startsWith(path.resolve('.test-data') + path.sep));
    await mkdir(directory, { recursive: true });
  }
  const pg = new PGlite(directory); let closed = false;
  try {
    if (options.initialize !== false) {
      await pg.exec(await up());
      const localSql = options.additionalFrozenLocalSql ?? await readFile(new URL('../../migrations/006_local_operations_records.up.sql', import.meta.url), 'utf8');
      if (!options.additionalFrozenLocalSql) assert.equal(createHash('sha256').update(localSql).digest('hex'), 'd1236225e3f34dcae489d593419f9e6a2999208d45e23e112f2cb4f1e814b0e0');
      await pg.transaction(tx => tx.exec(localSql));
      await seedOwnerAppRecords(pg);
    }
    const inputs = ownerQaInputs();
    const member = (await pg.query<{ id: string; assignment: string }>(
      "SELECT u.id,a.id AS assignment FROM hamdee_private.app_users u JOIN hamdee_private.role_assignments a ON a.user_id=u.id WHERE u.issuer=$1 AND u.subject=$2 AND a.role='admin' AND a.portfolio=true",
      [inputs.issuer, inputs.ownerSubject])).rows[0]; assert.ok(member);
    const database = adapter(pg), f = await createOwnerQaFixture({ database: options.decorateDatabase?.(database) || database, pg, origin: options.origin,
      operationsFactory: properties => ({ staffCollections: new StaffCollectionsService(properties), companyFinance: new CompanyFinanceService(properties) }) });
    return { ...f, pg, member, close: async () => { if (!closed) { closed = true; await f.close(); await pg.close(); } } };
  } catch (error) { await pg.close(); throw error; }
}
export type StaffQaFixture = Awaited<ReturnType<typeof createStaffQaFixture>>;
export const staffWrite = (f: StaffQaFixture, body: QaRecord, key: string = randomUUID(), headers: Record<string, string> = {}) =>
  f.request('POST', STAFF_BASE + '/commands', body, { 'Idempotency-Key': key, ...headers });
export const financeWrite = (f: StaffQaFixture, body: QaRecord, key: string = randomUUID(), headers: Record<string, string> = {}) =>
  f.request('POST', FINANCE_BASE + '/commands', body, { 'Idempotency-Key': key, ...headers });
export const staffRead = async (f: StaffQaFixture, month = '2026-10', asOf = '2026-10-16', collectorId?: string) =>
  (await qaBody(await f.request('GET', STAFF_BASE + '?month=' + month + '&asOf=' + asOf + (collectorId ? '&collectorId=' + collectorId : '')))).data as QaRecord;
export const financeRead = async (f: StaffQaFixture, month = '2026-10', asOf = '2026-10-16', accountId?: string) =>
  (await qaBody(await f.request('GET', FINANCE_BASE + '?month=' + month + '&asOf=' + asOf + (accountId ? '&accountId=' + accountId : '')))).data as QaRecord;

export async function seedPropertyReceipt(f: Pick<StaffQaFixture, 'login' | 'request'>, options: {
  currency?: string; amount?: string; method?: 'cash' | 'bank' | 'cheque';
  kind?: 'rent' | 'deposit' | 'advance'; receivedOn?: string;
} = {}) {
  const currency = options.currency || 'QAR', amount = options.amount || '200.00', method = options.method || 'cash', kind = options.kind || 'rent';
  await f.login(false);
  const property = (await qaBody(await f.request('POST', '/api/hamdee/v1/properties', { name: 'Synthetic staff-source villa ' + randomUUID() }, { 'Idempotency-Key': randomUUID() }), 201)).data;
  const rental = async (body: QaRecord) => (await qaBody(await f.request('POST', '/api/hamdee/v1/rental', body, { 'Idempotency-Key': randomUUID() }))).data as QaRecord;
  const room = await rental({ action: 'create-room', propertyId: property.id, code: 'STAFF-01' });
  const tenant = await rental({ action: 'create-tenant', name: 'Synthetic staff-source tenant', email: 'staff-source@example.invalid' });
  const agreement = await rental({ action: 'create-agreement', roomId: room.id, tenantId: tenant.id, monthlyRent: '1000.00', currency,
    depositRequired: '500.00', dueTerms: 'Explicit synthetic due date', startDate: '2026-10-01', endDate: null });
  const due = await rental({ action: 'issue-due', agreementId: agreement.id, period: '2026-10', dueDate: '2026-10-05', amount: '1000.00' });
  const collection = await rental({ action: 'record-collection', agreementId: agreement.id, kind, method, amount,
    receivedDate: options.receivedOn || '2026-10-16', reference: 'SYNTHETIC-STAFF-' + randomUUID(),
    ...(kind === 'rent' && method !== 'cheque' ? { allocations: [{ dueId: due.id, amount }] } : {}) });
  return { property, room, tenant, agreement, due, collection };
}
