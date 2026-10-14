# HAMDEE Property Management CRM

Standalone Next.js application preserving the HAMDEE interface, managed owner authentication adapter and transactional PostgreSQL property foundation. One approved owner/admin manages multiple properties. Partners and tenants are records, not login roles in this milestone.

The implemented slice covers email/password and TOTP through managed Supabase Auth, owner-only access, safe cookies/CSRF, property create/edit/archive/restore/history and dashboard counts from saved records. Financial and remaining CRM modules are not activated. CP1/CP2 reference security modules and synthetic regression coverage are retained.

**Current hosting boundary:** a successful build or Vercel import does not connect the backend. The accepted `LocalPostgresDatabase` permits dedicated loopback databases with its local-test marker; it rejects hosted database URLs. Vercel cannot use a database on your computer's localhost. A separately approved hosted adapter/schema/privilege review is still required for hosted persistence. Environment variables alone cannot complete that integration. Without approved configuration the UI shell loads and protected APIs return503 `CONFIGURATION_UNAVAILABLE`.

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

The owner connects the dedicated GitHub repository manually. Use a **new dedicated HAMDEE development project**, with no existing website project or domain reassignment. Before importing or adding credentials, enable appropriate deployment protection for **all deployment URLs**, including the first import. A new development project can classify its first/default-branch import as production; a branch name or noindex tag does not guarantee privacy.

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
HAMDEE_OWNER_COOKIE_KEY
HAMDEE_OWNER_IDLE_MS
HAMDEE_OWNER_ABSOLUTE_MS
HAMDEE_OWNER_CSRF_MS
HAMDEE_OWNER_MFA_MAX_AGE_MS
HAMDEE_OWNER_AUTH_TIMEOUT_MS
HAMDEE_OWNER_RATE_WINDOW_MS
HAMDEE_OWNER_RATE_BOUNDS
HAMDEE_OWNER_RATE_BACKOFF_MS
```

The existing nonsecret project/development pins remain in source. Do not enable integration merely because a platform build succeeded. No real owner account, hosted migration, provider recovery message or business data is provisioned by this repository.

## API and security boundary

Auth base: `/api/hamdee/auth`, with state, login, TOTP enrollment/verification, refresh, logout and recovery-preparation endpoints. Protected metadata base: `/api/hamdee/v1`, with session, dashboard and existing property commands/history. Success uses `{data,requestId}`; safe errors use `{error:{code,message},requestId}`. Property mutations retain UUID idempotency keys and ETag/If-Match revision checks.

Server checks pin trusted issuer and immutable owner ID, require current verified TOTP and fresh enabled database Admin/portfolio membership, and enforce exact Origin/session-bound CSRF for unsafe requests. Raw provider credentials remain in authenticated-encryption HttpOnly cookies; browser JSON exposes safe auth state and CSRF only. Sign-in never creates or enables database membership.

Managed refresh gates and precommit checks preserve fail-closed behavior, but provider/SQL are not one distributed transaction. Multiple refreshes per request add latency and rotation/rate pressure; delayed cookie responses may force reauthentication. Real-provider concurrency, outages and revocation timing require separate acceptance. Failed provider sign-out is explicitly unconfirmed; clearing local cookies alone does not revoke an independent copy. Recovery is preparation/manual review only: no email/SMS, password/factor reset or durable recovery hold is implemented. Current in-process limiter and console auth audit are local-development provisions.

SQL under `migrations/` is the existing local foundation and its disposable reset, not an automatic hosted migration plan. No build/start hook applies it. Preserve the existing RLS, least-privilege, transactional audit/history, revision and idempotency protections before any later database adaptation.

## Design and references

See [DESIGN.md](DESIGN.md), [CP1 technical reference](docs/security/CP1_CONTRACT.md) and [CP2 technical reference](docs/security/CP2_LOCAL_CONTRACT.md). The five shared HAMDEE assets are repository source under `public/shared/`; `pnpm run assets` verifies their hashes. Inter's license is included as `public/shared/OFL.txt`. No dependency on a parent Fusion Ventures checkout remains.
