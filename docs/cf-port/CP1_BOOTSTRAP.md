# CP1-A bootstrap: Kent's account, env-aware config, preflight v2

Date: 2026-09-26 · builder: CP1-A (Opus) · plan: `PLAN.md` §2, §2.5, §6, §10 CP1 · decisions: D5, D5b, D7.

Every Cloudflare call below went through `scripts/cf-preflight.sh <env> --bootstrap -- …` (project token from `~/.config/chopshop/cloudflare.env`, account proven = `ee213082783ec86585150e876edb6107` on every call). The token never appears in any output. Nothing was deployed, no Worker secret was created, and nothing was written to production data.

## 1. Resources (all on Kent's account)

| env | kind | name | id | placement |
|---|---|---|---|---|
| staging | D1 | `chopshop-stg` | `d1162797-5a79-4a79-aef9-e5f7e1634fb1` | location hint `weur` (created in WEUR) |
| production | D1 | `chopshop-prod` | `d401576e-184d-47bd-b68b-c3c80785844b` | location hint `weur` (created in WEUR), **empty, no migrations** |
| staging | R2 | `chopshop-stg-public` | (named) | jurisdiction `eu` |
| staging | R2 | `chopshop-stg-private` | (named) | jurisdiction `eu` |
| staging | R2 | `chopshop-stg-production` | (named) | jurisdiction `eu` |
| production | R2 | `chopshop-prod-public` | (named) | jurisdiction `eu` |
| production | R2 | `chopshop-prod-private` | (named) | jurisdiction `eu` |
| production | R2 | `chopshop-prod-production` | (named) | jurisdiction `eu` |
| staging | Queue | `chopshop-stg-outbox` | `a0ff00a9726542c7b8bec4a8d3256966` | — |
| staging | Queue | `chopshop-stg-email` | `7171f5a3834449a2be24f49f72f89071` | — |
| staging | Queue | `chopshop-stg-render-jobs` | `3aa48c8298ee408caa55ac818549e754` | — |
| production | Queue | `chopshop-prod-outbox` | `26003504c574439097d3c480611ad9c9` | — |
| production | Queue | `chopshop-prod-email` | `1a9f57a967d849af91678e5b3e25345a` | — |
| production | Queue | `chopshop-prod-render-jobs` | `aebd425360a44632bd9f0779e21e3851` | — |

None of them existed beforehand, so nothing was reused. Queues use the default message retention. There are no dead-letter queues: D1 (`outbox_events`, `email_deliveries`) holds the durable record and a 15-minute cron sweeper re-nudges, so a DLQ would only hold a second copy that nobody reads.

### Defaults taken on the plan's behalf (veto here)

- **R2 jurisdiction `eu` on all six buckets (GDPR: objects are stored and processed in the EU only).** This cannot be changed once a bucket exists. To undo it, delete the empty buckets and recreate them without `--jurisdiction`. It has three consequences:
  1. Every R2 binding must carry `"jurisdiction": "eu"`. `wrangler.jsonc` does, and the preflight now refuses a binding without it.
  2. **The S3 endpoint for these buckets is `https://<account>.eu.r2.cloudflarestorage.com`.** `cloudflare/src/pod/render-farm-client.ts:377` builds `https://${accountId}.r2.cloudflarestorage.com`, so presigned URLs to `chopshop-*-private` would miss the bucket. **The src owner must fix this before the POD surface is used** (for example a var for the S3 endpoint, or the jurisdiction). `test/pod-artwork.test.ts:2037` asserts the old host. The farm's `.r2.cloudflarestorage.com` suffix check still matches the `.eu.` host.
  3. The R2 API token behind `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` must cover these EU buckets. Logpush cannot write to jurisdictional buckets.
