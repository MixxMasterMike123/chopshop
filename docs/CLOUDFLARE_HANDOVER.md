# Cloudflare migration handover

**Last updated:** 2026-08-22, checkpoint 25 deployed dark (webhook awaits owner's Stripe endpoint + STRIPE_WEBHOOK_SECRET) — Fable orchestrating, Opus building, Fable reviewing
**Owner:** Codex/SOL started; Fable continuation run
**Continuation:** Fable or another agent should read this file, `CLOUDFLARE_MIGRATION.md`, and the three companion migration documents before changing code or infrastructure.

## Current repository state

- Branch: `cloudflare-migration`
- Remote: `origin/cloudflare-migration`
- Latest implementation checkpoint: checkpoint 25 — Stripe webhook → orders → discount burn, deployed dark (see below)
- Staging bootstrap has RUN: one platform admin exists (owner's identity); the bootstrap route is permanently dead (verified 404 on replay; D1 readback: 1 user / 1 active platform_admin / 1 audit row).
- Base application revision: `019a0b7` — `Harden checkout and print production pipeline`
- Production Firebase remains live and untouched by this migration run.
- Staging resources in the personal Cloudflare account: D1 `meteorshop-stg-db` (migrations 0001–0011), Worker `meteorshop-stg-api`, auth-email Queue + DLQ, R2 buckets `meteorshop-stg-public` / `meteorshop-stg-private` / `meteorshop-stg-temp`, secret `BETTER_AUTH_SECRET`.
- No **production** resources, DNS records, custom routes, Containers, Stripe endpoints, or email integrations have been created.
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
- Deployed 2026-08-16 (see checkpoint 13.1 below) after the owner added Bash permission rules for `wrangler deploy` and `wrangler d1 migrations apply meteorshop-stg-db` to `.claude/settings.local.json`.

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

## Checkpoint 13.1 — Staging deployment of checkpoints 10–13 + fail-closed auth fix

- Remote migration `0005_catalogue.sql` applied to `meteorshop-stg-db` (17 commands). WEUR readback confirmed the 3 catalogue tables, 3 indexes, and all 9 triggers.
- First deploy (version `369b60ad`) exposed a defect the local gate could not catch: `POST /v1/admin/products` and `POST /v1/platform/tenants` returned Cloudflare error 1101 (worker exception) because `createAuth` read `env.BETTER_AUTH_SECRET.length` and the secret binding does not exist in staging yet, while vitest always injects a test secret.
- Fix `ec36930`: `Env.BETTER_AUTH_SECRET` is now typed `string | undefined`; new `isAuthConfigured(env)` gate; `resolveSessionIdentity` returns null (anonymous, fail-closed) when the secret is missing or shorter than 32 chars; `createAuth` stays strict and still throws so a future mounted auth surface cannot run misconfigured. Six regression tests cover missing/short secret at the identity, guard, and route levels (163/163 total).
- Redeployed as version `8b01035c` (startup 46 ms, expected bindings only). Live smoke suite green: `/health` 200; `/ready` 200 reporting `0005_catalogue.sql`; unknown-host `/v1/storefront`, `/v1/products`, `/v1/products/{id}` all fail-closed JSON 404; `/api/auth/*` 404; anonymous `POST /v1/admin/products`, `PATCH /v1/admin/products/{id}`, `POST /v1/platform/tenants`, `POST /v1/platform/tenants/{id}/admins` all fail-closed JSON 404 (no more 1101).
- The live staging Worker is now version `8b01035c` from `ec36930`; staging D1 is at migration 0005.

## Checkpoint 14 — Sign-in-only auth HTTP surface (mounted, dark until secret exists)

- Decision executed: sign-in mounted, sign-up NOT mounted — accounts arrive via invitation/provisioning flows; public registration stays closed.
- `src/auth/auth-routes.ts`: the `/api/auth/*` namespace fails closed 404 in full when `BETTER_AUTH_SECRET` is unconfigured; when configured, an exact-match allowlist admits only `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`, `GET /api/auth/get-session` to the Better Auth handler. Everything else (sign-up, reset, verification, social) is 404.
- Better Auth's own `trustedOrigins` CSRF enforcement was **verified by probe, not assumed**: hostile-origin sign-in returns 403 `INVALID_ORIGIN` with no cookie; the test pins that exact status. Probe also exposed that no-Origin sign-ins share a rate bucket (429), which would have made loose "not 200" assertions pass vacuously — negative tests assert exact statuses instead.
- Builder mutation-verified the suite (sign-up added to allowlist, prefix matching, unconfigured guard removed — each broke the right tests).
- Local gate: 181/181 tests green. Deployed to staging: live `/api/auth/sign-in/email` still fail-closed 404 because the staging secret intentionally does not exist yet. **To open sign-in: owner runs `npx wrangler secret put BETTER_AUTH_SECRET` (32+ chars) in `cloudflare/` — note `wrangler secret` is not in the current permission allowlist.**

## Checkpoint 15 — R2 object ownership contracts (deployed; buckets NOT yet created)

- `0006_object_store.sql`: `stored_objects` — the canonical D1 ownership record for every future R2 object. R2 keys are never authorization; delivery resolves the row first. Applied to staging D1 (8 commands).
- Key containment CHECK uses byte-exact `substr()` comparison, NOT `LIKE` — the builder proved computed-pattern LIKE is unsound as a containment invariant (`_` wildcard: tenant `a_b` would accept `shops/axb/…`; ASCII case-insensitivity: tenant `abc` would accept `shops/ABC/…`).
- Freeze semantics: `immutable = 1` rows can be metadata-touched but never re-pointed, re-hashed, tombstoned, or unfrozen (two triggers). Status machine `pending → active → deleted(soft)`; pending objects are not deliverable.
- `src/storage/object-store.ts`: reserve (versioned keys `shops/{tenant}/{kind}/{id}/v1/{safeName}`, kind→bucket 1:1 map), activate (validated size/sha256), freeze, authorized-get (D1 row is sole authority), soft-delete, and `deliverPrivateObject` which fails closed when the row isn't private/active or the `PRIVATE_BUCKET` binding is absent. Binding exists ONLY in vitest/miniflare; `wrangler.jsonc` untouched, deploy dry-run confirms no R2 binding.
- Fable review finding: the content-type validator contained literal invisible control bytes (`\x00`,`\x1f`,`\x7f`) inside a regex class — functionally near-correct but unreviewable (it rendered as `[ -]`). Replaced with a visible RFC 7230 `type/subtype` token pattern + regression tests (hyphenated types accepted; parameters, spaces, CR/LF smuggling rejected). Control-byte scan of `src/` and `test/` is otherwise clean.
- `/ready` now requires `0006_object_store.sql`. Local gate 204/204 green.
- Next R2 step for the owner/agent: create `meteorshop-stg-public`, `meteorshop-stg-private`, `meteorshop-stg-temp` buckets, add the bindings to `wrangler.jsonc`, and build upload-grant/finalize + delivery routes on top of these contracts.

## Checkpoint 16 — Admin object upload + delivery routes (deployed; dark until buckets exist)

- Routes (all tenant-admin guarded + CSRF on state changes): `POST /v1/admin/objects` (reserve, private kinds only), `PUT /v1/admin/objects/{id}/content` (streamed upload), `GET .../{id}` (metadata, objectKey never exposed), `GET .../{id}/content` (authorized delivery, `no-store` + `nosniff`), `DELETE .../{id}` (tombstone row first, then bytes — a failed R2 delete leaves unreachable garbage, never a live object without a record).
- Integrity model: client declares sha256+size at reserve; the declared hash is handed to `R2Bucket.put` as the expected checksum so **R2 itself verifies the bytes** — probed in miniflare: mismatch throws and stores nothing, row stays `pending` and retryable. Bytes stream through the isolate unbuffered; 100 MB cap; Content-Length must match the declared size.
- Runtime quirk discovered: Workers synthesizes `content-length` for byte-backed request bodies; the absent-header branch is only reachable with a genuinely unknown-length stream (tests use `IdentityTransformStream`).
- All upload/delivery legs fail closed 404 while `PRIVATE_BUCKET` is undefined (current staging state); reserve/metadata are D1-only and work now. Deploy dry-run confirms no R2 binding.
- Local gate 242/242 green; control-byte source scan clean.
- When buckets are created: add the `PRIVATE_BUCKET` binding for `meteorshop-stg-private` to `wrangler.jsonc`, redeploy, and the upload path lights up with no code change.

## Checkpoint 17 — One-time platform bootstrap (deployed)

- `BETTER_AUTH_SECRET` was set by the owner on 2026-08-16; live sign-in verified (401 bad-creds, 403 hostile-origin, sign-up still 404, anonymous get-session null).
- `POST /v1/platform/bootstrap` mints the FIRST platform admin, then goes permanently dead: requires configured auth + `BOOTSTRAP_TOKEN` secret (≥32 chars) + matching `x-bootstrap-token` header (SHA-256-then-timingSafeEqual compare — hashing first is required, not optional: `timingSafeEqual` throws on unequal lengths, which would leak token length) + **zero existing `identity_access` platform_admin rows of ANY status** (a suspended admin still means bootstrap happened). Every failure is an indistinguishable 404; a 400 is only reachable after the token gate.
- Creates the user via Better Auth server API (`api.signUpEmail`), re-checks zero-admin, then INSERTs `identity_access` + audit row in one batch (PK makes a racing bootstrap lose loudly with 409; the loser's orphan user is privilege-less by construction and documented). No session cookie returned — admin signs in via the normal mounted route. Audit metadata carries no email.
- Type gotcha recorded: `crypto.subtle.timingSafeEqual` exists in workers-types but the tsconfig `WebWorker` lib shadows it; reached via a single-method cast with rationale comment.
- Gate 280/280 green; control-byte scan clean. Full loop proven in tests: bootstrap → sign-in through the worker → `POST /v1/platform/tenants` 201.
- Bootstrap procedure for the owner: `openssl rand -base64 48 | npx wrangler secret put BOOTSTRAP_TOKEN` (from `cloudflare/`), then one `POST /v1/platform/bootstrap` with header `x-bootstrap-token` and body `{email, password}`. Afterward the token secret can be deleted (`npx wrangler secret delete BOOTSTRAP_TOKEN`) — the route is dead either way once an admin exists.

## Checkpoint 18 — Server-authoritative checkout creation (deployed; no payment provider yet)

- First Wave-4/P2 slice: `POST /v1/checkout` (public, hostname tenancy) + `0007_checkout.sql` (`checkouts`, `checkout_items`).
- **The server is the only source of money**: requests carry only productId/variantId/quantity; sku/name/price/currency come from the tenant's published catalogue (same predicates as the public storefront query — nothing hidden is purchasable). Bodies containing price/sku/name keys are rejected outright by the strict allowlist. Variants must belong to the tenant AND the named product.
- Totals contract enforced in schema: `total = subtotal + shipping + vat - discount` CHECK, `line_total = quantity × unit_price` CHECK; shipping/vat/discount are 0 until their engines land. Item snapshots frozen by trigger; 9 triggers incl. product/variant tenant-match guards the FKs alone can't provide.
- **Idempotency**: caller key hashed as SHA-256(`tenant:key`), UNIQUE per tenant; insert-first, on collision compare freshly-resolved server lines (incl. name) against stored — match → replay (200, same checkout), mismatch (incl. price/name changed since) → 409, so a stale price is never silently honoured. Error-matching narrowed to the idempotency index by name.
- Builder ran an adversarial self-review that found and fixed 3 issues (missing product/variant tenant-match triggers, name missing from replay fingerprint, over-broad UNIQUE matching); Fable reviewed line-by-line after.
- Known accepted gaps for later checkpoints (documented in code): no rate limiting on this anonymous write (amplification ~50 D1 reads/request — must land before real traffic), line-resolution timing reveals resolve depth, no Turnstile, no shipping/VAT/discount, no PaymentIntent (nullable unique `payment_intent_id` column is the Stripe seam).
- Migration 0007 applied to staging D1; `/ready` requires it. Gate 356/356 green (76 new tests); deployed and smoke-tested live.

## Checkpoint 19 — Durable D1-backed rate limiting (deployed)

- `0008_rate_limits.sql`: `rate_limit_windows` (WITHOUT ROWID, PK scope/key_hash/window_start) — disposable operational data, deliberately no tenant/FK/immutability. Keys are SHA-256(`scope:key`); raw IPs/emails never reach D1 or logs.
- `src/lib/rate-limit.ts`: single-statement atomic upsert with `RETURNING count` (probed: works in D1 though undocumented — a null return throws rather than silently disabling the limiter), fixed windows, count ceiling, opportunistic bounded cleanup (`DELETE…LIMIT`, documented D1 support) on fresh windows, fail-closed on D1 errors. `clientIp` trusts only `CF-Connecting-IP`; missing header shares one stricter bucket.
- Builder caught a real production bug in its own first version: colo clock skew could drive `updated_at` backwards past the schema CHECK, turning the limiter into a 500 on the route it protects — fixed with `MAX(stored, excluded)` + skew regression test.
- Limits: checkout 10/min per IP (before body parsing) + 30/hour per email (after); over → 429 with `Retry-After`, message names no specific limit. Bootstrap: 5 per 10 min per IP, checked before the token compare, and over-limit returns the standard indistinguishable 404 (tested byte-identical, including with a CORRECT token — the limiter cannot be used as a token oracle).
- Migration 0008 applied to staging; `/ready` requires it. Gate 384/384 green; deployed and smoke-tested (429 verified live).

## Checkpoint 20 — Staging R2 buckets + PRIVATE_BUCKET binding (deployed)

- Created R2 buckets `meteorshop-stg-public`, `meteorshop-stg-private`, `meteorshop-stg-temp` in the verified personal staging account (location hint WEUR, matching D1; existence confirmed by `r2 bucket list` readback).
- Bound only `PRIVATE_BUCKET` → `meteorshop-stg-private` in `wrangler.jsonc`; the public/temp buckets stay unbound until code references them. Generated types now carry `PRIVATE_BUCKET: R2Bucket`, merging cleanly with the hand-written fail-closed `R2Bucket | undefined` contract in `src/env.d.ts` (comment updated: environments without buckets still fail closed).
- No code change was needed — exactly as checkpoint 16 designed, the upload/delivery path lit up on binding alone.
- Local gate 384/384 green; dry-run showed only the expected bindings plus the new R2 bucket. Deployed as version `899ceb15-5c0b-45f4-8582-d37610edf7d9`.
- Live smoke green: `/health` 200; `/ready` 200 at `0008_rate_limits.sql`; anonymous reserve/upload/delivery/delete on `/v1/admin/objects*` all fail-closed 404; sign-up 404; unknown-host storefront 404; anonymous checkout 404.
- Authenticated end-to-end upload smoke is still blocked on owner bootstrap: no platform admin exists in staging yet (`BOOTSTRAP_TOKEN` procedure in checkpoint 17), so no tenant/tenant-admin can be provisioned to exercise the live upload path.

## Checkpoint 21 — VAT-inclusive totals contract v2 + delivery method + shipping engine (deployed)

- Built by an Opus subagent, line-by-line reviewed by Fable; one review overrule (see weight parity below), commit `3f96401`, deployed as version `008f89a6`.
- **Money-semantics correction:** production prices are SEK VAT-INCLUSIVE (`functions/src/payment/createPaymentIntent.ts`: `total = subtotal − discount + shipping`, `vat = total − total/(1+rate)` derived/informational). 0007's CHECK `total = subtotal + shipping + vat − discount` was VAT-exclusive arithmetic that would double-count tax the moment a VAT engine landed. Migration `0009_checkout_totals_v2.sql` replaces it with `total = subtotal + shipping − discount`, `vat_minor` as contained VAT (`0 ≤ vat ≤ total`), `pickup ⇒ shipping = 0`, `delivery_method`/`shipping_country` (equivalence CHECK: pickup ⇔ no country), and frozen `vat_rate_bp` per row.
- **D1 migration facts probed, not assumed:** `PRAGMA defer_foreign_keys` does NOT persist across D1 statements (each runs in its own implicit transaction), so `DROP TABLE checkouts` fails under child FKs, and `legacy_alter_table=0` makes RENAME silently re-point the child's FK. The only sound recreate rebuilds BOTH tables: snapshot to staging copies → drop child, parent → create parent + copy → create child + copy → drop copies → re-declare all 9 triggers + 3 indexes. Structural tests prove the triggers survived and the child FK still names `checkouts`; remote WEUR readback after apply confirmed 9 triggers / 3 indexes / 0 rows.
- Also in 0009: `tenants.vat_rate_bp` (default 2500 = Swedish standard), `products.weight_grams` / `allow_shipping` (default 1) / `allow_pickup` (default 0) / `shipping_json`.
- **Shipping engine** (`src/commerce/shipping.ts`, pure integer): prod-parity term for term — region map (SE→sweden, DK/FI/NO→nordic, EU set→eu, else worldwide = most expensive), base tariff from the FIRST line's product for the region, fallback 2900/4900 minor, tiers `ceil((Σ(weight||10)×qty + 20g packaging)/50)`. The builder initially dropped the `+20 g`/`||10` constants claiming they only affected weightless baskets; Fable's review showed the packaging constant shifts EVERY basket's tier boundary (40 g: 2 tiers in prod, 1 without) — a systematic carriage undersell — and the exact prod math was restored. A basket therefore never ships free (floor 30 g = one tier).
- **VAT derivation**: exact remainder-based integer round-half-up (`q = ⌊total·10⁴/d⌋; net = q + (2r ≥ d)`), because the naive `(2·total·10⁴+d)/(2d)` intermediate leaves the safe-integer range within legal column bounds (differentially tested against exact rationals, 200k cases). Totals past `MAX_VAT_SAFE_TOTAL_MINOR` (~9.0e11) are refused as an opaque 422, never quoted imprecisely; carriage capped at 10,000,000 minor to keep products exact.
- **Eligibility is server-decided (P1-06 mirror):** pickup only when EVERY line's product allows it, shipping likewise; failure is the same opaque answer as an unresolvable line so the route is no oracle for collection eligibility.
- **Replay fingerprint extended:** delivery method, destination, freshly-recomputed carriage, and frozen VAT rate all pin the replay — a reused key after the merchant edits a shipping table/weight (across a tier boundary), a rate change, or a method switch is a 409, never a stale honored quote. total/vat deliberately not compared (pure functions of pinned fields).
- **Admin catalogue:** create/PATCH accept `weightGrams`, `allowShipping`, `allowPickup`, `shippingRates` (`{region:{cost}}` wire shape, unknown regions/keys rejected whole, explicit null clears, empty ≡ null, round-trip tested); canonical-product fields only, never projected. Audit rows carry field names only via the existing generic `Object.keys(input)`.
- Local gate 533/533 (149 new tests, incl. 7-case tier-boundary parity walk, migration-survival suite, VAT precision suite); mutation-tested guards (pickup `every`→`some`, fingerprint reversion, totals CHECK, packaging/default-weight constants — each broke exactly the right tests). Deployed and smoke-tested: `/ready` at 0009, all guarded surfaces fail-closed 404.
- Known accepted gaps (unchanged from 18 unless noted): discount engine (column live, hard-coded 0), Turnstile, PaymentIntent seam, checkout expiry sweep. Test-suite note: per-case email addresses are now needed in pricing suites — the 30/hour per-email rate limit otherwise turns extra tests into misleading 429s.

## Checkpoint 22 — Campaign discount engine (deployed)

- Built by an Opus subagent, line-by-line reviewed by Fable; commit `45d9cb2`, deployed as version `0eed0cc9`, migration `0010_discount_codes.sql` applied to staging.
- `discount_codes`: per-tenant UNIQUE uppercase codes (≤50 chars, prod's trim+uppercase normalization reproduced at the parse boundary), `fixed`/`percent` value XOR CHECK, inclusive `starts_at`/`ends_at` window, nullable `max_uses` + non-writable `used_count`, `min_spend_minor` compared against the FULL subtotal (prod parity, even for scoped codes), scope `all`/`products` with a loose JSON product-id list (deliberately NOT an FK join table — prod tolerates deleted products contributing 0 to the base). Percent stored as BASIS POINTS so fractional percents stay exact; math is `ceil(base×bp/10000)` via remainder decomposition because the naive product overflows 2^53 inside legal column bounds (differential + boundary tested; ceiling matches prod's client-parity-critical `Math.ceil`).
- **Probed D1 facts:** `ALTER TABLE ... ADD COLUMN` accepts AND enforces a multi-column CHECK on insert and update — `checkouts.discount_code_id` carries both `discount>0 ⇒ code id` and `discount ≤ subtotal` without recreating the table. `json_valid()`/`json_type()` work in CHECKs. Table-level CHECKs must follow all column defs.
- Checkout: optional `discountCode` (wrong shape = 400 decided pre-DB; well-formed unknown/ineligible = silently 0 — prod client parity AND no code-enumeration oracle). One extra D1 read only when a code is present; base computed from the already-resolved line snapshots. VAT derived from the discounted total (prod parity). Replay fingerprint pins BOTH `discount_minor` and `discount_code_id` (twin codes worth the same money must not misattribute usage). `used_count` increment is the PAYMENT checkpoint's job against the frozen code id; a zero-worth resolved code stores NO id (deliberate divergence: prod would freeze an id beside a 0 discount and let the webhook burn a use on nothing — judged a latent prod bug, not imported).
- Tenant-admin CRUD `/v1/admin/discount-codes` (POST create / GET / PATCH; activation is a PATCH field since it's one boolean on one row; GET is CSRF-exempt like the objects surface because same-origin GETs carry no Origin header — still behind the live session+membership guard). `used_count` absent from every allowlist. Audit rows field-names-only.
- Other explicit divergences/gaps: `percentBp` wire field (not prod's float `value` — future admin UI must convert); no tenant feature-flag gate yet (prod gates on the discountCodes add-on; all D1 tenants have the engine); no listing endpoint yet; `MAX_DISCOUNT_PRODUCT_IDS = 500` containment bound (prod has none); affiliate branch is a marked seam ABOVE the campaign lookup in `resolveDiscount` (prod checks affiliates first and they win collisions).
- **Test-fixture trap (record):** the shared `NOW = 1_787_200_000_000` constant sits days in the future of a real run; window fixtures anchored to it as `NOW ± DAY` can silently pass while testing nothing. Time-dependent suites must anchor to `Date.now()`.
- Local gate 646/646 (113 new); 15-mutation kill log (eligibility guards, scope base, fingerprint fields independently, uppercase normalization, clamps, tenant binding, PATCH coherence, zero-discount id rule — each caught by the right tests). Deployed and smoke-tested: `/ready` at 0010, all new surfaces fail-closed 404.

## Checkpoint 23 — Platform-provisioned users (deployed)

- Built by an Opus subagent, reviewed by Fable with one review finding that cascaded; commit `d87284e`, deployed as version `1a317c60`. No migration; `/ready` stays at 0010.
- `POST /v1/platform/users` (platform-guarded + CSRF before body parse, fail-closed 404): mints `tenant_admin` / `print_operator` identities via the Better Auth server API, then `identity_access` + audit row (account type only, never the email) in one batch. **`platform_admin` is deliberately NOT creatable over HTTP** — a hijacked platform session must not mint more of itself; raising that floor needs its own checkpoint with a second-factor story. Interim credential model: operator sets the initial password (mirrors prod's superadmin create-user flow minus the credentials email); the invitation flow supersedes it when Email Service lands. Password policy stays Better Auth's alone (probed: 8–128), mapped to opaque 400s.
- **Better Auth 1.6.29 facts probed:** error discrimination must use `body.code`, NOT `instanceof APIError` (the VALIDATION_ERROR branch throws from a different module instance). Duplicate email = `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (422), password codes 400.
- **Review finding (real, fixed):** `autoSignIn` defaulted TRUE — `signUpEmail` minted an orphan session row per provisioned user (probed: 1 row each, token discarded), bootstrap included. Now `autoSignIn: false` in `create-auth.ts`, pinned by a 6.1-style config regression test + zero-session assertions in bootstrap and provisioning suites; sign-in still mints exactly one session (probed by test).
- **Cascade finding:** under `autoSignIn: false`, Better Auth SWALLOWS duplicate sign-ups — returns success with a fabricated, never-persisted user id (two calls → two different ids, only the first is a row). Sound enumeration-hardening for public sign-up, but it made the thrown-duplicate branch unreachable and would have turned a duplicate provision into a FK-violation 500. Fixed with a duplicate pre-check (common case → clean 409; explicitly NOT a TOCTOU guarantee) + a persistence check on the returned id (raced case → 409); the throwing branch stays as defence in depth, and a test pins the swallowed-duplicate behaviour so a future upgrade fails loudly.
- Server-API `signUpEmail` bypasses Better Auth's rate limiter (probed: `rateLimit` table stays empty) — fixture draining applies only to handler-driven sign-ins. No limiter on this route, matching every platform surface: it sits behind a live platform session; abuse accounting is the audit trail's job.
- Mutation log: 8 mutations, one of which exposed a real test-suite gap (cross-origin denials all sent well-formed bodies, so moving the origin check after body parse leaked a 400 with the suite green — now pinned with malformed-body cross-site tests). The unreachable-over-HTTP batch-UNIQUE branch is flagged honestly as not fully kill-tested; the dangerous regression (silent account-kind conversion) is killed by 4 tests.
- Gate 702/702 (56 new). Deployed and smoked: anonymous `POST/GET /v1/platform/users` fail-closed 404.
- **Operator smoke scripts** (in `cloudflare/scripts/`, credentials prompted locally): `stg-smoke.sh` (platform basics: provision demo tenant bound to the workers.dev hostname, storefront resolution, suspend/activate gate, one-kind boundary) and `stg-e2e.sh` (full loop: provision tenant admin via checkpoint 23 → product with weight/carriage/pickup → activate+publish → discount code → R2 reserve/upload/download/delete → anonymous checkouts asserting EXACT engine money: 19900 subtotal / 5800 carriage (40g+20g pack, 2 tiers) / 1990 discount / 23710 total / 4742 VAT, pickup variant, and idempotent replay).

## Checkpoint 24 — Server-authoritative PaymentIntent creation (deployed; see 24.1 for the live fix)

- Built by an Opus subagent; awaiting Fable review. No migration — `payment_intent_id` has existed since 0007; `/ready` stays at `0010`. `wrangler.jsonc` untouched (secrets are bindings-invisible; dry-run confirms no new binding).
- `POST /v1/checkout/{checkoutId}/payment` — public/anonymous, hostname tenancy REQUIRED and the checkout row must belong to the resolved tenant. Platform-direct PI only; **Stripe Connect is a marked seam** in `stripe-client.ts` noting prod's "Marknadsplats" destination-charge model with NO `on_behalf_of` (moving the merchant of record would move the VAT liability).
- **New secret `STRIPE_SECRET_KEY`** follows the exact BETTER_AUTH_SECRET pattern: `string | undefined` in `src/env.d.ts`, `isStripeConfigured(env)`, and the ENTIRE surface answers fail-closed 404 while unconfigured — the gate runs before the method check, the path parse, D1, and even the rate limiter, so an unconfigured deploy is indistinguishable from a route that was never written. A present-but-garbage key is deliberately treated as CONFIGURED so it fails loudly as a 502 rather than making the route vanish and hiding a live misconfiguration.
- **Where the prod PI-fingerprint fix went (documented in code):** prod recomputes the cart on every call and needed a fingerprint to stop PI-per-keystroke and discount-after-PI desync. **The checkout IS that fingerprint here** — totals were frozen at creation, item snapshots are immutable by trigger, and the creation route's replay discipline already 409s a stale quote. This route reads **NO body at all** (a non-empty one is refused, checked via both `request.body` and `content-length`), recomputes nothing, and maps one checkout to exactly one intent forever. Applying a discount means creating a DIFFERENT checkout with its own intent.
- **One PI per checkout, forever:** Stripe idempotency key is deterministic (`checkout:{id}`) so racing calls reach the SAME intent at Stripe, then a guarded `UPDATE … WHERE checkout_id = ? AND payment_intent_id IS NULL` persists it; `changes === 0` means someone else attached, so the row is re-read and whatever is attached is served. Repeat calls RETRIEVE from Stripe and return the live `client_secret` — **the client secret is never stored in D1** (probed by test).
- **Terminal intents (`canceled`/`succeeded`) get the same opaque 404 as an expired checkout, and no second PI is minted.** Documented rationale: `payment_intent_id` is UNIQUE and occupied, so a replacement would either overwrite the link to an intent that may have MOVED MONEY or orphan one at Stripe — both are money-state forks, and a fork is strictly worse than a dead checkout. Terminal states are an allowlist of DEAD statuses, so a new Stripe intermediate status keeps working.
- **One opaque failure shape (404 `Checkout not found`) for unknown id / foreign tenant / expired / non-open status / terminal intent / bad path / wrong method** — deliberately not a 410 for expiry, because the checkout id is a bearer capability and distinguishing "never existed" from "yours but dead" confirms an id is real. Gateway failures are an opaque **502** carrying no Stripe text, code, request id, or account (`StripeGatewayError` carries no detail by construction; asserted by test that the response contains no `sk_test`/`API Key`/`req_…`/`stripe`).
- **Rate limit** (checkpoint-19 limiter, before any D1 or Stripe work): 20/min per IP — deliberately 2× checkout's 10/min because one buyer legitimately creates one checkout then polls its intent (reload, back-navigation, re-mounted payment element), while still tight because past the gate sits an outbound third-party call that is a cost/reputation vector against the platform's Stripe account.
- **PI metadata is `{checkout_id, tenant_id}` ONLY** — a deliberate divergence from prod, which reconstructs the order FROM metadata. The checkpoint-25 webhook will read the checkout row from D1, which is authoritative and CHECK-policed. Stripe metadata is not a PII store (dashboard-readable, exported, retained on Stripe's schedule).
- **Stripe SDK pinned `22.5.0` exact; `apiVersion` pinned `2026-07-29.dahlia`** (the SDK's own shipped version) in `STRIPE_API_VERSION`. **⚠️ CUTOVER ITEM: prod pins `2023-10-16` on the live account and its webhook endpoint** — the account/webhook version and this constant must be reconciled as ONE decision before cutover; a PI created under one version and read by a webhook pinned to another is exactly the drift that silently changes field shapes.
- **SDK-on-workerd probed, not assumed:** the package declares a dedicated `workerd` export condition whose entry initializes `WebPlatformFunctions`; a probe under vitest-pool-workers confirmed `Stripe.createFetchHttpClient()` dispatches through the runtime's fetch to `https://api.stripe.com/v1/payment_intents` carrying `Idempotency-Key` and `Stripe-Version` headers, plus error surfacing and retrieve. **No fallback REST client was needed.** `maxNetworkRetries: 0` — retries are the caller's business, since a silent SDK retry would race the guarded UPDATE.
- **Test seam:** Workers has no local Stripe to point at (unlike miniflare's real R2), so the gateway is injected through a **symbol-keyed** env property (`Symbol.for`) — it cannot collide with a binding name, cannot be set from `wrangler.jsonc`, and cannot arrive from outside the process, so the deployed path always builds the real client. The override is narrowed structurally rather than trusted. **No test touches real Stripe.**
- **Test-fixture trap (record):** the fake's intent ids first came from a PER-INSTANCE counter while the fake is rebuilt per test and D1 is not — every test got a fresh `pi_fake_1` and the second one to attach hit the UNIQUE column. 15 tests failed for that fixture defect, not a product one. Ids now come from a module-level counter.
- **Mutation log — 8 run, 8 killed, one of which exposed a REAL suite gap:**
  1. tenant binding dropped from the checkout lookup → killed by the foreign-tenant test.
  2. expiry check removed → killed by the expired-checkout test.
  3. `AND payment_intent_id IS NULL` dropped → **SURVIVED all 45 tests initially.** Because every race case used an idempotent gateway, both callers held the SAME intent and an unguarded write put back an identical value — invisible. Fixed by adding two cases driven by a deliberately NON-idempotent gateway (fresh intent per create), which isolates the guarded UPDATE as the sole defence against a different intent clobbering one that may already be confirming. Re-run: killed.
  4. no-body rule removed → killed by both body tests.
  5. unconfigured gate removed → killed by both unconfigured tests.
  6. terminal-status set emptied → killed by both terminal tests.
  7. `customer_email` added to PI metadata → killed by the exact-metadata tests.
  8. rate limiter moved AFTER the Stripe call → killed by the "before Stripe is touched" test.
- Local gate **747/747 green** (45 new). Control-byte scan clean on all touched files. `npm audit` on `stripe@22.5.0`: **0 vulnerabilities**. Dry-run **1826.87 → 2502.73 KiB (+675.86; gzip 319.85 → 397.88, +78.03)**; startup active 46 ms → **64.3 ms**, no startup blocker. Bindings list unchanged.
- **To light this up in staging:** owner runs `npx wrangler secret put STRIPE_SECRET_KEY` (a **TEST-MODE** key) from `cloudflare/`. No code change, no config change, no redeploy of config — the surface is dark until then.

## Checkpoint 24.1 — Edge-normalization fix: payment route live-verified (deployed 2026-08-22)

- Checkpoint 24 was committed as `7adccef` and deployed (version `00c9491b`); live smoke then found the route 404'ing every legitimate bodyless POST while all local tests stayed green. **Root cause:** Cloudflare's edge normalizes ordinary bodyless POSTs (curl, fetch over HTTP/2) by stamping `Content-Length: 0`, and the deployed no-body check treated any Content-Length header as a body declaration. Local Request objects are built without edge normalization, so no local gate can catch this class — only live smoke can.
- **Fix (`0925796`):** a declared `Content-Length: 0` is accepted as the authoritative "no body"; a non-zero declared length still refuses, and an absent length with a present stream (chunked) still refuses. Three regression tests pin the accepted and refused shapes.
- **Test time bombs defused (`0f39df2`):** two tests (provision-tenants "never leaks internal tenant columns", object-routes "refuses to delete a frozen object") wrote their file's frozen `NOW` constant into `updated_at` of rows the live routes had created with the real clock; once the real date overtook the constants (2026-08-21/22), `CHECK (updated_at >= created_at)` began failing. Those two write sites now use the real clock. `rate-limit.test.ts`'s still-future `NOW` (`1_787_500_000_000`, passes 2026-08-23) was audited and is safe: it injects `NOW` as the limiter's own clock and seeds self-consistent `NOW, NOW` pairs. **Pattern for future fixtures:** never mix a frozen test clock into rows the routes created with the real clock.
- Full gate green: types current, TypeScript clean, **749/749** tests. Deployed as version `ac1a0f05-9bea-454f-a57f-a1f612f434ce`.
- **Live smoke 9/9 (anonymous, no credentials needed):** published product → fresh pickup checkout → bodyless POST minted the **first real test-mode PaymentIntent** (`pi_3U7JGuKAaBMOW5AC0UQYvjiI`, client secret matching), repeat call answered 200 with the **same** intent id (same-PI idempotency proven live), non-empty body still 404, unknown checkout still opaque 404. Smoke script shape preserved in this checkpoint's session; it reuses the stg-e2e catalogue, so it needs no sign-in.
- **Next: checkpoint 25 — Stripe webhook → orders → discount `used_count` increment** (the frozen `discount_code_id` on the checkout row is the seam; the webhook reads the checkout from D1, never from PI metadata).

## Checkpoint 25 — Stripe webhook → durable orders → discount burn (DEPLOYED DARK 2026-08-22; awaiting owner Stripe endpoint + secret)

- Built by an Opus subagent, Fable-reviewed line-by-line, committed `b27481a`. Migration `0011_orders.sql` **applied to staging D1** (28 statements) and the worker **deployed as version `5d9cdeec-92ea-4625-bcdb-091740bfccf8`**. Dark smoke green: `/ready` reports `0011_orders.sql`, the webhook surface answers fail-closed 404 in every shape (unsigned, signed-looking, GET, sub-path), and the checkpoint-24 payment smoke re-ran 9/9 (fresh PI + same-PI idempotency).
- New route `POST /v1/webhooks/stripe` — **platform-level, not tenant-bound**. Stripe is configured with ONE endpoint URL per account and calls it for every event regardless of storefront, so there is no hostname to resolve a tenant from. The tenant comes from the `checkouts` row the PaymentIntent id finds. Grouped under `/v1/webhooks` rather than `/v1/platform` deliberately: every other `/v1/platform` route requires a live platform session, and this one has no session at all. Exact-match path only — no prefix, so `/v1/webhooks/stripe/anything` is an ordinary 404.
- **New secret `STRIPE_WEBHOOK_SECRET`** follows the exact BETTER_AUTH_SECRET / STRIPE_SECRET_KEY pattern: `string | undefined` in `src/env.d.ts`, `isStripeWebhookConfigured(env)`, and the ENTIRE surface answers fail-closed 404 while unconfigured — the gate runs before the method check, before the body is read, before D1. **Both** secrets are required (signing secret AND API key): a worker that could record payments but could not have created them is a misconfiguration worth failing closed on. A present-but-garbage secret is deliberately CONFIGURED so it fails loudly as a 400 rather than making the route vanish and hiding a live misconfiguration.
- **Signature verification is the only authentication, and it is sufficient**: it proves the caller holds a secret only Stripe and this worker have. No session, no same-origin check, no tenant hostname — each absence is a consequence of who the caller is, not a gap. Raw body read with `request.text()` **before** anything parses it; the signature covers the exact bytes sent.

### Probed, not assumed (stripe 22.5.0 under vitest-pool-workers)

- **`constructEventAsync` is mandatory on workerd.** The synchronous `constructEvent` throws `"SubtleCryptoProvider cannot be used in a synchronous context"` — Web Crypto's digest is promise-returning and the SDK has no synchronous fallback in a Worker. **Production calls the synchronous form**, which works only because it runs on Node.
- `generateTestHeaderStringAsync` works under workerd and emits `t={unix},v1={hex}`. The webhook suite signs with it and lets the **real** `constructEventAsync` verify — verification is never stubbed out.
- A bad signature throws `StripeSignatureVerificationError`, but its `.name` is plain `"Error"` — discriminate by constructor/`instanceof`, **not** by name.
- `DEFAULT_TOLERANCE` is 300 s and **is enforced**: an old timestamp is rejected with `"Timestamp outside the tolerance zone"`. That is real replay protection ahead of the event ledger.

### Migration 0011 — `orders`, `order_items`, `order_status_history`, `payment_events`

- `orders`: `UNIQUE checkout_id` and `UNIQUE payment_intent_id` are the structural half of idempotency — one checkout, one order, forever, even if the application logic were wrong. `UNIQUE (tenant_id, order_number)` is real, unlike prod which generates `PREFIX-{last 6 epoch digits}-{4 random base36}` with **no uniqueness check** against a wrapping (~16.7 min) timestamp.
- Every 0009/0010 money CHECK is **restated** on `orders` (v2 totals `total = subtotal + shipping − discount`, VAT contained, pickup ⇒ no carriage, discount ≤ subtotal, discount>0 ⇒ code id) so an order can never hold arithmetic a checkout could not. `orders_money_immutable` freezes the entire financial identity; `status`, `refunded_total_minor` and `updated_at` are deliberately excluded as the fields the lifecycle moves.
- `orders_tenant_matches_checkout_insert/update` closes the same gap `checkout_items` closes against `products`: the FK points at a global PK and is satisfied by ANY tenant's checkout.
- **Refunds are not built, but the shape does not preclude them**: `status` already admits `partially_refunded`/`refunded`, `captured_minor` is stored separately from `total_minor` (a later partial capture must not need a migration), and `refunded_total_minor` is a CUMULATIVE ABSOLUTE column capped at `captured_minor` — matching prod's `refundedTotalSek`, which is absolute precisely so a replayed refund converges instead of double-counting. Neither column is writable by this checkpoint.
- `payment_events` (event ledger, append-only, `event_id` PRIMARY KEY, nullable `tenant_id`): records **every** delivery including ones that produced no order, with an enumerated `outcome` (`processed`/`ignored`/`rejected`) and `reason_code`. Never provider text, never a payload excerpt. **Production has no such table** — its idempotency is entirely "order doc id IS the PaymentIntent id", so deliveries that produce no order are invisible and "Stripe says it delivered, we have nothing" is unanswerable.

### Deliberate divergences from production (all documented in code)

1. **The checkout row is authoritative; PI metadata is NOT.** Prod reconstructs the whole order from metadata (`customerEmail`, `itemDetails` chunked across keys because Stripe caps each value at 500 chars, `subtotal`, `vat`, ...). Checkpoint 24 put only `{checkout_id, tenant_id}` in metadata precisely so this handler has nothing to be tempted by. Metadata is compared as a **consistency assertion** and a mismatch is a refusal — never a lookup.
2. **Amount mismatch REFUSES; prod overwrites.** Prod compares with a 0.1 SEK tolerance and on mismatch **stamps the charged amount as the order total**, leaving subtotal/vat/shipping untouched so the breakdown no longer sums — an order whose own arithmetic is inconsistent, which this schema could not store anyway. Here: no order, no burn, a `rejected` ledger row. Compared as integers, same minor units, **no tolerance** (the amount was sent to Stripe FROM this row; neither side rounds). The charge still exists at Stripe and is refundable from the dashboard, which is the right place to resolve a payment nobody can explain.
3. **Never 4xx a validly-signed event.** Prod returns **400** for missing/unparseable metadata — Stripe treats 4xx as failure and retries for days, then gives up silently, leaving a **charged buyer with no order and no alert**. Past verification this handler answers 200 to everything it understands. The only non-2xx are 400 (signature) and 500 (D1 fault, genuinely retryable).
4. **One `db.batch`, or nothing.** Order + lines + status history + checkout transition + `used_count` burn + audit row + ledger row commit together. Prod does `orderRef.create()` then four independent best-effort writes; a crash between the create and the increment loses the burn **permanently**, because the retry short-circuits at the existing-order check and nothing reconciles the counter.
5. **`used_count` burns against the frozen `discount_code_id` only** — checkpoint 22's rule kept: a resolved-but-worthless code stored NO id, so no use is burned. Prod would freeze an id beside a 0 discount and burn a use on nothing.
6. **`max_uses` is deliberately NOT re-checked at burn time** (prod parity, and correct): eligibility was decided at quote time, and refusing to count now would leave a paid order whose discount is unaccounted for. Over-redemption when several buyers hold client secrets is a merchant problem; an unrecorded redemption is an accounting one.
7. **Order status is `paid`, not prod's `confirmed`** — the data model's vocabulary, so a later fulfilment checkpoint can add `processing`/`printed` without the first transition being ambiguous.
8. **Order numbers** are `YYYYMMDD-{8 Crockford chars}` from `crypto.getRandomValues` behind a real UNIQUE constraint (no I/L/O/U — these get read aloud). Prod's has ~1.7M effective space and no collision check.
9. **Expiry is NOT checked on this path.** An intent can succeed after the quote lapsed (the buyer held a client secret; Stripe never heard about the expiry). The money is real, so the order is created at the frozen total. Refusing would leave a paid buyer with nothing.
10. **`payment_intent.payment_failed` is a documented no-op seam.** Prod marks the checkout doc `failed`, and the purpose is the *opposite* of what the name suggests — it stops the abandoned-cart sweep from mailing a buyer whose card was declined. There is no sweep and no abandoned-cart email here yet, so writing a status nothing reads would be noise. One-line addition when the sweep lands.

### Rate limiting — considered, deliberately omitted (documented in the route)

The checkpoint-19 limiter keys on `CF-Connecting-IP`, and Stripe delivers from a small pool of its own addresses: every legitimate event for every tenant arrives from those few IPs. Any limit tight enough to matter would throttle real payment notifications — the class of request this platform can least afford to drop — and a loose one stops nothing. Worse, **a 429 to Stripe is a retry signal**, so throttling a flood converts it into a sustained retry storm. What actually bounds an attacker is the signature check, which runs before any D1 work: an unsigned flood costs one HMAC each and touches nothing; a *signed* flood is Stripe itself, and the ledger makes every event idempotent. If volume ever needs shaping it belongs at the edge (WAF rate rules on this path), not in a D1 write added to every payment notification.

### Mutation log — 11 run, 9 killed, 1 equivalent, 3 real suite gaps found and closed

| # | Mutation | Result |
|---|---|---|
| 1 | Drop signature verification entirely (bare `JSON.parse`) | **KILLED** — 5 tests |
| 2 | Drop the ledger replay READ | **EQUIVALENT MUTANT** — see below |
| 3 | Drop event-ledger idempotency entirely (read + insert + `recordOnly` write) | **KILLED** — 19 tests |
| 4 | Drop the amount/currency check | **KILLED** — 3 tests |
| 5 | Replace `db.batch` with a sequential loop (original order) | **SURVIVED**, then analysed — see below |
| 5b | Sequential loop with side effects BEFORE the order insert (prod's shape) | **KILLED** — 25 tests, incl. the new atomicity test |
| 6 | Drop the `discount_code_id !== null` guard | Survived, but **benign**: `WHERE col = NULL` matches nothing in SQL |
| 6b | Drop frozen-id scoping on the burn (`WHERE tenant_id = ?` only) | **SURVIVED → gap found → new test → KILLED** |
| 7 | File the order under the METADATA's tenant instead of the checkout's | **KILLED** — 1 test (schema trigger would also have caught it) |
| 8 | Drop the metadata consistency assertion | **KILLED** — 3 tests |
| 9 | Drop the checkout-status guard | **KILLED** — 1 test |
| 10 | Drop the unconfigured fail-closed gate | **KILLED** — 3 tests |
| 11 | Parse-then-reserialize the body before verifying (raw-body bug) | **SURVIVED → gap found → new test → KILLED** |

**Three findings worth recording:**

- **#2 is an honest equivalent mutant.** Removing the ledger read left all 63 tests green because every write path is *also* protected by a UNIQUE constraint, so a duplicate simply fails the batch atomically and the answer is identical. The read is therefore a genuine fast path, not the correctness mechanism — correctness is carried by the constraints. A test was added anyway pinning that a replay reports the ORIGINAL outcome from the ledger rather than re-deciding on current state; it does not kill #2 (the constraints make the mutant behaviourally identical) and that is stated plainly rather than papered over. #3 is the mutation that tests the real mechanism, and it dies loudly.
- **#5 → #5b.** Plain sequentialisation survived only because the order INSERT happens to be the FIRST statement, so it fails before any side effect runs. The moment the ordering changes to production's shape (side effects first), 25 tests fail. A new atomicity test was added (two distinct event ids racing one intent, asserting exactly one order AND exactly one burn AND no orphaned lines/history).
- **#6b and #11 were real gaps.** The existing bystander test used a checkout with *no* discount, so the increment statement was never queued and the missing tenant/id scope was invisible — now covered by a case with a real burn beside two untouched campaigns. And every fixture payload was `JSON.stringify` output, so a reserialize round-trip was byte-identical — now covered by a pretty-printed payload with a trailing newline that no reserializer could reproduce.

### Gate

- `npm run check`: types current, TypeScript clean, **816/816 tests green** (67 new in `test/webhook.test.ts`; 749 → 816).
- `npm run deploy:dry-run`: **2516.51 KiB / gzip 400.61 KiB** (from 24's 2502.73 / 397.88 — only +13.78 KiB, since the Stripe SDK was already in the entry graph). **Bindings list unchanged** — secrets are bindings-invisible.
- `npm run startup`: profile window 94.6 ms, active **59.1 ms** (24 was 64.3 ms), no startup blocker.
- Control-byte scan (python, not grep) over all 10 touched files: **clean**.
- Two pre-existing `/ready` assertions bumped `0010_discount_codes.sql` → `0011_orders.sql` (`test/health.test.ts`, `test/public-catalog.test.ts`).

### Files

| File | Purpose |
|---|---|
| `cloudflare/migrations/0011_orders.sql` | **new** — `orders`, `order_items`, `order_status_history`, `payment_events` + triggers/indexes |
| `cloudflare/src/commerce/webhook.ts` | **new** — event handling, order creation, atomic batch, discount burn, order numbers |
| `cloudflare/test/webhook.test.ts` | **new** — 67 tests, real signature verification via the SDK's own signer |
| `cloudflare/src/commerce/stripe-client.ts` | + `VerifiedStripeEvent`, `StripeWebhookVerifier`, `StripeSignatureError`, `isStripeWebhookConfigured`, verifier + symbol override |
| `cloudflare/src/index.ts` | + `/v1/webhooks/stripe` route, `webhookSignatureFailureResponse`, `/ready` → 0011 |
| `cloudflare/src/env.d.ts` | + `STRIPE_WEBHOOK_SECRET: string \| undefined` |
| `cloudflare/vitest.config.ts` | + test-only `STRIPE_WEBHOOK_SECRET` binding |
| `cloudflare/test/env.d.ts` | + `STRIPE_WEBHOOK_SECRET: string` |
| `cloudflare/test/health.test.ts`, `cloudflare/test/public-catalog.test.ts` | `/ready` migration pin → 0011 |

### To light this up in staging (owner actions — migration and deploy are DONE)

1. **Create the Stripe webhook endpoint** in the **TEST-mode** dashboard, URL:
   `https://meteorshop-stg-api.micke-ohlen.workers.dev/v1/webhooks/stripe`
   Subscribe to **`payment_intent.succeeded`** only. (`payment_intent.payment_failed` may be added when the abandoned-cart sweep lands; anything else is acknowledged as a recorded no-op today.)
   ⚠️ Set the endpoint's **API version to match `STRIPE_API_VERSION` (`2026-07-29.dahlia`)** — see the cutover item below.
2. **Set the signing secret**: copy the endpoint's `whsec_...` and run
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET` from `cloudflare/`.
   The surface lights up on the secret alone — no code change, no redeploy.

### Smoke plan (staging, once the secret exists)

1. ✅ done dark: `/ready` reports `0011_orders.sql`; all webhook shapes 404 while unconfigured.
2. Unsigned `POST /v1/webhooks/stripe` → **400** with the constant opaque body (flips from 404 once configured); response contains no `stripe`/`whsec`/`sk_test`/`req_`.
3. `GET /v1/webhooks/stripe` and `POST /v1/webhooks/stripe/extra` → still **404**.
4. Full money loop with the existing `stg-e2e.sh` catalogue: create an anonymous checkout **with a discount code**, mint its PaymentIntent via checkpoint 24, then confirm the intent with a test card (`4242…`) so Stripe delivers a real `payment_intent.succeeded`.
5. Verify by D1 readback: exactly one `orders` row for the checkout with `status='paid'` and money matching the checkout exactly; `order_items` matching the frozen lines; one `order_status_history` row (`NULL → paid`); `checkouts.status='completed'`; the discount code's `used_count` incremented by exactly **1**; one `payment_events` row with `outcome='processed'`.
6. **Resend the same event from the Stripe dashboard** → 200, and re-verify that order count and `used_count` are **unchanged**.
7. Stripe dashboard endpoint health should show 200s throughout.

### Known gaps / next checkpoints

- No order **read** surface yet (admin list/detail, buyer lookup). `orders` is write-only from the webhook.
- No **order confirmation email** — the outbox/email path is a later checkpoint. Prod deliberately sends print notifications via an outbox trigger rather than from the webhook; copy the outbox pattern, not a direct send.
- **Refunds** unbuilt (columns and statuses exist). Prod drives refunds from a callable, never the webhook; `partially_refunded` is treated as production-ready for print notification there.
- **Connect** still platform-direct; the `transfer_data`/`application_fee_amount` seam remains in `stripe-client.ts`.
- No **production snapshot** (POD print graph) — prod builds one in the webhook transaction; that lands with the print domain.
- **⚠️ CUTOVER ITEM (unchanged from 24, now sharper):** prod pins `2023-10-16` on the live account **and on its webhook endpoint**, while this worker pins `2026-07-29.dahlia`. The account version, the webhook endpoint version, and `STRIPE_API_VERSION` must be reconciled as ONE decision before cutover — an intent created under one version and read by a webhook pinned to another is exactly the drift that silently changes field shapes.

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

1. ✅ **Full authenticated e2e VERIFIED LIVE 2026-08-16** (owner ran `stg-e2e.sh`): platform sign-in → demo tenant → checkpoint-23 tenant-admin provisioning → grant → product create/activate/publish → discount code → R2 reserve/upload/download-byte-identical/delete(204) → anonymous shipped checkout with EXACT engine money (19900/5800/1990/23710/4742) → pickup variant (0/17910/3582) → idempotent replay returning the same checkout. 28/28 after correcting the script's delete expectation to the designed 204. Staging tenant admin: tenant-admin@demo.invalid. Optionally `npx wrangler secret delete BOOTSTRAP_TOKEN` — the route is dead either way.
2. Continue Wave-4 checkout: the payment-provider seam (`payment_intent_id` + frozen `discount_code_id` are the Stripe seam; the payment checkpoint owns the atomic `used_count` increment). Stripe secrets remain owner actions.
3. Turnstile (or equivalent) on the anonymous checkout surface before any real traffic.
4. Onboard a MeteorShop sending domain only at the explicit DNS/provider canary checkpoint; the unrelated existing domain stays untouched.
5. Keep Firebase as the sole production side-effect owner throughout these staging waves.

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
