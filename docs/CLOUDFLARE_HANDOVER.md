# Cloudflare migration handover

**Last updated:** 2026-08-16, checkpoint 11 locally complete — Fable orchestrating, Opus building, Fable reviewing
**Owner:** Codex/SOL started; Fable continuation run
**Continuation:** Fable or another agent should read this file, `CLOUDFLARE_MIGRATION.md`, and the three companion migration documents before changing code or infrastructure.

## Current repository state

- Branch: `cloudflare-migration`
- Remote: `origin/cloudflare-migration`
- Latest implementation checkpoint: checkpoint 11 — catalogue foundation (see below)
- Base application revision: `019a0b7` — `Harden checkout and print production pipeline`
- Production Firebase remains live and untouched by this migration run.
- Staging D1 database `meteorshop-stg-db` and Worker `meteorshop-stg-api` have been created in the personal Cloudflare account and smoke-tested.
- No production resources, DNS records, custom routes, secrets, queues, R2 buckets, Containers, Stripe endpoints, or email integrations have been created.
- The user's personal Cloudflare account is designated for staging/non-production.
- A separate Cloudflare production account is required before cutover, but does not need to exist yet.

## User instructions that remain active

1. Communicate in English.
2. Continue autonomously and make safe assumptions within the migration scope.
3. Commit and push frequently at stable checkpoints.
4. Keep this handover file current at every checkpoint so Fable can resume quickly.
5. Never push secret values into Git.
6. Do not change production DNS, deploy production Cloudflare resources, deactivate Firebase, or perform irreversible cleanup without an explicit cutover/deletion approval.

## Architecture decisions

- Resource prefix: `meteorshop-{env}-{service}` using hyphens for Cloudflare resource names.
- Personal account: staging/non-production resources only.
- Production: separate Cloudflare account under the same login/organization.
- Runtime: one modular API Worker, queue/scheduled jobs, static web deployment, and a Container for Sharp/FFmpeg.
- Data: one D1 database per environment; immutable `shop_id` tenant boundary enforced in the API/repository layer and database constraints.
- Files: public, private, and temporary R2 buckets.
- Async work: commerce, email, media, and import Queues with DLQs and deterministic idempotency.
- Auth: application-owned adapter, currently planned around pinned Better Auth + D1. Cloudflare Access is optional Platform defence-in-depth, not customer auth.
- Email: Cloudflare Email Service after a real-domain deliverability canary; retain rollback provider until proven.
- Existing Firebase Functions are reorganized by domain, not recreated as 75 Workers.

## Completed checkpoint

### Checkpoint 1 — Migration plan

- Created `docs/CLOUDFLARE_MIGRATION.md`.
- Updated the plan to use the personal account for staging and defer creation of the separate production account until pre-cutover.
- Created and pushed branch `cloudflare-migration`.
- Pushed commit `4a70cba`.

## Checkpoint 2 — Local Cloudflare foundation and executable specifications

### Documentation companions

Three documentation companions are complete and reviewed by the primary agent:

- `docs/CLOUDFLARE_FUNCTION_MAP.md` — all live Firebase exports mapped to Cloudflare responsibilities.
- `docs/CLOUDFLARE_DATA_MODEL.md` — D1 schema/invariants/collection mapping.
- `docs/CLOUDFLARE_CUTOVER_CHECKLIST.md` — staging, production, smoke, rollback, and retirement checklist.

The function inventory contains 75 unique rows matching the 75 live exports. During review, delegated `meteor-np-*` names were corrected to the authoritative `meteorshop-stg-*` / `meteorshop-prod-*` convention, the media queue was disambiguated as `*-media-jobs`, and an unused Hyperdrive reference was removed.

### Local Cloudflare foundation

Validated scaffolding has been added under `cloudflare/`:

- Standalone package and TypeScript configuration.
- `wrangler.jsonc` targeting `meteorshop-stg-api` only.
- Typed `/health` route and fail-closed 404 response.
- Workers-runtime Vitest coverage.
- Package README and `.gitignore` with staging, secret-handling, Wrangler-state, and startup-profile boundaries.

