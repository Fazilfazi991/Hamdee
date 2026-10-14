// Agent 4 independent CP2 QA. Test support only; never runtime policy.
// Bound only after Coordinator's explicit public-API freeze. All stores/provider
// below are independent in-memory fakes, not durable/multiworker infrastructure.
import { createHash, randomBytes } from 'node:crypto';
import type { DurableSession, IdentityProviderPort, MembershipSnapshot, SecurityAuditEvent,
  SecurityResult, ServerTokenPair, VerifiedIdentity } from '../../src/security/contracts';
import { createSessionService, type LoginChallengeRecord, type SessionIssued,
  type StoredServiceSession, type SubjectSecuritySnapshot } from '../../src/security/session-service';
import { createTokenEnvelope } from '../../src/security/token-envelope';
import { createCsrfProtector } from '../../src/security/csrf';

export type QaRole = 'admin' | 'operations' | 'finance' | 'read_only';
export type QaAction = 'read' | 'create' | 'update' | 'archive' | 'restore' | 'audit';
export type QaScope = { kind: 'portfolio' } | { kind: 'properties'; propertyIds: string[] };
export interface QaGrant { role: QaRole; scope: QaScope }
export interface QaScenario {
  readonly id: string;
  readonly subject: string;
  readonly arrangement: string;
  readonly expected: string;
}

export const QA_TIME = 1_000_000;
export const QA_ORIGIN = 'https://agent4.hamdee.invalid';
export const QA_SUBJECT_A = 'a4444444-1111-4111-8111-111111111111';
export const QA_SUBJECT_B = 'b4444444-2222-4222-8222-222222222222';
export const QA_SESSION_A = 'c4444444-3333-4333-8333-333333333333';
export const QA_SESSION_B = 'd4444444-4444-4444-8444-444444444444';
export const QA_PROPERTY_A = 'e4444444-5555-4555-8555-555555555555';
export const QA_PROPERTY_B = 'f4444444-6666-4666-8666-666666666666';

// Structurally compatible with accepted CP1 metadata. This synthetic binding is
// never connected to its URL; an injected fake is required for every operation.
export function qaBinding() {
  return {
    provider: 'supabase' as const, appId: 'hamdee' as const,
    environment: 'development' as const, dataClass: 'synthetic_only' as const,
    projectRef: 'abcdefghijklmnopqrst',
    issuer: 'https://abcdefghijklmnopqrst.supabase.co/auth/v1',
    audience: 'authenticated' as const
  };
}

// Deliberately distinct synthetic values from the original CP1 tests; return a
// detached object so scenario mutations cannot contaminate another test.
export function qaPolicy() {
  return {
    idleTimeout: 20_000, absoluteTimeout: 120_000, jwtLifetime: 12_000,
    refreshLead: 4_000, refreshLease: 2_000, clockTolerance: 200,
    stepUpMaxAge: 8_000,
    allowedOrigins: [QA_ORIGIN], redirectAllowlist: [QA_ORIGIN + '/auth/callback'],
    logoutScope: 'local' as const, trustedProxyPolicy: { mode: 'none' as const },
    limits: {
      login: { bounds: 4, window: 2_000, backoff: 400 },
      refresh: { bounds: 4, window: 2_000, backoff: 400 },
      mfa: { bounds: 4, window: 2_000, backoff: 400 },
      recovery: { bounds: 4, window: 2_000, backoff: 400 },
      invitation: { bounds: 4, window: 2_000, backoff: 400 },
      write: { bounds: 4, window: 2_000, backoff: 400 }
    },
    mfa: {
      administratorRequired: true as const, requireLiveAdminSession: true as const,
      otherRoles: 'optional' as const, factor: 'totp' as const,
      stepUpActions: ['membership_change', 'factor_change', 'recovery_approval', 'administrator_activation'] as const
    },
    disablementBoundary: 'recheck_at_commit' as const
  };
}

export function qaIdentity(now: number, mfa: boolean, subject = QA_SUBJECT_A, session = QA_SESSION_A) {
  return {
    binding: qaBinding(), subject, providerSessionId: session,
    issuedAt: now, notBefore: now, expiresAt: now + qaPolicy().jwtLifetime,
    assurance: mfa ? 'aal2' as const : 'aal1' as const,
    mfaVerifiedAt: mfa ? now : null, factorVerified: mfa,
    status: 'active' as const, liveSessionStatus: 'active' as const
  };
}

