claude-opus-5-5

# CP11 — U3: Prodigi webhook intake `POST /v1/webhooks/prodigi`

Built in the worktree `cp11-prodigi` (HEAD `e6650207`, U12 + U4). I made no git write, no network call, no wrangler call and no deploy. No key appears anywhere: the tests use U12's made-up keys.

## Files

- `cloudflare/src/dispatch/prodigi-intake.ts` (new). It holds the route handler, the CloudEvent reader, the pure mapping `prodigiLineFact` and `intakeProdigiOrder`.
- `cloudflare/src/dispatch/prodigi-client.ts`. Appended: `readProdigiOrder(env, config, id)`, `PRODIGI_ORDER_REF_PATTERN`, `PRODIGI_READ_MAX_BYTES` and the type `ProdigiOrderRead`. One header sentence was added; the submit path is untouched.
  - `readProdigiOrder` is a function next to `createProdigiClient`, not a method on `PrinterClient`. Making it a method would have meant editing `printer-client.ts`, which is U12's file.
  - It uses the same seam (`PRODIGI_FETCH_OVERRIDE` via `seamFetch`), the same gate config (`prodigiSubmitConfig`, so the host/key pairing applies to reads too), `redirect: "manual"`, `AbortSignal.timeout(PRINTER_SUBMIT_TIMEOUT_MS)` (30 s) and the `X-API-Key` header.
- `cloudflare/src/app.ts`. Changes are only inside `// CP11-IMPORTS-U3 — start/end` (one import) and `// CP11-ROUTES-U3 — start/end`. The route is `app.all(PRODIGI_WEBHOOK_PATH, onMethods(["POST"], …))`, registered right after the Stripe webhook. It is not wrapped in `storefront(...)`.
- `cloudflare/test/prodigi-intake.test.ts` (new, 31 tests).
- `docs/cf-port/CP11_U3_REPORT.md` (this file).

## The route's contract

**Request:**
- `POST {AUTH_BASE_URL}/v1/webhooks/prodigi`. Exact path, no sub-paths.
- `Content-Type` is `application/json` or `application/cloudevents+json`. Case and parameters such as `charset` are ignored.
- The body is a JSON CloudEvent of at most 64 KiB (65,536 bytes), read with `readJsonBodyWithin`.
- Only two things in the payload are read:
  - `type` must be a string that starts with `com.prodigi.` and is at most 200 characters long.
  - The order id is taken from `subject`, `data.id` or `data.order.id`. Every one of these that matches `^ord_[A-Za-z0-9]{1,64}$` must be the same id, and there must be at least one.
- `specversion` and the other CloudEvent attributes are not required. Requiring them would gain nothing, because the payload is never trusted, and it would risk 404-ing every real callback if Prodigi's envelope differs.

**Answers, in the order they are decided:**