Pinned toolchain:

- Wrangler `4.123.0`
- `@cloudflare/workers-types` `5.20260815.1`
- `@cloudflare/vitest-pool-workers` `0.21.3`
- Vitest `4.1.10`
- TypeScript `7.0.2`

The initially scaffolded Vitest configuration used the obsolete pre-Vitest-4 `defineWorkersConfig` API. Current Cloudflare documentation and installed package exports showed the new `cloudflareTest()` plugin contract; the configuration and test imports were corrected before commit.

Checkpoint 2 was committed and pushed as `0de5e79`.

## Checkpoint 3 — Staging tenancy/data foundation

### Version-controlled implementation

- Added `migrations/0001_platform_foundation.sql` with tenant, domain, audit, idempotency, and outbox foundations.
- Added immutable-tenant triggers, append-only audit triggers, uniqueness/check constraints, and operational indexes.
- Added a typed D1 binding and pinned the non-secret personal staging account ID in `wrangler.jsonc`.
- Added `/ready`, which verifies the required migration and fails closed with a generic `503` if D1 is unavailable or behind.
- Added Workers-runtime D1 migration setup and adversarial tests for hostname normalization, tenant re-homing, append-only audit records, and duplicate idempotency/outbox keys.

### Staging infrastructure and evidence

- Wrangler identity verified for the personal staging account before resource creation.
- Account ID: `0d392e5c79e386966a98a214ac91a133` (non-secret configuration identifier; credentials remain outside Git).
- D1: `meteorshop-stg-db`, ID `d709e702-17f6-4107-ad45-060f2b24dc89`, primary region WEUR.
- Remote migration applied successfully: 23 commands; readback confirmed five application tables, ten indexes, and six triggers.
- Worker: `meteorshop-stg-api`, version `2ab9878c-fec8-4a54-a4fd-5cca643731d9`.
- Staging URL: `https://meteorshop-stg-api.micke-ohlen.workers.dev`.
- `/health` returned `200`, `/ready` returned `200`, unknown and wrong-method routes returned fail-closed JSON `404` responses.
- Deployed bundle: 2.03 KiB / 0.89 KiB gzip; startup time reported as 5 ms.
- No tenant, shop, product, customer, payment, or other business records were seeded.

An initially added fake `preview_database_id` made the dry run report a local-only binding. It was removed before deployment; the reviewed bundle and live Worker bind the real staging D1 database.

## Checkpoint 4 — Identity and authorization foundation

- Pinned Better Auth `1.6.29`, the current stable release verified from npm on 2026-08-16; dependency audit reports zero known vulnerabilities.
- Selected Better Auth's native D1 adapter and generated its core schema from the pinned application configuration.
- Added `0002_auth_identity.sql` with the generated `user`, `session`, `account`, `verification`, and database-backed `rateLimit` tables.
- Kept authorization out of cookie claims: `identity_access`, `tenant_memberships`, and `print_memberships` are live D1 authority records.
- Preserved one account-kind boundary (`ordinary`, `tenant_admin`, `platform_admin`, or `print_operator`) and explicit multi-tenant print assignments.
- Added email/password configuration with session revocation on password reset, database-backed rate limiting, no session cookie cache, and explicit trusted origins.
- Did not mount `/api/auth/*`, create a remote auth secret, seed users, or deploy identity routes. This keeps staging sign-up closed until tenant provisioning, verification/reset email, and live guards are complete.
- Local gate passed: generated types current, TypeScript clean, 13/13 Workers/D1 tests green, and Better Auth reports no pending schema tables or columns after migrations.
- Remote migration `0002_auth_identity.sql` applied to `meteorshop-stg-db`: 20 commands completed successfully.
- Remote readback from the WEUR primary confirmed all eight identity/authorization tables, both tenant-immutability triggers, both recorded migrations, and exactly zero user rows.

## Checkpoint 5 — Tenant resolution and live authorization

