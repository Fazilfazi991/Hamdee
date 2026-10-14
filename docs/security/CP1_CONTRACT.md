# CP1 security reference

The retained modules in `src/security/contracts.ts`, `session-policy.ts` and `session-state.ts` define pure server security contracts. The current owner runtime uses managed authentication in `src/owner-auth.ts`; these reference modules are preserved and tested, not wired into the live entrypoints.

Identity metadata binds provider, application, environment, synthetic data class, project, issuer and audience. Subject and provider-session UUIDs, timestamps, assurance, active factors and session status are validated. Structural validation does not establish token authenticity. Membership and same-grant property scope are separate trusted server inputs; browser roles and user_metadata never grant access.

States are anonymous, primary_authenticated, mfa_required, authenticated, revoked, expired and recovery_pending. Policy durations, exact origins/redirects, logout scope, proxy trust, limiters, MFA and disablement boundary are explicit validated inputs. No operational defaults are selected by the reference code.

Transitions validate event shape/revision before expiration. Ordinary events require exact revision; logout, provider revocation, disablement and recovery may strengthen a newer loaded session with an older supported revision, never a future revision. Recovery remains sticky, including after expiry. Observed disablement remains false underneath recovery. Ordinary activity, refresh and MFA cannot resume terminal sessions or extend an absolute deadline.

Verified MFA rotates the hash and requires the same subject/session and a genuinely newer verified-factor timestamp. Admin grants require MFA even when combined with other roles. Refresh has a versioned owner lease; completion preserves assurance/MFA recency and never renews idle or absolute lifetime. Business activity renews idle only. Lifecycle permits are revision-bound observations, not property grants or database locks.

Provider, encrypted-envelope storage, CAS, audit, clock, randomness, hashing and limiter interfaces require concrete implementation. Durable CAS must commit session/tokens/audit atomically, retire old hashes and reject reuse. Pure tests do not prove distributed storage, provider verification or in-flight database serialization. The companion tests are `tests/security-contracts.test.ts` and `tests/session-state.test.ts`.
