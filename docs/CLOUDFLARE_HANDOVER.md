# Cloudflare migration handover

**Last updated:** 2026-08-16, checkpoint 2 ready to commit
**Owner:** Codex/SOL autonomous migration run
**Continuation:** Fable or another agent should read this file, `CLOUDFLARE_MIGRATION.md`, and the three companion migration documents before changing code or infrastructure.

## Current repository state

- Branch: `cloudflare-migration`
- Remote: `origin/cloudflare-migration`
- Last pushed commit: `4a70cba` — `docs: plan Cloudflare migration`
- Base application revision: `019a0b7` — `Harden checkout and print production pipeline`
- Production Firebase remains live and untouched by this migration run.
- No Cloudflare resources, DNS records, secrets, routes, or deployments have been created.
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

No Cloudflare resource or deployment has been created.

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

1. Commit and push the documentation + validated local foundation as checkpoint 2.
2. Authenticate Wrangler against the personal staging account and verify the selected account identity.
3. Record the account name and non-secret account ID in an operations record; do not put credentials in Git.
4. Create and locally test the first D1 migration for identity/tenancy, idempotency, audit, and outbox foundations.
5. Add a D1 binding only after the migration and two-tenant adversarial tests pass locally.
6. Update this handover before every commit/push and before any remote resource creation.

## Known blockers and approvals

- No implementation blocker at this checkpoint.
- Browser-based `wrangler login` will require the user's Cloudflare session when remote staging setup begins. Authentication is not a deployment and must be followed by `wrangler whoami` before resource creation.
- The production account, DNS zone, Cloudflare Email onboarding, Stripe webhook cutover, and secret entry remain later owner checkpoints.

## Recovery if the current agent stops unexpectedly

1. Run `git status --short` and confirm branch `cloudflare-migration`.
2. Do not discard uncommitted files under `cloudflare/` or `docs/`.
3. Read the files listed above and compare `git diff` against the last pushed checkpoint shown near the top.
4. Re-run `npm run check` from `cloudflare/` before modifying bindings or migrations.
5. Do not run `wrangler deploy`, create remote resources, or touch DNS until the account identity is verified and the relevant checklist approval is satisfied.
