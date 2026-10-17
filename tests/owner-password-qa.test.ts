import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createManagedOwnerProvider } from '../src/owner-auth';
import { createOwnerQaFixture, OTHER_QA_SUBJECT, ownerQaDeferred } from './support/owner-crm-harness';

// Independent tests for the approved password-only flow. All provider traffic
// is injected or intercepted; no real owner credentials or hosted data are used.
const base = '/api/hamdee/v1';
async function fixture(t: TestContext) { const f = await createOwnerQaFixture(); t.after(() => f.close()); return f; }
async function response(r: Response, status: number) {
  const body = await r.clone().json(); assert.equal(r.status, status, JSON.stringify(body));
  assert.equal(r.headers.get('cache-control')?.replaceAll(' ', ''), 'private,no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-request-id'), body.requestId); return body;
}
async function denied(r: Response) { const b = await r.json(); assert.ok([401, 403].includes(r.status), JSON.stringify(b)); assert.equal(b.data, undefined); }
const pre = (id: string, version: number) => ({ 'Idempotency-Key': randomUUID(), 'If-Match': `"property:${id}:${version}"` });

test('Password QA: verified owner reaches dashboard immediately without factor enrollment or OTP', async t => {
  const f = await fixture(t); await f.login(false);
  const state = await response(await f.auth('GET', 'state'), 200); assert.equal(state.data.state, 'authenticated');
  await response(await f.request('GET', base + '/dashboard'), 200);
  assert.equal(f.fake.facts.calls.enroll, 0); assert.equal(f.fake.facts.calls.mfa, 0);
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_.*(?:ACCESS|REFRESH)|SYNTHETIC-TEST-ONLY|qrCode|otpauth:/);
});

test('Password QA: anonymous requests and forged client owner/admin claims disclose no domain data', async t => {
  const f = await fixture(t);
  for (const path of ['/session', '/dashboard', '/properties', '/rental?month=2026-10&asOf=2026-10-15', '/expenses?month=2026-10&asOf=2026-10-15']) {
    await denied(await f.request('GET', base + path, undefined, { Authorization: 'Bearer SYNTHETIC_FORGED_OWNER', 'X-Role': 'admin', 'X-Owner-Subject': f.inputs.ownerSubject }));
  }
});

test('Password QA: invalid password, nonowner UUID and wrong issuer never obtain a protected session', async t => {
  for (const mode of ['password', 'subject', 'issuer'] as const) {
    const f = await fixture(t); await f.auth('GET', 'state');
    if (mode === 'subject') f.fake.facts.subject = OTHER_QA_SUBJECT;
    if (mode === 'issuer') f.fake.facts.wrongIssuer = true;
    await denied(await f.auth('POST', 'login', { email: f.inputs.email, password: mode === 'password' ? 'SYNTHETIC_WRONG_PASSWORD' : f.inputs.password }));
    await denied(await f.request('GET', base + '/dashboard')); assert.equal(f.fake.facts.calls.enroll, 0);
  }
});

test('Password QA: matching owner UUID cannot substitute for verified pinned email and valid password evidence', async t => {
  for (const mode of ['email', 'confirmation', 'future-password'] as const) {
    const f = await fixture(t); await f.auth('GET', 'state');
    if (mode === 'email') f.fake.facts.email = 'synthetic-other@example.invalid';
    if (mode === 'confirmation') f.fake.facts.emailConfirmed = false;
    if (mode === 'future-password') f.fake.facts.passwordAuthenticatedAt = f.clock.now() + 1;
    await denied(await f.auth('POST', 'login', { email: f.inputs.email, password: f.inputs.password }));
    await denied(await f.request('GET', base + '/dashboard'));
  }
});

test('Password QA: inactive MFA endpoints cannot enroll or verify factors and password access stays active', async t => {
  const f = await fixture(t); await f.login(false);
  await response(await f.auth('POST', 'mfa/enroll', {}), 404);
  await response(await f.auth('POST', 'mfa/verify', { factorId: '55550000-4444-4444-8444-444444444444', code: '444444' }), 404);
  await response(await f.request('GET', base + '/dashboard'), 200);
  assert.equal(f.fake.facts.calls.enroll, 0); assert.equal(f.fake.facts.calls.mfa, 0);
});

