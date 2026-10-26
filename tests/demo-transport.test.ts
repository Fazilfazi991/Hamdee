import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerQaFixture } from './support/owner-crm-harness';
import { seedDemoDataset, type DemoCommandTransport } from './support/demo-dataset';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createDemoHostedTransport, paceDemoCommands, verifyDemoHostedTarget, verifyDemoSeedDestination, DEMO_HOSTED_ORIGIN, DEMO_HOSTED_PROJECT } from '../scripts/demo-hosted';
import { ownerQaInputs } from './support/owner-crm-harness';
import { createOwnerApplication } from '../src/owner-runtime';

test('DEMO command list works through login/request-only API transport, without fixture/database/provider access', async t => {
  const f = await createOwnerQaFixture({ migrationFiles: ['006_local_operations_records.up.sql', '007_local_car_rentals.up.sql', '008_local_partner_records.up.sql'] });
  t.after(() => f.close());
  let logins = 0;
  const routes = new Set<string>(), keys = new Set<string>();
  const transport: DemoCommandTransport = {
    async login() { logins++; return f.login(); },
    async request(method, route, body, headers) {
      assert.equal(logins, 1); assert.equal(method, 'POST');
      assert.match(route, /^\/api\/hamdee\/v1\/(properties|rental|expenses|staff-collections\/commands|car-rentals\/commands|company-finance\/commands|personal-finance\/commands|partners\/commands)$/);
      assert.match(headers?.['Idempotency-Key'] ?? '', /^[0-9a-f-]{36}$/);
      assert.ok(!keys.has(headers!['Idempotency-Key'])); keys.add(headers!['Idempotency-Key']); routes.add(route);
      return f.request(method, route, body, headers);
    }
  };
  const result = await seedDemoDataset(transport);
  assert.equal(logins, 1); assert.equal(routes.size, 8); assert.equal(result.rooms.length, 4); assert.equal(result.tenants.length, 4);
  assert.equal(result.vehicles.length, 3); assert.equal(result.collectors.length, 2); assert.equal(result.accounts.length, 4);
});

test('DEMO command list stops immediately on failed private owner sign-in or failed API command; no fallback or retry', async () => {
  let calls = 0;
  await assert.rejects(seedDemoDataset({ login: async () => { throw new Error('owner sign-in required'); }, request: async () => { calls++; throw new Error('must not run'); } }), /owner sign-in required/);
  assert.equal(calls, 0);
  await assert.rejects(seedDemoDataset({ login: async () => {}, request: async () => { calls++; return Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }); } }), /401/);
  assert.equal(calls, 1);
});

