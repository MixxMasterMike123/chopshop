# Cloudflare full port — the plan (v2)

Status: **DRAFT v2 for Mikael's approval — no code until approved.** 2026-09-26.
v1 was reviewed by Codex (gpt-6-astra, session `01a0dcfa…`, two rounds); v2 restructures around its verdict: *"the gates can pass without proving that a paid order can be fulfilled."* §13 maps every finding to what changed.

Evidence base: `INVENTORY_FUNCTIONS.md` · `INVENTORY_CLIENT_DATA.md` · `INVENTORY_CF_BRANCH.md` · `INVENTORY_DOCS.md`.

---

## 0. Decision and rules

**Decision (Mikael 2026-09-26):** full migration to Cloudflare (Workers + D1 + R2 + Queues + cron) replacing Firebase entirely; the hybrid is abandoned (a month of drift, 82-function deploys).

**The spine of v2:** nothing broad gets built until **one paid order on Cloudflare is proven fulfillable and refundable under failure injection** (CP2). Breadth comes after, in dependency order.

Non-negotiables, each enforced by a *mechanical* gate:

| Rule | Gate |
|---|---|
| Firebase feature freeze | Firebase commits need a `hotfix:` prefix + one-line justification; CI rejects others on `main`. |
| Port what earns its place, delete the rest | §3; DELETE list signed by Mikael (§11). Deferred features get an explicit retirement procedure (§3.4). |
| Zero B8shield transfer | `guard/` tests fail on `/b8shield|b8s[-_]|reseller/i` and on `from 'firebase/` **outside a shrinking allowlist** (`guard/allowlist.txt`, seeded with today's file list); CI fails if the allowlist ever grows; it must be empty by CP7. |
| Correct account, always | `scripts/cf-preflight.sh` is the only wrangler/API entry point. It verifies: `whoami` account id == pinned; every binding's resource id (D1, R2, Queue) == the pinned id for `APP_ENV`; Stripe `GET /v1/account` id == pinned per env (sandbox for staging, live platform for production); Stripe webhook endpoint id + URL == pinned; connected accounts referenced by shops belong to that platform account. Any mismatch → refuse. |
| Storefront design preserved | Baseline screenshots of the **launch-scope pages** captured on Firebase before any change (§7); pixel diff ≤ 0.5 % or an explained delta per checkpoint. No redesign before the baseline. |
| Two reviews before any deploy | `scripts/cf-deploy.sh <env>` refuses unless `docs/cf-port/reviews/<git-sha>.md` exists for the **exact SHA** with both `codex: PASS` and `fable: PASS` lines, and the clean-checkout CI run for that SHA is green. Reviews list what was checked; an empty findings list is allowed but must say so. |
| Launch gate = LAUNCH_TODO | Production may accept a real order only when every A and B item in `docs/SnapWearDocs/LAUNCH_TODO.md` is ☑. The staging fake printer (§2.6) never exists in production config; `cf-preflight.sh` refuses a production deploy whose dispatch target is not SnapWear. |
| Plan first | This document. Scope changes are edits here, approved, before code. |

---

## 1. What the inventories say (corrected numbers)

- **Functions:** 82 exports → **29 PORT now · 40 PORT-LATER · 13 DELETE** (affiliate moved to LATER with a spec, Mikael 2026-09-26). 9 callables have no client caller. 3 need sharp/ffmpeg.
- **Frontend:** 141 live files touch Firebase; ~460 SDK operations including query scaffolding (173 read calls, 134 writes, 17 listeners, 67 callable sites, 51 Storage, 15 Auth). The launch backlog is the subset in §3.1, not the whole inventory. 83 sites depend on the Firestore Timestamp shape.
- **CF branch:** reusable foundation (tenant resolution, live D1 authz, Better Auth, fail-closed conventions, schema triggers, R2 ownership, rate limiter, Stripe client + webhook ledger, sharp core extraction, vitest-pool-workers). Its **upload contract is Worker-streamed with checksum**, not browser-presigned. Its **render client is synchronous (330 s)**; an async job contract does not exist yet. Its test gate is red at HEAD (config omitted in cp27). Staging lives in Mikael's personal account.
- **Docs:** 9 files to quarantine, 7 need a call, ~529 MB untracked clutter.
- **Known defects to fix in the port, not carry:** concurrent *different* partial refunds race in `connectRefund.ts` (cumulative total read-then-write; refund status not checked); `run-all.sh` only rebuilds `functions/lib` when one file is missing (stale compiled code can pass); the artwork upload modal awaits a synchronous callable.

---

## 2. Target architecture

```
Kent's Cloudflare account (ee213082783ec86585150e876edb6107)  —  envs: staging · production
├─ Worker chopshop-web   : same Vite build as static assets  +  same-origin /api/* → chopshop-api via service binding
├─ Worker chopshop-api   : Hono router · Better Auth on D1 · D1 · R2 (3 classes) · Queues · cron · Rate Limiting binding
├─ Render service        : sharp (ffmpeg later) — §2.6, decision by benchmark (§11)
└─ D1 chopshop-{stg,prod} · R2 {public, private, production} per env · Queues {outbox, email, render-jobs}
```

### 2.1 Tenant + session contract
- **Storefront:** tenant = request hostname (custom domain or `<shop>.<platform-domain>`), resolved in `chopshop-web`, forwarded to the API over the **service binding** as an internal header; the API accepts that header only on the binding, never from the public edge. Custom hostnames require ownership verification (CF for SaaS TXT/CNAME) before they resolve to a tenant.
- **Admin / platform / print:** one hostname each; the *active shop* is explicit (`X-Shop-Id` validated against the session's memberships; a platform user's chosen shop). Platform "open shop admin" = a server-minted, audited, time-boxed acting-as session (replaces the Firebase custom-token handoff).
- Cookies `Secure; HttpOnly; SameSite=Lax`, scoped per hostname; reset/verification links carry the origin they were requested from; no credential reuse across origins.
- **Guest orders:** the confirmation page authorizes with a **tenant-bound receipt capability** (random 256-bit token stored hashed on the order, returned once at checkout, expiring after 30 days); the buyer-facing response is a separate **allowlisted schema** (no cost, printer, Connect or snapshot fields). Tests: cross-shop access with a valid token → 404; private fields never in the buyer schema.

### 2.2 Cross-system consistency
D1 `batch()` is atomic **only for its own statements**. Every write that must cause an external effect writes the effect as an **outbox row in the same batch** (`outbox_events`: type, dedupe_key, payload, attempts, next_at, done_at, last_error). A Queue consumer + a 1-minute cron sweeper deliver at-least-once with **idempotency on the receiver** (dedupe_key = the effect's natural key: `order:{id}:dispatch`, `email:{order}:{type}`, `render:{artwork}:{version}`). A daily reconciliation cron compares Stripe ↔ orders ↔ outbox ↔ dispatch and writes an `alerts` row (+ email) for anything stranded > 15 min. Crash windows after commit are recoverable, never lost.

### 2.3 Money
- PaymentIntent: one per checkout, keyed by checkout id; fingerprinted on priced inputs (port of the existing rule); Connect destination charge with commission + **production withholding** + descriptor suffix.
- Webhook: raw-body signature (`constructEventAsync`), `payment_events` ledger keyed by Stripe event id (idempotent), then one batch: order + items + production snapshot + `outbox(dispatch)` + `outbox(email)` + discount burn.
- **Refunds as a state machine:** `refund_operations` row (requested → submitted → succeeded/failed/pending) created **before** calling Stripe, with an optimistic version on the order's refund total; a concurrent second refund fails the version check and re-reads. Stripe refund status is recorded from the API response *and* from `refund.updated` / `charge.refunded` webhooks, so dashboard-originated refunds reconcile. Transfer-reversal amounts are stored; the seller payout is computed from recorded facts.
- **Cancellation vs dispatch:** a refund or cancellation *before* dispatch marks the outbox row `superseded` in the same batch (dispatch consumer checks order state before sending); *after* dispatch acceptance it creates a `printer_cancellations` outbox effect (SnapWear: manual/email today — recorded as a required human action + alert); after printer production it is a return case, never an automatic cancel. All three paths are tests in CP2.
- **Retention:** the abandoned-checkout sweep cancels a PaymentIntent and purges its snapshot **only after** Stripe confirms a terminal state (`canceled`/`requires_payment_method` with no charge); a delayed `payment_intent.succeeded` racing the sweep is a CP2 injected test (the ledger keyed by event id wins; the snapshot is rebuilt from the order's frozen lines).
- Disputes, `payment_intent.payment_failed`, `account.updated` handled as in Firebase (ported invariants).

### 2.4 Invariants survive the trigger model
- **Screening revalidation** is a service call on every mutation that changes screened content: product text, mapping create/delete/artwork change, artwork rename/replace, and on routing/print-area edits (eligibility). Same predicate (`productUsesMappingSku`), same state machine (`decideScreening`), synchronous, in the same batch.
- **Public catalogue eligibility** is one predicate used by every public read and by cache invalidation: `is_active AND b2c_available AND shop.status='active' AND shop.published!=false AND takedown_at IS NULL AND screening.status NOT IN ('blocked')` (advisory statuses stay public — decision §11.6). Every transition invalidates the cached list for that tenant.
- **Production eligibility at checkout** is recomputed server-side from current facts (routing, print areas, slot printability, quote) when the snapshot is frozen.
- **Takedown / deletion protection:** `products.takedown_at` + D1 trigger `BEFORE DELETE ... WHEN takedown_at IS NOT NULL` (deletion by platform goes through an explicit `force` path that clears the stamp first, audited); `tenant_id` immutable triggers on every tenant table (from the branch).

### 2.5 Storage classes
| Class | Bucket | Access | Examples |
|---|---|---|---|
| public | `chopshop-{env}-public` | public read via custom domain, immutable versioned keys | catalogue images, collection covers, branding, mockup previews |
| private | `chopshop-{env}-private` | owner-checked, short-lived signed GET only | artwork originals, customer documents, invoices, page attachments |
| production | `chopshop-{env}-production` | server-only; immutable; retained ≥ 24 months | print masters per order line, snapshot artwork refs |

Upload = the branch's **Worker-streamed, checksum-verified** route (size caps per class, content-type sniffing, no overwrite of immutable keys, nightly orphan sweep). Browser-presigned PUT is not used. Stored URLs are rewritten **per class** during migration; private/production never get public URLs.

### 2.6 Render service (contract, whichever host)
`render_jobs` (artwork id + version, input key, output keys, state, lease_until, attempts, error). Worker enqueues; the service pulls the job, reads input via a scoped short-lived URL minted at execution, writes outputs to immutable keys, then POSTs completion `{job_id, checksums}` signed with HMAC (Containers, private binding, no public ingress) or an audience-bound OIDC token (Cloud Run). Leases expire → retry; partial outputs cleaned; 3 attempts → alert. The studio flow becomes async: upload → "processing" → poll job state. **CP1 benchmarks the largest allowed artwork on both hosts** (memory, cold start, wall time, cost at expected concurrency) and the decision is recorded with numbers. Staging dispatch target for SnapWear = a **fake printer** route that records submissions and returns SnapWear-shaped responses (incl. duplicate-`job_id` 400 and 422); it is bound only in the staging config.

### 2.7 D1 budgets
Limits: 10 GB per database (Paid), 2 MB per row, 100 bound params per query, 30 s per query, single-threaded per DB. Rules: no binary/base64 in rows (R2 keys only); `(tenant_id, …)` index on every tenant table; every list query bounded (`LIMIT` + cursor); `IN (...)` chunked ≤ 90; capacity alert at 5 GB; Time Travel + weekly export to R2 with a **restore drill in CP1**; one database now, tenant sharding designed (tenant id in every key) but not built.

### 2.8 Time
All timestamps are **UTC ISO-8601 strings written by the server** (`created_at`, `updated_at` never client-supplied); date-only fields (pickup dates, DAC7 periods) are `YYYY-MM-DD` with the shop's timezone (`Europe/Stockholm`) applied only at display; nulls stay null. `src/lib/time.js` (`toDate`, `formatDate`, `formatDateOnly`) replaces the 83 `.toDate()`/`.seconds` sites; tests cover DST boundaries for pickup dates.

### 2.9 Realtime → polling
Order confirmation polls `GET /orders/:id` (receipt capability) every 2 s for ≤ 90 s with cancellation on unmount and an explicit timeout state; Connect status refetches on return/focus; pages/DAC7/migration/content-studio refetch on mutation or while a job is running (backoff 2→10 s); admin presence dropped. Every poll has an error state.

---

## 3. Scope — 29 / 40 / 13

### 3.1 PORT now (what one live shop needs), in CP order
CP2 slice: auth (sign-in, reset with email delivery), shop config read, one product path (artwork → render → mapping → quote → publish), storefront PDP/cart/checkout/confirmation, PaymentIntent + webhook + orders + refunds + withdrawals, Connect onboarding endpoints, outbox + dispatch (+ cancellation paths), payout card, legal gate + acceptance, screening on publish, takedown, retention sweep.
CP3–6 breadth: platform (shops, features, live gate, users, printers/tiers/areas/routing, reports queue, settings), catalogue (variants, images, collections, pages, menu, branding, legal pages), admin (ProductForm + POD gate, orders list/detail, settings/delivery/pickup, payments UI, users with deactivate), POD (full studio, mappings UI, 3D read-only, infringement report page, rescreen on every mutation), email templates actually sent today.

### 3.2 PORT-LATER (40)
Reviews, abandoned-cart reminder emails, discount-code admin, content studio (ffmpeg), B2B, migrators, DAC7, print portal, B2C accounts (guest checkout + guest withdrawal stay), marketing materials, custom-domain admin UI, **affiliate** (spec `specs/AFFILIATE.md` written in CP0 from the live code before retirement), 3D model tooling, generic provisioning UI beyond CP3.

### 3.3 DELETE (13 + code/docs) — needs sign-off
Pre-pivot CRM wagons (dining/ambassador/campaign/writers), `deleteCustomerAccountV2`/`toggleCustomerActiveStatusV2` (order-wiping delete → replaced by deactivate), `getGeoDataV2`, `createAdminUserV2`, `syncAdminClaims`, `aggregateDac7Year`, V1 `confirmPasswordReset`, three dead email callables, `processB2COrderCompletionHttpV2`, `scrapeWebsiteMetaV2`; `OBSOLETE/`, b8shield-era docs/images, untracked root clutter.

### 3.4 Retirement procedure (deferred + deleted features)
For each item: routes removed from `App.jsx`, navigation entries and feature flags removed, imports deleted (guard allowlist shrinks), Firestore data **archived** (JSON export per collection to `chopshop-prod-private/archive/firebase/<collection>/`, checksummed, listed in the manifest) before any deletion, and a one-line entry in `docs/cf-port/RETIRED.md` (what, where archived, how to restore). Done per checkpoint, verified by the allowlist shrinking.

---

## 4. Data: migration manifest

`docs/cf-port/MIGRATION_MANIFEST.md` (CP0 output) lists every Firestore collection/doc with a fate — **carry** (shops incl. Connect ids/commission/payout settings + `legalAcceptances` copied append-only with evidence; users with an **old→new id map** + role/membership/suspension; products/variants/images; collections; pages; menus; branding; `settings/{platform,app,printRouting,podProfiles,podMockupTemplates,contentScreening}`; `printers` + `printerCatalog`; `pod3dModels`; `podArtwork` + `podMappings`; translations; `infringementReports`; `auditLogs`), **archive** (orders + `orderProduction`, deferred-feature collections), **drop** (rate limits, presence, password resets, projections). Storage objects copied per class with a verified checksum list; URLs rewritten by class.

**Phases and authority:** staging seeds may be re-run freely; the **production import runs once**, with deterministic ids (Firestore ids preserved where the schema allows, else the id map), collision = abort; **after the first CF order is accepted, no destructive re-import is permitted** (scripts refuse when `orders` is non-empty). Users recreated in Better Auth with **forced reset**; reset delivery tested on staging first. Go-live settings applied by script and verified: `refundApplicationFee=false`, commission defaults, Connect ids. Sonnet-written idempotent scripts with dry-run + verify tables.

---

## 5. Frontend

`src/api/*` typed client on the session cookie; the 25 wrapper modules re-implemented on it; the 112 inline-SDK files edited in checkpoint order from the inventory's per-file list. **Auth contract tests** (from `AuthContext.jsx`): role, platform flag, active shop, printer membership, acting-as — each a test before the swap. Removing deferred features changes those screens (users edit page, add-on tabs) — listed per checkpoint; "pixel-identical" applies to launch-scope pages only. Harnesses get a mock API client.

---

## 6. Accounts, environments, credentials

Kent's account `Kent@meteorpr.se's Account` (`ee213082783ec86585150e876edb6107`) — token `chopshop-cf-port` in `~/.config/chopshop/cloudflare.env` (600, outside the repo), expires 2027-02-01; Mikael's `wrangler` OAuth login is not a member of this account and is never used for it. `cf-preflight.sh` reads the file and performs the §0 checks.

**Secrets — rotation sequence (Firebase stays alive until CP7):** (1) create the new secret (Stripe webhook endpoint + secret per env, Resend key, SnapWear token, Better Auth secret) and deploy the CF consumer; (2) verify on staging; (3) only revoke a secret when nothing running uses it — the Firebase-side Resend/Stripe secrets are revoked at CP7 after the webhook handover. **Exception:** the already-compromised SMTP password, service-account key and GitHub PAT are revoked in **CP0** (they are not used by the retained Firebase paths after the Resend cutover; verify with a grep + a 24 h log check before revoking).

---

## 7. Design gate

1. CP0 captures baseline screenshots (375/768/1440, light/dark) of the **launch-scope pages only** on the current Firebase deploy, before any change. 2. Impeccable audit → design contract in `DESIGN.md`; drift found is *recorded*, not fixed pre-baseline. 3. Each checkpoint re-shoots its pages on staging and diffs; red blocks; deferred pages are not shot.

---

## 8. Zero-B8shield rename list
`b8shield-reseller-app`, `b8s-reseller-db`, storage bucket names, `DEFAULT_SHOP_ID` and b8shield fallbacks (`src/config`, `src/utils` 15 files, `functions/src` 21), reseller-era wagons, `stripe-review-export/`, `OBSOLETE/`, `public/images/README.txt`. "Reseller" allowlisted only by path in the legal templates.

---

## 9. Build → review → deploy (per checkpoint)
Opus builds (Sonnet for data scripts) → CI on a **clean checkout of the SHA** (vitest-pool-workers, ported pure invariants, guard tests, failure-injection suite from CP2 on) → `/codex review` → Fable review → `reviews/<sha>.md` with both verdicts → `cf-deploy.sh staging` (preflight) → smoke + design diff → handover entry. Production only at CP7 on Mikael's go.

---

## 10. Checkpoints (dependency order)

| CP | Scope | Exit criteria |
|---|---|---|
| **0 Hygiene + baseline** | Branch `cf-port` from `main`; bring `cloudflare/` + handover from `cloudflare-migration`; **fix the red gate**; Hono router; guard tests with the **shrinking allowlist**; `cf-preflight.sh` + `cf-deploy.sh`; `run-all.sh` always-rebuild hotfix on Firebase; docs quarantine + clutter removal; `MIGRATION_MANIFEST.md`; `specs/AFFILIATE.md`; `RETIRED.md` started; **design baseline**; compromised secrets revoked (§6); freeze announced in LAUNCH_TODO. | gate green on a clean checkout; preflight demonstrably refuses a wrong account/resource; baseline committed; manifest reviewed |
| **1 Foundation** | Kent's account: D1 ×2, R2 ×6, Queues, secrets created, envs; migrations applied; Better Auth + **password reset with Resend delivery**; §2.1 routing contract (hostname → tenant, service-binding header, `/api` same-origin, acting-as, receipt capability); platform super-admin bootstrap; D1 backup + **restore drill**; **render benchmark on both hosts → decision**; `render_jobs` + async contract; fake printer route (staging only). | sign-in + reset work on staging; wrong host → opaque 404; restore drill documented; render decision recorded with numbers |
| **2 Vertical slice (THE gate)** | One melodie-mc product seeded by script: artwork upload (streamed) → render job → validation → mapping → `quotePodCost` → publish (screening inline, fit, floor) → storefront PDP/cart/checkout (legal gate, consent, pickup) → sandbox PaymentIntent (Connect, withholding, descriptor) → webhook → order + snapshot + outbox in one batch → dispatch consumer → fake printer → payout card → refund via `refund_operations` → cancellation paths (§2.3) → retention sweep → reconciliation cron. **Failure-injection suite:** crash after each external success and before each local commit; duplicate webhook replay; delayed success vs retention sweep; two concurrent partial refunds; duplicate dispatch delivery; refund before/after dispatch. | money reconciles to the öre; **exactly one** production submission per order under every injected failure; stranded work alerts within 15 min; refund race cannot double-write; guest receipt cannot read another shop's order; design diff clean on the slice pages |
| **3 Platform minimal** | Shops config + features + live gate, users + memberships, printers/tiers/areas/routing + `printersPublic` query, settings tables, legal/terms, screening settings, reports queue; manifest scripts executed on staging. | slice operable by a platform user without scripts; staging data = manifest |
| **4 Catalogue + storefront** | Full products/variants/images, collections, pages, menu, branding, legal pages, public read API with the §2.4 eligibility predicate + invalidation; every storefront page swapped; public R2 images. | storefront diff-clean; anon reads only public fields; eligibility transitions tested |
| **5 Admin** | ProductForm + POD gate, products list, collections, menu, pages, settings/delivery/pickup, orders list/detail, payments/Connect UI, users (deactivate replaces delete). | admin diff-clean; F1–F5 invariants as Worker tests |
| **6 POD breadth** | Full studio, mappings UI, 3D read-only, infringement report page + footer link, rescreen on all mutations, remaining email templates; **SnapWear A5/A6 real submit** when Natalia's answers land — otherwise a LAUNCH_TODO blocker, never a stub in production. | publish → paid order → SnapWear submission validated against their API doc |
| **7 Cutover (runbook)** | Production env + secrets + pinned ids; **production import once** (§4); users recreated + resets sent; Stripe prod webhook created via API and pinned; staging soak; **write freeze on Firebase = Functions writers + schedules disabled explicitly** (deploy a no-op build / delete triggers), outstanding PaymentIntents cancelled, **webhook handover** (CF endpoint enabled → Firebase endpoint disabled → reconciliation run); DNS (melodiemc.com first); **rollback plan** (re-enable Firebase endpoint + hosting) valid until the first CF order; Firebase archived (verified export, §3.4) → read-only 14 days → **deletion checklist** (archive verified, no traffic, no deferred data unarchived). | melodie-mc live on CF; reconciliation clean; archive verified; LAUNCH_TODO A+B all ☑ before the first real order |
| **8+** | PORT-LATER items, one checkpoint each, same pipeline. | — |

**Estimate:** none until measured. CP0–CP2 are timed; the burn rate then projects CP3–7 with stated contingency and the external dependencies (Kent: plan, agreements, insurance, accountant; Natalia: C1–C6; Mikael: §11).

---

## 11. Decisions Mikael owes
1. Kent's account on **Workers Paid?** — blocks CP1
2. Render host: decided by the CP1 benchmark; Mikael approves the numbers — blocks CP2
3. Domains at CP7: real (melodiemc.com + a platform domain, name?) — blocks CP7
4. DELETE sign-off (§3.3) — blocks CP0
5. The 7 UNSURE docs — CP0
6. Screening policy: advisory (today) or approval-before-first-sale — sets the §2.4 predicate — blocks CP2
7. SSR for the storefront: later checkpoint (recommended)

---

## 12. Risks
| Risk | Mitigation |
|---|---|
| Paid order recorded but never fulfilled / fulfilled twice | outbox + idempotent receivers + failure-injection + reconciliation alerts; launch gate |
| Drift back to Firebase | freeze rule in CI |
| Frontend scope creep | per-file work list; launch-scope pages; deferred screens listed; retirement procedure |
| Wrong account / Stripe target | preflight verifies account + resource ids + Stripe account + webhook per env |
| Private assets exposed | three storage classes; buyer schema allowlist; authz tests |
| Refund / cancellation races | state machine + version check + refund webhooks + cancellation paths tested |
| D1 limits | budgets; alerts; restore drill |
| Render unknowns | benchmark first; async contract with leases |
| Data overwritten at cutover | import-once; refuse when orders exist |
| Reviewer rubber-stamping | deploy script refuses without both verdicts for the exact SHA |
| Estimate optimism | no number until measured |

---

## 13. Codex findings → v2
**Round 1:** 1 launch gate → §0 rule + CP6/CP7 · 2 atomicity → §2.2 · 3 refunds → §2.3 · 4 invariants → §2.4 · 5 tenant/auth → §2.1 · 6 storage → §2.5 · 7 cutover → CP7 · 8 gates → shrinking allowlist, review-gated deploy, clean-checkout CI, `run-all.sh` hotfix · 9 account proof → §0 preflight · 10 arithmetic → §1 · Q1 order → §10 · Q2 manifest → §4 · Q3 D1 → §2.7 · Q4 polling → §2.9 · Q5 render → §2.6 · Q6 estimate → measured · Q7 → CP2.
**Round 2 (B1–B8):** guest authorization → §2.1 · payment/fulfilment cancellation races → §2.3 · retention vs delayed success → §2.3 · public eligibility predicate → §2.4 · retirement procedure → §3.4 · reseed overwriting CF state → §4 phases · timestamps → §2.8 · secrets rotation sequence → §6.