| # | Condition | Answer |
|---|---|---|
| 1 | Method is not POST | 404 (onMethods falls through to the router's 404) |
| 2 | Prodigi gate off: `prodigiSubmitConfig(env) === null` (any D2 condition fails, including a live key or the live host on staging) | 404, before the body, D1 or the network is touched |
| 3 | Content type not accepted | 404 |
| 4 | More than 60 requests per minute from one address (`enforceRateLimit`, scope `prodigi-webhook-ip`, key `visitorRateKey(clientIp(request))`) | 429 with `Retry-After` |
| 5 | Body over 64 KiB (declared or streamed), not JSON, not a Prodigi CloudEvent, or no single `ord_` id | 404 |
| 6 | Re-read `GET {PRODIGI_API_BASE_URL}/v4.0/orders/{id}` with our key fails: network/timeout, 3xx (not followed), 401/403/408/429/5xx/other non-200, a 200 that is unreadable, over 1 MiB or names another order | **503** `{error:{code:"unavailable"}}`, so Prodigi retries |
| 7 | Re-read answers 404 or 400 | 404 |
| 8 | The read order's `merchantReference` is not a string of 1–200 characters, or no POD line of that order of ours has `printer_job_ref` equal to the id | 404 |
| 9 | Some line's `recordProductionStatus` returned `conflict` (lost its race twice, nothing written) | **503** |
| 10 | Otherwise, whatever each line's verdict (changed / unchanged / refused) | **200** `{received:true}` |

Every 404 is the opaque `{"error":{"code":"not_found","message":"Route not found"}}`. The tenant comes from the order row; no request carries one.

## The mapping (Prodigi facts → our state)

The rules are applied per line of ours whose `printer_job_ref` is the order id. The line's Prodigi item is the one whose `merchantReference === String(lineNo)`. The rules are checked in this order:

| Prodigi re-read says | Our action |
|---|---|
| A shipment with `status` "Shipped" (any case) whose `items[].itemId` contains the item's `id` (`ori_…`, **not** its merchantReference) | `recordProductionStatus(…, { state: "shipped", trackingNumber: tracking.number, trackingUrl: tracking.url, carrier: carrier.name })`. A field that 0051's rules (`parseProductionStatusInput`) would refuse, such as an `http:` URL, is dropped to null on its own; the line is still shipped. |
| `status.stage` "Cancelled" | No state change. If the line is `accepted` here and the order is neither cancelled (`cancelled_at`, `status='cancelled'`, line `cancelled`) nor refunded to its charge: one critical alert `printer_order_cancelled`, id `printer-order-cancelled:{orderId}-{lineNo}` (the dedupe), resource `print_job`. The insert is conditioned in SQL on the same facts. |
| `status.details.inProduction` is InProgress or Complete, or `status.stage` is Complete | `recordProductionStatus(…, { state: "in_production" })` |
| Anything else, or no item for the line | Nothing |

- Every write goes through `recordProductionStatus(env.DB, null, "{orderId}-{lineNo}", …)` with `actorUserId = null` (audit `source: "printer"`). It refuses backwards moves, refuses cancelled/refunded/not-accepted lines and no-ops repeats.
- Lines are handled one at a time in line order. On the last unsent line, the `shipped` write's `printerShippedOrderStatements` records an all-printer parcel order as shipped and sends its one mail. This answers U12's open question 2: the per-job entry point is called once per line.
- **Cancelled is checked before in-production.** This deviates from the brief's list order. A cancelled order's `details` can still say a step was InProgress when it stopped, and it must not move a line to `in_production`.
- **Shipped is checked first**, so a parcel that left before a cancel is still recorded.

**Which alert for Cancelled: a NEW kind, `printer_order_cancelled`.** Neither existing kind says what happened:
- `printer_cancellation_needed` (dispatch-effect.ts `runPrinterCancellationEffect`) tells a human to cancel a job at the printer because WE cancelled. That is the opposite direction, and reusing it would send the operator to cancel something already cancelled.
- `print_job_out_of_stock` (production-status.ts) records a printer exception and changes the line (0054). Rule 6 says no state change.

The new kind is shaped like those two: critical, ids only, the id is the dedupe, the resource is the print job. 0017's CHECK accepts any lower-case kind, and the digest groups kinds generically, so it needs no migration. The message names the job id, the order id, the line and the `ord_…` only (a test asserts no address or URL appears).

## Deliberately ignored

- **Everything in the payload except `type` and the id.** That includes its status, shipments, tracking, items and `merchantReference`. A test sends a payload claiming Shipped with forged tracking while the re-read says InProgress, and only `in_production` is recorded.
- **Per-item `items[].status`, `charges`, `fulfillmentLocation`, `dispatchDate`, `carrier.service`, `shipments[].id`** (no column for them).
- **`status.issues` / CreatedWithIssues issues** (not surfaced; see open questions).
- **Shipments not yet "Shipped".**
- **The order-level `shipping` detail.**
- **The `produced` state.** Prodigi has no distinct "printed, not yet shipped" fact we trust; `inProduction: Complete` maps to `in_production`.
- **Logging.** The new code calls no `console.*`, and a test spies on all five console methods across a success, a 503, an unknown id and a non-JSON body.

## Tests (`cloudflare/test/prodigi-intake.test.ts`, 31)

The orders are real: they are seeded, then dispatched through the real outbox path to a fake Prodigi behind `PRODIGI_FETCH_OVERRIDE`. Both lines carry one `ord_` exactly as U12 writes it. The same fake answers `GET /v4.0/orders/{id}`, and every request is recorded.

**Refusals (all must give the opaque 404 or the 429, and none may re-read):**
- *another method*: GET/PUT/PATCH/DELETE give 404 and 0 reads.
- *content type*: missing, text/plain, form, multipart, `application/jsonp` and `json` give 404. `Application/JSON; charset=utf-8` is accepted.
- *over 64 KiB*: a declared length and an undeclared stream both give 404. A body under the cap is read (200).
- *not a Prodigi CloudEvent*: non-JSON, empty, an array, no `type`, a foreign `type`, the bare `com.prodigi`, a numeric `type` and an over-long `type` all give 404.
- *no usable id*: `ord_`, `ORD_…`, path tricks, a space, 65 characters, `%2F`, a number, and two different ids all give 404. The id is found in each of its three places.
- *unknown*: Prodigi 404 → 404. Prodigi knows the order but it is nobody's here → 404. It is ours but no line carries the reference → 404. A `merchantReference` that is not a string → 404. No line moves.
- *gate off*: six D2 failures (switch absent/false, no token, a live key on staging, the live host on staging, `APP_ENV` development) each give 404 with 0 reads.
- *rate limit*: 60 pass, the 61st gets 429 with `Retry-After ≥ 1`, and another IP still passes.

**Behaviour:**
- *shipped moves one of two lines*:
  - The re-read is exactly `GET https://api.sandbox.prodigi.com/v4.0/orders/{ord}` with our key and `redirect: "manual"`.
  - Line 1 is shipped with number, URL and carrier.
  - Line 2 (its shipment is still "Processing") is untouched.
  - The order is not shipped, and there is one audit row.
- *same callback again*: three posts give 200 each, with one audit row and identical tracking.
- *in production after shipped*: line 1 stays shipped with its tracking, and line 2 goes `in_production`.
- *every line shipped*: both lines are shipped, the order's `fulfilment_status = 'shipped'`, exactly one `email.order_status` row is written, and a replay adds no second mail.
- *payload status ignored*: a lying payload gives `in_production` only, with no tracking.
- *nothing in production*: 200, nothing moves, no audit.
- *bad tracking field*: an `http:` URL is dropped and the line is still shipped.
- *503*: a re-read of 500/503/401/429/network gives 503 each time and nothing moves. After recovery the retry lands (200, shipped).
- *our cancellation*: the line is refused by `recordProductionStatus` and the answer is 200.
- *nothing logged*: all console methods are spied and none is called.

**Prodigi Cancelled:**
- One critical `printer_order_cancelled` alert per accepted line. It is raised once across two callbacks, its text has ids only, and nothing moves even though `inProduction` says InProgress.
- No alert when the order is cancelled on our side.
- A shipment that left before the cancel is still recorded as shipped, and only the other line alerts.

**Pure mapping:**
- The shipment is matched by `ori_` id, never by merchantReference.
- A non-Shipped shipment does not ship the line.
- The in-production/cancelled table (8 rows, case-insensitive).
- Missing item or malformed order → nothing; a numeric merchantReference does not match.

**`readProdigiOrder`:**
- A 307 is not followed (failed; `redirect` is manual; a signal is present).
- The status table (14 rows): only a 200 naming the same order is `ok`; 400/404 are `not_found`; the rest are `failed`, including a 201.
- An answer over 1 MiB → failed.
- A non-`ord_` id never reaches the network.
- A TimeoutError → failed.

**Tenancy:** two shops' Prodigi orders each move only their own lines, and each audit row carries its own tenant.

## Gate

- `cd cloudflare && npx tsc --noEmit` → clean.
- `cd cloudflare && npx vitest run` (whole suite, final tree) → `Test Files  141 passed (141)` / `Tests  5115 passed (5115)`.
  - One earlier run showed `1 failed | 140 passed`. The failing test was `dispatch-order-unit.test.ts` "Codex round 2: both sibling submissions explicitly REJECTED…", which caught another party's edit to `dispatch-effect.ts` + `dispatch-order-unit.test.ts` mid-write. Those files are not mine and I did not touch them. The re-run on the settled tree is green.
- `node guard/guards.test.mjs` (repo root) → `guard: PASS`. My new files are untracked, so I grepped them by hand for both guard patterns: no match.

## Where the brief was refined (argued)

1. **503 also on `conflict`.** Rule 7 says 200 whatever each line's verdict. But `conflict` is not a verdict: nothing was decided or written. A shipped callback answered 200 there could lose the line's `shipped` for good, because Prodigi may send no later event. A D1 fault still throws (Hono rethrows), which gives the runtime's 500, and Prodigi retries that too.
2. **Cancelled before in-production** (reason above).
3. **A re-read answering 401/403/429/3xx is a 503, not a 404.** Those are our configuration or Prodigi's load, not the caller's fault; the order may well exist.
4. **The order id is also read from `data.order.id`.** Prodigi's v4 callbacks carry the order under `data.order`. Ambiguity (two different ids) is refused.

## Open questions

1. **Tracking that arrives late.** If Prodigi ever marks a shipment Shipped before its tracking exists, the first callback records `shipped` with null tracking. A later callback carrying tracking is then refused `tracking_differs` (0051 writes tracking once). Both Standard services are tracked, so this is unlikely, but a sandbox check would settle it. If it happens, the fix belongs in production-status (allow null → value once), not here.
2. **Auto-resolving `printer_cancellation_needed`.** When WE cancelled and Prodigi later reports the order Cancelled, the open alert could be auto-resolved. Not built; a human still resolves it.
3. **CreatedWithIssues / `status.issues`** are now readable on every re-read and could raise an alert (U12's decision 8 left this to U3). Not built, because the brief's rules do not ask for it and an issue's kind vocabulary is not known yet.
4. **The `produced` state** is never set from Prodigi. If the seller's view needs "printed", `details.shipping: InProgress` might be the signal; that is unverified.
5. **The callback URL is per order** (`callbackUrl = AUTH_BASE_URL + /v1/webhooks/prodigi`, U12). The dashboard-level webhook URL is not needed. If one is also set, the same route serves it.
6. **U5** may move the fake Prodigi in this test file into `test/prodigi-fixtures.ts` (its brief says so). The fake here already keeps orders by id with a settable stage, shipments and read fault.
