# CP5-W2 report: the deploy path of the third Worker (`chopshop-admin`)

Model: claude-sonnet-5-5

Working tree only; no git write, no network, no real wrangler. `--admin` / `admin` are built as an exact structural mirror of `--web` / `web`.

## What was built

Pinned files
- `cloudflare/pinned.staging.json`: `adminWorkerName: "chopshop-admin-stg"`, `origins.admin: "https://chopshop-admin-stg.kent-ee2.workers.dev"`.
- `cloudflare/pinned.production.json`: `adminWorkerName: "chopshop-admin"`, `origins.admin: null`.

`scripts/cf-preflight.sh` (line numbers are of the file as committed by the reviewer; find by name)
- `--admin` flag; `--web` with `--admin` refused; `--bootstrap` with `--admin` refused (arguments block).
- One `EDGE` block replaces the old `WEB` block: deploy takes only `--dry-run`; only whoami, deployments, rollback, tail, versions list|view|deploy. The messages say `--web` or `--admin`. The web messages are byte-identical to before.
- `JSONC`/`RUN_DIR` for admin: `cloudflare/admin/wrangler.jsonc`, cwd `cloudflare/admin/`, run with `--config` (same exec branch as web).
- `cmd_pinned`: `adminWorkerName` required and must differ from `workerName` and `webWorkerName` (always, even under `--bootstrap`); `origins.admin` is required, a bare https origin when not null.
- `check_edge(kind)` replaces `cmd_webjsonc`; `webjsonc` and `adminjsonc` are thin wrappers, so every web check applies to admin unchanged: account id (top and env), env section present, top-level and env key allowlists (so no D1/R2/KV/queue/DO/container/secrets/AI/route/trigger/build), name == `adminWorkerName` (effective `<top>-<env>` too), assets exact, services exactly one `{API, pinned workerName, Internal}`, vars exactly `ADMIN_ORIGIN == origins.admin` and `PUBLIC_OBJECT_BASE_URL == r2.publicBaseUrl`, production `workers_dev`/`preview_urls` exactly false.
- `cmd_dist(dist, what, builder)`: the same `index.html` / `*.map` / `sourceMappingURL` check, run on `cloudflare/admin/dist` for an admin `deploy` (message says "the admin").
- Launch gate (6) and Stripe (7) apply to `--admin` exactly as to `--web` (unchanged code paths).

The API's side of the admin origin (ONE check, extended, not duplicated)
- `check_trusted(...)` is the old `AUTH_TRUSTED_ORIGINS` check lifted out of `cmd_jsonc`: the set must equal `{api, web}` plus `admin` when `origins.admin` is not null. The plain API mode calls it from `cmd_jsonc`.
- `--admin` calls it too through the new `apitrust` helper on `cloudflare/wrangler.jsonc` (refuses when that file has no `env.<env>`).
- `cloudflare/wrangler.jsonc`: `env.staging.vars.AUTH_TRUSTED_ORIGINS` gained the staging admin origin (a comment says why); production's vars untouched (its pinned admin is null, so the exact set is still `{api, web}`). `worker-configuration.d.ts` regenerated (`npm run types`), `npm run types:check` is green. The only diff is the hash line and the literal of that var.
- `CANONICAL_ORIGINS`: the comparison with the pinned origins ignores `admin` behind ONE constant, `CANONICAL_ORIGINS_CARRY_ADMIN = False` (with a comment, near the top of the Python block). **The reviewer flips it to `True`** when `cloudflare/src/lib/origins.ts` knows the key, and adds `CANONICAL_ORIGINS.admin` to the API's vars together. With True the variable must deep-equal pinned origins including `admin` (a null admin is not demanded). No `admin` key was added to `CANONICAL_ORIGINS`.

`scripts/cf-deploy.sh`
- Target `admin`; `all` = API, web build + web, admin build + admin, each only after the one before succeeded.
- `check_build_values <file> <what> <required> <allowlist>` (the old web block, generalised). Web: required file, any `VITE_` name, `VITE_STRIPE_PUBLISHABLE_KEY` required (unchanged). Admin: `~/.config/chopshop/admin.<env>.env`, OPTIONAL (missing = no build values, said in the usage text), mode 600 when present, only `VITE_PLATFORM_LEGAL_NAME`, `VITE_PLATFORM_ORG_NUMBER`, `VITE_STRIPE_PUBLISHABLE_KEY` (pk_ of the env), secret-looking values refused, no required name. The repository root `.env*` VITE_ names must be covered by the admin file too (also when the file is missing).
- All value checks run BEFORE anything is deployed (including for `all`: a bad admin file stops the API deploy).
- `build_with` / `after_build`: the old web build subshell and the clean-tree / HEAD-unchanged re-check, shared. The admin build is `node cloudflare/admin/check-admin-build.mjs` (no flag: it builds, then checks), `NODE_ENV=production`, no Cloudflare variable, no shell `VITE_`.
- Failure lines say what was deployed: "the API Worker and the web Worker ARE deployed" for an admin failure in `all`; a web failure in `all` adds "; the admin Worker was NOT deployed".
- Usage headers of both scripts updated.

