import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startOwnerBrowserHarness, OTHER_QA_SUBJECT } from '../support/owner-crm-harness';

// Real HAMDEE workspace with synthetic, constructor-injected provider/SQL only.
let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(60_000);
test.beforeEach(async () => { server = await startOwnerBrowserHarness(); await mkdir('evidence/password-qa/screenshots', { recursive: true }); });
test.afterEach(async () => { await server?.close(); });
async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html#dashboard');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
}
async function nav(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true }); if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name, exact: true }).click();
}
async function noMfa(page: Page) {
  await expect(page.getByLabel('Verification code', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /authenticator|verify code/i })).toHaveCount(0);
  expect(server.fixture.fake.facts.calls.enroll).toBe(0); expect(server.fixture.fake.facts.calls.mfa).toBe(0);
}
async function create(page: Page, name: string) {
  await nav(page, 'Properties'); await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill(name); await page.getByRole('button', { name: 'Save property', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

test('Password browser QA: password opens saved dashboard immediately, reload stays signed in, no MFA requests', async ({ page }, info) => {
  const mfaRequests: string[] = []; page.on('request', r => { if (/\/auth\/mfa\//.test(r.url())) mfaRequests.push(r.url()); });
  await login(page); await noMfa(page); await page.reload();
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible(); await noMfa(page);
  expect(mfaRequests).toEqual([]);
  const cookies = await page.context().cookies(); expect(cookies.some(c => c.name === 'hamdee_owner' && c.httpOnly && c.sameSite === 'Strict')).toBeTruthy();
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toMatch(/SYNTHETIC_(?:PROVIDER|INITIAL)|SYNTHETIC-TEST-ONLY|access_token|refresh_token/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `evidence/password-qa/screenshots/${info.project.name}-password-dashboard.png`, fullPage: true });
});

test('Password browser QA: anonymous direct API and invalid password reveal no protected records', async ({ page }, info) => {
  await page.goto(server.url + '/workspace/index.html');
  const anonymous = await page.request.get(server.url + '/api/hamdee/v1/dashboard'); expect(anonymous.status()).toBe(401);
  // The protected denial clears auth/CSRF cookies in this shared browser
  // context. Obtain a fresh anonymous CSRF state before testing the password.
  await page.reload();
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill('SYNTHETIC_WRONG_PASSWORD');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#access-error')).toContainText(/sign in|authorized|credentials|password/i);
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(server.fixture.inputs.email); await noMfa(page);
  await page.screenshot({ path: `evidence/password-qa/screenshots/${info.project.name}-invalid-password.png`, fullPage: true });
});

test('Password browser QA: nonowner provider UUID is rejected despite valid synthetic credentials', async ({ page }) => {
  server.fixture.fake.facts.subject = OTHER_QA_SUBJECT;
  await page.goto(server.url + '/workspace/index.html');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email); await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.locator('#access-error')).not.toBeEmpty();
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toHaveCount(0);
  expect((await page.request.get(server.url + '/api/hamdee/v1/properties')).status()).toBe(401); await noMfa(page);
});

test('Password browser QA: keyboard property CRUD, archive/restore and history need no second authentication step', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); await login(page);
  await nav(page, 'Properties'); await page.getByRole('button', { name: 'Add property', exact: true }).click(); await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.getByRole('button', { name: 'Add property', exact: true })).toBeFocused();
  await create(page, 'Synthetic password browser villa'); await page.getByRole('button', { name: 'Edit property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill('Synthetic password updated villa'); await page.getByRole('button', { name: 'Save property', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic password updated villa', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Archive', exact: true }).click(); await page.getByLabel('Reason', { exact: true }).fill('Synthetic password archive');
  await page.getByRole('button', { name: 'Confirm archive', exact: true }).click(); await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByLabel('Reason', { exact: true }).fill('Synthetic password restore'); await page.getByRole('button', { name: 'Restore property', exact: true }).click();
  await page.getByRole('button', { name: 'Audit history', exact: true }).click(); await expect(page.getByRole('cell', { name: 'restore', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Synthetic password updated villa', exact: true })).toBeVisible(); await noMfa(page);
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `evidence/password-qa/screenshots/${info.project.name}-password-property.png`, fullPage: true });
});

test('Password browser QA: idle expiry clears protected property draft and requires password again', async ({ page }) => {
  await login(page); await create(page, 'Synthetic expired password villa');
  await page.getByRole('button', { name: 'Edit property', exact: true }).click(); await page.getByLabel('Property name', { exact: true }).fill('Synthetic expired private draft');
  server.fixture.clock.advance(server.fixture.options.policy.idleTimeoutMs);
  await page.getByRole('button', { name: 'Save property', exact: true }).click(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.locator('body')).not.toContainText('Synthetic expired private draft'); await noMfa(page);
});

test('Password browser QA: unsafe write without CSRF cannot create a record; logout stays logged out after reload', async ({ page }) => {
  await login(page); const rejected = await page.request.post(server.url + '/api/hamdee/v1/properties', {
    headers: { Origin: server.url, 'Idempotency-Key': '55550000-3333-4333-8333-333333333333' }, data: { name: 'Synthetic rejected browser CSRF' } });
  expect(rejected.status()).toBe(403);
  const count = await server.fixture.pg!.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.properties'); expect(count.rows[0].n).toBe(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  expect((await page.request.get(server.url + '/api/hamdee/v1/dashboard')).status()).toBe(401); await noMfa(page);
});

test('Password browser QA: failed save retains draft and hides raw server details', async ({ page }, info) => {
  await login(page); await nav(page, 'Properties'); await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Property name', { exact: true }).fill('Synthetic password retained draft');
  await page.route('**/api/hamdee/v1/properties', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'text/html', body: 'PRIVATE_QA_STACK_MUST_NOT_RENDER' }) : route.continue());
  await page.getByRole('button', { name: 'Save property', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Property name', { exact: true })).toHaveValue('Synthetic password retained draft');
  await expect(page.locator('#form-error')).toContainText(/unreadable|retry|unavailable/i); await expect(page.locator('body')).not.toContainText('PRIVATE_QA_STACK_MUST_NOT_RENDER');
  await page.screenshot({ path: `evidence/password-qa/screenshots/${info.project.name}-password-save-error.png`, fullPage: true });
});

test('Password browser QA: monthly CSV reconciles saved rental/cost records and neutralizes formula-like property names', async ({ page }) => {
  await login(page); const f = server.fixture; await f.login(false);
  // Seed through the protected production handlers, independently of UI render.
  const post = async (path: string, fields: Record<string, unknown>) => {
    const r = await f.request('POST', '/api/hamdee/v1/' + path, fields, { 'Idempotency-Key': randomUUID() });
    const b = await r.json(); expect(r.ok, JSON.stringify(b)).toBeTruthy(); return b.data;
  };
  const p = await post('properties', { name: '=Synthetic, CSV "villa"' });
  const room = await post('rental', { action: 'create-room', propertyId: p.id, code: 'CSV-01' });
  const tenant = await post('rental', { action: 'create-tenant', name: 'Synthetic CSV tenant' });
  const agreement = await post('rental', { action: 'create-agreement', roomId: room.id, tenantId: tenant.id, monthlyRent: '1000.00', currency: 'QAR', depositRequired: '300.00', dueTerms: 'Synthetic exact date', startDate: '2026-10-01', endDate: null });
  const due = await post('rental', { action: 'issue-due', agreementId: agreement.id, period: '2026-10', dueDate: '2026-10-05', amount: '1000.00' });
  await post('rental', { action: 'record-collection', agreementId: agreement.id, kind: 'rent', method: 'cash', amount: '400.00', receivedDate: '2026-10-06', allocations: [{ dueId: due.id, amount: '400.00' }] });
  for (const [kind, amount] of [['deposit', '300.00'], ['advance', '200.00']]) await post('rental', { action: 'record-collection', agreementId: agreement.id, kind, method: 'bank', amount, receivedDate: '2026-10-06' });
  await post('expenses', { action: 'record-expense', propertyId: p.id, category: 'landlord', expenseDate: '2026-10-07', amount: '100.00', currency: 'QAR', vendorName: 'Synthetic CSV landlord', payment: { method: 'cash', amount: '40.00', paymentDate: '2026-10-07' } });
  await page.reload(); await nav(page, 'Expenses');
  await page.getByLabel('Expense month', { exact: true }).fill('2026-10'); await page.getByLabel('Report through', { exact: true }).fill('2026-10-15');
  await page.getByRole('button', { name: 'Apply expense filters', exact: true }).click();
  const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download monthly CSV', exact: true }).click();
  const download = await downloadEvent; expect(download.suggestedFilename()).toBe('HAMDEE-operations-2026-10.csv');
  const downloadPath = await download.path(); expect(downloadPath).not.toBeNull();
  const csv = await readFile(downloadPath!, 'utf8');
  expect(csv).toContain('Recorded comparison - not distributable profit');
  expect(csv.split('\r\n')[1]).toMatch(/^"'=Synthetic, CSV ""villa""","QAR","1000\.00","400\.00","600\.00","100\.00","40\.00","300\.00","300\.00","200\.00",/);
  await noMfa(page);
});
