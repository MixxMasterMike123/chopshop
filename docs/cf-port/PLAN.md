# Cloudflare full port — the plan (v3)

Status: **CP0–CP1 APPROVED by Mikael 2026-09-26** (Codex staged-approval path). **CP2+ pending re-review of this v3.** No CP2+ code until then.
History: v1 → Codex round 1 (10 findings + Q1–Q7) → v2 → Codex round 3 on the real v2 (12/25 addressed; remaining B1–B10) → **v3** (this). §13 maps every finding.

Evidence base: `INVENTORY_FUNCTIONS.md` · `INVENTORY_CLIENT_DATA.md` · `INVENTORY_CF_BRANCH.md` · `INVENTORY_DOCS.md` · `MIGRATION_MANIFEST.md` (CP0) · `specs/AFFILIATE.md` (CP0) · `baseline/` (CP0).

---

## 0. Decision and rules

**Decision (Mikael 2026-09-26):** full migration to Cloudflare (Workers + D1 + R2 + Queues + cron) replacing Firebase entirely; the hybrid is abandoned.

**The spine:** nothing broad gets built until **one paid order on Cloudflare is proven fulfillable, cancellable and refundable under failure injection** (CP2). Breadth comes after, in dependency order.

Non-negotiables, each enforced by a *mechanical* gate:

| Rule | Gate |
|---|---|
| Firebase feature freeze | CI on `main` rejects commits that touch `functions/`, `src/`, `firestore.rules`, `storage.rules` unless the subject starts with `hotfix:` (docs/scripts are free). The port's cutover commits carry the trailer `Port-Cutover: yes` as the single, explicit exception. |
| Port what earns its place, delete the rest | §3; DELETE list signed by Mikael (§11). Deferred features get the retirement procedure (§3.4). |
| Zero B8shield transfer | `guard/guards.test.mjs` fails on `/b8shield|b8s[-_]/i` and `from 'firebase/` outside `guard/allowlist.txt` (migration debt — may only shrink; stale entries fail; size baseline may not grow) and `guard/permanent-exemptions.txt` (the few legal-template paths where "reseller" is a live term — separate from debt, never counted). The allowlist must be **empty** by CP7; exemptions remain. |
| Correct account, always | `scripts/cf-preflight.sh <env>` is the only wrangler/API entry point: token injected per command (never inherited from the shell); `whoami` must show exactly one account == pinned id; `wrangler.jsonc` account id == pinned; every binding id (D1, R2, Queues) == `cloudflare/pinned.<env>.json`; Stripe `GET /v1/account` id == pinned per env and key prefix matches the mode; webhook endpoint id == pinned; production refuses unless `dispatchTarget == "snapwear"`. Nulls in the pinned file refuse deploys (bootstrap commands only with `--bootstrap`). |
| Storefront design preserved | Baseline screenshots of the **launch-scope pages** captured on Firebase before any change (§7); pixel diff ≤ 0.5 % or an explained delta per checkpoint. No redesign before the baseline. |
| Two reviews before any deploy | `scripts/cf-deploy.sh <env>` refuses unless: working tree clean, HEAD pushed, and **`git notes --ref=reviews show HEAD`** contains `codex: PASS` and `fable: PASS` (attestations live in git notes — outside the reviewed tree, bound to the immutable SHA, invalid for any other commit); production also needs `mikael: GO`. Clean-checkout CI green for that SHA is a precondition of writing the note. |
| Launch gate = enumerated LAUNCH_TODO ids | Production may accept a real order only when LAUNCH_TODO items **A1–A7, A9–A11, A13–A14 and B1–B10** are ☑ (A12 is post-pilot and excluded). `cf-preflight.sh production` reads the checklist file and refuses if any required id is not ☑. |
| Plan first | This document. Scope changes are edits here, approved, before code. |

---

## 1. What the inventories say (corrected numbers)

