import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';

// Independent actual-workspace acceptance. No app.js shim, API response mocks,
// service substitutes or production flags. Requires supervisor-frozen wiring.
let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>>;
const api = '/api/hamdee/v1';
test.setTimeout(150_000);
test.afterEach(async () => { await server?.close(); });
async function start(car = true) {
  server = await startOwnerBrowserHarness({ migrationFiles: ['006_local_operations_records.up.sql', ...(car ? ['007_local_car_rentals.up.sql'] : [])] });
  await mkdir('evidence/car-finance-qa/screenshots', { recursive: true });
}
async function login(page: Page) {
  await page.goto(server.url + '/workspace/index.html#dashboard');
  await page.getByLabel('Email', { exact: true }).fill(server.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true, level: 1 })).toBeVisible();
}
async function nav(page: Page, label: string) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.locator('#navigation').getByRole('link', { name: label, exact: true }).click();
}
async function command(module: string, body: unknown) {
  const response = await server.fixture.request('POST', api + '/' + module + '/commands', body, { 'Idempotency-Key': randomUUID() });
  const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result.data;
}
async function state(page: Page, module: string) {
  const response = await page.request.get(server.url + api + '/' + module + '?month=2026-10&asOf=2026-10-31');
  const result = await response.json(); expect(response.status(), JSON.stringify(result)).toBe(200); return result.data;
}
async function seed() {
  await server.fixture.login();
  const vehicle = await command('car-rentals', { action: 'create-vehicle', registration: 'SYNTHETIC-INDEPENDENT-CAR', make: 'Synthetic', model: 'Independent UI', status: 'active' });
  const agreement = await command('car-rentals', { action: 'create-agreement', vehicleId: vehicle.id, agreementKey: randomUUID(), customerName: 'Synthetic independent UI customer', startDate: '2026-10-01', endDate: '2026-10-31', agreedAmount: '100', currency: 'QAR', billingPeriod: 'Explicit whole saved term total' });
  const receipt = await command('car-rentals', { action: 'record-collection', agreementId: agreement.id, receiptKey: randomUUID(), receivedDate: '2026-10-02', amount: '30', currency: 'QAR', method: 'cash', reference: 'SYNTHETIC-INDEPENDENT-CASH30' });
  return { vehicle, agreement, receipt };
}
async function save(page: Page) {
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function opening(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Account name', { exact: true }).fill(name);
  await dialog.getByLabel('Account type', { exact: true }).selectOption('cash');
  await dialog.getByLabel('Currency', { exact: true }).fill('QAR');
  await dialog.getByLabel('Opening balance date', { exact: true }).fill('2026-10-01');
  await dialog.getByLabel('Owner-confirmed opening amount', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(dialog).toBeVisible();
  await dialog.getByLabel('I confirm this actual opening amount and date, including explicit zero if appropriate.', { exact: true }).check();
  await save(page); await expect(page.getByRole('region', { name: 'Cash account register', exact: true })).toContainText(name);
}

test('Independent full workspace: enabled car route reads real records, partial bank/cheque collections and one maintenance save persist', async ({ page }, info) => {
  await start(); const seeded = await seed(); await login(page); await nav(page, 'Car Rentals');
  await expect(page.getByRole('region', { name: 'Vehicle register', exact: true })).toContainText('SYNTHETIC-INDEPENDENT-CAR');
  for (const [amount, method] of [['20', 'bank'], ['10', 'cheque']]) {
    await page.getByRole('button', { name: 'Record collection', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('Rental term', { exact: true }).selectOption(seeded.agreement.id);
    await dialog.getByLabel('Receipt date', { exact: true }).fill('2026-10-10');
    await dialog.getByLabel('Collected amount', { exact: true }).fill(amount); await dialog.getByLabel('Payment method', { exact: true }).selectOption(method);
    await save(page);
  }
  await page.getByRole('button', { name: 'Record maintenance cost', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Cost date', { exact: true }).fill('2026-10-11');
  await page.getByRole('dialog').getByLabel('Actual recorded cost', { exact: true }).fill('12.5');
  await page.getByRole('dialog').getByLabel('Currency', { exact: true }).fill('QAR');
  await page.getByRole('dialog').getByLabel('Cost / work description', { exact: true }).fill('Synthetic one independent maintenance cost');
  await save(page); await page.reload();
  await expect(page.getByRole('region', { name: 'Car rental balances', exact: true })).toContainText('QAR 50');
  const cars = await state(page, 'car-rentals'); expect(cars.collections).toHaveLength(3); expect(cars.expenses).toHaveLength(1);
  expect(cars.balances[0]).toMatchObject({ agreedAmount: '100', collectedAmount: '50', outstandingAmount: '50', pendingChequeAmount: '10' });
  expect(cars.summary[0]).toMatchObject({ cashCollected: '50', recordedCosts: '12.5', recordedComparison: '37.5' });
  expect((await state(page, 'company-finance')).accounts).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `evidence/car-finance-qa/screenshots/${info.project.name}-actual-car-workspace.png`, fullPage: true });
});

test('Independent full workspace: explicit zero openings, original car receipt, transfer, duplicate rejection and personal scope reconcile after refresh/Back', async ({ page }, info) => {
  await start(); const seeded = await seed(); await login(page);
  await nav(page, 'Company Finance'); await opening(page, 'Synthetic independent company cash');
  const companyId = (await state(page, 'company-finance')).accounts[0].id;
  await nav(page, 'Personal Finance'); await opening(page, 'Synthetic independent personal cash');
  const personalId = (await state(page, 'personal-finance')).accounts[0].id;
  await nav(page, 'Company Finance');
  await page.getByRole('button', { name: 'Receive existing receipt', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Account', { exact: true }).selectOption(companyId);
  await page.getByRole('dialog').getByLabel('Original receipt', { exact: true }).selectOption('car-rental:' + seeded.receipt.id);
  await page.getByRole('dialog').getByLabel('I confirm this receipt was actually received into the selected account.', { exact: true }).check(); await save(page);
  await expect(page.getByRole('button', { name: 'Receive existing receipt', exact: true })).toBeDisabled();
  const transfer = async () => {
    await page.getByRole('button', { name: 'Transfer funds', exact: true }).click();
    await page.getByRole('dialog').getByLabel('To owner account', { exact: true }).selectOption(personalId);
    await page.getByRole('dialog').getByLabel('Transfer date', { exact: true }).fill('2026-10-12');
    await page.getByRole('dialog').getByLabel('Transfer amount', { exact: true }).fill('10');
    await page.getByRole('dialog').getByLabel('Unique transfer reference', { exact: true }).fill('SYNTHETIC-INDEPENDENT-TRANSFER10');
  };
  await transfer(); await save(page); await transfer();
  await page.getByRole('dialog').getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(/already recorded/i);
  await expect(page.getByRole('dialog').getByLabel('Transfer amount', { exact: true })).toHaveValue('10');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await state(page, 'company-finance')).totals[0]).toMatchObject({ opening: '0', receipts: '30', transfersOut: '10', balance: '20' });
  await nav(page, 'Personal Finance'); await expect(page.getByRole('region', { name: 'Cash account register', exact: true })).not.toContainText('Synthetic independent company cash');
  expect((await state(page, 'personal-finance')).totals[0]).toMatchObject({ opening: '0', receipts: '0', transfersIn: '10', balance: '10' });
  await page.reload(); await expect(page.getByRole('heading', { name: 'Personal Finance', exact: true, level: 1 })).toBeVisible();
  await nav(page, 'Car Rentals'); await page.goBack(); await expect(page.getByRole('heading', { name: 'Personal Finance', exact: true, level: 1 })).toBeVisible();
  expect((await state(page, 'car-rentals')).balances[0]).toMatchObject({ collectedAmount: '30', outstandingAmount: '70' });
  const balances = page.getByRole('region', { name: 'Cash account balances', exact: true });
  await expect(balances).toContainText('QAR 10');
  if (info.project.name === 'mobile') {
    await balances.focus(); for (let step = 0; step < 20; step++) await page.keyboard.press('ArrowRight');
    await expect.poll(() => balances.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `evidence/car-finance-qa/screenshots/${info.project.name}-actual-personal-workspace.png`, fullPage: true });
});

test('Independent full workspace: without007 Staff and finance remain live while Car stays disabled and direct car route fails closed', async ({ page }, info) => {
  await start(false); await login(page);
  await nav(page, 'Staff Collections'); await expect(page.getByRole('region', { name: 'Collector register', exact: true })).toBeVisible();
  await nav(page, 'Company Finance'); await expect(page.getByRole('region', { name: 'Cash account register', exact: true })).toBeVisible();
  await nav(page, 'Personal Finance'); await expect(page.getByRole('region', { name: 'Cash account register', exact: true })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true }); if (await menu.isVisible()) await menu.click();
  // The safe server error intentionally does not reveal whether storage is
  // missing or temporarily unreachable. Retry may recheck availability, but
  // cannot expose a destination before a successful authorized response.
  const unavailable = page.locator('#navigation').getByRole('button', { name: /^Car Rentals (Unavailable|Retry)$/ });
  await expect(unavailable).toBeVisible(); expect(await unavailable.getAttribute('href')).toBeNull();
  await expect(page.locator('#navigation').getByRole('link', { name: 'Car Rentals', exact: true })).toHaveCount(0);
  if ((await unavailable.textContent())?.includes('Retry')) await expect(unavailable).toHaveAttribute('data-action', 'retry-modules');
  else await expect(unavailable).toBeDisabled();
  await page.goto(server.url + '/workspace/index.html#car-rentals'); await expect(page.locator('#main')).toContainText(/unavailable/i);
  await nav(page, 'Staff Collections'); await expect(page.getByRole('region', { name: 'Collector register', exact: true })).toBeVisible();
  await page.screenshot({ path: `evidence/car-finance-qa/screenshots/${info.project.name}-car007-absent.png`, fullPage: true });
});

test('Independent full workspace: completed car write delayed across route reset and logout cannot resurrect protected UI', async ({ page }) => {
  await start(); await seed(); await login(page); await nav(page, 'Car Rentals');
  let release!: () => void, entered!: () => void, delivered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; }), done = new Promise<void>(resolve => { delivered = resolve; });
  let held = false, heldStatus = 0;
  await page.route('**/api/hamdee/v1/car-rentals/commands', async (route: Route) => {
    if (held) { await route.continue(); return; } held = true;
    const response = await route.fetch(); heldStatus = response.status(); entered(); await hold;
    try { await route.fulfill({ response }); } catch { /* Route reset/logout may abort the browser request. */ } finally { delivered(); }
  });
  try {
    await page.getByRole('button', { name: 'Record collection', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Receipt date', { exact: true }).fill('2026-10-10');
    await page.getByRole('dialog').getByLabel('Collected amount', { exact: true }).fill('20');
    await page.getByRole('dialog').getByLabel('Payment method', { exact: true }).selectOption('bank');
    await page.getByRole('dialog').getByRole('button', { name: 'Save record', exact: true }).click(); await ready; expect(heldStatus).toBe(200);
    await page.goto(server.url + '/workspace/index.html#dashboard');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Business Overview', exact: true, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    release(); await done; await expect(page.getByRole('region', { name: 'Car rental balances', exact: true })).toHaveCount(0);
    await page.reload(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    const denied = await page.request.get(server.url + api + '/car-rentals?month=2026-10&asOf=2026-10-31');
    expect(denied.status()).toBe(401);
    expect(denied.headers()['set-cookie']).toMatch(/hamdee_csrf=;[\s\S]*Max-Age=0/i);
    // The direct API probe shares the browser cookie jar and clears its CSRF
    // cookie. Renew through the real UI before the next explicit sign-in.
    await page.getByRole('button', { name: 'Check session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await login(page); const saved = await state(page, 'car-rentals');
    expect(saved.collections).toHaveLength(2); expect(saved.balances[0].collectedAmount).toBe('50');
  } finally { release(); }
});

test('Independent full workspace: reversing a transfer retains its reason and originals, restores both ledgers and respects cutoffs', async ({ page }) => {
  await start(); await server.fixture.login();
  const account = async (scope: string, openingAmount: string) => command(scope + '-finance', { action: 'create-account', name: 'Synthetic reversal ' + scope, scope, currency: 'QAR', kind: 'cash', openingDate: '2026-10-01', openingAmount, ownerConfirmedOpening: true });
  const company = await account('company', '30'), personal = await account('personal', '0');
  await command('company-finance', { action: 'transfer', fromAccountId: company.id, toAccountId: personal.id, transferredOn: '2026-10-12', amount: '10', reference: 'SYNTHETIC-INDEPENDENT-REVERSE10' });
  await login(page); await nav(page, 'Company Finance');
  await page.getByRole('button', { name: 'Reverse entry', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Reversal date', { exact: true }).fill('2026-10-13');
  await page.getByRole('dialog').getByLabel('Correction reason', { exact: true }).fill('SYNTHETIC independent transfer reversal; retain originals.'); await save(page);
  const companyState = await state(page, 'company-finance'), personalState = await state(page, 'personal-finance');
  expect(companyState.totals[0]).toMatchObject({ balance: '30', receipts: '0' }); expect(personalState.totals[0]).toMatchObject({ balance: '0', receipts: '0' });
  await expect(page.getByRole('region', { name: 'Monthly cash statement', exact: true })).toContainText('SYNTHETIC independent transfer reversal; retain originals.');
  const cutoff = await page.request.get(server.url + api + '/company-finance?month=2026-10&asOf=2026-10-12'); expect(cutoff.status()).toBe(200);
  expect((await cutoff.json()).data.totals[0].balance).toBe('20');
  const rows = await server.fixture.pg!.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.ops_money WHERE entry_kind=\'reversal\''); expect(rows.rows[0].n).toBe(2);
});
