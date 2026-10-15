import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';

let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(60_000);
test.beforeEach(async () => { server = await startOwnerBrowserHarness(); await mkdir('evidence/owner-crm', { recursive: true }); });
test.afterEach(async () => { await server?.close(); });
async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html#dashboard');
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await page.getByLabel(/email/i).fill(server.fixture.inputs.email);
  await page.getByLabel(/password/i).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('heading', { name: /dashboard|property overview/i }).first()).toBeVisible();
  await expect(page.locator('#owner-mfa, #enrollment-qr')).toHaveCount(0);
}
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name, exact: true }).click();
}
async function properties(page: Page) { await navigate(page, 'Properties'); }
async function create(page: Page, name: string) {
  await properties(page); await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save property', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
test('owner UI: password login, keyboard property CRUD/archive/restore/audit and saved dashboard', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); await properties(page);
  expect(await page.evaluate(() => {
    const header = document.querySelector('.topbar')!.getBoundingClientRect();
    const actions = document.querySelector('.topbar-actions')!.getBoundingClientRect();
    return actions.top >= header.top && actions.bottom <= header.bottom;
  })).toBeTruthy();
  await page.getByRole('button', { name: 'Add property', exact: true }).click(); await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.getByRole('button', { name: 'Add property', exact: true })).toBeFocused();
  await create(page, 'Synthetic Owner Browser Villa');
  await page.getByRole('button', { name: 'Edit property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill('Synthetic Owner Updated Villa');
  await page.getByRole('button', { name: 'Save property', exact: true }).click(); await page.reload();
  await expect(page.getByRole('heading', { name: 'Synthetic Owner Updated Villa', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Archive', exact: true }).click(); await page.getByLabel('Reason', { exact: true }).fill('Synthetic owner browser archive');
  await page.getByRole('button', { name: 'Confirm archive' }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click(); await page.getByLabel('Reason', { exact: true }).fill('Synthetic owner browser restore');
  await page.getByRole('button', { name: 'Restore property', exact: true }).click();
  await page.getByRole('button', { name: 'Audit history', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Synthetic owner browser archive', exact: true })).toBeVisible();
  await page.screenshot({ path: `evidence/owner-crm/${info.project.name}-owner-audit.png`, fullPage: true });
  await navigate(page, 'Dashboard');
  await expect(page.getByText('Synthetic Owner Updated Villa', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy(); expect(errors).toEqual([]);
});
test('owner UI: invalid password shows accessible error, clears password and never protected property data', async ({ page }) => {
  await page.goto(server.url + '/workspace/index.html'); await page.getByLabel(/email/i).fill(server.fixture.inputs.email);
  await page.getByLabel(/password/i).fill('SYNTHETIC_WRONG_PASSWORD'); await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('alert').first()).toBeVisible(); await expect(page.getByRole('button', { name: 'Add property', exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/password/i)).toHaveValue('');
  await expect(page.getByRole('alert').first()).toBeFocused();
  await page.getByLabel(/password/i).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
  await expect(page.locator('#owner-mfa, #enrollment-qr')).toHaveCount(0);
});
test('owner UI: empty filtered property results recover without changing saved records', async ({ page }) => {
  await login(page); await create(page, 'Synthetic property search recovery');
  await properties(page);
  await page.getByRole('textbox', { name: 'Search properties', exact: true }).fill('SYNTHETIC_NO_MATCH');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching properties', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search properties', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Search properties', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Synthetic property search recovery', exact: true })).toBeVisible();
});
test('owner UI: lost committed response retries one command and stale edit preserves draft', async ({ page }) => {
  await login(page); await properties(page); await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill('Synthetic owner lost response'); let lost = false;
  await page.route('**/api/hamdee/v1/properties', async route => {
    if (route.request().method() === 'POST' && !lost) { lost = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save property', exact: true }).click(); await expect(page.locator('#form-error')).toContainText(/interrupted|retry/i);
  await page.getByRole('button', { name: 'Save property', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic owner lost response', exact: true })).toBeVisible();
  expect((await server.fixture.pg!.query('SELECT id FROM hamdee_private.properties WHERE name=$1', ['Synthetic owner lost response'])).rows).toHaveLength(1);
  const id = page.url().split('#properties/')[1]; await page.getByRole('button', { name: 'Edit property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill('Synthetic owner retained draft');
  await server.fixture.login();
  const changed = await server.fixture.request('PATCH', '/api/hamdee/v1/properties/' + id, { name: 'Synthetic outside edit' }, { 'Idempotency-Key': randomUUID(), 'If-Match': `"property:${id}:1"` }); expect(changed.status).toBe(200);
  await page.getByRole('button', { name: 'Save property', exact: true }).click(); await expect(page.getByLabel('Property name', { exact: true })).toHaveValue('Synthetic owner retained draft');
  await expect(page.getByRole('button', { name: 'Review latest revision' })).toBeVisible();
});
test('owner UI: rejected expense CSRF retains the draft for an explicit retry', async ({ page }, info) => {
  await login(page); await create(page, 'Synthetic CSRF draft property');
  await page.getByRole('button', { name: 'Expenses & maintenance', exact: true }).click();
  await page.getByRole('button', { name: 'Add property expense', exact: true }).click();
  const dialog = page.locator('#expense-dialog');
  await dialog.getByLabel('Expense category', { exact: true }).selectOption({ label: 'Landlord rent / payment' });
  await dialog.getByLabel('Expense date', { exact: true }).fill('2026-10-05');
  await dialog.getByLabel('Recorded cost', { exact: true }).fill('7.50');
  await dialog.getByLabel('Currency', { exact: true }).fill('QAR');
  await dialog.getByLabel('Vendor / landlord', { exact: true }).fill('Synthetic retained CSRF vendor');
  let rejected = false;
  await page.route('**/api/hamdee/v1/expenses', async route => {
    if (route.request().method() === 'POST' && !rejected) {
      rejected = true;
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CSRF_REJECTED', message: 'Reload the sign-in state and try again.' } }) });
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Save expense record', exact: true }).click();
  await expect(dialog.locator('#expense-error')).toContainText('Review your draft, then save explicitly.');
  await expect(dialog.getByLabel('Vendor / landlord', { exact: true })).toHaveValue('Synthetic retained CSRF vendor');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save expense record', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Property expense register', exact: true }).getByRole('row').filter({ hasText: 'Synthetic retained CSRF vendor' })).toHaveCount(1);
  await navigate(page, 'Dashboard');
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Property monthly income and expenses', exact: true }).getByRole('cell', { name: 'QAR -7.50', exact: true })).toBeVisible();
  await page.screenshot({ path: `evidence/owner-crm/${info.project.name}-saved-expense-dashboard.png`, fullPage: true });
});
test('owner UI: logout in another tab wins over delayed reply and preserves demo storage isolation', async ({ page }) => {
  const sentinel = JSON.stringify({ properties: [{ name: 'SYNTHETIC_DEMO_MUST_NOT_APPEAR', rent: 123456 }] });
  await page.addInitScript(value => localStorage.setItem('hamdee-investment-demo-v1', value), sentinel); await login(page);
  await properties(page); await page.getByRole('button', { name: 'Add property', exact: true }).click(); await page.getByLabel('Property name', { exact: true }).fill('Synthetic delayed owner save');
  let release!: () => void, committed!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { committed = resolve; });
  await page.route('**/api/hamdee/v1/properties', async route => { if (route.request().method() === 'POST') { const response = await route.fetch(); committed(); await hold; await route.fulfill({ response }); } else await route.continue(); });
  await page.getByRole('button', { name: 'Save property', exact: true }).click(); await ready;
  // A busy modal intentionally blocks its page's top bar. Use a real second
  // owner tab to perform global logout, then make the first tab observe loss.
  const second = await page.context().newPage(); await second.goto(server.url + '/workspace/index.html#dashboard');
  await expect(second.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
  await second.getByRole('button', { name: /sign out|log out/i }).click();
  await page.evaluate(() => { window.location.hash = 'dashboard'; });
  await expect(page.getByLabel(/email/i)).toBeVisible(); release();
  await expect(page.getByRole('heading', { name: 'Synthetic delayed owner save', exact: true })).toHaveCount(0);
  await second.close();
  expect(await page.evaluate(() => localStorage.getItem('hamdee-investment-demo-v1'))).toBe(sentinel);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key !== 'hamdee-investment-demo-v1'))).toEqual([]);
});
test('owner UI: failed property response retains form with safe readable error', async ({ page }, info) => {
  await login(page); await properties(page); await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill('Synthetic retained owner failure');
  await page.route('**/api/hamdee/v1/properties', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'text/html', body: 'PRIVATE_STACK_MUST_NOT_APPEAR' }) : route.continue());
  await page.getByRole('button', { name: 'Save property', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await expect(page.getByLabel('Property name', { exact: true })).toHaveValue('Synthetic retained owner failure');
  await expect(page.locator('#form-error')).toContainText(/unreadable|retry|unavailable/i); await expect(page.locator('body')).not.toContainText('PRIVATE_STACK');
  await page.screenshot({ path: `evidence/owner-crm/${info.project.name}-owner-error.png`, fullPage: true });
});
test('owner UI: owner session survives reload, and logout removes protected content', async ({ page }, info) => {
  await login(page); await create(page, 'Synthetic reopened owner property');
  await page.reload(); await expect(page.getByRole('heading', { name: 'Synthetic reopened owner property', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /sign out|log out/i }).click();
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic reopened owner property', exact: true })).toHaveCount(0);
  await expect(page.locator('#owner-mfa, #enrollment-qr')).toHaveCount(0);
  await page.screenshot({ path: `evidence/owner-crm/${info.project.name}-owner-login.png`, fullPage: true });
});
test('owner UI: returning owner signs in directly with password and retains saved properties', async ({ page }) => {
  await login(page); await create(page, 'Synthetic returning owner property');
  await page.getByRole('button', { name: /sign out|log out/i }).click();
  await page.getByLabel(/email/i).fill(server.fixture.inputs.email); await page.getByLabel(/password/i).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic returning owner property', { exact: true })).toBeVisible();
  await expect(page.locator('#owner-mfa, #enrollment-qr')).toHaveCount(0);
});
