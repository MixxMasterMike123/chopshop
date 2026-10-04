# CP7-T3 — the preflight accepts a production Worker on its custom domain

Offline tooling, 2026-10-04, on `cf-port` at `3fe06068`. This unit does the preflight's part of runbook blocker 2 (`CP7_RUNBOOK.md` §10 item 2 and decision 1.1). No domain is decided, so nothing in production changes: no `wrangler.jsonc`, no `pinned.*.json`, no `cf-deploy.sh` and nothing under `cloudflare/src` was edited. Nothing ran against a real host. Every test runs the preflight against the harness's fake `wrangler` and fake `curl`.

Files changed: `scripts/cf-preflight.sh`, `guard/preflight.test.sh`, and this report.

## The rule as built

Each Worker is judged by **its own** pinned origin: the API by `origins.api`, `--web` by `origins.web`, and `--admin` by `origins.admin`. One function, `check_route` (`scripts/cf-preflight.sh:511-537`), decides. The API's check calls it last (`cmd_jsonc`, `:491`), and so does the web and admin check (`check_edge`, `:579`). Every check that existed before still runs first, in the same order. Its message is the same except in two places, both listed under "changed" below. The header's check 5 documents the rule as "addresses" (`:65-76`).

| Where | Pinned origin of that Worker | `routes` must be | Also |
|---|---|---|---|
| top level of any of the three files | — | absent (and `route` absent) | wrangler inherits both into every env section |
| `env.<env>.route` (singular) | — | absent, always | — |
| `env.staging` | anything | absent (`[]` counts as present) | everything else as before |
| `env.production` | host ends in `.workers.dev` (today's placeholder pins) | absent (`[]` counts as present) | everything else as before |
| `env.production` | host does **not** end in `.workers.dev` | **exactly** `[{"pattern": "<host>", "custom_domain": true}]` | the origin has no port; its host is no other pinned origin's host and not `r2.publicBaseUrl`'s; the API's `workers_dev` and `preview_urls` are exactly `false` |

`<host>` is the pinned origin minus `https://`. Check 2 already guarantees that the origin is bare: lowercase, no path, query, fragment or userinfo. With the port refused in custom mode, `<host>` is exactly `new URL(origin).host`. "Exactly" is the comparison the preflight already uses for `assets` and `services` (`canon`: JSON with sorted keys). Key order inside the entry is free. `true` is not `1` and not `"true"`. The match covers the whole list, so one entry and no other key. A zone route, a string entry, a path, a wildcard, a port, upper case, a trailing dot, another host, `enabled` and `previews_enabled` are all refused by that one comparison.

What did not change:
- `workers_dev` and `preview_urls` stay required `false` in production for the web and admin Workers, in both modes.
- Production has no workers.dev mode: a pinned workers.dev host still gives a Worker with `workers_dev: false` and no route, as today.
- Under `--bootstrap`, check 5 is not run, so the new rule is not run either. Bootstrap deploys nothing.

### Decisions in this unit, with reasons

1. **The port is refused in custom mode.** A custom domain answers on the https port only, so a pinned `:8443` can never be reached. A pinned `:443` would make `new URL(origin).host` drop the port. Then the route would match while `CANONICAL_ORIGINS` held `https://…:443`, which the Worker refuses at runtime: `cloudflare/src/lib/origins.ts` requires `url.origin === value`. Browsers never send `:443` in `Origin` either, so `AUTH_TRUSTED_ORIGINS` would never match. In workers.dev mode, check 2's existing rule (port allowed) is unchanged.
2. **No two production addresses may share a host** when one of them is a custom domain. I read wrangler 4.123.0 (`cloudflare/node_modules/wrangler/wrangler-dist/cli.js`, `publishCustomDomains`). When stdout is not a terminal, it sets `override_existing_origin` and `override_existing_dns_record` to true. So a second Worker deploying the same custom domain silently takes it from the first, and conflicting DNS records are replaced. With `origins.web == origins.api`, the web deploy would leave the API, the Stripe webhooks and the render container with no address. `r2.publicBaseUrl` is in the comparison because the public bucket's custom domain is a host too. The comparison ignores ports on the other side, because a host is one custom domain whatever the port.
3. **The API needs `workers_dev: false` and `preview_urls: false` only in custom mode.** Before this unit, the API's check did not look at either key. Requiring them in workers.dev mode would refuse the existing passing fixture `ENV_PRODUCTION`, which sets neither. That would break "today's pins pass exactly as before". In custom mode the requirement is new, and there is no existing user of that mode.
4. **The web and admin allowlist admits `routes` in production in both modes**, and `check_route` decides. That way a workers.dev pin with a route gets the explaining message ("is a workers.dev host, so the web Worker takes no route") instead of the generic one. In staging the allowlist is the old one and so is its message, byte for byte.
5. **Staging is unchanged, apart from routes.** A staging route is refused even when the staging pin is a custom host with exactly that host's custom-domain route. A staging custom-host pin with no route is accepted, as before. Making staging coherent on a custom host is out of scope.
6. **Each Worker by its own pin.** A mixed state passes: the API on its custom domain while the web Worker is still on a workers.dev pin. The tests include one such case.

## Every refusal message added or changed

Added, in `check_route`:
- `{jsonc} top level has {routes|route} - wrangler inherits it into every env section; the only route allowed is env.production.routes, the custom domain of the pinned origin`. Only the API's file can reach this one: the web and admin top-level allowlist refuses first, with its existing message.
- `{jsonc} env.{env}.route is {value} - the only route allowed is env.production.routes, the custom domain of the pinned origin` (API; for web and admin, the allowlist refuses `route` first).
- `{jsonc} env.staging.routes is {value} - staging takes no route (a route is only the custom domain of a pinned production origin that is not on workers.dev)` (API; for web and admin, the old staging allowlist message stands).
- `{jsonc} env.production.routes is {value} - pinned origins.{kind} '{origin}' is a workers.dev host, so the {kind} Worker takes no route (…)`.
- `{pinned}: origins.{kind} '{origin}' has a port - its Worker is reached through a custom domain, which answers on the https port only; pin the origin without one`.
- `{pinned}: origins.{kind} '{origin}' has the host of {origins.x|r2.publicBaseUrl} '{other}' - each production Worker's custom domain is a host of its own (wrangler, run without a terminal, moves a custom domain that another Worker holds to the one it deploys)`.
- `{jsonc} env.production.routes is {value}, expected exactly [{"custom_domain": true, "pattern": "<host>"}] - pinned origins.{kind} '{origin}' is not a workers.dev host, so the {kind} Worker is reached only through that custom domain (without it, it deploys with no address)`.

Added, in `cmd_jsonc` (API, custom mode only):
- `{jsonc} env.production.{workers_dev|preview_urls} is {value}, production on a custom domain requires false (the API answers on its pinned origin only, nothing of it on workers.dev)`.

Changed, in `check_edge` (web and admin):
- The env-key allowlist message, in production only: `… holds no data, no secret, no trigger and no route but its pinned custom domain: env.production may only hold account_id, assets, name, preview_urls, routes, services, vars, workers_dev`. The staging message is byte-identical to before.
- The `workers_dev`/`preview_urls` message ends `absent, wrangler turns workers_dev on when there is no route` (it said `absent, wrangler turns workers_dev on`). The new wording is true in both modes: wrangler's own default is `workers_dev = routes.length === 0` (`getSubdomainValues`, same file). The rule itself, explicit `false`, is unchanged.

## Other equalities a custom domain needs (brief point 3)

Each of these is already compared **exactly** with the pinned origins, so changing a pin forces the matching config edit. None needed a change:

| Value | Compared with | Where |
|---|---|---|
| API `vars.CANONICAL_ORIGINS` | deep-equal to pinned `origins` (the `admin` key only while it is pinned) | `cmd_jsonc` |
| API `vars.AUTH_BASE_URL` | `origins.api` | `cmd_jsonc` |
| API `vars.AUTH_TRUSTED_ORIGINS` | exactly the set {api, web} plus admin when pinned | `check_trusted`, from the API deploy and from `--admin` (`cmd_apitrust`) |
| web `vars.WEB_ORIGIN` | `origins.web` | `check_edge` |
| admin `vars.ADMIN_ORIGIN` | `origins.admin` | `check_edge` |
| `PUBLIC_OBJECT_BASE_URL` (all three) | `r2.publicBaseUrl` | `cmd_jsonc`, `check_edge` |

The render container pulls jobs from `CANONICAL_ORIGINS.api` (`cloudflare/src/render/render-container.ts` uses `readCanonicalOrigins`), so it follows the var. Nothing in `cloudflare/src`, `cloudflare/web/src` or `cloudflare/admin/src` names a workers.dev or r2.dev host (`git grep`), and there is no cookie-domain setting. One equality is new: no shared host (decision 2).

What the preflight does **not** compare, so it stays by hand (see the end of the next section): the Stripe endpoints' URL, `VITE_STOREFRONT_ORIGIN`, the R2 CORS rule, and whether the bucket's domain exists.

## The day the domain exists

Example domain `shop-example.test`: `api.`, `shop.`, `admin.`, and `img.` for the public bucket. The order is the runbook's (§2.2): everything outside the repository first, then **one** config commit (§2.8), then the gates.

**Before the commit (by hand, outside the repository):**
1. The zone `shop-example.test` is on Kent's Cloudflare account and reads Active (§2.5 step 1).
2. The public bucket's address: `scripts/cf-preflight.sh production --bootstrap -- r2 bucket domain add chopshop-prod-public --domain img.shop-example.test --zone-id <zone id> --jurisdiction eu` (§2.6). Then CORS on `chopshop-prod-public` and `chopshop-prod-private`, allowing GET and HEAD from `https://admin.shop-example.test` (§2.6).
3. The two Stripe live endpoints, both with the URL `https://api.shop-example.test/v1/webhooks/stripe`, created and then disabled (§2.4). Their `we_…` ids, and the live `acct_…` (§2.3).
4. `api.`, `shop.` and `admin.shop-example.test` carry no DNS record that must be kept. Without a terminal, wrangler replaces a conflicting record when it attaches the custom domain (decision 2).

**The config commit, these keys and nothing else:**

5. `cloudflare/pinned.production.json`:
   - `origins.api` = `"https://api.shop-example.test"`
   - `origins.web` = `"https://shop.shop-example.test"`
   - `origins.admin` = `"https://admin.shop-example.test"`
   - `r2.publicBaseUrl` = `"https://img.shop-example.test"`
   - `stripeAccountId`, `stripeWebhookEndpointId`, `stripeConnectWebhookEndpointId` = the ids from step 3. They are not part of this rule, but every non-bootstrap command refuses while they are null.
6. `cloudflare/wrangler.jsonc`, `env.production`:
   - add `"routes": [{ "pattern": "api.shop-example.test", "custom_domain": true }]`
   - `vars.CANONICAL_ORIGINS` = `{ "api": "https://api.shop-example.test", "web": "https://shop.shop-example.test", "admin": "https://admin.shop-example.test" }`
   - `vars.AUTH_BASE_URL` = `"https://api.shop-example.test"`
   - `vars.AUTH_TRUSTED_ORIGINS` = `"https://api.shop-example.test,https://shop.shop-example.test,https://admin.shop-example.test"`
   - add `vars.PUBLIC_OBJECT_BASE_URL` = `"https://img.shop-example.test"`
   - `workers_dev: false`, `preview_urls: false`: already so; keep them.
7. `cloudflare/web/wrangler.jsonc`, `env.production`:
   - add `"routes": [{ "pattern": "shop.shop-example.test", "custom_domain": true }]`
   - `vars.WEB_ORIGIN` = `"https://shop.shop-example.test"`
   - add `vars.PUBLIC_OBJECT_BASE_URL` = `"https://img.shop-example.test"`
   - `workers_dev`/`preview_urls`: already `false`; keep them.
8. `cloudflare/admin/wrangler.jsonc`, `env.production`:
   - add `"routes": [{ "pattern": "admin.shop-example.test", "custom_domain": true }]`
   - `vars.ADMIN_ORIGIN` = `"https://admin.shop-example.test"`
   - add `vars.PUBLIC_OBJECT_BASE_URL` = `"https://img.shop-example.test"`
   - `workers_dev`/`preview_urls`: already `false`; keep them.

The comments beside these keys that say "CP7 replaces …" can go in the same commit.

**Proven offline:** the test "repo … config + the report's day-of-domain edits" applies exactly steps 5–8 to copies of the committed files, with each anchor found exactly once. All three deploys pass every production check. Without the three `routes` lines, all three are refused for the missing route. The test runs only while the repo's production `origins.api` is still a workers.dev host. After the commit, the existing production real-file cases for the API and the web Worker check the committed files as they are. The admin's production real-file case is one of the 8 listed under "The test suite on the day".

**After the commit (by hand):**

9. `~/.config/chopshop/admin.production.env`: `VITE_STOREFRONT_ORIGIN=https://shop.shop-example.test`. Nothing compares it with `origins.web`: `cf-deploy.sh` only admits the name.
10. The gates of §2.8 (`bash guard/preflight.test.sh`, `bash guard/deploy.test.sh`), then the reviews. What the preflight suite does on that day: see "The test suite on the day" below.
11. On the first production deploy, read the two Stripe lines the preflight prints, `pinned Stripe webhook endpoint we_… exists: <status> -> <url>`. Both URLs must be `https://api.shop-example.test/v1/webhooks/stripe`. The preflight checks only that each endpoint exists (`cmd_webhook`); it does not compare the URL with `origins.api`.

### The test suite on the day

I rehearsed the day offline. A scratch mini-repo held copies of exactly the files the suite reads from `$REPO`. Steps 5–8 were applied to its committed files (the Stripe ids invented), then `guard/preflight.test.sh` ran there.

| Script and test | Result on the day | Failing cases |
|---|---|---|
| HEAD's (`3fe06068`, read with `git show`), the day's edits without the `routes` lines (the old preflight refuses them) | 294 passed, 8 failed | the 8 below |
| this unit's, with the `routes` lines | 429 passed, 8 failed | **the same 8**, set-identical |

This unit adds no failure on the day. The existing fixture builders (`env_section`, `web_section`, `admin_section`) already follow the repository's pins: `CANONICAL_ORIGINS` gains `admin` once it is pinned. They now also add the custom-domain route when the repository's pinned origin is a custom host. Before that change, the rehearsal showed 8 more failures, all fixtures with no route.

The 8 that remain come from cases written for today's pins, so HEAD's suite fails them on the day too. They must be edited in the same config commit:
- "production with null ids without --bootstrap → refused" expects `r2.publicBaseUrl` among the nulls. It reads it from the repository, where it is pinned by then.
- Six admin cases ("admin production: e['workers_dev'] = True / del … / preview_urls …", "admin production with the real LAUNCH_TODO", "admin production (origins.admin pinned …) → execs"). `PIN_PROD_ADMIN` pins `ADMIN_PROD_ORIGIN`, while `admin_section` already takes the repository's pinned admin origin. The smallest fix: `PIN_PROD_ADMIN` pins `origins.admin` only while the repository's is null, and `ENV_PRODUCTION_ADMIN` appends `ADMIN_PROD_ORIGIN` only then.
- "repo files as committed: production --admin refused while pinned origins.admin is null". It asserts today's state. Guard it on the repository's `origins.admin` being null, as the D95 case beside it already does for `r2.publicBaseUrl`.

This unit leaves those 8 alone. They are not caused by it, and their right shape depends on the day's pins.

### Not covered by this unit, and still by hand

- **Blocker 1, the launch gate**, still refuses every non-bootstrap production command until A5–A7 and B1–B10 are ☑ or decision 1.3 narrows it. This unit does not touch it.
- **Whether the bucket's domain exists and answers.** The preflight only proves that `r2.publicBaseUrl` equals the three `PUBLIC_OBJECT_BASE_URL` vars and is no Worker's host. That `img.` is attached to `chopshop-prod-public` and answers is §2.6's "Expect" (a 404 for a missing key), checked by hand.
- **The Stripe endpoints' URL** (step 11), the **R2 CORS rule** (step 2) and **`VITE_STOREFRONT_ORIGIN`** (step 9): nothing compares them with the pins.
- **The zone, the name servers and the certificates.** Wrangler attaches a custom domain at deploy and Cloudflare issues its certificate. That is not exercised here (no network). Whether the project token may attach a Workers custom domain is **not verified**: D5b records only "R2 Edit + DNS Edit".
- **Blocker 35, by reading wrangler 4.123.0's code only (not verified live):** with no custom-domain route, `wrangler deploy` does not call `publishCustomDomains` at all. A custom domain attached earlier, in the Dashboard or by an earlier deploy, therefore stays attached through a deploy without `routes`. The same holds for undoing step 6–8: removing a `routes` line does not detach the domain. Detach it in the Dashboard.
- **The runbook's text** (§2.1 row 6, §2.5 "API … not verified by a preflight test", "Web and admin: refused by the preflight today", blocker 2, blocker 35) now describes the old preflight. This unit may not edit it; the reviewer or the next runbook pass should.

## Tests

`guard/preflight.test.sh`: 302 cases at the untouched tree, 442 now (140 new). They follow the harness's pattern: a throwaway tree per case, the fake `wrangler` and `curl`, and fixtures generated by the existing `env_section` / `web_section` / `admin_section` with an edit. The new section is "CP7-T3", just before the final "secrets never surface" check, so that check covers every new run too. That check now reports 435 runs.

| Group | Cases | What |
|---|---|---|
| accepted | 6 | API, web, admin each on its custom domain (whole exec line); the entry's keys in the other order; web on a workers.dev pin while the other two are custom (each Worker by its own pin); `--bootstrap` with custom pins and no route |
| route shape on a custom pin | 81 | 27 shapes × 3 Workers: absent, `[]`, `null`, an object instead of a list, two entries (same, other host), a string entry, a `zone_name` route, a `zone_id` route, `zone_name` added to the custom entry, pattern + `/`, `/*`, `/platform`, `*.shop-example.test`, `*<host>`, `<host>:443`, `https://<host>`, upper case, capitalised, trailing dot, another host, `custom_domain` `false` / `1` / `"true"` / missing, extra `enabled`, extra `previews_enabled`. Each must name the expected `[{"custom_domain": true, "pattern": "<that Worker's host>"}]` |
| port on a custom pin | 6 | `:8443` (with the same port in the route) and `:443` (route without it) × 3 Workers |
| shared host | 5 | web = api's host (API deploy); web on admin's host; admin on web's host; `r2.publicBaseUrl` = web's host; `r2.publicBaseUrl` on api's host with another port |
| workers.dev off on a custom domain | 12 | `workers_dev` true / absent, `preview_urls` true / absent × 3 Workers (the API's are new; web and admin show the existing rule holds in custom mode) |
| route on a workers.dev pin | 5 | API with the custom domain of its workers.dev host; API `routes: []`; API with no route → execs (exactly as before); web; admin |
| staging | 7 | API: a custom-domain route on its pinned host, `[]`, a zone route, `route`; API pinned on a custom host with exactly its custom-domain route; web and admin with a custom-domain route on their pinned host (the old allowlist message, unchanged) |
| `route` (singular) and other keys | 6 | API: three forms of `route`; web and admin: `route` (the production allowlist message); web: a KV binding beside the custom domain |
| top level | 6 | API: `routes`, `route`, `routes: []` with a correct env section; API staging; web and admin with a correct env section |
| the real files, day of the domain | 6 | steps 5–8 applied to copies of the committed files: three deploys pass; without the `routes` lines, three refused |

"Production with today's workers.dev pins and no route passes exactly as before" is shown by the existing cases, unchanged and passing:
- "production fully pinned, launch gate done … → execs" (API);
- "web production, launch gate done, live Stripe, workers.dev off → execs";
- "admin production (origins.admin pinned, …) → execs";
- the six real-file cases against the committed configs;
- plus the new "API production on a workers.dev pin with no route → execs".

Changes to existing test code, and why:
- `ADMIN_PROD_ORIGIN` was `https://admin.prod.test.invalid`. It is now `https://chopshop-admin.kent-ee2.workers.dev`, the runbook's §2.5 name, shaped like the pinned api and web placeholders. Under the new rule, the old value is a custom host deployed with no route: exactly the shape this unit must refuse. With the old value, two existing cases failed on the new route refusal, as predicted ("admin production with the real LAUNCH_TODO …", which expected the launch-gate line, and "admin production (origins.admin pinned …) → execs"). With the new value, both test what they always tested.
- `write_jsonc` takes an optional fourth argument, top-level lines, as `write_web_jsonc` and `write_admin_jsonc` already did. With it empty, the file is the same JSON as before.
- `env_section`, `web_section` and `admin_section` add the custom-domain route in production when the repository's pinned origin is not a workers.dev host. For the API they also add `workers_dev`/`preview_urls` `false`. Today the condition is false. I generated the fixture variables (`ENV_STAGING`, `ENV_PRODUCTION`, `WEB_STAGING`, `WEB_PRODUCTION`, `ADMIN_STAGING`, `ADMIN_PRODUCTION`, `ENV_PRODUCTION_ADMIN`, `PIN_PROD_ADMIN`) from HEAD's file and from this one, then compared them. They are byte-identical, except the three that carry `ADMIN_PROD_ORIGIN`'s new value. That is why the mutation results below hold for the final file. The reason for the change: "The test suite on the day".

Two harness hazards met while writing the tests (both noted in the file):
- **bash 3.2 brace-expands a literal `{a, b}` nested in `"$(… "…")"`.** Each such edit goes through a variable.
- **A Python error in a fixture builder is silent.** The traceback goes to stderr, and `web_tree`'s `${2:-$WEB_STAGING}` falls back to the default fixture. Every run of this unit was also checked for zero `Traceback` lines.

## Mutation table

Each mutation ran in its own scratch mini-repo, holding copies of exactly the files `guard/preflight.test.sh` reads from `$REPO`. The copy of `scripts/cf-preflight.sh` was changed at an anchor checked to occur exactly once, and the copied test was run there. The repository's script was never edited for a mutation. Before the runs I saved it with `cp`, and `cmp` against that copy matched after them and again at the end. No run had a `Traceback` line. Every mutation is killed.

| # | Mutation (in `scripts/cf-preflight.sh`) | Result | Cases that failed (examples) |
|---|---|---|---|
| M1 | top-level `routes`/`route` check removed | 438/4 | API top level with `routes`, `route`, `routes: []`; API top level, staging |
| M2 | `env.<env>.route` check removed | 438/4 | API `env.staging.route`; three forms of API `env.production.route` |
| M3 | custom mode no longer limited to production (`env != "production"` dropped) | 441/1 | API staging pinned on a custom host with exactly its custom-domain route |
| M4 | the workers.dev test dropped (every production pin treated as custom) | 424/18 | the existing production happy paths ("production fully pinned …", "web production, launch gate done …", "admin production (origins.admin pinned …)"), the repo real-file case, the workers.dev-pin cases |
| M5 | "no `routes` without a custom pin" removed | 434/8 | workers.dev pin with a route (API, web, admin), API `routes: []`; API staging routes (three forms, and the custom-pin one) |
| M6 | port check removed | 436/6 | `:8443` and `:443` × API, web, admin |
| M7 | shared-host check removed | 437/5 | all five shared-host cases |
| M8 | `r2.publicBaseUrl` left out of the shared-host comparison | 440/2 | `r2.publicBaseUrl` on web's host; on api's host with another port |
| M9 | shared-host comparison keeps the other side's port | 441/1 | `r2.publicBaseUrl` on api's host with another port |
| M10 | exact route comparison removed | 358/84 | the 81 shape cases; the 3 real-file cases without `routes` |
| M11 | Python `==` instead of `canon` (`True == 1`) | 439/3 | `custom_domain = 1` × API, web, admin |
| M12 | `check_route` returns `False` in custom mode (the API's workers.dev check skipped) | 438/4 | API on its custom domain: `workers_dev` true / absent, `preview_urls` true / absent |
| M13 | the API's `workers_dev`/`preview_urls` check removed | 438/4 | the same four |
| M14 | the API's `check_route` call removed | 392/50 | the API's shape, port, shared-host, workers.dev, staging, `route` and top-level cases |
| M15 | the web/admin `check_route` call removed | 377/65 | the web and admin shape, port, shared-host and workers.dev-pin cases |
| M16 | `routes` admitted by the allowlist in staging too | 438/4 | web/admin `env.staging` with `routes` (the two existing cases and the two new ones: the message changes) |
| M17 | `routes` never admitted in production | 366/76 | web and admin on their custom domain → execs; their shape cases (the allowlist refuses first, with another message) |
| M18 | production allowlist message the same as staging's | 440/2 | web and admin `env.production` with `route` |
| M19 | the API's check refuses only `true` (absent accepted) | 440/2 | API on its custom domain with `workers_dev` absent, with `preview_urls` absent |

## Gates

Run after the last edit. The baseline is the untouched tree at `3fe06068`.

| Gate | Baseline | Now |
|---|---|---|
| `bash guard/preflight.test.sh` | `302 passed, 0 failed` | `442 passed, 0 failed` (0 `Traceback` lines; "no token or Stripe key in any stdout/stderr (435 runs)") |
| `bash guard/deploy.test.sh` | `90 passed, 0 failed` | `90 passed, 0 failed` |
| `node guard/guards.test.mjs` | `guard: allowlist size = 294, permanent exemptions = 1` · `guard: baseline = 294` · `guard: PASS` | the same three lines |
| `node --test "scripts/cf-port/migrate/test/*.test.mjs"` | `# tests 554` `# pass 554` `# fail 0` | `# tests 554` `# pass 554` `# fail 0` |

The guard scans tracked files only, so this untracked report is not in its count. I searched the report and every added line with the guard's own three patterns (`FAMILIES` in `guard/guards.test.mjs`): no match. `launch-gate.test.mjs` cuts the `PY` heredoc out of the preflight and reads its `LAUNCH_REQUIRED` line. Both keep their shape, and the suite passes.

## Seen, out of scope

- Check 2's `ORIGIN` pattern allows an explicit `:443`, which the Worker refuses at runtime (`url.origin === value`). This unit refuses it only for a custom-domain pin (decision 1). Elsewhere it is unchanged.
- `cmd_webhook` prints the endpoint's URL but does not compare it with `origins.api` (step 11). A check there would be a small, separate unit.
- `cf-deploy.sh` does not compare `VITE_STOREFRONT_ORIGIN` with `origins.web` (step 9).
- 8 existing cases are written for today's pins and fail on the day with HEAD's suite as well: see "The test suite on the day", which gives the smallest fix for each.
- The runbook's text about the preflight (§2.1 row 6, §2.5, blockers 2 and 35) is out of date after this unit; this unit may not edit it.

## Build log

1. **Read.**
   - The runbook: decision 1.1, §2.0–§2.8, §6.3, §10 blockers 2 and 35.
   - The preflight, whole.
   - `guard/preflight.test.sh`, whole: its fakes, fixture builders and real-file cases.
   - The three `wrangler.jsonc`, the two pinned files and `cf-deploy.sh` (it compares no origin).
   - The guard's patterns.
   - The migrate tests that read the preflight: `launch-gate.test.mjs` extracts the `PY` heredoc and the `LAUNCH_REQUIRED` line.
2. **Baselines at the untouched tree:** preflight 302/0 (71 s), deploy 90/0, guard PASS (allowlist 294), migrate 554/0.
3. **Read the installed wrangler 4.123.0, locally:**
   - `CustomDomainRoute` allows `pattern`, `custom_domain`, `enabled` and `previews_enabled`;
   - `routes` and `route` are inheritable and mutually exclusive;
   - `workers_dev` defaults to `routes.length === 0`.
4. **Script:** `check_route`, its two calls, the production allowlist and the header's "addresses". The extracted `PY` helper compiles; `bash -n` is clean.
5. **The existing suite against the new script: 300/2.** The two admin production cases deployed `ADMIN_PROD_ORIGIN = https://admin.prod.test.invalid`, a custom host, with no route: the new rule's refusal. I moved the fixture to the workers.dev placeholder.
6. **Tests added; first run 439/3.** Three fixtures hit bash 3.2's brace expansion. The Python edit failed and the harness silently used the default fixture, which then deployed. I routed them through variables: 442/0, 0 tracebacks.
7. **Pin independence.** The workers.dev-pin cases now pin the placeholders themselves (`W_*`) instead of reading the repository's production origins, which change on the day.
8. **Messages read whole.** A scratch copy of the suite printed every refusal line; each one read as intended.
9. **wrangler's custom-domain conflict handling.** Read `publishCustomDomains`: without a terminal it overrides another Worker's domain and conflicting DNS records, and it is not called with no custom-domain route. I made the shared-host message say so, and the web/admin `workers_dev` message now ends "when there is no route".
10. **Mutations M1–M19**, four parallel groups in scratch mini-repos: all killed. The real script compared equal with `cmp` to its saved copy.
11. **Rehearsal of the day, both modes.**
    - HEAD: 294/8. This unit: 421/16, the same 8 plus 8 from fixtures with no route.
    - The fixture builders now add the route on a custom pin. Today's fixtures stay byte-identical (generated from both files and compared).
    - Re-run: 429/8, set-identical to HEAD's.
12. **Gates after the last edit:** preflight 442/0, deploy 90/0, guard PASS (294), migrate 554/0. Forbidden-word search of the report and the added lines: no match. `git status`: the two files changed and this report; nothing else.
