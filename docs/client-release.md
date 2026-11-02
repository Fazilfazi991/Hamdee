# HAMDEE — continuation release package

Prepared 2 November 2026, continuing candidate `6a0397303025f23013e2997f955471d95e925352`. The final source commit is supplied in the coordinator's handoff after committing this package. Production remains unchanged: no push, provisioning, hosted migration, deployment, historical financial posting or live KYC import was performed.

## Source and requirements

The private handoff was recovered and reviewed: README/CONTINUATION first, all 17 manifest files verified, the original R01–R47 workbook wording and Q01–Q14 list, both workbooks, Malayalam transcript, timestamped English evidence notes and R48–R50 additions. Private originals remain outside Git. The uncertain word near 00:15 stays unresolved under Q05; no fines were added.

The [R01–R50 implementation mapping](client-requirements-review.md) links each original requirement to code, tests and its affected business hold. The final mapping has **46 Implemented locally**, **4 Needs business decision** (R29/R31/R33/R34), **0 Partial**, **0 Missing** and **0 Hosted verified**. Unanswered source questions hold only affected historical values or formulas; they do not block confirmed daily receipts, costs, corrections or counts.

## Completed continuation

- Source-level corrections for funded bill payments and funded rental/security deposit refunds retain the original, reason, actor, exact compensating money entry and optional replacement. Earlier business-date cutoffs retain the original effect; later cutoffs use compensation/replacement. Replays and competing corrections cannot duplicate outflows. Unsafe standalone reversals and corrections invalidating later available-funds balances remain denied.
- Collector opening/count records and account denomination counts preserve calculated versus declared/actual balances, currency, difference and explanation. Counts create no withdrawal, expense or handover. Later backdated entries cannot overwrite an original reconciliation snapshot.
- Principal ledgers separate money owed to HAMDEE from money HAMDEE owes. Opening obligations create no cash unless actual funding is explicitly entered. Partial repayments, principal amendments and linked correction/replacement history use exact currencies and decimals without becoming rent, interest or fees.
- Excel 2 reports show the tenant schedule, landlord, service charge, separate utility-account bills, detailed costs and property result. Sheet15-style owner summaries separate scheduled rent, actual collections, recorded costs, paid outflows, owner transfers and partner records. Unconfirmed share/Extra/owner-attribution results remain null with the applicable question, rather than fabricated zeros or payouts.
- Supporting landlord due-day/frequency, multiple Kahramaa accounts, Wi-Fi/service references, policy/investment details and furniture/asset locations use a simple non-posting reference register with revisions. Confirmed room order and retained source provenance preserve the monthly register order. Partial-month terms require an explicit amount; no general proration is invented.
- Sanitized imported-customer acceptance verifies property-scoped room identities, distinct same-name contacts, retained October/November source versions and explicit property/car links to existing IDs. Occupant changes preserve prior dues, receipts, deposits, KYC and optional private room documents. Customer profiles also show linked principal, supporting records and source/money histories. Car collections now save the receipt and chosen account/collector funds together.

Native PostgreSQL verification also found a calendar-date decoding defect in the local Asia/Calcutta timezone. HAMDEE pools now retain PostgreSQL DATE values as YYYY-MM-DD strings, keeping source receipt and linked money dates aligned; timestamp decoding remains unchanged. Coverage is in `tests/calendar-date.test.ts` and the native continuation suite.

The original customer, KYC, cheque, collection, expense and reconciliation features are retained. Pending security-cheque face values remain separate from available cash and funded deposits. KYC upload is not verification, files remain owner-authorized, and normal financial exports exclude identity-document details.

## Verification of the integrated source

| Verification | Result and boundary |
| --- | --- |
| Full local regression | **647/647 passed; zero failures, skips or TODOs**, 883,779 ms. The 43 affected UI source contracts were repeated successfully after the final UI fixes; they are already included in this inventory. Synthetic local data; PGlite and injected Auth are not hosted evidence. |
| Actual native PostgreSQL | **28/28 passed** on owned loopback PostgreSQL 17.11: legacy, owner, car/finance and populated continuation-upgrade suites. Includes independent sessions, retries/conflicts, rollback, least privilege and actual database/application restart checks. See [native testing](native-testing.md). |
| Complete desktop/mobile browser regression | **208/208 passed; zero failures/skips**, desktop and mobile, 370,672 ms (6.2 minutes), two isolated workers. Earlier discovery/targeted runs are excluded from this unique count. |
| Typecheck / ESLint | **Passed on the final implementation.** |
| Optimized application build | **Passed on the final implementation.** |
| Built runtime HTTP checks | **81 checks passed on the final implementation.** |
| Actual hosted provider/database/Preview acceptance | **Not run; no Hosted verified claim.** |

The retained legacy financial-reference suite separately reports 53 passed, 16 TODO decision gates and zero failures across 69 cases. These are historical reference diagnostics, not added to the 647-test count or a substitute for live connected-workflow acceptance.

The new focused acceptance sources cover source compensation, collector counts, principal directions/repayments, report math, private-file denial, canonical imported-customer matching, optional-document preservation and restart persistence. Native tests use synthetic records and fresh owned clusters; they do not touch an existing/shared service or prove real-provider authentication.