const sqlFiles = [
  ['initial_synthetic_development.sql', '8e6893d13d3bd39d246d41aef4208887e02992a820c16e293a1d3f63ab9185c4'],
  ['operations_synthetic_development.sql', 'bcee87ad46132f6d2c65a6afd43b73cc4fc4173060b8a4aeb4437f24368f9f6b'],
  ['car_rental_synthetic_development.sql', 'df732772c12f6b038ba2b0cc72b0fd8b8b4e4b67f293d6170c802f9f5cc93a4b'],
  ['partner_records_development.sql', 'd2158c425c135266d4f8225aa710cf468baf36a8fc2e0cdd9f367b4e2b060513'],
  ['partner_corrections_development.sql', 'e731ae8f266c42f8f735349434cc75270d61c5cff22647d2882c0288ba99496c']
] as const;
const sqlRead = (name: string) => readFile(new URL('../migrations/hosted/' + name, import.meta.url), 'utf8');
test('DEMO SQL is pinned to the isolated project; embedded migration/security logic remains byte-equivalent', async () => {
  for (const [name, sha] of sqlFiles) {
    const original = await sqlRead(name), demo = await sqlRead('demo_' + name);
    assert.equal(createHash('sha256').update(demo).digest('hex'), sha);
    assert.ok(!demo.includes('dytlzfwbgeuhzgzemqsf')); assert.ok(demo.includes('jfynuafwsympxxpkqags'));
    let expected = original.replaceAll('dytlzfwbgeuhzgzemqsf', 'jfynuafwsympxxpkqags');
    if (name === 'operations_synthetic_development.sql') expected = expected.replace('e00dbaff67872d04d53622400872596b596892f1da94529f558fca4f9ca61df0', sqlFiles[0][1]);
    assert.equal(demo, expected, 'Only the project pin and explanatory initial-hash comment may change');
    const tag = name.startsWith('operations_') ? '$reviewed_006$' : name.startsWith('car_') ? '$reviewed_007$' : name.startsWith('partner_records') ? '$reviewed_008$' : name.startsWith('partner_corrections') ? '$reviewed_009$' : null;
    if (tag) assert.equal(demo.split(tag)[1], original.split(tag)[1]);
  }
});
test('DEMO target wrappers install exactly48 local-modeled tables, exclude provider roles and preserve record-free initial state', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001');");
  await pg.exec(await sqlRead('demo_' + sqlFiles[0][0]));
  await pg.exec('ALTER ROLE hamdee_backend LOGIN'); // Disposable model only; real provisioning is private and separately reviewed.
  for (const [name] of sqlFiles.slice(1)) await pg.exec(await sqlRead('demo_' + name));
  const marker = (await pg.query<{ project_ref: string; data_class: string }>('SELECT project_ref,data_class FROM hamdee_private.application_identity')).rows[0];
  assert.equal(marker.project_ref, 'jfynuafwsympxxpkqags'); assert.equal(marker.data_class, 'synthetic_only');
  assert.equal((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='hamdee_private'")).rows[0].n, 48);
  for (const role of ['anon', 'authenticated', 'service_role', 'hamdee_backend']) assert.equal((await pg.query<{ allowed: boolean }>("SELECT has_schema_privilege($1,'hamdee_private','USAGE') AS allowed", [role])).rows[0].allowed, false);
  const counts = await pg.query<{ n: number }>("SELECT (SELECT count(*) FROM hamdee_private.properties)+(SELECT count(*) FROM hamdee_private.tenants)+(SELECT count(*) FROM hamdee_private.rent_collections)+(SELECT count(*) FROM hamdee_private.ops_money)+(SELECT count(*) FROM hamdee_private.app_users) AS n");
  assert.equal(Number(counts.rows[0].n), 0);
});

test('Managed DEMO API transport refuses Production/wrong origins and unverified server target before sending any password', async () => {
  const ownerId = '00000000-0000-4000-8000-000000000001';
  assert.throws(() => verifyDemoHostedTarget({ projectRef: 'dytlzfwbgeuhzgzemqsf', origin: DEMO_HOSTED_ORIGIN, ownerId }));
  assert.throws(() => verifyDemoHostedTarget({ projectRef: DEMO_HOSTED_PROJECT, origin: 'https://hamdee.vercel.app', ownerId }));
  assert.throws(() => verifyDemoHostedTarget({ projectRef: DEMO_HOSTED_PROJECT, origin: DEMO_HOSTED_ORIGIN + '.evil.invalid', ownerId }));
  let calls = 0;
  const transport = createDemoHostedTransport({ projectRef: DEMO_HOSTED_PROJECT, origin: DEMO_HOSTED_ORIGIN, ownerId, email: 'owner@example.invalid', password: 'SYNTHETIC' }, async (_url, options) => {
    calls++; assert.equal(options?.method, 'GET'); assert.equal(options?.body, undefined);
    return Response.json({ data: { state: 'anonymous' } });
  });
  await assert.rejects(transport.login()); assert.equal(calls, 1);
});

test('Managed DEMO transport retains server cookies/CSRF, executes idempotent API commands and logs out without fake deployment mode', async t => {
  const f = await createOwnerQaFixture({ migrationFiles: ['006_local_operations_records.up.sql', '007_local_car_rentals.up.sql', '008_local_partner_records.up.sql'] });
  t.after(() => f.close());
  const app = createOwnerApplication({ ...f.options, policy: { ...f.options.policy, origin: DEMO_HOSTED_ORIGIN, cookieSecure: true }, database: f.database, logger: () => {} });
  const credentials = ownerQaInputs();
  const transport = createDemoHostedTransport({ projectRef: DEMO_HOSTED_PROJECT, origin: DEMO_HOSTED_ORIGIN, ownerId: f.member!.id, email: credentials.email, password: credentials.password, trustedOidcToken: 'SYNTHETIC-LOCAL-TEST-OIDC' }, async (value, options) => {
    const url = new URL(String(value)); assert.equal(url.origin, DEMO_HOSTED_ORIGIN); assert.equal(options?.redirect, 'manual');
    const request = new Request(url, options); assert.equal(request.headers.get('x-vercel-trusted-oidc-idp-token'), 'SYNTHETIC-LOCAL-TEST-OIDC');
    const response = url.pathname.startsWith('/api/hamdee/auth/') ? await app.handleAuth(request) : await app.handleProperties(request);
    const headers = new Headers(response.headers); headers.set('x-hamdee-project-ref', DEMO_HOSTED_PROJECT); headers.set('x-hamdee-environment', 'isolated-demo');
    return new Response(response.body, { status: response.status, headers });
  });
  await transport.login(); await verifyDemoSeedDestination(transport);
  const seeded = await seedDemoDataset({ login: async () => {}, request: transport.request.bind(transport) });
  await verifyDemoSeedDestination(transport);
  assert.equal(seeded.rooms.length, 4); assert.equal(seeded.accounts.length, 4);
  assert.equal((await transport.request('POST', '/api/hamdee/auth/logout', {})).status, 200);
  assert.equal((await transport.request('GET', '/api/hamdee/v1/properties')).status, 401);
});

test('Bulk DEMO reproduces hosted rate-limit stop, then paced restart preserves every existing ID and full replay adds no records',async t=>{
  const f=await createOwnerQaFixture({migrationFiles:['006_local_operations_records.up.sql','007_local_car_rentals.up.sql','008_local_partner_records.up.sql'],
    timings:{idleTimeoutMs:900_000,absoluteTimeoutMs:28_800_000,csrfLifetimeMs:900_000}});
  t.after(()=>f.close());
  const buckets=new Map<string,{count:number;reset:number;blocked:number}>();
  const app=createOwnerApplication({...f.options,policy:{...f.options.policy,origin:DEMO_HOSTED_ORIGIN,cookieSecure:true},database:f.database,logger:()=>{},
    limiter:{async consume(flow,_key,now){let b=buckets.get(flow);if(!b||now>=b.reset){b={count:0,reset:now+60_000,blocked:0};buckets.set(flow,b);}
      if(now<b.blocked)return false;if(++b.count>120){b.blocked=now+60_000;return false;}return true;}}});
  const connect=()=>createDemoHostedTransport({projectRef:DEMO_HOSTED_PROJECT,origin:DEMO_HOSTED_ORIGIN,ownerId:f.member!.id,email:f.inputs.email,password:f.inputs.password},async(value,options)=>{
    const request=new Request(value,options),response=new URL(String(value)).pathname.startsWith('/api/hamdee/auth/')?await app.handleAuth(request):await app.handleProperties(request);
    const headers=new Headers(response.headers);headers.set('x-hamdee-project-ref',DEMO_HOSTED_PROJECT);headers.set('x-hamdee-environment','isolated-demo');
    return new Response(response.body,{status:response.status,headers});
  });
  const initial=connect();await initial.login();await verifyDemoSeedDestination(initial);
  await assert.rejects(seedDemoDataset({login:async()=>{},request:initial.request.bind(initial)}),/vehicle-expense-Yaris:.*RATE_LIMITED/s);
  const partial=(await f.pg!.query<{id:string}>('SELECT id FROM hamdee_private.properties')).rows;assert.equal(partial.length,1);
  assert.equal((await f.pg!.query<{n:number}>('SELECT count(*)::int AS n FROM hamdee_private.car_receipts')).rows[0].n,1);
  assert.equal(buckets.get('refresh')?.count,121,'Live identity checks retain the real120/minute limit');
  const snapshot=async()=>{
    const result:Record<string,unknown>={};
    for(const {tablename}of(await f.pg!.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='hamdee_private' ORDER BY tablename")).rows){
      assert.match(tablename,/^[a-z_]+$/);result[tablename]=(await f.pg!.query(`SELECT to_jsonb(r) AS row FROM hamdee_private.${tablename} r ORDER BY to_jsonb(r)::text`)).rows;
    }return result;
  };
  const resume=async()=>{
    f.clock.advance(60_001);const transport=connect();await transport.login();await verifyDemoSeedDestination(transport);
    let waits=0;const paced=paceDemoCommands(transport,async()=>{waits++;f.clock.advance(5_000);});
    const data=await seedDemoDataset({login:async()=>{},request:paced.request.bind(paced)});assert.ok(waits>50);
    assert.equal(data.property.id,partial[0].id);await verifyDemoSeedDestination(transport);
    const staff=await transport.request('GET','/api/hamdee/v1/staff-collections?month=2026-10&asOf=2026-10-31');assert.equal(staff.status,200);
    assert.deepEqual((await staff.json()).data.totals.map((row:{balance:string})=>row.balance).sort(),['0','700']);
    assert.equal((await transport.request('POST','/api/hamdee/auth/logout',{})).status,200);
    assert.equal((await transport.request('GET','/api/hamdee/v1/properties')).status,401);
    return data;
  };
  const complete=await resume(),before=await snapshot();assert.equal(complete.vehicles.length,3);assert.equal(complete.accounts.length,4);
  const repeated=await resume();assert.equal(repeated.rooms[0].id,complete.rooms[0].id);assert.deepEqual(await snapshot(),before,'All private rows and financial postings are unchanged by same-key replay');
});
