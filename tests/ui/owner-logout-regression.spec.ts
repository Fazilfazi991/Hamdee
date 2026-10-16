import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startOwnerBrowserHarness, ownerQaDeferred } from '../support/owner-crm-harness';

let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
const privateName = 'SYNTHETIC_PRIVATE_LOGOUT_RECORD';
test.setTimeout(60_000);
test.beforeEach(async () => {
  server = await startOwnerBrowserHarness(); await server.fixture.login();
  const result = await server.fixture.request('POST', '/api/hamdee/v1/properties', { name: privateName }, { 'Idempotency-Key': randomUUID() });
  expect(result.status).toBe(201);
});
test.afterEach(async () => { await server?.close(); });

async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html#dashboard');
  await page.getByLabel(/email/i).fill(server.fixture.inputs.email);
  await page.getByLabel(/password/i).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name: 'Villas & Properties', exact: true }).click();
  await page.getByRole('button', { name: privateName, exact: true }).click();
  await expect(page.getByRole('heading', { name: privateName, exact: true })).toBeVisible();
}
async function protectedReadsDenied(page: Page) {
  for (const path of ['/dashboard', '/properties', '/rental', '/expenses', '/staff-collections?month=2026-10&asOf=2026-10-16']) {
    const response = await page.request.get(server.url + '/api/hamdee/v1' + path);
    expect(response.status()).toBe(401);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    expect((await response.json()).data).toBeUndefined();
    expect(await response.text()).not.toContain(privateName);
  }
}
async function pendingRefresh(page: Page) {
  const response = await page.request.get(server.url + '/api/hamdee/auth/state');
  const csrf = (await response.json()).data.csrfToken;
  const gate = { entered: ownerQaDeferred<void>(), release: ownerQaDeferred<void>() };
  server.fixture.fake.facts.verifyGate = gate;
  const pending = page.request.post(server.url + '/api/hamdee/auth/refresh', {
    headers: { Origin: server.url, 'X-Hamdee-CSRF': csrf }, data: {}
  });
  await gate.entered.promise;
  return { pending, release() { server.fixture.fake.facts.verifyGate = null; gate.release.resolve(); } };
}

test('Logout UI regression: refresh, Back and direct/copy-cookie reads reveal no private data after confirmed logout', async ({ page, browser }) => {
  await login(page);
  const copied = await browser.newContext(); await copied.addCookies(await page.context().cookies(server.url));
  try {
    const response = page.waitForResponse(r => r.url().endsWith('/api/hamdee/auth/logout') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); expect((await response).status()).toBe(200);
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
    await protectedReadsDenied(page);
    expect((await copied.request.get(server.url + '/api/hamdee/v1/dashboard')).status()).toBe(401);
    await page.goBack(); await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
    await page.reload(); await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
    await protectedReadsDenied(page);
  } finally { await copied.close(); }
});

test('Logout UI regression: late refresh can deliver a cookie but cannot restore private access after revocation', async ({ page }) => {
  await login(page); const late = await pendingRefresh(page);
  try {
    const response = page.waitForResponse(r => r.url().endsWith('/api/hamdee/auth/logout'));
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); expect((await response).status()).toBe(200);
    await expect(page.getByLabel(/email/i)).toBeVisible();
  } finally { late.release(); }
  expect((await late.pending).status()).toBe(200);
  await page.reload(); await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
  await protectedReadsDenied(page);
});

test('Logout UI characterization: unconfirmed provider failure plus late cookie can restore access; confirmed retry invalidates it', async ({ page }) => {
  await login(page); const late = await pendingRefresh(page);
  server.fixture.fake.facts.unconfirmedLogout = true;
  try {
    const response = page.waitForResponse(r => r.url().endsWith('/api/hamdee/auth/logout'));
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); expect((await response).status()).toBe(503);
    await expect(page.getByRole('heading', { name: 'Sign-out unconfirmed', exact: true })).toBeVisible();
    await expect(page.getByText(/Global sign-out has not been confirmed/)).toBeVisible();
    await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
  } finally { late.release(); }
  expect((await late.pending).status()).toBe(200);
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.getByRole('heading', { name: privateName, exact: true })).toBeVisible();
  // This restores an unrevoked session; it is not evidence of successful logout.
  server.fixture.fake.facts.unconfirmedLogout = false;
  const response = page.waitForResponse(r => r.url().endsWith('/api/hamdee/auth/logout'));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); expect((await response).status()).toBe(200);
  await page.reload(); await expect(page.getByLabel(/email/i)).toBeVisible();
  await protectedReadsDenied(page);
});
