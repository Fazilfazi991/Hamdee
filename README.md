# HAMDEE Property Management CRM

Standalone Next.js application preserving the HAMDEE interface, managed owner authentication adapter and transactional PostgreSQL property foundation. One approved owner/admin manages multiple properties. Partners and tenants are records, not login roles in this milestone.

The local slice covers managed owner email/password login, property create/edit/archive/restore/history and the existing room, tenant, agreement, dues, collection, deposit, expense, maintenance and report workflows. Dashboard room occupancy and rent balances come from saved records. This authentication change preserves their existing calculations and persistence. CP1/CP2 reference modules and regression coverage are retained.

Open a property and choose **Rooms & rentals**, or use **Tenants & agreements** / **Collections**. Add a room and tenant, save an agreement, then issue its explicit monthly amount and due date. Cash/bank rent receipts allocate to selected dues; cheques are pending records without clearance. Advances require explicit dated allocation; deposits and refunds remain separate. Reports use a chosen month and occupancy/balance date, with currencies kept separate. No automatic proration, rent escalation or partner-profit rules are applied.

Use **Expenses**, **Maintenance**, or a property's **Expenses & maintenance** tab for landlord, Kahramaa, Wi-Fi/utilities, cleaning, maintenance and miscellaneous costs. Record a bill/cost once, then add full or partial payments against it; cheques remain pending. Completing a maintenance job creates exactly one linked expense, including explicit zero-cost work. Warranty updates preserve history and add no charge; matching prior work warns without automatically waiving cost. Vendor contacts, references, notes and payment dates are retained.

**Reports** downloads a monthly CSV and shows property/category totals by currency. The comparison is rent allocated toward the selected month's dues minus costs dated in that month through the report date; unpaid costs are included and cash/bank payments are shown separately by payment date. Deposits and unapplied advances are separate. This is an operational comparison, not recognized or distributable profit. `004_local_property_expenses.up.sql` is additive and local-only; it has not been applied hosted and requires its own hosted review.

`003_local_rental_operations.up.sql` is an additive, local-only migration. Test fixtures apply 001/002/003 to disposable synthetic databases. It has not been applied hosted; the earlier property-only activation package does not authorize this migration or the new rental source. Local acceptance uses synthetic provider responses and PGlite, including disk reopen. Native PostgreSQL retesting may be blocked by the Windows Application Control policy; do not bypass it or claim hosted/native acceptance from PGlite tests.

**Current hosting boundary:** the protected Preview serves the UI shell; it is not an activated CRM. `LocalPostgresDatabase` remains restricted to loopback. The locally prepared `HostedPostgresDatabase` requires separately reviewed connection pins, verified TLS, restricted database roles and a synthetic-development schema marker. Its source pins remain null, so environment variables cannot activate an unreviewed connection. Without approved configuration protected APIs return503 `CONFIGURATION_UNAVAILABLE`.

## Local setup

Use Node24 and the pinned pnpm11.25.0. Dependencies and lockfile are at repository root; no parent website, workspace package or asset download is required.

```text
pnpm install --frozen-lockfile
pnpm run assets
pnpm run dev
```

Open `http://127.0.0.1:4180/` (redirects to `/workspace/index.html`). Application environment variables are not required to install/build or inspect the unconfigured UI. There are no default application credentials. Automated login flows exist only in constructor-injected test harnesses.

## Verify

```text
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:financial
pnpm exec playwright install chromium
pnpm run test:ui
pnpm run build
pnpm run test:runtime
```

Foundation tests use disposable synthetic PGlite. Browser tests start/stop their own loopback handlers with injected fake authentication and cover the real workspace UI. The SDK tests intercept provider transport; they do not contact Supabase. Real provider acceptance remains pending.

Optional native PostgreSQL tests and source launchers are documented in [docs/native-testing.md](docs/native-testing.md). They require a separately supplied reviewed runtime and explicit disposable setup. No runtime binary, database, password file, test log or screenshot belongs in Git. Skipped native tests are not acceptance.

`tests/financial/reference/` contains the preserved synthetic financial model and report-function reference as CommonJS source. It is outside `public/`, is never imported by the application, and does not provide live financial behavior. Characterizations reproduce known defects; passing them does not mean those defects or unresolved policy gates are fixed.

## Manual Vercel import

Use the existing HAMDEE project in faziils-projects; do not create a duplicate project or reassign any website domain. Preserve its SSO protection. The repository's default development branch currently triggers Production builds. The prepared `vercel.json` disables automatic Git deployments for `codex/hamdee-crm-development`; after approval and publication, create explicitly targeted Previews. This disables automatic Preview builds on that branch too, without changing production-branch, domain or protection settings. Verify the first push's deployment events and cancel any unexpected Production build. Nothing deploys merely because this local file exists.

