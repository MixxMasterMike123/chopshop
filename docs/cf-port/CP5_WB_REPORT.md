Model: claude-opus-5-5 (Opus 5.5)

# CP5-WB — the seller's orders (Worker)

Brief: `CP5_BRIEFS.md` §WB. Built in the working tree only: no git write, no network, no wrangler, no deploy.

## Files

| File | |
|---|---|
| `cloudflare/migrations/0046_order_fulfilment.sql` | new |
| `cloudflare/src/commerce/fulfilment.ts` | new: transition table, decision, the one-batch change, the read of shipments + history |
| `cloudflare/src/commerce/admin-order-list.ts` | new: the list's query parser and read |
| `cloudflare/src/routes/admin-orders.ts` | new: the two route handlers |
| `cloudflare/src/commerce/admin-orders.ts` | edited: the detail's projection gains the new fields |
| `cloudflare/src/routes/money-orders.ts` | edited: the detail's assembly adds `shipments`, `statusHistory` (and a header line) |
| `cloudflare/src/dispatch/cancellation.ts` | edited: the return case reads `fulfilment_status` too (the one money-adjacent change the brief names) |
| `cloudflare/src/app.ts` | edited inside `CP5-IMPORTS-B` and `CP5-ROUTES-B` only |
| `cloudflare/test/admin-order-list.test.ts` | new (9 tests) |
| `cloudflare/test/admin-order-fulfilment.test.ts` | new (25 tests) |
| `cloudflare/test/refunds.test.ts` | edited, NOT on my list (see Deviations 8): the detail's exact-shape test, and the denylist test extended to the new fields and the list |
| `cloudflare/test/slice/vertical-slice.test.ts` | edited, NOT on my list (see Deviations 8): its key denylist named `sku` |

## Routes

Both are tenant-admin routes: `X-Shop-Id` + live membership, or an acting-as grant (admitted for the reads and the change; the audit row then carries `actingAsGrantId`). Everything else is the one opaque 404.

### `GET /v1/admin/orders?status=&fulfilment=&since=&until=&q=&cursor=&limit=`

No same-origin needed (a read). Every parameter optional, each at most once; any other parameter → `400 invalid_request`.

- `status`: a value of `orders.status`, or `cancelled` (= `cancelled_at` set, or the status value).
- `fulfilment`: `unfulfilled | processing | shipped | ready_for_pickup | delivered | completed`.
- `since` (inclusive) / `until` (exclusive): ISO-8601 UTC, on the order's creation.
- `q`: with `@` → the customer's e-mail address, exact, lower-cased (checkout stores it lower-cased); else an order number prefix (`[0-9A-Za-z-]{1,40}`, upper-cased, `GLOB 'X*'`).
- `cursor`: the previous `nextCursor` (`<created_at ms>~<order uuid>`); `limit` 1..100, default 50.

Paging is `(created_at, order_id)` descending on `orders_tenant_created_idx`.

```json
200 {
  "orders": [ {
    "orderId": "…", "orderNumber": "20261003-…", "createdAt": "ISO", "paidAt": "ISO",
    "status": "paid", "fulfilment": "unfulfilled", "cancelledAt": null,
    "deliveryMethod": "pickup", "totalMinor": 29900, "currency": "SEK",
    "customerEmail": "…", "recipientName": "…" | null, "pickupPlace": "…" | null,
    "itemCount": 1, "refundedMinor": 0 } ],
  "nextCursor": "…" | null,
  "count": 3,
  "totalMinor": 154400
}
```

`itemCount` = Σ quantity of the lines. `refundedMinor` = `refund_succeeded_minor`. `recipientName` / `pickupPlace` come from `order_recipients` (D98; null for an order made before 0045; `pickupPlace` = the frozen pickup place name, null for a parcel). `count` / `totalMinor` cover the whole filter window (the cursor is ignored), as one SQL aggregate (`COUNT(*)`, `SUM(total_minor)`) in the same `batch()` as the page.

