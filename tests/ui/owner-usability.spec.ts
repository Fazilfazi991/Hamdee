import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';
import { seedPropertyReceipt } from '../support/staff-qa-fixture';

let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(120_000);
test.beforeEach(async () => { server = await startOwnerBrowserHarness(); await mkdir('evidence/owner-usability', { recursive: true }); });
test.afterEach(async () => { await server?.close(); });
async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
}

const emptyCars = { moneyUnit: 'decimal-major-unit-strings', vehicles: [], agreements: [], availability: [], balances: [], collections: [], expenses: [], history: [], summary: [] };
test('authorized Staff records stay accessible while company account discovery is unavailable', async ({ page }) => {
  await page.route('**/api/hamdee/v1/staff-collections?*', route => route.fulfill({ json: { data: {
    moneyUnit: 'decimal-major-unit-strings', collectors: [], collections: [], handovers: [], totals: [], daily: [], history: []
  } } }));
  await page.route('**/api/hamdee/v1/company-finance?*', route => route.fulfill({ status: 503, json: {
    error: { code: 'STORAGE_UNAVAILABLE', message: 'Synthetic company account connection unavailable.' }
  } }));
  await login(page);
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true }); if (await menu.isVisible()) await menu.click();
  await expect(page.locator('#navigation a[href="#staff-collections"]')).toHaveCount(1);
  await expect(page.locator('#navigation a[href="#company"]')).toHaveCount(0);
  await page.locator('#navigation a[href="#staff-collections"]').click();
  await expect(page.getByRole('region', { name: 'Collector register', exact: true })).toBeVisible();
  await expect(page.locator('#main')).toContainText('Synthetic company account connection unavailable.');
});
test('authorized module discovery starts before a slow dashboard and independent services become accessible', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/hamdee/v1/dashboard', async route => {
    const response = await route.fetch(); await held;
    try { await route.fulfill({ response }); } catch { /* Navigation may cancel the old dashboard. */ }
  });
  await page.route('**/api/hamdee/v1/car-rentals?*', route => route.fulfill({ json: { data: emptyCars } }));
  await page.goto(server.url + '/workspace/index.html');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  try {
    await expect(page.locator('#navigation a[href="#car-rentals"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toHaveCount(0);
    await expect(page.locator('#navigation a[href="#company"]')).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
});

test('a transient module failure offers Retry and only a successful authorized contract activates the destination', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/hamdee/v1/car-rentals?*', route => ++attempts === 1
    ? route.fulfill({ status: 503, json: { error: { code: 'STORAGE_UNAVAILABLE', message: 'Temporary connection unavailable.' } } })
    : route.fulfill({ json: { data: emptyCars } }));
  await login(page);
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true }); if (await menu.isVisible()) await menu.click();
  const retry = page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Car Rentals Retry', exact: true });
  await expect(retry).toBeEnabled(); await expect(retry).not.toHaveAttribute('href');
  await expect(page.locator('#navigation a[href="#car-rentals"]')).toHaveCount(0);
  await retry.click();
  await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'Car Rentals', exact: true })).toBeVisible();
  await expect(page.locator('#navigation a[href="#company"]')).toHaveCount(0);
  if (await menu.isVisible()) await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.locator('#navigation a[href="#car-rentals"]')).toHaveCount(0);
});

test('read deadlines cancel a stalled fetch while preserving a separate route-abort signal', async ({ page }) => {
  await login(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/hamdee/v1/deadline-probe', async route => { await held; try { await route.abort(); } catch { /* Deadline already cancelled it. */ } });
  try {
    const result = await page.evaluate(async () => {
      const { PropertyApi } = await import('/workspace/adapter.js' as string);
      const original = window.setTimeout;
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => original(handler, delay === 25000 ? 25 : delay, ...args)) as typeof window.setTimeout;
      try { await new PropertyApi().request('/deadline-probe'); return { code: '', status: 0 }; }
      catch (error) { const failure = error as { code: string; status: number }; return { code: failure.code, status: failure.status }; }
      finally { window.setTimeout = original; }
    });
    expect(result).toEqual({ code: 'REQUEST_TIMEOUT', status: 504 });
    const aborted = await page.evaluate(async () => {
      const { PropertyApi } = await import('/workspace/adapter.js' as string);
      const controller = new AbortController(); controller.abort();
      try { await new PropertyApi().request('/deadline-probe', { signal: controller.signal }); return ''; }
      catch (error) { return (error as Error).name; }
    });
    expect(aborted).toBe('AbortError');
  } finally { release(); }
});

test('a delayed dashboard rental read does not block the independent expense request', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/hamdee/v1/rental?*', async route => {
    const response = await route.fetch(); await held;
    try { await route.fulfill({ response }); } catch { /* The test may close an aborted read. */ }
  });
  await page.goto(server.url + '/workspace/index.html');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  const expense = page.waitForRequest(request => new URL(request.url()).pathname === '/api/hamdee/v1/expenses', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  try { await expense; } finally { release(); }
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Income versus expenses', exact: true })).toBeVisible();
});

