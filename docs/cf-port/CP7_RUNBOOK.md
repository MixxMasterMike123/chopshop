# CP7 — the cutover runbook (PREPARED, NOT EXECUTED)

**Status, 2026-10-04:** this document has been written and nothing in it has been run. Nothing was created, written or deployed in production, in Firebase or in Stripe live mode. The only things run were the offline rehearsal and the test suite (§3.2). **The cutover cannot be executed today.** §10 lists what stops it, with an owner beside each item. Read §0 and §10 first.

**Written from:** branch `cf-port` at `7b7ef29d` (other builders had uncommitted files in the tree; this document depends on none of them). The sources are cited by path at each step, so every claim can be checked. Where a claim could not be checked in the repository, the text says **not verified**.

**Who executes it:** Mikael, with an AI orchestrator beside him. Run each step as written, in order.

---

## How to read this document

**Markers.**
- **NEEDS MIKAEL'S GO** — the step touches production: Cloudflare production, Stripe live mode, the Firebase project, a real domain's DNS, or production data (reading it counts too). Stop before it. Mikael says "go" for that step. Write his words and the time into the cutover log, then run it. **Nothing chains past such a mark.** A go for one step is not a go for the next one.
- **LOCAL** — runs on the Mac against local files only.
- **READ-ONLY** — reads something remote and changes nothing.

**Places.**
- `$REPO` = `/Users/mikaelohlen/Cursor Apps/chopshop`. Quote it, because the path has a space. Every command runs from `$REPO` unless the step says otherwise.
- `$W` = the cutover work directory, `~/chopshop-export/cutover-<YYYY-MM-DD>/`, created with `mkdir -m 700`. It is outside the repository. Plans, states and query results hold e-mail addresses, so they never go inside the repository.
- `$B` = the export bundle made on the day (§5.2), `~/chopshop-export/export-<timestamp>/`.
- **The cutover log** = `$W/cutover-log.md`. Write one line per step: time, step number, result, and who gave the go.
- `$FB_PROJECT` = the Firebase project id, and `$FB_DB` = its named Firestore database. They are not written out here because the repository's guard refuses the old brand's name in new files (`guard/guards.test.mjs`, PLAN §0). Set both once per shell:

  ```
  FB_PROJECT=$(python3 -c "import json; print(json.load(open('.firebaserc'))['projects']['default'])")
  FB_DB=$(sed -n "s/.*['\"]\([a-z0-9-]*-db\)['\"].*/\1/p" functions/src/config/database.ts | head -1)
  echo "$FB_PROJECT $FB_DB"      # check both printed before going on
  ```

  Both lines were tried on 2026-10-04 and print the right values. If either prints nothing, read the value from the file by eye.

**Terms, defined once.**
- **Worker**: a Cloudflare program. There are three: `chopshop-api` (the API), `chopshop-web` (the storefront), `chopshop-admin` (the admin and the platform console).
- **D1**: Cloudflare's database. Production is `chopshop-prod`.
- **R2**: Cloudflare's file storage. Production has three buckets: `chopshop-prod-public`, `-private` and `-production`.
- **The preflight**: `scripts/cf-preflight.sh`, the only allowed way to run `wrangler`. It checks the account, the pinned ids, Stripe and the launch gate, and refuses with one `PREFLIGHT REFUSED: …` line.
- **Pinned file**: `cloudflare/pinned.<env>.json`, the ids the preflight compares against. A `null` in it means "not created yet".
- **Attestation**: git notes on the exact commit (`codex: PASS`, `fable: PASS`, and for production `mikael: GO`). `scripts/cf-deploy.sh` refuses to deploy without them.
- **Time Travel bookmark**: a restore point of a D1 database. Any point in the last 30 days can be restored (`docs/cf-port/D1_BACKUP_RESTORE.md`).
- **PaymentIntent (PI)**: one Stripe payment attempt.
- **Webhook endpoint**: an address Stripe posts events to. Each endpoint has its own signing secret.
- **Connect / connected account**: the shop's own Stripe account. Money goes to it through the platform.
- **Launch gate**: the list of ids in `docs/SnapWearDocs/LAUNCH_TODO.md` that the preflight requires to be ☑ in production (§2.1).
- **Import run, plan, target state, actual state**:
  - The importers write a `plan.sql` and change nothing themselves.
  - A human applies the plan to D1.
  - The "target state" and "actual state" are JSON files built from read-only queries, taken before and after the apply.
  - The database records each applied plan as one row in `import_runs`.
- **Acting-as**: a platform user who opens a shop's admin. It is audited and lasts 60 minutes.
- **Legal adoption**: the shop's own admin accepts the three legal pages in the admin. Until that happens, the shop takes no checkout.
- **Freeze**: Firebase stops taking orders, and nothing writes the data that will be exported.
- **Point of no return**: the first order created on Cloudflare (§0).

---

## 0. Summary

**What the cutover does.**
1. Firebase stops taking orders. This is reversible.
2. Its data is exported, imported into the empty production D1, and its files are copied into R2.
3. Stripe's events are moved to Cloudflare, the addresses are moved, the users set new passwords, and the seller adopts the legal pages.
4. A real small purchase and its refund prove the money path.

Nothing in Firebase is deleted. It becomes a read-only archive (§9), and any deletion needs Mikael's explicit go later.

**Phases and expected times.** These are estimates. They are based on how long the same steps took on staging, read from `docs/cf-port/HANDOVER.md` and from the file times in `~/chopshop-export/`. Production D1 is assumed to be as fast as staging's.

| Phase | Section | Expected | Based on |
|---|---|---|---|
| Decisions and inputs | §1 | before the day | — |
| Build the missing pieces | §10 | weeks, not estimated | — |
| Production environment | §2 | half a day of Mikael's time, plus one reviewed config commit | CP1 bootstrap took one evening (`CP1_BOOTSTRAP.md`) |
| Rehearsal on a scratch database | §3 | 15 minutes per run | today's run took 8 s locally; the export read takes longer |
| **Day:** freeze | §4 | 30 minutes of work, plus the drain wait. Start the evening before, so open payments drain overnight | the Firebase sweep runs every 15 minutes (`functions/src/checkout-recovery/sweep.ts:45-51`) |
| **Day:** export, import, verify | §5 | 2 to 2.5 hours | staging: CP3 plan to verify in 33 min (00:49 to 01:22, 2026-09-28); file copy 7 min 20 s; catalogue 8 min; re-screen 9 calls; studio assets 41 s |
| **Day:** switch | §6 | 1 to 2 hours, depending on mail delivery and Kent's availability | — |
| **Day:** smoke | §7 | 1 hour, plus a 24-hour watch | — |

**Point of no return: the first order created on Cloudflare.** That is the smoke purchase in §7.3, or a buyer's order if the shop opens before it.
- **Until then:** the rollback in §8.1 brings Firebase back.
- **After it:** forward-fix only (§8.2). Migration 0052 refuses every production import run once production holds an order, a payment event or a checkout (`MIGRATION_MANIFEST.md` §d P2, P7), and a second completed run of either kind (platform, catalogue) in any case.

**Go/no-go list.** Every line must be "yes" before §4 starts. Mikael ticks it in the cutover log.

1. Every blocker in §10 marked **blocks cutover** is closed.
2. The launch gate passes, or Mikael has narrowed it (decision 1.3) and the preflight change is merged and attested.
3. The §3 rehearsal passed on an export no older than 48 hours, with the tools at the SHA that will be used.
4. The production environment (§2) is complete: `scripts/cf-preflight.sh production -- whoami` prints `preflight: OK`.
5. **Mail works in production.** A password-reset mail from the production Worker reached a real inbox, and its link opened the production admin. Users are recreated with no password, so nobody signs in without this mail. The only exception is the bootstrap path of decision 1.11.
6. **Stripe:**
   - the live key file exists;
   - both webhook endpoints are created, pinned and disabled;
   - D49 has been checked on the live account;
   - melodie-mc's connected account was read live, and its `charges_enabled` is true.
7. Kent is available on the day. He must:
   - set his password;
   - accept the platform terms;
   - enter the return address and the VAT answer;
   - adopt the legal pages.

   Without all four, melodie-mc's checkout stays closed.
8. **POD is off at go-live** (decision 1.4). The SnapWear submit client is not confirmed, so the six POD products stay unmapped and hidden in production, and the `pod` feature is off.
9. The freeze method is chosen (decision 1.12), and the pre-freeze `main` SHA is recorded as the rollback artifact.
10. The SHA to deploy carries `codex: PASS`, `fable: PASS` and `mikael: GO`.
11. The Firebase Stripe webhook endpoint's id is known. It is not in the repository; find it in the Stripe Dashboard.
12. Staging has run the same SHA for at least 48 hours with no open alert (the staging soak of PLAN CP7). 48 hours is a recommendation, not a recorded decision.

---

## 1. Decisions and inputs needed before the day

Each decision has a recommended default and names who decides. "Blocks" says what stays impossible until the decision is made.

