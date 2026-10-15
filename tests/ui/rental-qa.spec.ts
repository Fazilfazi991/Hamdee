import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';

let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(90_000);
test.beforeEach(async () => { server = await startOwnerBrowserHarness(); await mkdir('evidence/rental-qa', { recursive: true }); });
test.afterEach(async () => { await server?.close(); });
async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html#dashboard');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  await page.getByLabel('Verification code', { exact: true }).fill(server.fixture.inputs.validTotp);
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
}
async function nav(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true }); if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name, exact: true }).click();
}
async function addProperty(page: Page) {
  await nav(page, 'Properties'); await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill('Synthetic Rental Browser Villa');
  await page.getByRole('button', { name: 'Save property', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Rental Browser Villa', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rooms & rentals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rooms & units', exact: true })).toBeVisible();
}
async function open(page: Page, name: string) { await page.getByRole('button', { name, exact: true }).first().click(); return page.locator('#rental-dialog'); }
async function save(dialog: Locator) { await dialog.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(dialog).not.toBeVisible(); }
async function room(page: Page, code: string) { const d = await open(page, 'Add room'); await d.getByLabel('Room code', { exact: true }).fill(code); await save(d); }
async function prepareRoomAgreement(page: Page) {
  await addProperty(page); await room(page, 'QA-R01'); await room(page, 'QA-R02');
  let d = await open(page, 'Add tenant'); await d.getByLabel('Tenant name', { exact: true }).fill('Synthetic Browser Tenant');
  await d.getByLabel('Phone (optional)', { exact: true }).fill('+00000000000');
  await d.getByLabel('Email (optional)', { exact: true }).fill('tenant-browser@example.invalid');
  await d.getByLabel('Notes (optional)', { exact: true }).fill('Synthetic <img src=x onerror=alert(1)>'); await save(d);
  d = await open(page, 'Add agreement');
  await d.getByLabel('Room / unit', { exact: true }).selectOption({ label: 'Synthetic Rental Browser Villa · QA-R01' });
  await d.getByLabel('Tenant', { exact: true }).selectOption({ label: 'Synthetic Browser Tenant' });
  await d.getByLabel('Monthly rent', { exact: true }).fill('1000.00'); await d.getByLabel('Currency', { exact: true }).fill('QAR');
  await d.getByLabel('Due-date terms', { exact: true }).fill('Explicit amount due on owner-entered date');
  await d.getByLabel('Security deposit required', { exact: true }).fill('500.00');
  await d.getByLabel('Agreement start date', { exact: true }).fill('2026-10-01'); await save(d);
  await page.getByLabel('Rent month', { exact: true }).fill('2026-10');
  await page.getByLabel('Occupancy / balance date', { exact: true }).fill('2026-10-15');
  await page.getByRole('button', { name: 'Apply rental filters', exact: true }).click();
  d = await open(page, 'Issue monthly due');
  await d.getByLabel('Agreement', { exact: true }).selectOption({ index: 1 });
  await d.getByLabel('Rent month', { exact: true }).fill('2026-10'); await d.getByLabel('Exact due date', { exact: true }).fill('2026-10-05');
  await d.getByLabel('Amount', { exact: true }).fill('1000.00'); await save(d);
}
async function collect(page: Page, purpose: string, method: string, amount: string) {
  const d = await open(page, purpose === 'Rent' && method !== 'Cheque (pending only)' ? 'Collect rent' : 'Record collection');
  await d.getByLabel('Agreement', { exact: true }).selectOption({ index: 1 });
  await d.getByLabel('Collection purpose', { exact: true }).selectOption({ label: purpose });
  await d.getByLabel('Payment method', { exact: true }).selectOption({ label: method });
  await d.getByLabel('Amount', { exact: true }).fill(amount); await d.getByLabel('Received date', { exact: true }).fill('2026-10-10');
  await d.getByLabel('Reference (optional)', { exact: true }).fill('SYNTHETIC-' + method.toUpperCase());
  await save(d);
}