### `GET /v1/admin/orders/:orderId` (the detail, extended)

Same route and guard as before. `order` gains, all from named columns:

```json
"cancelledAt": null, "createdAt": "ISO", "customerEmail": "…",
"deliveryMethod": "shipping", "shippingCountry": "SE", "fulfilment": "shipped",
"items": [ { "lineNo": 1, "sku": "…", "name": "…", "variantLabel": "M" | null,
             "quantity": 2, "unitPriceMinor": 10000, "lineTotalMinor": 20000,
             "podState": "none" } ],
"shipments": [ { "trackingNumber": "RR…SE" | null, "carrier": "PostNord" | null, "createdAt": "ISO" } ],
"statusHistory": [ { "track": "payment" | "fulfilment", "from": "paid" | null, "to": "…",
                     "at": "ISO", "by": "system" | "admin" | "platform", "reason": "…" | null } ]
```

`podState` (one seller-safe word per line, derived in SQL from `production_json IS NULL`, `production_state`, `dispatch_state`; the snapshot itself is never selected):

| condition, first that holds | `podState` |
|---|---|
| no `production_json` (not a POD line) | `none` |
| `production_state = 'shipped'` | `sent` |
| `production_state IN ('in_production','produced')` | `in_production` |
| `dispatch_state = 'cancelled'` | `cancelled` |
| `dispatch_state = 'failed'` | `failed` |
| `dispatch_state = 'accepted'` | `in_production` |
| otherwise (NULL, pending, submitting, unknown) | `queued` |

`by` is derived: `actor_user_id IS NULL` → `system`; the actor's `identity_access.account_type = 'platform_admin'` → `platform`; else `admin`. No user id leaves the server. History is bounded at 200 rows, shipments at 50, lines at 200.

### `POST /v1/admin/orders/:orderId/fulfilment`

Same-origin required, `Idempotency-Key: <uuid>` required (as the refund route), both checked before the body is read (the key before the body, as the refund route does).

Request: exactly `{ "to": <target>, "trackingNumber"?: string 1..100, "carrier"?: string 1..60, "note"?: string 1..500 }` (trimmed, no control character). `to` ∈ `processing | shipped | ready_for_pickup | delivered | completed`. `trackingNumber`/`carrier` only with `to: "shipped"`.

| Answer | When |
|---|---|
| `200 { "fulfilment": { "orderId", "from", "to", "at": "ISO", "shipment": { "trackingNumber", "carrier", "createdAt" } \| null } }` | changed |
| same `200` + `Idempotent-Replayed: true` | the same key with the same order and body (compared by a sha256 of `[orderId, to, trackingNumber, carrier, note]`) |
| `409 { "error": { "code": "fulfilment_not_allowed", "reason", "message" } }` | refused; `reason` ∈ `order_closed`, `delivery_method`, `transition`, `tracking_required`, `printer_ships` |
| `409 { "error": { "code": "conflict" } }` | the key was used for another order or body |
| `400 invalid_request` / `400 idempotency_key_required` | body / header |
| `404` | no session, no or foreign `X-Shop-Id`, cross-site or missing `Origin`, malformed or foreign order id, any method but POST |

## The transition table

| from \ to | processing | shipped | ready_for_pickup | delivered | completed |
|---|---|---|---|---|---|
| unfulfilled | ✓ | ✓ parcel | ✓ pickup | — | — |
| processing | — | ✓ parcel | ✓ pickup | — | — |
| shipped | — | ✓ another parcel, tracking number required | — | ✓ | ✓ |
| ready_for_pickup | — | — | — | ✓ | ✓ |
| delivered | — | — | — | — | ✓ |
| completed | — | — | — | — | — |

Nothing goes back; `unfulfilled` is never a target. Refusals, in the order they are decided:

