import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
test('Owner QA: confirmed configured owner password session reaches protected dashboard', async t => {
  const f = await fixture(t); await f.login();
  assert.equal((await result(await f.auth('GET', 'state'), 200)).data.state, 'authenticated');
  const context = await result(await f.request('GET', '/api/hamdee/v1/session'), 200);
  assert.ok(context.data.capabilities.includes('archive'));
  const dashboard = await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  assert.deepEqual(dashboard.data, { totalProperties: 0, activeProperties: 0, archivedProperties: 0, recentProperties: [] });
});
test('Owner QA: owner aal1 password session reads properties without MFA enrollment', async t => {
  const f = await fixture(t); await f.login(false);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  await result(await f.auth('POST', 'mfa/enroll', {}), 404, 'NOT_FOUND');
  await result(await f.auth('POST', 'mfa/verify', { factorId: OWNER_QA_FACTOR, code: '000000' }), 404, 'NOT_FOUND');
  assert.equal(f.fake.facts.calls.enroll, 0); assert.equal(f.fake.facts.calls.mfa, 0);
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
test('Owner QA: active requests and refresh cannot extend original absolute lifetime', async t => {
  const f = await createOwnerQaFixture({ timings: { idleTimeoutMs: 20_000, absoluteTimeoutMs: 60_000, csrfLifetimeMs: 10_000 } });
  t.after(() => f.close()); await f.login(); const start = f.clock.now();
  for (let i = 0; i < 5; i++) { f.clock.advance(10_000); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200); }
  await result(await f.auth('GET', 'state'), 200); await result(await f.auth('POST', 'refresh', {}), 200);
  f.clock.advance(9_999); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  assert.equal((await result(await f.auth('GET', 'state'), 200)).data.expiresAt, start + 60_000);
  f.clock.advance(1); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 401, 'UNAUTHENTICATED');
});

test('Owner QA: changed or unconfirmed provider mailbox and invalid password proof revoke access', async t => {
  for (const mode of ['email', 'confirmed', 'password'] as const) {
    const f = await fixture(t); await f.login();
    if (mode === 'email') f.fake.facts.email = 'another-synthetic-owner@example.invalid';
    if (mode === 'confirmed') f.fake.facts.emailConfirmed = false;
    if (mode === 'password') f.fake.facts.passwordAuthenticatedAt = Number.NaN;
    await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 403, 'OWNER_ACCESS_DENIED');
    assert.equal(f.jar.values.has('hamdee_owner'), false);
  }
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
test('Owner QA: late refresh cookie after logout cannot regain managed business access', async t => {
  const f = await fixture(t); await f.login();
  const copied = f.jar.fork(), gate = { entered: ownerQaDeferred<void>(), release: ownerQaDeferred<void>() };
  f.fake.facts.verifyGate = gate;
  const late = f.auth('POST', 'refresh', {}, {}, copied);
  await gate.entered.promise; f.fake.facts.verifyGate = null;
  await result(await f.auth('POST', 'logout', {}), 200); gate.release.resolve();
  await late; await result(await f.request('GET', '/api/hamdee/v1/dashboard', undefined, {}, copied), 401);
});

test('Owner QA: strict JSON/body/method validation never creates an identity', async t => {
  const f = await fixture(t); await f.auth('GET', 'state');
  await result(await f.auth('POST', 'login', { email: f.inputs.email, password: f.inputs.password, role: 'admin' }), 422, 'VALIDATION_FAILED');
  await result(await f.auth('POST', 'login', { email: f.inputs.email, password: f.inputs.password }, { 'Content-Type': 'text/plain' }), 415, 'JSON_REQUIRED');
  await result(await f.auth('POST', 'signup', {}), 404, 'NOT_FOUND');
  assert.equal(f.fake.facts.calls.signIn, 0);
});
test('Owner QA: returning password owner needs no factor enrollment and cannot use another mailbox', async t => {
  const f = await fixture(t); await f.login(); await result(await f.auth('POST', 'logout', {}), 200);
  await f.login(false); const state = await result(await f.auth('GET', 'state'), 200);
  assert.equal(state.data.state, 'authenticated'); assert.deepEqual(state.data.factors, []);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  await result(await f.auth('POST', 'logout', {}), 200);
  const calls = f.fake.facts.calls.signIn;
  await result(await f.auth('POST', 'login', { email: 'other@example.invalid', password: f.inputs.password }), 401, 'UNAUTHENTICATED');
  assert.equal(f.fake.facts.calls.signIn, calls); assert.equal(f.fake.facts.calls.enroll, 0);
});

test('Owner QA: optional provider factors never activate app enrollment endpoints or waive password proof', async t => {
  const f = await fixture(t); f.fake.facts.accountFactorVerified = true;
  await f.login(false); assert.equal((await result(await f.auth('GET', 'state'), 200)).data.state, 'authenticated');
  await result(await f.auth('POST', 'mfa/enroll', {}), 404, 'NOT_FOUND');
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
});

test('Owner QA: optional factor removal and stale factor time never gate a password session', async t => {
  const f = await fixture(t); f.fake.facts.loginAal2 = true;
  await f.login(); f.fake.facts.factorActive = false;
  f.clock.advance(10_000);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  await result(await f.auth('GET', 'state'), 200);
  await result(await f.auth('POST', 'refresh', {}), 200);
  assert.equal(f.fake.facts.calls.enroll, 0); assert.equal(f.fake.facts.calls.mfa, 0);
});

test('Owner QA: provider refresh cannot replace the original password authentication binding', async t => {
  const f = await fixture(t); await f.login(); f.clock.advance(1);
  f.fake.facts.passwordAuthenticatedAt = f.clock.now();
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 401, 'UNAUTHENTICATED');
  assert.equal(f.jar.values.has('hamdee_owner'), false);
});

