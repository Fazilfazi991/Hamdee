# Client requirements review — 2 November 2026

This is an implementation review, not a confirmation of historical financial data. No source receipt, opening balance, KYC document or historical transaction has been posted during this review.

## Source inventory and limitations

Read-only source inspection located `HAMDEE .. EXCEL 1.xlsx`, `HAMDEE.. EXCEL 2.xlsx` and `HAMDEE VIDEO.mp4` on the owner's Desktop, outside this repository. Neither the repository, the supplied attachment directory nor a recursive OneDrive search contained `HAMDEE_Client_Requirements_Review.xlsx`. Connected Google Drive searches for the exact review-workbook name also returned no file; a broader HAMDEE search did not identify that workbook. The original R01–R47 definitions and original fourteen questions therefore remain unavailable. They must be retained from that workbook when provided; this review does not invent replacements or silently renumber them.

The two workbooks were inspected from their original XML, without modifying them or evaluating formula remarks as transactions. The video exists, but the Malayalam narration has not been transcribed or verified. Spreadsheet inspection alone does not satisfy the required audiovisual source review.

| Source | Exact location | Observed purpose / treatment |
| --- | --- | --- |
| Excel 1 | Sheet1 F4:G4; repeated AMOUNT/DEPOSIT sections | Amount and deposit columns exist; these labels alone do not establish receipt dates, currencies, verified opening balances or cash funding. |
| Excel 1 | Sheet1 J3, N3, J5, J8 | Cash balance, actual cash, old balance and collection total are separate concepts. An unexplained difference is not an owner withdrawal. |
| Excel 1 | Sheet1 J22:J30; R53; U54:U68 | Building utility references exist. Keep multiple account references per building rather than flattening into one number. |
| Excel 1 | Sheet1 U103 | Furniture location register exists; supporting inventory remains distinct from rent or cash receipts. |
| Excel 1 | Sheet1 D335:D337 | Yaris, Camry and Corola references have different textual period clues; matching names must not create or merge vehicles automatically. |
| Excel 1 | Sheet1 Q130:Q140 | Vehicle purchase/service/insurance/parts mentions are costs or review references, not proof of rental agreements. |
| Excel 1 | Sheet1 A375 | Outside receivables are separately labelled. Repayments must not all become rent. |
| Excel 1 | Sheet15 C3:G3, L3 | Owner summary headings: Total Rent, Total Collection, Landlord, Kahramaa, Maintenace, Total Ahad. Owner share basis and paid movements require separate confirmation. |
| Excel 1 | Sheet15 B11:B12 | Yaris and Honda City appear in this summary. Honda City's relationship to rental and maintenance entries is unresolved. |
| Excel 2 | Sheet1 A1 | Explicit title: “Matar Building 06 Oct 2026”. Preserve October 2026. |
| Excel 2 | Sheet1 B4, B6, B10, F11, A17 | Total rent, landlord, service charge, Kahramaa and balance are separate report components. |
| Excel 2 | Sheet1 F2, G4:H4 | Profit-share/share/amount headings exist; no universal percentage, calculation basis or rounding rule is inferred. |

The client brief establishes November 2026 for the main operational register and gradual backfill of older entries, with some bank references dating from March 2025. Existing `historical-occupancy.ts` explicitly projects an October source snapshot; preserve its original provenance until the underlying imported snapshot has been reconciled to the new source files. Do not globally relabel existing records.

## R01–R50 register

Status vocabulary: Working / Partially working / Missing / Needs business confirmation. A source requirement whose wording is absent cannot truthfully be marked implemented.