- Added hostname-only tenant resolution from the request URL. Client `shopId`, `X-Shop-Id`, and forwarded-host values are not authority.
- Resolver returns only a verified domain joined to an active tenant and otherwise fails closed.
- Added live D1 guards for platform admins, tenant admins, and print operators.
- Tenant-admin access requires an active account-kind record, active same-tenant admin membership, and active tenant.
- Print access requires an active print-operator record plus an explicit active assignment for the requested tenant; multi-shop assignments remain supported.
- Platform access requires a current active platform-admin record and is not inferred from tenant membership.
- Local gate passed: generated types current, TypeScript clean, 19/19 Workers/D1 tests green, including hostile tenant headers, unknown/pending/suspended domains, tenant-A-to-B attempts, live revocation, and print assignment scope.
- No new route was exposed and no staging deployment or remote data mutation was needed for this checkpoint.

## Checkpoint 6 — Session-to-live-principal bridge

- Added Better Auth session resolution from the incoming cookie/header set.
- Added request guards that combine a valid session with the live platform, tenant-admin, or print authorization query.
- Tenant-admin request authorization derives the tenant from the verified request hostname; callers cannot supply the privileged tenant context.
- Session cookie caching remains disabled, so Better Auth reads the current D1 session rather than treating a signed cookie snapshot as authorization.
- Added explicit server-side session revocation by user ID for demotion, suspension, tenant reassignment, and other privilege changes.
- Tests create real Better Auth email/password sessions against D1, then prove live access revocation, hostname-bound tenant authorization, session deletion, and anonymous denial.
- Local gate passed: generated types current, TypeScript clean, 23/23 Workers/D1 tests green.
- Auth HTTP routes remain unmounted and the remote staging Worker still has no `BETTER_AUTH_SECRET`; no public sign-up/sign-in surface was introduced.

### Checkpoint 6.1 — Verification identifier hardening

Better Auth defaults verification identifiers to plain storage. Password reset is still disabled/unmounted, but the configuration now explicitly selects hashed identifiers before any reset flow is wired. A configuration test prevents this from silently regressing; the full 23/23 test gate remains green.

## Checkpoint 7 — Auth email contract

- Cloudflare Email Sending account readback shows one existing enabled domain, `outpost.mohlenmedia.com`; it is unrelated and must not be reused or changed for MeteorShop.
- Cloudflare Email Sending is currently marked open beta by Wrangler. Build the provider behind an application contract and retain a rollback provider until a real MeteorShop domain canary passes.
- No domain onboarding, DNS edit, Email binding, Queue, recipient, or real send is authorized by this checkpoint.
- Added a versioned verification/reset Queue payload with strict recipient, expiry, purpose, HTTPS-origin, path, credential, and fragment validation.
- Operational metadata explicitly excludes the raw recipient and action capability; templates always produce both plain text and HTML.
- Added `0003_email_delivery_ledger.sql`. D1 stores only a normalized recipient hash and delivery/lease metadata—never a raw email address, action URL, token, or payload blob.
- Remote migration applied successfully to staging D1: seven commands. WEUR readback confirmed the table, three indexes, immutability trigger, exact non-sensitive columns, and zero delivery rows.
- Local gate passed: generated types current, TypeScript clean, 29/29 Workers/D1 tests green.

## Checkpoint 8 — Email delivery claim and lease state machine

- Added a SHA-256 fingerprint over the complete Queue job. Reusing a delivery ID with changed recipient, URL, tenant, purpose, locale, or expiry fails closed.
- Added atomic D1 insert/claim behavior with one lease winner under eight concurrent claim attempts.
- Added 60-second reclaimable leases, attempt accounting, due-time enforcement, lease-owned completion, bounded retry, redacted error codes, and explicit expired/failed terminals.
- Hardened the crash edge: a worker that crashes on its final allowed attempt becomes terminal when the lease expires rather than remaining stuck in `processing`.
- Added `createdAt` to the versioned Queue contract so a capability can be recorded as expired without violating ledger history constraints; maximum lifetime is 24 hours.
- Added migration `0004_email_delivery_fingerprint.sql`; remote WEUR readback confirmed the fingerprint column and required-fingerprint trigger, all four migrations, and zero delivery rows.
- Local gate passed: generated types current, TypeScript clean, 35/35 Workers/D1 tests green.
- Known provider boundary: a crash after Cloudflare accepts a send but before D1 records success can still duplicate a later send unless the provider gains a supported idempotency key. The lease removes concurrent duplicates but cannot atomically join an external mail send to D1.

