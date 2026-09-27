# CP2-A report — money: Connect destination charges, reserve-first refunds, the Stripe event matrix, payout facts, retention and reconciliation

Branch `cf-port`, worker in `cloudflare/`. Nothing committed, nothing deployed, no `wrangler` call reached Cloudflare, no state-changing git command run.

**Tests:** baseline `npm run check` green at **1257 tests / 34 files**. Final: **1588 tests / 45 files**, green (types:check, tsc, vitest). That total includes CP2-B's and CP2-C's suites, which landed in parallel. My share is **+147 net**:

- five new suites with 148 tests;
- `webhook.test.ts` went from 67 to 66 (one case list changed, see below);
- `payment.test.ts` stayed at 47 (fixture change only).

`node --test guard/guards.test.mjs` passes. A scan of every file I touched for the guard's forbidden strings (the legacy brand names and firebase imports) is clean.

```
 Test Files  45 passed (45)
      Tests  1588 passed (1588)
   Start at  01:56:41
   Duration  54.57s (transform 24.35s, setup 374.78s, import 3.65s, tests 45.08s, environment 5ms)
```

| Suite | Tests | Covers |
|---|---|---|
| `test/payment-connect.test.ts` (new) | 19 | Firebase fee formulas case by case; destination-charge params; fail-closed 404s; frozen-facts triggers |
| `test/webhook-money.test.ts` (new) | 14 | order batch: frozen money facts, opaque snapshot copy, per-line `production_json`, outbox rows byte-exact, invalid snapshot path |
| `test/refunds.test.ts` (new) | 48 | route guards; reserve → Stripe → settle; 4 concurrency interleavings; dedupe by refund id; dashboard refunds; late failure; full refund stops production; admin read + one-number denylist; schema backstops |
| `test/stripe-events.test.ts` (new) | 37 | intent status events; `nextRecovery` table; disputes created/updated/closed; `account.updated`; unknown types |
| `test/money-crons.test.ts` (new) | 30 | retention (incl. THE late-success race); reconciliation (dispute recovery, refund settle/release, missing orders, stranded dispatch, blocked payouts, alert idempotency); `computePayout` |
| `test/payment.test.ts` | 47 → 47 | **contract change:** fixture shops now have a charges-enabled connected account; the one exact-params assertion now includes the Connect fields |
| `test/webhook.test.ts` | 67 → 66 | **contract change:** "unhandled event types" listed 4 types that are now handled; the list is now `customer.subscription.created`, `invoice.paid`, `payout.paid`, `charge.captured`; the replay case uses `invoice.paid` |

**Mutation checks.** Each mutation was applied, the suites run, and the source restored byte-identical (verified by diff). **25 of 25 were killed.**

| Area | Mutations killed |
|---|---|
| Refunds | no transition fence on the money UPDATE; transition not guarded on its from-state; unconditional op insert; version guard + remaining guard + JS check removed; `refund_application_fee` true; idempotency key ≠ op id; releasing the reservation on an unknown outcome; no dedupe by refund id |
| Crons | purge without the 7-day wait after the cancel; `requires_payment_method` treated as terminal; marking canceled without asking Stripe; dispute reversal refunding the fee; releasing a reservation while Stripe is unreachable |
| Events | reverse-on-created off; a closed dispute able to reopen |
| Alerts | no open-alert dedupe |
| Webhook | no dispatch rows; fee not frozen onto the order |
| Payment | `on_behalf_of` on; withholding ignored; no Connect gate |
| Admin read | leaking the withheld amount — under its own key or under an innocent one |
| Payouts | fee added back; no withdrawal window |

Three mutations first survived:

- **The refund transition fence.** It survived until I added a deterministic settlement race: a D1 proxy holds both batches until both callers have read. That was a real test gap, now closed.
- **Retention**, in its single-edit form. The retention conditions are guarded twice, in the SELECT and again in the UPDATE, so mutating one guard left the other holding.
- **The leak**, in its single-edit form. The admin read never SELECTs `withheld_minor`, so an injected field came out `undefined` and was dropped.

The last two survivals were honest. All three are killed in their full form.

---

## Files

