import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { ApiError } from '../src/errors';
import { createManagedOwnerProvider, createOwnerAuth, type OwnerTokenPair } from '../src/owner-auth';
import { createOwnerQaFixture, OwnerCookieJar, ownerQaDeferred, ownerQaInputs } from './support/owner-crm-harness';

// Real installed SDK, intercepted transport, ephemeral synthetic signing key.
// No process-global fetch replacement, hosted request or provider account.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
function sdk(timeout = 3000) {
  const inputs = ownerQaInputs(), origin = 'https://' + inputs.projectRef + '.supabase.co';
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'logout-regression-rsa', alg: 'RS256', use: 'sig' };
  const sessionId = '44440000-6666-4666-8666-666666666666';
  const passwordTime = Math.floor(Date.now() / 1000) - 300;
  const facts = { revoked: false, refreshUnavailable: false, wrongSubject: false, wrongSession: false, wrongPasswordTime: false,
    hangLogout: false, rejectNextLogout: false, logoutStatus: 204, refreshes: 0, logouts: 0, statuses: [] as number[] };
  const user = (refreshed = false) => ({ id: refreshed && facts.wrongSubject ? '44440000-2222-4222-8222-222222222222' : inputs.ownerSubject, email: inputs.email, email_confirmed_at: new Date().toISOString(),
    aud: 'authenticated', role: 'authenticated', is_anonymous: false, factors: [] });
  const jwt = (expired = false, refreshed = false) => {
    const now = Math.floor(Date.now() / 1000), encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid }) + '.' + encode({
      iss: inputs.issuer, sub: user(refreshed).id, aud: 'authenticated', role: 'authenticated',
      iat: now - 120, exp: expired ? now - 60 : now + 3600,
      session_id: refreshed && facts.wrongSession ? '44440000-7777-4777-8777-777777777777' : sessionId,
      email: inputs.email, aal: 'aal1', amr: [{ method: 'password', timestamp: passwordTime + (refreshed && facts.wrongPasswordTime ? 1 : 0) }], is_anonymous: false
    });
    return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString('base64url');
  };
  const tokens = (expired = false): OwnerTokenPair => ({ accessToken: jwt(expired), refreshToken: 'SYNTHETIC_LOGOUT_REFRESH' });
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.origin, origin);
    if (url.pathname.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.pathname.endsWith('/user')) return facts.revoked
      ?Response.json({code:'session_not_found',msg:'Synthetic managed session revoked'},{status:403}):Response.json(user(true));
    if (url.pathname.endsWith('/token')) {
      const grant = url.searchParams.get('grant_type');
      assert.ok(grant === 'password' || grant === 'refresh_token');
      if (grant === 'refresh_token') {
        assert.equal((await request.json()).refresh_token, 'SYNTHETIC_LOGOUT_REFRESH'); facts.refreshes++;
      } else {
        assert.deepEqual(await request.json(), { email: inputs.email, password: inputs.password, gotrue_meta_security: {} });
      }
      if (facts.revoked || facts.refreshUnavailable) return Response.json({ error_code: 'refresh_token_not_found', msg: 'Synthetic unavailable session' }, { status: 400 });
      return Response.json({ access_token: jwt(false, true), refresh_token: 'SYNTHETIC_LOGOUT_REFRESH', token_type: 'bearer', expires_in: 3600, user: user(true) });
    }
    if (url.pathname.endsWith('/logout')) {
      assert.equal(request.method, 'POST'); assert.equal(url.searchParams.get('scope'), 'global');
      facts.logouts++;
      const access = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
      const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'));
      const status = claims.exp <= Math.floor(Date.now() / 1000) || facts.rejectNextLogout ? 401 : facts.logoutStatus;
      facts.rejectNextLogout = false;
      facts.statuses.push(status);
      if (status !== 204) return Response.json({ code: status === 401 ? 'bad_jwt' : 'synthetic_logout_failure', msg: 'Synthetic sign-out rejected' }, { status });
      if (facts.hangLogout) await new Promise<never>((_resolve, reject) => {
        if (request.signal.aborted) reject(new Error('Synthetic aborted request'));
        else request.signal.addEventListener('abort', () => reject(new Error('Synthetic aborted request')), { once: true });
      });
      facts.revoked = true; return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected synthetic auth path: ' + url.pathname);
  };
  return { facts, tokens, inputs, binding: { identity: { issuer: inputs.issuer, subject: inputs.ownerSubject }, sessionId, passwordAuthenticatedAt: passwordTime * 1000 },
    provider: createManagedOwnerProvider({ supabaseUrl: origin,
    publishableKey: 'sb_publishable_SYNTHETIC_LOGOUT_ONLY', requestTimeoutMs: timeout, fetch: fetcher }) };
}

