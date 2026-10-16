import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createManagedOwnerProvider } from '../../src/owner-auth';
import { createOwnerQaFixture, ownerProviderFake, ownerQaClock, ownerQaInputs } from '../support/owner-crm-harness';

// Independent local HTTP regressions. Only a constructor-injected synthetic
// provider and disposable PGlite; no hosted credentials, accounts or services.
const base = '/api/hamdee/v1';
async function fixture(t: TestContext) {
  const f = await createOwnerQaFixture({ migrationFiles: ['006_local_operations_records.up.sql'] });
  t.after(() => f.close()); await f.login(); return f;
}
async function value(response: Response, expected: number) {
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
}

test('Independent logout: confirmed global logout denies copied synthetic cookie, refresh and direct business APIs', async t => {
  const f = await fixture(t), copied = f.jar.fork();
  await value(await f.auth('POST', 'logout', {}), 200); assert.equal(f.fake.facts.calls.signOut, 1);
  for (const route of ['/dashboard', '/properties', '/rental', '/expenses', '/staff-collections?month=2026-10&asOf=2026-10-16']) {
    const response = await f.request('GET', base + route, undefined, {}, copied.fork());
    assert.equal((await value(response, 401)).error.code, 'UNAUTHENTICATED');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  const stale = copied.fork(); await value(await f.auth('GET', 'state', undefined, {}, stale), 200);
  assert.equal(stale.values.has('hamdee_owner'), false);
  await value(await f.auth('POST', 'refresh', {}, {}, copied.fork()), 401);
});

test('Independent logout: expired CSRF rejects before provider; normal authenticated state renewal enables explicit retry', async t => {
  const f = await fixture(t); f.clock.advance(10_001);
  assert.equal((await value(await f.auth('POST', 'logout', {}), 403)).error.code, 'CSRF_REJECTED');
  assert.equal(f.fake.facts.calls.signOut, 0); assert.equal(f.jar.values.has('hamdee_owner'), true);
  assert.equal((await value(await f.auth('GET', 'state'), 200)).data.state, 'authenticated');
  await value(await f.auth('POST', 'logout', {}), 200); assert.equal(f.fake.facts.calls.signOut, 1);
  await value(await f.request('GET', base + '/dashboard'), 401);
});

test('Independent logout characterization: unconfirmed provider revocation clears local cookie; anonymous retry cannot prove global revocation', async t => {
  const f = await fixture(t), copied = f.jar.fork(); f.fake.facts.unconfirmedLogout = true;
  assert.equal((await value(await f.auth('POST', 'logout', {}), 503)).error.code, 'SIGN_OUT_UNCONFIRMED');
  assert.equal(f.jar.values.has('hamdee_owner'), false); assert.equal(f.fake.revoked.size, 0);
  assert.equal(f.audit.some(event => event.event === 'logout' && event.outcome === 'unconfirmed'), true);
  f.fake.facts.unconfirmedLogout = false;
  await value(await f.auth('GET', 'state'), 200); await value(await f.auth('POST', 'logout', {}), 200);
  assert.equal(f.fake.facts.calls.signOut, 1, 'Anonymous retry skipped the managed provider');
  await value(await f.request('GET', base + '/dashboard', undefined, {}, copied), 200);
});

test('Independent logout regression: managed access rejection with live refresh signs out using a newly verified JWT', async t => {
  const input = ownerQaInputs(), clock = ownerQaClock(Date.now()), fake = ownerProviderFake(clock);
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), sessionId = '44440000-7777-4777-8777-777777777777';
  const passwordAt = Math.floor(clock.now() / 1000), attempts: string[] = [];
  let serial = 0, rejectedAccess = '', revoked = false, renewals = 0;
  const user = { id: input.ownerSubject, email: input.email, email_confirmed_at: '2026-01-01T00:00:00Z',
    confirmed_at: '2026-01-01T00:00:00Z', is_anonymous: false, aud: 'authenticated', role: 'authenticated',
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, factors: [] };
  const jwt = () => {
    const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url'), now = Math.floor(Date.now() / 1000);
    const payload = encode({ alg: 'RS256', typ: 'JWT', kid: 'independent-logout-qa' }) + '.' + encode({
      iss: input.issuer, sub: input.ownerSubject, email: input.email, aud: 'authenticated', role: 'authenticated',
      iat: now, exp: now + 3600, session_id: sessionId, aal: 'aal1', amr: [{ method: 'password', timestamp: passwordAt }],
      is_anonymous: false, jti: 'SYNTHETIC-' + ++serial });
    return payload + '.' + sign('RSA-SHA256', Buffer.from(payload), keys.privateKey).toString('base64url');
  };
  const transport: typeof fetch = async (inputUrl, init) => {
    const request = new Request(inputUrl, init), url = new URL(request.url);
    assert.equal(url.origin, 'https://' + input.projectRef + '.supabase.co');
    if (url.pathname.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'independent-logout-qa', alg: 'RS256', use: 'sig' }] });
    if (url.pathname.endsWith('/token')) {
      if (revoked) return Response.json({ error_code: 'refresh_token_not_found', msg: 'Synthetic revoked' }, { status: 400 });
      if (url.searchParams.get('grant_type') === 'refresh_token') renewals++;
      return Response.json({ access_token: jwt(), refresh_token: 'SYNTHETIC_INDEPENDENT_REFRESH', token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, user });
    }
    if (url.pathname.endsWith('/user')) return Response.json(user);
    if (url.pathname.endsWith('/logout')) {
      const access = request.headers.get('Authorization') || ''; attempts.push(access);
      if (attempts.length === 1) {
        rejectedAccess = access;
        return Response.json({ error_code: 'bad_jwt', msg: 'Synthetic expired access JWT' }, { status: 401 });
      }
      revoked = true; return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected synthetic auth endpoint: ' + url.pathname);
  };
  const managed = createManagedOwnerProvider({ supabaseUrl: 'https://' + input.projectRef + '.supabase.co',
    publishableKey: 'sb_publishable_SYNTHETIC_INDEPENDENT_LOGOUT', requestTimeoutMs: 3000, fetch: transport });
  fake.provider = managed;
  const f = await createOwnerQaFixture({ clock, provider: fake }); t.after(() => f.close()); await f.login();
  const renewalsBeforeLogout = renewals;
  const copied = f.jar.fork(); await value(await f.auth('POST', 'logout', {}), 200);
  assert.equal(attempts.length, 2); assert.equal(attempts[0], rejectedAccess); assert.notEqual(attempts[1], rejectedAccess);
  assert.equal(renewals - renewalsBeforeLogout, 1); assert.equal(revoked, true);
  await value(await f.request('GET', base + '/dashboard', undefined, {}, copied), 401);
});
