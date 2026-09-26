# Cloudflare full port — the plan

Status: **DRAFT for Mikael's approval — no code until approved.** 2026-09-26.
Evidence base (read these first, every claim below cites them):
`INVENTORY_FUNCTIONS.md` (82 exports, verdicts) · `INVENTORY_CLIENT_DATA.md` (frontend data surface) ·
`INVENTORY_CF_BRANCH.md` (what `cloudflare-migration` already delivers) · `INVENTORY_DOCS.md` (docs quarantine).

---

## 0. The decision and the rules it comes with

**Decision (Mikael 2026-09-26):** full migration to Cloudflare — Workers + D1 + R2 + Queues + cron — replacing Firebase entirely (Firestore, Auth, Storage, Functions, Hosting). Not the hybrid. The hybrid produced a month of drift (CF branch frozen at 2026-08-27 while 80 commits landed on Firebase) and a Firebase deploy of 82 functions.

Non-negotiables, each enforced by a gate, not by memory:

| Rule | Enforced by |
|---|---|
| **Firebase feature freeze.** Only hotfixes that keep melodie-mc's test usable. | Every Firebase commit after this date needs a `hotfix:` prefix and a one-line justification. |
| **Port what earns its place, delete the rest.** | §3 scope table; DELETE needs Mikael's sign-off (§11). |
| **Zero B8shield transfer.** No name, id, bucket, env var, identifier, comment, doc or image. | CI grep-guard `scripts/guard-no-b8shield.test.mjs` fails the build on `/b8shield|b8s[-_]|reseller/i` in the new tree. Rename list in §8. |
| **Correct account, always.** Kent's Cloudflare account; never the personal staging account (`0d39…`), never Ninetone's, never the igpholding token. | `scripts/cf-preflight.sh` runs before every wrangler/API action, compares `wrangler whoami` account id with the pinned `CF_ACCOUNT_ID`, and refuses on mismatch. Same preflight checks the Stripe key prefix per env. |
| **Storefront design preserved 100%.** React + Vite + Tailwind + NORD tokens stay; only the data layer changes. | Baseline screenshots of every route on Firebase BEFORE the port (§7); every checkpoint diffs against them. Impeccable freezes the design system first. |
| **Two reviewers before any deploy.** Opus 5.5 builds, Sonnet does data-transfer scripts, **Fable + Codex review every checkpoint** before it goes to staging. | §9 pipeline; a checkpoint without both review notes in its handover entry does not deploy. |
| **Plan first.** | This document; changes to scope are edits here, approved, before code. |

---

## 1. What the inventories say (headline numbers)

- **Functions:** 82 exports → **29 PORT now · 35 PORT-LATER · 18 DELETE** (`INVENTORY_FUNCTIONS.md` §counts). 9 callables have no client caller at all. 3 need sharp/ffmpeg (`processPodArtwork` now; the two content-studio ones later).
- **Frontend:** 141 live files touch the SDK — 173 reads, 134 writes, 17 realtime listeners, 67 callable sites, 51 Storage ops, 15 Auth calls, 41 collections. **Storefront is thin (32 of 37 files trivial). The pre-pivot CRM wagons alone own 9 of the 17 listeners and 8 collections nobody else uses.** 83 sites depend on the Firestore Timestamp shape (`.toDate()` / `.seconds`).
- **CF branch:** foundation is real and reusable (tenant resolution, live D1 authz, Better Auth on D1, fail-closed conventions, schema discipline, R2 ownership, rate limiter, Stripe client + webhook ledger, render-farm contract + extracted sharp core, vitest-pool-workers harness). But **only 11 of 82 exports have any counterpart; 71 have none**, and **the committed branch fails its own gate** (48 vitest failures + 64 tsc errors — checkpoint 27 forgot its test config). Staging lives in Mikael's *personal* account.
- **Docs:** 9 files to quarantine now, 7 need a call, ~529 MB of untracked clutter at the repo root.