test('Password QA: existing factor metadata and its age cannot reintroduce an MFA freshness gate', async t => {
  const f = await createOwnerQaFixture({ timings: { idleTimeoutMs: 900_000, absoluteTimeoutMs: 28_800_000, csrfLifetimeMs: 900_000 } });
  t.after(() => f.close()); f.fake.facts.loginAal2 = true; await f.login(false);
  f.clock.advance(120_000); f.fake.facts.factorActive = false;
  await response(await f.request('GET', base + '/dashboard'), 200);
  assert.equal(f.fake.facts.calls.enroll, 0); assert.equal(f.fake.facts.calls.mfa, 0);
});

test('Password QA: changed password authentication context invalidates the copied app session', async t => {
  const f = await fixture(t); await f.login(false); f.clock.advance(1); f.fake.facts.passwordAuthenticatedAt = f.clock.now();
  await denied(await f.request('GET', base + '/dashboard'));
});

test('Password QA: disabled membership and removed portfolio grant deny login despite valid provider password', async t => {
  for (const mode of ['disabled', 'grant'] as const) {
    const f = await fixture(t);
    if (mode === 'disabled') await f.pg!.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1', [f.member!.id]);
    else await f.pg!.query('UPDATE hamdee_private.role_assignments SET portfolio=false WHERE id=$1', [f.member!.assignment]);
    await f.auth('GET', 'state'); await denied(await f.auth('POST', 'login', { email: f.inputs.email, password: f.inputs.password }));
    await denied(await f.request('GET', base + '/properties'));
  }
});

test('Password QA: exact Origin and session CSRF remain mandatory for writes and logout', async t => {
  const f = await fixture(t); await f.login(false);
  const invalidHeaders: Record<string, string>[] = [{ 'X-Hamdee-CSRF': '' }, { 'X-Hamdee-CSRF': 'SYNTHETIC_WRONG_CSRF' }, { Origin: 'https://foreign.example.invalid' }];
  for (const extra of invalidHeaders) {
    await response(await f.request('POST', base + '/properties', { name: 'Synthetic rejected write' }, { 'Idempotency-Key': randomUUID(), ...extra }), 403);
    await response(await f.auth('POST', 'logout', {}, extra), 403);
  }
  assert.equal((await response(await f.request('GET', base + '/dashboard'), 200)).data.totalProperties, 0);
  const other = await fixture(t); await other.login(false);
  await response(await f.request('POST', base + '/properties', { name: 'Synthetic cross-session CSRF' }, { 'Idempotency-Key': randomUUID(), 'X-Hamdee-CSRF': other.jar.csrfToken }), 403);
});

test('Password QA: logout clears cookies and copied session cannot be reused', async t => {
  const f = await fixture(t); await f.login(false); const copied = f.jar.fork();
  const loggedOut = await f.auth('POST', 'logout', {}); await response(loggedOut, 200);
  assert.ok(loggedOut.headers.getSetCookie().some(line => /hamdee_owner=;.*Max-Age=0/i.test(line)));
  await denied(await f.request('GET', base + '/dashboard', undefined, {}, copied));
  await denied(await f.request('POST', base + '/properties', { name: 'Synthetic logged-out write' }, { 'Idempotency-Key': randomUUID() }, copied));
});

test('Password QA: exact 15-minute idle deadline denies while prior activity can refresh idle only', async t => {
  const f = await createOwnerQaFixture({ timings: { idleTimeoutMs: 900_000, absoluteTimeoutMs: 28_800_000, csrfLifetimeMs: 900_000 } });
  t.after(() => f.close()); await f.login(false);
  f.clock.advance(899_999); await response(await f.request('GET', base + '/dashboard'), 200);
  f.clock.advance(900_000); await denied(await f.request('GET', base + '/dashboard'));
});

test('Password QA: activity never extends the absolute eight-hour session deadline', async t => {
  const f = await createOwnerQaFixture({ timings: { idleTimeoutMs: 900_000, absoluteTimeoutMs: 28_800_000, csrfLifetimeMs: 900_000 } });
  t.after(() => f.close()); await f.login(false);
  for (let i = 0; i < 32; i++) { f.clock.advance(899_999); await response(await f.request('GET', base + '/dashboard'), 200); }
  f.clock.advance(32); await denied(await f.request('GET', base + '/dashboard'));
});