`cloudflare/package.json`: nothing. `build` is plain `tsc --noEmit` and no script runs `-p web`, so there is no `-p admin` to add (as instructed: not invented).

## Tests

| suite | before | after |
|---|---|---|
| `guard/preflight.test.sh` | 183 | 303 |
| `guard/deploy.test.sh` | 48 | 89 |

Existing cases kept in meaning, with these unavoidable edits:
- preflight: "unknown pinned origins key" now uses `origins.platform` (admin is known now); the `env_section` fixture builds `CANONICAL_ORIGINS` without admin and `AUTH_TRUSTED_ORIGINS` with the admin origin (as the repo's files do).
- deploy: expected steps of `all` are now `api build web abuild admin`; one "root .env.local blanked" case is run as `staging web` (under `all` the admin file must cover it too, and a new case checks exactly that); usage string.

New preflight cases: pinned keys (missing, equal names, http, path, empty, null refusal for staging and production with its own line, API and web production deploys NOT blocked by a null admin); arguments (both flag orders, subcommand and deploy-argument refusals); the admin configuration (account, env section, name incl. effective name, assets x9, services x7, vars x6, 13 binding/route/trigger keys in env, 5 at top level, production `workers_dev`/`preview_urls` x4); the API's `AUTH_TRUSTED_ORIGINS` in `--admin` and in API mode (missing, extra, null admin both ways, no env section, wrong account); `CANONICAL_ORIGINS_CARRY_ADMIN` both states (the constant is flipped with `sed` on the test tree's copy); dist (missing, `.map`, inline and CSS source map, words in code allowed); launch gate, Stripe, token of another account; happy paths (deploy, `--dry-run`, tail, deployments, rollback, versions list, production, staging `workers_dev` false) and the repo's real admin and API wrangler files (staging passes; production refused for null admin).
New deploy cases: target admin alone, `all` order and call list, optional admin file (missing, mode 644, secrets x5, unknown name, bad name, wrong pk prefix both ways, production go/no-go), the build sees only its own file's values, root `.env` coverage, failure texts (web fail, storefront build fail or dirty in `all`, admin build fail/deploy fail in `all` and alone, API fail), admin build leaving the tree dirty / HEAD moved, the three first refusals for `admin`, and that other targets ignore the other Worker's file.

## Mutation table (each break applied once to a copy; 62 run in parallel copies of the tree)

All KILLED by at least one failing case unless noted. P = preflight (suite `preflight`), D = deploy (suite `deploy`).

| id | mutation | failing cases |
|---|---|---|
| P1 | `--web`+`--admin` refusal removed | 2 |
| P2 | `--bootstrap`+`--admin` refusal removed | 2 |
| P3 | admin gets no subcommand restriction | 17 |
| P4 | admin restricted with the web wording | 17 |
| P5 | admin config file not selected | 73 |
| P6 | admin run in the API dir | 11 |
| P7 | adminWorkerName vs workerName/webWorkerName check removed | 2 |
| P8 | only webWorkerName dropped from that check | 1 |
| P9 | origins.admin format check skipped | 2 |
| P10 | null admin no longer refuses `--admin` | 3 |
| P11 | admin flag not passed to the pinned check | 3 |
| P12 | null admin joins the generic null list (would block API) | 18 |
| P13 | wrong origin var for admin | 30 |
| P14-P23 | each of: account check, top-level keys, env keys, name, assets, services, exact var set, ADMIN_ORIGIN value, PUBLIC_OBJECT_BASE_URL, production workers_dev skipped for admin only | 2, 5, 13, 4, 9, 7, 2, 1, 1, 4 |
| P24 | `check_trusted` no longer requires the admin origin | 43 |
| P25 | `--admin` no longer checks the API's trusted origins | 4 |
| P26 | apitrust tolerates a missing env section | 1 |
| P27 | API mode: trusted check removed | 4 |
| P28 | flag: admin always dropped | 2 |
| P29 | flag: admin never dropped | 41 |
| P30 | flag True: null admin still demanded | 1 |
| P31 | admin dist check not run | 5 |
| P32-P34 | dist: `.map`, sourceMappingURL, `index.html` check removed | 2, 6, 4 |
| P35 | admin exec without `--config` | 11 |
| D1 | admin not an accepted target | 19 |
| D2 | admin allowlist empty | 1 |
| D3 | admin file required | 31 |
| D4 / D5 | admin / web values not checked for target all | 8 / 15 |
| D6-D10 | mode, secret, allowlist, pk prefix, root `.env` checks removed | 3, 14, 1, 4, 4 |
| D11 | admin built with the web values | 1 |
| D12-D14 | admin re-check removed; HEAD check removed; dirty check removed | 3, 2, 6 |
| D15 / D16 | admin build / admin preflight failure ignored | 2 / 2 |
| D17 | admin deployed without `--admin` | 15 |
| D18 / D19 | admin step skipped for target admin / all | 11 / 10 |
| D20 / D21 | target admin also runs API / web | 10 / 10 |
| D22 / D23 | failure texts (DONE not updated; web failure not naming admin) | 3 / 3 |
| D24 / D25 | shell VITE_ vars kept; NODE_ENV not production | 3 / 2 |

