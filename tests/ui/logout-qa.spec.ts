import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';

// Disposable loopback UI; provider controls below exist only in test harness.
let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
test.setTimeout(90_000);
test.beforeEach(async () => { server = await startOwnerBrowserHarness(); await mkdir('evidence/car-finance-qa/screenshots', { recursive: true }); });
test.afterEach(async () => { await server?.close(); });
async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html#dashboard');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();
  // Drain dashboard reads before advancing the test clock; a response arriving
  // afterwards legitimately renews the browser CSRF proof.
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#daily-dashboard')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#navigation')).not.toContainText('Checking…');
}
async function property() {
  await server.fixture.login();
  const response = await server.fixture.request('POST', '/api/hamdee/v1/properties', { name: 'Synthetic independent logout villa' }, { 'Idempotency-Key': randomUUID() });
  expect(response.status).toBe(201); return (await response.json()).data as { id: string };
}
async function denied(page: Page) {
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add property', exact: true })).toHaveCount(0);
  for (const route of ['/dashboard', '/properties', '/staff-collections?month=2026-10&asOf=2026-10-16']) {
    const response = await page.request.get(server.url + '/api/hamdee/v1' + route);
    expect(response.status()).toBe(401); expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
  }
}

test('Independent logout browser: successful logout, reload, Back and direct property URL cannot restore protected content', async ({ page }, info) => {
  const saved = await property(); await login(page);
  await page.goto(server.url + '/workspace/index.html#properties/' + saved.id);
  await expect(page.getByRole('heading', { name: 'Synthetic independent logout villa', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await denied(page);
  await page.reload(); await denied(page); await page.goBack(); await denied(page);
  await page.goto(server.url + '/workspace/index.html#properties/' + saved.id); await denied(page);
  expect(server.fixture.fake.facts.calls.signOut).toBe(1);
  expect((await server.fixture.pg!.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.properties')).rows[0].n).toBe(1);
  await page.screenshot({ path: `evidence/car-finance-qa/screenshots/${info.project.name}-logout-direct-denial.png`, fullPage: true });
});

test('Independent logout browser: expired CSRF is renewed before a single confirmed logout and cannot restore access', async ({ page }, info) => {
  const saved = await property(); await login(page);
  // Leave an actual protected route in history: Back must recheck that route,
  // rather than returning to the browser's initial about:blank entry.
  await page.goto(server.url + '/workspace/index.html#properties/' + saved.id);
  await expect(page.getByRole('heading', { name: 'Synthetic independent logout villa', exact: true })).toBeVisible();
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#navigation')).not.toContainText('Checking…');
  server.fixture.clock.advance(60_001);
  const traffic: { method: string; path: string; status: number }[] = [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/hamdee/auth/')) traffic.push({ method: response.request().method(), path, status: response.status() });
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await denied(page);
  await expect(page).toHaveURL(/\/login(?:[?#]|$)/);
  const logout = traffic.findIndex(item => item.method === 'POST' && item.path.endsWith('/logout') && item.status === 200);
  expect(logout).toBeGreaterThanOrEqual(0);
  expect(traffic.slice(0, logout).some(item => item.method === 'GET' && item.path.endsWith('/state') && item.status === 200)).toBeTruthy();
  expect(traffic.filter(item => item.path.endsWith('/logout'))).toHaveLength(1);
  expect(server.fixture.fake.facts.calls.signOut).toBe(1);
  await page.reload(); await denied(page); await page.goBack(); await denied(page);
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `evidence/car-finance-qa/screenshots/${info.project.name}-logout-renewed.png`, fullPage: true });
});

test('Independent logout browser: provider failure stays explicitly unconfirmed; local refresh does not claim global success', async ({ page }, info) => {
  await property(); await login(page); server.fixture.fake.facts.unconfirmedLogout = true;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign-out unconfirmed', exact: true })).toBeVisible();
  await expect(page.locator('#main')).toContainText('Global sign-out has not been confirmed.');
  expect(server.fixture.fake.facts.calls.signOut).toBe(1); expect(server.fixture.fake.revoked.size).toBe(0);
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click(); await denied(page);
  await expect(page.locator('body')).not.toContainText('You have signed out.');
  expect(server.fixture.fake.facts.calls.signOut).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `evidence/car-finance-qa/screenshots/${info.project.name}-logout-provider-unconfirmed.png`, fullPage: true });
});