test('Password QA: provider outage and fresh membership disablement prevent protected reads and mutation', async t => {
  const f = await fixture(t); await f.login(false); f.fake.facts.unavailable = true;
  await response(await f.request('GET', base + '/dashboard'), 503); f.fake.facts.unavailable = false; await f.login(false);
  await f.pg!.query('UPDATE hamdee_private.app_users SET enabled=false WHERE id=$1', [f.member!.id]);
  await denied(await f.request('POST', base + '/properties', { name: 'Synthetic disabled write' }, { 'Idempotency-Key': randomUUID() }));
  assert.equal((await f.pg!.query<{ n: number }>('SELECT count(*)::int AS n FROM hamdee_private.properties')).rows[0].n, 0);
});

test('Password QA: delayed refresh completion after logout cannot resurrect copied access', async t => {
  const f = await fixture(t); await f.login(false); const copied = f.jar.fork();
  const gate = { entered: ownerQaDeferred<void>(), release: ownerQaDeferred<void>() }; f.fake.facts.verifyGate = gate;
  const late = f.auth('POST', 'refresh', {}, {}, copied); await gate.entered.promise; f.fake.facts.verifyGate = null;
  try { await response(await f.auth('POST', 'logout', {}), 200); } finally { gate.release.resolve(); }
  await late; await denied(await f.request('GET', base + '/dashboard', undefined, {}, copied));
});

test('Password QA: password-only property CRUD preserves stable identity, revision, audit and saved counts', async t => {
  const f = await fixture(t); await f.login(false);
  const p = (await response(await f.request('POST', base + '/properties', { name: 'Synthetic password-only villa' }, { 'Idempotency-Key': randomUUID() }), 201)).data;
  await response(await f.request('PATCH', base + '/properties/' + p.id, { name: 'Synthetic updated password villa' }, pre(p.id, 1)), 200);
  await response(await f.request('POST', `${base}/properties/${p.id}/archive`, { reason: 'Synthetic archive' }, pre(p.id, 2)), 200);
  const archived = (await response(await f.request('GET', base + '/dashboard'), 200)).data;
  assert.equal(archived.totalProperties, 1); assert.equal(archived.archivedProperties, 1); assert.equal(archived.activeProperties, 0);
  await response(await f.request('POST', `${base}/properties/${p.id}/restore`, { reason: 'Synthetic restore' }, pre(p.id, 3)), 200);
  f.rebuildApplication(); await f.login(false);
  const saved = (await response(await f.request('GET', base + '/properties/' + p.id), 200)).data;
  assert.equal(saved.id, p.id); assert.equal(saved.createdAt, p.createdAt); assert.equal(saved.version, 4);
  assert.equal((await response(await f.request('GET', `${base}/properties/${p.id}/audit`), 200)).data.length, 4);
  assert.equal(f.fake.facts.calls.enroll, 0); assert.equal(f.fake.facts.calls.mfa, 0);
});

test('Password QA: concurrent identical commands commit once and stale edits cannot overwrite a winner', async t => {
  const f = await fixture(t); await f.login(false); const key = randomUUID(), payload = { name: 'Synthetic password retry villa' };
  const replies = await Promise.all([0, 1].map(() => f.request('POST', base + '/properties', payload, { 'Idempotency-Key': key })));
  const bodies = await Promise.all(replies.map(r => response(r, 201))); assert.equal(bodies[0].data.id, bodies[1].data.id);
  assert.equal(replies.filter(r => r.headers.get('Idempotent-Replay') === 'true').length, 1);
  const id = bodies[0].data.id;
  const edits = await Promise.all(['one', 'two'].map(name => f.request('PATCH', base + '/properties/' + id, { name: 'Synthetic winner ' + name }, pre(id, 1))));
  assert.deepEqual(edits.map(r => r.status).sort(), [200, 412]);
  assert.equal((await response(await f.request('GET', base + '/dashboard'), 200)).data.totalProperties, 1);
  assert.equal((await response(await f.request('GET', `${base}/properties/${id}/audit`), 200)).data.length, 2);
});