- **Functions:** 82 exports → **29 PORT now · 40 PORT-LATER · 13 DELETE**. 9 callables have no client caller. 3 need sharp/ffmpeg.
- **Frontend:** 141 live files touch Firebase; ~460 SDK operations including query scaffolding (173 read calls, 134 writes, 17 listeners, 67 callable sites, 51 Storage, 15 Auth). The launch backlog is the subset in §3.1. 83 sites depend on the Firestore Timestamp shape.
- **CF branch:** reusable foundation (tenant resolution, live D1 authz, Better Auth, fail-closed conventions, schema triggers, R2 ownership, rate limiter, Stripe client + webhook ledger, sharp core extraction, vitest-pool-workers). Upload contract is **Worker-streamed with checksum**; render client is **synchronous (330 s)**; test gate red at HEAD (cp27 config omitted — fixed in CP0). Staging lives in Mikael's personal account.
- **Known defects fixed in the port, not carried:** concurrent partial-refund race in `connectRefund.ts`; synchronous artwork processing; `run-all.sh` stale-build shortcut (hotfixed on main 2026-09-26, `a497d32`).

---

## 2. Target architecture

```
Kent's Cloudflare account (ee213082783ec86585150e876edb6107)  —  envs: staging · production
├─ Worker chopshop-web   : same Vite build as static assets  +  /api/* → chopshop-api over a SERVICE BINDING (env.API)
├─ Worker chopshop-api   : Hono · Better Auth on D1 · D1 · R2 (3 classes) · Queues · cron · Rate Limiting binding
├─ Render service        : sharp (ffmpeg later) — §2.6, host decided by the CP1 benchmark
└─ D1 chopshop-{stg,prod} · R2 {public, private, production} per env · Queues {outbox, email, render-jobs}
```

### 2.1 Tenant + session contract (executable definitions)
- **Two entrypoints on `chopshop-api`:** the public `fetch` handler and a **WorkerEntrypoint class `Internal`** reachable only via the service binding from `chopshop-web`. The public handler **strips** any `X-Tenant-*` header; only the `Internal` entrypoint sets the tenant from the hostname it resolved. A tenant is therefore never request-supplied.
- **Storefront:** tenant = hostname (`<shop>.<platform-domain>` or a verified custom domain — CF for SaaS TXT/CNAME ownership check before it resolves).
- **Admin / platform / print:** one hostname each; active shop is explicit (`X-Shop-Id`, validated against the session's memberships; a platform user's chosen shop). Platform "open shop admin" = server-minted, audited, time-boxed acting-as session.
- **Reset / verification links:** the API only ever builds links from a **per-env canonical origin allowlist** (`pinned.<env>.json → origins`), choosing the origin by the requesting surface — never from `Origin`/`Host` of the request.
- Cookies `Secure; HttpOnly; SameSite=Lax`, scoped per hostname.
- **Guest orders:** confirmation authorizes with a **tenant-bound receipt capability** (256-bit token stored hashed on the order, returned once at checkout, 30-day expiry); the buyer response is a separate **allowlisted schema** (no cost, printer, Connect, snapshot fields). Tests: cross-shop token → 404; private fields never in the buyer schema.

### 2.2 Cross-system consistency: outbox with claims
D1 `batch()` is atomic **only for its own statements**. Every write that must cause an external effect writes an **outbox row in the same batch**: `outbox_events(id, type, dedupe_key UNIQUE, payload, state, claimed_by, claim_expires_at, attempts, next_at, last_error, cancel_requested, result_ref)`. States: `pending → claimed → submitting → done | failed | superseded`, plus `unknown` for effects whose external result was lost (§2.3). A consumer **claims atomically** (`UPDATE … WHERE state='pending' AND (claim_expires_at IS NULL OR claim_expires_at < now)`), re-checks `cancel_requested` after claiming, performs the effect with `dedupe_key` as the receiver-side idempotency key, and records the result. Expired claims are re-claimable; a stale worker's late completion is rejected unless its claim token matches. Delivery: Queue (at-least-once) + a **15-minute cron sweeper**; a **15-minute reconciliation cron** compares Stripe ↔ orders ↔ outbox ↔ dispatch and writes `alerts` (+ email) for anything stranded > 30 min. Alert SLA therefore = 30 min, matching the schedule.

