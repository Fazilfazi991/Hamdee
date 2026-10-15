// Agent 4 sole-owner QA preparation. Synthetic test support only.
// No owner-runtime/owner-auth imports before Coordinator's factory/HTTP freeze.
// No SDK, provider, process-global credentials or operational policy defaults.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fork, spawn, type ChildProcessByStdio, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { ApiError } from '../../src/errors';
import type { Database } from '../../src/database';
import { createOwnerApplication, type OwnerApplication } from '../../src/owner-runtime';
import type { OwnerAuthAuditEvent, OwnerAuthOptions, OwnerManagedProvider, OwnerProviderSession, OwnerTokenPair } from '../../src/owner-auth';
import { adapter, up } from './fixture';

export const OWNER_QA_TIME = 2_000_000;
export const OWNER_QA_SUBJECT = '44440000-1111-4111-8111-111111111111';
export const OTHER_QA_SUBJECT = '44440000-2222-4222-8222-222222222222';
export const OWNER_QA_PROVIDER_SESSION = '44440000-3333-4333-8333-333333333333';
export const OWNER_QA_FACTOR = '44440000-5555-4555-8555-555555555555';
export const PORTABLE_ARCHIVE_SHA256 = '80379B2C04D51C30225532E0AE04509899141E9957ED096FE749D7FD9DF8F82F';

export function ownerQaInputs() {
  return {
    ownerSubject: OWNER_QA_SUBJECT, email: 'synthetic-owner@example.invalid',
    password: 'SYNTHETIC-TEST-ONLY-Owner!4444', validTotp: '444444', invalidTotp: '000000',
    issuer: 'https://abcdefghijklmnopqrst.supabase.co/auth/v1',
    projectRef: 'abcdefghijklmnopqrst', audience: 'authenticated',
    propertyName: 'Synthetic owner villa ' + randomUUID(),
    location: 'Synthetic local-test location',
    archiveReason: 'Synthetic reversible archive', restoreReason: 'Synthetic restoration',
    // Values are explicit fixture inputs, not approved activation settings.
    time: OWNER_QA_TIME, idleMilliseconds: 20_000, absoluteMilliseconds: 120_000,
    tokenMilliseconds: 12_000, csrfSecret: new Uint8Array(32).fill(61)
  };
}

export function ownerQaClock(initialTime: number) {
  assert.ok(Number.isSafeInteger(initialTime) && initialTime >= 0);
  let now = initialTime;
  return { now: () => now, advance(milliseconds: number) {
    assert.ok(Number.isSafeInteger(milliseconds) && milliseconds >= 0 && Number.isSafeInteger(now + milliseconds));
    now += milliseconds;
  } };
}

export function ownerQaDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

