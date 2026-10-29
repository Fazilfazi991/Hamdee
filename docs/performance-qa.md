# Independent P0 performance QA

Candidate source starts at deployed Production commit `dbe91d85c99f72eb7950be1057683f7952a1a784`. No Production records were changed by this QA. All writes use disposable loopback fixtures with constructor-injected synthetic identity.

| Check | Result |
| --- | --- |
| TypeScript and ESLint | Passed |
| Default Next 16.4.1 Turbopack production build | Passed in isolated `hamdee-performance-build`, offline frozen-lockfile dependency install |
| Build source parity | SHA-256 equality for all ten changed application source files |
| Built runtime boundaries | 31 HTTP checks passed: standalone login/assets, unconfigured workspace and protected API fail-closed behavior |
| Targeted new browser performance checks | 4 passed across desktop and mobile |
| Native PostgreSQL owner suite | 5 passed, including independent connections, concurrent replay/version edits, audit rollback, app/database restart persistence |
| Native PostgreSQL legacy suite | 9 passed, including least privilege, upgrade persistence, disabled/revoked access and interrupted transaction recovery |
| Native cleanup | Both owned clusters confirmed stopped |
| Full Node regression | 590 unique cases covered: initial 589 passed with one stale copy assertion, corrected case passed; final 9-case adapter/dashboard rerun also passed |
| Frontend adapter performance regression | 7 passed |
| Full browser regression | 202 unique desktop/mobile cases passed: 22 preserved passing cases plus 180/180 completed in the resumed run (11.6 minutes) |

The browser performance checks hold a property read indefinitely: the selected navigation item and contextual loading heading update before release, and another route remains usable. Startup performs one capabilities read, does not request five operational overview payloads, and property navigation adds no `auth/state` fanout. Independent exact-source browser traces in `evidence/performance-p0/{baseline,candidate}-request-counts.json` repeat twice on desktop and mobile: startup API GET requests 15→4, property list/detail API GETs 2→1 each, and `auth/state` calls 8→1. These tests are real browser/loopback HTTP/PGlite flows, not hosted Supabase latency measurements.

The adapter tests cover in-flight GET coalescing only within the same route signal, mutation/session invalidation, cancellation, denied/stale-response isolation, and older response deadlines arriving after newer verified or explicitly renewed access state. There is no settled financial response cache. Security regression checks retain server authorization, revocation, CSRF, precommit checks, and transactional rollback.

Existing navigation/usability readiness tests now intercept the authorized capabilities endpoint rather than holding the removed startup overview probes. This preserves their assertions about unavailable/malformed contracts and delayed responses after logout. The preexisting final-dashboard copy assertion was corrected to match both current accessible and visible financial disclaimers, retaining all saved amount/currency/cutoff assertions.

Native tools were downloaded from the [official EDB archive](https://get.enterprisedb.com/postgresql/postgresql-17.11-5-windows-x64-binaries.zip), retained only under ignored `.test-tools`, and verified against the repository's pinned SHA-256 `80379B2C04D51C30225532E0AE04509899141E9957ED096FE749D7FD9DF8F82F` and four executable hashes before execution. Initial concurrent startup attempts hit existing 45-second tool and 10-second runtime startup budgets under heavy host contention; sequential native and runtime retries passed. These setup attempts are not application latency evidence.

The legacy demo financial reference command also passes 24 checks plus 53 Node cases (16 TODOs), but deliberately reproduces known legacy defects. It is characterization only and is not deployed financial acceptance.

The coordinator confirmed all nine signed-in Production routes reach usable states without alerts in a read-only smoke check. Hosted login/dashboard/module/save p50/p75/p95, provider latency, actual pool-acquisition/SQL time and cold starts remain unverified. The supported CUA evaluator exposes DOM state only (`performance` is unavailable); browser tool round trips include a roughly 3.1-second bridge floor, so those durations are excluded rather than presented as application latency. The protected candidate Preview builds successfully and redirects unauthenticated clients to Vercel SSO (302); exact branch-scoped environment inspection found zero Preview runtime keys. It is not an activated or accepted performance runtime. Candidate hosted testing needs separately approved isolated runtime/data configuration, authenticated access, and a disposable dataset for mutation testing. This QA does not establish the requested hosted performance targets or Production release readiness. Production remains on `dbe91d8`.

The browser run was deliberately paused during heavy concurrent Node/native work. Completed passing cases were preserved using the supported Playwright `--test-list-invert` filter; all remaining cases, including the corrected readiness contract cases, completed without failure. No hosted latency conclusion is drawn from local test-run durations or from discarded resource-contended setup attempts.