| IDs | Status | Evidence and remaining work |
| --- | --- | --- |
| R01, R02, R03, R04, R05, R06, R07, R08, R09, R10 | Needs business confirmation | Original individual definitions absent with review workbook; no invented mapping. |
| R11, R12, R13, R14, R15, R16, R17, R18, R19, R20 | Needs business confirmation | Original individual definitions absent with review workbook; retain IDs for reconciliation. |
| R21, R22, R23, R24, R25, R26, R27, R28, R29, R30 | Needs business confirmation | Original individual definitions absent with review workbook; retain IDs for reconciliation. |
| R31, R32, R33, R34, R35, R36, R37, R38, R39, R40 | Needs business confirmation | Original individual definitions absent with review workbook; retain IDs for reconciliation. |
| R41, R42, R43, R44, R45, R46, R47 | Needs business confirmation | Original individual definitions absent with review workbook; original fourteen questions also unavailable. |
| R48 | Working locally | Customer/cheque model verifies held/presented separation, explicit bank clearance, funded deposit, return/cancel/bounce/replacement, linked post-clearance reversal and idempotency. Property-linked clearance uses the existing rental deposit ledger. Private cheque images, funded-deposit refunds and generic reversal safeguards are implemented; production/hosted acceptance remains pending. |
| R49 | Partially working | New customer service reuses tenant IDs, derives profile relationships from original ledgers and flags duplicate names without merging. Unified desktop/mobile profile workflows pass, and independent tests verify explicit car links plus precise period-filtered statements. Linked vehicle and source money audit events are included in dated customer history. Final imported-customer/source reconciliation remains pending. |
| R50 | Working locally | Private customer KYC files, masking, explicit owner review and expiry are implemented. Independent checks confirm pending after upload, missing/expired handling, malformed-file rollback, owner denial and reveal privacy. Desktop/mobile customer flows pass. Real-provider and hosted acceptance remain separate. |

## Existing capabilities and genuine gaps in the supplied brief

| Capability | Baseline status | Existing evidence / release gap |
| --- | --- | --- |
| Owner email/password login, protected APIs, logout | Working locally | Owner auth/session suites; actual provider/hosted acceptance remains separate. |
| Properties, rooms, tenant IDs, optional document support, dated occupancy | Working locally | Rental/occupancy services and migrations 003/011/012. Preserve original records. |
| Dues, partial allocation, advance allocation and funded deposit separation | Working locally | Rental service and daily-operations tests. Dues require confirmed rental terms, not a document file. |
| Receipt plus selected money location in one save | Working locally | Connected receipt/allocation/account or collector entry is atomic and idempotent. Independent service and funded desktop/mobile rental browser workflows pass. Hosted acceptance remains pending. |
| Collector handover and internal account transfer | Working locally | Existing staff/company finance commands preserve original source receipt and transfer funds without new income. |
| One bill with multiple partial payments | Working locally | Connected funding records one bill, its payment and actual money movement. Further settlement retains the same bill and actual payment date. Property/company/personal scopes remain separate. |
| Paid property/company cost from collector funds | Working locally | Connected funding links the original bill payment to one custody outflow; independent scope QA verifies remaining money transfers by handover without a new receipt. |
| Company/personal cash and bank ledgers by currency | Working locally | Existing confirmed-opening ledger and daily dashboard. Physical count/reconciliation capture is not equivalent to calculated balances. |
| Actual counted balance, dated explanation and difference | Working locally | Additive migration 015 and reconciliation service retain original calculated/count values and explanations without creating withdrawals or money movements. Isolated service and desktop/mobile browser checks pass; hosted acceptance remains pending. |
| Customer statement with period/currency filter | Working locally | Property statement and precise car statement distinguish receipt dates, rental periods and opening/closing figures. Financial exports omit KYC fields. Full source-ledger reconciliation remains separate. |
| Security cheque lifecycle/replacement/correction | Working locally | Private security-cheque records preserve status events; bank posting requires explicit clearance. Linked correction and refund checks preserve money/deposit consistency. |
| Customer KYC private access/review | Working locally | Dedicated customer private files and metadata reuse owner authorization; verification remains an explicit reviewed revision. Upload alone does not verify KYC. |
| Excel 2 property report | Partially working | Category/month reports include separate service-charge costs and preserve individual bill references. Exact source comparison and multiple utility-reference reconciliation remain pending. |
| Sheet15 owner summary | Partially working | Existing dashboard and partner ledger; scheduled rent, collection, costs, shares and movements must reconcile without treating result as cash. |
| Partner percentages / calculation basis / rounding | Needs business confirmation | Existing partner movements are not an approved share calculator. |
| Outside receivable and loan principal/repayment ledger | Missing | Classified receipt/account mechanisms exist, but do not implement the original-principal/repayment relationship and remaining-balance ledger. |
| Investments, insurance and furniture locations | Needs business confirmation | Source supporting references observed; do not guess ownership, valuation or transaction classification. |
| Source deduplication/import | Needs business confirmation | No name-only merge; no historical money import before ambiguity review. |
| Hosted migration, real provider, working Preview | Needs business confirmation | Source README states hosted pins unset and existing protected Preview is UI shell. A local build is not a working hosted CRM. |