Honest size: this is a **new backend + a data-layer rewrite of one frontend**, not "move 82 functions". The frontend rewrite is the largest single chunk (§5).

---

## 2. Target architecture

```
Kent's Cloudflare account
├─ Worker  chopshop-api        (one deploy unit; envs: staging, production)
│   ├─ Hono router (replaces the branch's if-chain — 35 routes today, ~150 at the end)
│   ├─ Better Auth on D1 (sessions; roles resolved LIVE from D1, never from cookie claims)
│   ├─ D1  chopshop-{stg,prod}  (start from the branch's 12 migrations, then §4)
│   ├─ R2  chopshop-{stg,prod}-private  +  chopshop-{stg,prod}-public (images via custom domain)
│   ├─ Queues: email, print-outbox, screening      ·  Cron: sweeps (abandoned checkouts, outbox, review requests later)
│   ├─ Rate Limiting binding (replaces the D1 limiter where per-IP is enough; D1 stays for per-email quotas)
│   └─ Secrets: STRIPE_*, RESEND_API_KEY, BETTER_AUTH_SECRET, SNAPWEAR_API_TOKEN, RENDER_TOKEN, TURNSTILE_*
├─ Worker  chopshop-web        (static assets: the SAME Vite build; hostname → tenant, custom domains via CF for SaaS)
└─ Render service              (sharp today, ffmpeg later): DECISION §11 — Cloudflare Containers on this account,
                               else one Cloud Run container in a NEW GCP project (never the b8shield project)
```

Principles carried over from the branch (they are the good part): tenant from hostname only; opaque 404s; config checks before anything; same-origin checks; `tenant_id` immutable with triggers; append-only `audit_events`; R2 objects owned by rows (`stored_objects`); Stripe webhook = raw-body signature + `payment_events` ledger + one atomic batch.