- **D1: location hint `weur`, not a jurisdiction.** The CP1 brief specified `--location weur`. Wrangler 4.123 also supports `d1 create --jurisdiction eu`, which, like R2, guarantees EU-only storage and processing. A location hint does not guarantee that. It can only be chosen at creation. Both databases hold no business data (staging holds the schema only), so switching now means delete + recreate + re-pin the two ids. Mikael decides.

## 2. Account before and after

**Before** (via the preflight, `--env staging`; listings are account-wide):

```
d1 list                          → ai-content-hub (61582549-9c7d-4bf7-8c0d-b28b92a7b2fa)
r2 bucket list                   → ai-content-hub-media
r2 bucket list --jurisdiction eu → (none)
queues list                      → (none)
```

**After:**

```
d1 list                          → chopshop-prod (d401576e-…), chopshop-stg (d1162797-…), ai-content-hub (untouched)
r2 bucket list                   → ai-content-hub-media (untouched)
r2 bucket list --jurisdiction eu → chopshop-{stg,prod}-{public,private,production}
queues list                      → the six queues above (0 producers, 0 consumers each)
```

The unrelated `ai-content-hub*` resources were listed only, never touched.

## 3. Commands run (in order)

```sh
# local only
git archive cf-port cloudflare guard scripts/cf-preflight.sh scripts/cf-deploy.sh | tar -x   # see §8
(cd cloudflare && npm ci)

# wrangler.jsonc retargeted first (preflight step 4 refuses the old account id), then:
scripts/cf-preflight.sh staging --bootstrap -- whoami
scripts/cf-preflight.sh staging --bootstrap -- d1 list
scripts/cf-preflight.sh staging --bootstrap -- r2 bucket list
scripts/cf-preflight.sh staging --bootstrap -- r2 bucket list --jurisdiction eu
scripts/cf-preflight.sh staging --bootstrap -- queues list

scripts/cf-preflight.sh staging    --bootstrap -- d1 create chopshop-stg  --location weur --no-update-config
scripts/cf-preflight.sh production --bootstrap -- d1 create chopshop-prod --location weur --no-update-config
scripts/cf-preflight.sh staging    --bootstrap -- r2 bucket create chopshop-stg-{public,private,production} --jurisdiction eu --no-update-config   # one call each
scripts/cf-preflight.sh production --bootstrap -- r2 bucket create chopshop-prod-{public,private,production} --jurisdiction eu --no-update-config  # one call each
scripts/cf-preflight.sh staging    --bootstrap -- queues create chopshop-stg-{outbox,email,render-jobs}     # one call each
scripts/cf-preflight.sh production --bootstrap -- queues create chopshop-prod-{outbox,email,render-jobs}    # one call each

# after-listings (same four list commands as above)
```

Every command accepted `--env` (a global wrangler flag). `--no-update-config` stops wrangler from patching `wrangler.jsonc` itself. The file's checksum was identical before and after the creates, and the ids were pinned by hand.

## 4. Migrations (STAGING only)

```sh
scripts/cf-preflight.sh staging --bootstrap -- d1 migrations list DB --remote    # 12 pending: 0001 … 0012
scripts/cf-preflight.sh staging --bootstrap -- d1 migrations apply DB --remote   # 0001 … 0012 all ✅
scripts/cf-preflight.sh staging --bootstrap -- d1 migrations list DB --remote
  → ✅ No migrations to apply!
scripts/cf-preflight.sh staging --bootstrap -- d1 execute DB --remote \
    --command "SELECT count(*) AS tables FROM sqlite_master WHERE type='table'"
  → "tables": 31, "served_by_region": "WEUR", "changed_db": false
```

The migrations applied were `cloudflare/migrations/0001_platform_foundation.sql` … `0012_pod_artwork.sql` exactly as committed on cf-port `e50880a`. Migrations are append-only: a later edit to one of these files would not reach staging, so any schema change needs a new `0013_…` file. `wrangler` took its usual post-apply D1 backup. (`d1 list` reports `num_tables 0` for every database, including the pre-existing one. That column is stale metadata; the query above is the real count.)