test('Logout regression: expired user JWT with a live managed refresh session still confirms global sign-out', async () => {
  const f = sdk();
  await f.provider.signOut(f.tokens(true), f.binding);
  assert.equal(f.facts.revoked, true);
  assert.deepEqual(f.facts.statuses, [401, 204]);
  assert.equal(f.facts.refreshes, 1);
  await assert.rejects(f.provider.verifySession(f.tokens()));
});

test('Logout regression: valid JWT keeps the single global sign-out request and no refresh', async () => {
  const f = sdk(); await f.provider.signOut(f.tokens());
  assert.equal(f.facts.revoked, true); assert.equal(f.facts.logouts, 1); assert.equal(f.facts.refreshes, 0);
});

test('Logout regression: controller forwards sealed owner/session binding to the real SDK retry', async () => {
  const f = sdk(), origin = 'http://127.0.0.1:4189', jar = new OwnerCookieJar();
  const auth = createOwnerAuth({ policy: { owner: f.binding.identity, ownerEmail: f.inputs.email, projectRef: f.inputs.projectRef,
    origin, cookieSecure: false, idleTimeoutMs: 900000, absoluteTimeoutMs: 28800000, csrfLifetimeMs: 600000 },
    provider: f.provider, cookieKey: new Uint8Array(32).fill(71), clock: () => Date.now(), randomBytes,
    limiter: { async consume() { return true; } }, audit: { async append() {} } });
  const request = async (method: string, action: string, body?: unknown) => {
    const response = await auth.handle(new Request(origin + '/api/hamdee/auth/' + action, { method,
      headers: { Origin: origin, Cookie: jar.header(), 'X-Hamdee-CSRF': jar.csrfToken, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    await jar.accept(response); return response;
  };
  assert.equal((await request('GET', 'state')).status, 200);
  assert.equal((await request('POST', 'login', { email: f.inputs.email, password: f.inputs.password })).status, 200);
  f.facts.rejectNextLogout = true;
  assert.equal((await request('POST', 'logout', {})).status, 200);
  assert.deepEqual(f.facts.statuses, [401, 204]); assert.equal(f.facts.revoked, true);
  assert.equal(jar.values.has('hamdee_owner'), false);
});

test('Logout regression: failed managed refresh never turns a rejected logout into success', async () => {
  const f = sdk(); f.facts.refreshUnavailable = true;
  await assert.rejects(f.provider.signOut(f.tokens(true), f.binding));
  assert.equal(f.facts.revoked, false); assert.equal(f.facts.logouts, 1); assert.equal(f.facts.refreshes, 1);
});

test('Logout regression: failed second sign-out stays unconfirmed and is not retried repeatedly', async () => {
  const f = sdk(); f.facts.logoutStatus = 503;
  await assert.rejects(f.provider.signOut(f.tokens(true), f.binding), (error: unknown) => error instanceof ApiError && error.code === 'SIGN_OUT_UNCONFIRMED');
  assert.equal(f.facts.revoked, false); assert.deepEqual(f.facts.statuses, [401, 503]); assert.equal(f.facts.refreshes, 1);
});

test('Logout regression: other provider failures are not swallowed or silently retried', async t => {
  for (const status of [403, 404, 429, 500, 503]) await t.test(String(status), async () => {
    const f = sdk(); f.facts.logoutStatus = status;
    await assert.rejects(f.provider.signOut(f.tokens()), (error: unknown) => error instanceof ApiError && error.code === 'SIGN_OUT_UNCONFIRMED');
    assert.equal(f.facts.revoked, false); assert.equal(f.facts.logouts, 1); assert.equal(f.facts.refreshes, 0);
  });
});

test('Logout regression: refresh and retry share one deadline; timeout never confirms revocation', async () => {
  const f = sdk(250); f.facts.hangLogout = true;
  await assert.rejects(f.provider.signOut(f.tokens(true), f.binding), (error: unknown) => error instanceof ApiError && error.status === 503);
  assert.equal(f.facts.revoked, false); assert.equal(f.facts.refreshes, 1); assert.equal(f.facts.logouts, 2);
});

test('Logout regression: refreshed owner/session/password binding must match before a second global request', async t => {
  for (const flag of ['wrongSubject', 'wrongSession', 'wrongPasswordTime'] as const) await t.test(flag, async () => {
    const f = sdk(); f.facts[flag] = true;
    await assert.rejects(f.provider.signOut(f.tokens(true), f.binding));
    assert.equal(f.facts.revoked, false); assert.equal(f.facts.logouts, 1); assert.equal(f.facts.refreshes, 1);
  });
  await t.test('no trusted binding', async () => {
    const f = sdk(); await assert.rejects(f.provider.signOut(f.tokens(true)));
    assert.equal(f.facts.revoked, false); assert.equal(f.facts.logouts, 1); assert.equal(f.facts.refreshes, 0);
  });
});

test('Logout regression: confirmed revocation denies copied cookies on every protected read and auth refresh', async t => {
  const f = await createOwnerQaFixture(); t.after(() => f.close()); await f.login();
  const copied = f.jar.fork();
  const logout = await f.auth('POST', 'logout', {}); assert.equal(logout.status, 200);
  assert.equal(f.jar.values.has('hamdee_owner'), false);
  for (const route of ['/dashboard', '/properties', '/rental', '/expenses', '/staff-collections?month=2026-10&asOf=2026-10-16']) {
    const response = await f.request('GET', '/api/hamdee/v1' + route, undefined, {}, copied.fork());
    assert.equal(response.status, 401); assert.equal((await response.json()).data, undefined);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  const refresh = await f.auth('POST', 'refresh', {}, {}, copied.fork()); assert.equal(refresh.status, 401);
  const state = await f.auth('GET', 'state', undefined, {}, copied.fork()); assert.equal((await state.json()).data.state, 'anonymous');
});

test('Logout regression: unconfirmed failure clears cookies; an anonymous retry does not prove revocation', async t => {
  const f = await createOwnerQaFixture(); t.after(() => f.close()); await f.login();
  const copied = f.jar.fork(); f.fake.facts.unconfirmedLogout = true;
  const response = await f.auth('POST', 'logout', {});
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'SIGN_OUT_UNCONFIRMED');
  assert.equal(f.jar.values.has('hamdee_owner'), false); assert.equal(f.jar.values.has('hamdee_csrf'), false);
  const calls = f.fake.facts.calls.signOut;
  // Preserve this distinction: a failed provider revocation is not invalidation.
  assert.equal((await f.request('GET', '/api/hamdee/v1/dashboard', undefined, {}, copied)).status, 200);
  await f.auth('GET', 'state'); assert.equal((await f.auth('POST', 'logout', {})).status, 200);
  assert.equal(f.fake.facts.calls.signOut, calls);
  assert.ok(f.audit.some(e => e.event === 'logout' && e.outcome === 'unconfirmed'));
});

test('Logout regression: a late refresh cookie cannot retrieve private records after confirmed invalidation', async t => {
  const f = await createOwnerQaFixture(); t.after(() => f.close()); await f.login();
  const late = f.jar.fork(), gate = { entered: ownerQaDeferred<void>(), release: ownerQaDeferred<void>() };
  f.fake.facts.verifyGate = gate;
  const pending = f.auth('POST', 'refresh', {}, {}, late); await gate.entered.promise;
  try { assert.equal((await f.auth('POST', 'logout', {})).status, 200); }
  finally { f.fake.facts.verifyGate = null; gate.release.resolve(); }
  const delivered = await pending; assert.equal(delivered.status, 200);
  assert.equal((await f.request('GET', '/api/hamdee/v1/dashboard', undefined, {}, late)).status, 401);
});