EX05 reproduces `53,500 − 34,000 − 500 − 9,664 − 3,180 = 6,156` as a **scheduled-rent result**, not cash. The original report's currency is unconfirmed; write tests use explicit synthetic XTS. Four utility references reproduce 9,664. EX07's raw three-share result leaves a remainder; no share rule or remainder payout is inferred.

Repeated performance evidence uses five retained samples per action/viewport after one warm-up, measured from Playwright action to visible completion over loopback HTTP with the real workspace, PGlite and an injected fake provider. Navigation timing ends when the core customer profile and linked property row are visible; optional later panels are outside that measurement. Save timing ends at the exact updated balance. The following continuation sample set is local, not hosted latency or a percentile guarantee:

| Action | Desktop n / median / min–max ms | Mobile n / median / min–max ms |
| --- | --- | --- |
| Customer profile navigation | 5 / 179 / 170–190 | 5 / 194 / 166–226 |
| Connected collection save | 5 / 224 / 214–253 | 5 / 170 / 120–198 |

Raw samples are in ignored `evidence/continuation-performance/{desktop,mobile}.json`; these final samples come from a separate sequential two-case repeat after the complete browser run. Those two cases are already in the 208-case inventory and are not counted again. Hosted sample count is zero. Business-date report cutoffs are not immutable recorded-through snapshots when genuinely backdated records are later supplied; original records, compensations and reconciliation snapshots remain retained.

## Migration, preservation and recovery

The [destination-specific migration decision plan](migration-plan.md) reconciles the actual Git ancestry: an earlier **013 car-source** migration and this candidate's different **013 customer/KYC/cheque** migration are unrelated identities. Deletion from Git is not evidence that an applied database was rolled back. Migrations 001–016 are unchanged; no applied migration is overwritten or renumbered.

Local continuation artifacts are 017 (source-compatible corrections and dated effective ledgers), 018 (collector openings/counts and optional denomination evidence), and 019 (principal and supporting references). They are local-only rehearsal sources, not scripts to replay on Production. The populated upgrade and native preservation checks retain existing occupancy/source confirmations, optional private documents, vehicle references, stable IDs, historical transactions, RLS and permissions.

Existing reviewed connection pins identify Supabase project `dytlzfwbgeuhzgzemqsf`, Singapore, transaction-pooler mode and restricted `hamdee_backend` access. Pins are **non-null**. Migration-history and application-marker reads were denied by the connected account; the actual hosted schema, applied migration identities, data class, business-data inventory and recovery snapshot are therefore **unverified**. No unrelated project was used as a substitute.

Before any authorized hosted write, read that exact destination's marker, version, migration ledger and object fingerprints, then select the matching branch of the migration plan. Prepare a private transaction-consistent schema/data snapshot, including revisions, command/audit rows and private-file content hashes/bytes; verify checksum and restore it into an isolated destination. Compare UUID sets, row hashes, grants and currency/date totals before and after. No live snapshot or hosted restore was performed here. Local restart/preservation evidence is not a claim of a tested hosted backup.

The final hosted SQL must follow the observed destination state, use a unique migration identity and preserve any already applied car 013 or customer 013. A partial/drifted schema needs a specific forward repair; do not hide it with blanket IF NOT EXISTS or run local reset/down scripts against Production.

## Exact remaining business holds and hosted permissions

The original private Q01–Q14 list remains the decision authority. Its affected holds are:

- Q01/Q02/Q14: historical opening dates, currencies, ownership and cash/credit/custody/liability classifications.
- Q03: whether a difference is an approved owner movement; the default is an explained difference without a posting.
- Q04/Q05/Q06: uncertain deposit/advance/cheque components, unclear speech and due-day/range text. No invented fines or move-in dates.
- Q07/Q08/Q10: real historical occupant, property/room and vehicle identity decisions. Representative matching works; uncertain real identities are not merged or made active automatically.
- Q09/Q12: utility column/formula relationships and whether a single proration example is a general rule. Affected unconfirmed formulas remain held.
- Q11: property-specific partner identities, percentages, calculation basis, rounding and remainder. No automatic share or payout.
- Q13/Q14: whether supplementary references are current and how missing dates/currencies/owner-attribution are classified. No fabricated historical transactions.

Only two additional decision groups concern the proposed cheque lifecycle/clearance/refund evidence and mandatory KYC fields/documents/review rules. No mandatory KYC collection block or new regulatory claim was introduced.

The proposed hosted acceptance target is an explicitly targeted Preview in the **existing HAMDEE hosting project**, connected only to an inspected isolated synthetic database. The pinned development project may be used only after its marker/schema/data class and separation from Production are proven; deployment protection alone is not database isolation.

The genuinely missing hosted access/approvals are grouped together: (1) grant the connected account read access to the exact pinned project's migration/schema/marker/role metadata and preservation inventory; (2) confirm the isolated synthetic destination and private snapshot/restore procedure; and (3) approve the resulting destination-specific migration and explicitly targeted Preview deployment on the exact final commit. No provisioning, push, migration or deployment is inferred from this development brief. Historical financial postings, live KYC imports and later Production release still require their applicable explicit authorization.