export function qaMembership(grants: readonly QaGrant[], subject = QA_SUBJECT_A) {
  return {
    issuer: qaBinding().issuer, subject, enabled: true, revision: 1,
    grants: structuredClone(grants)
  };
}

export function qaClock(initialTime: number) {
  let current = initialTime;
  return {
    now: () => current,
    advance(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Number.isSafeInteger(current + milliseconds)) {
        throw new Error('Invalid synthetic QA clock advance');
      }
      current += milliseconds;
    }
  };
}

// Deterministic provider-completion barrier for race tests. No timers, sleeps,
// provider request, DB connection, token or host environment is used here.
export function qaDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

export const qaRoleActions: Readonly<Record<QaRole, readonly QaAction[]>> = {
  admin: ['read', 'create', 'update', 'archive', 'restore', 'audit'],
  operations: ['read', 'create', 'update'], finance: ['read', 'audit'], read_only: ['read']
};

// Preparation inventory retained for traceability, not additional passing tests
// or operational acceptance. Executable assertions live in the two QA suites.
export const qaSessionScenarios: readonly QaScenario[] = [
  { id: 'S01', subject: 'Explicit configuration', arrangement: 'Missing/inconsistent required policy', expected: 'Reject without provider/store side effects; no fallback defaults' },
  { id: 'S02', subject: 'Identity mismatch', arrangement: 'Wrong project/issuer/audience/subject/session or anonymous/deleted identity', expected: 'No authenticated app session or business permit' },
  { id: 'S03', subject: 'Disabled membership', arrangement: 'Successful synthetic provider validation but missing/disabled local membership', expected: 'Deny login and business operations' },
  { id: 'S04', subject: 'Untrusted claims', arrangement: 'Inject client admin roles and user_metadata claims', expected: 'Ignore claims; authorize only fresh server membership' },
  { id: 'S05', subject: 'Admin assurance', arrangement: 'Admin and Admin+operations/read_only grants with aal1', expected: 'Require MFA before any property read, write or cached replay' },
  { id: 'S06', subject: 'MFA binding', arrangement: 'Successful-looking MFA for another subject/session, stale assurance or invalid factor', expected: 'Deny without rotating to a business-capable session' },
  { id: 'S07', subject: 'Verified synthetic MFA', arrangement: 'Fake verified aal2 identity bound to original session', expected: 'Rotate handle; reject old handle; disclose no provider tokens' },
  { id: 'S08', subject: 'Deadline boundaries', arrangement: 'Immediately before/at/after idle, token and absolute deadlines', expected: 'Exact approved boundary; ordinary activity cannot resume expired access' },
  { id: 'S09', subject: 'Concurrent refresh', arrangement: 'Two callers acquire refresh with deferred fake provider', expected: 'One lease winner; stale CAS cannot overwrite newer session' },
  { id: 'S10', subject: 'Late refresh after logout', arrangement: 'Pause refresh, commit logout, resolve provider completion', expected: 'No resurrection of retired handle/session/tokens' },
  { id: 'S11', subject: 'Recovery boundary', arrangement: 'Start recovery at idle/absolute deadline or after expiry', expected: 'Sticky recovery hold; new primary login and late MFA/refresh cannot clear it' },
  { id: 'S12', subject: 'Disable/revoke boundary', arrangement: 'Disable at expiry and during deferred completion', expected: 'Membership remains disabled; stale completions/replays denied' },
  { id: 'S13', subject: 'Fresh live status', arrangement: 'Admin provider-session status revoked/unavailable', expected: 'No property permit even with locally unexpired metadata' },
  { id: 'S14', subject: 'CAS atomicity', arrangement: 'Store conflict/failure or audit failure during login, rotation and refresh', expected: 'No unaudited success or partial session/token replacement' },
  { id: 'S15', subject: 'Limiter failures', arrangement: 'Rate limit denial or required limiter unavailable', expected: 'Fail closed before protected mutation/provider work where contract requires' },
  { id: 'S16', subject: 'Envelope authentication', arrangement: 'Alter ciphertext/tag/nonce/key version/project binding; use wrong key', expected: 'Authenticated decrypt rejects; no token value in error/log/result' },
  { id: 'S17', subject: 'CSRF binding', arrangement: 'Missing/wrong/replayed/cross-session/preauth nonce; wrong Origin', expected: 'Unsafe operation denied; valid approved binding accepted' },
  { id: 'S18', subject: 'Fresh operation permit', arrangement: 'Membership/session revision changes after permit, before protected work', expected: 'Revalidation denies stale context; lifecycle permit alone grants no property rights' },
  { id: 'S19', subject: 'Independent sessions', arrangement: 'Two subjects and rotated/retired handles interleave operations', expected: 'No identity/token/CSRF/membership leakage between callers' }
];