### 2.3 Money
- PaymentIntent: one per checkout, keyed by checkout id; fingerprinted on priced inputs; Connect destination charge with commission + **production withholding** + descriptor suffix.
- Webhook: raw-body signature (`constructEventAsync`), `payment_events` ledger keyed by Stripe event id, then one batch: order + items + production snapshot + `outbox(dispatch)` + `outbox(email)` + discount burn + `receipt_token_hash`.
- **Refunds — reserve before Stripe:** `orders` carries `charged`, `refund_succeeded_total`, `refund_reserved_total`, `refund_version`. A refund request runs one batch: insert `refund_operations(id, order_id, amount, state='reserved', stripe_refund_id NULL)` + `UPDATE orders SET refund_reserved_total = refund_reserved_total + ?, refund_version = refund_version + 1 WHERE refund_version = ? AND charged - refund_succeeded_total - refund_reserved_total >= ?`. Zero rows updated → conflict, re-read, retry. Then Stripe is called with **idempotency key = operation id**; the response moves the op to `submitted` with `stripe_refund_id`; settlement (`refund.updated` / `charge.refunded` webhooks, or the API response when already `succeeded`) is **deduped by `stripe_refund_id`** and moves reserved → succeeded; a failed op releases its reservation. Dashboard-originated refunds arrive as webhooks with no op → an op is created from the webhook and reconciled. Transfer-reversal amounts are stored; seller payout is computed from recorded facts.
- **Dispatch state machine (printer):** the `outbox(dispatch)` row follows §2.2 with `type='dispatch'`; the printer job id is **stable** (`{orderId}-{lineNo}`), so a re-submit after `unknown` is deduplicated by the printer (SnapWear duplicate `job_id` → 400 = already accepted). `accepted` records the printer's response id. Because SnapWear has **no status API**, an `unknown` older than 30 min raises an alert requiring a human check (dashboard/email) and a manual `accepted`/`failed` resolution recorded with who/when.
- **Cancellation vs dispatch:** cancel/refund **before claim** → `superseded` in the same batch; **while claimed/submitting** → `cancel_requested=1`; the consumer re-checks before the HTTP call and, if the call already went out, the result is `accepted` and cancellation becomes a `printer_cancellation` outbox effect (SnapWear: email/manual today → human-action alert); **after acceptance** → same; **after production** → return case, never automatic. All four paths are CP2 tests.
- **Retention (abandoned checkouts):** a checkout's snapshot is purged **only** when (a) its PaymentIntent is `canceled` (confirmed by the cancel API response or `payment_intent.canceled`), or (b) the snapshot has been copied into a committed order. `requires_payment_method` is **not** terminal. Snapshots are retained ≥ 7 days after the PI's last state change; the reconciliation cron lists snapshots without a terminal PI. A late `payment_intent.succeeded` racing the sweep is a CP2 injected test: the sweep cancels via Stripe first (which fails if already succeeded) and only then purges.
- Disputes, `payment_intent.payment_failed`, `account.updated` handled as in Firebase (ported invariants).

### 2.4 Invariants survive the trigger model
- **Screening revalidation** on every mutation that changes screened content or eligibility: product text, mapping create/delete/artwork change, artwork rename/replace, routing/print-area edits. Same predicate (`productUsesMappingSku`), same state machine (`decideScreening`), synchronous, same batch.
- **Public eligibility** is one predicate for every public read: `is_active AND b2c_available AND shop.status='active' AND shop.published!=false AND takedown_at IS NULL AND screening.status <> 'blocked'` (advisory statuses stay public — §11.6). **Cache surfaces enumerated:** product list, product detail, collection pages, menu, sitemap, JSON-LD feed. All public responses are cached under a per-tenant **`catalog_version`** key that is bumped in the same batch as any eligibility transition (takedown, deactivate, unpublish, shop status), so every surface invalidates at once. Test: direct PDP URL returns 404 within one request after takedown.
- **Production eligibility at checkout** is recomputed server-side from current facts when the snapshot is frozen.
- **Takedown / deletion protection:** `products.takedown_at` + D1 trigger `BEFORE DELETE … WHEN takedown_at IS NOT NULL` (platform deletion clears the stamp first through an audited `force` path); `tenant_id` immutable triggers on every tenant table.

### 2.5 Storage classes
| Class | Bucket | Access | Examples |
|---|---|---|---|
| public | `chopshop-{env}-public` | public read via custom domain, immutable versioned keys | catalogue images, collection covers, branding, mockup previews |
| private | `chopshop-{env}-private` | owner-checked, short-lived signed GET only | artwork originals, customer documents, invoices, page attachments |
| production | `chopshop-{env}-production` | server-only; immutable; retained ≥ 24 months | print masters per order line, snapshot artwork refs |

