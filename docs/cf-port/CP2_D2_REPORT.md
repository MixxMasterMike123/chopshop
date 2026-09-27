# CP2-D2 — money follow-ups: report

Builder: CP2-D2 (branch `cf-port`, worker `cloudflare/`). Scope: DECISIONS **D36** (release the production withholding), **D40** (alert digest email), **D41** (parcel-inclusive price floor), plus the reviewer's **Part 4** (two Codex P2s on `f5a93e7`).
No git state was changed and no wrangler command was run. `~/.config/chopshop/*` was not read.

## 1. What was built

| Part | Result |
|---|---|
| 1 · D36 | `0028_withholding_release.sql`; `src/commerce/withholding-release.ts` (eligibility, reservation, discovery, execution, webhook settlement); reservation appended to the refund-settlement batch (`refund-dispatch-stop.ts`); discovery + execution in `runReconciliation`; `application_fee.refunded` / `application_fee.refund.updated` in `stripe-events.ts`; fee-refund gateway seam in `stripe-client.ts`; payout fact `withholding_released_minor` |
| 2 · D40 | `0029_alert_digest.sql` (`platform_state` + ledger kind); `src/commerce/alert-digest.ts` `runAlertDigest(env, now)`, re-exported from `crons.ts`; `alert_digest` kind in `auth-email-job.ts` (Swedish render) |
| 3 · D41 | `podPriceFloorMinor` in `src/pod/pod-quote.ts` (floor over per-item cost + the printer's parcel); the two gate call sites switched to it |
| 4 · Codex P2s | `parkForHold` in `dispatch-hold.ts` (+ the effect's hold branch); second-aligned resync watermark in `crons.ts` |

### Files

Owned list: `migrations/0028_withholding_release.sql`, `migrations/0029_alert_digest.sql` (new); `src/commerce/{withholding-release,alert-digest}.ts` (new); `src/commerce/{admin-orders,crons,dispatch-hold,money-alerts,payouts,refund-dispatch-stop,stripe-client,stripe-events}.ts`; `src/pod/pod-quote.ts`; `src/email/{auth-email-job,email-queue-consumer}.ts` (the consumer: doc comment only — `parseAuthEmailJob` already dispatches on kind); `src/env.d.ts` (additive); `test/money-followups.test.ts` (new); `test/pod-mappings.test.ts`, `test/pod-publish.test.ts` (numbers only).
Permitted by the addendum: `src/dispatch/dispatch-effect.ts` — the hold branch (1 line) + its import (1 line).

**Outside the list — please confirm (both minimal, both unavoidable for the spec):**
- `src/pod/pod-mappings.ts` (3 lines): the two gate call sites `priceFloorMinor(quote.productionCostMinor, vat)` → `podPriceFloorMinor(quote, vat)` + the import. `priceFloorMinor` only receives a cost, so without this D41 would exist as a function the gates never call. `pod-quote.ts` now returns the parcel on the quote; the call sites are the only place that chooses the floor.
- `src/email/email-delivery-store.ts` (3 lines): `fingerprintAuthEmailJob` adds `digest: canonicalAlertDigestContent(job.digest)` **only for `kind === "alert_digest"`**, exactly as it already does `order` for `order_confirmation` — every existing fingerprint is byte-identical. This is the "fingerprint covers the content" requirement; the fingerprint function lives in this file.

`src/app.ts`, `REQUIRED_MIGRATION`, `vitest.config.ts`, `test/slice*`, `scripts/cf-port/**` were not touched (no route was needed).

## 2. D36 — releasing the production withholding

### Schema (`0028_withholding_release.sql`)
- `orders.withholding_released_minor INTEGER NOT NULL DEFAULT 0 (≥ 0)` + trigger `orders_withholding_released_bounds`: never above `withheld_minor`, never decreasing.
- Partial index `orders_withholding_release_candidates_idx ON orders(paid_at) WHERE withheld_minor > 0 AND withholding_released_minor = 0 AND (cancelled_at IS NOT NULL OR (charged_minor > 0 AND refund_succeeded_minor >= charged_minor))` — the discovery query repeats this WHERE verbatim.
- `withholding_releases(id PK [A-Za-z0-9_-]{16,64}, tenant_id FK, order_id FK UNIQUE, amount_minor > 0, state reserved|submitted|succeeded|failed, cause full_refund|order_cancelled, attempts ≥ 0, stripe_application_fee_id, stripe_fee_refund_id UNIQUE, last_error (code), created_at/updated_at/settled_at ISO)`; CHECKs: `state='succeeded' ⇔ stripe_fee_refund_id NOT NULL`, `state ∈ {succeeded,failed} ⇔ settled_at NOT NULL`.
- Triggers: identity immutable (id, tenant, order, amount, cause, created_at; fee/refund ids set-once; attempts one-way), state machine, final rows frozen, **birth** (`state='reserved'`, `attempts=0`, tenant = the order's, `amount_minor = orders.withheld_minor` — a release can only ever be exactly the withholding), append-only (no delete). Indexes `(state, updated_at)`, partial `(stripe_application_fee_id)`.

### Eligibility (`releasableSql`) — "production can provably never happen"
`withheld_minor > 0` ∧ not yet released ∧ (fully refunded ∨ `cancelled_at`) ∧ status not a return case ∧ ≥ 1 dispatch row ∧ **every dispatch row `superseded` with `submitted_at IS NULL` and `unknown_since IS NULL`** (D36: "before submission"; 0021 makes all three final/one-way) ∧ no `printer_cancellation` row ∧ no line `submitting|accepted|unknown|failed`, `printer_job_ref`, `dispatched_at` or `production_state`. A partial refund never qualifies (dispatch is not superseded). One row per order (`order_id` UNIQUE) for the whole withheld amount.

### State machine
```
reserved ──► submitted ──► succeeded
   │             └───────► failed
   ├──────────────────────► succeeded   (a webhook fact beat the call)
   └──────────────────────► failed      (Stripe refused)
```
- **reserved** — born in the refund-settlement batch (appended to `fullRefundStopStatements`, AFTER the supersede statements, state-conditioned + `ON CONFLICT(order_id) DO NOTHING`), or by reconciliation's **discovery** (same predicate) for paths that supersede elsewhere: CP2-B's cancel route and an in-flight dispatch that honoured its cancellation later.
- **submitted** — write-ahead before each create call (`attempts + 1`). Before any further create, the fee's refunds are LISTED and one carrying `metadata.withholding_release_id = id` settles the row (a lost answer is found, never repeated — also past Stripe's 24 h idempotency window); an incomplete listing never proves absence.
- **succeeded** — one batch: row → succeeded (+ fee refund id) and `orders.withholding_released_minor` := the succeeded row's amount (idempotent by construction).
- **failed** — Stripe refused (4xx): critical alert `withholding_release_failed`; final, no automatic second attempt.
- Stranded: reserved/submitted > 30 min after birth → warning `withholding_release_unsettled_30m`.

### Stripe calls and events
- `POST /v1/application_fees/{fee}/refunds` `{ amount: withheld_minor, metadata: { order_id, tenant_id, withholding_release_id } }`, `Idempotency-Key: <release id>` (verified against the Stripe API reference and SDK 22.5.0: `stripe.applicationFees.createRefund(id, {amount, metadata}, {idempotencyKey})`; returns a `fee_refund` synchronously; refuses more than the fee's unrefunded remainder). Commission stays with the platform (D9).
- `GET /v1/application_fees/{fee}/refunds` (paged, `collectPages`) — the "ask Stripe first" read.
- The fee id: `charges.retrieve(stripe_charge_id).application_fee` (or the intent's expanded `latest_charge` when the charge id is unknown), recorded on the row.
- Events (D1 only, `withholding-release.ts handleApplicationFeeEvent`): `application_fee.refunded` (ApplicationFee, embedded `refunds.data`) and `application_fee.refund.updated` (one `fee_refund`), deduped by fee refund id / `metadata.withholding_release_id`; a different amount → not recorded + critical alert, ledger `rejected/refund_amount_mismatch`; a fee refund on one of our orders that no release made (the dashboard) → warning `withholding_release_unmatched`; a foreign fee → `ignored`.
- **Seam:** `StripeFeeRefundGateway` is SEPARATE from `StripeMoneyGateway` (`MONEY_METHODS` unchanged). `resolveStripeFeeRefundGateway` accepts the test override only if it implements the three fee methods; an override without them yields **null** (execution skipped, `summary.withholding.stripe = "unavailable"`), never the real client. Rationale: every existing suite's `FakeMoneyStripe` (and CP2-D1's slice harness) keeps working unchanged and can never have a release executed behind its back. Production (no override) always gets the real client.

### Payout facts and the ONE fee figure
- `PAYOUT_FACT_COLUMNS` + `withholding_released_minor`; `amount = charged − refunded − (fee − released) − transfer_reversed + retransferred`.
- `GET /v1/admin/orders/:id` → `money.feeMinor` = the **net** platform deduction (`netFeeMinor`), so `payout = charged − refunded − feeMinor` holds for the figures the seller sees. No new key; the denylist test walks the body after a release (no `withh|release|production|cost|commission|…` key, exactly one fee key, neither the withheld 12 300 nor the gross fee 13 300 in the text).
- Worked example (tests): charged 20 000, fee 13 300 (withheld 12 300 + commission 1 000), full refund → payout **−13 300** before the release, **−1 000** after. **Note:** "payout no longer negative" in the brief is not reachable under D9 — the shop still owes the non-refundable commission. See open question 1.

## 3. D40 — the alert digest email

- `0029_alert_digest.sql`: `platform_state` (ONE row, id = 1, inserted by the migration; no delete; `last_digest_at` forward-only) with `last_digest_at`, `digest_bucket_start`, `digest_computed_at`, `digest_json` (frozen content); `email_deliveries` recreated (0022's recipe, identical shape/triggers/indexes) to admit `alert_digest`.
- `runAlertDigest(env, now)` (in `alert-digest.ts`, exported from `crons.ts`): no `PLATFORM_ALERT_EMAIL` (or not an address) ⇒ one `console.info` line, `{status:"unconfigured"}`; no `EMAIL_QUEUE` ⇒ `queue_unconfigured`. Otherwise, for the 15-min bucket of `now`: if no digest is frozen for it, read open alerts; none created after `last_digest_at` ⇒ `nothing_new`; else freeze the content (first writer of the bucket wins, forward-only) → ledger record (`recordAuthEmailDelivery`, tenant NULL) → `EMAIL_QUEUE.send` → advance `last_digest_at`. Delivery id = `deliveryIdFromKey("alert_digest:" + bucketStart)`.
  - retried tick after success ⇒ `already_sent`, no job; after a failed enqueue ⇒ the IDENTICAL frozen job again (same id, same fingerprint), ledgered once; a crash between send and advance ⇒ the same job twice on the queue, sent once by the ledger (+ Resend idempotency key).
- Digest format (`AlertDigestContent`): `{ bucketStart, newCount, openCount, omittedKinds, kinds: [{ kind, severity (max), count, newCount, oldestAt, resourceIds (≤ 5, oldest first) }] }`, ≤ 30 kinds, ordered critical → warning → info, oldest first. **Never** an alert message, an amount or customer data (validated on build and on parse).
  - Subject: `Plattformslarm: 3 nya, 3 öppna`. Body line: `dispatch_stranded_30m (kritisk): 1 öppna, 1 nya, äldst 2026-09-27 08:15 UTC` / `  Resurser: outbox-1`; footer `Larmen hanteras i plattformens admin. Sammanställningen innehåller inga belopp eller kunduppgifter.` Job lifetime 6 h.
- "created/updated since the last digest": alerts have no `updated_at` (0017: the only change is resolving), so the trigger is "open alerts created after `last_digest_at`".

## 4. D41 — the floor includes the printer's parcel

`podPriceFloorMinor(quote, vatRateBp) = priceFloorMinor(quote.productionCostMinor + quote.parcelMinor, max(vatRateBp, PRODUCTION_VAT_BP))`, where `priceFloorMinor` is the unchanged exact-öre port of `podPricing.js` (`ceil((cost·(1+v) + 5 kr) / 0.92)` to whole kronor). `quotePodCost` now reads `printers.shipping_cost_minor` into `PodQuote.parcelMinor` (server-only); a quote without it is not floor-able (null, fail closed). Deliberate divergence from Firebase documented at the function (D41).

- **`max(tenant VAT, 25 %)`** — an addition to the brief, needed for "a single-item order at the floor ALWAYS clears the withholding": the withholding carries the platform's 25 % production VAT whatever the tenant's rate, and at tenant VAT 0 (a VAT-exempt small shop) the per-item formula puts the floor *below* the withholding. For 25 % tenants (the POD norm) it is exactly Firebase's factor. Proven by a property test over costs 0–600 kr, parcels 0–99,99 kr, VAT 0/6/12/25 %: `withholding ≤ floor` and `commission (5 % or 8 %) + withholding < floor`.

| Fixture set (parcel 49 kr) | cost ex VAT | floor before | floor after | withholding (1 item) |
|---|---|---|---|---|
| tee front | 140 kr | 196 kr | **263 kr** | 236,25 kr |
| tee front + pocket | 160 kr | 223 kr | **290 kr** | 261,25 kr |
| tee front + back | 180 kr | 250 kr | **317 kr** | 286,25 kr |
| tee front + back + pocket | 200 kr | 278 kr | **344 kr** | 311,25 kr |
| cap front | 120 kr | 169 kr | **236 kr** | 211,25 kr |
| tee front, tenant VAT 0 | 140 kr | 158 kr | **263 kr** | 236,25 kr |

Before, a 196 kr tee could not be bought alone (236,25 kr withheld > 196 kr). Test: a product priced exactly 263 kr maps (floor 26 300), publishes and checks out with quantity 1 (snapshot `withholdMinor 23 625 ≤ 26 300`). Fixture changes kept each test's intent: `pod-mappings` expected floors (and `parcelMinor` in the `quotePodCost` shape); `pod-publish` floor boundaries 19 5xx → 26 2xx/26 3xx, "between the two floors" variants 200 → 290 kr, and the base-price case now checks out AT the floor (it used to need 299 kr because of this very gap).

## 5. Part 4 — Codex P2s on f5a93e7

1. **Hold after claim burnt attempts.** `parkForHold(ctx, line)` (dispatch-hold.ts): under the claim's fence, only while `status='claimed'`, the order is STILL held, and an attempt remains, the row goes to exactly the held state (`pending`, claim released, `next_attempt_at = DISPATCH_HOLD_UNTIL_MS`, `last_error='payment_facts_pending'`; line `submitting → pending`) — no retry backoff, so no attempt is spent while held; `releaseDispatchHolds` un-parks it unchanged. 0021 makes `attempts` one-way, so the attempt of the claim that discovered the hold stays spent (cannot be refunded); that is the only one. Returns null otherwise and the effect falls back to `retryLater` (a released hold retries soon; a last-attempt row fails with its alert rather than being parked unclaimable forever). dispatch-effect.ts: `return (await parkForHold(ctx, lineRef)) ?? retryLater(ctx, "payment_facts_pending", lineRef);`.
2. **Resync watermark.** `stripe_account_synced_at` is written as `secondWatermark(now) = floor(now/1000)·1000` ("as of the start of this second"), so an `account.updated` created in the same second is a TIE (merged fail-closed + marked for resync by the existing handler), never stale-dropped.

Both regression tests were verified to FAIL with the fix reverted.

## 6. Tests

`test/money-followups.test.ts` — 29 tests:
- D36 (16): full refund before dispatch → reserved in the settlement batch, executed once (idempotent over 3 runs, no stranded alert), payout −13 300 → −1 000; denylist after release; admin cancel found by discovery (`cause: order_cancelled`); **no release** after printer acceptance, after a submitted-then-superseded job, on a partial refund, on a non-POD order; lost answer found by listing (1 create call total); Stripe refusal → failed + critical alert, no retry; unreachable Stripe → submitted + stranded alert at 30 min; fake without fee methods never executes; webhook settlement + replay + `refund.updated` already_applied; amount mismatch rejected + alert; dashboard fee refund → unmatched warning; foreign fee ignored; schema guards (birth amount, born reserved, UNIQUE order, append-only, bounds).
- D40 (6): var absent ⇒ none; alerts ⇒ one job (exact content, no message text/amounts, tenant-NULL ledger row, parse + Swedish render); retried tick ⇒ nothing more, next bucket with nothing new ⇒ none; failed enqueue ⇒ identical frozen job ledgered once, late alert new for the next bucket; fingerprint covers content (tampered body = `conflict`); `platform_state` guards.
- D41 (3): formula + fail-closed; property test; publish + checkout exactly at the floor.
- Part 4 (4): claim → hold → release (attempts 1 throughout 12 held sweeps, then dispatched once on attempt 2); last-attempt fallback fails with alert; hold gone before the park ⇒ nothing parked; same-second restriction after a resync applied.

`npm run check` — before: **47 files / 1683 tests** (the brief said 1681/47; the tree measured 1683 at start). After (with CP2-D1's concurrent `test/slice*` in the tree): **50 files / 1738 tests, all passing** — this checkpoint: +1 file, +29 tests; `pod-mappings`/`pod-publish` counts unchanged (57).

```
> npm run types:check && npm run build && npm test
 Test Files  50 passed (50)
      Tests  1738 passed (1738)
```

## 7. For the reviewer — wiring

- **wrangler.jsonc**: add `"PLATFORM_ALERT_EMAIL": "<ops address>"` to `env.staging.vars` (and production at CP7), then `npm run types`. Delivery also needs `RESEND_API_KEY` + `EMAIL_FROM` (D34). Declared optional in `env.d.ts` (a required declaration breaks every suite until the var exists in the generated types).
- **scheduled()**: `runAlertDigest` from `../commerce/crons` AFTER `runReconciliation` (add it to `CommerceCrons` / the step list). `runReconciliation` already runs D36 discovery + execution (summary key `withholding`).
- **Stripe platform webhook endpoint** (connect = false): add `application_fee.refunded` and `application_fee.refund.updated` to its enabled events (staging `we_1UK6L6KAaBMOW5ACcH1EYz0z`; production at CP7). The repo pins only the endpoint ids (no event list found in `scripts/`), so nothing else to update. Without them, releases still settle from the API response / the listing — the events are the redundant path.
- **REQUIRED_MIGRATION** → `0029_alert_digest.sql` (reviewer bumps; `/ready` tests follow).
- Optional one-liner in CP2-B's `cancelOrder` batch: append `reserveReleaseStatement(db, {nowMs, orderId, tenantId})` after `dispatchCancellationStatements` to reserve at cancel time instead of at the next discovery (≤ 15 min later; behaviour is otherwise identical).

## 8. Open questions

1. **Commission on a pre-production full refund (D9).** After the release the shop still owes the 5 % commission on money it fully refunded (−1 000 öre in the example). D9 says non-refundable; confirm that is intended for orders that never shipped, or extend D36 to refund the whole fee when nothing was produced.
2. **A job the printer REFUSED after submission** (submitted, then `superseded` on rejection + cancel) releases nothing under the strict "before submission" rule. It is safe (the printer said no), but the platform then keeps the withholding. Relax to `superseded ∧ unknown_since IS NULL`? And **`failed` dispatch rows** (never accepted, but a human may still resolve them to `done`) block the release until resolved — a later resolution to `superseded` is impossible (failed → done only), so such orders need a platform action.
3. **Dashboard fee refunds** are alerted (`withholding_release_unmatched`) but not counted in the payout facts. Count them as releases, or keep them out-of-band?
4. **Custom commission above 8 %** (`tenants.commission_bps > 800`): the floor assumes the 8 % BAS fee; above that, a single item at the floor can still exceed the gross on large prices. Fine while per-shop tiers have no billing rails (PLUS 5 % / BAS 8 %); revisit with tiers.
5. **D41 VAT factor** `max(tenant VAT, 25 %)` goes beyond the brief (see §4); rule on it.

## 9. Codex fix on 0cad1f0 — the release executor could starve (P2)

**Finding.** `executeWithholdingReleases` took the 50 oldest unsettled releases each run (`ORDER BY updated_at`), and a row that failed early (fee lookup, refund listing) returned without touching any column — so 50 rows failing forever filled every batch and newer, processable releases (other shops' money) were never examined.

**Fix.**
- `migrations/0030_withholding_release_backoff.sql`: `withholding_releases.next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'` (ISO CHECK) and `last_attempt_at` (ISO, nullable); index `withholding_releases_due_idx (state, next_attempt_at, created_at)`. The epoch default makes existing and newly reserved rows due at once. **REQUIRED_MIGRATION → `0030_withholding_release_backoff.sql`** (reviewer bumps).
- `src/commerce/withholding-release.ts`:
  - Selection: `WHERE state IN ('reserved','submitted') AND next_attempt_at <= now ORDER BY next_attempt_at, created_at, id LIMIT 50`.
  - **Every attempted row is stamped FIRST** (`stampAttempt`: `attempts + 1`, `last_attempt_at = now`, `next_attempt_at = now + releaseRetryDelayMs(attempt)`), a CAS on the attempts value just read that also acts as the run's claim. So every early return (fee lookup failed / fee not found / listing failed or incomplete / unknown create outcome / unreadable response) leaves the row backed off at the end of the queue. `attempts` now counts execution attempts, not create calls; `markSubmitted` no longer increments it.
  - Backoff: 10, 20, 40, 80, 160, 320 min, then capped at 6 h (the first retry is shorter than the 15-min cron, so the next tick retries even when its clock runs slightly early).
  - After `MAX_RELEASE_ATTEMPTS = 10` (about 30 h), a row that still fails goes to `failed` with `last_error = 'attempts_exhausted'` and ONE critical `withholding_release_failed` alert. The message names the last error code and, for a `submitted` row, warns that Stripe may hold a fee refund from an earlier attempt. The alert is inserted in the same batch as the transition, conditioned on the `settled_at` this batch stamped and deduped on an open alert. The Stripe-refusal path uses the same batch.
  - A late Stripe fact for a `failed` release now raises `withholding_release_unmatched` on that release, so the open `withholding_release_failed` alert can no longer dedupe it away. Nothing is recorded; a human settles it.
  - The stranded-alert query skips releases that already have an open `withholding_release_unsettled_30m` alert, so more than 50 stranded rows cannot starve the newer ones of their alert either.
  - Summary gains `gaveUp` (also counted in `failed`).

**Tests** (`test/money-followups.test.ts`, +3; one updated):
- The backoff schedule is pinned.
- **The regression:** 51 releases, the 50 oldest failing the fee lookup forever.
  - Run 1 stamps them (attempts 1, `last_attempt_at` = run time, `next_attempt_at` = +10 min).
  - The 51st is **released on run 2**.
  - Every one of the 50 ends `failed / attempts_exhausted` after exactly 10 fee lookups, with exactly one critical alert each, and no amount appears in any message.
  - Verified to FAIL with the old ordering restored.
- A late fact on a failed release produces the separate `unmatched` alert.
- Updated: the lost-answer test now also asserts the row is not retried within the same tick, and settles on the next one (attempts 2).

`npm run check`: **50 files / 1741 tests passing** (1738 → 1741: +3 here; CP2-D1's `test/slice*` in the tree, unchanged).

Files: `cloudflare/migrations/0030_withholding_release_backoff.sql` (new), `cloudflare/src/commerce/withholding-release.ts`, `cloudflare/test/money-followups.test.ts`, this report. Nothing else touched.

## 10. Codex fixes on 27190ca — round 2 (two P2s, `withholding-release.ts`)

**P2-1 · The final attempt's uncertainty was misreported.** On its last attempt, a row selected as `reserved` could send the create and lose Stripe's answer. `markSubmitted` updated the DB but not the in-memory row, so the give-up alert said "the shop has not received it" with no warning to check Stripe. That risked a duplicate manual payment.
- The attempt outcome now carries `createSent`: THIS attempt sent a create whose result is unknown (a lost answer, or a 2xx that could not be read).
- `uncertain = outcome.createSent || row.state === "submitted"`, where the second term covers an earlier attempt's create.
- An uncertain give-up is recorded as `last_error = 'attempts_exhausted_uncertain'`. The application fee id resolved in the attempt is kept on the row. The critical alert reads: "A create call was sent and its result is UNKNOWN … BEFORE any manual payment, list the refunds of application fee `fee_…` for metadata `withholding_release_id=<id>`".
- A certain give-up keeps `attempts_exhausted`, and its alert says "no create call ever reached Stripe".
- If Stripe's own fact arrives later, the existing `withholding_release_unmatched` alert says "the shop HAS received it".

**P2-2 · An amount mismatch was retried forever.** A listed refund carrying this release's id with a different amount returned `amount_mismatch`, which the executor treated as `skipped`. That bypassed the attempt limit, so the row was listed and created again on every run.
- A mismatch is now handled in ONE place, `applyFeeRefundFact`. For an open (reserved/submitted) release it runs the bounded failure path: `failed`, `last_error = 'amount_mismatch'`, one critical alert in the same batch (money moved that the platform did not ask for; nothing is recorded).
- This holds whichever path saw it: the webhook, the executor's listing, or the create response. The executor maps the result to `failed`, never `skipped`, so the row is never retried.
- A fact for an already-`failed` release always raises the separate `withholding_release_unmatched` alert, with the amount matching or not.

**Tests** (`test/money-followups.test.ts`, +4; one updated):
- **Reserved row, create answer lost on the final attempt:** the row fails `attempts_exhausted_uncertain` with the fee id kept. The alert contains "UNKNOWN" and the list-first instruction, and never "has not received". Stripe's later fact raises the "HAS received it" alert.
- **Reserved row, fee lookup failing on the final attempt:** fails `attempts_exhausted`, and the alert says "no create call ever reached Stripe".
- **Listed refund with our id and another amount:** the release fails once as `amount_mismatch` with one critical alert. Three later runs (past the 6 h cap) make no further list or create calls.
- **Create response with another amount:** the same; exactly one create call in total.
- **Updated:** the webhook-mismatch test now expects `failed / amount_mismatch` rather than `reserved`, and no create call afterwards.

The three new behaviour tests FAIL when the fixes are reverted; the certain give-up test is a contrast case. The regression tests ran in isolation and passed.

`npm run check`: **50 files / 1745 tests passing** (1741 → 1745: +4 here). The first full run had one failure in `test/checkout.test.ts` ("counts replays against the limit…"). That is a fixed-window rate limiter whose 11 requests straddled a window boundary under load. It is unrelated to this change (neither checkout nor the limiter was touched); the file passes alone (195/195) and the full rerun was green.

Files: `cloudflare/src/commerce/withholding-release.ts`, `cloudflare/test/money-followups.test.ts`, this report. No migration (the new `last_error` codes fit 0028's code-shape CHECK); no change to `REQUIRED_MIGRATION`.