1. `order_closed`: `cancelled_at` set, or `status ∈ {refunded, cancelled}`, or `charged_minor > 0 AND refund_succeeded_minor >= charged_minor`. A partially refunded order stays open.
2. `delivery_method`: `shipped` of a pickup order, `ready_for_pickup` of a parcel.
3. `transition`: an edge the table does not have.
4. `tracking_required`: `shipped → shipped` without a tracking number.
5. `printer_ships`: `shipped` or `ready_for_pickup` while a POD line (`production_json` set) has `production_state` other than `shipped` and a dispatch that was not cancelled.

**Which party ships a POD line:** the printer, always. For a parcel the job carries the order's recipient (`readDispatchShipTo` → `shipping_address` in the SnapWear body), so the printer ships to the buyer. For a pickup order the job carries no address, so the printer ships to the shop. **What the seller may change for a POD line therefore:** nothing about the line itself. Its state is read-only and comes from the dispatch (`podState` above). At order level the seller may set `processing` at any time, but `shipped` / `ready_for_pickup` (and so `delivered` / `completed`) only once every POD line is `production_state = 'shipped'`. No code writes `production_state` today (see Open questions).

**One batch:** the history row (`track = 'fulfilment'`, the key, the hash), the shipment (on every `shipped`), the audit row (`order.fulfilment`, metadata `{from, to, historyId}` + `actingAsGrantId` under a grant), the outbox row (`event_type = 'email.order_status'`, `outbox_id = email-order-status:<historyId>`, `dedupe_key = email.order_status:<historyId>`, payload exactly `{historyId, orderId}`, status `pending`) and the `UPDATE orders SET fulfilment_status` come last. Every statement carries the same guard: the order is still in the decided state, still open, and has no unsent POD line for `shipped` / `ready_for_pickup`. `meta.changes === 0` on the update → the request is decided again from the new state (2 tries, the key is re-checked each time, so a concurrent request with the same key replays its winner). A concurrent request with the same key that collides on the unique index replays the winner. Nothing writes `orders.status`. No mail is sent.

## Schema (0046) and backfill

- `orders.fulfilment_status TEXT NOT NULL DEFAULT 'unfulfilled' CHECK (IN the six)`, index `orders_tenant_fulfilment_idx (tenant_id, fulfilment_status, created_at DESC)`. Trigger `orders_fulfilment_coherent`: refuses `shipped` on a non-parcel, `ready_for_pickup` on a non-pickup, and any return to `unfulfilled`.
- `order_status_history` + `track TEXT NOT NULL DEFAULT 'payment' CHECK (payment|fulfilment)`, `client_key` (uuid shape), `request_hash` (sha256 hex); unique partial index `(tenant_id, client_key) WHERE client_key IS NOT NULL`; trigger `order_status_history_track_shape` (a fulfilment row: fulfilment vocabulary, `from` not null, key and hash present; a payment row: no key, no hash). The webhook and the refunds name none of the new columns, so their rows are `payment` with NULLs, unchanged.
- `order_shipments (shipment_id PK, tenant_id, order_id, history_id UNIQUE → order_status_history, tracking_number, carrier, created_at ISO TEXT, created_by)`. Triggers: tenant, parcel and history row must match on insert; insert-once on `shipment_id` OR `history_id`, which aborts plain, `OR IGNORE` and `OR REPLACE` before conflict resolution (rule 5); no update; no delete. Index `(tenant_id, order_id, created_at)`.
- Time: the new column on `orders` is not a time; history keeps its integer ms; the new table's `created_at` is ISO text (rule 7).

**Backfill rule** (one `UPDATE … WHERE status IN (fulfilment values)`, run before the triggers exist): `processing`, `printed` → `processing`; `shipped` on a parcel → `shipped`; `ready_for_pickup` on a pickup → `ready_for_pickup`; `shipped` on a pickup or `ready_for_pickup` on a parcel → `processing`; `delivered` → `delivered`; `completed` → `completed`. Everything else (`paid`, `partially_refunded`, `refunded`, `cancelled`) keeps the default `unfulfilled`. `orders.status` is not rewritten. The test runs the migration's own `UPDATE` statement (taken from `env.TEST_MIGRATIONS`) over 12 seeded combinations.

