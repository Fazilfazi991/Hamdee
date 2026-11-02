# Connected customer operations — local release candidate

Prepared 2 November 2026. This is a tested local development package, **not a completed Production release or full R01–R50 acceptance**. The exact local source commit is supplied in the handoff. No push, deployment, hosted migration, historical posting or live KYC import was performed.

## Delivered behavior

- Customers & Tenants reuses tenant IDs and explicitly links car rentals. Profiles combine contact/occupancy history, property and vehicle terms, dues, allocations, receipts, advances, funded deposits, cheque events, private KYC and original audit events. Property and car statements retain their respective monetary precision, dates and currencies.
- Cash/bank rent entry saves the receipt, allocation and selected company account or collector custody in one transaction. Replays do not duplicate financial records. Advances, pending cheques and deposits remain separate.
- Property/company/personal bills support unpaid and partial payment states. Each paid entry links to its actual account or collector outflow. Later payments settle the original bill. Personal costs stay outside property/company operating-cost reports. Service-charge and company-overhead categories are available.
- Security cheques remain noncash until explicitly presented and cleared into a confirmed bank account. Property-linked clearance posts to the existing rental deposit ledger. Returns, cancellation, bounce, replacements, private cheque images, funded refunds and explicit clearance reversal retain history. Bank reversal and re-receiving a reversed cheque cannot bypass the cheque ledger.
- KYC can be entered during customer creation and retained in later revisions. Private PDF/JPEG/PNG files are limited to 1 MB each, checked by signature and downloaded through owner-authorized endpoints. Uploading leaves review pending. Identity numbers are masked until explicit owner reveal. Financial CSVs exclude KYC fields.
- Company/personal account reconciliations retain the calculated balance, actual count, date, explanation and difference. They create no money movement. Later backdated entries do not overwrite the original counted snapshot.

## Evidence and limits

Final verification: **620 regression tests passed, zero failures/skips**, including 24 focused new service/acceptance cases. Typecheck, ESLint, optimized build and 52 built-runtime HTTP checks passed. Thirty-four selected desktop/mobile customer, rental, expense, navigation and private-document cases were verified across the final and targeted regression runs. The final broad run also passed the existing standalone partner browser acceptance.

The end-to-end browser test uses the real workspace, HTTP handlers and disposable synthetic PGlite with a constructor-injected fake provider. It covers customer creation with private KYC, room prefill, 2,000 due / 1,200 collection / 800 outstanding, a 600 bill / 200 payment / 400 unpaid, cheque clearance, account reconciliation, personal bills, financial CSV privacy and document denial after logout. Both desktop and mobile passed.

Independent service tests also cover collector 1,200 / handover 1,000 / remaining 200, collector-funded costs, competing retries, failed-save rollback, missing/expired KYC, short identifier masking, explicit car links with precise filtered statements, cheque replacement/returns/bounce/refunds and linked clearance corrections. Account reconciliation preserves exact decimals and earlier snapshots. A disk close/reopen and service reconstruction test preserves private document bytes, the 800 rent balance, one funded bill and command replay; disabling the owner afterward denies document access.

Measured final local browser samples (milliseconds; individual observations, not percentiles):

| Action | Desktop | Mobile |
| --- | ---: | ---: |
| Customer list navigation | 315 | 281 |
| Customer profile navigation | 322 | 237 |
| Customer with KYC save | 208 | 175 |
| Connected rent save | 165 | 200 |
| Paid property bill save | 236 | 214 |
| Held cheque save | 244 | 344 |
| Confirmed cheque clearance | 241 | 275 |
| Account reconciliation | 270 | 208 |
| Later personal bill payment | 248 | 209 |

Raw local evidence is under ignored `evidence/connected-customers/`. These results do not establish hosted latency, real-provider behavior, native PostgreSQL concurrency, or Production-data reconciliation.

## Requirements and remaining work

See [source review and R01–R50 mapping](client-requirements-review.md). The original R01–R47 wording and original fourteen questions are unavailable because `HAMDEE_Client_Requirements_Review.xlsx` is missing. Both original Excel files were inspected read-only; the Malayalam video narration is still unverified. None of those gaps is disguised as an implemented requirement.

R48 and R50 work locally. R49's connected profiles work locally; final source matching and comprehensive imported-customer acceptance remain pending. The following also remain explicit release gaps:

- Exact Excel 2 / Sheet15 report reconciliation, source vehicle identity decisions and supporting-record reconciliation.
- A structured original-principal / repayment relationship for outside receivables and loans; classified receipts alone do not implement that ledger.
- Coordinated correction/replacement of an already funded bill payment or refunded deposit. Unsafe standalone money reversals are denied instead of leaving the source balance stale.
- Actual counted reconciliation currently covers company/personal accounts; collector balances and handovers have dated ledgers, but collector count capture is not implemented.
- Hosted/native acceptance and a working hosted Preview. Current runtime activation pins remain unchanged; an unconfigured build correctly denies protected operations.

Business decisions still required are the original fourteen source questions when recovered; confirmed ambiguous rent/currency/opening data; vehicle identities; personal account ownership/classification; and partner percentages, calculation basis and rounding. The only new question groups are the proposed cheque lifecycle/evidence/refund handling and mandatory KYC fields/documents/review rules. No universal share, proration, regulatory-document requirement or KYC collection block was introduced.

## Migration and recovery package

Existing migrations remain unchanged. New artifacts are local-only and must **not** be replayed directly against a hosted or Production database:

1. `013_local_customers_kyc_cheques.up.sql` — private customer KYC, links, cheque history, refunds and correction safeguards; requires existing 001–004/006/007.
2. `014_local_connected_funding.up.sql` — immutable bill-payment funding evidence and collector spending safeguards.
3. `015_local_account_reconciliation.up.sql` — retained account-count comparisons, without balance adjustments.
4. `016_local_scoped_expenses.up.sql` — preserve existing bills as property scope and add company/personal bills and source categories.

Before any approved hosted execution, inspect the exact project/database/schema/roles and migration state; inventory existing rows and immutable IDs; prepare a restricted, transaction-consistent schema/data snapshot including private document bytes; verify its integrity and a restore into an isolated destination; and record the restore procedure and snapshot location privately. No live database snapshot was taken in this development session. Keep snapshots and credentials outside Git and public artifacts.

Then prepare a destination-specific transactional migration plan, compare preservation counts and grants, and test against a separate disposable destination. Restore from the verified snapshot for recovery; do not run local reset/down scripts or delete live records. Approval must cover that exact destination, snapshot, migration plan and deployment. Historical financial postings and live KYC imports require separate explicit authorization.

No hosted Preview was created because this brief does not authorize deployment. The local source package is ready for review; unresolved gaps above prevent claiming the full client implementation is finished.