test('Owner QA: approved fifteen-minute idle and eight-hour absolute deadlines are strict', async t => {
  const timings = { idleTimeoutMs: 15 * 60_000, absoluteTimeoutMs: 8 * 60 * 60_000, csrfLifetimeMs: 60_000 };
  const f = await createOwnerQaFixture({ timings }); t.after(() => f.close()); await f.login();
  f.clock.advance(timings.idleTimeoutMs - 1);
  await result(await f.auth('GET', 'state'), 200);
  await result(await f.auth('POST', 'refresh', {}), 200);
  f.clock.advance(1);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 401, 'UNAUTHENTICATED');
  await f.login(); const start = f.clock.now();
  for (let elapsed = 10 * 60_000; elapsed < timings.absoluteTimeoutMs; elapsed += 10 * 60_000) {
    f.clock.advance(10 * 60_000); await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  }
  f.clock.advance(10 * 60_000 - 1);
  assert.equal((await result(await f.auth('GET', 'state'), 200)).data.expiresAt, start + timings.absoluteTimeoutMs);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 200);
  f.clock.advance(1);
  await result(await f.request('GET', '/api/hamdee/v1/dashboard'), 401, 'UNAUTHENTICATED');
});

// Actual managed SDK adapter exercised through its injected fetch; every URL
// is intercepted and checked. No provider account/request or global fetch patch.
// One ephemeral key per test process avoids contradicting the SDK's legitimate
// shared JWKS cache by replacing the key behind the same synthetic issuer/kid.
const sdkSigningKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
function sdkTransport() {
  const inputs = ownerQaInputs(), { privateKey, publicKey } = sdkSigningKeys;
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'owner-qa-rsa', alg: 'RS256', use: 'sig' };
  const facts = { revoked: false, anonymous: false, wrongSubject: false, badSignature: false, aal2: false, emailConfirmed: true, passwordProof: true, calls: [] as string[] };
  const passwordTime = Math.floor(Date.now() / 1000);
  const factorId = '44440000-5555-4555-8555-555555555555', sessionId = '44440000-6666-4666-8666-666666666666';
  const user = () => ({ id: facts.wrongSubject ? OTHER_QA_SUBJECT : inputs.ownerSubject, aud: 'authenticated', role: 'authenticated',
    email: inputs.email, email_confirmed_at: facts.emailConfirmed ? new Date().toISOString() : null, is_anonymous: facts.anonymous, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { role: 'admin' },
    factors: facts.aal2 ? [{ id: factorId, factor_type: 'totp', status: 'verified', friendly_name: 'Synthetic TOTP' }] : [] });
  const jwt = (expiresIn=3600) => {
    const seconds = Math.floor(Date.now() / 1000), enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const content = enc({ typ: 'JWT', alg: 'RS256', kid: 'owner-qa-rsa' }) + '.' + enc({ iss: inputs.issuer, sub: user().id,
      aud: 'authenticated', role: 'authenticated', iat: seconds-120, exp: seconds + expiresIn, session_id: sessionId,
      email: inputs.email, aal: facts.aal2 ? 'aal2' : 'aal1', amr: [...(facts.passwordProof ? [{ method: 'password', timestamp: passwordTime }] : []), ...(facts.aal2 ? [{ method: 'totp', timestamp: seconds }] : [])], is_anonymous: facts.anonymous });
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
    if (url.pathname.endsWith('/user')) return facts.revoked
      ?Response.json({code:'session_not_found',msg:'Synthetic managed session revoked'},{status:403}):Response.json(user());
    if (url.pathname.endsWith('/logout')) { facts.revoked = true; return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith('/factors') && request.method === 'POST') return Response.json({ id: factorId, type: 'totp', totp: { qr_code: '<svg/>', secret: 'SYNTHETIC_ONLY', uri: 'otpauth://totp/Synthetic' } });
    if (url.pathname.endsWith('/factors')) return Response.json({ all: user().factors, totp: user().factors, phone: [] });
    if (url.pathname.endsWith('/challenge')) return Response.json({ id: '44440000-7777-4777-8777-777777777777', type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 60 });
    if (url.pathname.endsWith('/verify')) { facts.aal2 = true; return Response.json(session()); }
    throw new Error('Unexpected intercepted SDK endpoint: ' + url.pathname);
  };
  const provider = createManagedOwnerProvider({ supabaseUrl: 'https://' + inputs.projectRef + '.supabase.co', publishableKey: 'sb_publishable_SYNTHETIC_QA_ONLY', requestTimeoutMs: 3000, fetch: fetcher });
  return { provider, facts, inputs, factorId, expiringTokens:(expiresIn:number)=>({accessToken:jwt(expiresIn),refreshToken:'SYNTHETIC_SDK_REFRESH'}) };
}
test('Owner SDK QA: concrete password adapter verifies live signed claims without needless rotation or factor transport', async () => {
  const f = sdkTransport(); const primary = await f.provider.signIn(f.inputs.email, f.inputs.password);
  assert.equal(primary.identity.subject, f.inputs.ownerSubject); assert.equal(primary.assurance, 'aal1');
  assert.equal(primary.email, f.inputs.email); assert.equal(primary.emailConfirmed, true); assert.ok(primary.passwordAuthenticatedAt > 0);
  const refreshed = await f.provider.verifySession(primary.tokens);
  assert.equal(refreshed.assurance, 'aal1'); assert.equal(refreshed.passwordAuthenticatedAt, primary.passwordAuthenticatedAt);
  assert.deepEqual(refreshed.factors, []); assert.equal(refreshed.mfaVerifiedAt, null);
  assert.ok(f.facts.calls.some(call => call.includes('grant_type=password')));
  assert.equal(f.facts.calls.some(call => call.includes('grant_type=refresh_token')),false);
  assert.ok(f.facts.calls.some(call => call.includes('/user')));
  assert.equal(f.facts.calls.some(call => call.includes('/factors')), false);
});