What changes versus the Firebase model, on purpose:
- **No triggers.** "Publish a product" is one handler that validates, screens, projects and writes in one D1 batch. The whole class of audit findings from this week (F1 rules-can't-express, F4 trigger fan-out, P0-01 re-homing) does not exist here.
- **No public projections as tables.** `productsPublic` / `printersPublic` become allowlisted read queries (`INVENTORY_FUNCTIONS.md`, D1 seed section).
- **No realtime by default.** The 8 core `onSnapshot`s become: order-confirmation → poll `GET /orders/:id` until the webhook lands (max 90 s, as today); admin presence → dropped (or 60 s poll later); pages/payments/dac7/migration progress → poll. The 9 CRM-wagon listeners are deleted with the wagons.
- **Timestamps are ISO-8601 strings** end to end. A single `src/lib/time.js` (`toDate(x)`) replaces the 83 `.toDate()`/`.seconds` sites — mechanical, Opus.

---

## 3. Scope — port / later / delete

### 3.1 PORT now (the first live shop needs it)
From `INVENTORY_FUNCTIONS.md` (29 exports) plus the client surfaces that use them:

| Domain | Backend (from the 29) | Frontend surfaces |
|---|---|---|
| Auth & users | password reset (one flow, not three), platform super-admin + shop user provisioning, delete platform user | login (admin/platform/print), `AuthContext` → session client, users tabs |
| Tenancy / platform | shops (full `shops` schema, not the thin `tenants`), features/add-on flags, live gate, provisioning | PlatformShops, ShopDetail, Addons, Users, Printers (tiers, areas, routing), Reports (screening/takedown queue), settings |
| Catalogue | products (variants, images, POD fields), collections, pages, menu, branding, legal pages | ProductForm, AdminProducts, Collections, Menu builder, Pages, Store settings, Legal pages + acceptance |
| Storefront | public reads: catalogue, collections, pages, branding, menu, legal; cart; checkout; order confirmation; rapportera-intrång | every `src/pages/shop/*` — data layer only, pixels unchanged |
| Checkout / money | PaymentIntent (Connect destination charge, commission, **production withholding**, descriptor suffix), webhook (succeeded, failed, disputes ×2, account.updated), orders, refunds (cumulative), withdrawals, Connect onboarding ×4, commission/payout-delay/balance | Checkout, StripePaymentForm, OrderConfirmation, AdminOrders/Detail (one-number card), AdminPayments |
| Email | Resend transport + the order/auth templates actually sent today (order confirmation, admin notification, status update, refund, withdrawal, password reset, infringement admin) | — |
| POD | artwork upload (R2 presigned) + `processArtwork` on the render service, mappings, mockup templates/profiles, `quotePodCost`, studio publish gate, production snapshot at checkout, print outbox + sweep (SnapWear A6 hook), screening (in the publish path, no trigger), takedown | Design Studio, PodAdminPage (artwork, mappings), 3D read-only view |
| Retention | abandoned-checkout PI cancel + snapshot purge (the reminder emails wait) | — |
| Legal | platform terms + acceptance evidence + checkout gate, withdrawal (ångerrätt) | PlatformTermsGate, legal pages |

### 3.2 PORT-LATER (real add-ons; not needed for melodie-mc's first live sale)
Reviews (6), abandoned-checkout reminder emails (2), discount-code admin (1), content studio (3, ffmpeg), B2B wholesale (2), Shopify/Woo migrators (2), DAC7 (8), print portal (7 — SnapWear never logs in; revisit if a second printer returns), B2C customer accounts (guest checkout + guest withdrawal already work), marketing materials, custom-domain admin UI (CF makes the mechanism trivial; the UI can wait). Each gets its own later checkpoint; none is deleted.

### 3.3 DELETE (needs Mikael's sign-off, §11)
- **Pre-pivot CRM wagons:** dining, ambassador, campaign, writers (`enabled` flags, 9 listeners, 8 private collections, `scrapeWebsiteMetaV2`, two callables that don't even exist).
- **Affiliate program** (5 functions, 5 collections; B8shield ambassador heritage; campaign codes already cover creator codes).
- `deleteCustomerAccountV2` / `toggleCustomerActiveStatusV2` (the delete wipes every order of the user — replaced by a proper deactivate in the new users API), `getGeoDataV2`, `createAdminUserV2`, `syncAdminClaims`, `aggregateDac7Year`, the V1 `confirmPasswordReset`, the three dead email callables, `processB2COrderCompletionHttpV2`, the DAC7 duplicate.
- Everything in `OBSOLETE/` and every b8shield-era doc/image (§8).
- The untracked root clutter: `cloudflare/` (355 MB node_modules dump), three image dumps (174 MB), `worker-startup.cpuprofile`.

---

## 4. Data

- **Schema:** start from the branch's 12 migrations/30 tables; add (from the functions inventory D1 seed): full `shops`, `users` (roles, printer membership), `products` (+ `product_variants`, `product_images`), `collections`, `pages`, `menus`, `pod_artwork`, `pod_mappings`, `printers` (+ tiers, areas), `settings_*` as typed tables (platform, print_routing, pod_profiles, mockup_templates, content_screening), `orders` (+ items, status history, customer/shipping/pickup snapshot, consent proof, Connect fields), `order_production` (server-only money), `checkouts`, `infringement_reports`, `legal_acceptances`, `audit_events`. Not tables: public projections, rate limits, password resets, print notifications (Queue + state).
- **Re-seed, don't migrate.** No live customers. Sonnet writes idempotent scripts that read Firestore (named DB, ADC) and write D1 via the Worker's admin API or `wrangler d1 execute`: shops (5), users, melodie-mc + sillmans products/collections/pages/settings/branding, podArtwork + mappings (18 rows; the garment-less ones are re-published by Kent anyway), printers + routing + screening + templates seeds (already scripts — retarget). **Orders are not migrated** (9 test orders). Firebase Storage objects → R2 via a copy script; every stored download URL is rewritten to the R2 public URL (`INVENTORY_CLIENT_DATA.md` §0.5 lists the 15 path families; `ProductForm.jsx:737` parses Firebase URLs — replaced).
- **Auth:** Better Auth (already on the branch). Firebase Auth users are re-created by email with **forced password reset** (one email each; ~10 people). The two auth contexts (`AuthContext` for admin/platform/print, `SimpleAuthContext` for b2c) collapse into one session client with roles; b2c accounts are PORT-LATER, guest checkout stays.

---

## 5. Frontend: swap the data layer, keep the pixels

- New `src/api/` client (fetch + session cookie, typed per domain: `catalogue`, `orders`, `checkout`, `pod`, `platform`, `auth`, `storage`). The 25 existing wrapper modules (`podMappings.js`, `podArtwork.js`, `shopConfig.js`, `printRouting.js`, `podCostQuote.js`, `imageUpload.js`, …) are re-implemented on top of it — their importers don't change. The 112 files that call the SDK inline are edited file by file, in checkpoint order, by Opus, with the per-file effort ratings from `INVENTORY_CLIENT_DATA.md` §1 as the work list.
- `firebase/*` imports go to zero; `src/firebase/config.js` is deleted; the guard test also greps for `from 'firebase/`.
- Uploads: browser → `POST /storage/reserve` → PUT to the R2 presigned URL → `POST /storage/confirm` (the branch's contract). Public images are served from the public bucket on a custom domain, so `<img src>` stays a plain URL.
- Realtime: see §2. Harnesses (`src/dev/*`) get a mock API client so they keep working without a backend.

---

## 6. Accounts, environments, credentials

- **One account: Kent's** (§11 asks personal vs company). Two Worker envs in it: `staging` (`*.staging.<domain>`) and `production`. The old personal-account staging is never reused and is deleted at the end (its Email Sending domain `outpost.mohlenmedia.com` is unrelated — untouched).
- `cloudflare/wrangler.jsonc` pins `account_id` = Kent's; `scripts/cf-preflight.sh` is the only entry point for wrangler (deploy, d1, r2, secret) and refuses on any other account, on a missing `APP_ENV`, or on a Stripe key whose prefix doesn't match the env (`sk_test_`/sandbox for staging, `sk_live_` for production).
- **Secrets are rotated, never copied:** new Stripe webhook endpoint + secret per env, new Resend key, SnapWear token straight into CF, Better Auth secret generated. The known-exposed SMTP/SA/PAT secrets are retired as part of this, not later.
- Stripe: the platform account and Connect accounts are unaffected by hosting; only the webhook endpoint URL changes. Staging keeps the sandbox ("-sandlåda", not test mode — as learned 2026-08-22).

---

## 7. Design gate (the "100%")

1. **Checkpoint 0 captures the baseline while Firebase is still live:** gstack browse screenshots at 375/768/1440 of every storefront route (home, /produkter, collection, product, cart, checkout steps, confirmation, legal pages, rapportera-intrång), every admin page, every platform page, light + dark where applicable — stored under `docs/cf-port/baseline/` (git-lfs or a release asset if size demands).
2. **Impeccable freezes the design system:** `/impeccable` audit → `DESIGN.md` updated to a complete token + component contract (NORD storefront, Admin-Neutral, Platform-dark), and any drift found NOW is fixed on Firebase as a hotfix so the baseline is the truth.
3. **Every checkpoint that touches a page** re-shoots the same routes on staging and diffs (pixel diff ≤ 0.5 % or an explained delta — e.g. a timestamp). A red diff blocks the checkpoint. Reviewers see the before/after pair, not a description.

---

## 8. Zero-B8shield rename list (done on the way over, guarded by CI)

GCP project `b8shield-reseller-app` (never referenced), named DB `b8s-reseller-db`, storage bucket names, `DEFAULT_SHOP_ID` and every `b8shield` default/fallback in `src/config` + `src/utils` (15 files) + `functions/src` (21 files), the reseller-era wagons and their READMEs, `stripe-review-export/` (quarantine), `OBSOLETE/` (stays behind), `public/images/README.txt`. "Reseller" survives only where it is a live legal term in the platform terms (allowlisted by path in the guard).

---

## 9. Build → review → deploy pipeline (per checkpoint)

1. Opus builds in a worktree (or Sonnet for data scripts); gate green (`vitest` in `cloudflare/`, the ported pure invariants, the guard tests).
2. **Codex review** (`/codex review` on the diff) → findings fixed.
3. **Fable review** (line by line, adversarial: what did the reviewer miss, what broke, reverse-check) → findings fixed.
4. Deploy to **staging** via preflight; smoke (`stg-*.sh` style) + design diff.
5. Handover entry in `docs/cf-port/HANDOVER.md` (what, evidence, both review notes, open gaps) — the branch's checkpoint style, which worked.
6. Production deploy only at cutover (CP8), on Mikael's explicit go.

---

## 10. Checkpoints (ordered; each independently shippable to staging)

| CP | Scope | Builder | Exit criteria |
|---|---|---|---|
| **0 Hygiene + baseline** | New branch `cf-port` from main; bring `cloudflare/` + handover from `cloudflare-migration`; **fix the broken test gate** (vitest config, `env.d.ts`, types); Hono router; guard tests (b8shield, no-firebase-import); `cf-preflight.sh`; docs quarantine (§3.3, `docs/_archive/` + INDEX); root clutter removed; **design baseline captured (§7.1) + impeccable freeze (§7.2)**; Firebase freeze announced in LAUNCH_TODO. | Opus + Sonnet (docs move) | gate green on the branch; baseline in repo; preflight refuses wrong account (tested) |
| **1 Account + foundation** | Kent's account bootstrapped: D1 ×2, R2 ×4, Queues, secrets (rotated), envs; migrations applied; Better Auth mounted with password reset + invitation; platform super-admin bootstrap. | Opus | `whoami` = Kent's id; sign-in works on staging; audit_events written |
| **2 Frontend API layer + auth** | `src/api/*`, `time.js`, session client; `AuthContext` swapped; login/reset pages for admin/platform/print; harness mock client. Nothing else changes yet. | Opus | login on staging renders pixel-identical to baseline; no `firebase/` import in the auth path |
| **3 Platform + tenancy** | Full `shops` + features + live gate + provisioning; users; printers (tiers, areas, routing) + `printersPublic` query; settings tables + seeds retargeted; platform pages swapped. | Opus (+ Sonnet seeds) | every platform page diff-clean; SnapWear seed lands in D1 |
| **4 Catalogue + storefront** | products/variants/images/POD fields, collections, pages, menu, branding, legal pages; public read API with allowlist; R2 public images + URL rewrite; **all storefront pages swapped**. | Opus (+ Sonnet copy of melodie-mc/sillmans data) | storefront 100 % diff-clean at 3 widths, light/dark; anon can read nothing non-public (authz tests) |
| **5 Admin core** | ProductForm (incl. POD gate), products list, collections, menu, pages, store settings/identity/delivery/pickup, legal pages + acceptance, orders list/detail (one-number card), payments/Connect onboarding UI. | Opus | admin pages diff-clean; F1–F5 invariants re-tested as Worker tests |
| **6 Checkout + money** | Full checkout contract (pickup, consent, campaign discounts, legal gate, POD snapshot, Turnstile), PaymentIntent with Connect + withholding + descriptor, webhook (5 events), orders, refunds, withdrawals, Connect endpoints, Resend templates. Pure invariants ported (checkout, withholding, connect-params, dispute recovery, refund state). | Opus; Fable on the money path | real sandbox test order on staging: PI fee = commission + withholding; refund reflects on the card; webhook replay idempotent |
| **7 POD** | Artwork upload → render service → validation; mappings; templates/profiles; `quotePodCost`; studio publish (screening inline, fit checks, price floor); production snapshot; print outbox + sweep; **SnapWear A5/A6 if Natalia has answered, else the outbox stub**; takedown + infringement report + Anmälningar/Granskning. Render-service decision executed (§11). | Opus; Fable reviews the pipeline core move | publish → order → outbox job with the SnapWear payload shape; screening/takedown authz tests |
| **8 Cutover** | Production env; data re-seed (final); forced password resets; domains + DNS (melodie-mc first); Stripe prod webhook; Resend domain; smoke + one real test order + refund; Firebase → **read-only for 14 days**, then project deleted; personal-account staging deleted; memory + docs updated. | Sonnet (data) + Opus; Mikael runs DNS/Stripe dashboard steps | melodie-mc live on CF; Firebase billing → 0 |
| **9+ Later** | Reviews, abandoned-cart emails, discount-code admin, content studio (ffmpeg), B2B, migrators, DAC7, print portal, b2c accounts, custom-domain UI, SSR/SEO for the storefront. | — | one checkpoint each, same pipeline |

Rough size: CP0–2 ≈ 1.5 weeks, CP3–5 ≈ 3 weeks, CP6–7 ≈ 2–3 weeks, CP8 ≈ 1 week → **7–9 weeks** of Claude time, assuming Mikael's turnaround on decisions/DNS/Stripe steps within a day. SnapWear A5/A6 land inside CP7 only if Natalia's answers (C1–C6) arrive by then.

---

## 11. Decisions Mikael owes (blocking the checkpoint noted)

1. **Kent's account: personal or company (Meteor PR AB) — and is it on Workers Paid?** Needed for D1 limits, Queues and Containers. Mikael must be invited as admin; today `wrangler whoami` cannot see it. *(blocks CP1)*
2. **Render service:** Cloudflare Containers on that account (if the plan allows) vs one Cloud Run container in a **new** GCP project. Recommendation: Containers if available (one account, one bill), else Cloud Run. *(blocks CP7)*
3. **Domains at cutover:** real domains (melodiemc.com for Kent's shop, a platform domain for admin/platform) vs keep temporary hostnames. Recommendation: real. *(blocks CP8)*
4. **DELETE sign-off** for §3.3 — especially the CRM wagons and the affiliate program. *(blocks CP0's quarantine of their code)*
5. **Docs UNSURE (7)** in `INVENTORY_DOCS.md`: the two July legal `.docx` drafts, `juridik.md`, `stripe-review-export/`, `METEOR_PAKETERING_KENT.pdf`. *(CP0)*
6. **Storefront SEO:** keep the SPA shell for the port (design-identical) and do SSR as a later checkpoint — or fold SSR in now? Recommendation: later; it is not a data-layer change.

---

## 12. Risks and how the plan handles them

| Risk | Mitigation |
|---|---|
| Drift again (building on Firebase "just this once") | Freeze rule + `hotfix:` prefix; LAUNCH_TODO marks the freeze; memory records it. |
| Silent scope creep in the frontend rewrite | Per-file work list with effort ratings; a checkpoint owns a fixed file set. |
| Design drift | Baseline screenshots + pixel diff gate; impeccable contract first. |
| Wrong account / wrong Stripe mode | Preflight script is the only wrangler entry point; key-prefix check per env. |
| Money-path regressions | Pure invariants ported as tests before the routes (CP6 exit criteria include a sandbox order). |
| B8shield residue | CI guard + rename list; `OBSOLETE/` never crosses. |
| Render service latency/cost | Contract v0 exists; artwork validation is async (queue + status), studio already handles "processing". |
| Reviewer fatigue → rubber stamps | Two independent reviewers, findings must be listed in the handover entry (empty list is suspicious and gets challenged). |
| SnapWear unknowns (C1–C6) | Outbox stub keeps CP7 shippable; A5/A6 slot in when answers arrive. |
