import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createManagedOwnerProvider } from '../src/owner-auth';
import { createOwnerQaFixture, ownerQaDeferred, ownerQaInputs, OTHER_QA_SUBJECT, OWNER_QA_FACTOR } from './support/owner-crm-harness';

async function fixture(t: TestContext) { const f = await createOwnerQaFixture(); t.after(() => f.close()); return f; }
async function result(response: Response, status: number, code?: string) {
  const body = await response.clone().json(); assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get('Cache-Control')?.replaceAll(' ', ''), 'private,no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Request-Id'), body.requestId);
  if (code) assert.equal(body.error?.code, code);
  return body;
}

test('Owner QA: anonymous preflight supplies CSRF while direct protected requests deny', async t => {
  const f = await fixture(t); const state = await result(await f.auth('GET', 'state'), 200);
  assert.equal(state.data.state, 'anonymous'); assert.ok(state.data.csrfToken);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 401, 'UNAUTHENTICATED');
  await result(await f.request('GET', '/api/hamdee/v1/session', undefined, { Authorization: 'Bearer synthetic-owner-claim' }), 401, 'UNAUTHENTICATED');
});
test('Owner QA: configured owner with synthetic managed TOTP reaches protected dashboard', async t => {
  const f = await fixture(t); await f.login();
  assert.equal((await result(await f.auth('GET', 'state'), 200)).data.state, 'authenticated');
  const context = await result(await f.request('GET', '/api/hamdee/v1/session'), 200);
  assert.ok(context.data.capabilities.includes('archive'));
  const dashboard = await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  assert.deepEqual(dashboard.data, { totalProperties: 0, activeProperties: 0, archivedProperties: 0, recentProperties: [] });
});
test('Owner QA: owner aal1 and invalid TOTP cannot read or mutate property data', async t => {
  const f = await fixture(t); await f.login(false);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 403, 'MFA_REQUIRED');
  await result(await f.request('POST', '/api/hamdee/v1/properties', { name: f.inputs.propertyName }, { 'Idempotency-Key': crypto.randomUUID() }), 403, 'MFA_REQUIRED');
  await result(await f.auth('POST', 'mfa/enroll', {}), 200);
  await result(await f.auth('POST', 'mfa/verify', { factorId: OWNER_QA_FACTOR, code: '000000' }), 403, 'MFA_REQUIRED');
  assert.equal((await f.pg!.query<{ count: number }>('SELECT count(*)::int AS count FROM hamdee_private.properties')).rows[0].count, 0);
});
test('Owner QA: another authenticated subject or issuer is never elevated by email/claims', async t => {
  for (const mode of ['subject', 'issuer'] as const) {
    const f = await fixture(t); if (mode === 'subject') f.fake.facts.subject = OTHER_QA_SUBJECT; else f.fake.facts.wrongIssuer = true;
    await result(await f.auth('GET', 'state'), 200);
    await result(await f.auth('POST', 'login', { email: f.inputs.email, password: f.inputs.password }), 403, 'OWNER_ACCESS_DENIED');
    await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 401, 'UNAUTHENTICATED');
  }
});
test('Owner QA: CSRF mismatch/foreign Origin denies before provider login or property mutation', async t => {
  const f = await fixture(t); await f.auth('GET', 'state');
  const invalidHeaders: Record<string, string>[] = [{ 'X-Hamdee-CSRF': '' }, { Origin: 'https://other.invalid' }, { 'X-Hamdee-CSRF': 'synthetic-forged' }];
  for (const headers of invalidHeaders) {
    await result(await f.auth('POST', 'login', { email: f.inputs.email, password: f.inputs.password }, headers), 403, 'CSRF_REJECTED');
  }
  assert.equal(f.fake.facts.calls.signIn, 0); await f.login();
  const utf8Jar = f.jar.fork(), providerCalls = f.fake.facts.calls.verify;
  const utf8Proof = '\u00e9' + utf8Jar.csrfToken.slice(1);
  assert.equal(utf8Proof.length, utf8Jar.csrfToken.length);
  await result(await f.auth('POST', 'refresh', {}, { 'X-Hamdee-CSRF': utf8Proof }, utf8Jar), 403, 'CSRF_REJECTED');
  assert.equal(f.fake.facts.calls.verify, providerCalls);
  await result(await f.request('POST', '/api/hamdee/v1/properties', { name: f.inputs.propertyName }, { 'X-Hamdee-CSRF': '', 'Idempotency-Key': crypto.randomUUID() }), 403, 'CSRF_REJECTED');
  assert.equal((await f.pg!.query<{ count: number }>('SELECT count(*)::int AS count FROM hamdee_private.properties')).rows[0].count, 0);
});
test('Owner QA: cookie encryption/flags and auth projections exclude provider credentials', async t => {
  const f = await fixture(t); await f.auth('GET', 'state');
  const login = await f.auth('POST', 'login', { email: f.inputs.email, password: f.inputs.password });
  await result(login, 200);
  for (const cookie of login.headers.getSetCookie()) { assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i); assert.match(cookie, /Path=\//i); assert.doesNotMatch(cookie, /Domain=/i); }
  assert.doesNotMatch(await login.text(), /SYNTHETIC_PROVIDER|accessToken|refreshToken|password|synthetic-owner@example|ownerSubject/i);
  assert.ok(f.jar.values.has('hamdee_owner')); assert.doesNotMatch(f.jar.values.get('hamdee_owner')!, /SYNTHETIC_PROVIDER/);
  const copy = f.jar.fork(); const original = copy.values.get('hamdee_owner')!;
  copy.values.set('hamdee_owner', (original[0] === 'A' ? 'B' : 'A') + original.slice(1));
  await result(await f.request('GET', '/api/hamdee/v1/dashboard', undefined, {}, copy), 401, 'UNAUTHENTICATED');
});
test('Owner QA: logout revokes copied cookies despite unexpired access metadata', async t => {
  const f = await fixture(t); await f.login(); const copied = f.jar.fork();
  await result(await f.auth('POST', 'logout', {}), 200);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard', undefined, {}, copied), 401, 'UNAUTHENTICATED');
  assert.ok(f.fake.facts.calls.signOut > 0); assert.equal(f.jar.values.has('hamdee_owner'), false);
});
test('Owner QA: unconfirmed provider logout clears local cookie without claiming copied-cookie revocation', async t => {
  const f = await fixture(t); await f.login(); f.fake.facts.unconfirmedLogout = true;
  await result(await f.auth('POST', 'logout', {}), 503, 'SIGN_OUT_UNCONFIRMED');
  assert.equal(f.jar.values.has('hamdee_owner'), false);
});
test('Owner QA: state polling and refresh never extend signed idle expiry', async t => {
  const f = await fixture(t); await f.login(); f.clock.advance(f.inputs.idleMilliseconds - 1);
  await result(await f.auth('GET', 'state'), 200); await result(await f.auth('POST', 'refresh', {}), 200);
  f.clock.advance(1); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 401, 'UNAUTHENTICATED');
});
test('Owner QA: active requests and renewed MFA cannot extend original absolute lifetime', async t => {
  const f = await createOwnerQaFixture({ timings: { idleTimeoutMs: 20_000, absoluteTimeoutMs: 60_000, csrfLifetimeMs: 10_000, mfaMaxAgeMs: 60_000 } });
  t.after(() => f.close()); await f.login(); const start = f.clock.now();
  for (let i = 0; i < 4; i++) { f.clock.advance(10_000); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200); }
  // Renew MFA at 40s, isolating the 60s absolute deadline from MFA recency.
  await result(await f.auth('GET', 'state'), 200);
  await result(await f.auth('POST', 'mfa/verify', { factorId: OWNER_QA_FACTOR, code: f.inputs.validTotp }), 200);
  f.clock.advance(10_000); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  f.clock.advance(9_999); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  assert.equal((await result(await f.auth('GET', 'state'), 200)).data.expiresAt, start + 60_000);
  f.clock.advance(1); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 401, 'UNAUTHENTICATED');
});
test('Owner QA: MFA age expires during active requests while idle and absolute lifetimes remain valid', async t => {
  const f = await createOwnerQaFixture({ timings: { idleTimeoutMs: 20_000, absoluteTimeoutMs: 120_000, csrfLifetimeMs: 10_000, mfaMaxAgeMs: 15_000 } });
  t.after(() => f.close()); await f.login(); const start = f.clock.now();
  for (const elapsed of [5_000, 5_000, 4_999]) { f.clock.advance(elapsed); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200); }
  assert.equal((await result(await f.auth('GET', 'state'), 200)).data.expiresAt, start + 15_000);
  f.clock.advance(1); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 403, 'MFA_REQUIRED');
});
test('Owner QA: provider/database/limiter/audit failures remain explicit fail-closed failures', async t => {
  const f = await fixture(t); await f.login();
  f.fake.facts.unavailable = true; await result(await f.auth('GET', 'state'), 503, 'AUTH_UNAVAILABLE'); f.fake.facts.unavailable = false;
  f.hooks.databaseAvailable = false; await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 503, 'STORAGE_UNAVAILABLE');
  const g = await fixture(t); await g.auth('GET', 'state'); g.hooks.limiterAvailable = false;
  await result(await g.auth('POST', 'login', { email: g.inputs.email, password: g.inputs.password }), 503);
  const a = await fixture(t); await a.auth('GET', 'state'); a.hooks.auditAvailable = false;
  await result(await a.auth('POST', 'login', { email: a.inputs.email, password: a.inputs.password }), 503);
});
test('Owner QA: recovery is preparation only, globally revokes current session and sends no messages', async t => {
  const f = await fixture(t); await f.login(); const copied = f.jar.fork();
  const recovery = await result(await f.auth('POST', 'recovery', { email: f.inputs.email }), 202);
  assert.equal(recovery.data.state, 'recovery_pending');
  await result(await f.request('GET', '/api/hamdee/v1/dashboard', undefined, {}, copied), 401);
  assert.ok(f.fake.facts.calls.signOut > 0);
});
test('Owner QA: late refresh or MFA cookie after logout cannot regain managed business access', async t => {
  for (const phase of ['refresh', 'mfa'] as const) {
    const f = await fixture(t); await f.login(phase === 'refresh');
    if (phase === 'mfa') await result(await f.auth('POST', 'mfa/enroll', {}), 200);
    const copied = f.jar.fork(), gate = { entered: ownerQaDeferred<void>(), release: ownerQaDeferred<void>() };
    if (phase === 'refresh') f.fake.facts.verifyGate = gate; else f.fake.facts.mfaGate = gate;
    const late = phase === 'refresh' ? f.auth('POST', 'refresh', {}, {}, copied) : f.auth('POST', 'mfa/verify', { factorId: OWNER_QA_FACTOR, code: f.inputs.validTotp }, {}, copied);
    await gate.entered.promise; f.fake.facts.verifyGate = null; f.fake.facts.mfaGate = null;
    await result(await f.auth('POST', 'logout', {}), 200); gate.release.resolve();
    await late; await result(await f.request('GET', '/api/hamdee/v1/dashboard', undefined, {}, copied), 401);
  }
});
test('Owner QA: strict JSON/body/method validation never creates an identity', async t => {
  const f = await fixture(t); await f.auth('GET', 'state');
  await result(await f.auth('POST', 'login', { email: f.inputs.email, password: f.inputs.password, role: 'admin' }), 422, 'VALIDATION_FAILED');
  await result(await f.auth('POST', 'login', { email: f.inputs.email, password: f.inputs.password }, { 'Content-Type': 'text/plain' }), 415, 'JSON_REQUIRED');
  await result(await f.auth('POST', 'signup', {}), 404, 'NOT_FOUND');
  assert.equal(f.fake.facts.calls.signIn, 0);
});
test('Owner QA: returning owner gets aal1 plus existing verified factor and verifies without reenrollment', async t => {
  const f = await fixture(t); await f.login(); const enrolled = f.fake.facts.calls.enroll;
  await result(await f.auth('POST', 'logout', {}), 200); await f.login(false);
  const state = await result(await f.auth('GET', 'state'), 200);
  assert.equal(state.data.state, 'mfa_required'); assert.deepEqual(state.data.factors, [{ id: OWNER_QA_FACTOR, status: 'verified' }]);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 403, 'MFA_REQUIRED');
  await result(await f.auth('POST', 'mfa/verify', { factorId: OWNER_QA_FACTOR, code: f.inputs.validTotp }), 200);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200); assert.equal(f.fake.facts.calls.enroll, enrolled);
});
test('Owner QA: abandoned enrollment never becomes account verification or business access on new login', async t => {
  const f = await fixture(t); await f.login(false); await result(await f.auth('POST', 'mfa/enroll', {}), 200);
  assert.equal(f.fake.facts.accountFactorVerified, false); await result(await f.auth('POST', 'logout', {}), 200); await f.login(false);
  const state = await result(await f.auth('GET', 'state'), 200); assert.equal(state.data.state, 'mfa_required');
  assert.equal(state.data.factors.some((factor: { status: string }) => factor.status === 'verified'), false);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 403, 'MFA_REQUIRED');
});