Not killed, with reasons:
- P36 was a no-op edit of mine (not a real mutation); ignore.
- D26 (the `[ -f "$VALUES" ]` guard in `build_with`) survives: it is an equivalent mutant, because with the guard removed, `each_entry` on a missing file fails inside a `||` list where `set -e` is inactive and the build still runs with no values. The guard stays for clarity. Missing-file behaviour is covered by the "no admin.staging.env" cases.

Other checks: `bash -n` clean; `node guard/guards.test.mjs` PASS; `cd cloudflare && npx tsc --noEmit` clean; `npx vitest run`: 96 files passed, 1 failed (`test/health.test.ts`, which pins the migration file name `0046_order_fulfilment.sql` — another builder's unfinished migration work, not touched); 4139 of 4140 tests passed. No test under `cloudflare/test` pins `pinned.*` or the API's `AUTH_TRUSTED_ORIGINS` literal.

## What a reviewer must still do by hand before the first admin deploy to staging (in order)

1. Land the other builders' work and commit this one; the tree must be clean and pushed. Attest HEAD (`codex: PASS`, `fable: PASS`) as for any deploy.
2. Confirm the staging admin Worker's address is what is pinned: `chopshop-admin-stg` on the account's workers.dev subdomain gives `https://chopshop-admin-stg.kent-ee2.workers.dev` (the subdomain is the one the API and web use). If wrangler reports another address after the first deploy, change `origins.admin` in `pinned.staging.json`, `ADMIN_ORIGIN` in `cloudflare/admin/wrangler.jsonc` and `AUTH_TRUSTED_ORIGINS` in `cloudflare/wrangler.jsonc` together (`npm run types`).
3. Deploy the API first (`scripts/cf-deploy.sh staging api`): it now carries the admin origin in `AUTH_TRUSTED_ORIGINS` (Better Auth refuses admin sign-ins otherwise). `scripts/cf-deploy.sh staging admin` also works alone afterwards, but not before the API carries the origin.
4. Optionally create `~/.config/chopshop/admin.staging.env` (mode 600). Not needed: the admin build takes no value today.
5. `scripts/cf-deploy.sh staging admin`. The first deploy creates the Worker `chopshop-admin-stg`; its service binding needs `chopshop-api-stg` to exist already (it does).
6. When `origins.ts` accepts an `admin` key and that change is deployed: add `CANONICAL_ORIGINS.admin` (= `origins.admin`) to the API vars of each env that pins one, and flip `CANONICAL_ORIGINS_CARRY_ADMIN` to `True` in `scripts/cf-preflight.sh` in the same commit. Order matters (CP5_WX_REPORT "Reviewer wiring" item 2): adding the key before the Worker knows it takes the password-reset surface dark.
7. Run the staging smoke list of CP5_WX_REPORT item 8 (sign-in in a real browser, an upload across the service binding, the enforced CSP, `http://` redirect).
8. Production (later, CP7): pin `origins.admin` to the real domain, put the same value in `cloudflare/admin/wrangler.jsonc` env.production `ADMIN_ORIGIN` and in the API's production `AUTH_TRUSTED_ORIGINS` (and `PUBLIC_OBJECT_BASE_URL` in the admin vars). Until then `production --admin` is refused with a clear line.

## Deviations and open questions

- Null convention: the existing convention puts a null into the generic list that blocks EVERY non-bootstrap deploy. For `origins.admin` I did NOT do that: it blocks only `--admin`, with its own line. Reason: otherwise a null admin would also block the API's and the web Worker's production deploys once `r2.publicBaseUrl` is set. Easy to switch if you prefer the generic convention (drop the special branch in `cmd_pinned`).
- The CP5_WX_REPORT sketch said production `origins.admin` would be a placeholder; the task said null, so null is what is pinned. The committed `cloudflare/admin/wrangler.jsonc` env.production `ADMIN_ORIGIN` is still the placeholder `https://chopshop-admin.kent-ee2.workers.dev`; it disagrees with the pinned null only for as long as production `--admin` is refused, so I did not touch it (not my file). Whoever pins the real domain edits it with the pinned file.
- `--admin` allows deployments, rollback, tail and versions list|view|deploy as well, exactly like `--web` (the report sketch listed only deploy and whoami; the task said mirror `--web`). Tell me if it should be narrower.
- The "admin" word in messages: `cmd_dist` says "the admin ships none" / "the admin is not built" (generic wording from a parameter).
- `bash guard/guards.test.mjs` is a Node file; run it with `node`. PASS.

## Files modified

`scripts/cf-preflight.sh`, `scripts/cf-deploy.sh`, `guard/preflight.test.sh`, `guard/deploy.test.sh`, `cloudflare/pinned.staging.json`, `cloudflare/pinned.production.json`, `cloudflare/wrangler.jsonc` (staging `AUTH_TRUSTED_ORIGINS` only), `cloudflare/worker-configuration.d.ts` (regenerated), `docs/cf-port/CP5_W2_REPORT.md`.