**Tracked files changed**
- `src/commerce/payment.ts` — Connect destination charge
- `src/commerce/stripe-client.ts` — `StripeMoneyGateway` on the same override symbol; `StripeGatewayError.rejected`
- `src/commerce/webhook.ts` — order batch; non-order events dispatched to `stripe-events.ts`
- `src/app.ts` — the import block and my anchor lines only
- `test/payment.test.ts`, `test/webhook.test.ts`

**New source files**
- `migrations/0019_money.sql`
- `src/commerce/payment-events.ts` — ledger helpers and reason codes, moved out of webhook.ts
- `src/commerce/money-alerts.ts`
- `src/commerce/refunds.ts`
- `src/commerce/stripe-events.ts`
- `src/commerce/payouts.ts`
- `src/commerce/crons.ts`
- `src/commerce/admin-orders.ts`
- `src/routes/money-orders.ts`

**New test files**
- `test/money-fixtures.ts` (shared helpers, not a suite)
- the five suites above

**Not touched:** `env.d.ts` and `vitest.config.ts` needed nothing; no new bindings or vars. `0020` is unused and free for a follow-up.

**Not mine, in the working tree:** `src/app.ts`'s uncommitted diff also holds CP2-B's and CP2-C's imports and mounts. `src/routes/dispatch-admin.ts` and `src/routes/dispatch-platform.ts` are untracked CP2-B files.

**`REQUIRED_MIGRATION` and the readiness tests are left for the reviewer**, as briefed.

---

## Schema — `migrations/0019_money.sql`

Money is always integer minor units. For timestamps, new tables use ISO-8601 TEXT, while new columns on existing tables keep that table's INTEGER-ms convention.

**`tenants`** (Firebase `shops/{id}.payments`)
- Columns: `stripe_account_id`, `stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_details_submitted`, `stripe_account_synced_at`, `commission_bps`.
  - `stripe_account_id` is shape-checked `acct_…`.
  - The three flags are 0/1.
  - `commission_bps` is 0–10000, or NULL for the platform default.
- A partial UNIQUE index makes one account belong to one shop.
- Triggers: a capability flag requires an account.

**`checkouts`**
- The Connect facts frozen at PaymentIntent attach: `connect_account_id`, `application_fee_minor`, `withheld_minor`.
- Retention bookkeeping: `payment_intent_status`, `payment_intent_status_at`, `snapshot_purged_at`.
- Triggers:
  - Connect facts are write-once, and all set or all NULL;
  - the fee never exceeds the total, and the withholding never exceeds the fee;
  - `payment_intent_status` never leaves `succeeded`/`canceled`.
- Index for the sweep: `(status, payment_intent_status, payment_intent_status_at)`.

**`orders`**
- Columns:
  - `production_snapshot_json` (JSON object, ≤ 256 KiB)
  - `charged_minor` (backfilled from `captured_minor`)
  - `refund_succeeded_minor`, `refund_reserved_minor`, `refund_version`, `last_refund_op_id`
  - `application_fee_minor`, `withheld_minor`, `connect_account_id`
  - `transfer_reversed_minor`
  - `dispute_id`, `dispute_status`, `dispute_amount_minor`, `dispute_recovery`, `dispute_reversal_id`, `dispute_retransfer_id`, `dispute_retransferred_minor`, `dispute_updated_at`
  - `payout_state` (`pending|eligible|paid|blocked`, default `pending`)
  - `stripe_charge_id`, `stripe_transfer_id`, `stripe_amount_refunded_minor`
- Triggers:
  - The Connect facts and the snapshot are immutable once written.
  - `refund_succeeded_minor ≤ charged_minor`.
  - `refunded_total_minor` must equal `refund_succeeded_minor` (the sync the brief asked for, enforced).
  - Fee ≤ charged and withheld ≤ fee at insert.
- Deliberately **not** a trigger: `succeeded + reserved ≤ charged`. The reservation's guarded UPDATE enforces it for admin requests. A dashboard refund is a Stripe fact that must be recordable even while an admin reservation is in flight; Stripe then refuses the loser, whose reservation is released.
- Semantics of the less obvious columns:
  - `transfer_reversed_minor` counts **dispute** reversals only. A refund's own `reverse_transfer` is proportional, and with transfer = gross it equals the refund, which `refund_succeeded_minor` already counts.
  - `dispute_status` is shape-checked, not allowlisted, so a future Stripe status cannot abort the webhook batch forever.