Production `chopshop-prod` has **no** migrations applied, by design. Nothing was run against it after `d1 create`, not even `migrations list`, because that command creates the `d1_migrations` table.

## 5. Config changes

- **`cloudflare/wrangler.jsonc`**: top level holds only `name: chopshop-api`, `account_id` (Kent), `main`, `compatibility_date`, `compatibility_flags` and `observability`. There are no bindings or vars at the top level, so a bare `wrangler deploy` has nothing to deploy against. `env.staging` (`chopshop-api-stg`, workers.dev + preview URLs on) and `env.production` (`chopshop-api`, both off) each carry `vars` (`APP_ENV`, `SERVICE_NAME`, `CANONICAL_ORIGINS {api, web}`, `AUTH_BASE_URL` = api, `AUTH_TRUSTED_ORIGINS` = api,web, `R2_ACCOUNT_ID` = Kent, `R2_PRIVATE_BUCKET_NAME`), D1 `DB` (`migrations_dir: migrations`), R2 `PUBLIC_BUCKET` / `PRIVATE_BUCKET` / `PRODUCTION_BUCKET` (`jurisdiction: eu`), Queue producers `OUTBOX_QUEUE` / `EMAIL_QUEUE` / `RENDER_JOBS_QUEUE`, and consumers for the same three queues (batch 10, timeout 5, retries 8, concurrency 2, no DLQ). The old `AUTH_EMAIL_QUEUE` binding and its DLQ are gone.
- **Origins (D7, workers.dev until CP7):** staging api `https://chopshop-api-stg.kent-ee2.workers.dev` and web `https://chopshop-web-stg.kent-ee2.workers.dev`; production api `https://chopshop-api.kent-ee2.workers.dev` and web `https://chopshop-web.kent-ee2.workers.dev`. CP7 replaces the production pair in both `wrangler.jsonc` and `pinned.production.json`.
- **`pinned.<env>.json`**: `d1.id` filled in; `workerName` is now the deployed name of that env's worker (`chopshop-api-stg` / `chopshop-api`); new `origins {api, web}`.
- **`scripts/cf-preflight.sh`**: SHAPE gains `origins`. Both origins must be bare `https://` origins (lowercase host, optional port, no path, query, fragment or userinfo). This is checked even under `--bootstrap`. Without `--bootstrap` it also checks:
  - `env.<env>.name` (falling back to the top-level `name`) == `workerName`;
  - `vars.CANONICAL_ORIGINS` deep-equals pinned `origins`;
  - `AUTH_BASE_URL` == `origins.api`;
  - `AUTH_TRUSTED_ORIGINS` is exactly the set {api, web};
  - every R2 binding has `jurisdiction == "eu"`.

  Every earlier check is unchanged, and so is the "unknown key → extend the preflight first" behaviour.
- **`guard/preflight.test.sh`**: fixtures are now built from the repo's pinned files (worker name, origins, EU jurisdiction). The null-id cases null `d1.id` explicitly, because the real files now hold ids. New cases:
  - wrong env name, and a name inherited from the top level;
  - `CANONICAL_ORIGINS` drift, extra key or missing;
  - http, path or query+fragment origins;
  - pinned `origins` missing a key or carrying an unknown one;
  - `AUTH_BASE_URL` drift;
  - trusted origins missing web or carrying an extra origin;
  - R2 binding with a missing or foreign jurisdiction;
  - production with no env name falling back to `chopshop-api`, which is accepted;
  - **the repo's real `wrangler.jsonc` checked against the repo's real pinned files for both envs**, so any future drift between the two fails the suite.
