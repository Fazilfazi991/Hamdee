import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { startOwnerBrowserHarness } from '../support/owner-crm-harness';
import { StaffCollectionsService } from '../../src/staff-collections';
import { CompanyFinanceService } from '../../src/company-finance';

// Independent navigation acceptance. Real loopback owner HTTP and PGlite;
// no production flag, deployed environment, browser profile or auth shortcut.
// Run only after the Coordinator-reviewed navigation delta is frozen and bound.
let server: Awaited<ReturnType<typeof startOwnerBrowserHarness>> | undefined;
const api = '/api/hamdee/v1', coreNames = ['Dashboard', 'Villas & Properties', 'Expenses', 'Reports'];
const sidebarOrder = ['Dashboard', 'Villas & Properties', 'Car Rentals', 'Staff Collections', 'Expenses', 'Company Finance', 'Personal Finance', 'Partners & Investments', 'Reports'];
const unfinishedNames = ['Car Rentals', 'Company Finance', 'Personal Finance', 'Partners & Investments'];
test.setTimeout(120_000);
test.beforeEach(async () => { await mkdir('evidence/navigation-qa/screenshots', { recursive: true }); });
test.afterEach(async () => { await server?.close(); server = undefined; });
async function start(mode: 'ready' | 'absent' | 'no-schema' = 'ready') {
  server = await startOwnerBrowserHarness(mode === 'absent' ? { operationsFactory: () => ({}) } : {
    ...(mode === 'ready' ? { migrationFiles: ['006_local_operations_records.up.sql'] } : {}),
    operationsFactory: properties => ({ staffCollections: new StaffCollectionsService(properties), companyFinance: new CompanyFinanceService(properties) })
  }); return server;
}
async function credentials(page: Page, hash = '#dashboard') {
  await page.goto(server!.url + '/workspace/index.html' + hash);
  await page.getByLabel('Email', { exact: true }).fill(server!.fixture.inputs.email);
  await page.getByLabel('Password', { exact: true }).fill(server!.fixture.inputs.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function login(page: Page) {
  await credentials(page); await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
}
async function drawer(page: Page) {
  const button = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await button.isVisible() && await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
async function nav(page: Page, name: string | RegExp) {
  await drawer(page); await page.locator('#navigation').getByRole('link', { name, exact: typeof name === 'string' }).click();
}
async function noDeadSidebar(page: Page, staff: boolean) {
  await drawer(page); const navigation = page.locator('#navigation');
  const labels = (await navigation.getByRole('link').allTextContents()).map(label => label.trim());
  expect(labels.sort()).toEqual((staff ? [...coreNames, 'Staff Collections'] : [...coreNames]).sort());
  const entries = navigation.locator('a, button, [aria-disabled="true"]');
  await expect(entries).toHaveCount(9);
  expect((await entries.allTextContents()).map(text => text.trim().replace(/\s*(Unavailable|Checking…|Retry)\s*$/i, '').trim())).toEqual(sidebarOrder);
  for (const name of [...unfinishedNames, ...(staff ? [] : ['Staff Collections'])]) {
    await expect(navigation.getByRole('link', { name, exact: true })).toHaveCount(0);
    const disabled = navigation.locator('button, [aria-disabled="true"]').filter({ hasText: name });
    await expect(disabled).toHaveCount(1); await expect(disabled).toBeVisible();
    await expect(disabled).toContainText(/Unavailable|Checking…|Retry/i);
    expect(await disabled.getAttribute('href')).toBeNull();
    expect(await disabled.evaluate(element => element.tagName !== 'A' && element.getAttribute('role') !== 'link' && (element.matches('button:disabled') || element.getAttribute('data-action') === 'retry-modules' || (element.getAttribute('aria-disabled') === 'true' && element.tabIndex < 0)))).toBeTruthy();
  }
  for (const href of await navigation.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))) expect(href).toMatch(/^#[a-z][a-z-]*(?:\/[^\s]+)?$/);
}
async function command(route: string, body: Record<string, unknown>, expected = 200) {
  const response = await server!.fixture.request('POST', api + route, body, { 'Idempotency-Key': randomUUID() });
  const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(expected); return value.data;
}
async function property(suffix: string, populated = true) {
  await server!.fixture.login(false);
  const name = 'Synthetic Navigation Villa ' + suffix, created = await command('/properties', { name }, 201);
  if (!populated) return { ...created, name, suffix };
  const room = await command('/rental', { action: 'create-room', propertyId: created.id, code: 'NAV-' + suffix, label: 'Synthetic navigation room ' + suffix });
  const tenantName = 'Synthetic Navigation Tenant ' + suffix, tenant = await command('/rental', { action: 'create-tenant', name: tenantName, email: 'nav-' + suffix.toLowerCase() + '@example.invalid' });
  const agreement = await command('/rental', { action: 'create-agreement', roomId: room.id, tenantId: tenant.id, monthlyRent: '100', currency: 'QAR', depositRequired: '25', dueTerms: 'Synthetic explicit date only', startDate: '2026-10-01', endDate: '2026-10-31' });
  const formerName = 'Synthetic Navigation Former Tenant ' + suffix, former = await command('/rental', { action: 'create-tenant', name: formerName, email: 'former-nav-' + suffix.toLowerCase() + '@example.invalid' });
  await command('/rental', { action: 'create-agreement', roomId: room.id, tenantId: former.id, monthlyRent: '80', currency: 'QAR', depositRequired: '0', dueTerms: 'Synthetic historical agreement only', startDate: '2026-09-01', endDate: '2026-09-30' });
  const due = await command('/rental', { action: 'issue-due', agreementId: agreement.id, period: '2026-10', dueDate: '2026-10-05', amount: '100' });
  for (const [kind, method, amount, label] of [['rent', 'cash', '10', 'CASH'], ['deposit', 'cash', '5', 'DEP'], ['rent', 'cheque', '7', 'CHEQUE']]) await command('/rental', {
    action: 'record-collection', agreementId: agreement.id, kind, method, amount, receivedDate: '2026-10-10', reference: `SYNTHETIC-NAV-${suffix}-${label}`,
    allocations: kind === 'rent' && method === 'cash' ? [{ dueId: due.id, amount }] : []
  });
  for (const [category, amount] of [['landlord', '4'], ['kahramaa', '2']]) await command('/expenses', { action: 'record-expense', propertyId: created.id, category, expenseDate: '2026-10-10', amount, currency: 'QAR', vendorName: `Synthetic ${category} ${suffix}`, reference: `SYNTHETIC-NAV-${suffix}-${category}` });
  const job = await command('/expenses', { action: 'create-job', propertyId: created.id, roomId: room.id, workType: 'Synthetic navigation check', issue: 'Synthetic maintenance issue ' + suffix, openedDate: '2026-10-10', vendorName: 'Synthetic maintenance ' + suffix });
  await command('/expenses', { action: 'complete-job', jobId: job.id, expectedVersion: 1, completedDate: '2026-10-10', workCompleted: 'Synthetic completed work ' + suffix, actualCost: '3', currency: 'QAR', warrantyStartDate: '2026-10-10', warrantyEndDate: '2026-11-10', reference: 'SYNTHETIC-NAV-' + suffix + '-JOB' });
  return { ...created, name, suffix, tenantName, formerName };
}
async function selectProperty(page: Page, record: { name: string }) {
  await nav(page, 'Villas & Properties');
  await page.getByRole('button', { name: record.name, exact: true }).or(page.getByRole('link', { name: record.name, exact: true })).first().click();
  await expect(page.locator('#main')).toContainText(record.name);
}
const sections = [
  { name: /^Rooms(?:\s*[&/]\s*(?:units|rentals))?$/i, token: 'NAV-A' },
  { name: /^Tenants$/i, token: 'Synthetic Navigation Tenant A' },
  { name: /^(?:Rental\s+)?agreements$/i, token: 'Synthetic Navigation Tenant A' },
  { name: /^Collections$/i, token: 'SYNTHETIC-NAV-A-CASH' },
  { name: /^Cheques?(?:\s+desk)?$/i, token: 'SYNTHETIC-NAV-A-CHEQUE' },
  { name: /^(?:Security\s+)?deposits(?:\s*&\s*advances)?$/i, token: 'SYNTHETIC-NAV-A-DEP' },
  { name: /^Landlord payments$/i, token: 'Synthetic landlord A' },
  { name: /^Utilities$/i, token: 'Synthetic kahramaa A' },
  { name: /^Maintenance$/i, token: 'Synthetic maintenance issue A' },
  { name: /^(?:Audit\s+)?history$/i, token: 'create' }
];
async function section(page: Page, name: RegExp, propertyId: string) {
  if (name.test('Audit history')) {
    await page.getByRole('button', { name: 'Audit history', exact: true }).click();
    await expect(page).toHaveURL(server!.url + '/workspace/index.html#properties/' + propertyId + '/history');
    return '#properties/' + propertyId + '/history';
  }
  const link = page.locator('#detail-content').getByRole('link', { name });
  if (!await link.count()) {
    const expenses = name.test('Landlord payments') || name.test('Utilities') || name.test('Maintenance');
    await page.getByRole('button', { name: expenses ? 'Expenses & maintenance' : 'Rooms & rentals', exact: true }).click();
  }
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute('href'); expect(href).toContain(propertyId); await link.click();
  await expect(page).toHaveURL(server!.url + '/workspace/index.html' + href);
  await expect(page.locator('#detail-content').getByRole('link', { name })).toHaveAttribute('aria-current', 'page'); return href!;
}
function gate() {
  let release!: () => void, entered!: () => void, delivered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; }), done = new Promise<void>(resolve => { delivered = resolve; });
  return { hold, ready, done, release, entered, delivered };
}
async function holdStaff(page: Page) {
  const g = gate(); let delayed = false, status = 0;
  await page.route('**/api/hamdee/v1/staff-collections?*', async (route: Route) => {
    if (delayed) { await route.continue(); return; } delayed = true;
    const response = await route.fetch(); status = response.status(); g.entered(); await g.hold;
    try { await route.fulfill({ response }); } catch { /* Aborted on logout is an expected outcome. */ } finally { g.delivered(); }
  }); return { ...g, status: () => status };
}