Upload = the branch's **Worker-streamed, checksum-verified** route (size caps per class, content-type sniffing, no overwrite of immutable keys, nightly orphan sweep). No browser-presigned PUT. Stored URLs are rewritten **per class** during migration; private/production never get public URLs.

### 2.6 Render service (contract, whichever host)
`render_jobs(id, artwork_id, version, attempt, state, lease_token, lease_until, input_key, output_prefix, error)`. The Worker enqueues; the service **acquires** a job (`POST /jobs/acquire` authenticated: Containers = private binding, no public ingress; Cloud Run = audience-bound OIDC token verified against the pinned service account), receiving `{job_id, attempt, lease_token, scoped input URL}`. Outputs go to **attempt-specific keys** `…/{artwork}/{version}/attempt-{n}/…`. Completion `POST /jobs/{id}/complete` carries `{attempt, lease_token, checksums}`; the API accepts it **only if** `attempt == current AND lease_token matches AND lease_until > now`, then **promotes** the verified attempt's outputs to the canonical keys in one batch; late completions from expired attempts are rejected and their outputs swept. 3 attempts → alert. Studio flow becomes async (upload → processing → poll). **CP1 benchmarks the largest allowed artwork on both hosts** (memory, cold start, wall time, cost at expected concurrency); decision recorded with numbers. Staging dispatch target = the **fake printer** route (records submissions; SnapWear-shaped responses incl. duplicate-`job_id` 400 and 422), bound only in staging config.

### 2.7 D1 budgets
10 GB per database (Paid), 2 MB per row, 100 bound params per query, 30 s per query, single-threaded per DB. Rules: no binary/base64 in rows; `(tenant_id, …)` index on every tenant table; bounded list queries (`LIMIT` + cursor); `IN (...)` chunked ≤ 90; capacity alert at 5 GB; Time Travel + weekly export to R2 with a **restore drill in CP1**. One database now; tenant sharding designed (tenant id in every key, no cross-tenant joins in code) but not built. **Reporting** (DAC7, platform stats) reads **nightly exports in R2** — never cross-database joins — so sharding later changes nothing for reports.

### 2.8 Time
UTC ISO-8601 strings written by the server; date-only fields `YYYY-MM-DD` interpreted in `Europe/Stockholm` at display; nulls stay null. `src/lib/time.js` replaces the 83 sites; DST tests for pickup dates.

### 2.9 Realtime → polling
Order confirmation polls `GET /orders/:id` (receipt capability) every 2 s ≤ 90 s, cancels on unmount, explicit timeout state; Connect status refetches on return/focus; pages/DAC7/migration/content-studio refetch on mutation or while a job runs (backoff 2→10 s); presence dropped. Every poll has an error state.

---

## 3. Scope — 29 / 40 / 13

### 3.1 PORT now, in CP order
CP2 slice: auth (sign-in, reset with email), shop config read, one product path (artwork → render → mapping → quote → publish), storefront PDP/cart/checkout/confirmation, PaymentIntent + webhook + orders + refunds + withdrawals, Connect onboarding endpoints, outbox + dispatch + cancellation paths, payout card, legal gate + acceptance, screening on publish, takedown, retention sweep, reconciliation.
CP3–6 breadth: platform (shops, features, live gate, users, printers/tiers/areas/routing, reports queue, settings), catalogue (variants, images, collections, pages, menu, branding, legal pages), admin (ProductForm + POD gate, orders list/detail, settings/delivery/pickup, payments UI, users with deactivate), POD (full studio, mappings UI, 3D read-only, infringement report page, rescreen on every mutation), email templates actually sent today.

### 3.2 PORT-LATER (40)
Reviews, abandoned-cart reminder emails, discount-code admin, content studio (ffmpeg), B2B, migrators, DAC7, print portal, B2C accounts (guest checkout + guest withdrawal stay), marketing materials, custom-domain admin UI, **affiliate** (`specs/AFFILIATE.md`), 3D model tooling, generic provisioning UI beyond CP3.