test('Owner SDK regression: concurrent navigation and repeated reads keep live verification without refresh-token races',async()=>{
  const f=sdkTransport(),login=await f.provider.signIn(f.inputs.email,f.inputs.password);
  for(let i=0;i<4;i++){
    const results=await Promise.all(Array.from({length:8},()=>f.provider.verifySession(login.tokens)));
    for(const r of results){assert.deepEqual(r.tokens,login.tokens);assert.equal(r.sessionId,login.sessionId);}
  }
  assert.equal(f.facts.calls.filter(c=>c.includes('grant_type=refresh_token')).length,0);
  assert.equal(f.facts.calls.filter(c=>c.endsWith('/user')).length,33);
  await f.provider.signOut(login.tokens);
  await assert.rejects(()=>f.provider.verifySession(login.tokens),{code:'UNAUTHENTICATED'});
  assert.equal(f.facts.calls.filter(c=>c.includes('grant_type=refresh_token')).length,0);
});

test('Owner SDK regression: expired and near-expiry JWTs renew once, then ordinary rechecks do not rotate again',async()=>{
  for(const expiresIn of [-60,20]){
    const f=sdkTransport(),login=await f.provider.signIn(f.inputs.email,f.inputs.password);
    const renewed=await f.provider.verifySession(f.expiringTokens(expiresIn));
    assert.equal(renewed.sessionId,login.sessionId);assert.equal(renewed.passwordAuthenticatedAt,login.passwordAuthenticatedAt);
    await Promise.all(Array.from({length:4},()=>f.provider.verifySession(renewed.tokens)));
    assert.equal(f.facts.calls.filter(c=>c.includes('grant_type=refresh_token')).length,1);
  }
});

