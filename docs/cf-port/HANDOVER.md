# Cloudflare port — handover log

One entry per checkpoint (PLAN §9): what exists, how it was verified, both review notes, open gaps. Newest first. Branch `cf-port`.

## CP1 — Foundation on Kent's account (approved 2026-09-26, in progress)

**Session note:** the two CP1 Opus builders started at the end of the first 2026-09-26 session died with it — nothing reached disk or Cloudflare (verified: clean `git status`, `wrangler.jsonc` still on the old account, Kent's account held zero chopshop resources). Both were relaunched from written briefs in the second session; this entry is filled in when their diffs pass Fable review.

**Facts established before relaunch (read-only API/wrangler, token from `~/.config/chopshop/cloudflare.env`):** the token sees exactly one account (Kent's, `ee213082783ec86585150e876edb6107`); workers.dev subdomain `kent-ee2`; account holds unrelated `ai-content-hub` D1 + R2 bucket `ai-content-hub-media` (do not touch); zone **`melodiemc.com` is ACTIVE on Kent's account** (→ DECISIONS D7b); no queues, no Workers.

**Landed (2026-09-26 evening):**
- `6f68d10` **CP1-A** — all 14 resources on Kent's account (D1 `chopshop-stg` `d1162797-5a79-4a79-aef9-e5f7e1634fb1` with 0001–0012 applied, `chopshop-prod` `d401576e-184d-47bd-b68b-c3c80785844b` empty; R2 ×6 `--jurisdiction eu`; Queues ×6, no DLQ), env-aware `wrangler.jsonc` (top level `chopshop-api-unbound`, bindings-less; `env.staging` `chopshop-api-stg`, `env.production` `chopshop-api`), pinned ids + `origins`, preflight extended (env name, origins, AUTH_*, SERVICE_NAME, R2_PRIVATE_BUCKET_NAME, jurisdiction, R2_JURISDICTION; 62 tests), direct-wrangler npm scripts removed. Record: `CP1_BOOTSTRAP.md`.
- `db66555` **CP1-B** — Hono router on the raw pathname (`src/app.ts`; old-vs-new comparison identical over 58 paths × 2 hosts × 7 methods), public entrypoint + `Internal` WorkerEntrypoint both strip `X-Tenant-*` (handler-layer guard 404s if one ever gets through), admin tenant = `X-Shop-Id` validated against live memberships (contract change; hostname no longer consulted for `/v1/admin/**`), acting-as grants (`0013`, 60 min, audited, revocable, re-checked live per request), `CANONICAL_ORIGINS` allowlist (`src/lib/origins.ts`), password reset mounted (`request-password-reset`, `reset-password/:token`, `reset-password`) with ledger + `EMAIL_QUEUE` → Resend consumer (idempotency-key, lease, backoff; dark until `RESEND_API_KEY`+`EMAIL_FROM`), guest receipt capability (`0014`: hashed token on order, one-shot handoff `POST /v1/checkout/:id/receipt` by `DELETE…RETURNING`, allowlisted buyer schema `GET /v1/orders/:id` with denylist test), Better Auth limiter keyed on `cf-connecting-ip` (was X-Forwarded-For — bypassable), R2 EU presign host. Tests 916 → 1094 / 31 files. Record: `CP1_B_REPORT.md`.
- Reviewer (Fable) fixes at merge: `R2_JURISDICTION` var was read by B but never set by A → added to both envs + preflight check; dead `AUTH_EMAIL_QUEUE` declaration removed; vitest `environment: "staging"`; guard red from three CP0 docs fixed (`94c5678`).

**🚀 FIRST STAGING DEPLOY — 2026-09-26 21:10 CEST.** `scripts/cf-deploy.sh staging` on HEAD `29412a5` (attestations `codex: PASS` + `fable: PASS` in `refs/notes/reviews`, pushed) → Worker **`chopshop-api-stg`** at `https://chopshop-api-stg.kent-ee2.workers.dev`, version `f318df4b-2b0c-4c9c-8a4c-fe32cdd78f88`, all 7 bindings + 3 queue consumers attached. Staging D1 has migrations 0001–0016. Secrets set via the preflight from the 600 files: `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (`BOOTSTRAP_TOKEN` set, used once, deleted). Stripe sandbox webhook endpoint `we_1UK0jhKAaBMOW5ACAHh8BxB8` → `/v1/webhooks/stripe` (`payment_intent.succeeded`, api `2026-07-29.dahlia`), pinned.

**Smoke (live, curl):** `/health` 200 · `/ready` 200 (`0016_…`) · `/v1/storefront` 404 (no tenant domain yet) · anonymous `get-session` `null` 200 · **bootstrap** → platform admin `micke.ohlen@gmail.com` (uid `oayBSxS86Imk746kC0oY65eUMIcUL0B6`; password in `~/.config/chopshop/secrets.staging.env` → `PLATFORM_ADMIN_PASSWORD`) 201 · **sign-in** 200 + session cookie · `get-session` with cookie 200 · **request-password-reset** 200 (byte-identical shape) → `email_deliveries` row `password_reset / pending / 0 attempts` — the consumer holds it until `RESEND_API_KEY` + `EMAIL_FROM` exist. Not yet exercised on staging: reset link + reset-password (needs the email), tenant/admin surface (needs a tenant + `X-Shop-Id`), receipts (needs a checkout), POD (needs R2 API token).

**Codex (6 runs, gpt-6-astra, high):** `65f610c` 4×P1 + 2×P2 → fixed `9b02e24` (+ P2 → `9aadb15`, re-reviewed clean); `6f68d10` 3×P1 all supplied by `db66555`; `db66555` 1×P2 → `7908e83` → P2 → `694e559` → P2 → `29412a5` (5-line trigger, Fable-reviewed). Verdict at HEAD: no open findings.

**Verification (at `29412a5`):** `bash guard/preflight.test.sh` 70/70 · `node guard/guards.test.mjs` PASS · `cd cloudflare && npm run check` types up to date, tsc 0, vitest 1097/1097 (31 files).

**Verification (at `db66555`, historical):** `bash guard/preflight.test.sh` 62/62 · `node guard/guards.test.mjs` PASS · `cd cloudflare && npm run check` types up to date, tsc 0, vitest 1094/1094 (31 files). (superseded by the Codex paragraph above)

**Known gaps (B's own list):** reset timing side-channel (known vs unknown address) remains; object-store audit rows do not record the acting-as grant; email copy still says "MeteorShop"; uncollected receipt handoffs are swept only by the next poll (15-min sweeper is CP2); `DELETE … LIMIT` relies on D1's SQLite build (passes in the workers pool, confirm on staging).

**Split:** CP1-A = account bootstrap (D1 ×2, R2 ×6, Queues ×6, staging migrations, env-aware `wrangler.jsonc`, pinned ids, preflight extension, `CP1_BOOTSTRAP.md`). CP1-B = worker contract (Hono, two entrypoints + header stripping, `X-Shop-Id` + acting-as, canonical-origin allowlist, password reset via EMAIL_QUEUE → Resend, guest receipt capability, `CP1_B_REPORT.md`). Still to come in CP1: render benchmark + decision (D6), `render_jobs` acquire/complete with fencing, fake printer route (staging only), D1 backup + restore drill.

## CP0 — Hygiene + baseline (approved 2026-09-26, in progress)

**Done (all on `cf-port`, each verified by Fable before commit):**
- `83080ed` `cloudflare/` worker tree + `docs/CLOUDFLARE_HANDOVER.md` + `RENDER_FARM_CONTRACT.md` brought over from `cloudflare-migration` @ `2b13d05`, unchanged.
- `e24f17a` **test gate green**: the six test-only POD env values cp27 forgot (`vitest.config.ts`, `test/env.d.ts`) + regenerated `worker-configuration.d.ts` — recovered from `stash@{0}`. `npm run check` → types up to date, tsc 0, **vitest 916/916** (independent run).
- `ea74f4e` docs quarantine: 9 files → the two `docs/_archive/` subfolders (legacy-brand, superseded) with `INDEX.md`; `docs/cf-port/RETIRED.md` ledger; 173 MB image dumps moved to `~/Cursor Apps/chopshop-quarantine/`; cpuprofile deleted; zero live references (verified).
- `8cd7466` `MIGRATION_MANIFEST.md` — 75 rows (22 carry / 46 archive / 7 drop), read-only prod census, 15 open questions (→ DECISIONS D9–D23).
- `b2a8ba9` `specs/AFFILIATE.md` — live program specified from source; found the `approveAffiliate` takeover hole → **hotfix `f807625` on `main`** (merged `65628e1`), deploy pending Mikael (DECISIONS D1).
- `d882b00` storefront **design baseline** — 12 launch-scope pages × 375/768/1440 on bundle `index-EybuBb5L.js`, manifest with sha256, re-shoot script + ImageMagick diff script (0.5 % gate); re-shoot 10 min later: 33/36 identical, 3 within 0.003 %.
- `5a0fe32` PLAN v3 (Codex rounds 1–3 folded in); `b1e8c97` `DECISIONS.md`.
- (this commit) **guards + preflight + deploy gate** — see commit message. Real preflight run authenticates to Kent's account and refuses on the still-old `wrangler.jsonc` account id (expected until CP1).
- `main` `a497d32` hotfix: `run-all.sh` always rebuilds; Firebase freeze announced in LAUNCH_TODO.

**Reviews:** Fable reviewed every builder diff line by line (this file's author). Codex reviewed the PLAN (3 rounds); Codex review of the CP0 *code* (guards/preflight/deploy) is **pending** — CP0 has no deploy, so the `cf-deploy.sh` gate is not yet exercised for real.

**Open in CP0 (status 2026-09-26 evening):**
1. Hono router → slid into CP1-B (routing contract lands with the entrypoints).
2. ~~Impeccable audit → design contract~~ ✅ `ef88c4d` `DESIGN_CONTRACT.md`.
3. Admin/platform baseline screenshots — still needs a logged-in browser session handed off by Mikael.
4. ~~Compromised-secret revocation~~ ✅ verified unused, commands in `c3f31df` `SECRETS_REVOKE.md` (now `scripts/cf-port/SECRETS_REVOKE.md` — Firebase-side runbook, guard-excluded like the export tooling); **Mikael runs them** (D4).
5. Code retirement of the DELETE list — blocked on D2 sign-off.
6. Codex review of the CP0 tooling — folded into the CP1 review (same deploy).
7. ~~Token scopes~~ ✅ D5b answered (R2 + DNS scopes added; `r2 bucket list` on Kent's account works).

**Known gaps carried into CP1:** `wrangler.jsonc` must be retargeted (Kent's `account_id`, `env.staging`/`env.production` with the pinned names); `cloudflare/package.json` scripts call wrangler directly (bypass the preflight) — remove them; `cf-deploy.sh` does not itself enforce clean-checkout CI (CI does); git notes need `git push origin refs/notes/reviews`.