### 3.3 DELETE (13 + code/docs) — needs sign-off
Pre-pivot CRM wagons (dining/ambassador/campaign/writers), `deleteCustomerAccountV2`/`toggleCustomerActiveStatusV2` (→ deactivate), `getGeoDataV2`, `createAdminUserV2`, `syncAdminClaims`, `aggregateDac7Year`, V1 `confirmPasswordReset`, three dead email callables, `processB2COrderCompletionHttpV2`, `scrapeWebsiteMetaV2`; `OBSOLETE/`, b8shield-era docs/images, untracked root clutter.

### 3.4 Retirement procedure
Per item: routes removed from `App.jsx`, navigation + feature flags removed, imports deleted (allowlist shrinks), Firestore data **archived** (JSON per collection to `chopshop-prod-private/archive/firebase/<collection>/`, checksummed, in the manifest) before deletion, entry in `docs/cf-port/RETIRED.md` (what, where archived, how to restore).

---

## 4. Data: migration manifest and cutover order

`docs/cf-port/MIGRATION_MANIFEST.md` (CP0) lists every collection/doc with a fate (carry / archive / drop), fields, id strategy, URL classes, timestamps, and post-import verification (Connect ids, commission, `refundApplicationFee=false`, routing default, blocklist count). Users: Better Auth recreation with an old→new id map and **forced reset** (delivery tested on staging first).

**Authority by phase:** staging seeds re-run freely. **Production:** (1) **freeze first** — Firebase writers and schedules disabled (§10 CP7), outstanding PaymentIntents drained/cancelled, payments reconciled; (2) export → import (deterministic ids; collision = abort) → verify; (3) switch. No Firebase change can occur between export and switch because the writers are already off. After the first CF order is accepted, destructive re-import is refused (`orders` non-empty → abort).

---

## 5. Frontend
`src/api/*` typed client; the 25 wrapper modules re-implemented on it; the 112 inline-SDK files edited in checkpoint order from the inventory's per-file list. Auth contract tests (role, platform flag, active shop, printer membership, acting-as) before the swap. Removing deferred features changes those screens — listed per checkpoint; pixel parity applies to launch-scope pages. Harnesses get a mock API client.

---

## 6. Accounts, environments, credentials
Kent's account (`ee213082783ec86585150e876edb6107`); token `chopshop-cf-port` in `~/.config/chopshop/cloudflare.env` (600), expires 2027-02-01; Mikael's `wrangler` OAuth login is not a member and is never used. `cf-preflight.sh` performs the §0 checks.

**Secrets:** Cloudflare gets **its own** credentials everywhere (new Stripe restricted keys per env on the same platform account, new webhook endpoints + secrets, new Resend key, SnapWear token, Better Auth secret). The only thing shared with Firebase is the Stripe **platform account**, not any key. Sequence: create → deploy CF consumer → verify on staging → (Firebase-side keys stay valid until CP7 + 14 days for rollback) → revoke. **Already-compromised** SMTP password, service-account key and GitHub PAT: verified unused by the retained Firebase paths (grep + 24 h log check) → **revoked in CP0**.

---

## 7. Design gate
CP0 captures baseline screenshots (375/768/1440) of the **launch-scope pages** on the current Firebase deploy (storefront public pages by `$B`; admin/platform pages once a logged-in session is handed off). Impeccable audit → design contract in `DESIGN.md`; drift is recorded, not fixed pre-baseline. Each checkpoint re-shoots its pages on staging and diffs; red blocks; deferred pages are not shot.

---

## 8. Zero-B8shield rename list
`b8shield-reseller-app`, `b8s-reseller-db`, storage bucket names, `DEFAULT_SHOP_ID` and b8shield fallbacks (`src/config`, `src/utils`, `functions/src`), reseller-era wagons, `stripe-review-export/`, `OBSOLETE/`, `public/images/README.txt`. Permanent exemptions (legal-template "reseller") live in `guard/permanent-exemptions.txt`.

---

## 9. Build → review → deploy (per checkpoint)
Opus builds (Sonnet for data scripts) → CI on a **clean checkout of the SHA** → `/codex review` → Fable review → `git notes --ref=reviews add` on that SHA (`codex: PASS`, `fable: PASS`; production adds `mikael: GO`) → `cf-deploy.sh staging` (preflight) → smoke + design diff → handover entry. Any new commit invalidates the note by construction.