- **`cloudflare/package.json`** (scripts only): removed `deploy:dry-run` and `deploy:staging` because they bypass the preflight. `types` and `types:check` now pass `--env staging`: without it, wrangler 4.123 makes every binding optional (`DB?: D1Database`), which gives 470 tsc errors (`possibly undefined`, measured). `dev` became `wrangler dev --local --env staging`, since without `--env` local dev has no bindings at all.
- **`cloudflare/worker-configuration.d.ts`**: regenerated with `--env staging`. The only difference is the Env block; the runtime types are unchanged.
- **`cloudflare/README.md`**: rewritten for the current setup.

## 6. Secrets the first staging deploy needs (not created: no Worker exists yet)

**Order matters.** When the target Worker does not exist yet, `secret put` run non-interactively creates it anyway, as a stub (`export default { fetch() {} }`; wrangler's `createDraftWorker`, where the confirm prompt falls back to "yes"). That is an ungated deploy. So run these only **after** the first gated `scripts/cf-deploy.sh staging`. That deploy ships dark, because every surface fails closed until its secret exists. An alternative is `deploy --secrets-file`, but `cf-deploy.sh` does not pass it today.

```sh
scripts/cf-preflight.sh staging -- secret put BETTER_AUTH_SECRET      # ≥ 32 chars, generated fresh
scripts/cf-preflight.sh staging -- secret put BOOTSTRAP_TOKEN         # ≥ 32 chars; remove after the first platform admin exists
scripts/cf-preflight.sh staging -- secret put STRIPE_SECRET_KEY       # NEW sandbox restricted key (rk_test_…), CF-only
scripts/cf-preflight.sh staging -- secret put STRIPE_WEBHOOK_SECRET   # from the NEW CF staging webhook endpoint (pin its we_ id first)
scripts/cf-preflight.sh staging -- secret put RESEND_API_KEY          # NEW Resend key for CF
scripts/cf-preflight.sh staging -- secret put R2_ACCESS_KEY_ID        # R2 API token scoped to the chopshop-stg-* EU buckets
scripts/cf-preflight.sh staging -- secret put R2_SECRET_ACCESS_KEY
scripts/cf-preflight.sh staging -- secret put RENDER_FARM_URL
scripts/cf-preflight.sh staging -- secret put RENDER_FARM_TOKEN
```

The non-bootstrap preflight refuses these until `pinned.staging.json → stripeWebhookEndpointId` is set and `~/.config/chopshop/stripe.staging.env` holds a valid `sk_test_` / `rk_test_` key for `acct_1Tp7gtKAaBMOW5AC`. `RESEND_API_KEY` is not yet declared in `src/env.d.ts`; the src owner adds it when the Resend consumer lands.

## 7. Verification

```
$ bash guard/preflight.test.sh
… 59 passed, 0 failed

$ node guard/guards.test.mjs          # cf-port tree + these changes + this report counted as tracked (§8)
guard: 1662 tracked files scanned, 317 match a pattern
guard: allowlist size = 313, permanent exemptions = 1
guard: baseline = 313
guard: FAIL
  (a) 3 file(s) match a forbidden pattern and are not allowlisted:
      docs/cf-port/DESIGN_CONTRACT.md  [<old-brand family>]
      docs/cf-port/HANDOVER.md  [<old-brand family>]
      docs/cf-port/SECRETS_REVOKE.md  [<old-brand family>, <legacy-term family>]
```

The family tags are redacted here, because the guard's own labels are forbidden strings.

**This failure is already present on cf-port `e50880a` without these changes.** An identical run on the pristine export (1661 files) gives the same three offenders and the same 317 matches. This change, this report included, adds none, and a direct grep of every file touched here finds no forbidden string. The three docs came from later CP0 commits (`c3f31df`, `ef88c4d`, `e167dd8`) and name the old project id and localStorage key. Their owner must clean them; the allowlist may not grow.

```
$ cd cloudflare && npm run types:check     → ✨ Types at worker-configuration.d.ts are up to date.  (exit 0)
$ npm run build                            → tsc --noEmit  (exit 0)
```

`npm test` / `npm run check` were **not** run. `cloudflare/vitest.config.ts` still reads the top-level config, which now has no bindings. **At merge the reviewer must add `environment: "staging"` to its `wrangler` options** (`wrangler: { configPath: "./wrangler.jsonc", environment: "staging" }`). With that, miniflare gets real local D1/R2/Queue bindings from `env.staging`. The `r2Buckets: ["PRIVATE_BUCKET"]` override and the "no R2 binding yet" comments there and in `test/env.d.ts` can then go.

End-to-end proof that the retargeted config and the pinned ids agree:

```
$ scripts/cf-preflight.sh staging --bootstrap -- d1 migrations list DB --remote
preflight: token sees exactly one account: Kent@meteorpr.se's Account (ee213082783ec86585150e876edb6107) = pinned
preflight: Stripe key belongs to the pinned sandbox account acct_1Tp7gtKAaBMOW5AC
preflight: OK (BOOTSTRAP: unset ids and env.staging bindings not enforced; null: stripeWebhookEndpointId) — wrangler --env staging d1 migrations list DB --remote
Resource location: remote
✅ No migrations to apply!

$ scripts/cf-preflight.sh staging -- whoami        # non-bootstrap
PREFLIGHT REFUSED: …/cloudflare/pinned.staging.json still has null (not yet created) values: stripeWebhookEndpointId - create them under --bootstrap, pin the ids, then deploy
```

The non-bootstrap refusal comes from step 2 (null pinned id), which runs before the Stripe-file step. `~/.config/chopshop/stripe.staging.env` now exists and holds a key for the pinned sandbox account, so the missing webhook endpoint id is the only remaining null. The new `env.staging` checks (name, origins, trusted origins, jurisdiction) are proven against the real files by the two "repo wrangler.jsonc passes every … check" cases in `guard/preflight.test.sh`.

## 8. Build notes and open items for the reviewer

- **Worktree base:** the builder's worktree was created at `f807625` (the hotfix on `main`), 15 commits behind `cf-port` `e50880a`. No git state was changed. `cloudflare/`, `guard/` and `scripts/cf-{preflight,deploy}.sh` were materialised from `cf-port` with `git archive` and edited there. `guards.test.mjs` was run on a scratch `git archive cf-port` export with the edited files overlaid, using a `git` shim that answers `ls-files -z` with `git ls-tree -r --name-only cf-port`. Commit by copying the owned files onto `cf-port`.
- **Top-level `name` equals the production worker name (`chopshop-api`).** A bare `wrangler deploy` would therefore target the production Worker with zero bindings. Three things prevent it: credentials for this account exist only inside the preflight, which always passes `--env`; the `deploy:*` npm scripts are gone; and the Worker fails closed. If that is not enough, give the top level a non-deployable name, and the preflight then relies on every env section setting its own `name`.
- The preflight does not check `vars.R2_PRIVATE_BUCKET_NAME == pinned r2.private` or `SERVICE_NAME == workerName`. Both would be cheap to add.
- The existing queue handler (`handleDisabledAuthEmailQueue`) now sees three queues, and it retries every message without reading it. Once max_retries runs out with no DLQ, messages are dropped (D1 remains the record). The src owner routes by `batch.queue` when real consumers land.
- `chopshop-web(-stg)` Workers do not exist yet. The `web` origins name them in advance (D7). The `kent-ee2` workers.dev subdomain was taken from D7 and not re-queried.
- `~/.config/chopshop/stripe.staging.env` appeared during this run (20:05 local). Its `STRIPE_SECRET_KEY` held a `REPLACE_…` placeholder, then a publishable `pk_test_` key (20:09), then from 20:14 a valid key for `acct_1Tp7gtKAaBMOW5AC`. The preflight validates an existing Stripe file even under `--bootstrap`, so migrations waited until 20:14. The resources had all been created before the file appeared. This builder did not read or change the file.