**Staging after the migration.** On the CF side `orders.status` is written only by the webhook (`'paid'`) and by the refund settlement (`paid` / `partially_refunded` / `refunded`). No import tool inserts orders (grep of `scripts/`). So each of the 3–4 test orders is now `paid`, `partially_refunded` or `refunded`, and after 0046 every one reads `fulfilment_status = 'unfulfilled'` with its `status` unchanged. Their history rows become `track = 'payment'` with NULL key and hash. `order_shipments` is empty and no outbox row is added. Each order can then take a fulfilment change unless it is fully refunded or cancelled. This is a deduction; I did not read staging (no network). The reviewer can confirm before applying with `SELECT status, delivery_method, COUNT(*) FROM orders GROUP BY 1, 2`.

## Cancellation (the one money-adjacent change)

`cancellation.ts` `notProducedSql` now refuses when `status IN (RETURN_CASE_ORDER_STATUSES)` **or** `fulfilment_status IN ('shipped','ready_for_pickup','delivered','completed')`. It reads both columns because an order shipped before 0046 has the fact in `status`. `RETURN_CASE_ORDER_STATUSES` itself is unchanged. `refund-dispatch-stop.ts` and `withholding-release.ts` (which import that constant and read `status` only) are not touched. They agree with the cancellation wherever they act: both touch only orders with dispatch rows (POD lines), and such an order cannot reach a return-case fulfilment state until every POD line is `production_state = 'shipped'`, which all three guards already read. The CP2 parity suite (`money-codex-fixes`) and the dispatch suite pass unchanged.

## Tests and gate