test('Navigation independent: absent operations module keeps working core links and visible disabled unfinished sections', async ({ page }) => {
  await start('absent'); await login(page); await noDeadSidebar(page, false);
  await nav(page, 'Expenses'); await expect(page.getByRole('heading', { name: 'Property expenses', exact: true, level: 1 })).toBeVisible();
  await nav(page, 'Reports'); await expect(page.getByRole('heading', { name: 'Monthly property report', exact: true })).toBeVisible();
  await nav(page, 'Villas & Properties'); await expect(page.getByRole('button', { name: 'Add property', exact: true })).toBeVisible();
  await nav(page, 'Dashboard'); await expect(page.getByRole('heading', { name: 'Property overview', exact: true })).toBeVisible();
});

test('Navigation independent: real service without006 is not eligible for Staff navigation', async ({ page }) => {
  await start('no-schema'); await login(page); await noDeadSidebar(page, false);
  const response = await page.request.get(server!.url + api + '/staff-collections?month=2026-10&asOf=2026-10-16'); expect(response.status()).toBeGreaterThanOrEqual(400);
});

test('Navigation independent: Staff appears only after actual validated owner module GET completes', async ({ page }) => {
  await start(); const held = await holdStaff(page);
  try {
    await credentials(page); await held.ready; expect(held.status()).toBe(200);
    await expect(page.locator('#navigation a[href="#staff-collections"]')).toHaveCount(0);
    await noDeadSidebar(page, false);
    held.release(); await held.done; await expect(page.locator('#navigation a[href="#staff-collections"]')).toHaveCount(1);
    await noDeadSidebar(page, true); await nav(page, 'Staff Collections');
    await expect(page.getByRole('region', { name: 'Collector register', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add collector', exact: true })).toBeEnabled();
  } finally { held.release(); }
});

test('Navigation independent: malformed200 capability response cannot expose Staff as a working destination', async ({ page }) => {
  await start(); await page.route('**/api/hamdee/v1/staff-collections?*', async route => {
    const response = await route.fetch(); expect(response.status()).toBe(200);
    await route.fulfill({ status: 200, json: { data: { moneyUnit: 'unsupported', collectors: [] } } });
  }); await login(page); await noDeadSidebar(page, false);
});

test('Navigation independent: scoped property children, Back/direct URLs and selection isolate two real property record sets', async ({ page }, info) => {
  await start(); const a = await property('A'), b = await property('B'); await login(page); await selectProperty(page, a);
  let first = '', second = '';
  for (const [index, destination] of sections.entries()) {
    const href = await section(page, destination.name, a.id); if (index === 0) first = href; if (index === 3) second = href;
    await expect.poll(() => page.locator('#main').innerText()).toContain(a.name); await expect.poll(() => page.locator('#main').innerText()).toContain(destination.token);
    if (destination.name.test('Tenants')) await expect.poll(() => page.locator('#main').innerText()).toContain(a.formerName);
    await expect.poll(() => page.locator('#main').innerText()).not.toContain('Synthetic Navigation Tenant B'); await expect.poll(() => page.locator('#main').innerText()).not.toContain('Synthetic Navigation Former Tenant B'); await expect.poll(() => page.locator('#main').innerText()).not.toContain('SYNTHETIC-NAV-B-');
  }
  await section(page, sections[2].name, a.id); await page.getByRole('button', { name: 'Add agreement', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Tenant', { exact: true }).getByRole('option', { name: b.tenantName, exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Close rental dialog', exact: true }).click();
  await page.goto(server!.url + '/workspace/index.html' + first); await expect(page.locator('#main')).toContainText('NAV-A');
  await section(page, sections[3].name, a.id); await expect(page.locator('#main')).toContainText('SYNTHETIC-NAV-A-CASH');
  await page.goBack(); await expect(page).toHaveURL(server!.url + '/workspace/index.html' + first); await expect(page.locator('#main')).toContainText('NAV-A');
  await page.goto(server!.url + '/workspace/index.html' + second); await expect(page.locator('#main')).toContainText('SYNTHETIC-NAV-A-CASH');
  await selectProperty(page, b); await section(page, sections[0].name, b.id); await expect(page.locator('#main')).toContainText('NAV-B'); await expect(page.locator('#main')).not.toContainText('NAV-A');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `evidence/navigation-qa/screenshots/${info.project.name}-selected-property.png`, fullPage: true });
});

test('Navigation independent: legacy public hash destinations remain readable without reintroducing dead sidebar modules', async ({ page }) => {
  await start('absent'); await property('LEGACY'); await login(page);
  for (const [hash, token] of [['#tenants', 'Synthetic Navigation Tenant LEGACY'], ['#collections', 'SYNTHETIC-NAV-LEGACY-CASH'], ['#cheques', 'SYNTHETIC-NAV-LEGACY-CHEQUE'], ['#maintenance', 'Synthetic maintenance issue LEGACY'], ['#expenses', 'Synthetic landlord LEGACY'], ['#reports', 'Synthetic Navigation Villa LEGACY']]) {
    await page.goto(server!.url + '/workspace/index.html' + hash);
    await expect(page.locator('#main')).not.toContainText(/Module unavailable|Unknown route|Not found/i);
    await expect(page.locator('#main')).toContainText(token);
    await noDeadSidebar(page, false);
  }
});

test('Navigation independent: empty and archived property routes retain context and actionable history', async ({ page }) => {
  await start(); const unrelated = await property('OTHER'), empty = await property('EMPTY', false), archived = await property('ARCHIVED', false);
  const response = await server!.fixture.request('POST', api + '/properties/' + archived.id + '/archive', { reason: 'Synthetic navigation archive' }, {
    'Idempotency-Key': randomUUID(), 'X-Hamdee-Property-Revision': `"property:${archived.id}:1"`
  }); expect(response.status).toBe(200);
  await login(page); await selectProperty(page, empty); await section(page, sections[0].name, empty.id);
  await expect(page.locator('#main')).toContainText(/No saved records(?: yet)?|No rooms(?: yet| found| recorded)?/i); await expect(page.locator('#main')).toContainText(empty.name);
  await section(page, sections[1].name, empty.id);
  await expect.poll(() => page.locator('#main').innerText()).not.toContain(unrelated.tenantName);
  await expect.poll(() => page.locator('#main').innerText()).not.toContain(unrelated.formerName);
  await expect(page.getByRole('region', { name: 'Tenant register', exact: true })).toContainText('No saved records yet.');
  await expect(page.getByRole('button', { name: 'Add tenant', exact: true })).toBeEnabled();
  await page.goto(server!.url + '/workspace/index.html#properties/' + archived.id); await expect(page.locator('#main')).toContainText(archived.name);
  await section(page, sections.at(-1)!.name, archived.id); await expect(page.locator('#main')).toContainText('Synthetic navigation archive');
  await expect(page.locator('#main')).not.toContainText(/Module unavailable|Unknown route|Not found/i);
});

test('Navigation independent: keyboard drawer navigation, Escape and focus return work at mobile and desktop', async ({ page }, info) => {
  await start('absent'); await login(page); const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) {
    await menu.focus(); await page.keyboard.press('Enter'); await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape'); await expect(menu).toHaveAttribute('aria-expanded', 'false'); await expect(menu).toBeFocused();
    await page.keyboard.press('Enter'); await expect(menu).toHaveAttribute('aria-expanded', 'true');
  }
  const reports = page.locator('#navigation').getByRole('link', { name: 'Reports', exact: true }); await reports.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Monthly property report', exact: true })).toBeVisible();
  if (await menu.isVisible()) {
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.focus(); await page.keyboard.press('Enter'); await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#navigation').getByRole('link', { name: 'Reports', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `evidence/navigation-qa/screenshots/${info.project.name}-keyboard.png`, fullPage: true });
});

test('Navigation independent: late validated capability response after logout cannot resurrect Staff menu or protected context', async ({ page }) => {
  await start(); const held = await holdStaff(page);
  try {
    await credentials(page); await held.ready; expect(held.status()).toBe(200);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    held.release(); await held.done;
    await expect(page.locator('#navigation a[href="#staff-collections"]')).toHaveCount(0);
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add collector', exact: true })).toHaveCount(0);
    await page.reload(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  } finally { held.release(); }
});