export const qaPropertyScenarios: readonly QaScenario[] = [
  { id: 'P01', subject: 'Role/action matrix', arrangement: 'Four roles across read/create/update/archive/restore/audit', expected: 'Approved capabilities only; Admin MFA remains prerequisite' },
  { id: 'P02', subject: 'Property scope', arrangement: 'Assigned, unassigned and explicit portfolio resources', expected: 'No implicit Admin portfolio; hidden identifiers return generic not-found' },
  { id: 'P03', subject: 'Same-grant boundary', arrangement: 'Read-only assigned grant plus unrelated operations/admin grant', expected: 'No capability/scope union that elevates assigned resource' },
  { id: 'P04', subject: 'Revoked cached replay', arrangement: 'Create/update committed; remove scope or disable membership before retry', expected: 'Fresh denial rather than cached protected result' },
  { id: 'P05', subject: 'Independent actor requests', arrangement: 'Substitute identifiers, client roles/actor IDs, hidden counterparty and query filters', expected: 'No cross-property metadata/count/audit leak or privilege escalation' },
  { id: 'P06', subject: 'Property transaction rollback', arrangement: 'Fail audit/revision during create/update/archive', expected: 'Property/profile/history/command/creator scope remain atomic; safe retry' },
  { id: 'P07', subject: 'Command identity/revision', arrangement: 'Same-key same payload, changed payload and stale If-Match', expected: 'One committed effect/replay, conflict and stale-revision responses preserved' },
  { id: 'P08', subject: 'Local persistence', arrangement: 'Authorized metadata create/edit/archive/restore, DB close/reopen and new session', expected: 'Stable UUID/creation/history and correct active/archived visibility' },
  { id: 'P09', subject: 'Session failure prevents mutation', arrangement: 'Expired/recovery/revoked/aal1 Admin reaches existing property handler composition', expected: 'No protected query/mutation or replay success; draft/session redaction where API applies' },
  { id: 'P10', subject: 'Scope-change boundary', arrangement: 'Change grant/member revision between session permit and transaction entry', expected: 'Existing service repeats DB authorization; no claimed native commit-time lock guarantee' }
];

export const qaOk = <T>(value: T): SecurityResult<T> => ({ ok: true, value });
export const qaUnavailable = (): SecurityResult<never> => ({ ok: false, failure: 'unavailable' });
const copy = <T>(value: T): T => structuredClone(value);
type RefreshResult = SecurityResult<{ identity: VerifiedIdentity; tokens: ServerTokenPair }>;