| # | Decision | Recommended default | Who | Blocks |
|---|---|---|---|---|
| 1.1 | **The platform domain**, and the host names under it: API, storefront, admin, images. **Not decided.** `melodiemc.com` is Kent's artist website and has nothing to do with ChopShop (D85). It is never used and never changed. PLAN §10's CP7 row ("DNS (melodiemc.com first)") and D7b are wrong about it. The shop `melodie-mc` has no domain of its own. | A neutral domain registered for this purpose only, with its zone on Kent's Cloudflare account (D89). Suggested names: `api.`, `shop.`, `admin.`, `img.`. **Fallback for day one:** the `*.kent-ee2.workers.dev` hosts. The preflight cannot do that today: blocker 2. | Mikael | Admin deploy, mail domain, R2 public address, Stripe endpoint URLs |
| 1.2 | **Mail:** the Resend account (Kent's account was named on 2026-09-28) and the sending domain for `EMAIL_FROM`. | A subdomain of the platform domain (for example `mail.<domain>`), verified at Resend. `EMAIL_FROM = ChopShop <no-reply@mail.<domain>>`. | Mikael, Kent | Resets, invites, order mails, alert digest |
| 1.3 | **What the launch gate covers.** PLAN §0 requires A1–A7, A9–A11, A13–A14 and B1–B10 of `LAUNCH_TODO.md` to be ☑. The preflight applies this to **every** non-bootstrap production command, including `deploy` and `secret put` (`scripts/cf-preflight.sh:648-651`). 13 required items are not ☑: A5 ⏸, A6 ⏸, A7 ☐, B1–B5 ☐, B6 ◐, B7–B10 ☐. `LAUNCH_TODO.md` line 6 scopes the rule to "a SnapWear-routed order". | **Narrow the gate to POD.** Production may be set up and opened for non-POD sales while POD is off. The full gate still applies before any shop's `pod` feature is switched on. This needs a PLAN §0 edit and a reviewed preflight change. | Mikael | Everything in production after D1, R2 and queues |
| 1.4 | **POD at go-live.** | **Off.** The six POD products of melodie-mc stay unmapped, so they are hidden by the public predicate (D83). The `pod` feature is off for every shop. It goes on only after SnapWear answers C1–C9, the real client is tested against their API, and the full gate passes. | Mikael | — |
| 1.5 | **EUR rate and buffer** for the SnapWear offer. | 11.20 SEK/EUR plus 3 % (B9a; `FULL_EUR_APPLY` in `cloudflare/test/printer-catalog.test.ts:222-248`). Confirm on the day it is applied. With POD off, the apply can wait until POD is switched on. | Mikael | POD-on only |
| 1.6 | **Garment and colour table** of the six POD products. Staging assumed the unisex tee, catalogue model `64000`, and its colours. | Kent confirms. 17 variants could not be mapped on staging (§5.10). Kent decides whether to drop or merge them. | Kent | POD-on only |
| 1.7 | **Who adopts legal pages, and when.** | Kent, for melodie-mc, on the day, right after his password reset (§6.6). The other three shops have no carried admin. They stay unpublished, as in the source, until each has an admin who adopts. | Kent, Mikael | melodie-mc's checkout |
| 1.8 | **How long Firebase stays as an archive.** PLAN says 14 days, and that is a minimum. | At least until the archive in R2 is written and verified (§9.2). Recommended: no less than 90 days, and past the DAC7 filing on 31 Jan 2027. The 90 days is this document's recommendation, not a recorded decision. Orders have a 7-year retention whatever is chosen (Bokföringslagen; manifest §c). | Mikael | Deletion only |
| 1.9 | **Stripe key type for the Worker.** | A **restricted** live key (PLAN §6). Staging always used a full `sk_test_` key (D34), so no restricted key has ever been tried. Rehearse the same permission set on staging first, with an `rk_test_` key and a seed purchase plus refund. | Mikael | §2.3 |
| 1.10 | **Stripe API version.** The Worker speaks `2026-07-29.dahlia` (`cloudflare/src/commerce/stripe-client.ts:13-22`). Firebase and its live endpoint use `2023-10-16`. | Create the Cloudflare endpoints on `2026-07-29.dahlia` and leave Firebase's as it is. The note in `stripe-client.ts` asks for this to be one explicit decision. | Mikael | §2.4 |
| 1.11 | **The first sign-in to production.** Imported users have no password (`transform-users.mjs`: `account.password = NULL`). | (a) **Bootstrap** Mikael's platform admin on production **before** the import, with the same address his Firebase account has. The importer then **adopts** that user (D59, `transform-users.mjs` lines 26-30) and keeps the password chosen at bootstrap. This takes mail out of the operator's path. With a **different** address, production ends with 3 platform admins and `verify.mjs` item #14 fails: it expects exactly 2 (`verify.mjs:63-64`). **Not rehearsed with real data:** rehearse it on a scratch database first (blocker 19). (b) The fallback: "Glömt lösenord" after the import, which needs mail. | Mikael | §6.4 |
| 1.12 | **The freeze method.** Firebase has **no** platform-wide switch. The only no-code stop is per shop: `published === false` or `status === 'disabled'`, which `createPaymentIntentV2` checks (`functions/src/payment/createPaymentIntent.ts:45-48`, refusal at `:507-513`). | **(A) The no-code freeze** (§4.3–§4.8): hide the published shop, drain, pause the three schedules, disable the Firebase webhook endpoint, ask people to stop editing, and prove it with a double export. Each step is undone in minutes. **(B) A frozen Firebase build** (§4.9) is PLAN's artifact. It is not built, and is optional for a platform of this size. | Mikael | §4 |
| 1.13 | **The old Firebase addresses after the switch** (`meteorpr.web.app` admin, `shop-meteorpr.web.app` storefront, `platform-meteorpr`, `print-meteorpr`). | Redirect each to the matching Cloudflare host. This is a Firebase Hosting deploy from `main` (§6.3). Which old paths exist and where each lands is **not verified** (blocker 24). | Mikael | §6.3 |
| 1.14 | **The day and the time window.** | A weekday morning with low traffic. Start the freeze the evening before (§4.4 drain). Kent is reachable all day. | Mikael, Kent | — |
| 1.15 | **Open decisions that touch go-live but do not block it:** D68 (personal data in evidence rows), D97 (d) (withdrawal for a suspended shop), B11/D8 (screening policy), D91 (commission), D101, and the publication texts (`CP5_FX_REPORT.md`). | Their defaults stand until Mikael says otherwise. | Mikael | — |

---

## 2. Production environment — to create

### 2.0 What exists and what does not

**Exists.** Created 2026-09-26 (`docs/cf-port/CP1_BOOTSTRAP.md` §1), pinned in `cloudflare/pinned.production.json`:
- account `ee213082783ec86585150e876edb6107`;
- D1 `chopshop-prod` (`6216ebd9-…`, EU). It is **empty: no migration has been applied, and nothing has been run against it**;
- R2 buckets `chopshop-prod-public`, `-private` and `-production` (EU);
- queues `chopshop-prod-outbox`, `-email` and `-render-jobs`;
- Worker names `chopshop-api`, `chopshop-web` and `chopshop-admin`. HANDOVER records no production deploy;
- `stripeMode: live`;
- `dispatchTarget: snapwear`.

**`null` in `pinned.production.json`, meaning work to do:**

| Key | What it becomes | Step |
|---|---|---|
| `stripeAccountId` | the live platform account `acct_…` | 2.3 |
| `stripeWebhookEndpointId` | the platform endpoint `we_…` | 2.4 |
| `stripeConnectWebhookEndpointId` | the Connect endpoint `we_…` | 2.4 |
| `r2.publicBaseUrl` | the public bucket's origin | 2.6 |
| `origins.admin` | the admin origin | 2.5 |

**Inconsistent today**, to fix in the config commit (§2.8):
- `origins.api` and `origins.web` are pinned to `chopshop-api.kent-ee2.workers.dev` and `chopshop-web.kent-ee2.workers.dev`. But all three production configs set `"workers_dev": false`, so those hosts would not answer (`cloudflare/wrangler.jsonc` env.production, `cloudflare/web/wrangler.jsonc`, `cloudflare/admin/wrangler.jsonc`).
- The API **must** have a public address. Stripe posts to `/v1/webhooks/stripe`, and the render container pulls jobs from the API's canonical origin over the public internet (`cloudflare/src/render/render-container.ts:25-27,57-77`).
- `env.production.vars.CANONICAL_ORIGINS` has no `admin` key, and `AUTH_TRUSTED_ORIGINS` has no admin origin. Reset and invite links land on the admin origin, and Better Auth refuses a sign-in from an origin it does not trust.
- `PUBLIC_OBJECT_BASE_URL` is absent from all three production configs. There is a comment where it belongs.

**Files that do not exist yet** in `~/.config/chopshop/`. Each is mode 600 and holds only names and values:
- `stripe.production.env` (`STRIPE_SECRET_KEY`);
- `web.production.env` (`VITE_STRIPE_PUBLISHABLE_KEY=pk_live_…`, `VITE_PLATFORM_LEGAL_NAME`, `VITE_PLATFORM_ORG_NUMBER`);
- `admin.production.env` (`VITE_STOREFRONT_ORIGIN`, and `VITE_STRIPE_PUBLISHABLE_KEY=pk_live_…`: `cf-deploy.sh` refuses a blank one, HANDOVER 2026-10-04 00:05);
- `secrets.production.env`, for the generated secrets before they are put on the Worker.

### 2.1 What the preflight refuses in production today, and what lifts each refusal

| Refusal | Where | What lifts it |
|---|---|---|
| `launch gate: … items not marked done: A5, A6, A7, B1, B2, B3, B4, B5, B6, B7, B8, B9, B10` for **every** production command without `--bootstrap`, including `deploy`, `secret`, `d1 execute` and `tail` | `scripts/cf-preflight.sh:569-594, 648-651` | All 13 ☑, or decision 1.3 plus a preflight change (blocker 1) |
| `still has null (not yet created) values` | `:331-332` | §2.3–§2.6 and the pinning commit §2.8 |
| `no …/stripe.production.env` | `:686-687` | §2.3 |
| Under `--bootstrap`, when `stripe.production.env` exists but `stripeAccountId` is null: "the Stripe key … belongs to acct_…, pinned stripeAccountId is null" | `:659-672`; the file is checked even under `--bootstrap` | Pin `stripeAccountId` **before** creating the file, or keep the file away until it is pinned |
| `--admin`: `origins.admin is null` | `:327-330` | §2.5 and §2.8 |
| `--web` / `--admin` in production: `workers_dev` and `preview_urls` must be `false`, and `routes` is not an allowed key | `:482, 501-503, 522-526` | **Neither the workers.dev fallback nor a custom domain can be declared for these two Workers today.** Blocker 2: a reviewed preflight extension |
| `secret` under `--bootstrap` | `:127-131` | Not liftable by design: secrets need the full checks, so they wait for blocker 1 |

**What runs today under `--bootstrap`, without the launch gate:** `whoami`, `d1`, `r2` and `queues` only. Migrations, Time Travel, `d1 execute`, R2 public address and CORS are therefore possible before the gate is solved. Deploys and secrets are not.

### 2.2 Step order

```
2.3 Stripe live: account id, key           ─┐
2.4 Stripe endpoints (created, then disabled)│
2.5 Domain / addresses (decision 1.1)        ├─ 2.8 one reviewed config commit (pins + vars)
2.6 R2 public address + CORS                 │
2.7 R2 API token, mail domain, Resend key   ─┘
2.9 D1 migrations (bootstrap)  ── 2.10 first deploy (dark) ── 2.11 secrets ── 2.12 checks ── 2.13 mail proof
```

### 2.3 Stripe live: the account id and the key — NEEDS MIKAEL'S GO

**Where:** the Stripe Dashboard in **live** mode, then the Mac.

1. Read the live platform account's id: Dashboard → Settings → Business → Account details, `acct_…`. Write it into `$W/cutover-log.md`. It is an id, not a secret.
2. **D49: check Accounts v1 on the LIVE platform.** Path: Dashboard → Settings → Developers → API policies → "Accounts v1 support". D49 says it was enabled in Testläge (test mode), which shares settings with live. Look at it in live mode and write down what it says. Existing connected accounts are carried by id, so this matters only for a **new** seller's onboarding.
3. Create the Worker's key, decision 1.9: Dashboard → Developers → API keys → Create restricted key, name `chopshop-cf-production`.
   - **Permissions:** the Worker calls PaymentIntents (write), Refunds (write), Charges and Disputes (read), Application fees and their refunds (write; D36 releases), Transfers and reversals (write), Connected accounts, Account links and Login links (write; onboarding and payout schedule), Balance (read), Webhook endpoints (read; the preflight reads them).
   - This list is derived from the Worker's calls and **was never tried as a restricted key (not verified)**. Rehearse it on staging first with an `rk_test_` key.
4. Write the key into `~/.config/chopshop/stripe.production.env` (`STRIPE_SECRET_KEY=rk_live_…`), then `chmod 600` it. **Do this only after the account id is pinned** (§2.1, row 4). Until then, keep the key in the Dashboard.

- **Expect:** after §2.8, `scripts/cf-preflight.sh production --bootstrap -- whoami` prints `preflight: Stripe key belongs to the pinned live account acct_…`.
- **If not:** the line names the account the key belongs to. A wrong account means a key of another Stripe account was pasted.
- **Undo:** delete the restricted key in the Dashboard, and delete the file.

### 2.4 Stripe live: the two webhook endpoints — NEEDS MIKAEL'S GO

Two endpoints, because Stripe sends platform events only to an endpoint created without Connect, and connected-account events only to one created with Connect (D39).

**Where:** Dashboard → Developers → Webhooks → Add endpoint, in live mode. The API (`POST /v1/webhook_endpoints`) works too.

| | Platform endpoint | Connect endpoint |
|---|---|---|
| URL | `<API origin>/v1/webhooks/stripe` | the same URL |
| Listen to | events on **your account** | events on **connected accounts** |
| API version | `2026-07-29.dahlia` (decision 1.10) | the same |
| Events | `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `application_fee.refunded`, `application_fee.refund.updated` (12, as on staging: HANDOVER CP2; handled in `cloudflare/src/commerce/`) | `account.updated` |

1. Create both. Copy each signing secret (`whsec_…`) into `~/.config/chopshop/secrets.production.env` as `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET`.
2. **Disable both at once**, until §6.1. They would otherwise receive live events, including events about Firebase-era payments and melodie-mc's `account.updated`, before the Worker exists. Stripe would mark them failing.
3. Write both `we_…` ids into the cutover log for the pinning commit.

- **Expect:** after §2.8, the preflight prints `pinned Stripe webhook endpoint we_… exists: disabled -> https://…/v1/webhooks/stripe`, and the same for CONNECT. The preflight checks existence, not that the endpoint is enabled (`:562-567`).
- **Undo:** delete both endpoints.

### 2.5 Addresses: the platform domain, or the fallback — NEEDS MIKAEL'S GO

**With a decided domain (1.1):**
1. Add the zone to Kent's Cloudflare account (Dashboard → Add a site), and set the registrar's name servers to the two Cloudflare gives.
   - **Expect:** the zone reads "Active" (minutes to hours).
   - The project token already has DNS Edit (D5b).
2. The host names become:
   - `origins.api = https://api.<domain>`;
   - `origins.web = https://shop.<domain>`;
   - `origins.admin = https://admin.<domain>`.

   They are attached to the Workers as custom domains:
   - **API:** a `routes` entry with `custom_domain: true` in `cloudflare/wrangler.jsonc` env.production. The API's check (`cmd_jsonc`) has no key allowlist, but this is **not verified** by a preflight test.
   - **Web and admin:** **refused by the preflight today** (blocker 2). The preflight must be extended to accept exactly one pinned custom-domain route per Worker.
   - Adding the custom domain in the Dashboard instead may survive later `wrangler deploy` runs. That is **not verified**; do not rely on it.

**Fallback, workers.dev for day one:** set `workers_dev: true` in all three production configs. The pinned `api` and `web` origins already name these hosts; `origins.admin` becomes `https://chopshop-admin.kent-ee2.workers.dev`. **Refused by the preflight today for web and admin** (`:522-526`), so this is also blocker 2. The API's check does not look at `workers_dev`.

**Never:** `melodiemc.com` (D85).

**Undo:** remove the custom domains or the zone. Nothing points at them yet.

### 2.6 R2: the public address and CORS — NEEDS MIKAEL'S GO

The public bucket needs an origin. Images, logos and covers are served from it: `PUBLIC_OBJECT_BASE_URL`, D78.

**With the domain:**
```
scripts/cf-preflight.sh production --bootstrap -- r2 bucket domain add chopshop-prod-public --domain img.<domain> --zone-id <zone id> --jurisdiction eu
```
**Fallback:**
```
scripts/cf-preflight.sh production --bootstrap -- r2 bucket dev-url enable chopshop-prod-public --jurisdiction eu
```
The second form is the command staging used (D95). It prints the `https://pub-….r2.dev` address. Cloudflare documents that address as rate-limited and meant for development; that was **not re-checked today**.

- **Expect:** the address answers 404 for a key that does not exist, as staging's did.
- Write the origin (no path, no trailing slash) into the log for §2.8.

**CORS (cross-origin rules):** GET and HEAD from the admin origin only, on `chopshop-prod-public` and `chopshop-prod-private`, as staging got on 2026-10-04 (HANDOVER "Update 03:35"). Staging's rule file lived in a session scratchpad and is gone.
1. Read the current rules: `scripts/cf-preflight.sh production --bootstrap -- r2 bucket cors list chopshop-prod-public --jurisdiction eu`. Expect none.
2. Write the file in the shape `r2 bucket cors set --help` documents. **Not verified here.**
3. Set it on both buckets: `… r2 bucket cors set <bucket> --file <file> --jurisdiction eu`.
4. Read back with `cors list`.

**Undo:** `r2 bucket cors delete <bucket> --jurisdiction eu`; `r2 bucket dev-url disable …` or `r2 bucket domain remove …`.

### 2.7 R2 API token, Resend, and the mail domain — NEEDS MIKAEL'S GO

1. **R2 API token for presigning.** The Worker signs upload and download URLs for the render container (`cloudflare/src/env.d.ts`: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`).
   - Create it at Dashboard → R2 → Manage API tokens: Object Read & Write, limited to the three `chopshop-prod-*` buckets, EU jurisdiction.
   - Put both values into `secrets.production.env`.
2. **Resend.**
   - Add the sending domain (1.2) at Resend. Put its DNS records (SPF, DKIM, and the return-path record Resend lists) on the zone, and wait for "Verified".
   - Create a **sending-only** API key named `chopshop-cf-production` and put it into `secrets.production.env` as `RESEND_API_KEY`.
   - Write `EMAIL_FROM` there too.
3. **Expect:** Resend shows the domain as Verified.
4. **Undo:** revoke the R2 token and the Resend key.

### 2.8 The config commit: pins and vars — LOCAL, then review

One commit on `cf-port`. It holds only these edits:
- `cloudflare/pinned.production.json`: `stripeAccountId`, `stripeWebhookEndpointId`, `stripeConnectWebhookEndpointId`, `origins.api`, `origins.web`, `origins.admin`, `r2.publicBaseUrl`.
- `cloudflare/wrangler.jsonc` env.production.vars:
  - `CANONICAL_ORIGINS` gets `{api, web, admin}`, deep-equal to the pinned origins;
  - `AUTH_BASE_URL` = api;
  - `AUTH_TRUSTED_ORIGINS` = `api,web,admin`;
  - `PUBLIC_OBJECT_BASE_URL` = the pinned base;
  - plus `workers_dev` or `routes` per §2.5.

  `PLATFORM_ALERT_EMAIL` is already set. `DISPATCH_TARGET` stays `snapwear`; the preflight refuses anything else in production (`:323-324`).
- `cloudflare/web/wrangler.jsonc` env.production.vars: `WEB_ORIGIN`, `PUBLIC_OBJECT_BASE_URL`.
- `cloudflare/admin/wrangler.jsonc` env.production.vars: `ADMIN_ORIGIN`, `PUBLIC_OBJECT_BASE_URL`.

**Gate (LOCAL):** `bash guard/preflight.test.sh` and `bash guard/deploy.test.sh`. Both include cases that check the repository's real `wrangler.jsonc` files against the real pinned files for both envs (`CP1_BOOTSTRAP.md` §5). Then Codex, Fable, and the attestation.

- **Expect:** the read-only checks `scripts/cf-preflight.sh production --bootstrap -- whoami` and `scripts/cf-preflight.sh production --bootstrap -- d1 list` print `preflight: OK (BOOTSTRAP: …)` with no null listed.
- **Undo:** revert the commit.

### 2.9 Migrations on production D1 — NEEDS MIKAEL'S GO

**Where:** terminal, `$REPO`. `--bootstrap` is used because `d1` is allowed under it and the launch gate is not run (§2.1). `D1_BACKUP_RESTORE.md` uses the same form for production.

```
scripts/cf-preflight.sh production --bootstrap -- d1 time-travel info chopshop-prod      > $W/bookmark-before-migrations.txt
scripts/cf-preflight.sh production --bootstrap -- d1 migrations list chopshop-prod --remote
scripts/cf-preflight.sh production --bootstrap -- d1 migrations apply chopshop-prod --remote
scripts/cf-preflight.sh production --bootstrap -- d1 execute chopshop-prod --remote --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"
```

- **Expect:** `list` shows 48 to apply: `0001_platform_foundation.sql` … `0050_email_kinds.sql`. There is no `0020` and no `0047`; both gaps are deliberate (HANDOVER: "0047 is skipped for good"). `apply` ends with every file ✅. The last query returns `0050_email_kinds.sql`.
- **Note:** `migrations list` creates the `d1_migrations` table. That is fine now; `CP1_BOOTSTRAP.md` §4 avoided it only while the database was meant to stay untouched.
- **If not:** a failed file stops the apply, and the files before it stay applied. Read the error. Do not edit a committed migration; fix forward with a new numbered file.
- **Undo:** the database holds no data yet. Restore to the bookmark:

  ```
  printf 'y\n' | scripts/cf-preflight.sh production --bootstrap -- d1 time-travel restore chopshop-prod --bookmark=<bookmark>
  ```

### 2.10 The first deploy, dark — NEEDS MIKAEL'S GO

**Needs:** blocker 1 solved, §2.8 merged, a clean checkout, Docker Desktop running (the render container image is built at deploy), and `web.production.env` plus `admin.production.env`.

**Where:** a clean git worktree of the attested SHA, with **copies** of both `node_modules`. This is how staging was deployed while builders were writing in the tree (HANDOVER 2026-10-03 19:10).

```
git notes --ref=reviews append -m "mikael: GO" HEAD && git push origin refs/notes/reviews     # only on Mikael's go for this SHA
scripts/cf-deploy.sh production
```

- **Expect:** the output prints, in order:
  - `deploy: production all — HEAD <sha> reviewed (codex: PASS, fable: PASS, mikael: GO)`;
  - `deploy: production — API Worker deployed`;
  - `… web Worker deployed`;
  - `… admin Worker deployed`.
- **Expect, live checks:**
  - `curl -s <api origin>/health` reports `production`.
  - `curl -s <api origin>/ready` names `0050_email_kinds.sql`.
- **Every surface is dark until its secret exists** (`cloudflare/src/env.d.ts`: fail-closed everywhere).
- **If not:** `DEPLOY FAILED: …` says what this run did deploy. A refusal before step a deployed nothing.
- **Undo:** `scripts/cf-preflight.sh production -- deployments list` and `… -- rollback`, or `… versions deploy <previous>`. For the first deploy there is no previous version: leave it dark, or delete the Worker in the Dashboard.

### 2.11 Secrets — NEEDS MIKAEL'S GO

**Order:** only after §2.10. A `secret put` on a Worker that does not exist creates an ungated stub Worker (`CP1_BOOTSTRAP.md` §6).

**Pattern.** The value never appears on a command line:
```
openssl rand -base64 48 | tr -d '\n' | scripts/cf-preflight.sh production -- secret put BETTER_AUTH_SECRET
scripts/cf-preflight.sh production -- secret put STRIPE_SECRET_KEY        # paste at the prompt
```

| Name | Where its value comes from |
|---|---|
| `BETTER_AUTH_SECRET` | generated fresh, at least 32 characters; never staging's |
| `STRIPE_SECRET_KEY` | §2.3, the live restricted key |
| `STRIPE_WEBHOOK_SECRET` | §2.4, the platform endpoint's signing secret |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | §2.4, the Connect endpoint's signing secret |
| `RESEND_API_KEY` | §2.7 |
| `EMAIL_FROM` | §2.7, an address on the verified domain (it may be a var instead) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | §2.7 |
| `RENDER_FARM_TOKEN` | generated fresh, at least 32 characters (`cloudflare/src/pod/render-jobs.ts`) |
| `BOOTSTRAP_TOKEN` | only for decision 1.11 (a); generated, at least 32 characters; **deleted after use** |

**Not in production:**
- `FAKE_PRINTER_TOKEN`: staging only (`cloudflare/src/dispatch/fake-printer.ts:33-40`).
- `RENDER_FARM_URL`: not needed by the pull model (`cloudflare/src/app.ts`, `isAdminPodSurfaceConfigured`).
- The SnapWear API token: its name is not decided yet. The real client is being built (A6: header `x-api-token`).

- **Expect:** `scripts/cf-preflight.sh production -- secret list` shows the names above (never the values).
- **Undo:** `… secret delete <NAME>`.

### 2.12 Checks after the secrets — READ-ONLY

- `curl -s -o /dev/null -w '%{http_code}\n' <api origin>/v1/me` → `401`.
- `curl -s -o /dev/null -w '%{http_code}\n' <admin origin>/login` → `200`.
- `scripts/cf-preflight.sh production -- queues list` shows each of the three queues with a consumer.
- The deploy output listed the cron `*/15 * * * *`.

### 2.13 Mail proof (go/no-go item 5) — NEEDS MIKAEL'S GO

**With decision 1.11 (a):**
1. Bootstrap Mikael's platform admin.
2. Sign out.
3. Use "Glömt lösenord" on `<admin origin>/login` with that address.

The bootstrap call goes to the API host itself. The admin proxy refuses `/v1/platform/bootstrap` (`cloudflare/admin/src/allowlist.ts:52`).

Save the following as `$W/bootstrap.py` (mode 600) and run `python3 $W/bootstrap.py`. It reads the token from the file and asks for the password without echoing it, so nothing lands on a command line or in the shell history:
```
import getpass, json, os, urllib.error, urllib.request
vals = {}
for line in open(os.path.expanduser('~/.config/chopshop/secrets.production.env')):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.rstrip('\n').split('=', 1)
        vals[k.strip()] = v.strip()
api = input('API origin (https://…, no trailing slash): ').strip()
body = json.dumps({'email': input('address (the SAME as the Firebase platform account): ').strip(),
                   'name': input('name: ').strip(),
                   'password': getpass.getpass('password (12–128 characters): ')}).encode()
req = urllib.request.Request(api + '/v1/platform/bootstrap', data=body, method='POST',
                             headers={'content-type': 'application/json', 'x-bootstrap-token': vals['BOOTSTRAP_TOKEN']})
try:
    print(urllib.request.urlopen(req, timeout=30).status)
except urllib.error.HTTPError as error:
    print(error.code)
```
The route was proven on staging with curl in CP1 (201, HANDOVER CP1). **This script itself has not been run** (blocker 37).

- **Expect:** `201`. A `404` means one of three things: the token is wrong or shorter than 32 characters, `BETTER_AUTH_SECRET` is missing, or a platform admin already exists. The route answers all three the same way on purpose (`bootstrap.ts:161-185`).
- **Then:** `scripts/cf-preflight.sh production -- secret delete BOOTSTRAP_TOKEN`. The route answers an opaque 404 forever after, because one platform admin exists (`cloudflare/src/platform/bootstrap.ts:146-188`).

**Expect for the mail itself:** it arrives within minutes, its link opens `<admin origin>/reset-password/…`, and a new password works.

**If not:** Resend's dashboard shows whether the send happened. The `email_deliveries` row shows pending or failed:
```
scripts/cf-preflight.sh production --bootstrap -- d1 execute chopshop-prod --remote --command "SELECT kind, status, attempts FROM email_deliveries ORDER BY created_at DESC LIMIT 5"
```
**No-go until it works.**

**Undo (the bootstrapped user):** none is needed. The import adopts it (1.11). Without the import, the user is harmless.

---

## 3. Rehearsal on a scratch database

### 3.1 How the earlier rehearsals were done

- **CP3, 2026-09-27** (`docs/cf-port/CP3_S_REPORT.md` §10.7; `~/chopshop-export/rehearsal-2026-09-27/`):
  - five read-only target queries on staging;
  - `state-from-queries.mjs`;
  - `import.mjs --env staging --scrub-unmapped --target-state`;
  - the plan executed against `node:sqlite` with every migration applied and a pre-state like staging's.

  862 statements applied, none refused. It found three defects before staging did: the published flag, the commission, the VAT rate.
- **Catalogue, 2026-09-28** (`~/chopshop-export/rehearsal-catalogue/rehearse.mjs`): the same, on top of the applied CP3 plan, with an **invented** copy manifest that marks every file as copied (`scripts/cf-port/migrate/test/catalogue-fixtures.mjs`).
- **What no local rehearsal finds:** D1 refuses a compound SELECT of more than five terms; local SQLite does not. The first staging run found it, and a test now holds every state query to five (HANDOVER 2026-09-28 19:10).

### 3.2 Run today (2026-10-04), offline, on the existing bundle — the result

**Driver:** `~/chopshop-export/rehearsal-cp7-2026-10-04/rehearse-cp7.mjs`, outside the repository. It calls the repository's own command-line tools for every plan, state and verify step. The driver itself does only what `wrangler d1 execute` would do: apply the migrations and the plan to a **file** database (`scratch.sqlite`), and run the read-only queries.
- **Bundle:** `~/chopshop-export/export-2026-09-27T15-02-15.414Z` (4 994 documents in 40 collections, 8 Auth users).
- **Target:** a **fresh, empty** database with every migration, which is what production will be. Staging's pre-state had three tenants and two users.
- **Mode:** `--env staging`. The brief forbade any script with `--env production`, even offline (§3.3).

| Step | Result |
|---|---|
| Migrations | 48 applied: `0001` … `0050`, without `0020` and `0047` |
| `import.mjs` (CP3) | exit 0; 864 statements; 285 685 bytes; plan sha256 `f179f0f35ca8…`. It differs from staging's `15406b3f…` because the target state differs: empty here, three tenants there |
| Counts in the plan | tenants with domains, settings and features: 18 rows · users, accounts, identities, memberships, id map: 13 · printers, tiers, catalogue: 325 · pod profiles: 8 · screening terms and settings: 65 · platform defaults: 1 · legal acceptances: 0 · audit events: 0 |
| Report lines | melodie-mc's commission of 5 000 bps is not carried; the platform default applies (D75). Store-identity keys are moved out of the JSON for three shops |
| Apply | no statement refused |
| `verify.mjs` | **16 PASS, 0 FAIL, 9 DEFERRED** (deferred: items 5, 8, 9, 11, 12, 13, 16, 18, 19) |
| The same plan applied again | refused by its first statement ("an import run starts running, once, one at a time") |
| Invented copy manifest | 524 entries, 524 public objects inserted |
| `import-catalogue.mjs` | exit 0; 4 888 statements; 1 665 777 bytes. Products 217, variants 971, tags 26, images 709, publications 205, screening 205, collections 19, members 86, pages 1, store identities 4. Expected public: 205 in the source, 6 POD, **199 once every shop is live** |
| Apply | no statement refused |
| `verify-catalogue.mjs` | **41 PASS, 0 FAIL**. melodie-mc shows 6 public products now, because it is published in the source; the other three show 0 until published |
| The catalogue plan applied again | refused |
| Local times | migrations 0.5 s · CP3 plan 0.2 s · apply 0.9 s · verify 0.2 s · catalogue plan 1.1 s · apply 4.9 s · verify 0.5 s |
| **The second production run** (`import-once-check.mjs` beside the driver; an in-memory database; no tool run) | a first `env='production'` run is completed, then a second one is inserted: **refused, "an import run starts running, once, one at a time"** (0033). This was blocker 3; migration 0052 closes it (§3.5) |
| `node --test "scripts/cf-port/migrate/test/*.test.mjs"` | **454 pass, 0 fail** |

The staging run imported **684** images, not 709: 21 files were missing at the source (sillmans, 404), and the invented manifest marks every file as copied. Staging's catalogue plan therefore had 4 838 statements.

### 3.3 What the rehearsals do not prove

- **§3.2 is staging mode.** The production-mode plans were rehearsed afterwards (§3.5). What production mode changes, read from the code:
  - addresses are carried as they are, and `--email-map` / `--scrub-unmapped` are refused (`lib/scrub.mjs:68-84`; the catalogue too since CP7-T1);
  - live Connect ids and flags are carried **verbatim** (`lib/scrub.mjs:205-207`);
  - `snapwear` is imported **active** and is the default printer (`lib/transform-printers.mjs`, `lib/transform-print-defaults.mjs`; D59, D66);
  - melodie-mc's commission **refuses the plan** unless `--commission-default-for melodie-mc` is passed (`lib/transform-shops.mjs:192`; D75).
- D1's own limits. Only a real D1 shows them.
- **The Worker.** §3.5 runs the copy against the repository's fake API (`scripts/cf-port/migrate/test/fake-staging-api.mjs`), not a Worker, and every source file is answered by the driver itself, never fetched. The studio assets, the legal steps, the re-screen, the printer apply and the Connect refresh go through the Worker and are not rehearsed offline.
- **The real pins.** §3.5 injects `origins.api` and `r2.publicBaseUrl` into the run (a temporary copy of the pinned file outside the repository). The real `cloudflare/pinned.production.json` has `r2.publicBaseUrl` null today, so the catalogue's command refuses (blocker 16), and its `origins.api` host has no address (blocker 2).
- The bootstrap adoption of decision 1.11 (blocker 19).

### 3.4 To repeat it with a fresh export — LOCAL after the export

1. **NEEDS MIKAEL'S GO** (it reads production Firestore and Auth; read-only by design, `scripts/cf-port/migrate/export.mjs:15-20`):

   ```
   (cd functions && npm ci)                       # firebase-admin is loaded from functions/node_modules
   gcloud auth application-default login          # ADC; GOOGLE_CLOUD_PROJECT must be unset or equal to $FB_PROJECT
   node scripts/cf-port/migrate/export.mjs                        # dry run: counts only
   node scripts/cf-port/migrate/export.mjs --apply --out ~/chopshop-export
   ```

   Run it from a **clean** tree. The 2026-09-27 bundle records `dirty: true`.
2. `(cd ~/chopshop-export/export-<ts> && shasum -a 256 -c SHA256SUMS)` → every line `OK`.
3. Copy the driver into a new `~/chopshop-export/rehearsal-cp7-<date>/`, set `B` and `R` at its top, and run `node rehearse-cp7.mjs`.
4. **"Passed" means:**
   - `import.mjs` exits 0;
   - `verify.mjs` reports 0 FAIL;
   - both re-applies are refused;
   - `import-catalogue.mjs` exits 0;
   - `verify-catalogue.mjs` reports 0 FAIL;
   - the counts differ from §3.2 only by what changed in the source since 2026-09-27 (new products, new users), and each difference is explained.

   The number of checks may grow with the data. The rule is zero FAIL.
5. **Production mode** (§3.5): copy `~/chopshop-export/rehearsal-cp7t1-2026-10-04/rehearse-cp7t1.mjs` into a new `~/chopshop-export/rehearsal-cp7t1-<date>/`, set `B` and `R` at its top, and run `node rehearse-cp7t1.mjs | tee run.txt`. It is offline, but it runs scripts with `--env production`, so ask Mikael first.
   - **"Passed" means:** in section 0 every command ends in a `REFUSED` line, except the `--dry-run`, which exits 0; `import.mjs` exits 0 and `verify.mjs` reports 0 FAIL; the copy is refused before the platform import (3a) and exits 0 after it with every entry `copied` (3b); `import-catalogue.mjs` is `ok true`; `verify-catalogue.mjs` reports 0 FAIL; every line of section 5 says `REFUSED`, each with the sentence §3.5 shows.
   - Also rehearse the bootstrap adoption of decision 1.11: insert a platform admin with the operator's address into the scratch database before the target-state queries, and check that the plan adopts it (blocker 19).

### 3.5 Run 2026-10-04, production mode (CP7-T1) — the result

**Driver:** `~/chopshop-export/rehearsal-cp7t1-2026-10-04/rehearse-cp7t1.mjs`, outside the repository; its output is `run.txt` and `logs/` beside it. It calls the repository's command-line tools where they can run offline, and their run functions in process where a pin must be injected. Nothing reaches a real host:
- the commands that read the real `cloudflare/pinned.production.json` run with an empty `HOME` and no credentials, and each refuses before any request (or is a `--dry-run`);
- the copy runs against the fake API on 127.0.0.1 with `/health` saying production and `/ready` on 0052. Its production target is built by `productionTarget()` from a temporary repository root that holds a pinned file with the fake's origin, and its credentials by `productionCredentials()` from a mode-600 production secrets file of the fake's invented user. Every source file is answered by the driver (a PNG made from the address), and `fetch` refuses any address but the fake's.
- **Bundle:** `~/chopshop-export/export-2026-09-27T15-02-15.414Z`. **Target:** a fresh, empty `scratch.sqlite` with every migration.

| Step | Result |
|---|---|
| Migrations | 50 applied: `0001` … `0052`, without `0020` and `0047` |
| The commands on the real pinned file | `storage-copy.mjs` and `import-studio-assets.mjs` without `--confirm`: exit 2, `--env production needs --confirm production (the explicit confirmation of a production run)`. `storage-copy.mjs` with `CHOPSHOP_API_URL=http://127.0.0.1:9`: exit 2, `CHOPSHOP_API_URL is not the pinned production API origin`. Both with `--confirm production` and no production secrets file: exit 2, `CHOPSHOP_PLATFORM_EMAIL is not set in the environment or in ~/.config/chopshop/secrets.production.env`. `import-catalogue.mjs` without `--confirm`: exit 1, the same confirmation sentence; with it: exit 1, `cloudflare/pinned.production.json r2.publicBaseUrl is null: a page image would have no public address`. `verify-catalogue.mjs` without `--confirm`: exit 1, the confirmation sentence |
| `storage-copy.mjs --dry-run` (production, no request) | exit 0; 524 distinct files; `not of the source's storage (never copied): robowatz/branding 1`; `archived shops (D21, not imported), files not copied: none` |
| `import.mjs --env production --commission-default-for melodie-mc` | exit 0; 864 statements; 287 109 bytes; plan sha256 `a9cabd60eba8…`. Tenants with domains, settings and features 18 rows · users, accounts, identities, memberships, id map 13 · printers, tiers, catalogue 325 · print defaults 1 · pod profiles 8 · screening terms and settings 65 · platform defaults 1 · legal acceptances 0 · audit events 0 |
| Apply, then `verify.mjs --env production` | no statement refused; **16 PASS, 0 FAIL, 9 DEFERRED** |
| The copy before the platform import is on the API | refused before any file was read: `the platform import is not applied: gif-sundsvall, melodie-mc, ninetone, sillmans are not a tenant on the API (apply import.mjs's plan first; the copy acts as each shop)` |
| The copy after it | exit 0; manifest `env` production; 524 entries, **524 copied**; 524 objects, all active; 1 063 API requests; 4 acting-as grants, each with the cutover's reason; 0 objects shared (the driver answers distinct bytes per address; staging shared 23) |
| `import-catalogue.mjs --env production --confirm production` (pins injected) | ok; 4 888 statements; 1 683 472 bytes; plan sha256 `a17e6f75b150…`; the first statement names kind `catalogue`. Products 217, variants 971, tags 26, images 709, publications 205, screening 205, collections 19, members 86, pages 1, store identities 4. Public: 205 in the source, 6 POD, **199 once every shop is live** (gif-sundsvall 113, melodie-mc 6, ninetone 58, sillmans 22) |
| Apply, then `verify-catalogue.mjs --env production --confirm production` | no statement refused; **41 PASS, 0 FAIL**. `import_runs`: one completed `platform` run, one completed `catalogue` run |
| The catalogue plan again (the same file) | refused: `an import run starts running, once, one at a time` |
| A catalogue plan rebuilt from the target after the apply | refused by the tool: `production already holds a completed catalogue run: the catalogue is imported once (0052)`, and every row it would write is already there |
| A second catalogue plan with another run id, applied | refused by the database: `an import run starts running, once, one at a time` |
| The platform plan again (the same file) | refused: `an import run starts running, once, one at a time` |
| A second platform plan with another run id, applied | refused by the database: `an import run starts running, once, one at a time` |
| The catalogue plan on a database without the platform run | refused: `the catalogue is imported after the platform import of the same export` |
| The catalogue plan once an order exists (after the platform import) | refused: `production holds orders: nothing is imported after the first order` |
| The platform plan once a payment event exists | refused: the same sentence |
| Rows at the end | tenants 4, users 3, identities 3, printers 1, products 217, variants 971, images 709, collections 19, pages 1, stored objects 524, orders 0 |
| Local times | migrations 0.4 s · CP3 plan 0.1 s · apply 0.3 s · verify 0.1 s · copy 1.0 s · catalogue plan 0.2 s · apply 2.3 s · verify 0.2 s |

The 709 images (not staging's 684) are because the driver answers every file; production's copy will report the 21 files the source no longer holds as `missing`, and the catalogue then writes 684 images, as on staging.

---

## 4. Freeze (Firebase stops taking orders) — the evening before

Everything in §4 is reversible. The undo is written beside each step.

**What Firebase is today** (read from `firebase.json`, `.firebaserc` and `functions/`):
- The project is `$FB_PROJECT`, functions in `us-central1`, named database `$FB_DB` (both defined in "Places" above).
- Four Hosting sites serve one build: `meteorpr` (admin), `shop-meteorpr` (storefront), `platform-meteorpr` and `print-meteorpr`.
- The client calls functions directly at `https://us-central1-$FB_PROJECT.cloudfunctions.net/<name>`.
- 82 functions (`docs/cf-port/INVENTORY_FUNCTIONS.md`):
  - **3 schedules:** `sweepPrintNotifyOutbox` (every 10 minutes), `sweepAbandonedCheckouts` (every 15 minutes; cancels abandoned PaymentIntents), `sweepReviewRequests` (every 60 minutes);
  - 9 Firestore triggers;
  - 7 HTTP functions, including **`stripeWebhookV2`** (Stripe endpoint pinned to `2023-10-16`) and **`createPaymentIntentV2`** (the only function that opens a payment);
  - order writers that matter: `stripeWebhookV2`, `createB2BOrder`, `processB2COrderCompletionHttpV2` (no caller, unauthenticated), `refundOrder`, `submitWithdrawal`, `setPrintJobStatus`.
- The admin client also writes `orders` directly under the rules (`firestore.rules:497-513` on `main`).
- **No freeze CI exists.** PLAN §0's rule is on paper only (blocker 17).

### 4.1 Record the rollback artifact — LOCAL

```
git fetch origin && git rev-parse origin/main      # expected f8076251 unless a hotfix landed since; write it in the log
```
This SHA is "the pre-freeze build". Firebase deploys only from `main` (the memory notes `hosting_deploy_from_main_only.md` and `cloudflare_migration_run.md`): a deploy from another branch would regress production.

### 4.2 Record what the freeze will change — READ-ONLY

1. In the Firebase platform console (`platform-meteorpr`), write down each shop's "published" and "status" into the log. In the 2026-09-27 export, melodie-mc is published (it has no `published` field, which Firebase reads as published) and gif-sundsvall, ninetone and sillmans are hidden (HANDOVER CP3).
2. **Why it matters:** §4.3 sets melodie-mc to hidden. **The export then carries `published: false`, and the importer imports it unpublished** (`lib/transform-shops.mjs`: only an explicit `false` hides). §6.5 publishes it again on Cloudflare.
3. In the Stripe Dashboard (live), find the Firebase endpoint whose URL ends in `/stripeWebhookV2`. Write down its `we_…` id. It is not in the repository.

### 4.3 Stop new checkouts — NEEDS MIKAEL'S GO

**Where:** the Firebase platform console → Butiker → melodie-mc → set the shop to hidden (`published = false`; the toggle is at `src/pages/platform/PlatformShopDetail.jsx:122` on `main`). Do the same for any other shop that is published by then.

- **Expect:** `createPaymentIntentV2` answers 403 "Shop is not accepting orders" (`functions/src/payment/createPaymentIntent.ts:507-513`). The storefront still shows, without search indexing, and a payment attempt shows "Butiken tar inte emot beställningar ännu…" (`src/components/shop/StripePaymentForm.jsx:434-438` on `main`).
- **Check:** open a product on `shop-meteorpr.web.app`, put it in the cart, go to checkout, try to pay. It must be refused before any card form.
- **If not:** stop. Something else is published, or the toggle did not save.
- **Undo:** set the shop back to published.

### 4.4 Drain the open PaymentIntents — NEEDS MIKAEL'S GO

**Goal:** zero platform PaymentIntents in a `requires_*` or `processing` state (manifest §d P4).

1. Let `sweepAbandonedCheckouts` run overnight. It cancels abandoned PaymentIntents every 15 minutes.
2. **READ-ONLY** in the morning. The key is read from the file and given to curl on stdin (the preflight's own way; `printf` is a shell builtin, so the key never appears in a process list):

   ```
   sk() { printf 'user = "%s:"\n' "$(sed -n 's/^STRIPE_SECRET_KEY=//p' ~/.config/chopshop/stripe.production.env)"; }
   for s in requires_payment_method requires_confirmation requires_action requires_capture processing; do
     printf '%s: ' "$s"
     sk | curl -sS -K - "https://api.stripe.com/v1/payment_intents/search?query=status%3A%27$s%27&limit=100" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("data",[])), [p["id"] for p in d.get("data",[])])'
   done
   ```

   - **Expect:** `0 []` for every state. Stripe's search can lag by about a minute.
3. For each id still open and not `processing`, **NEEDS MIKAEL'S GO** per batch:

   ```
   sk | curl -sS -K - -X POST "https://api.stripe.com/v1/payment_intents/<pi id>/cancel" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))'
   ```

   - **Expect:** `canceled`.
   - A `processing` payment cannot be cancelled. Wait for it to settle, then reconcile it in §4.5.
4. **Undo:** none, and none is needed. A cancelled abandoned checkout is what the sweep would have done anyway.

The Dashboard's Payments list, filtered on "Incomplete", shows the same.

### 4.5 Reconcile Firebase's payments — READ-ONLY

1. **Stripe Dashboard (live) → Payments, since the last known order.** Every *succeeded* payment must have a Firestore order with the same id (Firebase stores an order under its PaymentIntent id; manifest row 39). The 2026-09-26 census had 9 orders, all refunded test orders of melodie-mc.
2. Every new real order since then: write it into the log. **Firebase orders are archived, not imported** (D10). Their refunds and withdrawals are handled in the Stripe Dashboard after the cutover, because the Cloudflare admin will not show them. The Cloudflare withdrawal function does not know them (blocker 32).
3. Pending printer mails: `printNotifications` must be 0 (manifest P4). The export's dry run shows the count.

### 4.6 Pause the three schedules — NEEDS MIKAEL'S GO

Do this **after** §4.4, because `sweepAbandonedCheckouts` does the draining.
```
gcloud scheduler jobs list --project "$FB_PROJECT" --location us-central1
gcloud scheduler jobs pause <job> --project "$FB_PROJECT" --location us-central1     # once per job
```
The job names are expected to read `firebase-schedule-<function>-us-central1`. This is **not verified**; read the list.

- **Expect:** `list` shows the three as `PAUSED`.
- **Undo:** `gcloud scheduler jobs resume <job> …`.

### 4.7 Disable the Firebase Stripe webhook endpoint — NEEDS MIKAEL'S GO

Do this after §4.4 shows nothing open or processing.

**Where:** Stripe Dashboard (live) → Developers → Webhooks → the endpoint from §4.2 → Disable.

**Why now and not at the switch:** manifest §d P3 wants nothing to write Firestore after the export. Once disabled, `payment_intent.succeeded` for a late payment, `account.updated` and dispute events are no longer written to Firestore. Stripe keeps them in its Events list. The connected accounts' status is read live again on Cloudflare (§6.5).

PLAN §10 CP7 disables Firebase's endpoint at the switch instead. This document follows the manifest. Mikael may choose otherwise; then this step moves to §6.1.

- **Undo:** enable it again. Events that arrived while it was disabled are **not** re-sent automatically (**not verified**). Read them in the Dashboard's Events list.

### 4.8 People stop editing — NEEDS MIKAEL'S GO (it is a message to Kent)

Tell Kent and every Firebase admin user: no edits in the Firebase admin from now on (products, settings, orders). The double export in §5.2 proves that nobody edited.

### 4.9 Option B: the frozen Firebase build — NOT BUILT (decision 1.12)

**What it must contain.** One commit on `main` with the subject `hotfix: …` and the trailer `Port-Cutover: yes` (PLAN §0):
- `createPaymentIntentV2`, `createB2BOrder` and `processB2COrderCompletionHttpV2` answer 503 "closed for the move" before anything else;
- the three schedules are removed, or return at once;
- `firestore.rules` refuse every write but the platform's;
- `submitWithdrawal` stays: it is a buyer's legal right. Decide this with Mikael.

**How it is deployed:** from `main`, `cd functions && npm ci && npm run build`, then `firebase deploy --only functions,firestore:rules --project "$FB_PROJECT"`. **NEEDS MIKAEL'S GO.**

**Verified by:** a checkout attempt gets the 503; `gcloud scheduler jobs list` no longer lists the jobs; a write from the admin client is refused.

**Undo:** check out the §4.1 SHA, build, and deploy the same two targets.

It is kept as a deployable artifact together with the pre-freeze SHA (PLAN §10 CP7).

### 4.10 Freeze evidence — LOCAL

Write `$W/freeze-evidence.md` with:
- the time of each of §4.3–§4.8;
- the shop flags before and after;
- the PaymentIntent counts per state (all 0);
- the schedules shown as PAUSED;
- the webhook endpoint shown as disabled;
- the message to Kent;
- who gave each go.

The manifest's P3 asks for this file before the import.

---

## 5. Export → import → verify (the day)

Staging proved this order:
1. the CP3 import;
2. the file copy;
3. the catalogue;
4. the re-screen;
5. the legal texts;
6. the studio assets;
7. the printer catalogue apply.

Each step below names the tool's state in production **today**. Where a tool refuses production, the command is written in the shape it must take, and the step says so.

**Tool readiness for production, in one table:**

| Tool | Production today | Before the cutover |
|---|---|---|
| `scripts/cf-port/migrate/export.mjs` | reads production by design; read-only (`:15-20`, test `no-write-calls.test.mjs`) | run from a clean tree; P3 is proven with a double export (§5.2) |
| `import.mjs` | **accepts** `--env production` (`:108`). Refuses the staging scrub options there. Needs `--commission-default-for melodie-mc`. Its plan is the production **platform** run (0052: one per kind). Does **not** check the manifest's P1 (`--confirm`, `--expect-tenants`), P3 (freeze evidence), P4 (open payments) or P5 (re-pull Connect flags) | P1/P3/P4/P5 by hand (blocker 9) |
| `state-from-queries.mjs` | prints production queries **without `--bootstrap`**, so they are launch-gated (`:113`) | add `--bootstrap` by hand, or fix (blocker 11) |
| `verify.mjs` | accepts production; expects `snapwear` active and the default printer, and 2 platform admins plus 1 shop admin (`:63-64, 123-125`); leaves 9 items DEFERRED | check the deferred items by hand (§5.9; blocker 10) |
| `storage-copy.mjs` | **production mode** (CP7-T1): `--env production --confirm production`; the API origin of the pinned file; credentials from the environment or `~/.config/chopshop/secrets.production.env` only; refuses a shop that is not yet a tenant (§5.5) | the address of the production API (blocker 2) and the production secrets file |
| `import-catalogue.mjs` | **production mode** (CP7-T1): `--confirm production`; its plan is the production **catalogue** run (0052); refuses while `r2.publicBaseUrl` is null (§5.6) | `r2.publicBaseUrl` pinned (blocker 16) |
| `verify-catalogue.mjs` | **production mode** (CP7-T1): `--confirm production`, for the queries and the checks (§5.6) | none |
| `import-studio-assets.mjs` | **production mode** (CP7-T1): as `storage-copy.mjs` (§5.11); needed only for the studio and POD | the address of the production API (blocker 2) and the production secrets file |
| `staging-legal.mjs` | **REFUSES** production by design: the seller adopts the pages himself (`:5-6`) | only its step (a), the archived terms text, is needed in production (blocker 7) |
| `reconcile-staging.mjs` | **REFUSES** a non-staging origin or a non-sandbox account (`:82-83, 198-199`) | production mode (blocker 8) |
| `restore-archive.mjs` | **REFUSES** production (`:119-128`) | after the cutover only |
| `seed-staging-slice.mjs`, `connect-proof-staging.mjs` | staging only, by design | none; the smoke is done by hand (§7) |
| `build-locales.mjs` | no environment; the files are in the repository | check that nothing changed (§5.8) |

### 5.1 Bookmark production D1 — NEEDS MIKAEL'S GO

```
scripts/cf-preflight.sh production --bootstrap -- d1 time-travel info chopshop-prod > $W/bookmark-before-import.txt
```
- **Expect:** a bookmark line. This is the restore point of §8.1 step 7.

### 5.2 Export, twice — NEEDS MIKAEL'S GO (it reads production)

1. Export as in §3.4 step 1 (dry run, then `--apply`).
   - **Expect** (2026-09-27 figures, `CP3_X_REPORT.md`): 40 collections, about 5 000 documents, 8 Auth users, `verify-bundle` 240/240, live re-count 39/39, 0 warnings. The dry run's counts should equal the manifest's census plus whatever was added since.
2. `(cd $B && shasum -a 256 -c SHA256SUMS)` → all `OK`.
3. **The P3 check.** Export again, ten minutes later, into a second bundle `$B2`, and compare the carried collections. The parts are byte-deterministic (sorted keys), and every record holds its `updateTime`, so any write between the two changes a hash:

   ```
   python3 - "$B" "$B2" <<'PY'
   import json, sys, os
   a, b = sys.argv[1], sys.argv[2]
   for c in json.load(open(os.path.join(a, 'manifest.json')))['collections']:
       if c['fate'] != 'carry': continue
       ma = json.load(open(os.path.join(a, c['name'], 'manifest.json'))); mb = json.load(open(os.path.join(b, c['name'], 'manifest.json')))
       same = [p['sha256'] for p in ma['parts']] == [p['sha256'] for p in mb['parts']]
       print(('SAME   ' if same else 'CHANGED'), c['name'], ma['documentCount'], mb['documentCount'], ma['maxUpdateTimeSeen'])
   PY
   ```

   - **Expect:** every line `SAME`. Every `maxUpdateTimeSeen` is earlier than the §4.3 time.
   - **Also compare the Auth users:** `shasum -a 256 "$B/_auth/users.jsonl" "$B2/_auth/users.jsonl"`. They are not a Firestore collection, so the loop above does not cover them. A difference means an account changed, or someone signed in to Firebase, if the sign-in time is part of the record (**not verified**). Read which before going on.
   - **If a line says CHANGED:** someone wrote after the freeze. Find out what it was, and decide whether the freeze holds before going on.
4. `$B` is the bundle for every step below.

### 5.3 Translations: unchanged — LOCAL

```
node scripts/cf-port/build-locales.mjs --bundle "$B" --out $W/locales && diff -r $W/locales "$REPO/src/locales" && echo SAME
```
- **Expect:** `SAME`. The locale files are built into the storefront (D16).
- **If not:** commit the new files. That needs a review and a new deploy of `web`.

### 5.4 The CP3 import: tenants, users, printers, settings — NEEDS MIKAEL'S GO for the apply

1. **Target state** (READ-ONLY on production): print the queries with `node scripts/cf-port/migrate/state-from-queries.mjs --print-queries target --env production`. Run each printed command **with `--bootstrap` added after `production`** (blocker 11), redirected into `$W/q-target/<name>.json`. Then:

   ```
   node scripts/cf-port/migrate/state-from-queries.mjs --from $W/q-target --kind target --out $W/target-state.json
   ```

   - **Expect:** with decision 1.11 (a), one user (the bootstrapped platform admin) and no tenant.
2. **Plan** (LOCAL):

   ```
   node scripts/cf-port/migrate/import.mjs --env production --bundle "$B" --out $W/cp3-plan --target-state $W/target-state.json --commission-default-for melodie-mc
   ```

   - **Expect** (§3.2 and staging): about 864 statements, about 286 KB; 4 tenants (gif-sundsvall, melodie-mc, ninetone, sillmans; robowatz is archived, D21); 2 platform admins and 1 shop admin (melodie-mc), with the operator's admin **adopted**, not created (1.11); `snapwear` with 323 article tiers; 63 screening terms; 8 POD profiles.
   - **If it refuses:** read every `REFUSED:` line. A commission, an unknown address or a collision means stop and ask.
   - This plan is the production **platform** run. Migration 0052 lets production complete one run of each kind, so the catalogue (§5.6) is the second run, of kind `catalogue` (blocker 3, closed).
3. **Apply.** NEEDS MIKAEL'S GO:

   ```
   scripts/cf-preflight.sh production --bootstrap -- d1 execute chopshop-prod --remote --file=$W/cp3-plan/plan.sql
   ```

   - **Expect:** success with no error. On staging, 862 statements and 2 509 rows were written, first try (HANDOVER CP3).
   - **If it stops halfway:** the plan's `apply.md` §4 says how to complete the same run.
   - **Undo:** restore to the §5.1 bookmark.
4. **Actual state and verify** (READ-ONLY, then LOCAL): `--print-queries actual --env production`, the same way as step 1, into `$W/q-actual`. Then:

   ```
   node scripts/cf-port/migrate/state-from-queries.mjs --from $W/q-actual --kind actual --out $W/actual-state.json
   node scripts/cf-port/migrate/verify.mjs --env production --bundle "$B" --plan $W/cp3-plan --actual-state $W/actual-state.json | tee $W/verify-cp3.txt
   ```

   - **Expect:** `PASS: verify complete, nothing failed`, with these items PASS:
     - #1 `refund_application_fee = false` (D9);
     - #2 `default_commission_bps = 500`;
     - #3 `reverse_dispute_on_created = true`;
     - #4 Connect facts, commission and VAT equal to the plan (Connect ids carried, D75 for melodie-mc);
     - #6 `default_printer_id = snapwear`, `snapwear` active and `type = api`;
     - #7 63 terms, `review_first_products = 2`, `hard_block = false`;
     - #10 every POD profile present;
     - #14 identities {platform_admin 2, tenant_admin 1};
     - #15 status, published and `pod` equal to the plan;
     - #17 the bundle verifies.

### 5.5 The file copy — NEEDS MIKAEL'S GO

It runs as the platform user, acting as each shop, through the Worker's object routes. It downloads from the source's storage, which stays readable because nothing in Firebase is deleted.

**Before it.** The tool checks each of these and refuses with its own sentence (exit 2) before it copies anything:
- §5.4 is applied: every shop of the export is a tenant on the API. The copy acts as each shop.
- The production API answers `/health` with `production`, and `/ready` is on `0052_import_run_kinds.sql` or later (the catalogue that follows needs 0052).
- `cloudflare/pinned.production.json` `origins.api` is the production API's address. Today it is the workers.dev host, which has no address in production (blocker 2).
- `~/.config/chopshop/secrets.production.env` exists with mode 600 and holds `CHOPSHOP_PLATFORM_EMAIL` and `PLATFORM_ADMIN_PASSWORD` (or `CHOPSHOP_PLATFORM_PASSWORD`) of the production platform admin (decision 1.11). The same names in the environment win over the file. The staging file is never read. `CHOPSHOP_SECRETS_FILE` must be unset, or name that same file.
- `$W/copy` is a new directory. A manifest written for staging, or for another API, is refused there.

1. **Dry run** (LOCAL; it makes no request and writes nothing):

   ```
   node scripts/cf-port/migrate/storage-copy.mjs --env production --confirm production --bundle "$B" --out $W/copy --dry-run
   ```

   - **Expect** (rehearsal, §3.5): `sources: 524 distinct files (shop, address)`, then files and references per shop and use, `not of the source's storage (never copied): robowatz/branding 1`, `archived shops (D21, not imported), files not copied: none`, `dry run: no request made, nothing written`, exit 0.

2. **The copy.** NEEDS MIKAEL'S GO:

   ```
   node scripts/cf-port/migrate/storage-copy.mjs --env production --confirm production --bundle "$B" --out $W/copy | tee $W/copy.log
   ```

   - **Expect:** the dry run's lines, then `signed in as the platform user`, `every shop of the run is a tenant on the API`, a count every 25 files, `result (per shop and use):`, `API requests: …; waits on 429: …`, `manifest: copy-manifest.json in --out (524 entries, 0 failed)`, exit 0.
   - **Expect** (staging, 2026-09-28, `$HOME/chopshop-export/copy-staging-2026-09-28/run-1.log`):
     - 524 distinct files: **503 copied, 21 missing** (sillmans product images the source no longer holds, 404), 0 refused, 0 failed;
     - 480 objects (23 files identical to another of the same shop);
     - about 309 MB;
     - 969 API requests;
     - about 7 minutes.
   - **Exit 1** means some files are `failed` (a timeout or a 5xx, after three tries). Run the same command again: it skips every file already copied and tries the rest. Repeat until the last line says `0 failed`. The catalogue plan refuses a manifest that holds a failed file. `missing` and `refused` are final results; the catalogue is written without those images.
   - **Exit 2** is a refusal. Nothing was copied. Each sentence names its cause:
     - `--env production needs --confirm production (the explicit confirmation of a production run)`;
     - `cloudflare/pinned.production.json origins.api is null: production has no pinned API origin yet`;
     - `CHOPSHOP_API_URL is not the pinned production API origin`;
     - `CHOPSHOP_SECRETS_FILE is set: production reads its credentials only from the environment or ~/.config/chopshop/secrets.production.env`;
     - `~/.config/chopshop/secrets.production.env is the staging secrets file: production never reads staging's credentials`;
     - `~/.config/chopshop/secrets.production.env can be read by others (mode 644): chmod 600 it`;
     - `CHOPSHOP_PLATFORM_EMAIL is not set in the environment or in ~/.config/chopshop/secrets.production.env`, or `no production platform password: …`;
     - `/health does not say production (HTTP …)`, or `/ready is not on migration 0052 or later (HTTP …)`;
     - `sign-in failed: HTTP …`;
     - `the platform import is not applied: <shops> is/are not a tenant on the API (apply import.mjs's plan first; the copy acts as each shop)`;
     - `the manifest in --out was written for another environment or API`, or `… from another bundle`.
   - **The rate limit:** the sign-in and every request wait out a 429 (`Retry-After`, at most five waits; `lib/api-session.mjs`, since `2c154012`). HANDOVER 2026-09-28 found `staging-legal.mjs` failing two shops on the sign-in's limit; the wait is proven by test for a production copy (`test/storage-copy.test.mjs`).
   - **Read one back:** fetch a copied file from the public address; its size and sha256 must equal the manifest entry. The public address needs `r2.publicBaseUrl` (blocker 16).
   - **Undo:** restore D1 to the §5.1 bookmark: that removes the `stored_objects` rows. The files stay in `chopshop-prod-public` under `shops/<tenant>/…`, named by no row. No tool deletes them (not needed for a rollback; **not verified** how to remove them).

### 5.6 The catalogue — NEEDS MIKAEL'S GO

The plan is the production run of kind `catalogue` (migration 0052). It is additive to §5.4 and names objects only from §5.5's manifest.

**Before it.** `import-catalogue.mjs` refuses (exit 1, `▸ REFUSED — problems found`, one `! REFUSED: …` line each) unless:
- `--confirm production` is given;
- `cloudflare/pinned.production.json` has `origins.api` and `r2.publicBaseUrl`. **Today `r2.publicBaseUrl` is null, so the command refuses** (blocker 16): a page image is written as its public address;
- `--email-map` and `--scrub-unmapped` are absent (production carries every address as it is);
- the copy manifest is of production, was written against the pinned API, holds no `failed` file, and has an entry for every file of the four shops (the copy ran without `--shop` and `--limit`);
- the target holds the completed platform run of this export (§5.4) and no completed catalogue run at all.

1. **Bookmark.** NEEDS MIKAEL'S GO:

   ```
   scripts/cf-preflight.sh production --bootstrap -- d1 time-travel info chopshop-prod > $W/bookmark-before-catalogue.txt
   ```

2. **Target state** (READ-ONLY on production), after the copy:

   ```
   node scripts/cf-port/migrate/import-catalogue.mjs --print-queries --env production --confirm production
   ```

   Run each printed command **with `--bootstrap` added after `production`** (blocker 11), into `$W/q-cat-target/<name>.json`. Then:

   ```
   node scripts/cf-port/migrate/import-catalogue.mjs --state-from $W/q-cat-target --state-out $W/catalogue-target-state.json
   ```

3. **Plan** (LOCAL):

   ```
   node scripts/cf-port/migrate/import-catalogue.mjs --env production --confirm production --bundle "$B" --copy-manifest $W/copy/copy-manifest.json --target-state $W/catalogue-target-state.json --out $W/catalogue-plan
   ```

   - **Expect** (rehearsal, §3.5, every file copied): 4 888 statements, about 1.68 MB; 217 products, 971 variants, 26 tags, 709 images, 205 publications, 205 screening rows, 19 collections with 86 members, 1 page, 4 store identities. With the 21 files the source no longer holds `missing`, the images are 684 and the statements 4 838, as on staging (2026-09-28, applied first try).
   - `$W/catalogue-plan/apply.md` names the run id and the kind.

4. **Apply.** NEEDS MIKAEL'S GO:

   ```
   scripts/cf-preflight.sh production --bootstrap -- d1 execute chopshop-prod --remote --file=$W/catalogue-plan/plan.sql
   ```

   - **Expect:** success with no error.
   - **The database refuses the plan's first statement** (0052), and so nothing is written, when:
     - a catalogue run has already completed, or another run is in flight: `an import run starts running, once, one at a time`;
     - the platform run of the same export has not completed: `the catalogue is imported after the platform import of the same export`;
     - production holds an order, a payment event or a checkout: `production holds orders: nothing is imported after the first order`.
   - **If it stops halfway:** `apply.md` §2 says how to complete the same run.
   - **Undo:** restore to the step 1 bookmark.

5. **Re-screen at once** (§5.7).

6. **Verify** (READ-ONLY, then LOCAL):

   ```
   node scripts/cf-port/migrate/verify-catalogue.mjs --print-queries --env production --confirm production
   ```

   Run each printed command with `--bootstrap` added after `production`, into `$W/q-cat-actual/<name>.json`. Then:

   ```
   node scripts/cf-port/migrate/verify-catalogue.mjs --state-from $W/q-cat-actual --state-out $W/catalogue-actual-state.json
   node scripts/cf-port/migrate/verify-catalogue.mjs --env production --confirm production --bundle "$B" --plan $W/catalogue-plan --actual-state $W/catalogue-actual-state.json | tee $W/verify-catalogue.txt
   ```

   - **Expect:** `PASS: 41 checks, nothing failed` (the rehearsal's count; it grows with the data). The rule is zero FAIL.
   - **Once all four shops are live, the public projection is 199:** gif-sundsvall 113, ninetone 58, sillmans 22, melodie-mc 6. Only melodie-mc is published in the source, so production shows **6** at first. A shop that is not live yet is PASS with 0, and its note says what makes it live (§6.5, §6.6).

### 5.7 Re-screen at once — NEEDS MIKAEL'S GO

Between the catalogue apply and the sweep, imported products are public **with unscreened texts** (`CP4_S2_REPORT.md` §7 deviation 3). Run the sweep right after the apply.

**Where:** the browser, signed in as the platform user on `<admin origin>`, in the developer console. The admin forwards `/_api/v1/platform/*` (`cloudflare/admin/src/allowlist.ts`):
```
await (await fetch('/_api/v1/platform/screening-terms/rescreen', { method: 'POST' })).json()
```
- Repeat until the answer says `pending: 0`. Staging needed 9 calls for 205 products.
- This route through the admin host is **not verified** on staging; the staging run used the API host.

### 5.8 Legal texts: the archived platform terms — NEEDS MIKAEL'S GO

- The platform terms version `2026-09-07` is seeded by migration 0031. Its text must be archived with `PUT /v1/platform/legal/terms-versions/2026-09-07/text`. Without it, the terms page shows "Sidan kunde inte hittas" (HANDOVER 2026-09-28 18:30).
- **The body** is `JSON.stringify({ version, terms, dpa })` from `src/config/platformTerms.js`. It must hash to the version's stored sha256 (`staging-legal.mjs` step (a)).
- **Today** only `staging-legal.mjs` builds it, and that tool refuses production (blocker 7).
- **The shops' legal pages are NOT imported by any script.** Each seller adopts them (§6.6).

### 5.9 The checks `verify.mjs` defers — READ-ONLY, by hand (blocker 10)

| Manifest (e) item | Check |
|---|---|
| 5 | `scripts/cf-preflight.sh production -- whoami` prints both pinned endpoints |
| 8, 9 | POD off: `SELECT COUNT(*) FROM pod_mappings` = 0 and `SELECT COUNT(*) FROM pod_artwork` = 0 in production |
| 11 | melodie-mc's legal readiness, after §6.6: `GET /_api/v1/platform/tenants/melodie-mc` → `legal` ready |
| 12 | §5.6's verify-catalogue counts, once a production mode exists |
| 13 | `SELECT COUNT(*) FROM products WHERE description LIKE '%firebasestorage%' OR description LIKE '%storage.googleapis%'` = 0, plus the same on the other text columns the catalogue verify scans. A public object answers 200 on the public host, and a private key answers 404 there |
| 16 | §5.3 |
| 18 | `SELECT (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM payment_events), (SELECT COUNT(*) FROM checkouts), (SELECT COUNT(*) FROM outbox_events)` = 0, 0, 0, 0 |
| 19 | the launch gate, or decision 1.3 |

Run each query through `scripts/cf-preflight.sh production --bootstrap -- d1 execute chopshop-prod --remote --command "…"`.

### 5.10 The printer: rebuild SnapWear's offer — NEEDS MIKAEL'S GO — can wait until POD goes on

**Found on staging today** (the orchestrator's note of 2026-10-04; not yet in the repository):
- The imported Snapwear printer carries article **numbers only**, with no colour or size labels.
- The importer maps every article to a stand-in model `garment_<garment>` (`scripts/cf-port/migrate/lib/transform-printers.mjs:59-92`).
- The labels come back only through the catalogue apply, which rebuilds the offer from the stored supplier catalogue. Each article becomes `{model, label: "<colour> / <size>"}` (`CP3_C_REPORT.md` §4).
- Production allows the apply, because its dispatch target is `snapwear`. Staging refuses it for an inactive `api` printer (`CP3_C_REPORT.md` deviation 4).

**Steps, in the browser console on `<admin origin>` as the platform user:**
1. `await (await fetch('/_api/v1/platform/printers/snapwear/catalog')).json()`
   - **Expect:** `modelCount 8`, `skuCount 323`.
2. **Dry run:** POST `/_api/v1/platform/printers/snapwear/catalog/apply` with the body `FULL_EUR_APPLY` from `cloudflare/test/printer-catalog.test.ts:222-248`, with `eurSek` and `bufferBp` as Mikael confirms (decision 1.5). Leave out `apply`; its absence means a dry run.
   - **Expect:** a `diff`, and `dryRun: true`.
3. **Apply:** the same body with `apply: true`.
   - **Expect** (the test at `:660`):
     - 323 articles;
     - `unpricedSkus: []`;
     - every tier equal to the Firebase seed's price × 100, with print 3 800 öre on front, back and pocket;
     - garments bag, beanie, cap, hoodie, longsleeve, sweatshirt, tee;
     - provisional areas bag, beanie, cap, longsleeve.
4. **Undo:** apply again with the previous selection. The printer's `revision` fences concurrent edits.

**The six POD products of melodie-mc (D83).** **Not at go-live (decision 1.4).** When POD goes on:
- The seller (Kent) re-uploads the six originals and confirms the rights. That is his statement, not the platform's.
- He maps each variant to its printer article (`CP5_FM_REPORT.md`, "How Kent brings a hidden POD product … back").
- On staging today, 250 mappings were written and **17 variants could not be**:
  - 2 are size XS: SnapWear's tee has no XS;
  - 15 are duplicate colour groups on "The Return": one variant per printer article per product (`cloudflare/migrations/0023_pod_printers_mappings.sql:149`, `UNIQUE (product_id, artwork_id, printer_id, sku)`).
- The garment (unisex tee, model 64000) and the colour table were **assumed** on staging and need Kent's confirmation (decision 1.6).

### 5.11 Studio assets — NEEDS MIKAEL'S GO — needed only for the studio

The shape is `CP5_WH_REPORT.md`'s run book with `--env production --confirm production`. The tool refuses, before any request, on the same conditions and with the same sentences as the copy (§5.5), except that `/ready` must be on `0049` or later and it needs no tenant (the files are the platform's own).

1. **Dry run** (LOCAL; no request):

   ```
   node scripts/cf-port/migrate/import-studio-assets.mjs --env production --confirm production --bundle "$B" --out $W/studio --hosting-dir public --dry-run
   ```

   - **Expect:** `templates: 8 to write (…)`, the models, `files: 86 distinct (74 from the hosting directory, 12 from the source's storage)`, `hosting paths that --hosting-dir does not hold: 0`.

2. **The run.** NEEDS MIKAEL'S GO:

   ```
   node scripts/cf-port/migrate/import-studio-assets.mjs --env production --confirm production --bundle "$B" --out $W/studio --hosting-dir public | tee $W/studio.log
   ```

   - **Expect** (staging, `~/chopshop-export/studio-import-2026-10-04-run1.log`): 86 files copied, 8 templates, 6 3D models, `verify: … 0 mismatches`, exit 0, about 41 s.
   - The 3D originals are not carried: 6 colourways.
   - **Exit 1:** a file or an item is named as not copied or not written; run again (it is idempotent). **Exit 2:** a refusal, as in §5.5.
   - **Undo:** restore D1 to a bookmark taken just before the run (as §5.1). The files stay in R2 under `platform/studio/`, named by no row (**not verified** how to remove them).

---

## 6. Switch

### 6.1 Stripe: enable Cloudflare's endpoints — NEEDS MIKAEL'S GO

Stripe Dashboard (live) → Webhooks → enable both endpoints of §2.4. The Firebase one was disabled in §4.7. If it was not, disable it now.

- **Expect:** within an hour, the Dashboard shows deliveries to the Cloudflare URL answered 200. A Connect `account.updated` is the likely first one.
- **Not verified:** what the Worker does with an event about a **Firebase-era** payment, which has no order on Cloudflare (deferred payment events, `0026`). Expect alerts and read them (blocker 34).
- **Undo:** disable them again (§8.1).

### 6.2 Reconciliation — READ-ONLY

On Cloudflare, the 15-minute cron reconciles Stripe, orders, the outbox and dispatch, and writes alerts.

**In the browser console as the platform user:**
```
await (await fetch('/_api/v1/platform/alerts?state=open')).json()
await (await fetch('/_api/v1/platform/dispatch?state=unknown')).json()
```
- **Expect:** empty lists. There are no orders yet. The Firebase side was reconciled in §4.5.

### 6.3 Addresses — NEEDS MIKAEL'S GO

1. **The platform domain** (decision 1.1): the custom domains were attached in §2.5. Open `<web origin>/melodie-mc`, `<admin origin>/login` and `<api origin>/health`.
   - **Expect:** 200 for each, with a valid certificate.
   - The storefront keeps Firebase's path shape: `/<shop>/…` on one shared host (D77).
2. **The old Firebase hosts** redirect to the new ones (decision 1.13). This is a `firebase.json` `redirects` change on `main` with the trailer `Port-Cutover: yes`, built and deployed with `firebase deploy --only hosting --project "$FB_PROJECT"` from `main`. **NEEDS MIKAEL'S GO.**
   - **Expect:** `curl -sI https://shop-meteorpr.web.app/<path>` returns `301` with `location: <web origin>/<path>`.
   - **Not verified:** whether the old storefront used a `/se/` prefix. `se` is a reserved first segment on Cloudflare (`cloudflare/web/src/shop-segment.ts`), so such links would 404 without a mapping (blocker 24).
   - **Undo:** Firebase console → Hosting → each site → release history → roll back the release. The console's rollback is the documented path; the CLI path was not checked.
3. **DNS records for the platform domain only. Never `melodiemc.com`.**

### 6.4 Users: sign-in and the reset mails — NEEDS MIKAEL'S GO

1. **Mikael signs in on `<admin origin>/login`.**
   - With decision 1.11 (a): he uses the bootstrap password; the import adopted his user.
   - With (b): "Glömt lösenord" → the reset mail → a new password.
   - **Expect:** the platform console lists 4 shops.
2. **Invite the other platform admin and Kent.** Users page → each user → "Skicka inbjudan" (`POST /v1/platform/users/:id/invite`, a 72-hour invite; `MIGRATION_MANIFEST.md` §a).
   - **Not verified** for imported users with no password, and in particular for an imported **platform** admin (blocker 19).
   - Fallback: each uses "Glömt lösenord".
3. **Expect:** each mail arrives, its link opens `<admin origin>`, and the new password works.
   - The rows of `email_deliveries` read `sent`:

     ```
     scripts/cf-preflight.sh production --bootstrap -- d1 execute chopshop-prod --remote --command "SELECT kind, status FROM email_deliveries ORDER BY created_at DESC LIMIT 10"
     ```

**Go/no-go:** Kent's mail must arrive. Without it he cannot adopt, and melodie-mc cannot sell.

### 6.5 Shops: hostnames, publication, POD off, Connect — NEEDS MIKAEL'S GO

**In the browser console as the platform user.**

1. **A verified storefront hostname per shop.** The web Worker maps `/<shop>/…` to the shop's verified hostname (`cloudflare/src/tenancy/shop-hostname.ts`). The importer writes only a pending placeholder, `<shop>.import.invalid`, and no route verifies a pending one (HANDOVER CP4):

   ```
   for (const s of ['melodie-mc','gif-sundsvall','ninetone','sillmans'])
     console.log(s, (await fetch(`/_api/v1/platform/tenants/${s}/domains`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostname: `${s}.shop.invalid` }) })).status)
   ```

   - **Expect:** 201 for each. Staging used `<shop>.stg-shop.invalid` (HANDOVER 2026-09-28 18:30).
   - The hostname is only a key: no DNS ever resolves it. Any unique name works.
   - A shop with a domain of its own later gets that domain instead (D89).
2. **Publish melodie-mc again** (the freeze set it hidden, §4.2): `POST /_api/v1/platform/tenants/melodie-mc/publish`.
   - **Expect:** `<web origin>/melodie-mc` shows 6 products, and checkout is still closed (legal).
   - The other three stay unpublished, as in the source.
3. **POD off** (decision 1.4): the add-ons page → melodie-mc → `pod` off, or `PUT /_api/v1/platform/tenants/melodie-mc/features`.
   - **Expect:** the shop's `/admin/pod` is closed to the seller (`CP5_FM_REPORT.md`: the `pod` feature gates the page).
   - **Not verified:** that the flag alone hides an already-mapped product. There are none, so this is safe today.
4. **Connect read live** (manifest P5; the importer carried the flags verbatim): acting as melodie-mc, `POST /_api/v1/admin/payments/connect/refresh` (`CP3_F_REPORT.md`).
   - Acting-as: open the shop's admin from the platform console's shop page. That opens the 60-minute grant (`POST /v1/platform/tenants/:id/acting-as`, CP1). Admin requests then carry `X-Shop-Id: melodie-mc`.
   - Whether the payments page's own refresh button calls this route is **not verified**.
   - **Expect:** `200`, with `chargesEnabled` and `payoutsEnabled` true and equal to what the Stripe Dashboard shows for that account.
   - Do the same for every other shop that has an account.

### 6.6 Kent: terms, settings, legal pages — this is Kent's step

1. Kent signs in. The platform-terms gate appears; he accepts (`POST /v1/admin/legal/accept-terms`).
2. **Inställningar:** he enters the return address and the VAT answer.
   - melodie-mc's source had neither. Staging needed placeholders for it (HANDOVER 2026-09-28 19:10).
3. **The legal pages:** he adopts the three pages (`POST /v1/admin/legal/accept-pages`).
   - Only the shop's own admin may sign. A platform user acting as the shop gets 404 (`legal-admin.ts` `maySignForSeller`).
4. **Expect:** the platform's shop page shows legal readiness, and melodie-mc's checkout opens. Then the shop's legal pages and the platform terms are shown on the storefront.

**Why this bites:** on Firebase, the legal pages were generated from templates and always existed. On Cloudflare, a shop's legal pages exist only once the seller has adopted them, and its checkout stays closed until then (HANDOVER 2026-09-28 18:30). **Every imported shop starts with a closed checkout.**

---

## 7. Smoke on production

### 7.1 Look at it — READ-ONLY

1. Shoot the baseline pages:

   ```
   docs/cf-port/baseline/capture-storefront.sh $W/shots <web origin>
   ```

   The twelve baseline pages are shot at 375, 768 and 1440 px.
   - **Expect:** every page shows its heading, there is no console error, and the images come from the public host.
   - Compare with `~/chopshop-export/shots-staging-2026-10-03/`. The differences known from staging are D81 (28 px shorter, no account row) and melodie-mc's hidden POD products.
2. The admin: dashboard, products, orders, settings, payments. The platform: shops, users, reports.

### 7.2 Security in two minutes — READ-ONLY

- Anonymous `GET <admin origin>/_api/v1/me` → 401.
- A storefront path on the admin host → 404.
- A private object's key on the public host → 404.

### 7.3 THE FIRST ORDER: the point of no return — NEEDS MIKAEL'S GO

Before this step, read §8.1 one last time. After it, §8.1 no longer applies.

1. Mikael buys the cheapest non-POD product of melodie-mc with his own card. Use pickup if the product offers it.
2. **Expect:**
   - the payment succeeds, and the receipt page shows the order;
   - the order confirmation mail arrives;
   - the seller's order list shows it;
   - Stripe shows a succeeded PaymentIntent with:
     - an application fee at the platform default commission (500 bps, D75 for melodie-mc);
     - a transfer to melodie-mc's connected account;
     - the shop's statement descriptor suffix (A9).

### 7.4 Refund it — NEEDS MIKAEL'S GO

1. In the admin's order page: full refund.
2. **Expect:**
   - "Ordern återbetalad", or a "reserved" notice that settles within minutes;
   - Stripe shows one refund;
   - the application fee is **not** refunded (D9: `refund_application_fee = false`);
   - the transfer to the connected account is reversed;
   - the refund mail arrives.

**This test costs the platform's commission on the item plus Stripe's card fee.**

### 7.5 Reconcile — READ-ONLY, by hand (blocker 8)

1. Compare the admin's order page with the Stripe Dashboard: charged, refunded, application fee, transfer and its reversal.
   - The rule is `reconcile-staging.mjs`'s: payout = transfer − reversed − (fee − fee refunded).
2. After 30 minutes (two cron runs): `GET /_api/v1/platform/alerts?state=open` is empty.

### 7.6 Watch for 24 hours

- The alert digest goes to `PLATFORM_ALERT_EMAIL` (D40).
- Logs: `scripts/cf-preflight.sh production -- tail`. It is launch-gated like every production command.
- Resend's dashboard for failed sends.

---

## 8. Rollback

### 8.1 Until the first Cloudflare order (§7.3) — NEEDS MIKAEL'S GO

Run in this order. Each step reverses one earlier step.

1. Stripe: **disable** Cloudflare's two endpoints (§6.1).
2. Stripe: **enable** the Firebase endpoint (§4.7).
3. Firebase Hosting: roll back the redirect release on each site, if §6.3 step 2 ran.
4. If the frozen build was deployed (§4.9): check out the §4.1 SHA on `main`, build, and deploy `functions,firestore:rules` (only from `main`).
5. `gcloud scheduler jobs resume <job> …` for the three jobs (§4.6).
6. Firebase platform console: set melodie-mc back to published (§4.3).
7. Cloudflare: `POST /_api/v1/platform/tenants/melodie-mc/unpublish`, so that two storefronts do not both claim the shop (D57: unpublished = closed).
   - **To make a second cutover attempt possible:** restore production D1 to the §5.1 bookmark. The import-once rule (0052: one completed run of each kind) refuses a second run otherwise. Time Travel keeps 30 days:

     ```
     printf 'y\n' | scripts/cf-preflight.sh production --bootstrap -- d1 time-travel restore chopshop-prod --bookmark=<§5.1 bookmark>
     ```

   - The files copied to R2 stay, and no sweep removes them (PLAN §2.5's sweep is not built). The next copy finds or re-uploads them.
8. Tell Kent.

**Verify the rollback:**
- a checkout on `shop-meteorpr.web.app` reaches the card form (then abandon it);
- the Firebase endpoint's deliveries answer 200;
- `gcloud scheduler jobs list` shows the jobs ENABLED.

**What is lost:** nothing in Firebase. Events that came while the Firebase endpoint was disabled are in Stripe's Events list (§4.7).

### 8.2 After the first Cloudflare order: forward-fix only

There is no return to Firebase. The order exists only in D1, the importer refuses (P2, P7), and Firebase would never learn of it.

- **A bad deploy:** `scripts/cf-preflight.sh production -- deployments list`, then `… -- rollback` (or `--web` / `--admin`), or `versions deploy` of the previous version.
- **Bad data:** fix it forward through the routes. **A Time Travel restore would erase every order since the bookmark.** Never do it after real orders without a reconciliation of every order in between, and Mikael's go.
- **The emergency brake for one shop:** `POST /_api/v1/platform/tenants/<shop>/unpublish`. The storefront closes, and with it the checkout (D57). A suspension also closes the admin.
- **Money:** the Stripe Dashboard, plus the reconciliation cron's alerts.
- **A stuck dispatch:** the platform's manual resolution (`GET /v1/platform/dispatch?state=unknown|failed`; D43).

---

## 9. After the cutover

### 9.1 The archive period

Firebase stays as it is after the freeze for the period of decision 1.8:
- hosting redirects;
- schedules paused;
- the webhook disabled;
- Firestore, Storage and Auth untouched.

Firebase keeps billing for the project; the amount is small.

### 9.2 The archive in R2 — must be complete before ANY deletion

**No tool is built for it** (blocker 21). What `MIGRATION_MANIFEST.md` §c asks for:
1. **The bundle** → `chopshop-prod-private/archive/firebase/<collection>/export-<exportedAt>/`, with its `SHA256SUMS`, through `scripts/cf-preflight.sh production --bootstrap -- r2 object put …` per file. That command is **not verified** against the jurisdiction flag.
2. **A native `gcloud firestore export`** of the named database `$FB_DB` as a second copy, then copied to `archive/firebase/_native/`. GCS dies with the project.
3. **Storage objects no carried field names:** the archive families of manifest §b, for example 318.7 MB of marketing material. `storage-copy.mjs` copies only referenced files.
4. **The user id map** `_maps/user-id-map.json`: the bundle says "generated by the IMPORTER", and `import.mjs` writes `legacy_id_map` in D1. Whether a JSON copy is written anywhere is **not verified**; export the table.
5. **A line in `docs/cf-port/RETIRED.md`** per archived collection, with its restore line.

**Retention:** orders, `orderProduction` and checkouts for 7 years after the fiscal year. No lifecycle rule on `archive/`.

### 9.3 The deletion checklist — NOT executed; each line needs Mikael's go later

1. The archive in R2 is verified: `shasum -c` of a downloaded copy, and counts equal to the manifest.
2. No traffic on Firebase for 14 days or more: function invocations 0; hosting serves only redirects.
3. Deferred data is archived and reachable:
   - `dac7Sellers` is restored before DAC7 ports (D23, due diligence by 31 Dec 2026);
   - every PII archive is listed in `RETIRED.md`.
4. No key or config still names the Firebase project: grep the repository and the Workers' vars.
5. Then, in this order: functions → hosting → Firestore → Storage → the project. Each step is irreversible.

### 9.4 Secrets to revoke

1. **The three known-exposed secrets of CP0** (`scripts/cf-port/SECRETS_REVOKE.md`): the SMTP password with its 4 Secret Manager entries, the service-account key `49c329e6…`, and the GitHub PAT.
   - Whether Mikael has run these is **not verified**. The memory note still lists them as urgent.
2. **After the archive period** (PLAN §6: Firebase-side keys stay valid until the cutover plus the rollback window):
   - Firebase's live Stripe secret key: roll it in the Dashboard;
   - Firebase's webhook endpoint: delete it;
   - Firebase's Resend key;
   - `RENDER_FARM_TOKEN` in Firebase Secret Manager, and the Firebase render farm if one is still deployed;
   - `ADMIN_MAINTENANCE_SECRET`;
   - old Secret Manager versions (they cost money; memory note `gcp_billing_cleanup.md`).
3. **Production:** `BOOTSTRAP_TOKEN` is deleted right after use (§2.13).
4. **The Cloudflare token `chopshop-cf-port` expires on 2027-02-01** (PLAN §6). Renew it before then, or every preflight refuses.

### 9.5 What is PORT-LATER (PLAN §3.2, decisions)

- reviews;
- abandoned-checkout mails;
- discount-code admin;
- the content studio;
- B2B;
- the shop-system migrators;
- **DAC7: a hard date, seller due diligence by 31 Dec 2026 (D23: CP9 in November)**;
- the print portal;
- B2C accounts;
- marketing materials;
- the custom-domain page (D89, D90);
- affiliate;
- the 3D models page (being built now: FO);
- forwards and posts (D88);
- SSR (D31);
- the weekly D1 export to R2 and the 5 GB alert (`D1_BACKUP_RESTORE.md`: production has Time Travel's 30 days only);
- the orphan-object sweep (PLAN §2.5);
- the `outboundByHost` upgrade of the container's path to the API;
- the printer's status signal that writes `order_items.production_state`.

---

## 10. Open blockers found while writing

Each blocker has an owner and the smallest next step. "Blocks" says **cutover** (no go-live without it), **POD-on** (only before POD is switched on), or **later** (after the cutover, before deletion).

1. **The launch gate covers every production command.**
   - `scripts/cf-preflight.sh:648-651` runs it for every non-bootstrap production command, including `deploy` and `secret put`.
   - 13 required items are not ☑: A5 ⏸, A6 ⏸ (SnapWear's answers), A7 ☐, B1–B5 ☐, B6 ◐, B7–B10 ☐.
   - Nothing beyond D1, R2 and queues can be done in production today.
   - Owner: Mikael (decision 1.3); the port (the preflight change); Kent and SnapWear (the items themselves).
   - Next step: Mikael says whether a non-POD go-live is allowed. If yes, a preflight change scoped to POD, with tests, and a PLAN §0 edit.
   - Blocks: **cutover**.
2. **Production Workers have no possible address.**
   - The pinned api and web origins are workers.dev hosts, but `workers_dev` is `false` in all three production configs.
   - The preflight forbids `workers_dev: true` and any `routes` for the production web and admin Workers (`:482, 522-526`).
   - `origins.admin` is null, so the admin deploy is refused.
   - The API must be public: Stripe webhooks, and the render container (`render-container.ts:25-27`).
   - No domain is decided.
   - Owner: Mikael (domain, 1.1); the port (preflight support for one pinned custom-domain route per Worker, or for workers.dev).
   - Next step: decide the domain.
   - Blocks: **cutover**.
3. **The production catalogue cannot be imported. — CLOSED by CP7-T1 (commit to come), option (b); `docs/cf-port/CP7_T1_REPORT.md`.**
   - Migration `0052_import_run_kinds.sql` gives `import_runs` a `kind`: `platform` (the CP3 plan, and every run that names no kind) and `catalogue` (the catalogue plan names it in its first statement). Production completes one run **per kind**; still one run in flight at a time; a catalogue run only after the completed platform run of the same export; and no run starts or completes once production holds an order, a payment event or a checkout (manifest §d P2, P7, which 0033 left to the operator).
   - `import-catalogue.mjs --env production --confirm production` builds the production plan (§5.6). The order of the day is enforced by the tools: the copy refuses a shop that is not yet a tenant (§5.5), and the catalogue plan refuses a manifest that is not complete, not of production or not of the pinned API, and a target without the platform run.
   - Rehearsed offline in production mode (§3.5): both plans land, and every second run is refused.
   - **Still open:** `r2.publicBaseUrl` must be pinned before the plan can be built (blocker 16); Codex on 0052 and the tools; the reviewer applies 0052 on staging before the next API deploy (`REQUIRED_MIGRATION` is 0052).
   - Blocks: **cutover** until the commit is reviewed.
4. **`storage-copy.mjs` refuses production. — CLOSED by CP7-T1 (commit to come).**
   - `--env production --confirm production`; the API origin of `cloudflare/pinned.production.json` (refused while null; an explicit `CHOPSHOP_API_URL` must equal it); credentials from the environment or `~/.config/chopshop/secrets.production.env` only (mode 600; never the staging file; `CHOPSHOP_SECRETS_FILE` refused); `/health` must say production and `/ready` be on 0052; every shop must already be a tenant; a manifest of another environment or API is refused. Each refusal is tested and mutation-checked.
   - The sign-in has waited out a 429 since `2c154012`; a production copy's wait is now proven by test.
   - **Still open:** the production API has no address (blocker 2); the production secrets file does not exist yet (Mikael). It has never run against a real host.
   - Blocks: **cutover** until the commit is reviewed.
5. **`verify-catalogue.mjs` refuses production. — CLOSED by CP7-T1 (commit to come).** `--env production --confirm production` for the queries and the checks (§5.6). Rehearsed: 41 PASS, 0 FAIL (§3.5). Blocks: nothing once reviewed.
6. **`import-studio-assets.mjs` refuses production. — CLOSED by CP7-T1 (commit to come).** The same target and refusals as the copy (§5.11). **Still open:** blocker 2 and the production secrets file, as for 4. Blocks: **POD-on** (the studio) until reviewed.
7. **The platform terms' archived text has no production path.**
   - `staging-legal.mjs` step (a) is staging-only.
   - There is no terms-versions page: FL is not built.
   - Owner: the port.
   - Next step: build FL's terms page, or give that one step a production mode.
   - Blocks: **cutover** (the terms page is empty without it; whether the sellers' acceptance also needs it is **not verified**).
8. **No production reconciliation tool.** `reconcile-staging.mjs` refuses a non-staging origin and key (`:82-83, 198-199`). Owner: the port. Next step: production mode, read-only. Blocks: **cutover** (the smoke's proof; by hand meanwhile).
9. **`import.mjs` does not enforce the manifest's production preconditions.**
   - P1 (`--confirm production --expect-tenants`; the manifest's 5 is 4 now, robowatz being archived), P3 (freeze evidence, update-time re-scan), P4 (open payments) and P5 (re-pull Connect flags from live Stripe) are not implemented.
   - Connect flags are carried verbatim (`lib/scrub.mjs:205-207`).
   - Owner: the port.
   - Next step: implement them, or accept §4.10, §5.2 step 3, §4.4 and §6.5 step 4 as the manual equivalents. Mikael decides.
   - Blocks: **cutover**.
10. **`verify.mjs` leaves 9 manifest items DEFERRED** (5, 8, 9, 11, 12, 13, 16, 18, 19). The manifest says its output must be all PASS before the switch. Owner: the port. Next step: §5.9's manual checks, or add them to the tool. Blocks: **cutover**.
11. **`state-from-queries.mjs` prints production queries without `--bootstrap`** (`:113`), so they are launch-gated. Owner: the port (small). Next step: print `--bootstrap` for production d1 reads, or follow decision 1.3. Blocks: **cutover** (workaround in §5.4).
12. **The real SnapWear submit client does not exist.**
    - `cloudflare/src/dispatch/printer-client.ts:191-195` is a stub that rejects; production's `DISPATCH_TARGET` resolves to it.
    - It is being built and stays OFF until SnapWear confirms C1–C9.
    - Nothing writes `order_items.production_state`, so a POD order cannot be marked shipped.
    - Until then no POD order can be dispatched from production: POD stays off at go-live (1.4), and the six products stay hidden.
    - Owner: SnapWear (the answers); the port (client and status intake).
    - Blocks: **POD-on**.
13. **The six POD products' data.**
    - The garment (64000) and the colours are assumed.
    - 17 variants cannot be mapped: 2 XS, and 15 duplicate colour groups on "The Return".
    - Owner: Kent. Next step: Kent confirms the garment and colours, and decides the 17.
    - Blocks: **POD-on**.
14. **Mail has never worked end to end, not even on staging.**
    - There is no Resend account or key, no verified sending domain, and `EMAIL_FROM` is unset.
    - Resets, invites, order mails and the alert digest all depend on it.
    - Owner: Mikael and Kent (account, domain); the port (verify on staging first).
    - Next step: create the Resend account, put the staging secrets in place, and run a reset end to end on staging.
    - Blocks: **cutover**.
15. **Stripe production is not set up.**
    - There is no live key file.
    - `stripeAccountId` and both endpoint ids are null.
    - A restricted key's permission set has never been tried.
    - D49 has not been checked on the live account.
    - The API version decision is open (`stripe-client.ts:13-22`).
    - Owner: Mikael.
    - Next step: rehearse a restricted `rk_test_` key on staging (seed purchase plus refund), then §2.3–§2.4.
    - Blocks: **cutover**.
16. **R2 production is not set up.**
    - `r2.publicBaseUrl` is null. The custom domain needs the platform zone; `r2.dev` is rate-limited and meant for development (not re-checked).
    - There is no CORS rule on the production buckets.
    - There is no production R2 API token.
    - Owner: Mikael (+ the pinning commit).
    - Blocks: **cutover**.
17. **Firebase has no freeze build and no freeze CI.**
    - The only no-code stop is per shop (`createPaymentIntent.ts:45-48`).
    - PLAN §0's CI rule exists on paper only: the sole workflow is `isolation-tests.yml`.
    - The Firebase webhook endpoint id is not recorded in the repository.
    - Owner: Mikael (1.12); the port (the frozen build, if chosen).
    - Blocks: **cutover** (the decision, not necessarily the build).
18. **The freeze flag is exported.** Setting melodie-mc hidden in Firebase makes the import write it unpublished. It is covered in §4.2 and §6.5; a gotcha, not a defect. Owner: whoever runs the day. Blocks: nothing, if followed.
19. **The first production sign-in path is unrehearsed.**
    - Imported admins have no password.
    - The bootstrap-then-adopt path (1.11 a) has not been tried with the real bundle.
    - Invites for imported users, and for imported **platform** admins in particular, are **not verified**.
    - Owner: the port.
    - Next step: an offline rehearsal (§3.4 step 5), then a staging trial of an invite to a user with no password.
    - Blocks: **cutover**.
20. **Every shop's checkout is closed until its own admin acts.**
    - The admin must accept the terms, set the return address and VAT answer, and adopt the legal pages.
    - Only melodie-mc has a carried admin (Kent), and its source has no return address or VAT answer.
    - B7 (a liability clause in the platform terms) would publish a new terms version. D47 gives 14 days of grace, after which unaccepted shops close.
    - Owner: Kent.
    - Next step: Kent knows the steps (§6.6) and keeps the day free.
    - Blocks: **cutover** (for selling).
21. **There is no tool for the archive in R2.**
    - The bundle upload, the native Firestore export, the Storage archive families and the user-id map JSON (manifest §c).
    - `restore-archive.mjs` refuses production.
    - Owner: the port.
    - Blocks: **later** (before any deletion).
22. **An ordering trap in the preflight.** With `stripe.production.env` present and `stripeAccountId` null, even `--bootstrap` refuses (`:659-672`). Covered in §2.3. Blocks: nothing, if followed.
23. **`cf-deploy.sh` refuses a blank `VITE_STRIPE_PUBLISHABLE_KEY` in `admin.<env>.env`,** although its header says any name may be blanked (HANDOVER 2026-10-04 00:05). For production, put `pk_live_…` there. Owner: the port (fix with a test). Blocks: nothing, with the workaround.
24. **The old URLs' shape is not verified.** Whether `shop-meteorpr.web.app` links carry a `/se/` (or other) prefix that Cloudflare reserves, and therefore what the redirect must map. Owner: the port, Mikael. Next step: list real old links (sitemap, shared links) and test each against the redirect. Blocks: **cutover** (search traffic and links).
25. **Backups are thin.** There is no weekly D1 export and no 5 GB alert; Time Travel's 30 days only (`D1_BACKUP_RESTORE.md`). Owner: the port. Blocks: **later**.
26. **The storefront design gate: re-shot on staging 2026-10-04, every difference explained; Mikael's sign-off is what remains.**
    - PLAN's CP4 exit is "storefront diff-clean". 36 shots (12 pages × 3 widths) against the baseline, 0 console errors, 0 failed requests; shots and side-by-sides in `~/chopshop-export/shots-staging-2026-10-04/`.
    - The differences are the planned removals of D81 (the account icon in the header, the "Mitt konto" footer link = 28 px on every page, the Trustpilot tile on the home page) and text that differs (the legal pages' dates and placeholder address, the archived platform terms). Layout, type and colours match. The cart was empty in the baseline too: there is no total to compare.
    - Owner: Mikael (to accept the explained differences as the gate's "explained delta", PLAN §7.3).
    - Blocks: **cutover** (per PLAN) until he has.
27. **The guard's migration allowlist must be EMPTY by CP7** (PLAN §0). It holds 296 entries (HANDOVER 2026-10-04). Owner: the port; Mikael may re-scope it. Blocks: **cutover** (per PLAN as written).
28. **Open decisions that touch the launch:** D68 (no erase path for personal data in evidence, withdrawals, recipients), D97 (d), B11/D8, D91, D101, the publication texts. Owner: Mikael. Blocks: nothing, on the defaults.
29. **No production Worker has ever run.** Production D1 has no migrations. The render container has never run in production, and the image builds at deploy with Docker running. Owner: the port. Next step: §2.9–§2.12, once blockers 1 and 2 are solved. Blocks: **cutover**.
30. **The staging soak is not defined in the repository.** 48 hours with no open alert is this document's suggestion (§0 item 12). Owner: Mikael. Blocks: **cutover** (as a go/no-go item).
31. **Legal agreements are part of the launch gate:** B6 (DPA with SnapWear, drafted), B6b (the shop-level processing agreement), B7, B3 (insurance), B4 (accountant). Owner: Mikael, Kent. Blocks: **POD-on**, or **cutover** if the gate is not narrowed (1.3).
32. **Withdrawals of Firebase-era orders.**
    - Firebase orders are archived, not imported, so the Cloudflare withdrawal function cannot find them.
    - The 2026-09-26 census had only refunded test orders; re-check this at the freeze (§4.5).
    - Owner: Mikael. Next step: if a real Firebase order exists at the freeze, its buyer is answered by hand (shop or platform mail).
    - Blocks: nothing if there is none.
33. **The Cloudflare project token expires on 2027-02-01** (PLAN §6). Owner: Mikael. Blocks: **later**.
34. **Stripe events about Firebase-era payments** that arrive at the Cloudflare endpoint after the switch (refunds or disputes of old charges) have no order there. What the Worker does with them (deferred events, 0026) is **not verified**: expect alerts. Owner: the port. Next step: read `cloudflare/src/commerce/stripe-events.ts` for an unknown PaymentIntent, and write the expected behaviour into §6.1. Blocks: nothing.
35. **Whether a custom domain added in the Dashboard survives a `wrangler deploy`** of a configuration with no `routes` is **not verified**. This is why §2.5 asks for preflight support (blocker 2) and not a Dashboard-only domain. Owner: the port.
36. **The browser-console calls in §5–§6 are untried through the admin host** in production form (re-screen, catalogue apply, domains, publish, features, Connect refresh, alerts). The admin proxy allows `/v1/platform/*` (`cloudflare/admin/src/allowlist.ts`), but on staging each was run another way (scripts on the API host, or the pages), or, for the catalogue apply, in a way the repository does not record. Owner: the port. Next step: walk each on staging through `<staging admin origin>/_api/…` and correct this runbook. Blocks: **cutover** (an executable runbook).
37. **The bootstrap script in §2.13 has never been run.** The route itself was proven with curl on staging in CP1. Owner: the port. Next step: run the script once against a local development Worker (`cd cloudflare && npm run dev`, which is `wrangler dev --local --env staging`, with an empty local database). Staging cannot test it: a platform admin exists there, so the route answers 404. Blocks: **cutover** if decision 1.11 (a) is taken.
