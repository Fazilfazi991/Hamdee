# HAMDEE continuation migration compatibility and preservation

This plan belongs to the continuation of local candidate `6a0397303025f23013e2997f955471d95e925352`. It does not authorize hosted execution. Original client files remain in the private handoff directory, outside Git; examples and rehearsals use synthetic records only.

## Reconciled source ancestry

| Source event | Evidence | Consequence |
| --- | --- | --- |
| `75dd2a21c17d9e4846cbb3ce59d1e056029a9a64` | Introduced `013_local_car_source_records.up.sql` together with occupancy 011 and private documents 012 | Vehicle registration/make may be unknown; `needs_confirmation` and private immutable `car_source_references` may already exist. These are unposted source evidence, not receipts. |
| `93b77d0` | Deleted that car migration and reverted its API/UI/tests | Deletion from Git does not establish that an applied database was rolled back. |
| `47588af` through `490b191` | Restored occupancy/documents and later rental work without restoring car-source 013 | Source provenance and destination schema must be checked independently. |
| `6a0397303025f23013e2997f955471d95e925352` | Introduced different `013_local_customers_kyc_cheques.up.sql` | Numeric version 013 was reused. It is not an upgrade/replacement for car-source 013. |

LF-normalized SHA-256 source fingerprints:

- Historical car 013: `c005ae49ecd4294599ba0545855d048e7c9a489d00f4fa1694da66b786aba12a` (Git blob `fa9216a61c3593da2ab2e72ed94420a7dc58b89d`).
- Candidate customer 013: `e2914401740895d8f3658276732ed2213cb310522aa59232557cac48339ae4c6` (Git blob `236d51f383a56c15779bac9a7f89d1982f82bca4`).

The continuation leaves migrations 001–016 unchanged. Local 017 restores car-source capability additively and preserves a correctly matching existing car-source table; it adds coordinated correction evidence and dated effective ledger views. Existing nullable vehicle identities and source references remain readable through the restored car API. Source references cannot create income or confirmed rental terms.

## Known destination and current access limit

The existing source pins identify dedicated synthetic-development Supabase project `dytlzfwbgeuhzgzemqsf`, Singapore, transaction pooler port 6543 and restricted `hamdee_backend` login. Pins are non-null; older documentation saying they are unset is stale. These pins are not proof of the destination's applied migrations or data class.

During this continuation, migration-history and application-marker inspection for that project were denied by the connected account. Its available project listing did not expose HAMDEE. **Actual hosted migration history, object fingerprints, record inventory and recovery snapshot remain unverified.** No unrelated project was used. Production was not queried for business data or modified.

No SQL in this package should be run against a hosted destination merely because a filename begins with a number. The new local scripts explicitly reject non-local application markers. A hosted wrapper must be separately prepared and approved after the following readback succeeds.

## Destination-specific decision branches

1. Read the exact destination's immutable project ID, `application_identity`, database version, schemas, applied migration ledger/source checksums, role attributes, memberships, default privileges, RLS, policies, constraints, triggers and function definitions. Include 011 occupancy confirmations, 012 private property documents and both possible 013 identities. A migration ledger alone is insufficient when earlier SQL was executed manually.
2. If historical car 013 was applied, preserve its recorded identity/checksum and all `car_source_references`, nullable vehicle fields, status values, revisions and rental snapshots. Add customer/KYC/cheque changes under a **new unique hosted migration identity**; never overwrite or mark the unrelated customer 013 as the same applied migration.
3. If car 013 was never applied, confirm that the entire car-source capability is absent before adding it. If candidate customer 013 is already applied, verify its complete schema/checksum and existing data, then omit re-creation rather than replaying the file.
4. If either source is partial or its constraints/grants differ, stop only that upgrade path and produce an explicit forward repair from the observed state. Do not blanket `IF NOT EXISTS` around unknown objects, delete data or silently normalize a partially applied schema.
5. Preserve existing 001–016 ledger entries, including occupancy, optional files, property/room/customer/vehicle UUIDs and permissions. Apply continuation features through destination-specific transactional additions in dependency order: source-compatible corrections (local reference 017), collector counts/openings (018), then principal/supporting records (019). Preserve original applied version identities rather than renumbering them.
6. After execution in an approved isolated destination, verify schema fingerprints and every preservation comparison before exposing a Preview. The Preview must have its own inspected database and marker; deployment protection does not establish database isolation.

## Correction data model and preservation

`financial_corrections` retains source kind/ID, reason, actor, date, original funding entry, exact reversal and optional same-parent replacement. Original bill payments and deposit refunds stay immutable. Generic finance reversals cannot bypass these links. A corrected replacement can itself be corrected as a new source; an original source can be corrected only once.

The old bill-payment reference index is intentionally replaced by a source-aware trigger: an explicit replacement may retain its original bank/payment reference along its correction ancestry, while an unrelated duplicate reference remains denied. The payment-limit guard reads net effective payments, retaining the original bill's maximum and currency checks. These are reviewed forward schema changes, not edits to the already committed migrations that created the original index/functions.

`expense_payment_effects`, `rental_collection_effects` and `security_deposit_refund_effects` expose original rows plus a negative dated compensation. They do not rewrite an earlier business date or transaction. Source services and reports use those effective rows when 017 is installed, retaining the original uncorrected schema behavior when it is absent. Company accounts and collector balances derive from the same money entries. Changed funding locations, wrong currencies, excess repayments/refunds and dependent negative dated balances fail atomically.

For old funded rental refunds, `rental_refund_funding_links` mechanically identifies existing source-to-money evidence from the existing recorded event. It posts no new money. An already reversed rental refund without coordinated source evidence is rejected for explicit review rather than silently repaired.

## Snapshot, recovery and acceptance

Before a hosted write, prepare a transaction-consistent private schema/data snapshot for the **verified destination**, including immutable revisions, audit/command results, private file bytes and storage metadata. Keep credentials, full document numbers, file contents and backups outside Git, public artifacts and logs. Record checksum, timestamp, destination identity and restricted location privately. Restore the snapshot into an isolated test destination and verify access denial for unauthorized users; a file existing on disk is not a tested recovery plan.

Baseline comparisons must include counts, stable UUID sets and deterministic row hashes for properties/revisions, rooms, tenants, occupancies/source confirmations, optional documents (content hashes), vehicles/revisions/source references, agreements, dues, allocations, collections, expenses/payments, KYC revisions/documents, cheques/status events/refunds, accounts, custody, transfers, partner movements and permissions. Compare actual currency/date totals separately; do not add different currencies or treat missing amounts as zero.

Local populated-upgrade rehearsal is implemented in `tests/car-source-compatibility.test.ts` using the exact historical car 013 schema retained as a test fixture. It preserves populated occupancy, private optional documents, source references, vehicle/customer/property IDs and account rows while applying the continuation. Correction tests retain original rows, check earlier cutoffs, replacement chains, replay, conflicting concurrent commands and failure after compensation writes. Native independent upgrade/concurrency/restart results are reported separately by the release coordinator; PGlite alone is not native or hosted evidence.

For recovery after any approved upgrade failure, roll back the transaction first. If restoration is needed, use the previously verified snapshot/restore procedure for that exact destination. Never execute a local down/reset script against Production. No live recovery snapshot, hosted migration, resource provisioning, push or deployment has been performed by this workstream.
