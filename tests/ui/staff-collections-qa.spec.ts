import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { StaffCollectionsService } from '../../src/staff-collections';
import { CompanyFinanceService } from '../../src/company-finance';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';
import { seedPropertyReceipt, assertMajor } from '../support/staff-qa-fixture';

// Independent real owner UI -> loopback HTTP -> local PGlite acceptance.
// No endpoint fixtures, hosted credentials, browser profiles or response mocks.
let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(180_000);
test.beforeEach(async () => {
  const sql = await readFile(new URL('../../migrations/006_local_operations_records.up.sql', import.meta.url));
  expect(createHash('sha256').update(sql).digest('hex')).toBe('d1236225e3f34dcae489d593419f9e6a2999208d45e23e112f2cb4f1e814b0e0');
  server = await startOwnerBrowserHarness({ migrationFiles: ['006_local_operations_records.up.sql'],
    operationsFactory: properties => ({ staffCollections: new StaffCollectionsService(properties), companyFinance: new CompanyFinanceService(properties) }) });
  await mkdir('evidence/staff-collections-qa/screenshots', { recursive: true });
});
test.afterEach(async () => { await server?.close(); });

async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html#dashboard');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();
}
async function navigate(page: Page) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name: 'Staff Collections', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Collector register', exact: true })).toBeVisible();
}
async function open(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible(); return dialog;
}
async function save(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(dialog).not.toBeVisible();
}
async function state(page: Page) {
  const response = await page.request.get(server.url + '/api/hamdee/v1/staff-collections?month=2026-10&asOf=2026-10-16');
  expect(response.status()).toBe(200); return (await response.json()).data;
}
async function finance(page: Page) {
  const response = await page.request.get(server.url + '/api/hamdee/v1/company-finance?month=2026-10&asOf=2026-10-16');
  expect(response.status()).toBe(200); return (await response.json()).data;
}