**`order_items.production_json`**
- The snapshot's `lines[]` entry for the line (`lineNo = item_index + 1`), write-once.

**`refund_operations`** (new)
- Columns: `id, tenant_id, order_id, amount_minor >0, state, prev_state, stripe_refund_id UNIQUE NULL, origin admin|stripe, reason ≤500, created_by, transition_id, created_at, updated_at` (ISO).
- The state machine, enforced by trigger:

  ```
  reserved → submitted | succeeded | failed | released
  submitted → succeeded | failed
  succeeded → failed          (a late card failure)
  released → submitted | succeeded | failed   (Stripe later proves it happened)
  ```

- Other triggers: identity (amount, order, origin, reason, creator) immutable; `stripe_refund_id` write-once; tenant must match the order; no delete.
- An admin op must be born `reserved`, and `origin='admin' ⇔ created_by IS NOT NULL`.

---

## Routes

Mounted inside `// CP2-ROUTES-A` as exact patterns, so CP2-B's `/v1/admin/orders/:orderId/cancel` stays theirs.

Both routes are guarded by the tenant-admin session plus `X-Shop-Id` (membership, or an acting-as grant); POST also requires same-origin. Every guard failure, and any malformed, unknown or foreign order id, is the opaque 404 `{"error":{"code":"not_found","message":"Route not found"}}`.

### `GET /v1/admin/orders/:orderId`
```json
{ "order": {
    "orderId": "<uuid>", "orderNumber": "20260927-XXXXXXXX", "status": "partially_refunded",
    "currency": "SEK", "paidAt": "2026-09-27T01:20:00.000Z",
    "totals": { "subtotalMinor": 20000, "shippingMinor": 0, "discountMinor": 0, "vatMinor": 0, "totalMinor": 20000 },
    "money": { "chargedMinor": 20000, "refundedMinor": 5000, "refundPendingMinor": 0,
               "refundableMinor": 15000, "feeMinor": 13300,
               "dispute": null /* or { "status": "needs_response", "amountMinor": 20000 } */ },
    "payout": { "state": "pending", "amountMinor": 1700, "eligibleAt": "2026-10-11T01:20:00.000Z" },
    "refunds": [ { "refundId": "<uuid>", "amountMinor": 5000, "state": "succeeded",
                   "origin": "admin", "reason": "goodwill", "createdAt": "2026-09-27T01:21:00.000Z" } ] } }
```

- **The seller sees ONE number.** `feeMinor` is the only deduction ("Avgift (plattform & produktion)").
- The projection is built from named columns and never SELECTs:
  - the withheld or commission split;
  - the snapshot, printer or SKU data;
  - the account id or transfer data.
- The suite walks the body against a key denylist (`withh, production, cost, commission, bps, snapshot, printer, connect, transfer, stripe, applicationfee, application_fee`).
- It also checks that neither half of the fee (12 300 withheld, 1 000 commission) nor the 9 840 line cost appears anywhere in the text.

### `POST /v1/admin/orders/:orderId/refunds` — body exactly `{ "amountMinor": <int > 0>, "reason": "<1–500 chars, no control chars>" }`

| Status | Body | When |
|---|---|---|
| 201 | `{"refund":{"refundId","amountMinor","state"}}` | Stripe answered. `state` is `submitted` (pending at Stripe), `succeeded`, or `failed` (Stripe refused; the reservation was released) |
| 202 | same, `state: "reserved"` | Stripe's outcome is unknown (network, timeout, 5xx). The reservation **holds**; the webhook or reconciliation settles it, or releases it after 30 min if Stripe never got it |
| 409 | `{"error":{"code":"refund_not_allowed","message":"The order cannot be refunded by this amount"}}` | More than remains, a charged-back order, or the version race lost 25 times |
| 400 | `invalid_request` | The body is not exactly the shape above |
| 404 | opaque | Guards, or Stripe unconfigured (the surface is dark) |

How a request runs:

1. **Reserve.** One batch holds:
   - `UPDATE orders … refund_reserved_minor += amount, refund_version += 1, last_refund_op_id = op WHERE refund_version = <read> AND charged − succeeded − reserved ≥ amount`;
   - `INSERT refund_operations … SELECT … WHERE last_refund_op_id = op` (a marker, so the op exists only if THIS batch's update applied);
   - the audit row `order.refund.requested`.

   Zero rows means re-read and retry (bounded at 25), or 409.
2. **Call Stripe.** `refunds.create` with:
   - **idempotency key = op id**;
   - `reverse_transfer: true`, `refund_application_fee: false` (D9);
   - metadata `{order_id, refund_operation_id, tenant_id}` only.
3. **Settle.** Every later fact about the refund goes through `applyRefundFact`, deduped by `stripe_refund_id`. The sources are the API response, `refund.created`, `refund.updated`, `refund.failed`, embedded `charge.refunded` refunds, and reconciliation's `listRefunds`.

   One batch performs `UPDATE refund_operations SET prev_state = state, state = <to>, transition_id = <fresh> WHERE id = ? AND state IN (<allowed predecessors>)`. The order's reserved and succeeded deltas are computed in SQL from `prev_state` and `state`, fenced on that transition id, so a replay or a racing fact moves money at most once.

   Order status follows Firebase `refundStateAfter`:
   - a full refund goes to `refunded`, from any status except `cancelled`;
   - a partial refund moves `paid` to `partially_refunded`;
   - fulfilment statuses are left alone;
   - a late failure walks the status back.

   A history row is written for each status change.
4. **A refund that makes the order fully refunded stops production in the same batch.** It uses CP2-B's exported `dispatchCancellationStatements`:
   - unclaimed dispatch rows become `superseded` and their lines `cancelled`;
   - claimed ones get `cancel_requested`;
   - accepted ones get the printer-cancellation path.

   CP2-B's guard means a produced or shipped order (a return case) is never cancelled.

---

## Event matrix (`src/commerce/stripe-events.ts`)

Every event is deduped through `payment_events` by event id. Every handler is **D1-only**, so no Stripe call is made from the webhook (see Deviations, 3).

| Event | Effect |
|---|---|
| `payment_intent.succeeded` | (webhook.ts) the order batch. Adds: frozen `charged/application_fee/withheld/connect_account_id`, `stripe_charge_id` from `latest_charge`, the snapshot copied opaquely onto the order, each line onto `order_items.production_json`, one `dispatch` outbox row per snapshot line, one `email` row, and the checkout marked `payment_intent_status='succeeded'`. An unreadable snapshot (or a `lineNo` naming no order line) still makes the order: no snapshot, no dispatch, and a critical `production_snapshot_invalid` alert in the same batch |
| `payment_intent.payment_failed` | `checkouts.payment_intent_status` ← the object's status (`requires_payment_method`), `…_at` ← now. Not terminal |
| `payment_intent.canceled` | same, ← `canceled` (terminal) |
| `refund.created` / `refund.updated` / `refund.failed` | `applyRefundFact`. An unknown refund on a known order becomes an op with origin `stripe` (the dashboard). An unknown intent is `ignored`. An amount mismatch with the op is `rejected` plus an alert, and no money moves |
| `charge.refunded` | `orders.stripe_amount_refunded_minor = MAX(…, amount_refunded)`, plus embedded refunds applied as facts. Recent API versions do not embed refunds; reconciliation lists them from Stripe when Stripe's figure exceeds settled + reserved |
| `charge.dispute.created` | order: `dispute_id/status/amount`, `dispute_recovery='reversal_pending'` (Firebase `reverseDisputeOnCreated` default true), `payout_state='blocked'`, `stripe_charge_id` filled if missing. Found by intent, else by charge |
| `charge.dispute.updated` | status and amount refreshed. A closed dispute never reopens |
| `charge.dispute.closed` | `won`/`warning_closed`/`prevented`: a made reversal becomes `retransfer_pending`; nothing reversed yet becomes `won_no_reversal`. `lost`: `pending_outcome` becomes `reversal_pending`, otherwise it is final. Payout recomputed. A second dispute id on the same order is `rejected` plus an alert |
| `account.updated` | `tenants.stripe_charges_enabled/payouts_enabled/details_submitted/synced_at`, matched on the **stored** account id, never on account metadata (Firebase's 2026-07-06 wrong-shop incident). Unknown account is `ignored` |
| anything else | `ignored` / `unhandled_event_type`, logged by type only |

---

## Payout facts (`src/commerce/payouts.ts`)

`amount = charged − refund_succeeded − application_fee − transfer_reversed + dispute_retransferred`.

This is the brief's formula, plus the won-dispute re-transfer. It can be **negative**: under D9 a full refund or a lost dispute leaves the shop owing the fee.

| State | When |
|---|---|
| `paid` | Final. No writer yet |
| `blocked` | A dispute is open (an unknown status counts as open), recovery is still moving money (`pending_outcome`/`reversal_pending`/`retransfer_pending`), or the shop's `payouts_enabled` = 0 |
| `eligible` | `now ≥ paid_at + 14 days` |
| `pending` | Otherwise |

`eligibleAt` is `paid_at + 14 d`. The stored `payout_state` is refreshed by the dispute webhooks and by `refreshPayoutStates` in every reconciliation run; the admin read derives it live.

---

## Crons (`src/commerce/crons.ts`)

Two exports, `(env, now: epochMs) → JSON summary`. They throw only on a D1 fault. CP2-B's `scheduled()` (`src/outbox/scheduled.ts`, committed) already calls both after its sweeper.

**`runRetentionSweep`**
- Summary: `{ examined, canceled, skippedSucceeded, skippedLive, purged, errors, stripe }`.
- **Step 1** (only when Stripe is configured). For open or expired checkouts with an intent, where the intent is not `succeeded`/`canceled`, the quote has lapsed, and the last intent change is ≥ 7 days old:
  - `paymentIntents.cancel`, idempotency `retention-cancel:{checkoutId}`;
  - on any refusal or error, **retrieve** the intent and record what Stripe says it IS.
  - Only a confirmed `canceled` marks the checkout `abandoned`. A `succeeded` answer (the late-success race) is recorded and left for the webhook; a live one such as `processing` is recorded and left.
- **Step 2** purges `production_snapshot_json` (and sets `snapshot_purged_at`) only when one of these holds, re-checked inside the UPDATE itself:
  - the intent is `canceled` and has been for ≥ 7 days (the sweep's own cancel is a state change, so the purge comes one retention period after it);
  - the checkout is `completed`, an order exists, and ≥ 7 days have passed;
  - there never was an intent and the checkout expired ≥ 7 days ago.
- `requires_payment_method` is never terminal.

**`runReconciliation`**

Summary: `{ alertsRaised, dispatch, disputes, paymentIntents, payouts, refunds, retention: { snapshotsWithoutTerminalIntent }, stripe }`. In order:

1. **Dispute recovery.** These are the money moves the webhook queued, done here with Firebase's params:
   - `transfers.createReversal`, full, `refund_application_fee: false`, key `dispute-reversal:{disputeId}`;
   - `transfers.create` for exactly what was reversed, key `dispute-retransfer:{disputeId}`.

   A refused reversal becomes `shortfall`, and a missing transfer becomes `no_transfer`; each raises a critical `dispute_recovery_failed` alert. An unknown outcome is retried next run. A dispute won while its reversal is in flight is queued straight back (`retransfer_pending`).
2. **Refunds.** Ops `reserved`/`submitted` for over 30 min, and orders whose Stripe `amount_refunded` exceeds settled + reserved:
   - list the intent's refunds from Stripe and apply them as facts;
   - release a `reserved` op that Stripe's list shows no refund for (only when the list call succeeded);
   - raise `refund_unsettled_30m` for whatever is still open.
3. **PaymentIntents** (72 h lookback, ≤ 5 × 100): a succeeded intent that names a checkout here, has no order, and whose charge is > 30 min old raises a critical `order_missing_for_succeeded_pi`.
4. **Payout states** are refreshed.
5. **Dispatch.** A `dispatch` outbox row not `done`/`superseded` > 30 min after creation raises `dispatch_stranded_30m`; `failed` and `unknown` are included.
6. **Blocked disputes.** An open dispute recorded > 30 min ago on a blocked payout raises `payout_blocked_dispute`.
7. **The retention listing:** a count of snapshots without a terminal intent.

**Alerts** are one open row per (kind, resource), inserted atomically with `INSERT … SELECT … WHERE NOT EXISTS (open alert)`. The id is random, so once an operator resolves an alert, a condition that is still true raises a fresh one. Messages carry ids only, never amounts.

---

## The Firebase formulas and rules ported (with refs)

| What | Firebase | Here |
|---|---|---|
| Commission | `functions/src/payment/connectFee.ts` `computeApplicationFeeOre`: `floor(amount × bps / 10000)`, bps floored and clamped 0–10000, result clamped to [0, amount] | `payment.ts computeCommissionMinor` |
| Commission rate | `connectFee.resolveCommissionBps`: integer shop bps, else platform default; default = `settings/platform.defaultCommissionBps ?? PLATFORM_DEFAULT_COMMISSION_BPS ?? 500` (`config/app-urls.ts:85`) | `resolveCommissionBps`, default constant `DEFAULT_COMMISSION_BPS = 500` until CP3 has a platform settings table |
| Fee = commission + withheld; fee > gross ⇒ refuse (409 `production-exceeds-gross`), never clamp | `connectParams.buildConnectChargeParams` | `buildConnectCharge`; the refusal is the route's opaque 404 plus an operator log line (ids only) |
| POD needs Connect (409 `pod-requires-connect`) | `createPaymentIntent.ts:771-788` | Stricter: **every** checkout needs a charges-enabled account (fail closed, as briefed) |
| Withholding amount | `productionWithholding.computeProductionWithholding` (×1.25, rounded once) | Computed by CP2-C into `totals.withholdMinor`. Read here: a non-integer or missing value refuses payment |
| Statement suffix | `createPaymentIntent.ts:555-569`: NFKD, strip marks, `[A-Za-z0-9 ]`, collapse spaces, ≤ 12, uppercase, omitted without a letter | `statementDescriptorSuffix` (tests: `Sillmans Åkeri & Söner` → `SILLMANS AKE`) |
| Refund params | `connectParams.buildRefundParams`: `reverse_transfer` always on a destination charge, `refund_application_fee` per policy | `reverse_transfer: true`, `refund_application_fee: false` (D9) |
| Cumulative refunds, `refunded` iff total ≥ charged, else `partially_refunded` | `connectParams.refundStateAfter`, `connectRefund.ts` | State machine plus `STATUS_AFTER_REFUND_SQL`. Firebase's concurrent-refund race (PLAN §1) is closed by reserve-first |
| Dispute reversal: full, `refund_application_fee:false`, key on dispute id | `connectParams.buildDisputeReversalParams`, `stripeWebhook.ts:54-131` | `crons.ts recoverDisputes` |
| Won ⇒ re-transfer exactly what was reversed, key on dispute id | `buildDisputeReTransferParams`, `stripeWebhook.ts:844-882` | same |
| Lost ⇒ reverse if not reversed | `stripeWebhook.ts:883-897` | `nextRecovery` |
| Reverse on created (default true) | `platformConfig.reverseDisputeOnCreated` | `REVERSE_DISPUTE_ON_CREATED = true` |
| `account.updated` flags | `connectOnboarding.statusPatch` | flags + synced_at (no email, no `requirementsDue`) |
| `payment_intent.payment_failed` | `stripeWebhook.ts:718-739` marks checkout `failed` (stops abandoned-cart mail) | records the intent status (no reminder mail exists here) |
| Seller sees one number | `orderMoney.ts` split plus `ORDER_MONEY_DENYLIST` | the admin projection plus the denylist/value test; PI metadata stays join-keys only |

---

## Deviations from the brief or Firebase — please rule on each

1. **`on_behalf_of` is OFF.** The brief says "`on_behalf_of` the same". The locked money model does not use it:
   - memory `payments-stripe-connect`: "PLATFORM is merchant of record (NO `on_behalf_of`)";
   - `connectParams.ts`: "NO on_behalf_of → platform stays VAT MoR";
   - the existing `stripe-client.ts` comment warns against adding it by reflex.

   `on_behalf_of` moves the settlement merchant and the VAT liability to the shop. I kept Firebase's model behind `CONNECT_ON_BEHALF_OF = false`, pinned by a test. Flipping it is a legal/tax decision (Mikael/Kent, advisor), and then a one-line change.
2. **Dispute recovery moves money from the cron, not the webhook.** I may not edit the webhook route (outside my anchor), and it passes only `env.DB`, so the webhook cannot reach the Stripe gateway. The dispute handlers therefore record `reversal_pending`/`retransfer_pending` in the fact's batch, and `runReconciliation` performs the Stripe call with Firebase's params and idempotency keys. This is the outbox discipline; latency is ≤ 15 min. If you want it inline, the webhook route needs `resolveStripeMoneyGateway(env)` passed through, which is a one-line edit outside my block.
3. **"On a lost dispute reverse commission"** I read as Firebase's dispute recovery: reverse the transfer, keep the fee. Affiliate commission reversal (`commissionReversal.ts`) is PORT-LATER. **A mechanics note for Mikael:** Firebase's comment claims `refund_application_fee:false` leaves "shop net 0, platform −dispute fee". Its worked example assumes the transfer is gross − fee, but Stripe's destination transfer is the **gross** (memory: "transfer object carries GROSS … fee collected FROM the destination"). With the ported `false`, a lost dispute actually leaves the **shop at −fee** (commission + production) and the platform at +fee − dispute fee. `true` would give Firebase's intended split. The code ports Firebase's `false`; the intended outcome needs a decision.
4. **`warning_closed` (and `prevented`) are treated like WON**, whereas Firebase treats them like lost. An inquiry that closes without a chargeback took nobody's money, so a reversal made on creation is returned to the shop.
5. **A full refund stops production** (CP2-B's statements, in the settlement batch). PLAN §2.3 implies it ("cancel/refund before claim → superseded in the same batch"), and CP2-B exported the statements for it. A partial refund never does.
6. **Unreadable snapshot ⇒ the order is still created**, with an alert and no dispatch, never refused. The money is taken, and the existing webhook philosophy holds.

---

## Integration notes for the reviewer

- **Stripe webhook subscriptions** needed on the CF endpoint:
  - `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`;
  - `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`;
  - `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`;
  - `account.updated`. **This is a Connect event on connected accounts:** the endpoint must be created with `connect: true`, or a second endpoint added, and the preflight pins one endpoint id today.
- **Nothing new in env or config.**
- **Connect onboarding endpoints** (create an Express account, account link, login link) are **not built**; they were not in the CP2-A brief. The CP2-D seed should set `tenants.stripe_account_id` and `stripe_charges_enabled = 1` (and `stripe_payouts_enabled`) directly.
- **Two different alerts can fire for one stuck dispatch.** CP2-B's sweeper raises its `unknown`-row alert; my reconciliation raises `dispatch_stranded_30m` on anything not `done`/`superseded` after 30 min. Their kinds differ, so both appear. Dedupe or keep as the order-level net, as you prefer.
- **`src/dispatch/snapwear-wire.printerJobId` and `src/dispatch/cancellation.dispatchCancellationStatements`** are imported (read-only use). If CP2-B renames either, compile breaks loudly.

---

## Open questions

1. `on_behalf_of` — Deviation 1.
2. Dispute fee mechanics — Deviation 3: should a lost dispute leave the shop at 0 (`refund_application_fee: true` on the reversal) or at −fee (Firebase's actual code, ported)?
3. **D9 and an unproduced full refund.** With the fee non-refundable, a full refund *before production* leaves the platform holding the withheld production cost that it never paid the printer, and the shop pays it (payout = −fee). Intended, or should the non-printed withholding go back to the shop (a reverse transfer of the withheld part)?
4. **Negative payout amounts** are reported as-is. The CP5 payout card needs copy for "you owe".
5. **`payout_state = 'paid'` has no writer.** Matching orders to connected-account Stripe payouts (`payout.paid` on the connected account) is a later checkpoint.
6. **Retention purges the snapshot only.** Abandoned checkouts keep the buyer's email and lines. GDPR retention for those rows is undecided.
7. **Noisy alerts.** A refund pending at Stripe for more than 30 min (Klarna, bank debits can take days) raises `refund_unsettled_30m` once while open. Keep, or exempt `submitted`-and-pending-at-Stripe?
8. **Missing-order alerts only detect.** The alert could self-heal by replaying the event from Stripe's events API (authentic over our key).
9. **Alert e-mail** (PLAN §2.2 "alerts (+ email)") is not wired; rows only.
10. **Platform default commission** is the code constant 500; CP3's settings table should own it.
