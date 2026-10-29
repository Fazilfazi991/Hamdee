# Isolated query profile — 29 October 2026

Re-run against production baseline `dbe91d8` in `hamdee-performance-p0`.
Earlier measurements from `4ce5b95` are obsolete for this release. Absolute local
timings differ under concurrent development/test load and must not be interpreted
as a before/after comparison of those revisions.

Run `node --import tsx scripts/profile-query-performance.mjs` from this checkout.
Optional native mode: `node --import tsx scripts/profile-query-performance.mjs --native --approved-local-only`.
It verifies the existing pinned portable PostgreSQL runtime/archive under `.test-tools`,
creates its own disposable loopback cluster using the established native harness,
creates a least-privilege profile backend role, retains runtime RLS and constraints,
and stops only that owned cluster in `finally`. It never accepts a database URL.
The same seed and financial assertions run in both modes. Native mode additionally
captures EXPLAIN ANALYZE/BUFFERS for the slowest SQL statement in rental, expense,
and car overviews, logging only plan node/table names, counts, buffers and timing.
Raw SQL parameters, predicates, user identities, row payloads and credentials are
excluded. Do not start volume profiling while regression/UI tests saturate the host.
The script creates an in-memory PGlite database using the existing test migrations,
seeds synthetic records, invokes actual service read methods with the owner role,
and closes the database. It accepts no hosted URL or credentials and logs only
aggregate timings, counts and response sizes. No production database was read or
modified. Existing constraints and financial triggers remain enabled.

Dataset: 8 properties, 131 rooms, 115 contacts, 131 active agreements across two
synthetic currencies, 12 monthly periods, 1,572 dues/receipts/allocations, 12 vehicles
and 1,440 car receipts, 24 staff collections, one company cash account and handover.
Expense/maintenance history is empty; finance/staff volume is modest. These cases
are useful for identifying shared rental aggregation overhead, but do not establish
high-volume expense/staff/finance performance. There is no independent Partners
service endpoint in this checkout, so no partner query latency is claimed.

One initial invocation was discarded per module, followed by 10 sequential warm
samples. These are local database/service timings, not browser or hosted targets.
The first invocation is not a hosted cold-start measurement and must not be labeled
as one. Network/TLS, connection acquisition, Singapore routing, managed Auth,
browser render, transfer/compression and saves are excluded.

| Actual service overview | SQL statements including owner checks | JSON bytes | Warm p50 ms | p75 ms | p95 ms | SQL p50 ms |
|---|---:|---:|---:|---:|---:|---:|
| Rental portfolio | 15 | 1,760,907 | 538.71 | 628.74 | 754.22 | 478.42 |
| Rental one property | 15 | 236,898 | 101.07 | 151.57 | 301.94 | 94.15 |
| Expenses | 11 | 2,620 | 228.29 | 264.40 | 312.69 | 227.16 |
| Staff | 7 | 37,143 | 63.12 | 65.76 | 69.35 | 62.00 |
| Company Finance | 7 | 1,859 | 5.26 | 5.90 | 8.43 | 4.63 |
| Cars | 7 | 866,952 | 197.55 | 208.98 | 235.18 | 184.39 |
| Property dashboard | 8 | 3,278 | 5.12 | 5.41 | 6.59 | 4.62 |

Assertions passed: 131 rooms and 115 contacts returned; selected November due and
collected totals each equal exactly 1,310,000 minor units; two currencies remain
distinct; all selected-period outstanding balances equal zero. Synthetic receipt
amounts are fixtures, not verified client financial totals.

Confirmed: rental overview returns all historical collections, allocations and
events despite selected-month dues. That produces 1.75 MB before compression for
this 12-month dataset. A property-scoped read reduces the payload by about 86.5%.
The expense overview spends ~228 ms with zero expense records because its return
also aggregates rental dues, collections and allocations. Car overview returns
all receipts and event history (867 KB here). Invoking these overviews merely to
discover module availability incurs real database and transfer work.

The newer rental source reads property metadata and rental reissue events and
calculates historical occupant projections from contact notes. The profiler runs
that source, yielding 15 statements rather than the obsolete 13. It seeds active
synthetic agreements and ordinary contacts, not imported private source-sheet notes;
that historic provenance projection needs dedicated synthetic regression coverage.