| Setting | Selection |
| --- | --- |
| Framework | Next.js |
| Root directory | Repository root; do not select a nested folder |
| Node.js |24.x |
| Build command | `pnpm run build` |
| Output directory | Next.js default; no override |
| Install | Frozen lockfile with pinned pnpm11.25.0 |

`package.json` pins `packageManager` to pnpm11.25.0. Enable Vercel Corepack support using the build-time variable named `ENABLE_EXPERIMENTAL_COREPACK`, following the official instructions. Let Vercel detect the package manager with Corepack enabled; require the install log to show pnpm11.25.0 and a frozen lockfile. Do not use an unpinned bare package-manager override. The build-tool setting is separate from application configuration.

Leave application variables unset for the initial protected build/UI check. No database migration, auth bootstrap, resource provisioning or deployment command runs during install/build. No Vercel project/account IDs or credentials are stored here.

Official references: [build settings](https://vercel.com/docs/builds/configure-a-build), [package managers/Corepack](https://vercel.com/docs/package-managers), [Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [deployment protection](https://vercel.com/docs/deployment-protection).

## Configuration names

`.env.example` contains names/placeholders only. All owner policy, identity, project, residency and key values require reviewed activation; synthetic test inputs are not defaults. Runtime configuration is server-only. Never commit a filled environment file or put provider/database/session secrets in `NEXT_PUBLIC_` variables.

The owner runtime consumes these names:

```text
HAMDEE_OWNER_RUNTIME_APPROVAL
HAMDEE_APP_ID
HAMDEE_ENVIRONMENT
HAMDEE_DATA_CLASS
HAMDEE_PROJECT_REF
HAMDEE_PROJECT_OWNER
HAMDEE_REGION
HAMDEE_RESIDENCY_DECISION
HAMDEE_SUPABASE_URL
HAMDEE_AUTH_ISSUER
HAMDEE_AUTH_AUDIENCE
HAMDEE_SUPABASE_PUBLISHABLE_KEY
HAMDEE_OWNER_SUBJECT
HAMDEE_OWNER_ORIGIN
HAMDEE_DATABASE_URL
HAMDEE_DATABASE_MODE
HAMDEE_HOSTED_DATABASE_APPROVAL
HAMDEE_DATABASE_CA_PEM
HAMDEE_OWNER_COOKIE_KEY
HAMDEE_OWNER_IDLE_MS
HAMDEE_OWNER_ABSOLUTE_MS
HAMDEE_OWNER_CSRF_MS
HAMDEE_OWNER_EMAIL
HAMDEE_OWNER_AUTH_TIMEOUT_MS
HAMDEE_OWNER_RATE_WINDOW_MS
HAMDEE_OWNER_RATE_BOUNDS
HAMDEE_OWNER_RATE_BACKOFF_MS
```

The existing nonsecret project/development pins remain in source. Do not enable integration merely because a platform build succeeded. No real owner account, hosted migration, provider recovery message or business data is provisioned by this repository.

## API and security boundary

Auth base: `/api/hamdee/auth`, with state, email/password login, refresh, logout and recovery-preparation endpoints; TOTP endpoints are inactive. Protected metadata base: `/api/hamdee/v1`, with session, dashboard and existing property commands/history. Success uses `{data,requestId}`; safe errors use `{error:{code,message},requestId}`. Property mutations retain UUID idempotency keys and read ETags and `X-Hamdee-Property-Revision` write checks. The application revision header prevents intermediary conditional-response handling after a committed mutation; stale revisions still fail closed.

Server checks pin trusted issuer, immutable owner ID and the configured confirmed mailbox, require verified password authentication and fresh enabled database Admin/portfolio membership, and enforce exact Origin/session-bound CSRF for unsafe requests. Raw provider credentials remain in authenticated-encryption HttpOnly cookies; browser JSON exposes safe auth state and CSRF only. Sign-in never creates or enables database membership.

Managed refresh gates and precommit checks preserve fail-closed behavior, but provider/SQL are not one distributed transaction. Multiple refreshes per request add latency and rotation/rate pressure; delayed cookie responses may force reauthentication. Real-provider concurrency, outages and revocation timing require separate acceptance. Failed provider sign-out is explicitly unconfirmed; clearing local cookies alone does not revoke an independent copy. Recovery is preparation/manual review only: no email/SMS, password/factor reset or durable recovery hold is implemented. Current in-process limiter and console auth audit are local-development provisions.

SQL under `migrations/` is the existing local foundation and its disposable reset, not an automatic hosted migration plan. No build/start hook applies it. Preserve the existing RLS, least-privilege, transactional audit/history, revision and idempotency protections before any later database adaptation.

## Prepared hosted development activation

Only project `dytlzfwbgeuhzgzemqsf`, Singapore, synthetic records is in scope. After authorization, inspect its actual schema, Connect endpoint/port, SSL certificate, PostgreSQL version, role attributes and grants before filling `reviewedHostedDatabasePins` in `src/hosted-database.ts`. Do not compose the pooler hostname from the region. Prefer transaction pooling for Vercel; queries remain unnamed and transaction state uses SET LOCAL. Direct mode requires the reviewed project CA; pooled mode uses verified Node roots or an explicitly reviewed CA. No URL query options, PG environment overrides or disabled TLS validation are accepted. Source and runtime credentials use only the restricted hamdee_backend login, never postgres/service_role.

Hosted SQL requires its own separately reviewed application step: verify the target and any available backup; preserve existing schema/data; apply the approved foundation/hardening to an empty dedicated schema only when absent, inside a controlled transaction; add the exact synthetic-development marker with project_ref and data_class constraints; provision hamdee_backend LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION and membership in hamdee_runtime without ADMIN OPTION. Keep private tables/functions unavailable to PUBLIC, anon, authenticated and the Data API. Do not execute local down/reset SQL or blindly replay CREATE statements on an existing schema. Existing local migrations remain byte-identical. A live-schema inspection must determine the final SQL before execution approval.

HAMDEE uses the existing Supabase Free plan. Synthetic development does not require paid backups, automated backup services, PITR or a plan upgrade. Preserve the versioned schema/migrations in this repository and publish approved additions through the existing Git approval gate. Keep backup and recovery safeguards documented for future real-data approval; their paid features do not block the synthetic Preview.

Enable runtime only on a separately approved Vercel Preview with HAMDEE_DATABASE_MODE=hosted-development and HAMDEE_HOSTED_DATABASE_APPROVAL=approved-synthetic-development-database, all existing owner runtime fields and reviewed source pins. VERCEL_ENV must be preview. No host/account secret is stored in this repository. Server-only variables, exact Preview HTTPS origin, immutable owner UUID and a dedicated cookie key must be configured through authorized platform secret handling.

Managed Auth setup requires one explicitly approved mailbox/account, disabled public signup, a confirmed exact mailbox, password-primary managed session and an enabled internal owner Admin/portfolio grant tied to the project's issuer and immutable user UUID. No staff accounts, portals or mandatory authenticator enrollment. Confirm the approved recovery custodian; never put credentials or recovery secrets in reports. Until a recovery procedure is approved, recovery is preparation only. An authorized operator must disable database membership and revoke provider sessions before resetting credentials, then reenable access only after verified owner identity and password authentication. The application does not implement a durable self-service recovery hold.

Required hosted acceptance after activation: actual provider email/password sign-in/logout/revocation/expiry and concurrent refresh; wrong-owner, unconfirmed-mailbox and missing-password-proof denial; dashboard/property CRUD/archive/restore/history; persistence after reopen; duplicate/stale-write/rollback behavior; provider/database outages and desktop/mobile browser flows. Local synthetic tests and TLS handshakes do not establish hosted acceptance.

## Design and references

See [DESIGN.md](DESIGN.md), [CP1 technical reference](docs/security/CP1_CONTRACT.md) and [CP2 technical reference](docs/security/CP2_LOCAL_CONTRACT.md). The five shared HAMDEE assets are repository source under `public/shared/`; `pnpm run assets` verifies their hashes. Inter's license is included as `public/shared/OFL.txt`. No dependency on a parent Fusion Ventures checkout remains.

The active single-owner release uses managed email/password login directly into the dashboard. It does not enroll or challenge authenticators and has no factor-freshness gate. Historical CP1/CP2 security contracts remain preserved. Provider errors are enforced; this code does not suppress provider restrictions. The owner approved 15-minute idle and 8-hour absolute limits; the real entrypoint requires those exact explicit settings. Tests may inject shorter clocks for repeatable boundary coverage. The sealed cookie binds the original verified password AMR time; refresh/activity cannot replace it or extend absolute lifetime. Changes to optional factor metadata do not become an application login requirement. Cookies from the previous authentication contract require a fresh password login.