## Checkpoint 9 — Staging auth-email Queue

Planned staging resources for this checkpoint:

- Primary Queue: `meteorshop-stg-email-auth`
- Dead-letter Queue: `meteorshop-stg-email-auth-dlq`
- Retention: 86,400 seconds (the free-tier maximum and the contract's maximum capability lifetime)
- Producer binding: `AUTH_EMAIL_QUEUE`

No public producer route, Email Sending binding, domain/DNS change, or real message send is part of this checkpoint.

- Created primary Queue ID `6f77ddb4e3bb4fe08ce5638ab468eaea` and DLQ ID `06386088cd4443d9b6f22990e5b55f69` in the verified personal staging account.
- Configured `meteorshop-stg-api` as the sole producer and consumer for the primary Queue; the DLQ has no consumer and remains operator-visible.
- Added a fail-closed Queue handler that retries accidental messages after five minutes without inspecting or logging their body.
- Configured batches of 10, five-second batch timeout, two-way concurrency, eight Queue retries, and the named DLQ.
- Deployed staging Worker version `7099d7e1-4a18-4f12-baba-5d977c2b7a8f`; startup remains 4 ms and bundle is 2.50 KiB / 1.06 KiB gzip.
- Corrected `/ready` to require the latest schema migration (`0004_email_delivery_fingerprint.sql`), not only migration 0001. Live `/health` and `/ready` return 200; `/api/auth/sign-in/email` remains a fail-closed JSON 404.
- Local gate passed: generated Queue binding current, TypeScript clean, 36/36 tests green, and deployment dry-run shows only the expected staging Queue/D1/non-secret vars.
- No messages were enqueued, and no Email Sending binding, auth secret, or auth route exists.

## Checkpoint 10 — First tenant-bound read route (not deployed)

- Added `GET /v1/storefront` as the first business-facing Cloudflare route.
- Tenant context comes only from the verified active request hostname; hostile `X-Shop-Id` and forwarded-host headers are ignored.
- The repository query binds the resolved tenant ID and rechecks active status.
- Response fields are an explicit allowlist: storefront name, locale, and currency. Internal tenant ID, support email, and `settings_json` are not selected or serialized.
- Unknown hosts and wrong HTTP methods fail closed with JSON 404 responses.
- Local gate passed: generated bindings current, TypeScript clean, 39/39 Workers/D1 tests green, and deploy dry-run passed at 4.69 KiB / 1.62 KiB gzip.
- This checkpoint has **not** been deployed. The live staging Worker remains version `7099d7e1-4a18-4f12-baba-5d977c2b7a8f` from checkpoint 9.

## Checkpoint 11 — Catalogue foundation (not deployed, remote migration not applied)

- Built by an Opus subagent, line-by-line reviewed by Fable before commit.
- Added `0005_catalogue.sql`: `products`, `product_variants`, `product_publications` with tenant-immutability triggers, parent-tenant-consistency triggers (variant/publication tenant must match product tenant, verified against SQLite trigger firing order), `product_id` immutability/re-point guards, `(tenant_id, sku)` uniqueness, non-negative price and 0/1 boolean CHECKs, `published => published_at` CHECK, and operational indexes.
- Added `src/catalog/public-catalog.ts`: tenant-context-required reads with explicit column allowlists. Public list/detail select only publication name/description/price/currency plus product `sku`; `internal_json` and `b2c_price_minor` are never selected. Detail includes active variants (id, sku, label, price) with the tenant bound on every query side.
- Added `GET /v1/products` and `GET /v1/products/{productId}`: hostname-only tenancy, strict single-segment path parsing with safe percent-decoding, fail-closed JSON 404s for unknown host, foreign-tenant IDs, drafts, archived, unpublished, malformed paths, and wrong methods.
- `/ready` now requires `0005_catalogue.sql`.
- Local gate: types current, TypeScript clean, 61/61 Workers/D1 tests green (21 new adversarial catalogue tests incl. cross-tenant re-homing/re-pointing and leak sentinels), deploy dry-run 8.40 KiB / 2.39 KiB gzip.
- **Not deployed and remote migration not applied**: this session's tool permissions block `wrangler deploy` and remote D1 commands. The live staging Worker remains version `7099d7e1` (checkpoint 9) and staging D1 remains at migration 0004. Before or at the next deploy: apply `0005_catalogue.sql` remotely first, then deploy (deploy without the migration leaves `/ready` correctly reporting 503 migration_required).

## Checkpoint 12 — Tenant-admin catalogue write path (not deployed)

- Built by an Opus subagent, reviewed line-by-line by Fable; the builder also mutation-tested the three security-critical tests (CSRF stub, projection-unpublish clause, tenant binding) and each failed for the right reason.
- Added `src/catalog/admin-catalog.ts`: strict allowlist parsers (unknown keys rejected, integer minor-unit prices, 3-letter currency, bounded lengths) and `create`/`update`/`publish`/`unpublish` operations. Every mutation is one `db.batch` that also appends its `audit_events` row (metadata records changed field names only, never values).
- Publication projection is server-maintained: PATCH refreshes a published projection from the canonical row in the same batch and increments `projection_version`; a status change away from `active` forces `published = 0`; publish requires `status = 'active'` (409 otherwise) and upserts via `ON CONFLICT`; unpublish is idempotent.
- Routes `POST /v1/admin/products`, `PATCH /v1/admin/products/{id}`, `POST .../publish`, `POST .../unpublish` in `src/index.ts`. Guard order: `authorizeTenantAdminRequest` (live D1 session + membership + hostname tenant) AND strict same-origin `Origin` check (`src/lib/same-origin.ts`) before any body parsing; failures are fail-closed 404 so the surface stays hidden. Validation failures are 400 without echoing input; unique-SKU collisions are bare 409s that leak no SQL text.
- Better Auth remains unmounted as an HTTP surface; tests drive `createAuth(env).handler()` directly to mint real sessions. Note: Better Auth's default sign-up rate bucket (3/10s shared when no client IP) required draining the `rateLimit` table between test fixtures — future suites with ≥4 fixture users will hit the same wall.
- Bundle grows to 1725 KiB / 300 KiB gzip because the admin routes pull Better Auth into the entry graph; local startup profile remains ~20 ms with no startup blocker.
- Local gate: types current, TypeScript clean, 102/102 tests green (41 new: lifecycle incl. projection refresh, anonymous/ordinary/foreign-admin/revoked denial with DB-unchanged assertions, missing/cross-site Origin, malformed bodies/paths, duplicate SKU in/across tenants, immutable audit rows).

## Checkpoint 13 — Platform tenant provisioning (not deployed)

- Built by an Opus subagent, reviewed line-by-line by Fable, including a Fable-run mutation test on the one-kind identity guard (weakening it failed exactly the two guard tests, then it was restored and the full gate re-ran green).
- Added `src/platform/provision-tenants.ts` + `POST /v1/platform/tenants`, `POST .../{tenantId}/domains`, `POST .../{tenantId}/suspend|activate`, `POST .../{tenantId}/admins`, guarded by `authorizePlatformRequest` AND strict same-origin check before any parsing; fail-closed 404s hide the surface.
- Strict parsers: tenant IDs `^[a-z0-9][a-z0-9-]*$` ≤64; hostnames normalized (lowercase, root dot stripped) then validated label-by-label ≤253 chars; locale/currency patterns; unknown body keys rejected.
- Tenant provisioning creates tenant + first storefront domain + audit row in one `db.batch`. Domains are created `verified` because **the platform operator is the verification authority at this stage** — a DNS proof-of-control checkpoint must downgrade the default to `pending` before self-serve domains.
- Admin grant enforces the one-account-kind boundary: existing `identity_access` of a different kind, or any non-active identity/membership → 409 (no silent re-enable); no existing row → plain INSERT (PK makes a racing grant fail loudly); duplicate active grant is idempotent. Suspension relies on live guards (resolver requires active tenant) and does not touch sessions.
- Local gate: types current, TypeScript clean, 157/157 tests green (55 new, incl. provision→storefront-resolves→suspend-404→activate-restores E2E and a granted admin exercising the checkpoint 12 write path), deploy dry-run 1740 KiB / 302 KiB gzip.

## Verification and research completed

- Read the complete Cloudflare platform, Wrangler, and Workers best-practices skills and their required review references.
- Retrieved current official Cloudflare Workers best practices, Wrangler configuration guidance, and Vitest integration guidance on 2026-08-15.
- Downloaded current `@cloudflare/workers-types` `5.20260815.1` into `/private/tmp` for API/type reference only.
- Confirmed local Node.js `v22.14.0` and npm `10.9.2`.
- Wrangler is intentionally installed locally in `cloudflare/`; no global installation is required.

## Checkpoint 2 verification

Run from `cloudflare/`:

- `npm run types` — passed; generated `worker-configuration.d.ts`.
- `npm run check` — passed: generated bindings current, TypeScript clean, 2/2 Workers-runtime tests passed.
- `npm run deploy:dry-run` — passed; 0.98 KiB bundle / 0.54 KiB gzip, staging vars only.
- `npm run startup` — passed; local profile window 21.0 ms, active 9.1 ms, no startup blocker.
- Dependency installation audit — 0 vulnerabilities reported.
- `git diff --check` — passed before handover refresh.

Wrangler/Vitest local analysis requires loopback access in the Codex sandbox and therefore was rerun with the approved narrow command prefixes. The generated `worker-startup.cpuprofile` is ignored and must not be committed.

## Next safe actions

1. Apply `0005_catalogue.sql` to `meteorshop-stg-db` remotely, then deploy checkpoints 10+11 to `meteorshop-stg-api` (both reviewed and accepted; blocked only on tool permissions — owner can run `npx wrangler d1 migrations apply meteorshop-stg-db --remote` then `npm run deploy:staging` from `cloudflare/`).
2. Smoke `/health`, `/ready`, unknown-host `/v1/storefront` and `/v1/products`, and confirm `/api/auth/*` remains 404.
3. Decide whether to mount sign-in only before sign-up; do not enable either until a staging secret and provisioning policy are in place.
4. Onboard a MeteorShop sending domain only at the explicit DNS/provider canary checkpoint; the unrelated existing domain stays untouched.
5. Create R2 buckets only when their object ownership contracts and local tests are ready.
6. Keep Firebase as the sole production side-effect owner throughout these staging waves.

## Known blockers and approvals

- No implementation blocker at this checkpoint.
- Wrangler is authenticated through its local credential store. Re-run `wrangler whoami` before each new remote resource group or if the session/account changes.
- The production account, DNS zone, Cloudflare Email onboarding, Stripe webhook cutover, and secret entry remain later owner checkpoints.

## Recovery if the current agent stops unexpectedly

1. Run `git status --short` and confirm branch `cloudflare-migration`.
2. Do not discard uncommitted files under `cloudflare/` or `docs/`.
3. Read the files listed above and compare `git diff` against the last pushed checkpoint shown near the top.
4. Re-run `npm run check` from `cloudflare/` before modifying bindings or migrations.
5. The user has approved routine migration commands, staging resources, non-production deploys, commits, and pushes. Still stop for production DNS/traffic cutover, live Stripe side-effect switching, destructive deletion, or secret values only the user can supply.