test('Rental UI QA: full owner room/tenant/agreement/due/partial collection workflow and saved dashboard', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); await prepareRoomAgreement(page);
  const occupancy = page.getByRole('region', { name: 'Rooms and occupancy', exact: true });
  await expect(occupancy.getByRole('cell', { name: 'occupied', exact: true })).toHaveCount(1);
  await expect(occupancy.getByRole('cell', { name: 'vacant', exact: true })).toHaveCount(1);
  await collect(page, 'Rent', 'Cash', '400.00');
  const dues = page.getByRole('region', { name: 'Monthly rent dues', exact: true });
  await expect(dues.getByRole('cell', { name: 'partial', exact: true })).toBeVisible();
  await expect(dues.getByRole('cell', { name: 'QAR 600.00', exact: true })).toBeVisible();
  await collect(page, 'Security deposit', 'Bank', '500.00'); await collect(page, 'Rent', 'Cheque (pending only)', '600.00');
  await expect(dues.getByRole('cell', { name: 'partial', exact: true })).toBeVisible();
  await collect(page, 'Rent', 'Bank', '600.00'); await expect(dues.getByRole('cell', { name: 'paid', exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Rooms & rentals', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Monthly rent dues', exact: true }).getByRole('cell', { name: 'paid', exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Rooms and occupancy', exact: true }).getByRole('row').filter({ has: page.getByRole('cell', { name: 'QA-R01', exact: true }) }).getByRole('button', { name: 'Room history', exact: true }).click();
  const history = page.locator('#rental-dialog'); await expect(history.getByRole('cell', { name: 'Synthetic Browser Tenant', exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: `evidence/rental-qa/${info.project.name}-rental-workflow.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await nav(page, 'Dashboard');
  const summary = page.getByRole('region', { name: 'Monthly rental summary', exact: true });
  await expect(summary.getByRole('cell', { name: 'QAR 1000.00', exact: true })).toHaveCount(2);
  await expect(summary.getByRole('cell', { name: 'QAR 0.00', exact: true })).toHaveCount(2);
  await expect(summary.getByRole('cell', { name: 'QAR 500.00', exact: true })).toBeVisible();
  await expect(summary.getByRole('cell', { name: 'QAR 600.00', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.rental-panel img'))).toBeNull(); expect(errors).toEqual([]);
  await page.screenshot({ path: `evidence/rental-qa/${info.project.name}-rental-dashboard.png`, fullPage: true });
});

test('Rental UI QA: duplicate code and failed save retain input; logout clears protected rental content', async ({ page }, info) => {
  await login(page); await addProperty(page); await room(page, 'QA-DUP');
  let d = await open(page, 'Add room'); await d.getByLabel('Room code', { exact: true }).fill('qa-dup');
  await d.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(d.locator('#rental-error')).toContainText(/already.*room code/i);
  await expect(d.getByLabel('Room code', { exact: true })).toHaveValue('qa-dup');
  await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  d = await open(page, 'Add tenant'); await d.getByLabel('Tenant name', { exact: true }).fill('Synthetic retained failure');
  await page.route('**/api/hamdee/v1/rental', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'text/html', body: 'PRIVATE_ERROR_MUST_NOT_APPEAR' }) : route.continue());
  await d.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(d.locator('#rental-error')).toContainText(/unreadable|retry|unavailable/i);
  await expect(d.getByLabel('Tenant name', { exact: true })).toHaveValue('Synthetic retained failure');
  await expect(page.locator('body')).not.toContainText('PRIVATE_ERROR_MUST_NOT_APPEAR');
  await page.screenshot({ path: `evidence/rental-qa/${info.project.name}-rental-error.png`, fullPage: true });
  await d.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.unroute('**/api/hamdee/v1/rental');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add room', exact: true })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'QA-DUP', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
