import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import { hostedConnectionOptions, guardHostedTransaction, reviewedHostedDatabasePins,
  HAMDEE_DEVELOPMENT_PROJECT, HAMDEE_PRODUCTION_PROJECT, HAMDEE_DEMO_BRANCH, HAMDEE_DEMO_ORIGIN,
  isApprovedDemoRuntime, type HostedDatabasePins } from '../src/hosted-database';
import type { Sql } from '../src/database';

const scope = { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: HAMDEE_DEMO_BRANCH, HAMDEE_OWNER_ORIGIN: HAMDEE_DEMO_ORIGIN };
const pins = reviewedHostedDatabasePins!;
const url = `postgresql://${pins.user}:SYNTHETIC_DEMO_PASSWORD@${pins.host}:${pins.port}/postgres`;
async function scoped(work: () => void | Promise<void>) {
  const previous = new Map(Object.keys(scope).map(key => [key, process.env[key]])); Object.assign(process.env, scope);
  try { await work(); } finally { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
test('DEMO database pins only the separately reviewed project and pooler with verified TLS', async () => scoped(() => {
  assert.equal(HAMDEE_DEVELOPMENT_PROJECT, 'jfynuafwsympxxpkqags');
  assert.notEqual(HAMDEE_DEVELOPMENT_PROJECT, String(HAMDEE_PRODUCTION_PROJECT));
  const config = hostedConnectionOptions(url, pins), ssl = config.ssl as ConnectionOptions;
  assert.equal(config.host, 'aws-0-ap-southeast-1.pooler.supabase.com'); assert.equal(config.port, 6543);
  assert.equal(config.user, 'hamdee_backend.jfynuafwsympxxpkqags');
  assert.equal(ssl.rejectUnauthorized, true); assert.equal(ssl.minVersion, 'TLSv1.2');
  assert.equal(ssl.checkServerIdentity, checkServerIdentity); assert.equal(config.max, 2);
  assert.equal(config.application_name, 'hamdee-isolated-demo'); assert.equal(config.connectionString, undefined);
}));
test('DEMO connection rejects Production credentials, alternate pins, URL overrides and TLS bypass', async () => scoped(() => {
  const denied = (value: string, reviewed: HostedDatabasePins | null = pins) => assert.throws(() => hostedConnectionOptions(value, reviewed),
    error => { assert.doesNotMatch(String(error), /SYNTHETIC_DEMO_PASSWORD|pooler\.supabase|postgresql:/); return true; });
  denied(url, null);
  for (const value of [url.replace(HAMDEE_DEVELOPMENT_PROJECT, HAMDEE_PRODUCTION_PROJECT), url.replace(pins.host, 'other.pooler.supabase.com'),
    url.replace(pins.host, pins.host + '.invalid'), url.replace(':6543', ':5432'), url.replace('/postgres', '/other'),
    url.replace(pins.user, 'postgres.' + HAMDEE_DEVELOPMENT_PROJECT), url + '?sslmode=no-verify', url + '#override', url.replace('SYNTHETIC_DEMO_PASSWORD', '%00')]) denied(value);
  for (const patch of [{ projectRef: HAMDEE_PRODUCTION_PROJECT }, { host: 'other.pooler.supabase.com' }, { user: 'postgres' }, { mode: 'direct' }, { port: 5432 }]) {
    denied(url, { ...pins, ...patch } as HostedDatabasePins);
  }
  for (const [key, value] of [['PGOPTIONS', '-c role=postgres'], ['NODE_TLS_REJECT_UNAUTHORIZED', '0']]) {
    const previous = process.env[key]; process.env[key] = value;
    try { denied(url); } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
}));
test('DEMO scope rejects Production, missing branch and lookalike origins', async () => {
  assert.equal(isApprovedDemoRuntime(scope), true);
  for (const patch of [{ VERCEL_ENV: 'production' }, { VERCEL_ENV: 'development' }, { VERCEL_ENV: undefined },
    { VERCEL_GIT_COMMIT_REF: 'codex/hamdee-crm-development' }, { VERCEL_GIT_COMMIT_REF: undefined },
    { HAMDEE_OWNER_ORIGIN: 'https://hamdee.vercel.app' }, { HAMDEE_OWNER_ORIGIN: HAMDEE_DEMO_ORIGIN + '.invalid' }]) {
    assert.equal(isApprovedDemoRuntime({ ...scope, ...patch }), false);
    await scoped(() => { const prior = { ...process.env }; Object.assign(process.env, patch);
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete process.env[key];
      try { assert.throws(() => hostedConnectionOptions(url, pins)); } finally { for (const key of Object.keys(patch)) if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    });
  }
});
test('DEMO transaction marker and restricted-role checks fail before business work', async () => scoped(async () => {
  for (const patch of [{}, { project_ref: HAMDEE_PRODUCTION_PROJECT }, { environment: 'production' }, { data_class: 'client_records' }, { app_id: 'other' }, { unsafeRole: true }]) {
    const calls: string[] = []; let work = false;
    const marker = { app_id: 'hamdee', environment: 'synthetic-development', project_ref: HAMDEE_DEVELOPMENT_PROJECT, data_class: 'synthetic_only', ...patch };
    const sql: Sql = { query: async <T>(query: string) => { calls.push(query); return { rows: (query.includes(' AS safe FROM') ? [{ safe: !patch.unsafeRole }] : query.startsWith('SELECT app_id') ? [marker] : []) as T[] }; } };
    const run = () => guardHostedTransaction(sql, async () => { work = true; return 42; });
    if (Object.keys(patch).length) { await assert.rejects(run); assert.equal(work, false); }
    else { assert.equal(await run(), 42); assert.equal(work, true); }
    assert.match(calls[0], /set_config\('statement_timeout','10000ms',true\)/);
    if (!patch.unsafeRole) assert.ok(calls.includes('SET LOCAL ROLE hamdee_runtime'));
  }
}));
test('DEMO configured runtime permits only exact Preview scope and denies misconfiguration before network', () => {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test', ...scope,
    HAMDEE_OWNER_RUNTIME_APPROVAL: 'approved-development-owner-runtime', HAMDEE_DATABASE_MODE: 'hosted-development',
    HAMDEE_HOSTED_DATABASE_APPROVAL: 'approved-isolated-demo-database', HAMDEE_APP_ID: 'hamdee',
    HAMDEE_ENVIRONMENT: 'development', HAMDEE_DATA_CLASS: 'synthetic_only', HAMDEE_REGION: 'ap-southeast-1',
    HAMDEE_RESIDENCY_DECISION: 'approved_synthetic_development_only', HAMDEE_PROJECT_OWNER: 'Synthetic DEMO owner',
    HAMDEE_PROJECT_REF: HAMDEE_DEVELOPMENT_PROJECT, HAMDEE_SUPABASE_URL: `https://${HAMDEE_DEVELOPMENT_PROJECT}.supabase.co`,
    HAMDEE_AUTH_ISSUER: `https://${HAMDEE_DEVELOPMENT_PROJECT}.supabase.co/auth/v1`, HAMDEE_AUTH_AUDIENCE: 'authenticated',
    HAMDEE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_DEMO_ONLY', HAMDEE_OWNER_SUBJECT: '44440000-1111-4111-8111-111111111111',
    HAMDEE_OWNER_EMAIL: 'synthetic-demo@example.invalid', HAMDEE_DATABASE_URL: url,
    HAMDEE_OWNER_COOKIE_KEY: Buffer.alloc(32, 47).toString('base64url'), HAMDEE_OWNER_IDLE_MS: '900000', HAMDEE_OWNER_ABSOLUTE_MS: '28800000',
    HAMDEE_OWNER_CSRF_MS: '60000', HAMDEE_OWNER_AUTH_TIMEOUT_MS: '3000', HAMDEE_OWNER_RATE_WINDOW_MS: '60000',
    HAMDEE_OWNER_RATE_BOUNDS: '30', HAMDEE_OWNER_RATE_BACKOFF_MS: '60000' };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'ComSpec']) if (process.env[key]) environment[key] = process.env[key];
  const cases = [{}, { VERCEL_ENV: 'production' }, { VERCEL_GIT_COMMIT_REF: 'main' }, { HAMDEE_DATABASE_MODE: 'hosted-production' },
    { HAMDEE_PROJECT_REF: HAMDEE_PRODUCTION_PROJECT }, { HAMDEE_SUPABASE_URL: `https://${HAMDEE_PRODUCTION_PROJECT}.supabase.co` },
    { HAMDEE_AUTH_ISSUER: `https://${HAMDEE_PRODUCTION_PROJECT}.supabase.co/auth/v1` }, { HAMDEE_DATABASE_URL: url.replace(HAMDEE_DEVELOPMENT_PROJECT, HAMDEE_PRODUCTION_PROJECT) },
    { HAMDEE_DATABASE_URL: url.replace(pins.host, 'other.pooler.supabase.com') }, { HAMDEE_OWNER_ORIGIN: 'https://hamdee.vercel.app' },
    { HAMDEE_OWNER_IDLE_MS: '901000' }, { HAMDEE_OWNER_ABSOLUTE_MS: '28801000' }, { HAMDEE_PRODUCTION_COOKIE_KEY: 'SYNTHETIC_WRONG_SCOPE_KEY' },
    { HAMDEE_HOSTED_DATABASE_APPROVAL: 'approved-existing-client-records-database' }];
  const code = `
    import assert from 'node:assert/strict'; import net from 'node:net';
    let sockets=0,fetches=0; net.Socket.prototype.connect=function(){sockets++;throw Error('SOCKET_CANARY');};
    globalThis.fetch=async()=>{fetches++;throw Error('FETCH_CANARY');}; console.warn=()=>{}; console.info=()=>{};
    const {NextRequest}=await import('next/server');
    const {handleOwnerAuthRequest,handleOwnerPropertyRequest}=await import('./src/owner-runtime.ts');
    const {GET:authRoute}=await import('./app/api/hamdee/auth/[...action]/route.ts');
    const origin=${JSON.stringify(HAMDEE_DEMO_ORIGIN)},allowed=process.argv[1]==='allow';
    const response=await authRoute(new NextRequest(origin+'/api/hamdee/auth/state'));
    assert.equal(response.status,allowed?200:503); assert.doesNotMatch(JSON.stringify(await response.json()),/SYNTHETIC_DEMO_PASSWORD|SOCKET_CANARY|FETCH_CANARY/);
    assert.equal(response.headers.get('x-hamdee-project-ref'),allowed?'jfynuafwsympxxpkqags':null);
    assert.equal(response.headers.get('x-hamdee-environment'),allowed?'isolated-demo':null);
    const privateResponse=await handleOwnerPropertyRequest(new Request(origin+'/api/hamdee/v1/properties'));
    assert.equal(privateResponse.status,allowed?401:503);
    for(const other of ['https://hamdee.vercel.app',origin+'.invalid']){
      const blocked=await handleOwnerAuthRequest(new NextRequest(other+'/api/hamdee/auth/state',{headers:{'x-forwarded-host':new URL(origin).host,'host':new URL(origin).host}}));
      assert.equal(blocked.status,503); assert.equal(blocked.headers.get('x-hamdee-project-ref'),null);
    }
    if(allowed){ process.env.VERCEL_ENV='production'; assert.equal((await handleOwnerAuthRequest(new Request(origin+'/api/hamdee/auth/state'))).status,503); }
    assert.equal(sockets,0); assert.equal(fetches,0);
  `;
  for (const patch of cases) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, Object.keys(patch).length ? 'deny' : 'allow'],
      { cwd: new URL('../', import.meta.url), env: { ...environment, ...patch }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
  }
});