// Exercise the concrete managed SDK adapter with signed claims and a completely
// intercepted transport. Each process owns one ephemeral JWKS key.
const signingKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
function sdk() {
  const projectRef = 'qrstuvwxyzabcdefghij', issuer = `https://${projectRef}.supabase.co/auth/v1`;
  const subject = '55550000-1111-4111-8111-111111111111', sessionId = '55550000-2222-4222-8222-222222222222';
  const email = 'synthetic-password-owner@example.invalid';
  const facts = { anonymous: false, verified: true, passwordAmr: true, wrongEmailClaim: false, wrongSubjectClaim: false, wrongIssuer: false,
    missingSession: false, expired: false, badSignature: false, revoked: false, calls: [] as string[] };
  const user = () => ({ id: subject, email, email_confirmed_at: facts.verified ? '2026-01-01T00:00:00Z' : null,
    confirmed_at: facts.verified ? '2026-01-01T00:00:00Z' : null, is_anonymous: facts.anonymous,
    aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { role: 'admin' }, factors: [] });
  const jwt = () => {
    const now = Math.floor(Date.now() / 1000), encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const text = encode({ typ: 'JWT', alg: 'RS256', kid: 'password-independent-qa' }) + '.' + encode({
      iss: facts.wrongIssuer ? 'https://foreign.example.invalid/auth/v1' : issuer, sub: facts.wrongSubjectClaim ? OTHER_QA_SUBJECT : subject,
      email: facts.wrongEmailClaim ? 'other@example.invalid' : email, aud: 'authenticated', role: 'authenticated', iat: now,
      exp: facts.expired ? now - 1 : now + 3600, session_id: facts.missingSession ? undefined : sessionId,
      aal: 'aal1', amr: [{ method: facts.passwordAmr ? 'password' : 'otp', timestamp: now }], is_anonymous: facts.anonymous });
    const signature = sign('RSA-SHA256', Buffer.from(text), signingKeys.privateKey); if (facts.badSignature) signature[0] ^= 1;
    return text + '.' + signature.toString('base64url');
  };
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url); assert.equal(url.origin, `https://${projectRef}.supabase.co`);
    facts.calls.push(request.method + ' ' + url.pathname + url.search);
    if (url.pathname.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [{ ...signingKeys.publicKey.export({ format: 'jwk' }), kid: 'password-independent-qa', alg: 'RS256', use: 'sig' }] });
    if (url.pathname.endsWith('/token')) {
      if (facts.revoked) return Response.json({ error_code: 'refresh_token_not_found', msg: 'Synthetic revoked' }, { status: 400 });
      return Response.json({ access_token: jwt(), refresh_token: 'SYNTHETIC_PASSWORD_QA_REFRESH', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: user() });
    }
    if (url.pathname.endsWith('/user')) return facts.revoked
      ?Response.json({code:'session_not_found',msg:'Synthetic managed session revoked'},{status:403}):Response.json(user());
    if (url.pathname.endsWith('/logout')) { facts.revoked = true; return new Response(null, { status: 204 }); }
    throw new Error('Unexpected SDK endpoint intercepted: ' + url.pathname);
  };
  return { facts, email, provider: createManagedOwnerProvider({ supabaseUrl: `https://${projectRef}.supabase.co`, publishableKey: 'sb_publishable_SYNTHETIC_PASSWORD_QA_ONLY', requestTimeoutMs: 3000, fetch: fetcher }) };
}

test('Password SDK QA: verified password aal1 uses live managed-user checks without needless refresh', async () => {
  const f = sdk(), session = await f.provider.signIn(f.email, 'SYNTHETIC_TEST_PASSWORD_ONLY');
  assert.equal(session.assurance, 'aal1'); assert.equal(session.factors.length, 0);
  await f.provider.verifySession(session.tokens);
  assert.ok(f.facts.calls.some(c => c.includes('grant_type=password'))); assert.equal(f.facts.calls.some(c => c.includes('grant_type=refresh_token')),false);
  assert.ok(f.facts.calls.some(c => c.endsWith('/user'))); assert.ok(f.facts.calls.every(c => !/factors|challenge|verify/.test(c)));
  await f.provider.signOut(session.tokens); await assert.rejects(() => f.provider.verifySession(session.tokens));
});

for (const flag of ['anonymous', 'wrongEmailClaim', 'wrongSubjectClaim', 'wrongIssuer', 'missingSession', 'expired', 'badSignature'] as const) {
  test(`Password SDK QA: ${flag} signed/provider evidence is denied`, async () => {
    const f = sdk(); f.facts[flag] = true; await assert.rejects(() => f.provider.signIn(f.email, 'SYNTHETIC_TEST_PASSWORD_ONLY'));
  });
}
for (const flag of ['verified', 'passwordAmr'] as const) {
  test(`Password SDK QA: missing ${flag} evidence cannot be replaced by client admin metadata`, async () => {
    const f = sdk(); f.facts[flag] = false; await assert.rejects(() => f.provider.signIn(f.email, 'SYNTHETIC_TEST_PASSWORD_ONLY'));
  });
}