test('owner views avoid redundant rental and villa property-register reads without caching private records', async ({ page }) => {
  const source = await seedPropertyReceipt(server.fixture, { amount: '100.00' });
  const reads: string[] = [];
  page.on('request', request => { if (request.method() === 'GET') reads.push(new URL(request.url()).pathname); });
  await login(page);
  expect(reads.filter(path => path === '/api/hamdee/v1/rental')).toHaveLength(1);
  await expect(page.locator('#rental-dashboard')).toContainText('Confirm imported occupancy.');
  await expect(page.locator('#expense-dashboard')).toHaveAttribute('aria-busy', 'false');
  const propertyReads = () => reads.filter(path => path === '/api/hamdee/v1/properties').length;
  const before = propertyReads();
  await page.getByRole('button', { name: source.property.name, exact: true }).click();
  await page.getByRole('button', { name: 'Rooms & rentals', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Rooms and occupancy', exact: true })).toContainText(source.room.code);
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  expect(propertyReads()).toBe(before);
  await page.getByRole('button', { name: 'Expenses & maintenance', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Property expense register', exact: true })).toBeVisible();
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  expect(propertyReads()).toBe(before);
  await page.goto(server.url + '/workspace/index.html#reports');
  await expect(page.getByRole('heading', { name: 'Monthly property report', exact: true })).toBeVisible();
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  const beforeRefresh = reads.filter(path => path === '/api/hamdee/v1/rental').length;
  await page.reload();
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  expect(reads.filter(path => path === '/api/hamdee/v1/rental')).toHaveLength(beforeRefresh);
});

test('collection choices follow the selected agreement and keep deposits, advances and pending cheques distinct', async ({ page }, info) => {
  const a = await seedPropertyReceipt(server.fixture, { amount: '100.00' });
  const b = await seedPropertyReceipt(server.fixture, { amount: '200.00' });
  await login(page);
  await page.goto(server.url + '/workspace/index.html#collections');
  await page.getByLabel('Rent month', { exact: true }).fill('2026-10');
  await page.getByLabel('Occupancy / balance date', { exact: true }).fill('2026-10-20');
  await page.getByRole('button', { name: 'Apply rental filters', exact: true }).click();
  await page.getByRole('button', { name: 'Record collection', exact: true }).click();
  const d = page.locator('#rental-dialog');
  const due = d.getByLabel('Allocate rent to due', { exact: true });
  await d.getByLabel('Agreement', { exact: true }).selectOption(a.agreement.id);
  await d.getByLabel('Payment method', { exact: true }).selectOption('cash');
  await expect(due.locator('option')).toHaveCount(2);
  await expect(due.locator('option[value="' + a.due.id + '"]')).toHaveCount(1);
  await expect(due.locator('option[value="' + b.due.id + '"]')).toHaveCount(0);
  await due.selectOption(a.due.id);
  await d.getByLabel('Amount', { exact: true }).fill('25.00');
  await d.getByLabel('Agreement', { exact: true }).selectOption(b.agreement.id);
  await expect(due).toHaveValue('');
  await expect(due).toHaveAttribute('required', '');
  await expect(due.locator('option[value="' + b.due.id + '"]')).toHaveCount(1);
  await expect(d.getByLabel('Amount', { exact: true })).toHaveValue('25.00');
  await d.getByLabel('Collection purpose', { exact: true }).selectOption('deposit');
  await expect(due).toBeHidden(); await expect(due).toBeDisabled();
  await expect(d.locator('#rental-payment-note')).toContainText('separate from rent income');
  await d.getByLabel('Collection purpose', { exact: true }).selectOption('advance');
  await expect(d.locator('#rental-payment-note')).toContainText('unapplied');
  await d.getByLabel('Collection purpose', { exact: true }).selectOption('rent');
  await d.getByLabel('Payment method', { exact: true }).selectOption('cheque');
  await expect(due).toBeHidden(); await expect(due).toBeDisabled();
  await expect(d.locator('#rental-payment-note')).toContainText('stays pending');
  await d.getByLabel('Payment method', { exact: true }).selectOption('bank');
  await expect(due).toBeVisible(); await due.selectOption(b.due.id);
  await d.getByLabel('Received date', { exact: true }).fill('2026-10-20');
  await d.getByLabel('Reference (optional)', { exact: true }).fill('SYNTHETIC-USABILITY-PARTIAL');
  await page.screenshot({ path: `evidence/owner-usability/${info.project.name}-collection-review.png` });
  await d.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(d).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Collection register', exact: true })).toContainText('SYNTHETIC-USABILITY-PARTIAL');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Collection register', exact: true })).toContainText('SYNTHETIC-USABILITY-PARTIAL');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