interface OwnerQaScenario {
  readonly id: string; readonly area: 'access' | 'persistence' | 'native' | 'browser';
  readonly arrangement: string; readonly assertion: string;
}
// Inventory only. These descriptions are not executed assertions/test passes.
export const ownerQaScenarios: readonly OwnerQaScenario[] = [
  { id: 'O01', area: 'access', arrangement: 'Synthetic managed owner email/password with confirmed mailbox', assertion: 'Only confirmed configured mailbox + immutable subject + issuer + password-primary session reaches protected records' },
  { id: 'O02', area: 'access', arrangement: 'Missing, malformed, expired, wrong-project, anonymous and nonowner managed identity', assertion: 'Deny direct API access; client owner claims never substitute for configured identity' },
  { id: 'O03', area: 'access', arrangement: 'Wrong or unconfirmed mailbox, missing password proof, wrong session or provider outage', assertion: 'No protected data or property mutation without current verified owner password identity' },
  { id: 'O04', area: 'access', arrangement: 'Absent/wrong/cross-session/origin CSRF proof for unsafe auth/property operations', assertion: 'Fail closed with no protected mutation; valid proof works and command retry stays idempotent' },
  { id: 'O05', area: 'access', arrangement: 'Copied stale access after logout, token/idle/absolute deadlines, delayed refresh response', assertion: 'No session resurrection or unauthorized data; explicit expiry/activity semantics from frozen contract' },
  { id: 'O06', area: 'access', arrangement: 'Recovery request, unknown account, unavailable provider or abandoned recovery flow', assertion: 'Safe generic responses; preparation fails closed; no real messages or invented recovery completion' },
  { id: 'O07', area: 'access', arrangement: 'Spoofed client role/subject headers, runtime/test-auth environment values', assertion: 'Test injection remains test-owned; normal configuration cannot create an owner session' },
  { id: 'O08', area: 'persistence', arrangement: 'Owner creates/edits/archives/restores property and reads audit', assertion: 'Stable UUID/creation identity, revisions, attributable history and authoritative saved-record counts' },
  { id: 'O09', area: 'persistence', arrangement: 'Failed audit/commit, interrupted response, same-key retry, changed payload and stale revision', assertion: 'Atomic metadata/history/command result, one committed mutation, explicit conflict, draft retained where applicable' },
  { id: 'O10', area: 'persistence', arrangement: 'Lifecycle session permits owner but database membership/grant is disabled or removed', assertion: 'Service repeats fresh SQL authorization; no implicit bypass of underlying grants' },
  { id: 'O11', area: 'native', arrangement: 'Two independent PostgreSQL connections race identical commands and stale edits', assertion: 'Distinct backend PIDs; one command effect/replay and one optimistic edit winner; audit/history reconcile' },
  { id: 'O12', area: 'native', arrangement: 'Create/update/archive/restore; close application pools, stop/restart owned PostgreSQL, restart app and sign in anew', assertion: 'Properties/history and saved-record dashboard counts survive BOTH engine and app restart' },
  { id: 'O13', area: 'native', arrangement: 'Actual nonowner runtime, connection failure and actor-context reuse', assertion: 'No elevated SQL/RLS bypass, actor/GUC leakage or partial writes; only owned instance touched' },
  { id: 'O14', area: 'browser', arrangement: 'Desktop 1440x1000 and mobile 390x844 owner password login through dashboard/property operations', assertion: 'Real workspace UI with fake provider only in harness; saved totals reconcile; no fabricated financial KPIs' },
  { id: 'O15', area: 'browser', arrangement: 'Keyboard password login/property form, invalid input, Escape/focus return and mobile navigation', assertion: 'Usable labels/errors/focus; no page overflow; HAMDEE branding preserved' },
  { id: 'O16', area: 'browser', arrangement: 'Committed response dropped; retry same command, stale edit and review latest revision', assertion: 'One saved record, actionable conflict, no silent mutation resend or false success' },
  { id: 'O17', area: 'browser', arrangement: 'Delay save/refresh response across logout/session loss; reload and new browser session', assertion: 'Protected content/drafts clear; late response cannot repopulate authenticated state' },
  { id: 'O18', area: 'browser', arrangement: 'Browser or database unavailable, empty register, demo localStorage sentinel and script-like names', assertion: 'Safe errors/empty states; no fallback seed, money totals, unsafe rendering or provider-token leakage' }
];

export const ownerQaViewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 }
] as const;

// Pure guard: never connects, reads generic DB env vars, discovers services or
// accepts a hosted URL. Actual setup must create this uniquely named database
// in a fresh owned loopback cluster before any migrations are applied.
export function ownerNativeConnection(url: string, confirmation: string) {
  assert.equal(confirmation, 'disposable-local-hamdee-owner');
  const parsed = new URL(url);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.ok(parsed.port && parsed.username && parsed.password && !parsed.search && !parsed.hash);
  assert.match(parsed.pathname, /^\/hamdee_dev_owner_qa_[a-f0-9]{32}$/);
  const port = Number(parsed.port); assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  return { host: '127.0.0.1', port, database: parsed.pathname.slice(1),
    user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
    ssl: false as const, max: 4, connectionTimeoutMillis: 3000, statement_timeout: 10000,
    idle_in_transaction_session_timeout: 10000, application_name: 'hamdee-owner-qa' };
}

async function sha256(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex').toUpperCase();
}