test('Owner SDK regression: invalid signatures and malformed expiry never authorize ordinary reads',async()=>{
  const f=sdkTransport(),login=await f.provider.signIn(f.inputs.email,f.inputs.password);
  const parts=login.tokens.accessToken.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  await assert.rejects(()=>f.provider.verifySession({...login.tokens,accessToken:parts.join('.')}));
  for(const exp of [null,'9999999999',-1,1.5]){
    const bad='e30.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.eA';
    await assert.rejects(()=>f.provider.verifySession({...login.tokens,accessToken:bad}),{code:'UNAUTHENTICATED'});
  }
  assert.equal(f.facts.calls.filter(c=>c.includes('grant_type=refresh_token')).length,0);
});
test('Owner SDK QA: anonymous identity and invalid signed claims are rejected by actual adapter', async () => {
  for (const flag of ['anonymous', 'badSignature', 'emailConfirmed', 'passwordProof'] as const) {
    const f = sdkTransport(); await f.provider.signIn(f.inputs.email, f.inputs.password);
    f.facts[flag] = flag === 'anonymous' || flag === 'badSignature'; await assert.rejects(() => f.provider.signIn(f.inputs.email, f.inputs.password));
  }
});
test('Owner SDK QA: global sign-out invalidates copied refresh input without any hosted request', async () => {
  const f = sdkTransport(), session = await f.provider.signIn(f.inputs.email, f.inputs.password);
  await f.provider.signOut(session.tokens); await assert.rejects(() => f.provider.verifySession(session.tokens));
  assert.ok(f.facts.calls.some(call => call.includes('/logout') && call.includes('scope=global')));
});

