# Performance candidate measurements

The owner runtime emits `Server-Timing` only for successful responses. Values are request-local durations in milliseconds or fixed numeric counters. They contain no identities, record fields, credentials, URLs, or financial payloads. Concurrent requests have independent measurements through `AsyncLocalStorage`.

| Metric | Exact scope |
| --- | --- |
| `owner` | Time inside the owner application's request wrapper, through response creation; excludes Next.js routing, process startup before invocation, network transfer and browser work. |
| `auth` | Sum of owner authentication/authorization controller calls, including managed provider calls, policy checks, encryption and controller work. This is not isolated Supabase Auth latency. |
| `database` | Sum of complete database transaction calls, including pool acquisition, connection setup if required, hosted guards, callback work and commit/rollback. Callback work includes live identity rechecks, so this overlaps `auth`. |
| `sql` | Sum of query round-trip durations issued through the service callback's SQL wrapper. Excludes transaction BEGIN/COMMIT/ROLLBACK and hosted guard statements executed before the callback; not PostgreSQL execution time alone. |
| `db_tx` | Number of service database transaction invocations, including ones attempted; returned as a numeric `desc`. |
| `db_query` | Number of service callback SQL query invocations. Excludes hosted guard and driver transaction-control statements. |

These overlapping metrics must not be added or subtracted to claim isolated provider, connection or PostgreSQL server processing time. Those require provider/driver tracing or server-side query diagnostics on the protected candidate. No such hosted measurements are established by local fixtures.

`X-Hamdee-Session-Expires-At` and `X-Hamdee-CSRF` are functional same-origin authorization projection headers. They keep the browser's existing idle timer and anti-CSRF proof synchronized with a successful business request, avoiding a separate authentication-state request. They are **not diagnostics**: diagnostic capture must whitelist `Server-Timing`, status, elapsed duration and request counts, and must not record Cookie, Set-Cookie, CSRF, Authorization, response bodies or financial payloads.

Module discovery reads only private-schema table names under the current full owner grant, projects them to availability booleans, and repeats all ordinary authorization and live identity checks. Capability metadata neither caches identity nor authorizes future business requests.
