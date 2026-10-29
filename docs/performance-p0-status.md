# HAMDEE P0 performance candidate — 29 October 2026

**Status: hosted acceptance and Production release blocked. Production has not been changed.**

Protected Preview code candidate: [`f5b8c05`](https://github.com/Fazilfazi991/Hamdee/commit/f5b8c052a065464a6aa8032f32faa99bb957e1de), [immutable Preview URL](https://hamdee-dshvxyvif-faziils-projects.vercel.app), deployment `dpl_FC6o9NnxKx8QoaDeCJDEH1KjXho4`. Vercel reports READY in `sin1`. An unauthenticated `/login` request redirects 302 to `https://vercel.com/sso-api`; no share/bypass link was created and SSO settings were not changed. Filtered environment metadata for this branch has zero matching Preview keys, so this is a built protected candidate, **not an activated, performance-accepted owner runtime**. Production was rechecked and remains `dbe91d85`.

The candidate branch `codex/hamdee-performance-p0` starts at the exact deployed Production revision `dbe91d85c99f72eb7950be1057683f7952a1a784`. An older worktree was identified and excluded as a release base. No financial migrations, indexes, client records, provider configuration, or Production environment variables were changed.

## Evidence and changes

- Production already included the reduced optional-module owner-context transactions and batched transaction-local SQL settings. These are not new candidate savings.
- Replaced overview-based discovery with one fully owner-authorized capability request. It reads schema availability rather than tenant or financial datasets. Partners and existing module branches remain supported.
- Removed redundant frontend `auth/state` reads after already-authorized business responses. Those responses carry the current verified expiry and CSRF state; explicit CSRF renewal and server revocation/precommit checks remain.
- Coalesced only identical outstanding GETs under the same route AbortSignal. No settled financial-response cache was added. Mutations and access loss invalidate the scope.
- Preserved module filters on navigation; private state is still cleared on logout, expiry and denied access. Contextual loading, draft preservation and duplicate-submit safeguards remain under regression tests.
- Added numeric request-local `Server-Timing`, documented in [performance-metrics.md](performance-metrics.md). These metrics do not isolate Supabase provider latency from auth-controller work or pool acquisition from total transaction work. They contain no tokens, identities or financial payloads.
- Realistic synthetic profiling confirms full-history overhead: 131 rooms, 115 contacts, twelve rental periods. Rental overview: 15 SQL callbacks, 1,760,907 JSON bytes; car overview: 866,952 bytes. Detailed timings, dataset limitations and exact currency/total assertions are in [performance-query-profile.md](performance-query-profile.md). No speculative index or history truncation was applied.

## Hosted baseline

The exact deployed frontend and candidate were also exercised in real headless browsers against isolated loopback fixtures (two desktop and two mobile runs per version). Only request path/count metadata was captured:

| Browser workflow | Production-baseline GETs | Candidate GETs |
| --- | ---: | ---: |
| Startup through login/dashboard | 15 | 4 |
| Startup `auth/state` subset | 8 | 1 |
| Property register navigation | 2 | 1 |
| Property detail navigation | 2 | 1 |

Counts matched in all four runs per version: 73.3% fewer startup GETs and 50% fewer property-navigation GETs. Local selected-navigation feedback was 15.8–25.8ms baseline and 19.1–45.9ms candidate. This does not establish faster hosted navigation; the primary demonstrated change is avoided network/data work.

Measured public Production HTTPS on 29 October at 14:43 Dubai time (10:43 UTC) from the Windows execution host, unthrottled network, uncontrolled geographic RTT. Eight sequential requests per endpoint; subsequent percentile calculations use seven samples. First observed request is **not** a verified cold start. Bodies, cookies and tokens were discarded without diagnostic output.

| Signed-out endpoint | First observed total | Subsequent p50 / p75 / p95 |
| --- | ---: | ---: |
| `/login` document | 329 ms | 80 / 88 / 234 ms |
| `/api/hamdee/auth/state` anonymous | 242 ms | 146 / 164 / 165 ms |

These are HTTP timings, not login-to-dashboard or browser-render measurements. They do not establish the reported authenticated bottleneck. Function region `sin1` was verified from the deployed Vercel revision; reviewed database configuration uses the Singapore transaction pooler on port 6543. Neither metadata nor READY status proves runtime latency.

| Required authenticated workflow | Hosted before | Hosted after |
| --- | --- | --- |
| Login to usable dashboard | Not measured | Not measured |
| Dashboard, villa, room, module navigation | Six single module observations below; required percentiles unavailable | Not measured |
| Rental/finance reads and confirmed saves | Not measured | Not measured |
| Cold starts, slow network, interrupted/concurrent requests | Not measured | Not measured |

The owner subsequently signed into the in-app browser. One read-only Production navigation sample per section at a 439px viewport gave automation-observed click-to-main-ready times: property register 1,668ms; cars 1,393ms; staff 1,369ms; expenses 2,780ms; company 891ms; personal 1,507ms. Selection reached the requested route and no alert was present for these six samples. These include browser-control overhead, occurred during heavy local test CPU load, and do not isolate network/server/render duration. Further samples encountered browser-control timeouts and were excluded. They are **not** reliable warm p50/p75/p95 or target acceptance. Login duration was not captured because the owner signed in manually. No financial payload, credentials or tenant details were recorded, and no Production business mutations were attempted.

An approved disposable Preview dataset is still needed. Existing Preview configuration is branch-scoped; this candidate does not copy Production credentials or use client records as disposable QA fixtures. All nine top-level Production routes subsequently reached main-ready with no loading descendants or alert indicators in one read-only traversal. That traversal showed an approximately 3.1-second browser-control floor across every route, so it was excluded from application latency statistics. Precise network waterfalls are unavailable through the current browser's DOM-only evaluation surface; no unsupported browser-state or cookie extraction was attempted.

## Release gates

Local regression results and measured fixture request counts are recorded separately by [independent QA](performance-qa.md). The full Node run exercised 590 cases: 589 passed initially and one failed an outdated dashboard disclaimer assertion. That semantic assertion was corrected without altering financial invariants; the final focused frontend/dashboard rerun passed all nine cases. Native PostgreSQL owner tests passed 5/5 and legacy database tests 9/9, with owned clusters stopped. TypeScript, ESLint, a default Next 16.4.1 build with frozen dependencies, source-hash parity and 31 built-runtime HTTP checks passed. All 202 unique desktop/mobile browser cases passed: 22 completed cases retained from the paused run plus all 180 remaining cases passed in the supported nonoverlapping test-list run. Browser suite elapsed time under local load is not an application latency metric.

These checks are not hosted acceptance. Supabase provider latency, hosted connection setup, authenticated before/after percentiles and cold starts remain distinct gates. The optional native query profile passed exact synthetic financial/currency checks and stopped its separate cluster; it shows cached full-history rental/expense/car work still deserves investigation if hosted targets are missed. No native profile was used to justify an unmeasured Production index or financial-history cutoff.

A protected Preview may be built for code review. Without separately approved isolated Preview runtime configuration, it must remain fail-closed and cannot qualify as an accepted performance release. No Production push, promotion, release configuration change or client handover is authorized by this task. Complete authenticated hosted before/after p50/p75/p95, all listed owner workflows, native/security/financial regression and explicit Production release approval before release.
