# Cloudflare migration handover

**Last updated:** 2026-08-16, checkpoint 3 ready to commit
**Owner:** Codex/SOL autonomous migration run
**Continuation:** Fable or another agent should read this file, `CLOUDFLARE_MIGRATION.md`, and the three companion migration documents before changing code or infrastructure.

## Current repository state

- Branch: `cloudflare-migration`
- Remote: `origin/cloudflare-migration`
- Last pushed commit: `0de5e79` — `chore: scaffold Cloudflare migration foundation`
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

1. Commit and push checkpoint 3 after the final local verification pass.
2. Verify and lock the current Better Auth version and its official Cloudflare D1 schema/migration workflow.
3. Add identity/session schema only through the supported auth tooling; do not invent password or session tables.
4. Implement the tenant resolver/repository boundary and prove two-tenant API isolation before porting a business route.
5. Create R2 buckets and Queues only when their contracts and local tests are ready.
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