test('Staff independent owner UI: property receipt, partial/full handovers, duplicate denial, correction and persistence use real services', async ({ page }, info) => {
  const source = await seedPropertyReceipt(server.fixture, { amount: '100.00' });
  const pageErrors: string[] = [], external: string[] = [], actions: string[] = [], commandBodies: Record<string, unknown>[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') { external.push(route.request().url()); await route.abort(); return; }
    await route.continue();
  });
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/staff-collections/commands')) {
      const body = request.postDataJSON(); actions.push(body.action); commandBodies.push(body);
    }
  });
  await login(page); await navigate(page);
  let dialog = await open(page, 'Add collector');
  await dialog.getByLabel('Collector name', { exact: true }).fill('Synthetic independent UI collector'); await save(dialog);
  await expect(page.getByRole('region', { name: 'Collector register', exact: true })).toContainText('Synthetic independent UI collector');
  const collectorId = (await state(page)).collectors[0].id;
  dialog = await open(page, 'Add company account');
  await dialog.getByLabel('Account name', { exact: true }).fill('Synthetic independent company cash');
  await dialog.getByLabel('Account type', { exact: true }).selectOption('cash');
  await dialog.getByLabel('Currency', { exact: true }).fill('QAR');
  await dialog.getByLabel('Opening balance date', { exact: true }).fill('2026-10-01');
  await dialog.getByLabel('Owner-confirmed opening balance', { exact: true }).fill('0');
  await dialog.getByLabel('I confirm this account’s opening amount and date, including an explicit zero if appropriate.', { exact: true }).check(); await save(dialog);
  const accountId = (await finance(page)).accounts[0].id;
  dialog = await open(page, 'Link collected receipt');
  await dialog.getByLabel('Collector', { exact: true }).selectOption(collectorId);
  await dialog.getByLabel('Original receipt', { exact: true }).selectOption('property-rent:' + source.collection.id);
  await expect(dialog.locator('#staff-receipt-detail')).toContainText('100');
  await dialog.getByLabel('Where is the money?', { exact: true }).selectOption('collector-held');
  await dialog.getByLabel('I confirm where this receipt is held.', { exact: true }).check(); await save(dialog);
  const balances = page.getByRole('region', { name: 'Collector custody balances', exact: true });
  await expect(balances).toContainText('QAR 100'); assertMajor((await state(page)).totals[0].balance, '100');
  async function handover(amount: string, reference: string) {
    const form = await open(page, 'Record handover');
    await form.getByLabel('Collector', { exact: true }).selectOption(collectorId);
    await form.getByLabel('Company cash / bank account', { exact: true }).selectOption(accountId);
    await expect(form.getByLabel('Account currency', { exact: true })).toHaveValue('QAR');
    await form.getByLabel('Handover amount', { exact: true }).fill(amount);
    await form.getByLabel('Handover date', { exact: true }).fill('2026-10-16');
    await form.getByLabel('New unique handover reference', { exact: true }).fill(reference); return form;
  }
  dialog = await handover('40', 'SYNTHETIC-UI-H1'); await save(dialog);
  await expect(balances).toContainText('QAR 60');
  let snapshot = await state(page), company = await finance(page);
  assertMajor(snapshot.totals[0].balance, '60'); assertMajor(company.totals[0].balance, '40');
  assertMajor(company.totals[0].receipts, '0'); assertMajor(company.totals[0].transfersIn, '40');
  await page.screenshot({ path: `evidence/staff-collections-qa/screenshots/${info.project.name}-partial-handover.png`, fullPage: true });
  dialog = await handover('10', 'SYNTHETIC-UI-H1');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(dialog.locator('#staff-error')).not.toBeEmpty();
  await expect(dialog.getByLabel('Handover amount', { exact: true })).toHaveValue('10');
  snapshot = await state(page); expect(snapshot.handovers).toHaveLength(1); assertMajor(snapshot.totals[0].balance, '60');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  dialog = await open(page, 'Correct handover');
  await dialog.getByLabel('Handover amount', { exact: true }).fill('25');
  await dialog.getByLabel('New unique handover reference', { exact: true }).fill('SYNTHETIC-UI-H1-CORRECTION');
  await dialog.getByLabel('Correction reason', { exact: true }).fill('Synthetic independent correction; retain original'); await save(dialog);
  await expect(balances).toContainText('QAR 75');
  snapshot = await state(page); company = await finance(page);
  expect(snapshot.handovers).toHaveLength(2); expect(snapshot.handovers.filter((row: { reversed: boolean }) => row.reversed)).toHaveLength(1);
  assertMajor(snapshot.totals[0].balance, '75'); assertMajor(company.totals[0].balance, '25'); assertMajor(company.totals[0].receipts, '0');
  await writeFile(`evidence/staff-collections-qa/${info.project.name}-correction-shape.json`, JSON.stringify({
    syntheticOnly: true, command: commandBodies.find(body => body.action === 'correct-handover'),
    history: snapshot.history.find((row: { action: string }) => row.action === 'staff:correct-handover'), handovers: snapshot.handovers
  }, null, 2));
  await expect(page.getByRole('region', { name: 'Staff collection history', exact: true })).toContainText('Synthetic independent correction; retain original');
  dialog = await handover('75', 'SYNTHETIC-UI-H2-FULL'); await save(dialog);
  snapshot = await state(page); company = await finance(page);
  assertMajor(snapshot.totals[0].balance, '0'); assertMajor(snapshot.totals[0].received, '100'); assertMajor(snapshot.totals[0].handedOver, '100');
  assertMajor(company.totals[0].balance, '100'); assertMajor(company.totals[0].receipts, '0'); assertMajor(company.totals[0].transfersIn, '100');
  expect(snapshot.collections).toHaveLength(1); expect(snapshot.handovers).toHaveLength(3);
  await expect(page.getByRole('region', { name: 'Daily collector statement', exact: true })).toContainText('2026-10-16');
  await page.reload(); await expect(page.getByRole('region', { name: 'Collector handovers', exact: true })).toContainText('SYNTHETIC-UI-H2-FULL');
  const persisted = await state(page); expect(persisted.handovers).toHaveLength(3); assertMajor(persisted.totals[0].balance, '0');
  const rental = await page.request.get(server.url + '/api/hamdee/v1/rental?month=2026-10&asOf=2026-10-16');
  expect(rental.status()).toBe(200); const rentalData = (await rental.json()).data;
  expect(rentalData.collections.filter((row: { id: string }) => row.id === source.collection.id)).toHaveLength(1);
  expect((await server.fixture.pg!.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.app_users')).rows[0].n).toBe(1);
  expect(actions).toEqual(['create-collector', 'record-collection', 'handover', 'handover', 'correct-handover', 'handover']);
  expect(pageErrors).toEqual([]); expect(external).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `evidence/staff-collections-qa/screenshots/${info.project.name}-full-corrected-persisted.png`, fullPage: true });
});
