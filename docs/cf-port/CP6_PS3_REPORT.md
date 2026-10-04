# CP6-PS3: checkout refuses a stand-in frame while the canvas is on; the printer's "out of stock" after acceptance (LAUNCH_TODO A7)

Built on HEAD `8aaac26e`, branch `cf-port`, in the working tree only. No git write, nothing on the network, no wrangler command that reaches Cloudflare, no deploy. At the start `git status --short` was empty.

## Design (written before any code)

### Part 1: a stand-in frame is refused at checkout while `PRINT_CANVAS_ENABLED` is on

**Today.** `decideProductionLine` (`src/pod/pod-mappings.ts`) freezes `frameProvisional` beside each print slot and never refuses on it ("frozen beside each slot, never a reason to refuse the cart"). With the canvas on, dispatch then refuses the paid line for good (`canvasFrame` → `print_canvas_frame_provisional`, terminal, `dispatch_failed`), and a human places it by hand. On SnapWear that is every order for 64400, B445, SF500, TRUCKER and W101.

**The rule.** `decideProductionLine` takes a boolean `refuseStandInFrames`. When it is true and the line's model is `provisional`, the line is not producible (`null`): exactly the path every other unproducible POD line takes, so `freezeProductionSnapshot` returns `null` and `createCheckout` answers `invalid_items` before anything is written. `resolveProductionLines` threads the boolean. `resolveProductionLine` (the one-line reader; no caller in `src/` today) passes `false`, so it keeps its present behaviour. `CheckoutOptions` gains `refuseStandInFrames?: boolean` (absent = false). The route (`src/app.ts` `handleCheckoutRoute`) passes `printCanvasEnabled(env)`: the switch is read once, at the edge, and only a boolean goes inward. Dispatch is not touched: a line paid before the switch went on, or a checkout created while it was off and paid after, still meets `canvasFrame` and fails closed with its alert, as in PS2.

**Off = nothing changes.** With the switch off or unset (production today) the boolean is false and the function takes exactly today's path. A test proves the same cart is accepted with byte-identical money columns and snapshot, unset vs `"false"`, and that with the switch on a cart on real frames is byte-identical too.

**What the buyer sees.** The checkout route's existing opaque refusal: HTTP 422 `{"error":{"code":"unprocessable","message":"Request could not be processed"}}` (`src/app.ts` `unprocessableResponse`), the same answer as a deleted mapping or an unpriced SKU. Nothing is written. The storefront maps 422 to `unpurchasable` (`src/storefront/adapters/checkout.js`) and shows "Något i varukorgen är inte längre tillgängligt. Gå tillbaka till varukorgen, uppdatera sidan och försök igen." with the toast "Kunde inte initiera betalning" (`src/components/shop/StripePaymentForm.jsx`). Retrying cannot help.