export function authHarness(grants: readonly QaGrant[] = [{ role: 'operations', scope: { kind: 'portfolio' } }], mfa = false) {
  const clock = qaClock(QA_TIME), policy = qaPolicy(), binding = qaBinding();
  const tokens: ServerTokenPair = { accessToken: 'SYNTHETIC_AGENT4_ACCESS', refreshToken: 'SYNTHETIC_AGENT4_REFRESH' };
  const facts = {
    identity: qaIdentity(QA_TIME, mfa) as VerifiedIdentity,
    live: 'active' as 'active' | 'revoked', factorActive: true,
    providerAvailable: true, auditAvailable: true, storeAvailable: true,
    subjectAvailable: true, challengeAvailable: true, limiterAvailable: true,
    limited: false, forceConflict: false,
    refreshGate: null as Promise<RefreshResult> | null,
    providerCalls: { verify: 0, refresh: 0, live: 0, mfa: 0, revoke: 0 },
    storeCalls: { read: 0, create: 0, compareAndSwap: 0 },
    audit: [] as SecurityAuditEvent[]
  };
  const records = new Map<string, StoredServiceSession>(), retired = new Set<string>();
  const subjectRows = new Map<string, SubjectSecuritySnapshot>();
  subjectRows.set(QA_SUBJECT_A, { membership: qaMembership(grants) as MembershipSnapshot, epoch: 0, recoveryPending: false });
  const challenges = new Map<string, LoginChallengeRecord>();
  const factors = new Map<string, string>();
  const atomicAudit = (events: readonly SecurityAuditEvent[]) => {
    if (!facts.auditAvailable) return false;
    facts.audit.push(...copy(events)); return true;
  };
  const unavailableOrConflict = () => !facts.storeAvailable || !facts.auditAvailable;
  const store = {
    async read(hash: string) { facts.storeCalls.read++; return facts.storeAvailable ? qaOk(copy(records.get(hash) || null)) : qaUnavailable(); },
    async create(next: StoredServiceSession, events: readonly SecurityAuditEvent[]) {
      facts.storeCalls.create++;
      if (unavailableOrConflict()) return qaUnavailable();
      const hash = next.session.handleHash;
      if (!hash || records.has(hash) || retired.has(hash) || facts.forceConflict) return qaOk('conflict' as const);
      if (!atomicAudit(events)) return qaUnavailable();
      records.set(hash, copy(next)); return qaOk('applied' as const);
    },
    async compareAndSwap(hash: string, expected: number, next: StoredServiceSession, events: readonly SecurityAuditEvent[]) {
      facts.storeCalls.compareAndSwap++;
      if (unavailableOrConflict()) return qaUnavailable();
      const current = records.get(hash), replacement = next.session.handleHash;
      if (facts.forceConflict || !current || current.session.version !== expected || next.session.version !== expected + 1 || !replacement ||
        (replacement !== hash && (records.has(replacement) || retired.has(replacement)))) return qaOk('conflict' as const);
      if (!atomicAudit(events)) return qaUnavailable();
      if (replacement !== hash) { records.delete(hash); retired.add(hash); }
      records.set(replacement, copy(next)); return qaOk('applied' as const);
    }
  };
  const subjects = {
    async read(_binding: typeof binding, subject: string) {
      return facts.subjectAvailable ? qaOk(copy(subjectRows.get(subject) || { membership: null, epoch: 0, recoveryPending: false })) : qaUnavailable();
    },
    async invalidate(input: { subject: string; expectedEpoch: number; reason: 'logout_all' | 'recovery'; audit: readonly SecurityAuditEvent[] }) {
      if (!facts.subjectAvailable || !facts.auditAvailable) return qaUnavailable();
      const current = subjectRows.get(input.subject);
      if (!current || current.epoch !== input.expectedEpoch) return qaOk('conflict' as const);
      if (!atomicAudit(input.audit)) return qaUnavailable();
      subjectRows.set(input.subject, { ...copy(current), epoch: current.epoch + 1, recoveryPending: current.recoveryPending || input.reason === 'recovery' });
      return qaOk('applied' as const);
    }
  };
  const provider: IdentityProviderPort = {
    async verify(token) {
      facts.providerCalls.verify++;
      return facts.providerAvailable && token === tokens.accessToken ? qaOk(copy(facts.identity)) : qaUnavailable();
    },
    async refresh() {
      facts.providerCalls.refresh++;
      if (!facts.providerAvailable) return qaUnavailable();
      if (facts.refreshGate) return facts.refreshGate;
      return qaOk({ identity: refreshedIdentity(), tokens: { ...tokens } });
    },
    async sessionStatus() { facts.providerCalls.live++; return facts.providerAvailable ? qaOk(facts.live) : qaUnavailable(); },
    async revoke() { facts.providerCalls.revoke++; return facts.providerAvailable ? qaOk(undefined) : qaUnavailable(); },
    async enrollFactor() { return qaOk({ factorId: 'qa-factor', serverOnlyEnrollmentMaterial: 'SYNTHETIC_ONLY_ENROLLMENT' }); },
    async challengeFactor(_identity, factorId) {
      if (!facts.providerAvailable || factorId !== 'qa-factor') return qaUnavailable();
      const id = 'qa-challenge-' + factors.size; factors.set(id, factorId); return qaOk({ challengeId: id });
    },
    async verifyFactor(_identity, challengeId, code) {
      facts.providerCalls.mfa++;
      if (!facts.providerAvailable || code !== '444444' || !factors.has(challengeId)) return qaUnavailable();
      factors.delete(challengeId);
      const identity = { ...refreshedIdentity(), assurance: 'aal2' as const, factorVerified: true, mfaVerifiedAt: clock.now() };
      facts.identity = identity;
      return qaOk({ identity: copy(identity), tokens: { ...tokens } });
    },
    async verifyAssuranceAndFactors(identity) {
      if (!facts.providerAvailable) return qaUnavailable();
      return qaOk(facts.factorActive ? copy(identity) : { ...copy(identity), assurance: 'aal1' as const, factorVerified: false, mfaVerifiedAt: null });
    }
  };
  function refreshedIdentity(): VerifiedIdentity {
    return { ...copy(facts.identity), issuedAt: clock.now(), notBefore: clock.now(), expiresAt: clock.now() + policy.jwtLifetime };
  }
  const random = { bytes: (length: number) => randomBytes(length) };
  const envelopes = createTokenEnvelope({ keys: { 'qa-key-v1': new Uint8Array(32).fill(41), 'qa-key-v2': new Uint8Array(32).fill(42) }, activeKeyVersion: 'qa-key-v1', random });
  const csrf = createCsrfProtector(new Uint8Array(32).fill(43));
  const hasher = { hash: async (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex') };
  const options = {
    binding, policy, provider, store, subjects,
    challenges: {
      async create(record: LoginChallengeRecord) {
        if (!facts.challengeAvailable) return qaUnavailable();
        if (challenges.has(record.handleHash)) return qaOk('conflict' as const);
        challenges.set(record.handleHash, copy(record)); return qaOk('applied' as const);
      },
      async consume(hash: string, origin: string, now: number) {
        if (!facts.challengeAvailable) return qaUnavailable();
        const value = challenges.get(hash);
        if (!value || value.origin !== origin || value.expiresAt <= now) return qaOk(false);
        challenges.delete(hash); return qaOk(true);
      }
    }, clock, random, hasher, envelopes, csrf,
    limiter: { async consume() { return facts.limiterAvailable ? qaOk({ allowed: !facts.limited, retryAt: facts.limited ? clock.now() + 400 : null }) : qaUnavailable(); } },
    audit: { async append(events: readonly SecurityAuditEvent[]) { return atomicAudit(events) ? qaOk(undefined) : qaUnavailable(); } },
    challengeLifetime: 3_000, maxCasAttempts: 3
  };
  const makeService = () => createSessionService(options);
  const service = makeService();
  const context = (csrfToken: string | null) => ({ origin: QA_ORIGIN, csrfToken, limiterKey: 'SYNTHETIC_SERVER_DERIVED_KEY' });
  const login = async () => {
    const challenge = await service.issueLoginChallenge({ origin: QA_ORIGIN, limiterKey: 'SYNTHETIC_SERVER_DERIVED_KEY' });
    return service.login({ challengeHandle: challenge.handle, tokens, context: context(challenge.csrfToken) });
  };
  const authorize = (issued: SessionIssued) => service.authorize({ handle: issued.handle, action: null, mutation: null });
  const mutation = (issued: SessionIssued) => ({ handle: issued.handle, context: context(issued.csrfToken) });
  const findRecord = (issued: SessionIssued) => [...records.values()].find(row => row.session.identity?.providerSessionId === facts.identity.providerSessionId &&
    row.session.version === issued.view.version);
  const setMembership = (changes: Partial<MembershipSnapshot>) => {
    const row = subjectRows.get(facts.identity.subject)!;
    subjectRows.set(facts.identity.subject, { ...copy(row), membership: { ...copy(row.membership!), ...copy(changes) } });
  };
  const cloneRecords = (): DurableSession[] => copy([...records.values()]);
  return { service, makeService, options, facts, clock, policy, binding, tokens, records, retired, subjects, subjectRows,
    envelopes, csrf, hasher, context, login, authorize, mutation, findRecord, setMembership, cloneRecords, refreshedIdentity };
}