test('Owner runtime diagnostic: fixed server categories omit secret canaries and preserve fail-closed responses', () => {
  const env:NodeJS.ProcessEnv={NODE_ENV:'test'};
  for(const name of ['SystemRoot','WINDIR','TEMP','TMP','PATH','ComSpec'])if(process.env[name])env[name]=process.env[name]!;
  const code=`
    import assert from 'node:assert/strict';
    import net from 'node:net';
    let fetches=0,sockets=0;
    globalThis.fetch=async()=>{fetches++;throw new Error('PRIVATE_PROVIDER_ERROR_CANARY');};
    net.Socket.prototype.connect=function(){sockets++;throw new Error('PRIVATE_SOCKET_ERROR_CANARY');};
    const warnings=[];console.warn=(...args)=>{warnings.push(args);};
    const {handleOwnerAuthRequest,handleOwnerPropertyRequest}=await import('./src/owner-runtime.ts');
    const base={
      HAMDEE_OWNER_RUNTIME_APPROVAL:'approved-development-owner-runtime',HAMDEE_APP_ID:'hamdee',
      HAMDEE_ENVIRONMENT:'development',HAMDEE_DATA_CLASS:'synthetic_only',HAMDEE_PROJECT_OWNER:'PRIVATE_OWNER_CANARY',
      HAMDEE_PROJECT_REF:'jfynuafwsympxxpkqags',HAMDEE_REGION:'ap-southeast-1',
      HAMDEE_RESIDENCY_DECISION:'approved_synthetic_development_only',
      HAMDEE_SUPABASE_URL:'https://jfynuafwsympxxpkqags.supabase.co',
      HAMDEE_AUTH_ISSUER:'https://jfynuafwsympxxpkqags.supabase.co/auth/v1',HAMDEE_AUTH_AUDIENCE:'authenticated',
      HAMDEE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_PRIVATE_KEY_CANARY',
      HAMDEE_OWNER_SUBJECT:'44440000-1111-4111-8111-111111111111',HAMDEE_OWNER_EMAIL:'private-email-canary@example.invalid',
      HAMDEE_OWNER_ORIGIN:'https://hamdee-git-codex-hamdee-demo-preview-faziils-projects.vercel.app',HAMDEE_OWNER_COOKIE_KEY:Buffer.alloc(32,12).toString('base64url'),
      HAMDEE_DATABASE_MODE:'hosted-development',HAMDEE_HOSTED_DATABASE_APPROVAL:'approved-isolated-demo-database',
      HAMDEE_DATABASE_URL:'postgres://hamdee_backend.jfynuafwsympxxpkqags:PRIVATE_DATABASE_CANARY@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
      VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'codex/hamdee-demo-preview',HAMDEE_OWNER_IDLE_MS:'900000',HAMDEE_OWNER_ABSOLUTE_MS:'28800000',
      HAMDEE_OWNER_CSRF_MS:'60000',HAMDEE_OWNER_AUTH_TIMEOUT_MS:'3000',HAMDEE_OWNER_RATE_WINDOW_MS:'60000',
      HAMDEE_OWNER_RATE_BOUNDS:'30',HAMDEE_OWNER_RATE_BACKOFF_MS:'60000'
    };
    const [stage,patch,loggerFails]=JSON.parse(process.argv[1]);
    Object.assign(process.env,base,patch);
    if(loggerFails)console.warn=()=>{throw new Error('PRIVATE_LOGGER_ERROR_CANARY');};
    for(const path of ['/api/hamdee/auth/state','/api/hamdee/auth/state','/api/hamdee/v1/properties']){
      const request=new Request('https://hamdee-git-codex-hamdee-demo-preview-faziils-projects.vercel.app'+path);
      const response=await(path.includes('/auth/')?handleOwnerAuthRequest(request):handleOwnerPropertyRequest(request));
      assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');
      const body=await response.json();assert.equal(body.error.code,'CONFIGURATION_UNAVAILABLE');
      assert.deepEqual(Object.keys(body).sort(),['error','requestId']);
      assert.doesNotMatch(JSON.stringify(body),/CANARY|stage|owner_configuration|synthetic\\.invalid|supabase/i);
    }
    if(loggerFails)assert.deepEqual(warnings,[]);
    else{
      const events=warnings.map(args=>{assert.equal(args.length,1);return JSON.parse(args[0]);});
      const expected=stage==='database_configuration'
        ?[{event:'hosted_database_configuration_unavailable',stage:'tls_ca'},{event:'owner_configuration_unavailable',stage}]
        :[{event:'owner_configuration_unavailable',stage}];
      assert.deepEqual(events,expected);
      assert.doesNotMatch(JSON.stringify(warnings),/CANARY|password|sb_publishable|postgres:|supabase\\.co/);
    }
    assert.equal(fetches,0);assert.equal(sockets,0);
  `;
  const scenarios:[string,Record<string,string>,boolean?][]=[
    ['runtime_approval',{HAMDEE_OWNER_RUNTIME_APPROVAL:'PRIVATE_APPROVAL_CANARY'}],
    ['database_mode',{HAMDEE_DATABASE_MODE:'PRIVATE_MODE_CANARY'}],
    ['hosted_scope',{VERCEL_ENV:'production'}],
    ['identity_configuration',{HAMDEE_OWNER_EMAIL:'PRIVATE_MAILBOX_CANARY'}],
    ['cookie_key',{HAMDEE_OWNER_COOKIE_KEY:'A'.repeat(42)+'B'}],
    ['security_budgets',{HAMDEE_OWNER_RATE_BOUNDS:'PRIVATE_BUDGET_CANARY'}],
    ['session_policy',{HAMDEE_OWNER_IDLE_MS:'900001'}],
    ['provider_configuration',{HAMDEE_SUPABASE_PUBLISHABLE_KEY:'PRIVATE_KEY_CANARY'}],
    ['database_configuration',{HAMDEE_DATABASE_CA_PEM:'PRIVATE_CA_CANARY'}],
    ['hosted_scope',{HAMDEE_OWNER_ORIGIN:'https://hamdee-git-codex-hamdee-demo-preview-faziils-projects.vercel.app/'}],
    ['identity_configuration',{HAMDEE_OWNER_EMAIL:'PRIVATE_MAILBOX_CANARY'},true]
  ];
  for(const scenario of scenarios){
    const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code,JSON.stringify(scenario)],{
      cwd:new URL('../',import.meta.url),env,encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(child.status,0,`${scenario[0]}: ${child.stderr}`);
    assert.equal(child.stdout,'');assert.equal(child.stderr,'');
  }
});
