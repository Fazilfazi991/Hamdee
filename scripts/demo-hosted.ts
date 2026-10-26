// Explicit operator entrypoint for the separate HAMDEE DEMO Preview only.
// Never imported by the application. No fake provider, DB URL, generic .env,
// service-role key, Production endpoint or automatic hosted execution exists.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { seedDemoDataset, demoOverview, type DemoCommandTransport } from '../tests/support/demo-dataset';

export const DEMO_HOSTED_PROJECT = 'jfynuafwsympxxpkqags';
export const DEMO_HOSTED_ORIGIN = 'https://hamdee-git-codex-hamdee-demo-preview-faziils-projects.vercel.app';
export interface DemoHostedTarget { projectRef: string; origin: string; ownerId: string }
export interface DemoHostedPrivateInput extends DemoHostedTarget { email: string; password: string; trustedOidcToken?: string }
/** Operator-side pacing only. Never changes server limits or retries a failure.
 * Each command can perform several live identity checks; bulk writes must leave
 * room for those checks and the read-only destination/reconciliation requests. */
export function paceDemoCommands(transport:DemoCommandTransport,wait:()=>Promise<void>=()=>delay(5_000)):DemoCommandTransport {
  return {login:()=>transport.login(),async request(method,route,body,headers){
    if(method==='POST')await wait();
    return transport.request(method,route,body,headers);
  }};
}
export function verifyDemoHostedTarget(target: DemoHostedTarget) {
  assert.equal(target.projectRef, DEMO_HOSTED_PROJECT, 'Only the separately approved DEMO project is permitted');
  assert.equal(target.origin, DEMO_HOSTED_ORIGIN, 'Only the separately approved DEMO Preview origin is permitted');
  assert.match(target.ownerId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, 'Verify the separate managed owner binding first');
}
export function createDemoHostedTransport(input: DemoHostedPrivateInput, execute: typeof fetch = fetch): DemoCommandTransport {
  verifyDemoHostedTarget(input);
  assert.ok(input.email && input.password, 'The owner must privately supply the separate DEMO sign-in');
  const jar = new Map<string, string>(); let csrf = '', authenticated = false;
  const request = async (method: string, route: string, body?: unknown, extra: Record<string, string> = {}) => {
    assert.match(route, /^\/api\/hamdee\/(auth\/(state|login|logout)|v1\/(session|dashboard|properties|rental|expenses|staff-collections|car-rentals|company-finance|personal-finance|partners)(\/commands)?)(\?[^#]*)?$/);
    assert.ok(method === 'GET' || method === 'POST');
    assert.ok(Object.keys(extra).every(key => key === 'Idempotency-Key'), 'Only the stable command key may be supplied');
    const headers = new Headers({ Origin: input.origin, 'Content-Type': 'application/json', Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '), 'X-Hamdee-CSRF': csrf, ...extra });
    if (input.trustedOidcToken) headers.set('x-vercel-trusted-oidc-idp-token', input.trustedOidcToken);
    const response = await execute(input.origin + route, { method, headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.status < 300 || response.status >= 400, 'DEMO authentication/records must never follow redirects');
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(';')[0], split = first.indexOf('='), key = first.slice(0, split), value = first.slice(split + 1);
      if (!['hamdee_owner', 'hamdee_csrf'].includes(key)) continue;
      if (!value || /max-age=0(?:;|$)/i.test(cookie)) jar.delete(key); else jar.set(key, value);
    }
    const parsed = await response.clone().json().catch(() => null);
    if (typeof parsed?.data?.csrfToken === 'string') csrf = parsed.data.csrfToken;
    return response;
  };
  return {
    async login() {
      const state = await request('GET', '/api/hamdee/auth/state');
      assert.equal(state.status, 200, 'Protected DEMO authentication endpoint is required');
      // Verify server-owned target attestation BEFORE transmitting a password.
      // The DEMO-only deployment adds these fixed headers after its literal
      // project/branch/origin checks; shared real-data Preview cannot satisfy it.
      assert.equal(state.headers.get('x-hamdee-project-ref'), DEMO_HOSTED_PROJECT);
      assert.equal(state.headers.get('x-hamdee-environment'), 'isolated-demo');
      const signedIn = await request('POST', '/api/hamdee/auth/login', { email: input.email, password: input.password });
      assert.equal(signedIn.status, 200, 'Separate DEMO owner sign-in failed');
      assert.equal((await signedIn.json()).data.state, 'authenticated');
      const session = await request('GET', '/api/hamdee/v1/session'); assert.equal(session.status, 200);
      const data = (await session.json()).data;
      assert.equal(data.id, input.ownerId, 'Managed DEMO owner binding differs');
      assert.equal(data.authenticationProvider, 'managed-supabase-owner', 'A deployable fake identity is not permitted');
      authenticated = true;
    },
    async request(method, route, body, headers) {
      assert.ok(authenticated, 'Sign into the separate managed DEMO owner first');
      return request(method, route, body, headers);
    }
  };
}

export async function verifyDemoSeedDestination(transport: DemoCommandTransport) {
  const propertyResponse = await transport.request('GET', '/api/hamdee/v1/properties?archiveState=all&limit=100');
  assert.equal(propertyResponse.status, 200); const properties = await propertyResponse.json();
  assert.equal(properties.nextCursor, null, 'Unexpected additional property pages');
  for (const property of properties.data) assert.match(property.name, /^DEMO\b/, 'A non-DEMO property prohibits seeding');
  const rental = await demoOverview(transport, 'rental');
  for (const tenant of rental.tenants) assert.match(tenant.name, /^DEMO\b/, 'A non-DEMO contact prohibits seeding');
  for (const room of rental.rooms) assert.match(room.code, /^DEMO-/, 'A non-DEMO room prohibits seeding');
  for (const row of [...rental.dues, ...rental.collections]) assert.equal(row.currency, 'XTS', 'Non-test monetary records prohibit seeding');
  const cars = await demoOverview(transport, 'car-rentals');
  for (const car of cars.vehicles) assert.match(car.registration, /^DEMO-ONLY-/);
  for (const row of [...cars.agreements, ...cars.collections, ...cars.expenses]) assert.equal(row.currency, 'XTS');
  for (const module of ['company-finance', 'personal-finance']) {
    const overview = await demoOverview(transport, module);
    for (const account of overview.accounts) { assert.match(account.name, /^DEMO\b/); assert.equal(account.currency, 'XTS'); assert.equal(account.openingAmount, '0'); }
    for (const entry of overview.entries) assert.equal(entry.currency, 'XTS');
  }
  const staff = await demoOverview(transport, 'staff-collections');
  for (const collector of staff.collectors) assert.match(collector.name, /^DEMO\b/);
  for (const row of [...staff.collections, ...staff.handovers]) assert.equal(row.currency, 'XTS');
  const partners = await demoOverview(transport, 'partners');
  for (const partner of partners.partners) assert.match(partner.name, /^DEMO\b/);
  for (const entry of partners.entries) assert.equal(entry.currency, 'XTS');
  const expenses = await demoOverview(transport, 'expenses');
  for (const expense of expenses.expenses) assert.equal(expense.currency, 'XTS');
}

async function main() {
  assert.ok(process.argv.includes('--approved-isolated-demo-seed'), 'Explicit separate-DEMO seeding approval is required');
  assert.ok(process.argv.includes('--execute'), 'No hosted work occurs without the explicit execution flag');
  let stage = 'private_input';
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) { const bytes = Buffer.from(chunk); size += bytes.length; assert.ok(size <= 16_384); chunks.push(bytes); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DemoHostedPrivateInput;
    verifyDemoHostedTarget(input);
    // This short-lived same-project Vercel token is read only when explicitly
    // executing the approved tool, never printed or written to disk. No env
    // file, Production secret or long-lived bypass secret is discovered.
    input.trustedOidcToken ??= process.env.VERCEL_OIDC_TOKEN;
    const transport = createDemoHostedTransport(input);
    stage = 'owner_login'; await transport.login();
    stage = 'destination_preflight'; await verifyDemoSeedDestination(transport);
    // The seeder's login callback reuses this already-verified private session.
    const paced=paceDemoCommands(transport);
    let commands=0;
    stage = 'synthetic_commands'; const data = await seedDemoDataset({ login: async () => {},async request(...args){
      const response=await paced.request(...args);
      if(response.ok&&++commands%10===0)console.log('DEMO progress: '+commands+' synthetic commands verified; paced writes continue.');
      return response;
    }});
    stage = 'reconciliation';
    const staff = await demoOverview(transport, 'staff-collections'), company = await demoOverview(transport, 'company-finance'), personal = await demoOverview(transport, 'personal-finance');
    assert.deepEqual(staff.totals.map((row: { balance: string }) => row.balance).sort(), ['0', '700']);
    const balances = new Map([...company.totals, ...personal.totals].map(row => [row.accountId, row.balance]));
    for (const [i, expected] of ['1300', '1000', '175', '100'].entries()) assert.equal(balances.get(data.accounts[i].id), expected);
    stage = 'logout'; assert.equal((await transport.request('POST', '/api/hamdee/auth/logout', {})).status, 200);
    assert.equal((await transport.request('GET', '/api/hamdee/v1/properties')).status, 401);
    console.log(JSON.stringify({ status: 'DEMO_SEED_VERIFIED', projectRef: DEMO_HOSTED_PROJECT, properties: 1, rooms: 4, contacts: 4, vehicles: 3, collectors: 2, accounts: 4, currency: 'XTS', collectorBalances: ['700', '0'], companyCash: '1300', companyBank: '1000', personalCash: '175', personalBank: '100', logoutDeniedAccess: true }));
  } catch (error) {
    // Fixed-format diagnostics only: never print exceptions, response bodies,
    // submitted credentials, session cookies or tokens.
    const failure=error as {actual?:unknown;message?:unknown};
    const status=typeof failure?.actual==='number'&&Number.isInteger(failure.actual)&&failure.actual>=400&&failure.actual<=599?' HTTP '+failure.actual:'';
    const code=typeof failure?.message==='string'?failure.message.match(/"code":"([A-Z_]{1,64})"/)?.[1]:undefined;
    console.error('DEMO seed stopped at ' + stage + status + (code?' '+code:'') + '. No automatic retry, deletion, reset or Production fallback.'); process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