Source risks requiring follow-up profiling: rental advance balance calculation
filters the entire allocation array per advance receipt; expense and finance
summaries use correlated aggregates; finance returns overlapping `entries` and
`monthEntries`; car/staff history and several event arrays are unbounded. Filtering
or pagination must preserve historical reports and all as-of cash/credit balances.
Do not truncate financial source rows to improve a benchmark.

Index inventory: rental allocation due/receipt indexes, rental agreement room/date
index, expense-payment expense index, car receipt agreement/status/date/vehicle
indexes and operational account/collector/currency/date indexes already exist.
No new index or migration was added. The native plans below confirm historical
scan work, but no trial index comparison establishes a beneficial index change.

The source pins the transaction pooler to ap-southeast-1, port 6543, with pool max
2, 3-second connection timeout and 10-second idle timeout. This establishes configured
pooling, not actual acquisition latency or function/database colocation. Hosted
deployment metadata and protected-environment timings must verify those separately.

Release status: isolated evidence only. Authenticated hosted before/after p50/p75/p95,
request waterfalls, browser/render timings, save timings, native database plans,
slow/interrupted network and concurrency acceptance remain required. These local
numbers cannot establish release readiness or the user-visible performance targets.

## Optional native mode executed

The optional mode passed against actual PostgreSQL portable 17.11 using its own
hash-verified runtime and disposable cluster. Setup and every service call retained
database constraints, runtime-role RLS and owner pre/post checks. A separate
least-privilege login backend was used for service calls. Root's large Node suite
and QA's UI suite were paused/completed before the volume run; a brief final
targeted root suite overlapped setup. These numbers still describe a local machine,
not managed hosted performance. They are not a controlled candidate-versus-baseline
comparison. No production credentials or database URLs were accepted.

Ten warm samples, same synthetic data and exact currency/November financial checks:

| Actual service overview | SQL statements | JSON bytes | Warm p50 ms | p75 ms | p95 ms | SQL p50 ms |
|---|---:|---:|---:|---:|---:|---:|
| Rental portfolio | 15 | 1,760,907 | 604.84 | 679.47 | 734.75 | 542.50 |
| Rental one property | 15 | 236,898 | 117.89 | 125.08 | 152.32 | 109.45 |
| Expenses | 11 | 2,620 | 482.61 | 514.38 | 579.12 | 480.72 |
| Staff | 7 | 35,784 | 137.21 | 146.73 | 165.94 | 134.68 |
| Company Finance | 7 | 1,839 | 6.48 | 8.40 | 9.82 | 5.72 |
| Cars | 7 | 870,577 | 361.09 | 465.32 | 508.03 | 333.02 |
| Property dashboard | 8 | 3,278 | 10.63 | 12.19 | 13.78 | 10.00 |

EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) was run within the same owner context for
the most expensive observed SQL statement in each of three overviews. Only node
types/table names/counts/timing/buffers were emitted; filters and parameters were
not logged. Parent-node times and buffer totals include their descendants and must
not be added together.

| Statement | Planning ms | Execution ms | Representative work | Root shared-hit/read blocks |
|---|---:|---:|---|---:|
| Rental allocations join | 0.220 | 236.321 | Hash join and sort return all 1,572 allocations; sequential scans of 1,572 receipts and 1,572 allocations | 12,631 / 0 |
| Expense property/currency summary | 1.410 | 356.448 | Unique/Merge Append processes 3,144 rental key rows into 8 property/currency keys; correlated aggregate scans run 8 times | 21,762 / 0 |
| Car JSON overview | 2.656 | 307.442 | Receipt bitmap scan reads 1,440 rows; event sequential scan/sort reads 1,464 rows; correlated receipt CTE scans run 12 times | 12,309 / 0 |

All three measured plans used cached buffers without physical reads. This confirms
substantial historical scan/join/aggregation/serialization work remains even with
a warm local database. The measurement does not isolate CPU spent in row security
functions from other query work. It does not justify weakening those checks or
adding an index speculatively. A narrower read contract or separately paginated
history must preserve complete financial totals and historic views before release.

The native script exited 0, all financial assertions passed, and cleanup printed
`NATIVE_PROFILE_CLUSTER_STOPPED true`. It stopped only its own newly created cluster.
QA was explicitly notified to resume after cleanup. Hosted database plans, network,
Auth, save and user-visible timings remain outstanding acceptance evidence.