---

## 10. Checkpoints (dependency order)

| CP | Scope | Exit criteria |
|---|---|---|
| **0 Hygiene + baseline** ✅ approved | Branch `cf-port`; `cloudflare/` + handover brought in; **red gate fixed**; guards + shrinking allowlist + permanent exemptions; `cf-preflight.sh`, `cf-deploy.sh` (git-notes attestations), `pinned.<env>.json`; `run-all.sh` hotfix (done); docs quarantine + clutter; `MIGRATION_MANIFEST.md`; `specs/AFFILIATE.md`; `RETIRED.md`; storefront **design baseline**; compromised secrets revoked; freeze announced (done). Hono router. | gate green on a clean checkout; preflight demonstrably refuses wrong account/resource/null ids; baseline committed; manifest reviewed |
| **1 Foundation** ✅ approved | Kent's account: D1 ×2, R2 ×6, Queues, secrets created, envs; migrations applied; Better Auth + **password reset with Resend delivery**; §2.1 contract implemented + tested (Internal entrypoint, hostname → tenant, header stripping, origin allowlist, acting-as, receipt capability); platform super-admin bootstrap; D1 backup + **restore drill**; **render benchmark on both hosts → decision**; `render_jobs` acquire/complete contract with fencing; fake printer (staging only). | sign-in + reset work on staging; a tenant header on the public entrypoint is ignored (test); wrong host → opaque 404; restore drill documented; render decision recorded with numbers |
| **2 Vertical slice (THE gate)** | One melodie-mc product seeded by script: artwork upload → render job → validation → mapping → `quotePodCost` → publish (screening inline, fit, floor) → storefront PDP/cart/checkout (legal gate, consent, pickup) → sandbox PaymentIntent (Connect, withholding, descriptor) → webhook → order + snapshot + outbox in one batch → dispatch (claims) → fake printer → payout card → refund (reserve-first) → cancellation paths ×4 → retention sweep → reconciliation. **Failure-injection suite:** crash after each external success and before each local commit; duplicate webhook replay; delayed success vs retention sweep; two concurrent partial refunds; duplicate dispatch delivery; lost printer response (`unknown`) → manual resolution; cancel during `submitting`; expired render lease with late completion. | money reconciles to the öre; **one accepted printer job per eligible order, zero for pre-dispatch cancellations**, under every injected failure; stranded work alerts within 30 min; refund race cannot over-refund; guest receipt cannot read another shop's order; late render completion rejected; design diff clean on the slice pages |
| **3 Platform minimal** | Shops config + features + live gate, users + memberships, printers/tiers/areas/routing + `printersPublic` query, settings tables, legal/terms, screening settings, reports queue; manifest scripts executed on staging. | slice operable by a platform user without scripts; staging data = manifest |
| **4 Catalogue + storefront** | Full products/variants/images, collections, pages, menu, branding, legal pages, public read API with the §2.4 predicate + `catalog_version` caching; every storefront page swapped; public R2 images. | storefront diff-clean; anon reads only public fields; takedown → PDP 404 next request |
| **5 Admin** | ProductForm + POD gate, products list, collections, menu, pages, settings/delivery/pickup, orders list/detail, payments/Connect UI, users (deactivate). | admin diff-clean; F1–F5 invariants as Worker tests |
| **6 POD breadth** | Full studio, mappings UI, 3D read-only, infringement report page + footer link, rescreen on all mutations, remaining email templates; **SnapWear A5/A6 real submit** when Natalia's answers land — otherwise a LAUNCH_TODO blocker, never a stub in production. | publish → paid order → SnapWear submission validated against their API doc |
| **7 Cutover (runbook)** | Production env + secrets + pinned ids; staging soak; **1 freeze**: deploy a Firebase build whose writers/schedules are disabled (kept as a deployable rollback artifact together with the previous build), drain/cancel outstanding PaymentIntents, reconcile payments; **2 export → production import (once) → verify**; **3 switch**: CF Stripe webhook endpoint enabled → Firebase endpoint disabled → reconciliation run → DNS (melodiemc.com first); users' resets sent; **rollback** (re-enable Firebase endpoint, redeploy the pre-freeze build, DNS back) is documented and valid until the first CF order; after that, recovery = CF forward-fix + reconciliation (no return to Firebase). Firebase archived (verified export) → read-only 14 days → **deletion checklist** (archive verified, no traffic, deferred data archived, no key still referenced). | melodie-mc live on CF; reconciliation clean; archive verified; required LAUNCH_TODO ids ☑ before the first real order |
| **8+** | PORT-LATER items, one checkpoint each. | — |