- `cd cloudflare && npx tsc --noEmit` → clean (also `-p web`).
- `npx vitest run` → **`Test Files  97 passed (97)` / `Tests  4140 passed (4140)`**.
  - My files: `admin-order-list.test.ts` 9, `admin-order-fulfilment.test.ts` 25.
  - Baseline before my work: `Test Files 3 failed | 91 passed (94)`. The failures were in `invites.test.ts`, `origins.test.ts` (WA's work in progress) and `payment.test.ts` (rate-limit case). All three pass in the final run.
- `node guard/guards.test.mjs` → `guard: PASS`. My new files are untracked, so I checked them myself: no match for either forbidden family (the earlier brand, the resale feature), nor for `b2b`.

Covered: every refusal of both routes (session, shop, origin, method, malformed/foreign id, key, body, every bad query parameter); mount order (list, detail, refunds, cancel, fulfilment each reach their own handler; other methods and near paths 404); list fields exact, newest first, paging, window counters, each filter; the full transition matrix (pure, both delivery methods, against an independently written table) plus a parcel and a pickup walked over the route; `order_closed` (cancelled, refunded, refunded-to-charge) and partial refund open; `printer_ships` for parcel and pickup until `production_state='shipped'`; the batch's five writes exactly once, a refused change writes nothing; replay, key conflict (other body, other order), concurrent same key → one change, concurrent different keys → one 200 + one 409; full refund keeps `ready_for_pickup`, a change keeps `partially_refunded`, history interleaves both tracks; cancelled order refused; return case after shipped / delivered / completed / ready_for_pickup, not after processing; acting-as (audit grant id, history `platform`); detail fields, `podState` per dispatch state, job ref absent; denylist (keys and values) on the detail and the list; backfill; schema backstops (shipment update/delete/`INSERT OR REPLACE`, incoherent step, back to unfulfilled, malformed history row).

## Deviations from the brief

1. **The per-line field is `podState`, not `production`.** The one-number denylist (refunds suite, slice) refuses every key containing `production`. Renaming the field keeps that guard whole; exempting one key would weaken it.
2. **`statusHistory[]` entries carry `track`** (`payment` | `fulfilment`). The two tracks share some words (`shipped` was a `status` value), and a client must be able to tell them apart.
3. **Added fields:** `cancelledAt` on the list and the detail (cancellation never moved `status`, so without it a seller could not see a cancelled order), and `lineNo` per item.
4. **`order_shipments.history_id`** (a column the brief did not list): it links a shipment to its change, so unit WE can read the tracking number from the outbox's `historyId`. A shipment row is written on every `shipped` change; the tracking number and carrier are optional, except on `shipped → shipped` (a further parcel), which requires a tracking number.
5. **The Idempotency-Key is required** (the refund route requires it), and it is stored on the history row (`client_key`, `request_hash`) instead of in a table of its own.
6. **`printer_ships` also blocks `ready_for_pickup`.** The brief named only `shipped`. For a pickup order the printer ships to the shop, so "ready" before the print arrived would be false. This is also what keeps the claim in the Cancellation section true.
7. **`variantLabel` is the variant's CURRENT label** (`product_variants.label` by the frozen `variant_id`, tenant-scoped). No label is frozen on the order. The SKU, name and prices are the frozen ones.
8. **Two test files outside my list were edited.** Both changes were needed to keep the suite green:
   - `refunds.test.ts`: the detail's exact-shape assertion now includes the new fields. The denylist test is extended as the brief and the coordinator asked: it covers a POD line with a job ref, a fulfilment change, and the list. Its `1000` value check is limited to the detail, because the list legitimately shows other orders' 1 000 refunds.
   - `slice/vertical-slice.test.ts`: its key denylist includes `sku`, but the brief requires `items[].sku`. That SKU is the SHOP's article number (`SLICE-TEE-1`), not the printer's (`TEE_S`, which lives only in the POD mapping and the snapshot). The check now lets `sku` through on the lines only, asserts it is the shop's, and asserts the printer SKU value is absent from the whole read.
9. `count` and `totalMinor` sum `total_minor` regardless of currency. A shop has one currency today.

## Open questions

1. **No code writes `order_items.production_state`.** Its comment says "set by a platform route (print portal / manual, later)". Until that writer exists, an order with any POD line can go to `processing` but never to `shipped` / `ready_for_pickup`. That follows the rule, but a live POD shop cannot close its orders. Which unit writes it, and from what signal (SnapWear has no status API)?
2. Should a seller be able to undo a mistaken step (e.g. `shipped` → `processing`)? It is not built; the history is append-only, so an undo would be a new row.
3. Every change writes an `email.order_status` outbox row, `processing` included. Unit WE decides which steps actually mail the buyer. Until WE lands, those rows sit `pending`: the sweeper and the consumer claim only known types.
4. The fulfilment words in `orders.status`'s CHECK (`processing` … `completed`) are now dead for new writes. Should a later migration retire them?
5. Should the dashboard's money counter be net of refunds? Only `totalMinor` (gross) is built, as the brief says.

## Reviewer wiring

- `REQUIRED_MIGRATION` → `"0046_order_fulfilment.sql"` in `cloudflare/src/app.ts`, plus the two tests that pin it: `test/health.test.ts:36` and `test/public-catalog.test.ts:572`. My tests do not depend on it: vitest applies every migration in the folder, and `/ready` passes with 0045 named.
- `test/slice-harness.ts`: no change needed. The new column has a default and the webhook names its columns.
- Staging: apply 0046 through the preflight. It is additive (one `ALTER … ADD COLUMN` on `orders`, three on `order_status_history`, one new table, one backfill `UPDATE`).
- No `wrangler.jsonc`, `env.d.ts`, `vitest.config.ts` or pinned-file change is needed.
- For unit WE: the consumer of `email.order_status`. The payload is `{historyId, orderId}`; the tracking number is at `order_shipments.history_id = historyId`.
- For unit FD / the FA dev API: the two routes above, and the detail's new fields.