**What the seller can learn.** Nothing from the refusal: no order, no row, no log line, and the answer is opaque by design (it must not be an oracle for a shop's printer set-up). The seller's printer read (`GET /v1/admin/pod/printers`, `src/pod/printers.ts` `tenantPrinterView`) already says which models are stand-ins (`provisional: true`, `provisionalAreas`), but nothing tells them that such a product cannot be bought while the canvas is on. See "Part 1: other callers" for the proposal.

### Part 2: A7, the printer's "out of stock" after it accepted the job

**What exists.** A printer job is one order line. The printer accepts it (`dispatch_state = 'accepted'`), SnapWear's auto-pay charges at acceptance, the production withholding stays with the platform from that moment (`withholding-release.ts` `releasableSql`: an accepted line is never releasable), and PS1's intake moves `production_state` forward (`in_production → produced → shipped`). Nothing can record that the printer later says it cannot make it.

#### State model (per printer line)

Two new nullable columns on `order_items` (migration `0054_printer_exception.sql`):

| Column | Values | Meaning |
|---|---|---|
| `printer_exception` | NULL, `'out_of_stock'` | What the printer reported after accepting the job. A fact: written once, never cleared, never changed. |
| `printer_exception_resolved_at` | NULL, ISO-8601 ms | A platform operator closed the exception WITHOUT the printer sending the line (it will not be made; the shop and the buyer have been settled with by hand). Written once, never cleared. |

The derived states of a line with an exception:

| State | Columns | Holds the order back? | Seller's word |
|---|---|---|---|
| open | exception set, not resolved, not shipped | yes | `failed` |
| sent after all (restocked) | exception set, `production_state = 'shipped'` | no (it is sent) | `sent` |
| resolved | exception set, resolved, not shipped | no | `failed` |

#### Transitions, all through `POST /v1/platform/print-jobs/:jobId/status`

The route keeps its gate (platform principal only, same-origin, opaque 404 otherwise) and its form: one function decides from what is recorded, one batch writes the audit row and the line update under a guard that the line is still as decided (two tries), and a repeat is a 200 no-op answered from what is recorded. Two new bodies, each exactly one key:

1. **`{ "exception": "out_of_stock" }`: record it.**
   - Allowed: the line is a printer line, its dispatch is `accepted`, its production state is NULL or `in_production`, the order is open and the line not cancelled.
   - Refused (409 `print_job_status_not_allowed`, nothing written): `not_accepted`; `cancelled`; `refunded`; `produced` (the line is already `produced` or `shipped`: the blank was in stock).
   - Repeat: 200 `changed: false`.
   - One batch: audit `print_job.exception` (ids and states only), the line, and the alert (below), the alert conditioned on this batch's audit row.
2. **States after the exception.**
   - `shipped` is allowed while the exception is open (the printer restocked and sent it; the printer's mail may only ever say "shipped"). Every PS1 rule applies: tracking once, and the auto-ship of an all-printer parcel order with its one mail.
   - `in_production` and `produced` are refused with reason `out_of_stock`. They would tell nobody anything: the line holds the order either way until it is shipped or resolved.
   - Any state after a resolution is refused with reason `exception_resolved`.
3. **`{ "exception": "resolved" }`: close it without the printer sending the line.**
   - Allowed: the line has an open exception (set, not resolved, not shipped). Allowed even when the order is closed (cancelled or refunded): it is bookkeeping for the human who settled it, and it changes nothing for a closed order.
   - Refused: `no_exception` (none was recorded); `produced` (the line was shipped after all).
   - Repeat: 200 `changed: false`.
   - One batch: audit `print_job.exception_resolved`, the line, and PS1's `printerShippedOrderStatements` guarded on this batch's audit row. So when the order now qualifies for the automatic `shipped` (parcel, all lines printer lines, at least one shipped, none unsent, open, unfulfilled or processing), it is recorded with its one mail, exactly as if the last line had shipped.

The migration's triggers make a wrong writer abort: no line is inserted with either column set; the exception is set only on a printer line whose dispatch is `accepted` and which is not produced or shipped, and is never changed or cleared; the resolution is set only on a line with the exception that is not shipped, and is never changed or cleared; a line with an exception may move its production state only to `shipped`, and a resolved one not at all.

#### What each party sees

- **Buyer.** Nothing when the exception is recorded: no mail. If the printer restocks and ships, the usual flow applies. If a human refunds the line, the refund route's own mail (`refund_notice`). When the resolution completes an all-printer parcel order, the one "Skickad" mail goes out for what was sent. Otherwise the seller's own fulfilment mail.
- **Seller.** The line reads `podState: "failed"` ("the printer refused it, or cannot make it; the platform is on it"), the existing word. It becomes `sent` if the printer ships it after all. There is no new state, no reason, no cost, no printer, no job reference and no tracking. Fulfilment: an open exception is an unsent printer line, so `shipped` and `ready_for_pickup` are refused with the existing `printer_ships`. A resolved one no longer holds the order back.
- **Platform.** `GET /v1/platform/print-jobs` rows carry `exception` and `exceptionResolvedAt`, with a new filter `exception=out_of_stock|none`. The status route's `job` carries the same two fields. Alert kind `print_job_out_of_stock`, severity critical, raised ONCE per line forever (deterministic id `print-job-out-of-stock:{jobId}`, `ON CONFLICT DO NOTHING`, conditioned on the batch that recorded it), mailed by the existing digest. Ids and codes only.

#### The order's fulfilment (`fulfilment.ts`)

The two candidates in the brief:

- **(A) It stops counting as unsent at once.** In an all-printer parcel order, when the other line ships, PS1's auto-ship sees no unsent line and records the whole order `shipped`, sending the buyer "Skickad" for an order whose out-of-stock item will not arrive unless a human acts. Refused.
- **(B) It keeps blocking until a human resolves it.** Taken. With no other change it is never automatic: `unsentPodLinesSql` already counts the line (it is neither `shipped` nor `cancelled`), so the seller gets `printer_ships` and the auto-ship cannot fire.

But (B) alone is stuck for ever in one case the code shows: an order where one line is out of stock and another POD line was produced or shipped. The cancel route then refuses the whole order (`return_case`), a partial refund leaves it open, and nothing can ever move its fulfilment. Only a full refund would close it, which refunds the goods that did ship. Hence the **resolution** (transition 3): the human's act that says "this line will not come". `unsentPodLinesSql` gains one clause, `AND u.printer_exception_resolved_at IS NULL`, so a resolved line counts like a line whose dispatch was cancelled. This one predicate is shared by the seller's change, its batch guard and the auto-ship, so the three cannot disagree.

So a buyer can be told "shipped" for an order with an out-of-stock line only after a human acted: a platform operator who resolved it, or a printer that really shipped it. The order is never stuck: every case ends in shipped (restock), resolved, a cancellation or a full refund.

#### Money does not move

No amount, fee, withholding or payout computation changes. Nothing reads the new columns for money. The withholding of an accepted line stays with the platform exactly as today. `releasableSql` is untouched and still refuses any order with an accepted line, a printer reference or a `dispatched_at`.

**What a human must do today**, with the existing routes:

1. The alert `print_job_out_of_stock` names the job. The operator asks the printer: restock (and when), or cancel the job, which on SnapWear means a refund of its auto-pay charge to the platform.
2. **Restocked.** When the printer sends it, record `{ "state": "shipped", … }`. Nothing else: the line is a normal sent line, and the money was always due.
3. **Not restocked.**
   1. The printer cancels the job and refunds the platform (outside this system).
   2. The buyer's money: the seller, or the platform acting as the shop (acting-as grant), refunds that line's share through `POST /v1/admin/orders/:orderId/refunds` `{ amountMinor, reason }` (partial; D9 `reverse_transfer`, so the shop funds it). If nothing else in the order stands, a full refund, or the cancel route followed by the refund, closes the whole order. Either way the refund-dispatch stop or the cancellation queues a `printer_cancellation`, whose `printer_cancellation_needed` alert is redundant here: the operator resolves it with a note.
   3. The shop's money: the production withholding of that line stays with the platform (D36 releases only whole orders whose production never happened). To make the shop whole, the platform refunds that amount of the order's application fee by hand in Stripe. The webhook then raises `withholding_release_unmatched` (warning: "refunded outside the withholding release; the payout facts do not include it"), and the shop's payout view does not show it. This is known and is the reason for the follow-up below.
   4. Resolve the exception: `{ "exception": "resolved" }`. The order can now go on: the seller ships or hands over the rest, or the auto-ship records it if everything else was sent by the printer.
   5. Resolve the alert with a note of what was decided (`POST /v1/platform/alerts/:alertId/resolve`).

**What a per-line release would need (not built):**
- A release row keyed by (order, line): `withholding_releases` is UNIQUE per order (0028).
- An amount rule: the line's frozen `withholdMinor` is informational, and the order's total is rounded once over the sum plus the printer's shipping. Whether shipping is released when the last line goes is a decision.
- An eligibility fact that the printer refunded THIS job, which nothing records today. The resolution is not that fact: it says only that the line will not come.
- `orders.withholding_released_minor` would become a sum, through `netFeeMinor` and the payout. That is CP2-D2's money path, so it needs Mikael's decision first.

#### Decisions taken on my own conservative defaults (for Mikael to confirm or veto)

| # | Decision taken | Alternative |
|---|---|---|
| D1 | The exception is a fact: written once, never cleared or changed. | Clear it on a restock. Not needed: the restock is recorded as `shipped`. |
| D2 | Recorded only while the line is not `produced` (the brief said "has not shipped"). `produced` means it was printed on the blank, so out of stock is impossible, and such a line already makes a cancellation a return case. | Also allow it on `produced`. |
| D3 | After the exception, only `shipped` (restock); `in_production`/`produced` are refused; nothing after a resolution. | Let every forward state follow. The seller would then still read `failed` for a line in production. |
| D4 | Fulfilment: an open exception blocks the seller and the auto-ship; a platform resolution releases it. | (A) stop counting at once (automatic mail risk); (B) block until full refund or cancel only (stuck); (C) let the seller pass it but not the auto-ship. (C) is smaller, but the seller sees only `failed` and could mail "shipped" while the platform is still arranging a restock. |
| D5 | Resolution is allowed on a closed (cancelled or refunded) order, as bookkeeping. | Refuse it like the production states. |
| D6 | The resolution batch runs PS1's auto-ship, so an all-printer parcel order whose other lines were sent is recorded shipped with its one mail. | Leave it to the seller, which makes the outcome depend on whether the other lines shipped before or after the resolution. |
| D7 | The alert is critical, once per line, and not resolved automatically by the resolution: the operator closes it with a note. | Resolve it in the resolution's batch. |
| D8 | The seller reads `failed` for both an open and a resolved exception. | `cancelled` after the resolution. Its documented meaning is "before it reached the printer", which would be untrue. |
| D9 | No buyer mail when the exception is recorded. | An "item delayed" mail (a new mail kind and copy). |
| D10 | No money moves; the per-line release is manual (above). | Build the per-line release (needs a money decision). |
| D11 | Recording is refused on a cancelled or refunded order (consistent with the production states: the job is being cancelled anyway). | Record it anyway, as a fact. |

## Build log

1. **Part 1, the checkout gate.**
   - `src/pod/pod-mappings.ts`: `decideProductionLine` takes `refuseStandInFrames` and returns null for a stand-in model when it is true. `resolveProductionLines` threads it. `resolveProductionLine` passes `false`.
   - `src/commerce/checkout.ts`: `CheckoutOptions.refuseStandInFrames?`, threaded through `freezeProductionSnapshot`.
   - `src/app.ts`: `handleCheckoutRoute` passes `printCanvasEnabled(env)`.
   - New `test/checkout-stand-in-frames.test.ts` (5 tests).
   - Gates: `tsc` clean; the new file 5/5; `pod-publish`, `print-canvas-snapshot`, `checkout`, `print-canvas`: 4 files / 268 tests passed.
2. **Part 2, the source.**
   - New `migrations/0054_printer_exception.sql`: 2 columns, 4 triggers.
   - `src/app.ts` `REQUIRED_MIGRATION` → 0054; pins in `test/health.test.ts`, `test/public-catalog.test.ts`.
   - `src/dispatch/production-status.ts`: the two exception bodies, their decision, `changeOf`, the guard over the exception facts, the alert, and the resolution's auto-ship.
   - `src/routes/print-jobs-platform.ts`: docs only.
   - `src/dispatch/print-job-list.ts`: the two row fields and the `exception` filter.
   - `src/commerce/fulfilment.ts`: `unsentPodLinesSql` gains the resolved clause.
   - `src/commerce/admin-orders.ts`: `POD_STATE_SQL` maps an exception to `failed`.
   - `src/dispatch/cancellation.ts`: comment only.
   - Existing tests changed for the new shapes: `test/print-job-status.test.ts` (the `job` view's two keys; the facts literal) and `test/platform-print-jobs-list.test.ts` (`ROW_KEYS`, the row, the query base).
   - Gates: `tsc` clean. `print-job-status`, `platform-print-jobs-list`, `admin-order-fulfilment`, `refunds`, `health`, `public-catalog`, `money-codex-fixes`, `money-followups`, `print-canvas`, `checkout-stand-in-frames`: 10 files / 254 tests passed.
3. **Part 2, the tests.** New `test/printer-exception.test.ts` (20 tests).
   - The first run found a real mismatch: the resolution's batch guard asked for `dispatch_state = 'accepted'`, which its decision does not ask. On a line whose dispatch had become `cancelled`, the decision said "move" and the guard said no, twice, which answers 409 `conflict` for ever. The resolution's guard now asks only what its decision asks (the exception still open). The test now uses a real fake-printer acceptance before the seller cancels.
   - Gates: `tsc` clean; `printer-exception` + `print-job-status`: 2 files / 41 tests passed.
4. **Gates on the whole tree, then mutations.**
   - Gates: `tsc` ×3 clean; full `vitest run` 118 files / 4645 tests; `types:check` up to date; guard PASS; migrate tools 554/554.
   - My new files and every added line grepped for the guard's word families: no match.
   - 33 mutations, run by a scratch script (copy aside, one exact replacement asserted to match once, the named test files, restore with `cp`, prove with `cmp`). All 33 were caught, and every file was restored `cmp`-identical. Table below.
5. **Review pass and final gates.** `changeOf` now picks the line's view field by field instead of spreading the facts object (no behaviour change). Every gate ran again after this, the last code edit: the same results (below).

---

## What was built

### Part 1: checkout refuses a stand-in frame while the canvas is on

As designed (above). The rule is one line in `decideProductionLine`. The boolean comes from `printCanvasEnabled(env)` at the route edge and nowhere else. With the switch off or unset, checkout takes exactly today's path (proven byte-identical). Dispatch is untouched: `canvasFrame` still fails closed for a line paid before the switch, or for a checkout created while it was off and paid after (within `CHECKOUT_TTL_MS`, 24 h).

**What the buyer sees.** HTTP 422 `{"error":{"code":"unprocessable","message":"Request could not be processed"}}`, with nothing written: no checkout, no items, no audit row (tested). The storefront shows "Något i varukorgen är inte längre tillgängligt. Gå tillbaka till varukorgen, uppdatera sidan och försök igen." and the toast "Kunde inte initiera betalning". Retrying never helps while the switch stays on.

**What the seller learns.** Nothing. No order exists, nothing is logged, and the refusal is opaque by design. The seller's printer read does mark the model as a stand-in (`provisional`, `provisionalAreas`), but nothing ties that to "cannot be sold now".

### Part 1: other callers (follow-up, not built)

| Caller | Agrees with the new rule? | Why not built |
|---|---|---|
| Public "can this product be bought" predicate (`src/catalog/eligibility.ts` `PUBLIC_ELIGIBILITY_PREDICATE`) | No. A published product on a stand-in model stays on the storefront while the switch is on, and every checkout of it answers 422. | It is one SQL constant, shared by checkout's line resolution, the public catalogue (list, detail, previews), the sitemap (×3), SEO, the preview, screening's D8 count and the platform tenant directory. None of them has the switch. To agree, every caller needs the switch, plus a `json_extract` over the printer's `capabilities_json` per mapping (`$.skus."<sku>".model`, then `$.models."<model>".provisional`). Not a same-shaped small change. |
| The seller's publish gate (`evaluatePodGate`), mapping write (`createMapping`), quotes (`quoteForProduct`, `designQuote`) | No. A seller can still map and publish onto a stand-in model. | None of them takes the env. Their callers are in `src/catalog/admin-catalog.ts`, `src/catalog/product-variants.ts` and `src/routes/pod-admin.ts`, and the change needs seller-facing copy (`podRefusalMessage`). |

**Proposed, as ONE follow-up unit:** the smallest way to tell the seller, and to stop the storefront offering what checkout refuses. Both parts read the switch at the route edge, as checkout now does.
- `evaluatePodGate` takes the same boolean and refuses a set routed to a stand-in model with a new code, e.g. `pod_frame_unconfirmed`. Its `podRefusalMessage` sentence would say the printer has not confirmed this garment's print area yet, so it cannot be sold now (Swedish copy for Mikael). The seller then learns it at publish and at every mapping write, through the refusal channel `test/printers-platform.test.ts` already walks for leaks.
- The public predicate gains the same clause, so an already-published product leaves the storefront instead of failing at checkout.

Optionally, the tenant printer view could carry one more boolean so the studio marks those articles. That is a frontend change.

### Part 2: A7

As designed (above), with the one correction found by the tests (build log step 3).

| Body (`POST /v1/platform/print-jobs/:jobId/status`) | 200 | 409 `reason` |
|---|---|---|
| `{ "exception": "out_of_stock" }` | changed (audit `print_job.exception`, alert once), or `changed: false` on a repeat | `not_accepted`, `cancelled`, `refunded`, `produced` |
| `{ "exception": "resolved" }` | changed (audit `print_job.exception_resolved`; `orderShipped: true` when it completes an all-printer parcel order, mail nudged), or `changed: false` | `no_exception`, `produced` (it was shipped after all) |
| `{ "state": … }` on a line with an open exception | only `shipped` (restock) | `out_of_stock` for `in_production` / `produced` |
| `{ "state": … }` on a resolved line | never | `exception_resolved` |

- **Platform.** `job` and every `GET /v1/platform/print-jobs` row carry `exception` (`"out_of_stock"` or null) and `exceptionResolvedAt` (ISO or null). New filter `exception=out_of_stock|none` (one value; anything else is a 400). The alert is `print_job_out_of_stock`, critical, with id `print-job-out-of-stock:{jobId}`, resource `print_job`/`{jobId}`. It is in the same batch as the exception, conditioned on that batch's audit row, so it is raised once.
- **Seller.** The line reads `failed` while the exception is open and after it is resolved, and `sent` if the printer ships it after all. No new state, key or text. The test walks the seller's order detail and the order list with the one-number denylist, `expectNoCostKeys` and a text search (no `out_of_stock`, `exception`, `resolved`, the alert id, the job reference, the printer's tracking or carrier, or the printer id).
- **Fulfilment.** An open exception holds the order: the seller gets `printer_ships`, and the auto-ship cannot fire. A resolved one does not hold it (`unsentPodLinesSql`).
- **Money.** Nothing reads the new columns for money. Proven on a webhook-paid Connect order:
  - recording and resolving leave the order row and the line's money byte-identical;
  - reconciliation discovers no withholding release;
  - a full refund through the seller's route settles (201) and queues one `printer_cancellation`;
  - still no release, and `withheld_minor` unchanged.

### Migration 0054 (`cloudflare/migrations/0054_printer_exception.sql`)

Additive: two nullable `ADD COLUMN`s and four triggers. No existing column, row or trigger is touched.

| Trigger | Aborts when |
|---|---|
| `order_items_printer_exception_not_at_insert` | a line is inserted with either column set |
| `order_items_printer_exception_once` | the exception is changed or cleared, or set on a line that is not a printer line, not `accepted`, or `produced`/`shipped` |
| `order_items_printer_exception_resolved_once` | the resolution is changed or cleared, or set without the exception or on a `shipped` line |
| `order_items_printer_exception_production` | a line with the exception moves its production state to anything but `shipped`, or a resolved one moves at all |

CHECKs: the exception is `'out_of_stock'` only; the resolution is ISO-8601 with milliseconds (`strftime('%Y-%m-%dT%H:%M:%fZ')`).

**Config: none changed.** The migration bump needed only `src/app.ts` `REQUIRED_MIGRATION` and its two test pins (`test/health.test.ts`, `test/public-catalog.test.ts`). The migrate tools' text scan derives its columns from the migrations, and 554/554 still pass.

## Files

| File | |
|---|---|
| `cloudflare/migrations/0054_printer_exception.sql` | new |
| `cloudflare/src/pod/pod-mappings.ts` | Part 1: the gate in `decideProductionLine`; the boolean through `resolveProductionLines`; `resolveProductionLine` passes `false` |
| `cloudflare/src/commerce/checkout.ts` | Part 1: `CheckoutOptions.refuseStandInFrames?`, threaded; header |
| `cloudflare/src/app.ts` | Part 1: the route passes `printCanvasEnabled(env)`; `REQUIRED_MIGRATION` → 0054 |
| `cloudflare/src/dispatch/production-status.ts` | Part 2: the exception bodies, decision, change, guard, alert and the resolution's auto-ship; header |
| `cloudflare/src/dispatch/print-job-list.ts` | Part 2: two row fields, the `exception` filter; header |
| `cloudflare/src/routes/print-jobs-platform.ts` | Part 2: docs only |
| `cloudflare/src/commerce/fulfilment.ts` | Part 2: one clause in `unsentPodLinesSql`; header comments |
| `cloudflare/src/commerce/admin-orders.ts` | Part 2: one `WHEN` in `POD_STATE_SQL`; the word's doc |
| `cloudflare/src/dispatch/cancellation.ts` | comment only (its guard-agreement note now names the resolved exception) |
| `cloudflare/test/checkout-stand-in-frames.test.ts` | new, 5 tests |
| `cloudflare/test/printer-exception.test.ts` | new, 20 tests |
| `cloudflare/test/print-job-status.test.ts` | edited (below) |
| `cloudflare/test/platform-print-jobs-list.test.ts` | edited (below) |
| `cloudflare/test/health.test.ts`, `cloudflare/test/public-catalog.test.ts` | the migration pin, 0053 → 0054 |
| `docs/cf-port/CP6_PS3_REPORT.md` | this report |

### Existing tests changed (the only ones)

- `test/print-job-status.test.ts`:
  - the `StatusBody` type and the one `toStrictEqual` of the `job` view gain `exception: null, exceptionResolvedAt: null`;
  - the pure `decideProductionStatus` facts literal gains the same two fields.
  - No assertion of behaviour changed.
- `test/platform-print-jobs-list.test.ts`:
  - `ROW_KEYS`, the `JobRow` type and the one `toStrictEqual` row gain the two fields;
  - the query-plan suite's `base` query gains `exception: null`.
  - Every plan pin is unchanged and passes.
- `test/health.test.ts:36`, `test/public-catalog.test.ts:572`: the pin.
- Not changed: every checkout, webhook, money, refund, fulfilment and denylist suite passes as it was.

## Tests

- `test/checkout-stand-in-frames.test.ts` (5):
  - off/unset byte-identical (money columns and snapshot, with the hand-computed 36 000 / 45 000 / 40 900 / 51 125 öre);
  - on: refused, nothing written, a plain line alone still sold;
  - on with real frames: byte-identical to off;
  - the route reads the switch exactly (`"true"` only; unset, `"false"`, `"TRUE"`, `" true"` and `"1"` all 201);
  - the one-line reader unchanged.
- `test/printer-exception.test.ts` (20):
  - recording: audit, alert, view; a repeat; two at once; a concurrent record; every refusal; the body and the gate;
  - after the exception: only `shipped`; the open exception holds the seller and the auto-ship; a restock ships the order with one mail;
  - resolving: the line no longer holds the order; the auto-ship with one mail, and none when nothing was sent; repeat, refusals, a closed order, nothing after; a state racing a new exception;
  - money (above);
  - the seller's read and the platform's list;
  - each 0054 backstop.

## Mutations

The test files run per row: Part 1 `checkout-stand-in-frames` (P2 also `print-canvas-snapshot`); Part 2 `printer-exception` + `print-job-status` (L1/L2 also `platform-print-jobs-list`). Every file was restored and proven `cmp`-identical; `git status` afterwards showed only this unit's files.

| # | Mutation | Result |
|---|---|---|
| P1 | checkout gate removed | 2 failed |
| P2 | gate ignores the switch (refuses every stand-in) | 4 failed |
| P3 | checkout treats an absent option as on | 1 failed |
| P4 | the route never passes the switch | 1 failed |
| P5 | the route passes the switch for any value | 1 failed |
| P6 | the one-line reader refuses stand-ins | 1 failed |
| X1 | exception allowed on a produced/shipped line | 1 failed |
| X2 | exception without the accepted check | 1 failed |
| X3 | exception without the cancelled/refunded checks | 1 failed |
| X4 | an exception repeat is a move | 4 failed |
| X5 | no alert | 3 failed |
| X6 | alert not conditioned on this batch | 1 failed (the concurrent-record test) |
| X7 | alert id random | 1 failed. Only the test that pins the id fails: "once" itself is held first by the batch guard (a repeat or a lost race writes nothing), so the id dedupe is defence in depth, as PS1's P1b. |
| X8 | an open exception lets every state through | 2 failed |
| X9 | a resolved exception lets states through | 1 failed |
| X10 | the batch guard without the exception facts (the race) | 3 failed |
| X11 | resolution without the `no_exception` check | 1 failed |
| X12 | resolution of a shipped line allowed | 1 failed |
| X13 | resolution requires an open order | 1 failed |
| X14 | resolution never auto-ships | 1 failed |
| X15 | the parser takes extra keys | 1 failed |
| F1 | a resolved line still counts as unsent (stuck orders) | 2 failed |
| F2 | candidate (A): every exception line stops counting | 4 failed |
| S1 | the seller's word ignores the exception | 3 failed |
| S2 | the seller's word: exception before shipped | 2 failed |
| L1 | the list's exception filter ignored | 1 failed |
| L2 | the list's row drops the exception | 1 failed |
| M1 | 0054 insert trigger a no-op | 1 failed |
| M2 | 0054 `exception_once` a no-op | 1 failed |
| M3 | 0054 `resolved_once` a no-op | 1 failed |
| M4 | 0054 production trigger a no-op | 1 failed |
| M5 | 0054 CHECK on the exception's value removed | 1 failed |
| M6 | 0054 CHECK on the resolution's format removed | 1 failed |

## Deviations from the brief

1. **A second column and a "resolve" body** (`printer_exception_resolved_at`, `{ "exception": "resolved" }`). The brief's frame had one column. The code shows that candidate (B) alone leaves one kind of order stuck for ever: an out-of-stock line plus another POD line that was produced or shipped. The cancel route refuses it as a return case, a partial refund leaves it open, and only a full refund would close it. See "The order's fulfilment".
2. **The exception is refused on `produced`**, not only on `shipped` (D2).
3. **After the exception only `shipped` follows, and four new 409 reasons** (`out_of_stock`, `exception_resolved`, `no_exception`, `produced`) (D3).
4. **The resolution runs PS1's auto-ship** (D6).
5. **The resolution's batch guard asks neither for an accepted dispatch nor for an open order**, matching its decision (build log step 3; D5).
6. **The seller-projection coverage of the new column is in the new test file** (the same denylist plus `expectNoCostKeys` and a text search), not added to the existing denylist suites. Those pass unchanged.
7. **The status route's audit `action` is now a bound parameter** (`print_job.status` as before; the two new actions beside it).
8. **`src/dispatch/cancellation.ts`: a comment edit.** Its note that the three guards agree is no longer exactly true for a resolved exception (see "Seen, outside scope" 3).

## Gates (final, on the tree as delivered)

- `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`: clean (exit 0).
- `cd cloudflare && npx vitest run`: **Test Files 118 passed (118), Tests 4645 passed (4645)**. Baseline 116 / 4620: +2 files, +25 tests, 0 changed outcomes. The two known `Network connection lost` uncaught-exception lines print, as at HEAD.
- `cd cloudflare && npm run types:check`: "Types at worker-configuration.d.ts are up to date."
- `node guard/guards.test.mjs`: **guard: PASS** (allowlist 294 = baseline). It scans tracked files only. My four new files are untracked, so I grepped them and every added line for the three families: no match.
- `node --test "scripts/cf-port/migrate/test/*.test.mjs"`: **tests 554, pass 554, fail 0**.

## Reviewer wiring

- **Migration 0054 must be applied before the Worker that needs it.** `/health` readiness requires `0054_printer_exception.sql`. The intake and the list select the new columns, so a Worker deployed on an unmigrated D1 answers 500 on those routes. The migration is additive; nothing reads the columns for money.
- **Staging changes behaviour.** Staging has `PRINT_CANVAS_ENABLED = "true"`, so checkout there now refuses (422) any product whose printer model is a stand-in. If the staging fake printer carries SnapWear's five stand-in models, those products can no longer be bought on staging. That is the point, and any staging smoke on those models will refuse. Production: nothing changes until the switch is set.
- **No config, `wrangler.jsonc`, `pinned.*.json`, `scripts/`, `guard/` or `render/` change.**
- **The next free migration number is 0055.**
- **Smoke on staging** (after 0054 and the deploy):
  1. On a product whose model is a stand-in (if any), the checkout answers 422; one on real frames answers 201.
  2. For an accepted job, in the platform console as the platform user:
     ```js
     await (await fetch('/_api/v1/platform/print-jobs/<orderId>-1/status', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exception: 'out_of_stock' }) })).json()
     ```
     Expect `changed: true` and `job.exception: "out_of_stock"`. Then:
     - one open alert `print_job_out_of_stock` in `GET /_api/v1/platform/alerts?state=open`;
     - the seller's order reads `podState: "failed"`;
     - the seller's "skickad" is refused `printer_ships`.
  3. Then `{ exception: 'resolved' }`. Expect `exceptionResolvedAt` set and the seller able to ship. For an all-printer parcel order whose other lines were shipped: `orderShipped: true` and one `email.order_status` row.

## Seen, outside scope (not fixed)

1. **A dispatch-`failed` line has the same stuck order** (pre-existing). A line the printer refused is acknowledged through `/v1/platform/dispatch/:id/resolve` as `failed` and keeps `dispatch_state = 'failed'` (`src/dispatch/resolution.ts`: `cancelled` only when `cancel_requested`). So it still counts as unsent. If another POD line of the order was produced or shipped, the seller can never ship the order, the cancel route refuses it as a return case, and only a full refund closes it. The same "resolved does not count" idea would apply there.
2. **The manual return of a line's withholding raises a warning** (pre-existing). Done in the Stripe dashboard, it raises `withholding_release_unmatched` ("refunded outside the withholding release; the payout facts do not include it"), and the shop's payout view never shows it. This is the gap a per-line release would close (Design, "Money does not move").
3. **A redundant printer cancellation for a resolved line.** A full refund of an order that has a resolved exception line and no produced line queues a `printer_cancellation` for that line's accepted job (`refund-dispatch-stop.ts` reads `orders.status` only), even when the seller already marked the order shipped. The cancel route refuses the same order (it reads `fulfilment_status`). The only effect is a redundant human-action alert; no money moves. Documented in `cancellation.ts`.
4. **The console does not know the exception yet** (`src/admin-app/adapters/printJobs.js`, the frontend's file). It ignores the new row keys and shows its generic sentence ("Tryckjobbet kan inte få den statusen.") for the four new refusal reasons. It needs buttons for the two bodies, the column, the filter and four reason sentences: a frontend follow-up.
5. **Docs that now drift:**
   - `docs/SnapWearDocs/LAUNCH_TODO.md` A7 still reads ☐ (the orchestrator's document; not edited).
   - The CP6-PS2 report's open question 2 and "Not done" (the checkout gate) are now answered by Part 1.
   - HANDOVER says the next migration is 0054; it is now 0055.

## Unfinished

Nothing in the brief is left unbuilt, but three things are follow-ups: the storefront predicate and publish gate agreeing with Part 1 (proposed above), the console UI for the exception (4 above), and a per-line withholding release (needs Mikael's money decision). Every owner decision is listed under "Decisions taken on my own conservative defaults" (D1–D11). Part 1 adds two more: the opaque 422 (no new code) is the buyer's answer, and the storefront and publish agreement is deferred.