// Actual managed SDK adapter exercised through its injected fetch; every URL
// is intercepted and checked. No provider account/request or global fetch patch.
// One ephemeral key per test process avoids contradicting the SDK's legitimate
// shared JWKS cache by replacing the key behind the same synthetic issuer/kid.
const sdkSigningKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
function sdkTransport() {
  const inputs = ownerQaInputs(), { privateKey, publicKey } = sdkSigningKeys;
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'owner-qa-rsa', alg: 'RS256', use: 'sig' };
  const facts = { revoked: false, anonymous: false, wrongSubject: false, badSignature: false, aal2: false, calls: [] as string[] };
  const factorId = '44440000-5555-4555-8555-555555555555', sessionId = '44440000-6666-4666-8666-666666666666';
  const user = () => ({ id: facts.wrongSubject ? OTHER_QA_SUBJECT : inputs.ownerSubject, aud: 'authenticated', role: 'authenticated',
    email: inputs.email, is_anonymous: facts.anonymous, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { role: 'admin' },
    factors: facts.aal2 ? [{ id: factorId, factor_type: 'totp', status: 'verified', friendly_name: 'Synthetic TOTP' }] : [] });
  const jwt = () => {
    const seconds = Math.floor(Date.now() / 1000), enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const content = enc({ typ: 'JWT', alg: 'RS256', kid: 'owner-qa-rsa' }) + '.' + enc({ iss: inputs.issuer, sub: user().id,
      aud: 'authenticated', role: 'authenticated', iat: seconds, exp: seconds + 3600, session_id: sessionId,
      aal: facts.aal2 ? 'aal2' : 'aal1', amr: [{ method: 'password', timestamp: seconds }, ...(facts.aal2 ? [{ method: 'totp', timestamp: seconds }] : [])], is_anonymous: facts.anonymous });
    const signature = sign('RSA-SHA256', Buffer.from(content), privateKey); if (facts.badSignature) signature[0] ^= 1;
    return content + '.' + signature.toString('base64url');
  };
  const session = () => ({ access_token: jwt(), refresh_token: 'SYNTHETIC_SDK_REFRESH', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user: user() });
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.origin, 'https://' + inputs.projectRef + '.supabase.co');
    facts.calls.push(request.method + ' ' + url.pathname + url.search);
    if (url.pathname.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [publicJwk] });
    if (url.pathname.endsWith('/token')) {
      if (facts.revoked) return Response.json({ error_code: 'refresh_token_not_found', msg: 'Synthetic revoked refresh' }, { status: 400 });
      return Response.json(session());
    }
    if (url.pathname.endsWith('/user')) return Response.json(user());
    if (url.pathname.endsWith('/logout')) { facts.revoked = true; return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith('/factors') && request.method === 'POST') return Response.json({ id: factorId, type: 'totp', totp: { qr_code: '<svg/>', secret: 'SYNTHETIC_ONLY', uri: 'otpauth://totp/Synthetic' } });
    if (url.pathname.endsWith('/factors')) return Response.json({ all: user().factors, totp: user().factors, phone: [] });
    if (url.pathname.endsWith('/challenge')) return Response.json({ id: '44440000-7777-4777-8777-777777777777', type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 60 });
    if (url.pathname.endsWith('/verify')) { facts.aal2 = true; return Response.json(session()); }
    throw new Error('Unexpected intercepted SDK endpoint: ' + url.pathname);
  };
  const provider = createManagedOwnerProvider({ supabaseUrl: 'https://' + inputs.projectRef + '.supabase.co', publishableKey: 'sb_publishable_SYNTHETIC_QA_ONLY', requestTimeoutMs: 3000, fetch: fetcher });
  return { provider, facts, inputs, factorId };
}
test('Owner SDK QA: concrete adapter uses password/refresh/user/claims and verified factor transport', async () => {
  const f = sdkTransport(); const primary = await f.provider.signIn(f.inputs.email, f.inputs.password);
  assert.equal(primary.identity.subject, f.inputs.ownerSubject); assert.equal(primary.assurance, 'aal1');
  const enrolled = await f.provider.enrollTotp(primary.tokens); const verified = await f.provider.verifyTotp(enrolled.session.tokens, f.factorId, '444444');
  assert.equal(verified.assurance, 'aal2'); assert.ok(verified.factors.some(factor => factor.status === 'verified'));
  await f.provider.verifySession(verified.tokens);
  assert.ok(f.facts.calls.some(call => call.includes('grant_type=password')));
  assert.ok(f.facts.calls.some(call => call.includes('grant_type=refresh_token')));
  assert.ok(f.facts.calls.some(call => call.includes('/user')));
});
test('Owner SDK QA: anonymous identity and invalid signed claims are rejected by actual adapter', async () => {
  for (const flag of ['anonymous', 'badSignature'] as const) {
    const f = sdkTransport(); await f.provider.signIn(f.inputs.email, f.inputs.password);
    f.facts[flag] = true; await assert.rejects(() => f.provider.signIn(f.inputs.email, f.inputs.password));
  }
});
test('Owner SDK QA: global sign-out invalidates copied refresh input without any hosted request', async () => {
  const f = sdkTransport(), session = await f.provider.signIn(f.inputs.email, f.inputs.password);
  await f.provider.signOut(session.tokens); await assert.rejects(() => f.provider.verifySession(session.tokens));
  assert.ok(f.facts.calls.some(call => call.includes('/logout') && call.includes('scope=global')));
});