// Can inspect the existing reviewed runtime read-only in a preserved checkout;
// data/log/password files must later live in the ACTIVE checkout's ignored dirs.
// Inspection never starts/stops an engine or modifies the preserved checkout.
export async function inspectOwnerPortableRuntime(archivePath: string, runtimePath: string) {
  const runtime = await realpath(runtimePath), archive = await realpath(archivePath);
  assert.equal(await sha256(archive), PORTABLE_ARCHIVE_SHA256);
  const provenance = JSON.parse(await readFile(new URL('./portable-postgresql.json', import.meta.url), 'utf8')) as {
    sha256: string; tools: { file: string; sha256: string }[]
  };
  assert.equal(provenance.sha256, PORTABLE_ARCHIVE_SHA256);
  const bin = await realpath(path.join(runtime, 'pgsql/bin'));
  assert.ok(bin.startsWith(runtime + path.sep));
  const allowed = ['postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'createdb.exe'];
  assert.equal(new Set(provenance.tools.map(tool => tool.file)).size, allowed.length);
  for (const name of allowed) {
    const tool = provenance.tools.find(item => item.file === name); assert.ok(tool);
    const file = await realpath(path.join(bin, name)); assert.ok(file.startsWith(bin + path.sep));
    assert.equal(await sha256(file), tool.sha256);
  }
  return { bin, archiveSha256: PORTABLE_ARCHIVE_SHA256 };
}

// Fresh owner-suite cluster, NEVER shared with the old native test suite. This
// does not run at module import. Call only from authorized tests after freeze.
// All generated files remain under this active package's ignored .test-data.
export async function startOwnerNativeCluster(runtime: { bin: string; archiveSha256: string }, suite: 'owner' | 'legacy' = 'owner') {
  assert.ok(suite === 'owner' || suite === 'legacy');
  assert.equal(process.platform, 'win32'); assert.equal(runtime.archiveSha256, PORTABLE_ARCHIVE_SHA256);
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const packageIdentity = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { name: string };
  assert.equal(packageIdentity.name, 'hamdee-property-foundation');
  const parent = path.resolve(root, '.test-data', 'owner-native');
  await mkdir(parent, { recursive: true }); assert.ok((await realpath(parent)).startsWith(root + path.sep));
  const suffix = randomUUID().replaceAll('-', ''), data = path.join(parent, suffix);
  await mkdir(data); assert.ok((await realpath(data)).startsWith(root + path.sep));
  const user = 'hamdee_owner_qa_owner', password = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const database = (suite === 'owner' ? 'hamdee_dev_owner_qa_' : 'hamdee_dev_task005_') + suffix;
  const passwordFile = path.join(parent, suffix + '.password');
  const serverLog = path.join(data, 'postgresql.log');
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const environment: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(PG|HAMDEE_|SUPABASE_|DATABASE_URL$)/i.test(key))), NODE_ENV: 'test' };
  const tools = ['postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'createdb.exe'];
  async function run(name: string, args: string[], variables: NodeJS.ProcessEnv = environment, daemon = false) {
    assert.ok(tools.includes(name));
    const executable = await realpath(path.join(runtime.bin, name)); assert.ok(executable.startsWith(runtime.bin + path.sep));
    return new Promise<void>((resolve, reject) => {
      const child: ChildProcessByStdio<null, Readable, Readable> = spawn(executable, args, { cwd: root, env: variables, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      // Output is deliberately suppressed: no password/URL/provider records.
      child.stdout.resume(); child.stderr.resume();
      const timer = setTimeout(() => { child.kill(); reject(new Error('Owned native QA tool timed out: ' + name)); }, 45000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('Owned native QA tool could not start: ' + name)); });
      child.once(daemon ? 'exit' : 'close', code => {
        clearTimeout(timer); if (daemon) { child.stdout.destroy(); child.stderr.destroy(); }
        if (code === 0) resolve(); else reject(new Error('Owned native QA tool failed: ' + name));
      });
    });
  }
  let started = false, pid = 0;
  async function assertOwned() {
    assert.ok((await realpath(data)).startsWith(root + path.sep));
    const lines = (await readFile(path.join(data, 'postmaster.pid'), 'utf8')).trim().split(/\r?\n/);
    assert.equal(path.resolve(lines[1]), data); assert.equal(Number(lines[3]), port);
    if (pid) assert.equal(Number(lines[0]), pid);
    return Number(lines[0]);
  }
  async function start() {
    await run('pg_ctl.exe', ['-D', data, '-l', serverLog, '-w', '-t', '30', 'start'], environment, true);
    pid = await assertOwned(); started = true;
  }
  async function close() {
    if (!started) return;
    await assertOwned(); await run('pg_ctl.exe', ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']); started = false; pid = 0;
  }
  try {
    await writeFile(passwordFile, password, { mode: 0o600 });
    try { await run('initdb.exe', ['-D', data, '-U', user, '--pwfile=' + passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']); }
    finally { await unlink(passwordFile); }
    await writeFile(path.join(data, 'postgresql.auto.conf'), ["listen_addresses = '127.0.0.1'", 'port = ' + port,
      "timezone = 'UTC'", 'max_connections = 20', "log_statement = 'none'", "log_min_error_statement = 'panic'",
      'log_connections = off', 'log_disconnections = off', ''].join('\n'));
    await start();
    await run('createdb.exe', ['--host=127.0.0.1', '--port=' + port, '--username=' + user, '--no-password', database], { ...environment, PGPASSWORD: password });
  } catch (error) {
    // pg_ctl can fail after spawning postgres; stop only after ownership proof.
    if (!started) { try { pid = await assertOwned(); started = true; } catch { /* No verified owned running instance. */ } }
    if (started) await close(); throw error;
  }
  const connection = `postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
  if (suite === 'owner') ownerNativeConnection(connection, 'disposable-local-hamdee-owner');
  return { connection, close, restart: async () => { await close(); await start(); },
    evidence: () => ({ engine: 'PostgreSQL portable 17.11', archiveSha256: runtime.archiveSha256,
      host: '127.0.0.1', port, database, dataDirectory: data, ownedPid: pid, serverStopped: !started }) };
}

const assetPaths = new Set(['workspace/index.html', 'workspace/adapter.js', 'workspace/app.js', 'workspace/rental.js', 'workspace/expenses.js', 'workspace/foundation.css',
  'shared/styles.css', 'shared/icons.js', 'shared/hamdee-logo.png', 'shared/inter-latin.woff2']);
export type OwnerQaHttpHandler = (request: Request) => Promise<Response>;

// Browser transport setup independent of the not-yet-frozen owner API. The
// caller must supply a factory bound only to test fakes. No default test login,
// SDK client, standalone public endpoint or environment auth switch exists.
export async function startOwnerLoopbackHarness(assetRoot: string,
  createHandler: (origin: string) => Promise<OwnerQaHttpHandler>, preferredPort = 0) {
  const root = await realpath(assetRoot); let handler: OwnerQaHttpHandler | null = null;
  const server: Server = createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const pathname = new URL(req.url || '/', origin).pathname;
      if (pathname.startsWith('/api/hamdee/')) {
        if (!handler) { res.writeHead(503).end('QA application unavailable'); return; }
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 32768) { res.writeHead(413).end(); return; } chunks.push(bytes); }
        const headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const response = await handler(new Request(origin + req.url, { method: req.method, headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
        const outgoing = Object.fromEntries(response.headers) as Record<string, string | string[]>;
        const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing['set-cookie'] = cookies;
        res.writeHead(response.status, outgoing); res.end(await response.text()); return;
      }
      const file = pathname.slice(1); if (!assetPaths.has(file)) { res.writeHead(404).end(); return; }
      const mime = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'font/woff2';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); res.end(await readFile(path.join(root, file)));
    } catch { res.writeHead(500).end('Synthetic owner QA harness failure'); }
  });
  const close = () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(preferredPort, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try { handler = await createHandler(origin); } catch (error) { await close(); throw error; }
  return { url: origin, close,
    // Reconstruct application composition while retaining the same origin.
    // A separate child-process test is still required for actual app restart.
    rebuildApplication: async () => { handler = null; handler = await createHandler(origin); }
  };
}

export type OwnerQaGate = ReturnType<typeof ownerQaDeferred<void>>;
export function ownerProviderFake(clock: ReturnType<typeof ownerQaClock>) {
  const inputs = ownerQaInputs();
  const sessions = new Map<string, OwnerProviderSession>(), revoked = new Set<string>();
  const facts = { unavailable: false, unconfirmedLogout: false, loginAal2: false, subject: OWNER_QA_SUBJECT,
    email: inputs.email, emailConfirmed: true, passwordAuthenticatedAt: clock.now(), wrongIssuer: false, factorActive: true, verifyGate: null as { entered: OwnerQaGate; release: OwnerQaGate } | null,
    mfaGate: null as { entered: OwnerQaGate; release: OwnerQaGate } | null,
    calls: { signIn: 0, verify: 0, enroll: 0, mfa: 0, signOut: 0 }, enrolled: false, accountFactorVerified: false };
  let serial = 0;
  const rotate = (session: OwnerProviderSession): OwnerProviderSession => {
    const value = { ...structuredClone(session), expiresAt: clock.now() + inputs.tokenMilliseconds,
      tokens: { accessToken: 'SYNTHETIC_PROVIDER_ACCESS_' + ++serial, refreshToken: 'SYNTHETIC_PROVIDER_REFRESH_' + serial } };
    sessions.set(value.tokens.refreshToken, value); return structuredClone(value);
  };
  const verify = (tokens: OwnerTokenPair): OwnerProviderSession => {
    if (facts.unavailable) throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Synthetic provider unavailable.');
    const session = sessions.get(tokens.refreshToken);
    if (!session || revoked.has(session.sessionId)) throw new ApiError(401, 'UNAUTHENTICATED', 'Synthetic managed session revoked.');
    return { ...structuredClone(session), email: facts.email, emailConfirmed: facts.emailConfirmed, passwordAuthenticatedAt: facts.passwordAuthenticatedAt, factors: !facts.factorActive ? [] : facts.accountFactorVerified || facts.loginAal2 ?
      [{ id: OWNER_QA_FACTOR, status: 'verified' }] : facts.enrolled ? [{ id: OWNER_QA_FACTOR, status: 'unverified' }] : [] };
  };
  const provider: OwnerManagedProvider = {
    async signIn(email, password) {
      facts.calls.signIn++;
      if (facts.unavailable) throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Synthetic provider unavailable.');
      if (email !== inputs.email || password !== inputs.password) throw new ApiError(401, 'UNAUTHENTICATED', 'Synthetic invalid credentials.');
      const session: OwnerProviderSession = {
        identity: { issuer: facts.wrongIssuer ? 'https://other.invalid/auth/v1' : inputs.issuer, subject: facts.subject },
        email: facts.email, emailConfirmed: facts.emailConfirmed, passwordAuthenticatedAt: facts.passwordAuthenticatedAt, sessionId: randomUUID(), assurance: facts.loginAal2 ? 'aal2' : 'aal1', expiresAt: clock.now() + inputs.tokenMilliseconds,
        mfaVerifiedAt: facts.loginAal2 ? clock.now() : null,
        factors: facts.loginAal2 || facts.accountFactorVerified ? [{ id: OWNER_QA_FACTOR, status: 'verified' }] : facts.enrolled ? [{ id: OWNER_QA_FACTOR, status: 'unverified' }] : [],
        tokens: { accessToken: 'SYNTHETIC_INITIAL_ACCESS', refreshToken: 'SYNTHETIC_INITIAL_REFRESH' }
      };
      return rotate(session);
    },
    async verifySession(tokens) {
      facts.calls.verify++; const session = verify(tokens), gate = facts.verifyGate;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      return rotate(session); // Deliberately permits an already-inflight stale reply.
    },
    async enrollTotp(tokens) {
      facts.calls.enroll++; const session = verify(tokens);
      if (facts.accountFactorVerified) throw new ApiError(409, 'FACTOR_ALREADY_ENROLLED', 'Synthetic factor is already verified.');
      facts.enrolled = true;
      return { session: rotate(session), factorId: OWNER_QA_FACTOR, qrCode: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>' };
    },
    async verifyTotp(tokens, factorId, code) {
      facts.calls.mfa++; const session = verify(tokens), gate = facts.mfaGate;
      if (factorId !== OWNER_QA_FACTOR || code !== inputs.validTotp || !(facts.enrolled || facts.accountFactorVerified)) throw new ApiError(403, 'MFA_REQUIRED', 'Synthetic TOTP rejected.');
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      facts.accountFactorVerified = true;
      return rotate({ ...session, assurance: 'aal2', mfaVerifiedAt: clock.now(), factors: [{ id: factorId, status: 'verified' }] });
    },
    async signOut(tokens) {
      facts.calls.signOut++;
      if (facts.unconfirmedLogout || facts.unavailable) throw new ApiError(503, 'SIGN_OUT_UNCONFIRMED', 'Synthetic global sign-out unconfirmed.');
      const session = verify(tokens); revoked.add(session.sessionId);
    }
  };
  return { provider, facts, sessions, revoked };
}

export class OwnerCookieJar {
  readonly values = new Map<string, string>();
  csrfToken = '';
  header() { return [...this.values].map(([name, value]) => name + '=' + value).join('; '); }
  fork() { const copy = new OwnerCookieJar(); for (const [key, value] of this.values) copy.values.set(key, value); copy.csrfToken = this.csrfToken; return copy; }
  async accept(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('='), name = pair.slice(0, split), value = pair.slice(split + 1);
      if (/max-age=0(?:;|$)/i.test(cookie) || !value) this.values.delete(name); else this.values.set(name, value);
    }
    const result = await response.clone().json().catch(() => null);
    if (typeof result?.data?.csrfToken === 'string') this.csrfToken = result.data.csrfToken;
  }
}

export async function seedOwnerAppRecords(sql: { query: (text: string, values?: unknown[]) => Promise<unknown> }) {
  const inputs = ownerQaInputs(), id = randomUUID(), assignment = randomUUID();
  await sql.query('INSERT INTO hamdee_private.app_users(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,$4,true)',
    [id, inputs.issuer, inputs.ownerSubject, 'Synthetic sole owner']);
  await sql.query("INSERT INTO hamdee_private.role_assignments(id,user_id,role,portfolio) VALUES($1,$2,'admin',true)", [assignment, id]);
  return { id, assignment };
}

export async function createOwnerQaFixture(config: { origin?: string; database?: Database; pg?: PGlite;
  databaseEnvironment?:'local-test'|'synthetic-development';
  provider?: ReturnType<typeof ownerProviderFake>; clock?: ReturnType<typeof ownerQaClock>;
  timings?: Pick<OwnerAuthOptions['policy'], 'idleTimeoutMs' | 'absoluteTimeoutMs' | 'csrfLifetimeMs'> } = {}) {
  const inputs = ownerQaInputs(), clock = config.clock || ownerQaClock(inputs.time), fake = config.provider || ownerProviderFake(clock);
  const pg = config.database ? config.pg : config.pg || new PGlite();
  let member: { id: string; assignment: string } | undefined;
  if (!config.database) {
    assert.ok(pg); await pg.exec(await up()); member = await seedOwnerAppRecords(pg);
  }
  const database = config.database || adapter(pg!);
  const audit: OwnerAuthAuditEvent[] = [];
  const hooks = { auditAvailable: true, limiterAvailable: true, rateLimited: false, databaseAvailable: true };
  const options: OwnerAuthOptions = {
    policy: { owner: { issuer: inputs.issuer, subject: inputs.ownerSubject }, ownerEmail: inputs.email, projectRef: inputs.projectRef,
      origin: config.origin || 'http://127.0.0.1:4189', cookieSecure: false,
      idleTimeoutMs: inputs.idleMilliseconds, absoluteTimeoutMs: inputs.absoluteMilliseconds,
      csrfLifetimeMs: 10_000, ...config.timings },
    provider: fake.provider, cookieKey: new Uint8Array(32).fill(62), clock: clock.now, randomBytes,
    limiter: { async consume() { if (!hooks.limiterAvailable) throw new Error('SYNTHETIC_LIMITER_FAILURE'); return !hooks.rateLimited; } },
    audit: { async append(event) { if (!hooks.auditAvailable) throw new Error('SYNTHETIC_AUDIT_FAILURE'); audit.push(structuredClone(event)); } }
  };
  const guardedDb: Database = { transaction(work) { if (!hooks.databaseAvailable) return Promise.reject(new Error('SYNTHETIC_DATABASE_FAILURE')); return database.transaction(work); } };
  let app: OwnerApplication = createOwnerApplication({ ...options, database: guardedDb, databaseEnvironment:config.databaseEnvironment, logger: () => {} });
  const jar = new OwnerCookieJar();
  const request = async (method: string, route: string, body?: unknown, extra: Record<string, string> = {}, cookies = jar) => {
    const request = new Request(options.policy.origin + route, { method,
      headers: { Cookie: cookies.header(), Origin: options.policy.origin, 'Content-Type': 'application/json', 'X-Hamdee-CSRF': cookies.csrfToken, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = route.startsWith('/api/hamdee/auth/') ? await app.handleAuth(request) : await app.handleProperties(request);
    await cookies.accept(response); return response;
  };
  const auth = (method: string, action: string, body?: unknown, extra?: Record<string, string>, cookies?: OwnerCookieJar) => request(method, '/api/hamdee/auth/' + action, body, extra, cookies);
  const login = async (_legacyMfa = true) => {
    void _legacyMfa; // Historical callers remain source-compatible; password login is sufficient.
    const state = await auth('GET', 'state'); assert.equal(state.status, 200, 'Owner auth state must be implemented');
    const response = await auth('POST', 'login', { email: inputs.email, password: inputs.password }); assert.equal(response.status, 200, 'Owner login must be implemented');
    assert.equal((await response.clone().json()).data.state, 'authenticated');
    return jar;
  };
  return { inputs, options, fake, clock, jar, audit, hooks, pg, member, database, request, auth, login,
    app: () => app, rebuildApplication: () => { app = createOwnerApplication({ ...options, database: guardedDb, databaseEnvironment:config.databaseEnvironment, logger: () => {} }); },
    close: async () => { if (!config.database) await pg?.close(); } };
}

export async function startOwnerBrowserHarness() {
  let fixture!: Awaited<ReturnType<typeof createOwnerQaFixture>>;
  const server = await startOwnerLoopbackHarness(fileURLToPath(new URL('../../public/', import.meta.url)), async origin => {
    let offset = 0;
    const clock = { now: () => Date.now() + offset, advance: (milliseconds: number) => { assert.ok(Number.isSafeInteger(milliseconds) && milliseconds >= 0); offset += milliseconds; } };
    fixture = await createOwnerQaFixture({ origin, clock,
      timings: { idleTimeoutMs: 120_000, absoluteTimeoutMs: 600_000, csrfLifetimeMs: 60_000 } });
    return request => new URL(request.url).pathname.startsWith('/api/hamdee/auth/') ? fixture.app().handleAuth(request) : fixture.app().handleProperties(request);
  });
  return { ...server, fixture, close: async () => { await server.close(); await fixture.close(); } };
}

export async function startOwnerAppProcess(connection: string, preferredPort = 0) {
  ownerNativeConnection(connection, 'disposable-local-hamdee-owner');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|HAMDEE_|SUPABASE_|DATABASE_URL$)/i.test(key))), NODE_ENV: 'test' };
  const child: ChildProcess = fork(path.join(root, 'tests/support/owner-app-child.mjs'), [], {
    cwd: root, env, execArgv: ['--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout?.resume(); child.stderr?.resume();
  const ready = await new Promise<{ url: string; pid: number }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned owner-app child did not become ready')); }, 30000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Owned owner-app child could not start')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Owned owner-app child exited before readiness')); });
    child.on('message', value => {
      const message = value as { type?: string; url?: string; pid?: number };
      if (message.type === 'ready' && message.url && typeof message.pid === 'number' && message.pid === child.pid) {
        clearTimeout(timer); const url = new URL(message.url); assert.equal(url.hostname, '127.0.0.1'); resolve({ url: message.url, pid: message.pid });
      }
      if (message.type === 'failed') { clearTimeout(timer); reject(new Error('Owned owner-app child setup failed')); }
    });
    child.send({ type: 'start', connection, preferredPort });
  });
  return { ...ready, close: async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Owned owner-app child shutdown timed out')); }, 15000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.send({ type: 'stop' });
    });
  } };
}

export async function verifyOwnerRestartWitness(connection: string, witness: { id: string; version: number; name: string; createdAt: string; previousAppPid: number }) {
  const app = await startOwnerAppProcess(connection), jar = new OwnerCookieJar(), inputs = ownerQaInputs();
  assert.notEqual(app.pid, witness.previousAppPid);
  const request = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(app.url + route, { method, headers: { Cookie: jar.header(), Origin: app.url, 'Content-Type': 'application/json', 'X-Hamdee-CSRF': jar.csrfToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    await jar.accept(response); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
  };
  try {
    await request('GET', '/api/hamdee/auth/state');
    await request('POST', '/api/hamdee/auth/login', { email: inputs.email, password: inputs.password });
    const property = (await request('GET', '/api/hamdee/v1/properties/' + witness.id)).data;
    assert.equal(property.id, witness.id); assert.equal(property.version, witness.version); assert.equal(property.createdAt, witness.createdAt);
    assert.equal(property.name, witness.name); assert.equal(property.lifecycleStatus, 'registered');
    assert.equal((await request('GET', `/api/hamdee/v1/properties/${witness.id}/audit`)).data.length, 4);
    assert.ok((await request('GET', '/api/hamdee/v1/dashboard')).data.totalProperties > 0);
    return { propertyId: witness.id, version: witness.version, freshAppPid: app.pid, newSession: true, historyCount: 4 };
  } finally { await app.close(); }
}