## One private business review list

Retain the original fourteen source questions as one private list when the missing review workbook is supplied. Do not recreate or duplicate them from assumptions. The following are the only new business questions introduced by the three additions:

1. Cheques: confirm allowed statuses, who records presentation/clearance, permitted bank accounts, required clearance evidence, return/bounce correction policy, replacement linkage and whether an image is required. Proposed lifecycle remains an implementation proposal until reviewed.
2. KYC: confirm which documents/fields are mandatory, which have expiry, review responsibility and whether any action is blocked by missing documents. Proposed fields/statuses are optional implementation choices; no regulatory claim or collection block is inferred.

Existing unresolved source decisions remain unresolved: exact confirmed room/month rent and currency where ambiguous, dated opening balances/account ownership, personal classification, utility account references, vehicle identity links, share percentages/basis/rounding, and original periods. Missing historical decisions must not block legitimate November operations with explicit confirmed inputs.

## Safety and acceptance boundary

Use disposable local synthetic fixtures only. No hosted write tests, schema reset, KYC import, historical financial posting or deployment is authorized by this brief. New migrations are additive local release artifacts until separately approved against an inspected destination with a recoverable snapshot. Native concurrency, real provider session behavior, hosted performance and real data reconciliation cannot be claimed from PGlite or a green build.

## Independent checks added with this review

`tests/client-requirements-qa.test.ts` verifies competing same-key collection/bill retries, 2,000 due with 1,200 allocated and 800 remaining, one receipt/claim/inflow, no new receipt when changing month, wrong-currency rollback with subsequent valid retry, a 600 bill with one 200 payment, and personal spending outside property operating costs. These exercise disposable synthetic PGlite transactions; they do not establish native multi-connection races.

`tests/client-requirements-customers-qa.test.ts` independently checks private customer creation/file access, masking and explicit reveal without persisting revealed values into command results, owner denial, malformed-file rollback, missing/expired KYC, duplicate-name flags without automatic merge, held/presented cheque separation, explicit 2,000 bank clearance with competing retries, uncleared return/cancel/bounce/replacement without financial movement, and a property-linked cleared cheque corrected by explicit bank reversal while the original 2,000 rent due remains outstanding. Synthetic identity placeholders contain no real identity numbers or documents.

Follow-up audit added short-identifier masking, unlinked deposit refund/retry/over-refund/reversal-denial/as-of checks, and explicit car linking without duplicate tenant records. Car profile receipts/costs and filtered car statements retain decimal precision (1,000.123456 agreed minus 100.000001 received = 900.123455). The audit reproduced an inconsistent generic company-ledger reversal of a cleared security cheque; the release now adds a deferred database guard requiring linked cheque correction evidence rather than allowing an isolated bank reversal.

`tests/client-requirements-scopes-qa.test.ts` adds three independent cases for company unpaid/partial bills with next-month settlement, personal bank-funded spending excluded from property/company operating costs, and collector-funded company bills followed by custody handover. All three pass locally. The other two independent files total twelve passing cases. Together these fifteen independent cases verify service/database behavior with synthetic records; browser coverage and performance are separately recorded in the consolidated release report.

Exact measured suite results are recorded in the consolidated release report after final integration. Source workbooks were not copied into Git or edited.
