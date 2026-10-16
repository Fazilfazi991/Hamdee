import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';

let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
const villa = '=Synthetic Expense Browser Villa';
test.setTimeout(120_000);
test.beforeEach(async () => { server = await startOwnerBrowserHarness(); await mkdir('evidence/expense-qa', { recursive: true }); });
test.afterEach(async () => { await server?.close(); });
async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html#dashboard'); await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email); await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
}
async function nav(page: Page, name: string) { const menu = page.getByRole('button', { name: 'Open navigation', exact: true }); if (await menu.isVisible()) await menu.click(); await page.getByRole('link', { name, exact: true }).click(); }
async function setup(page: Page) {
  await login(page); await nav(page, 'Villas & Properties'); await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill(villa); await page.getByRole('button', { name: 'Save property', exact: true }).click(); await expect(page.getByRole('heading', { name: villa, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rooms & rentals', exact: true }).click(); await page.getByRole('button', { name: 'Add room', exact: true }).click();
  const room = page.locator('#rental-dialog'); await room.getByLabel('Room code', { exact: true }).fill('EXP-R01'); await room.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(room).not.toBeVisible();
  await page.getByRole('button', { name: 'Expenses & maintenance', exact: true }).click(); await expect(page.getByRole('button', { name: 'Add property expense', exact: true })).toBeVisible();
  await page.getByLabel('Expense month', { exact: true }).fill('2026-10'); await page.getByLabel('Report through', { exact: true }).fill('2026-10-15'); await page.getByRole('button', { name: 'Apply expense filters', exact: true }).click();
}
async function open(page: Page, name: string) { await page.getByRole('button', { name, exact: true }).first().click(); return page.locator('#expense-dialog'); }
async function save(dialog: Locator) { await dialog.getByRole('button', { name: 'Save expense record', exact: true }).click(); await expect(dialog).not.toBeVisible(); }
async function payment(dialog: Locator, method: string, amount: string, date: string, reference: string) {
  await dialog.getByLabel('Payment method', { exact: true }).selectOption({ label: method }); await dialog.getByLabel('Payment amount', { exact: true }).fill(amount); await dialog.getByLabel('Payment date', { exact: true }).fill(date); await dialog.getByLabel('Payment reference (optional)', { exact: true }).fill(reference);
}
async function expenseForm(page: Page, amount = '1000.25', paid = false) {
  const d = await open(page, 'Add property expense'); await d.getByLabel('Expense category', { exact: true }).selectOption({ label: 'Landlord rent / payment' });
  await d.getByLabel('Expense date', { exact: true }).fill('2026-10-05'); await d.getByLabel('Recorded cost', { exact: true }).fill(amount); await d.getByLabel('Currency', { exact: true }).fill('QAR');
  await d.getByLabel('Vendor / landlord', { exact: true }).fill('Synthetic browser landlord'); await d.getByLabel('Vendor contact (optional)', { exact: true }).fill('synthetic-landlord@example.invalid');
  await d.getByLabel('Invoice / expense reference (optional)', { exact: true }).fill('SYNTHETIC-LANDLORD-INVOICE'); await d.getByLabel('Notes (optional)', { exact: true }).fill('Synthetic <img src=x onerror=alert(1)>');
  if (paid) await payment(d, 'Cash', '400.00', '2026-10-05', 'SYNTHETIC-CASH'); return d;
}
function jobRow(page: Page, issue: string) { return page.getByRole('region', { name: 'Maintenance job register', exact: true }).getByRole('row').filter({ hasText: issue }); }
async function createJob(page: Page, issue: string, opened = '2026-10-01') {
  const d = await open(page, 'Create maintenance job'); await d.getByLabel('Room allocation (optional)', { exact: true }).selectOption({ label: villa + ' · EXP-R01' });
  await d.getByLabel('Work type', { exact: true }).fill('AC service'); await d.getByLabel('Issue / requested work', { exact: true }).fill(issue); await d.getByLabel('Job opened date', { exact: true }).fill(opened);
  await d.getByLabel('Vendor / landlord', { exact: true }).fill('Synthetic AC vendor'); await d.getByLabel('Vendor contact (optional)', { exact: true }).fill('synthetic-ac@example.invalid'); await save(d);
}

test('Expense UI QA: owner costs/partial payments/maintenance/warranty/history/report persist on desktop and mobile', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await setup(page);
  let d = await expenseForm(page, '1000.25', true); await save(d);
  const expenses = page.getByRole('region', { name: 'Property expense register', exact: true });
  const landlord = expenses.getByRole('row').filter({ hasText: 'Synthetic browser landlord' }); await expect(landlord.getByRole('cell', { name: 'QAR 600.25', exact: true })).toBeVisible();
  await landlord.getByRole('button', { name: 'Record payment', exact: true }).click(); d = page.locator('#expense-dialog'); await payment(d, 'Cheque (pending only)', '600.25', '2026-10-06', 'SYNTHETIC-CHEQUE'); await save(d);
  await expect(landlord.getByRole('cell', { name: 'QAR 600.25', exact: true })).toHaveCount(2);
  await landlord.getByRole('button', { name: 'Record payment', exact: true }).click(); d = page.locator('#expense-dialog'); await payment(d, 'Bank', '600.25', '2026-10-07', 'SYNTHETIC-BANK'); await save(d);
  await expect(landlord.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0);
  await createJob(page, 'Synthetic first leaking AC'); await jobRow(page, 'Synthetic first leaking AC').getByRole('button', { name: 'Complete job', exact: true }).click(); d = page.locator('#expense-dialog');
  await d.getByLabel('Completed date', { exact: true }).fill('2026-10-08'); await d.getByLabel('Work completed', { exact: true }).fill('Synthetic replacement of faulty part');
  await d.getByLabel('Actual cost', { exact: true }).fill('250.50'); await d.getByLabel('Currency', { exact: true }).fill('QAR'); await d.getByLabel('Invoice / expense reference (optional)', { exact: true }).fill('SYNTHETIC-AC-INVOICE');
  await d.getByLabel('Warranty start date (optional)', { exact: true }).fill('2026-10-08'); await d.getByLabel('Warranty end date (optional)', { exact: true }).fill('2026-10-31');
  await payment(d, 'Cash', '100.25', '2026-10-08', 'SYNTHETIC-JOB-CASH'); await save(d);
  await expect(jobRow(page, 'Synthetic first leaking AC').getByRole('button', { name: 'Complete job', exact: true })).toHaveCount(0); await expect(expenses.getByRole('row')).toHaveCount(3);
  await createJob(page, 'Synthetic repeat AC issue', '2026-10-10'); await expect(jobRow(page, 'Synthetic repeat AC issue')).toContainText('Possible warranty coverage');
  await jobRow(page, 'Synthetic first leaking AC').getByRole('button', { name: 'Job history', exact: true }).click(); d = page.locator('#expense-dialog'); await expect(d).toContainText('Synthetic replacement of faulty part'); await expect(d).toContainText('2026-10-31'); await d.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: 'Expenses & maintenance', exact: true }).click(); await expect(page.getByRole('region', { name: 'Property expense register', exact: true }).getByRole('row')).toHaveCount(3);
  const summary = page.getByRole('region', { name: 'Property monthly income and expenses', exact: true }); await expect(summary.getByRole('cell', { name: 'QAR 1250.75', exact: true })).toBeVisible(); await expect(summary.getByRole('cell', { name: 'QAR -1250.75', exact: true })).toBeVisible(); await expect(summary.getByRole('cell', { name: 'QAR 1100.50', exact: true })).toBeVisible();
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download monthly CSV', exact: true }).click(); const download = await downloaded;
  expect(download.suggestedFilename()).toBe('HAMDEE-operations-2026-10.csv'); const stream = await download.createReadStream(); expect(stream).toBeTruthy(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv).toContain("\"'=Synthetic Expense Browser Villa\""); expect(csv).toContain('"-1250.75"'); expect(csv).toContain('not distributable profit');
  await page.screenshot({ path: `evidence/expense-qa/${info.project.name}-operations.png`, fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy(); expect(errors).toEqual([]);
  await nav(page, 'Dashboard'); await expect(page.getByRole('region', { name: 'Property monthly income and expenses', exact: true }).getByRole('cell', { name: 'QAR -1250.75', exact: true })).toBeVisible(); await page.screenshot({ path: `evidence/expense-qa/${info.project.name}-dashboard.png`, fullPage: true });
});

test('Expense UI QA: duplicate invoice/error retention/logout protect local expense records', async ({ page }, info) => {
  await setup(page); let d = await expenseForm(page, '10.25'); await save(d);
  await expect(page.getByRole('region', { name: 'Property monthly income and expenses', exact: true }).getByRole('cell', { name: 'QAR -10.25', exact: true })).toBeVisible();
  d = await expenseForm(page, '10.25'); await d.getByRole('button', { name: 'Save expense record', exact: true }).click(); await expect(d.locator('#expense-error')).toContainText(/already recorded/i); await expect(d.getByLabel('Recorded cost', { exact: true })).toHaveValue('10.25'); await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  d = await open(page, 'Create maintenance job'); await d.getByLabel('Work type', { exact: true }).fill('Synthetic retained work'); await d.getByLabel('Issue / requested work', { exact: true }).fill('Synthetic retained error');
  await page.route('**/api/hamdee/v1/expenses', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'text/html', body: 'PRIVATE_EXPENSE_ERROR_MUST_NOT_APPEAR' }) : route.continue());
  await d.getByRole('button', { name: 'Save expense record', exact: true }).click(); await expect(d.locator('#expense-error')).toContainText(/unreadable|retry|unavailable/i); await expect(d.getByLabel('Issue / requested work', { exact: true })).toHaveValue('Synthetic retained error'); await expect(page.locator('body')).not.toContainText('PRIVATE_EXPENSE_ERROR_MUST_NOT_APPEAR');
  await page.screenshot({ path: `evidence/expense-qa/${info.project.name}-error.png`, fullPage: true }); await d.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.unroute('**/api/hamdee/v1/expenses');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add property expense', exact: true })).toHaveCount(0); await expect(page.getByRole('cell', { name: 'Synthetic browser landlord', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