**Estimate:** none until measured. CP0–CP2 are timed; the burn rate projects CP3–7 with stated contingency and the external dependencies (Kent: plan, agreements, insurance, accountant; Natalia: C1–C6; Mikael: §11).

---

## 11. Decisions Mikael owes
1. Kent's account on **Workers Paid?** — blocks CP1 · 2. Render host — decided by the CP1 benchmark; Mikael approves the numbers · 3. Domains at CP7 (melodiemc.com + platform domain name) · 4. DELETE sign-off (§3.3) — blocks the code-retirement part of CP0 · 5. The 7 UNSURE docs · 6. Screening policy: advisory or approval-before-first-sale (sets the §2.4 predicate) — blocks CP2 · 7. SSR later (recommended).

---

## 12. Risks
| Risk | Mitigation |
|---|---|
| Paid order never fulfilled / fulfilled twice | outbox with claims + stable printer job ids + failure-injection + 15-min reconciliation |
| Drift back to Firebase | scoped freeze rule in CI |
| Frontend scope creep | per-file work list; launch-scope pages; retirement procedure |
| Wrong account / Stripe target | preflight verifies account + resource ids + Stripe account + webhook per env |
| Private assets exposed | three storage classes; buyer schema allowlist; authz tests |
| Refund over-refund / dashboard refunds | reserve-first ops, op-id idempotency, refund-id dedupe, webhook reconciliation |
| Cancellation vs in-flight dispatch | claim states + `cancel_requested` + human-action alerts for SnapWear |
| Stranded snapshots | purge only on confirmed cancel/commit; 7-day retention; reconciliation |
| D1 limits | budgets; alerts; restore drill; reports from exports |
| Render retries collide | attempt keys + lease tokens + atomic promotion |
| Data lost at cutover | freeze before export; import once; refuse when orders exist |
| Reviewer rubber-stamping | git-notes attestations bound to the SHA; deploy script refuses otherwise |
| Estimate optimism | measured, none stated |

---

## 13. Codex findings → where addressed
**Round 1:** 1 → §0 launch gate (enumerated ids) · 2 → §2.2 claims · 3 → §2.3 reserve-first · 4 → §2.4 · 5 → §2.1 entrypoints + origin allowlist · 6 → §2.5 · 7 → CP7 freeze-first + rollback bounds · 8 → §0/§9 git-notes, clean-checkout CI, `run-all.sh` hotfix · 9 → §0 preflight · 10 → §1 · Q1 → §10 · Q2 → §4 · Q3 → §2.7 (+ reports from exports) · Q4 → §2.9 · Q5 → §2.6 acquire/complete/fencing · Q6 → measured · Q7 → CP2 criteria (one accepted job per eligible order; 30-min alert SLA matching the schedule).
**Round 3 B1–B10:** B1 retention → §2.3 (non-terminal states, cancel-then-purge, 7-day retention) · B2 refunds → §2.3 reserve-first, op-id idempotency, refund-id dedupe · B3 dispatch → §2.2/§2.3 claims, `unknown`, `cancel_requested`, stable job id · B4 cutover → §4/CP7 freeze first, rollback artifacts, post-first-order recovery · B5 attestations → §0/§9 git notes · B6 contradictions → 15-min crons / 30-min SLA; enumerated LAUNCH_TODO ids; "one accepted job per eligible order" · B7 trust boundaries → §2.1 Internal entrypoint, header stripping, origin allowlist; §2.6 authenticated acquire + completion bound to job/attempt/lease · B8 render collisions → §2.6 attempt keys + fencing + promotion · B9 takedown cache → §2.4 enumerated surfaces + `catalog_version` · B10 guards/freeze → §0 permanent exemptions separate from debt; freeze scoped to implementation paths with the `Port-Cutover` exception.
