import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenEnvelope } from '../src/security/token-envelope';
import { createCsrfProtector } from '../src/security/csrf';
import { createSessionService, SessionServiceError } from '../src/security/session-service';
import { transitionSession } from '../src/security/session-state';
import { authHarness, qaBinding, qaClock, qaDeferred, qaIdentity, qaOk, qaPolicy, QA_ORIGIN, QA_TIME, QA_SESSION_B, QA_SUBJECT_B } from './support/agent4-auth-harness';
import type { SecurityResult, ServerTokenPair, VerifiedIdentity } from '../src/security/contracts';

const denied = (run: () => Promise<unknown>, codes?: readonly string[]) => assert.rejects(run, (error: unknown) => {
  assert.ok(error instanceof SessionServiceError, 'Expected safe session error');
  assert.notEqual(error.code, 'CP2_NOT_READY', 'Unfinished implementation is not a passed negative test');
  if (codes) assert.ok(codes.includes(error.code), 'Unexpected safe error category: ' + error.code);
  assert.doesNotMatch(error.message, /SYNTHETIC_AGENT4|444444|ciphertext|refreshToken/);
  return true;
});

test('Agent4 CP2: synthetic primary login authorizes operations; safe view excludes secrets', async () => {
  const h = authHarness(), issued = await h.login(), active = await h.authorize(issued);
  assert.equal(issued.view.state, 'authenticated'); assert.equal(active.identity.subject, h.facts.identity.subject);
  assert.deepEqual(Object.keys(issued.view).sort(), ['absoluteExpiresAt', 'idleExpiresAt', 'state', 'version']);
  assert.doesNotMatch(JSON.stringify(issued.view), /token|SYNTHETIC_AGENT4|grants|subject|handle/i);
  assert.ok(h.records.size === 1 && h.facts.audit.length > 0);
});
test('Agent4 CP2: login challenge is one-use and invalid Origin/missing proof do not verify identity', async () => {
  const h = authHarness(), c = await h.service.issueLoginChallenge({ origin: QA_ORIGIN, limiterKey: 'qa-server-key' });
  await denied(() => h.service.login({ challengeHandle: c.handle, tokens: h.tokens, context: h.context(null) }), ['CSRF_REJECTED']);
  assert.equal(h.facts.providerCalls.verify, 0);
  await denied(() => h.service.login({ challengeHandle: c.handle, tokens: h.tokens, context: { ...h.context(c.csrfToken), origin: 'https://other.invalid' } }), ['CSRF_REJECTED']);
  const issued = await h.service.login({ challengeHandle: c.handle, tokens: h.tokens, context: h.context(c.csrfToken) });
  await h.authorize(issued);
  await denied(() => h.service.login({ challengeHandle: c.handle, tokens: h.tokens, context: h.context(c.csrfToken) }));
  assert.equal(h.records.size, 1);
});
test('Agent4 CP2: login challenge expiry rejects exactly at deadline', async () => {
  const h = authHarness(), c = await h.service.issueLoginChallenge({ origin: QA_ORIGIN, limiterKey: 'qa-server-key' });
  h.clock.advance(h.options.challengeLifetime);
  await denied(() => h.service.login({ challengeHandle: c.handle, tokens: h.tokens, context: h.context(c.csrfToken) }));
  assert.equal(h.records.size, 0);
});
test('Agent4 CP2: provider mismatch and unavailable provider never create sessions', async () => {
  for (const kind of ['issuer', 'subject', 'expired', 'anonymous', 'unavailable'] as const) {
    const h = authHarness();
    if (kind === 'issuer') h.facts.identity = { ...h.facts.identity, binding: { ...h.binding, issuer: 'https://other.invalid/auth/v1' } };
    if (kind === 'subject') h.facts.identity = { ...h.facts.identity, subject: QA_SUBJECT_B };
    if (kind === 'expired') h.facts.identity = { ...h.facts.identity, expiresAt: h.clock.now() };
    if (kind === 'anonymous') h.facts.identity = { ...h.facts.identity, status: 'anonymous' };
    if (kind === 'unavailable') h.facts.providerAvailable = false;
    await denied(() => h.login()); assert.equal(h.records.size, 0);
  }
});
test('Agent4 CP2: disabled membership and sticky recovery block primary login despite provider success', async () => {
  for (const recovery of [false, true]) {
    const h = authHarness();
    if (recovery) h.subjectRows.set(h.facts.identity.subject, { ...h.subjectRows.get(h.facts.identity.subject)!, recoveryPending: true });
    else h.setMembership({ enabled: false });
    await denied(() => h.login()); assert.equal(h.records.size, 0);
  }
});
test('Agent4 CP2: Admin and mixed-role aal1 cannot authorize or replay as a lower role', async () => {
  for (const roles of [['admin'], ['admin', 'operations'], ['read_only', 'admin']] as const) {
    const h = authHarness(roles.map(role => ({ role, scope: { kind: 'portfolio' } }))), issued = await h.login();
    assert.equal(issued.view.state, 'mfa_required');
    await denied(() => h.authorize(issued), ['MFA_REQUIRED']);
  }
});
test('Agent4 CP2: synthetic verified MFA rotates handle and invalidates prior handle/proof', async () => {
  const h = authHarness([{ role: 'admin', scope: { kind: 'portfolio' } }]), first = await h.login();
  const challenge = await h.service.challengeMfa({ ...h.mutation(first), factorId: 'qa-factor' });
  const verified = await h.service.completeMfa({ ...h.mutation(first), challengeId: challenge.challengeId, code: '444444' });
  assert.notEqual(verified.handle, first.handle); assert.equal(verified.view.state, 'authenticated');
  assert.equal((await h.authorize(verified)).identity.assurance, 'aal2');
  await denied(() => h.authorize(first));
  await denied(() => h.service.authorize({ handle: verified.handle, action: null, mutation: h.context(first.csrfToken) }), ['CSRF_REJECTED']);
});
test('Agent4 CP2: wrong MFA code fails without enabling business access', async () => {
  const h = authHarness([{ role: 'admin', scope: { kind: 'portfolio' } }]), issued = await h.login();
  const c = await h.service.challengeMfa({ ...h.mutation(issued), factorId: 'qa-factor' });
  await denied(() => h.service.completeMfa({ ...h.mutation(issued), challengeId: c.challengeId, code: '000000' }));
  await denied(() => h.authorize(issued), ['MFA_REQUIRED']);
});
test('Agent4 CP2: MFA completion for another provider session rejects', async () => {
  const h = authHarness([{ role: 'admin', scope: { kind: 'portfolio' } }]), issued = await h.login();
  const c = await h.service.challengeMfa({ ...h.mutation(issued), factorId: 'qa-factor' });
  h.facts.identity = { ...h.facts.identity, providerSessionId: QA_SESSION_B };
  await denied(() => h.service.completeMfa({ ...h.mutation(issued), challengeId: c.challengeId, code: '444444' }));
  await denied(() => h.authorize(issued));
});
test('Agent4 CP2: exact JWT expiry cannot grant business access', async () => {
  const h = authHarness(), issued = await h.login(); h.clock.advance(h.policy.jwtLifetime);
  await denied(() => h.authorize(issued));
});
test('Agent4 CP2: refresh retains original absolute deadline and stale MFA step-up stays stale', async () => {
  const h = authHarness([{ role: 'admin', scope: { kind: 'portfolio' } }], true), issued = await h.login();
  const deadline = issued.view.absoluteExpiresAt;
  h.clock.advance(h.policy.jwtLifetime - 1000);
  await h.service.refresh(h.mutation(issued));
  const a = await h.authorize(issued); assert.equal(a.view.absoluteExpiresAt, deadline);
  await denied(() => h.service.authorize({ handle: issued.handle, action: 'membership_change', mutation: h.context(issued.csrfToken) }), ['STEP_UP_REQUIRED']);
});
test('Agent4 CP2: business authorization slides idle via audited CAS; refresh alone never slides idle', async () => {
  const h = authHarness(), issued = await h.login(), before = [...h.records.values()][0], auditCount = h.facts.audit.length;
  h.clock.advance(5_000);
  const authorized = await h.authorize(issued), active = [...h.records.values()][0];
  assert.equal(active.session.version, before.session.version + 1);
  assert.equal(active.session.lastActivityAt, h.clock.now());
  assert.equal(authorized.view.idleExpiresAt, h.clock.now() + h.policy.idleTimeout);
  assert.equal(authorized.view.absoluteExpiresAt, issued.view.absoluteExpiresAt);
  assert.ok(h.facts.audit.length > auditCount);
  h.clock.advance(3_000);
  const refreshed = await h.service.refresh(h.mutation(issued)), afterRefresh = [...h.records.values()][0];
  assert.equal(afterRefresh.session.lastActivityAt, active.session.lastActivityAt);
  assert.equal(refreshed.idleExpiresAt, authorized.view.idleExpiresAt);
  assert.equal(refreshed.absoluteExpiresAt, issued.view.absoluteExpiresAt);
});
test('Agent4 CP2: verified MFA timestamp zero remains a valid fresh step-up', async () => {
  const h = authHarness([{ role: 'admin', scope: { kind: 'portfolio' } }], true);
  const zero = qaClock(0); h.facts.identity = qaIdentity(0, true);
  const service = createSessionService({ ...h.options, clock: zero });
  const challenge = await service.issueLoginChallenge({ origin: QA_ORIGIN, limiterKey: 'qa-server-key' });
  const issued = await service.login({ challengeHandle: challenge.handle, tokens: h.tokens, context: h.context(challenge.csrfToken) });
  const active = await service.authorize({ handle: issued.handle, action: 'membership_change', mutation: h.context(issued.csrfToken) });
  assert.equal(active.identity.mfaVerifiedAt, 0); assert.equal(active.view.state, 'authenticated');
});
test('Agent4 CP2: every elevated action rejects null mutation before activity, store or provider effects', async () => {
  const observations = [];
  for (const action of ['membership_change', 'factor_change', 'recovery_approval', 'administrator_activation'] as const) {
    const h = authHarness([{ role: 'admin', scope: { kind: 'portfolio' } }], true), issued = await h.login();
    h.clock.advance(1_000);
    const snapshot = () => structuredClone({ records: [...h.records], retired: [...h.retired], subjects: [...h.subjectRows],
      providerCalls: h.facts.providerCalls, storeCalls: h.facts.storeCalls });
    const before = snapshot(), auditCount = h.facts.audit.length;
    const result = await h.service.authorize({ handle: issued.handle, action, mutation: null }).then(
      () => 'UNEXPECTED_SUCCESS',
      (error: unknown) => error instanceof SessionServiceError ? error.code : 'UNEXPECTED_ERROR_TYPE'
    );
    observations.push({ action, result, before, after: snapshot() });
    // Redacted denial audit is intended; no accepted activity event may occur.
    const denialEvents = h.facts.audit.slice(auditCount);
    assert.deepEqual(denialEvents.map(event => [event.event, event.outcome]), [['denied', 'denied']]);
    assert.ok(denialEvents.every(event => event.actorSubject === null && event.providerSessionId === null));
    const allowed = await h.service.authorize({ handle: issued.handle, action, mutation: h.context(issued.csrfToken) });
    assert.equal(allowed.identity.assurance, 'aal2'); assert.equal(allowed.identity.subject, h.facts.identity.subject);
  }
  assert.deepEqual(observations.map(({ action, result }) => ({ action, result })),
    ['membership_change', 'factor_change', 'recovery_approval', 'administrator_activation'].map(action => ({ action, result: 'CSRF_REJECTED' })));
  for (const observation of observations) assert.deepEqual(observation.after, observation.before, observation.action + ' must have zero side effects');
});
test('Agent4 CP2: exact idle and absolute boundaries deny even with newly valid token metadata', async () => {
  for (const duration of [qaPolicy().idleTimeout, qaPolicy().absoluteTimeout]) {
    const h = authHarness(), issued = await h.login(); h.clock.advance(duration);
    for (const [hash, row] of h.records) h.records.set(hash, { ...row, session: { ...row.session, observedAt: h.clock.now(), identity: h.refreshedIdentity() } });
    await denied(() => h.authorize(issued), ['UNAUTHENTICATED']);
    for (const row of h.records.values()) {
      assert.equal(row.session.absoluteExpiresAt, issued.view.absoluteExpiresAt);
      assert.equal(row.session.lastActivityAt, h.clock.now() - duration);
      if (row.session.state === 'expired') assert.equal(row.session.reason, duration === h.policy.absoluteTimeout ? 'absolute' : 'idle');
    }
  }
});
test('Agent4 CP2: same-handle session CSRF is reusable but cross-session/purpose proofs reject', async () => {
  const h = authHarness(), a = await h.login(), b = await h.login();
  for (let i = 0; i < 2; i++) await h.service.authorize({ handle: a.handle, action: null, mutation: h.context(a.csrfToken) });
  await denied(() => h.service.authorize({ handle: b.handle, action: null, mutation: h.context(a.csrfToken) }), ['CSRF_REJECTED']);
  const c = await h.service.issueLoginChallenge({ origin: QA_ORIGIN, limiterKey: 'qa-server-key' });
  await denied(() => h.service.authorize({ handle: a.handle, action: null, mutation: h.context(c.csrfToken) }), ['CSRF_REJECTED']);
});
test('Agent4 CP2: limiter denial/outage precedes login challenge creation', async () => {
  for (const outage of [false, true]) {
    const h = authHarness(); h.facts.limited = !outage; h.facts.limiterAvailable = !outage;
    await denied(() => h.service.issueLoginChallenge({ origin: QA_ORIGIN, limiterKey: 'qa-server-key' }), outage ? ['SESSION_UNAVAILABLE'] : ['RATE_LIMITED']);
    assert.equal(h.facts.providerCalls.verify, 0); assert.equal(h.records.size, 0);
  }
});
test('Agent4 CP2: required store/subject/audit/challenge outages cannot issue successful login', async () => {
  for (const flag of ['storeAvailable', 'subjectAvailable', 'auditAvailable', 'challengeAvailable'] as const) {
    const h = authHarness(); h.facts[flag] = false;
    await denied(() => h.login()); assert.equal(h.records.size, 0);
  }
});
test('Agent4 CP2: audit failure leaves prior session/envelope intact during rotation', async () => {
  const h = authHarness(), issued = await h.login(), before = h.cloneRecords(); h.facts.auditAvailable = false;
  await denied(() => h.service.rotate(h.mutation(issued))); assert.deepEqual(h.cloneRecords(), before);
});
test('Agent4 CP2: bounded forced CAS conflict denies rotation and retains record', async () => {
  const h = authHarness(), issued = await h.login(), before = h.cloneRecords(); h.facts.forceConflict = true;
  await denied(() => h.service.rotate(h.mutation(issued))); assert.deepEqual(h.cloneRecords(), before);
});
test('Agent4 CP2: subject disablement and revoked/unavailable Admin live status deny access', async () => {
  for (const condition of ['revoked', 'unavailable', 'disabled'] as const) {
    const h = authHarness([{ role: 'admin', scope: { kind: 'portfolio' } }], true), issued = await h.login();
    if (condition === 'revoked') h.facts.live = 'revoked';
    if (condition === 'unavailable') h.facts.providerAvailable = false;
    if (condition === 'disabled') h.setMembership({ enabled: false, revision: 2 });
    await denied(() => h.authorize(issued));
  }
});
test('Agent4 CP2: provider revoke outage still persists local logout and requests reconciliation', async () => {
  const h = authHarness(), issued = await h.login(); h.facts.providerAvailable = false;
  const result = await h.service.logout(h.mutation(issued));
  assert.deepEqual(result, { localRevoked: true, providerRevocation: 'reconciliation_required' });
  await denied(() => h.authorize(issued));
});
test('Agent4 CP2: removed Admin factor denies locally cached aal2 access', async () => {
  const h = authHarness([{ role: 'admin', scope: { kind: 'portfolio' } }], true), issued = await h.login();
  h.facts.factorActive = false; await denied(() => h.authorize(issued));
});
test('Agent4 CP2: tampered persisted envelope cannot refresh or disclose token material', async () => {
  const h = authHarness(), issued = await h.login(); h.clock.advance(h.policy.jwtLifetime - h.policy.refreshLead);
  for (const [hash, row] of h.records) {
    assert.ok(row.tokens); h.records.set(hash, { ...row, tokens: { ...row.tokens, ciphertext: 'SYNTHETIC_TAMPERED_ENVELOPE' } });
  }
  await denied(() => h.service.refresh(h.mutation(issued)));
  assert.equal(h.facts.providerCalls.refresh, 0);
});
test('Agent4 CP2: recovery invalidates another handle and blocks future primary login', async () => {
  const h = authHarness(), a = await h.login(), b = await h.login();
  await h.service.startRecovery(h.mutation(a));
  await denied(() => h.authorize(a)); await denied(() => h.authorize(b)); await denied(() => h.login());
  assert.equal(h.subjectRows.get(h.facts.identity.subject)?.recoveryPending, true);
});
test('Agent4 CP2: recovery remains authoritative at idle/absolute deadline and after persisted expiry', async () => {
  for (const elapsed of [qaPolicy().idleTimeout, qaPolicy().absoluteTimeout, qaPolicy().absoluteTimeout + 1]) {
    const h = authHarness(), issued = await h.login(); h.clock.advance(elapsed);
    if (elapsed > h.policy.absoluteTimeout) for (const [hash, row] of h.records) {
      const expired = transitionSession(row.session, { type: 'expire', expectedVersion: row.session.version }, h.binding, h.policy, h.clock.now());
      assert.equal(expired.state, 'expired'); assert.equal(expired.reason, 'absolute');
      h.records.set(hash, { ...row, session: expired });
    }
    await h.service.startRecovery(h.mutation(issued));
    assert.equal(h.subjectRows.get(h.facts.identity.subject)?.recoveryPending, true);
    h.facts.identity = h.refreshedIdentity();
    await denied(() => h.login()); await denied(() => h.authorize(issued));
  }
});
test('Agent4 CP2: combined recovery, disablement, expiry and logout never clear the subject hold', async () => {
  const h = authHarness(), issued = await h.login();
  await h.service.startRecovery(h.mutation(issued)); h.setMembership({ enabled: false, revision: 2 });
  h.clock.advance(h.policy.absoluteTimeout + 1);
  await h.service.logout(h.mutation(issued)).catch(error => {
    assert.ok(error instanceof SessionServiceError); assert.notEqual(error.code, 'CP2_NOT_READY');
  });
  const row = h.subjectRows.get(h.facts.identity.subject)!;
  assert.equal(row.recoveryPending, true); assert.equal(row.membership?.enabled, false);
  h.facts.identity = h.refreshedIdentity();
  await denied(() => h.login()); await denied(() => h.authorize(issued));
  for (const persisted of h.records.values()) {
    assert.equal(persisted.session.state, 'recovery_pending'); assert.equal(persisted.session.reason, 'recovery');
    assert.equal(persisted.session.membership?.enabled, false); assert.equal(persisted.tokens, null);
  }
});
test('Agent4 CP2: fresh privilege revision requires handle rotation and mandatory new Admin MFA', async () => {
  const h = authHarness(), issued = await h.login();
  h.setMembership({ revision: 2, grants: [{ role: 'admin', scope: { kind: 'portfolio' } }] });
  await denied(() => h.authorize(issued), ['ROTATION_REQUIRED', 'MFA_REQUIRED']);
  const rotated = await h.service.rotate(h.mutation(issued)); assert.notEqual(rotated.handle, issued.handle);
  await denied(() => h.authorize(issued)); await denied(() => h.authorize(rotated), ['MFA_REQUIRED']);
});
test('Agent4 CP2: all-device logout rejects existing handles but permits fresh enabled login', async () => {
  const h = authHarness(); const service = createSessionService({ ...h.options, policy: { ...h.policy, logoutScope: 'all' } });
  const a = await h.login(), b = await h.login(); await service.logout(h.mutation(a));
  await denied(() => h.authorize(a)); await denied(() => h.authorize(b));
  await h.authorize(await h.login());
});
test('Agent4 CP2: deferred refresh cannot resurrect after logout or recovery', async () => {
  for (const recovery of [false, true]) {
    const h = authHarness(), issued = await h.login(); h.clock.advance(h.policy.jwtLifetime - h.policy.refreshLead);
    const gate = qaDeferred<SecurityResult<{ identity: VerifiedIdentity; tokens: ServerTokenPair }>>();
    h.facts.refreshGate = gate.promise;
    const pending = h.service.refresh(h.mutation(issued));
    // Drain promise jobs until the fake provider is entered; no wall-clock sleep.
    for (let i = 0; i < 100 && h.facts.providerCalls.refresh === 0; i++) await Promise.resolve();
    assert.equal(h.facts.providerCalls.refresh, 1);
    if (recovery) await h.service.startRecovery(h.mutation(issued)); else await h.service.logout(h.mutation(issued));
    const rejected = denied(() => pending);
    gate.resolve(qaOk({ identity: h.refreshedIdentity(), tokens: h.tokens }));
    await rejected; await denied(() => h.authorize(issued));
  }
});
test('Agent4 CP2: independent service instances compete on one refresh lease', async () => {
  const h = authHarness(), issued = await h.login(); h.clock.advance(h.policy.jwtLifetime - h.policy.refreshLead);
  const gate = qaDeferred<SecurityResult<{ identity: VerifiedIdentity; tokens: ServerTokenPair }>>(); h.facts.refreshGate = gate.promise;
  const first = h.service.refresh(h.mutation(issued));
  for (let i = 0; i < 100 && h.facts.providerCalls.refresh === 0; i++) await Promise.resolve();
  assert.equal(h.facts.providerCalls.refresh, 1);
  const second = h.makeService().refresh(h.mutation(issued));
  const rejected = denied(() => second);
  gate.resolve(qaOk({ identity: h.refreshedIdentity(), tokens: h.tokens }));
  await first; await rejected; assert.equal(h.facts.providerCalls.refresh, 1);
});
test('Agent4 CP2: deferred refresh after disablement or idle/absolute deadline cannot enable access', async () => {
  for (const condition of ['disabled', 'idle', 'absolute'] as const) {
    const h = authHarness(), issued = await h.login(); h.clock.advance(h.policy.jwtLifetime - h.policy.refreshLead);
    const gate = qaDeferred<SecurityResult<{ identity: VerifiedIdentity; tokens: ServerTokenPair }>>(); h.facts.refreshGate = gate.promise;
    const pending = h.service.refresh(h.mutation(issued));
    for (let i = 0; i < 100 && h.facts.providerCalls.refresh === 0; i++) await Promise.resolve();
    assert.equal(h.facts.providerCalls.refresh, 1);
    if (condition === 'disabled') h.setMembership({ enabled: false, revision: 2 });
    else h.clock.advance((condition === 'idle' ? h.policy.idleTimeout : h.policy.absoluteTimeout) - (h.clock.now() - QA_TIME));
    const rejected = denied(() => pending);
    gate.resolve(qaOk({ identity: h.refreshedIdentity(), tokens: h.tokens }));
    await rejected; await denied(() => h.authorize(issued));
    for (const row of h.records.values()) assert.equal(row.session.absoluteExpiresAt, issued.view.absoluteExpiresAt);
  }
});
test('Agent4 CP2: independent fake CAS commits one winner and retires old hashes atomically', async () => {
  const h = authHarness(), issued = await h.login(), row = h.findRecord(issued)!;
  assert.ok(row); const hash = row.session.handleHash!;
  const next = { ...row, session: { ...row.session, version: row.session.version + 1, handleHash: 'e'.repeat(64) } };
  const results = await Promise.all([h.options.store.compareAndSwap(hash, row.session.version, next, []), h.options.store.compareAndSwap(hash, row.session.version, next, [])]);
  assert.deepEqual(results, [qaOk('applied'), qaOk('conflict')]);
  assert.deepEqual(await h.options.store.read(hash), qaOk(null));
  assert.deepEqual(await h.options.store.create(row, []), qaOk('conflict'));
});
test('Agent4 CP2: authenticated envelopes roundtrip and reject tamper, wrong binding and wrong key', async () => {
  const h = authHarness(), original = await h.envelopes.seal(h.tokens, h.binding);
  assert.deepEqual(await h.envelopes.open(original, h.binding), h.tokens);
  for (const patch of [{ ciphertext: (original.ciphertext[0] === 'A' ? 'B' : 'A') + original.ciphertext.slice(1) }, { nonce: 'AA' }, { keyVersion: 'qa-key-v2' }, { algorithm: 'none' }]) {
    await assert.rejects(() => h.envelopes.open({ ...original, ...patch }, h.binding));
  }
  const wrong = { ...h.binding, projectRef: 'zzzzzzzzzzzzzzzzzzzz', issuer: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co/auth/v1' };
  await assert.rejects(() => h.envelopes.open(original, wrong));
  const other = createTokenEnvelope({ keys: { 'qa-key-v1': new Uint8Array(32).fill(99) }, activeKeyVersion: 'qa-key-v1', random: h.options.random });
  await assert.rejects(() => other.open(original, h.binding));
});
test('Agent4 CP2: envelope rejects malformed canonical encoding, truncated tag and unknown key version', async () => {
  const h = authHarness(), original = await h.envelopes.seal(h.tokens, h.binding);
  const raw = Buffer.from(original.ciphertext, 'base64url'); raw[raw.length - 1] ^= 1;
  for (const patch of [
    { ciphertext: original.ciphertext + '=' }, { ciphertext: ' ' + original.ciphertext },
    { ciphertext: raw.toString('base64url') }, { ciphertext: Buffer.alloc(15).toString('base64url') },
    { nonce: original.nonce + '=' }, { nonce: Buffer.alloc(11).toString('base64url') },
    { keyVersion: 'unknown' }, { keyVersion: '../qa-key-v1' }
  ]) await assert.rejects(() => h.envelopes.open({ ...original, ...patch }, h.binding), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /SYNTHETIC_AGENT4|qa-key-v1|ciphertext/); return true;
  });
});
test('Agent4 CP2: standalone CSRF binds project, handle and purpose with exact Origin', () => {
  const csrf = createCsrfProtector(new Uint8Array(32).fill(51));
  const binding = { identityBinding: qaBinding(), purpose: 'session' as const, handleHash: 'f'.repeat(64) };
  const token = csrf.issue(binding);
  assert.equal(csrf.verify(token, binding), true);
  for (const patch of [{ handleHash: 'a'.repeat(64) }, { purpose: 'login' as const }, { identityBinding: { ...qaBinding(), projectRef: 'zzzzzzzzzzzzzzzzzzzz' } }]) assert.equal(csrf.verify(token, { ...binding, ...patch }), false);
  for (const origin of [null, 'https://other.invalid', QA_ORIGIN + '/', QA_ORIGIN + '.other.invalid']) assert.throws(() => csrf.assertMutation({ origin, csrfToken: token, limiterKey: 'qa-server' }, binding, qaPolicy()));
});
