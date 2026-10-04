claude-opus-5-5

# CP6-PS1: the SnapWear submit client (off) and the printer's production status intake

I built this on HEAD `7b7ef29d`, branch `cf-port`, in the working tree only. There was no git write, no network, no wrangler and no deploy. I touched nothing outside `cloudflare/src/**`, `cloudflare/test/**`, `cloudflare/migrations/**` and this report. During the run, `git status` showed no change of the frontend builder's under `src/**`.

## Files

| File | |
|---|---|
| `cloudflare/src/dispatch/printer-client.ts` | edited. The stub `snapwearClient` is gone. Added: the gate `snapwearSubmitConfig`, `createSnapwearClient`, the transport seam `SNAPWEAR_FETCH_OVERRIDE`, and `resolvePrinterClient` builds the real client only through the gate. `classifyPrinterResponse` reads a success through `snapwearAcceptedJobRef`. |
| `cloudflare/src/dispatch/snapwear-wire.ts` | edited. Confirmed constants `SNAPWEAR_ORDER_ADD_PATH` and `SNAPWEAR_TOKEN_HEADER`. Assumption holders `SNAPWEAR_SUBMIT_WITHOUT_SHIP_TO` and `snapwearAcceptedJobRef`. |
| `cloudflare/src/dispatch/dispatch-effect.ts` | edited. `parkForPrinter`: a missing client is now a true hold. `PRINTER_HOLD_UNTIL_MS`. The PS2 seam `printFilesForPrinter`. `afterLostAnswer`: fail closed on a refusal that follows a lost answer. |
| `cloudflare/src/outbox/sweeper.ts` | edited. Step 0, `releasePrinterHolds`: parked jobs become due as soon as a client resolves. |
| `cloudflare/src/env.d.ts` | edited. `SNAPWEAR_SUBMIT_ENABLED?`, `SNAPWEAR_API_BASE_URL?`, `SNAPWEAR_API_TOKEN?`. |
| `cloudflare/src/dispatch/production-status.ts` | new. `recordProductionStatus`, the ONE writer of `order_items.production_state`, with its parser and its pure decision. |
| `cloudflare/src/routes/print-jobs-platform.ts` | new. `POST /v1/platform/print-jobs/:jobId/status`. |
| `cloudflare/src/commerce/fulfilment.ts` | edited, additively (WB's file). `openSql` is now exported. New `printerShippedOrderStatements` (the auto-ship, see "The mail"). Header comment extended. |
| `cloudflare/src/app.ts` | `CP6-IMPORTS-P` / `CP6-ROUTES-P` blocks; `REQUIRED_MIGRATION` → `0051_print_job_status.sql` |
| `cloudflare/migrations/0051_print_job_status.sql` | new. 3 columns on `order_items`, 2 triggers. |
| `cloudflare/test/snapwear-client.test.ts` | new, 48 tests (part 1) |
| `cloudflare/test/print-job-status.test.ts` | new, 21 tests (part 2) |
| `cloudflare/test/fake-printer.test.ts` | edited. The two places that pinned the stub: one test removed, one assertion changed to `toBeNull()`. |
| `cloudflare/test/dispatch.test.ts` | edited. The stub case is now "SnapWear without its switch is held". The hold test asserts the parking. The "client exception" case now uses a throwing fake transport, so the defensive branch stays covered. |
| `cloudflare/test/health.test.ts`, `test/public-catalog.test.ts` | the migration pin, as WH did for 0049 |

---

## Part 1: the SnapWear submit client

### The gate (`snapwearSubmitConfig`, `printer-client.ts`)

`resolvePrinterClient` builds the SnapWear client only when every row below holds. Otherwise it returns **null**, and the dispatcher holds the job. There is no stub and no guess.

| Condition | Missing or wrong → | Test (`snapwear-client.test.ts`, "the gate") |
|---|---|---|
| `DISPATCH_TARGET === "snapwear"` | null | `is null with` the fake printer as target / no DISPATCH_TARGET / mis-cased |
| `APP_ENV === "production"` | null | `is null with` staging / no APP_ENV / mis-cased |
| `SNAPWEAR_SUBMIT_ENABLED === "true"` (exactly) | null | `is null with` no switch / false / TRUE / 1 / " true" |
| `SNAPWEAR_API_BASE_URL` is a bare https origin (no credentials, port, path, query or fragment; trailing `/` allowed; refused, never repaired) | null | http, path, query, fragment, credentials, port, not a URL, mis-cased |
| `SNAPWEAR_API_TOKEN` is present, printable ASCII, no space, 16 to 512 characters | null | missing, empty, short, a space, CR/LF |
| all five | the client, posting to `<origin>/api/order/add` | "is built with all five" |

**Staging can never build it.** One test sets every SnapWear value on staging. Pointed at `snapwear`, staging gets null. Pointed at `fake-printer`, it gets the fake: the fake's route receives the job, and the SnapWear transport records zero calls.

### The request

`POST <origin>/api/order/add`, built by `createSnapwearClient`:
- Headers: `x-api-token: <token>`, `content-type: application/json`, `accept: application/json`. There is no `Authorization` header.
- The body is `toSnapwearJobBody(job)`, the same bytes the fake receives.
- `redirect: "manual"`: a 3xx comes back and is classified `unknown`, so the token never follows a redirect.
- `AbortSignal.timeout(30 s)`.
- The answer goes through `classifyPrinterResponse`, the same closed union as before.

A transport failure is `unknown` with reason `network`, whatever its message said. The client never logs.

Tests:
- "never puts the token, the address or the body in a result or a log line": a thrown error whose message contains the token and the URL.
- "writes no token, origin or print address into the row, the alerts or the logs": a full dispatch through the effect, with the outbox row, the alerts, the line and every console method searched.

### To confirm with SnapWear

Each assumption is ONE constant or ONE function, with the assumption written beside it in the code. Every test named below is in `test/snapwear-client.test.ts` unless another file is given.

| Q | Assumption taken | Holder | Test | If the answer differs |
|---|---|---|---|---|
| **C4** | SnapWear may fetch the artwork at print time, days later. The presigned print address therefore lives **7 days**, R2's maximum. | `DISPATCH_PRINT_URL_TTL_SECONDS` (`dispatch-effect.ts`) | "C4: the print file's address lives 7 days"; the URL's `X-Amz-Expires` in "submits the frozen line…" | If they store at import: shorten it to about an hour. If they re-fetch for a reprint after 7 days, a presigned URL cannot serve that. We would need our own non-expiring, token-checked redirect route (a design change). |
| **C5** duplicate | A duplicate `job_id` is `400` with `message` exactly `"Job with this job_id already exists"`. Any other 400 is `rejected`, never accepted. | `SNAPWEAR_DUPLICATE_JOB_MESSAGE` (`snapwear-wire.ts`) | "C5: a 400 is a duplicate ONLY with the assumed message…" | Change the constant (or the matcher, e.g. to `errors.job_id`). Until then a real duplicate reads as `rejected`, which fails closed: on a first attempt the job is `failed` with an alert; after a lost answer it stays `unknown` (row below). |
| **C5** `design` | Optional. We do not send it. | `toSnapwearJobBody` (`printer-client.ts`) | "C5: neither `design` nor a neck-label key is sent; the body has exactly the known keys" | Add the key in the builder, plus its source. |
| **C5** neck label | No neck label is sent. | `toSnapwearJobBody` | same | Add the key. The label artwork would be a print file of its own (PS2). |
| **C6** success | Accepted ONLY on a 2xx whose body is `{ id: <string 1–200>, status: "accepted" }` (the fake's shape). Any other success shape is `unknown`: re-submitted with the same id, settled by the duplicate answer or by a human after 30 minutes. | `snapwearAcceptedJobRef` (`snapwear-wire.ts`) | "C6: accepted ONLY on 2xx { id: string, status: 'accepted' }…" | Rewrite this one function to their shape. The 200-character cap matches the `printer_job_ref` CHECK: a longer id used to abort the completing batch. |
| **C6** charge | The auto-pay charge result is not read. An order placed but unpaid is caught by LAUNCH_TODO B9 (daily look at SnapWear's unpaid orders). | `snapwearAcceptedJobRef` (its comment) | same test (only that exact shape is accepted) | If the answer shows a failed charge, map it to `rejected` (`charge_failed`) inside that function. |
| `items[]` wrapper | One entry per job, `{ sku, quantity }`, because one order line is one job. | `toSnapwearJobBody` | "items[] and the pairing…" | Change the builder. |
| pairing | `artworks[i]` is printed at `layouts[i].location`; front before back. | `toSnapwearJobBody` (the order comes from `buildDispatchJob`) | same; also `fake-printer.test.ts` "pairs each artwork with its placement" | Change the builder. |
| address | `shipping_address { name, address1, address2, zip, city, country_code, phone }`. Phone is optional and null when not given. No buyer e-mail is sent. | `snapwearShippingAddress` (`snapwear-wire.ts`) | "the address: the assumed field names, the phone null when not given, no e-mail" | Change the function. If phone or e-mail is required, the checkout must collect a phone (a markup change, CP4_R open question 1) and the job must carry the buyer's e-mail (the DPA covers it). |
| collected order | A job WITHOUT a parcel address (a pickup order, or one from before 0045) is **not sent**: the client answers `rejected` / `ship_to_missing` before any call. The dispatch then fails with its alert, and a human places the job by hand and resolves it as accepted. | `SNAPWEAR_SUBMIT_WITHOUT_SHIP_TO = false` (`snapwear-wire.ts`) | "a collected order (no parcel address) is never sent…"; "a collected order fails with its alert, and SnapWear is never called" | Build the address SnapWear names (e.g. the shop's) in the client and set the constant to true. The fake still takes such jobs. |
| mockups | `mockups[]` is optional; we send `[]`. What would fill it: the product's mockup images (the studio's publish makes them `product_media` public objects, CP5-FN2), frozen by object id into the line's production snapshot at checkout and turned into addresses at dispatch. The snapshot carries none today. | `PrinterJob.mockupUrls` (comment) / `toSnapwearJobBody` | "items[] and the pairing… mockups optional" | Freeze the ids at checkout and fill the field. |
| parcels (new) | One SnapWear order per order **line**. We do not know whether SnapWear puts the lines of one order into one parcel, or charges shipping per SnapWear order. | (the dispatch design, PLAN §2.3: job id `{orderId}-{lineNo}`) | n/a | If shipping is charged per SnapWear order, the per-order shipping withholding (LAUNCH_TODO decision "withheld once per printer per order") under-collects on every multi-line order. The fix is one job per ORDER (`items[]` with many entries), which is a dispatch redesign. |
| **C7** | SnapWear's shipping e-mail carries our job id and a tracking number. | The intake takes the job id and optional tracking fields. | `print-job-status.test.ts` | The A12 parser calls the same function. |
| (ours) token | Printable ASCII, 16 to 512 characters. | `SNAPWEAR_TOKEN_PATTERN` | the gate tests | Relax the pattern. |

### Holding: the brief's "as it already does" was not true

What I checked: before this unit, a null client went to `retryLater("printer_not_configured")`. Every wake-up spent one attempt. After 10 attempts, roughly 4 hours of backoff (1, 2, 4 … 60 minutes), the row was `failed` with `dispatch_failed`, and the line showed "failed" to the seller. Nothing re-dispatches a `failed` row: a human can only resolve it, which means placing the job by hand. So a production window with the switch off would have failed every paid POD order after about 4 hours. That breaks "no terminal failure, no lost job".

What I built (`parkForPrinter`, with the same shape as the payment hold's `parkForHold`):
1. **Park.** The claimed row goes back to `pending`, with its claim released, `last_error = 'printer_not_configured'`, and `next_attempt_at = PRINTER_HOLD_UNTIL_MS`. That is year 9999, one second before the payment hold's sentinel, on purpose: `releaseDispatchHolds` wakes every row at the payment sentinel whose order is not payment-held, and must not wake these.
2. **No attempt is spent.** Nothing claims the row again, so no further attempt is used.
3. **Line and seller.** The line is not touched; the seller reads "queued".
4. **Release.** The sweeper's step 0 makes every parked row due as soon as `resolvePrinterClient` answers non-null. The same sweep sends them.
5. **Alert.** No new alert kind. Reconciliation's existing `dispatch_stranded_30m` names every dispatch unsettled 30 minutes after its order (PLAN §2.2), and a parked row is one of them. A second alert per order would only add noise.
6. **Last attempt.** A row that reaches the effect on its LAST attempt cannot be parked, because it could never be claimed again. It falls back to the old retry, so it fails with its alert. That is the unchanged CP2 rule, and it is tested.

Tests ("holding: no client is a hold, never a failure"):
- Four sweeps across 30 days leave `attempts: 1`, the row parked, no printer call and no alert. The payment-hold release does not wake it.
- Reconciliation alerts at +31 minutes and not at +10.
- The first sweep after the switch sends the job once: `attempts: 2`, `done`, the line accepted.
- A row on its last attempt fails with its alert.

### Also fail-closed (`afterLostAnswer`, `dispatch-effect.ts`)

A `rejected` answer to a row that earlier went `unknown` (its `unknown_since` is set) is kept `unknown`, not `failed`. The job may already be at SnapWear, and the 400 may be SnapWear's duplicate answer in words we cannot read (C5). Recording it "failed — the printer did not receive it" could lead a human to place the job a second time.

Tested both ways:
- After a lost answer, the same refusal stays `unknown` and there is no `dispatch_failed`.
- With no earlier unknown, the refusal is `failed` with its alert.

On staging nothing changes: the fake always answers a re-submit with its known duplicate text.

### The PS2 seam

`printFilesForPrinter(job)` in `cloudflare/src/dispatch/dispatch-effect.ts`. It returns the print file per slot (key + sha256); the dispatcher then checks it in R2 and presigns it. Today it returns the artwork's stored print PNG from the line's frozen snapshot. PS2 (LAUNCH_TODO A5) replaces only this function's body: the printer's whole frame with the motif at its placement offset, rendered per line and stored under the order.

---

## Part 2: the production status intake

### The route

```
POST /v1/platform/print-jobs/{orderId}-{lineNo}/status
     { "state": "in_production" | "produced" | "shipped",
       "trackingNumber"?: string 1..100, "trackingUrl"?: https ≤ 500, "carrier"?: string 1..60 }
```

The tracking fields are allowed only with `shipped`. They are trimmed, may not contain control characters, and `null` means absent.

| Answer | When |
|---|---|
| `200 { changed: true, job, orderShipped }` | the line moved. `orderShipped` is true when this change also recorded the whole order `shipped` (see "The mail"). |
| `200 { changed: false, job, orderShipped: false }` | the same state with the same tracking facts again. Nothing is written. |
| `409 { error: { code: "print_job_status_not_allowed", reason, message } }` | `reason` is one of: `not_accepted` (dispatch state is not `accepted`), `cancelled` (order `cancelled_at`, status `cancelled`, or the line's dispatch cancelled), `refunded` (status `refunded`, or refunded to the charge), `backwards` (a lower state), `tracking_differs` (the same state with other tracking facts; the tracking is write-once) |
| `409 { error: { code: "conflict" } }` | lost a race twice; nothing was written |
| `400 invalid_request` | the body is not exactly the shape above |
| `404` (opaque) | no session; not a platform user; an `X-Shop-Id` header (D70); a cross-site or Origin-less request; any method but POST; a malformed job id (`-0`, `-01`, upper case, encoded `/`); an unknown order or line; a line that is not a printer line |

`job` is `{ jobId, tenantId, orderId, lineNo, state, trackingNumber, trackingUrl, carrier }`. This is the platform's answer, so it carries the tenant.

Every change is audited in the same batch: `audit_events` action `print_job.status`, resource `print_job` / `{jobId}`, actor = the platform user. The metadata is `{ from, to, orderId, lineNo, source }`. No tracking goes into the audit; it stays on the line.

**Kept thin.** The route only authorizes, parses and maps the result. A later SnapWear webhook or the A12 mail parser calls `recordProductionStatus(db, null, jobId, input, now)`, the same function, with `source: "printer"` and history `by: "system"`.

### The rules, each tested ("the rules")

| Rule | How it holds |
|---|---|
| Only an accepted job moves | Moves only when `dispatch_state = 'accepted'`: accepted, a duplicate, or resolved accepted by a human. Tested for `null`, `pending`, `submitting`, `unknown` and `failed` (each 409 `not_accepted`), and for a human-resolved line with no reference. |
| Forward only | Skipping is allowed: the printer's mail may only ever say "shipped". A repeat is a 200 no-op that writes no audit row. A step back is 409 `backwards`. Migration 0051's trigger aborts any writer that tries. |
| Cancelled / refunded | 409 with the reason. Nothing is written. |
| Atomicity under races | One batch: the audit row, then the line update, each guarded on "the line still has the state read, `accepted`, in an open order". A no-op batch is decided again (two tries). Tested: a cancellation landing between the read and the batch gives 409 `cancelled` and writes nothing. |
| A repeat is answered from what is recorded | A repeat answers 200 no-op even if the order closed since. The fact stands; idempotency is worth more than a fresh refusal. |

### What a written state changes

| Where | `in_production` | `produced` / `shipped` | Test |
|---|---|---|---|
| Cancellation (`cancellation.ts` `notProducedSql`) | Still cancels. The accepted job gets a `printer_cancellation` row, which raises a human-action alert. | 409 `return_case`. Nothing changes. | "cancellation: produced or shipped is a return case…" (real fake-printer acceptance, real cancel route) |
| Full refund (`refund-dispatch-stop.ts`) | The refund settles and queues a `printer_cancellation`. | The refund settles (the buyer's money moves) but queues NO printer cancellation: the goods exist; it is a return case for a human. | "a full refund: still settles…" (a webhook-paid Connect order, the real refund route) |
| Withholding release (`withholding-release.ts:96`, `OR wr_i.production_state IS NOT NULL`) | **Nothing changes for the money.** See below. | same | same test: `discovered 0`, no `withholding_releases` row, in all three states |
| The seller's fulfilment (`fulfilment.ts` `printer_ships`) | n/a | `shipped`: the line no longer counts as unsent, so the seller may ship or hand over the order once EVERY printer line is shipped. | "a mixed parcel order waits for the seller…", "a pickup order waits for the seller…" |

**On line 96.** The release requires every printer line to be untouched by the printer: no `dispatch_state` in (`submitting`, `accepted`, `unknown`, `failed`), no `printer_job_ref`, no `dispatched_at`. The writer moves only an ACCEPTED line, and an accepted line already fails lines 93 to 95 (and line 82: its dispatch row is `done`, not superseded). So from the moment the printer accepts, the production withholding stays with the platform, because SnapWear's auto-pay charges at acceptance. A written state cannot change that. Line 96 would matter only for a state written on a line that never reached the printer. It would then block the release for ever, and the shop would pay for production that never happened. That is a second reason the writer refuses `not_accepted`. Mutation P13 (line 96 removed) leaves my tests green, which confirms that nothing changes for the money.

### The mail (a decision: I took the conservative one)

The buyer's shipped mail goes through the existing order-mail path: one fulfilment history row, then the `email.order_status` outbox row (`{historyId, orderId}`), then WE's `runOrderStatusEmailEffect`. It goes out **once**:

- **All-printer parcel order** (every line is a printer line, delivery by parcel). When the printer sends the LAST unsent line, the same batch records the order `shipped`. `printerShippedOrderStatements` in `fulfilment.ts` writes the history row, the audit row, the mail row and the update last, exactly as the seller's change does. It runs only if the order is open and still `unfulfilled` or `processing`. The route nudges the mail. This is not per line: the first of two lines writes nothing at order level. Two last lines racing still ship the order once (tested). The seller's own `shipped` afterwards is shipped → shipped, which requires a tracking number (another parcel). Their `delivered` is a different mail.
- **Mixed order** (a line the seller sends) or **pickup order** (the print went to the shop): the intake does not touch the order. The seller marks it shipped or ready for pickup as `fulfilment.ts` describes, which is now possible, and that is the one mail.

Decisions inside this, listed for a veto:
1. **The printer's tracking is NOT in the buyer's mail, and NOT on the seller's order.** The auto-ship writes no `order_shipments` row. That row feeds both the mail and the seller's `shipments[]`, so tracking for the buyer would also widen what the seller sees. The tracking stays on the line (0051), where no tenant route reads it. The mail says "Skickad" without a tracking number (tested on the rendered mail). Switching it on is one statement in `printerShippedOrderStatements` (insert the shipment from the line's tracking when the order's lines share one), after Mikael decides.
2. `fulfilment_status` was "written only by the seller's route" (0046's comment). It is now also written by `fulfilment.ts`'s auto-ship, the one platform-side case, so the column keeps one owning module. The statusHistory reads `by: "platform"`, or `"system"` for a future automated source.
3. A line whose dispatch was cancelled before acceptance does not hold the order back. This is `fulfilment.ts`'s own rule (tested).

### Migration 0051 (`0051_print_job_status.sql`)

The change is additive:
- `order_items.printer_tracking_number` (1–100, no CR/LF), `printer_carrier` (1–60), `printer_tracking_url` (`https://…`, 9–500, no CR/LF or space). All nullable; no tenant route selects them.
- Trigger `order_items_production_state_forward`: the state never goes back and is never cleared.
- Trigger `order_items_printer_tracking_once`: tracking is written only in the statement that moves the line to `shipped`, and never changed after.

Why a migration (the brief preferred none): a printer job is one LINE, so tracking is per line, and each line can be its own parcel. 0046's `order_shipments` is per order change and is read by the seller's order detail. It could not hold per-line tracking without widening the seller's view. The existing fixtures that write `production_state` directly (from NULL) pass the triggers unchanged.

### A7 (out of stock after acceptance): not built

It does not fit without more than a state.

The smallest design:
- A new nullable `order_items.printer_exception TEXT CHECK (IN ('out_of_stock'))`, written by the same intake (`state: "exception"`).
- `POD_STATE_SQL` maps it to the seller's existing word `failed` ("the printer refused it; the platform is on it"), so there is no new seller-visible state.

What stops it:
1. **The order would be stuck.** `fulfilment.ts` would have to stop counting the line as unsent (or the order can never ship), and someone must decide reprint versus refund.
2. **The money.** SnapWear charged at acceptance. If SnapWear refunds us, that line's withholding must go back to the shop. D36 releases only whole orders, so a per-line release (or a manual adjustment) needs a design and Mikael's decision.

---

## Deviations from the brief

1. **Holding was not a hold** ("as it already does for a null client"). I built `parkForPrinter` and the sweeper's release. Details are under "Holding".
2. **No new alert.** The "existing threshold" alert is reconciliation's `dispatch_stranded_30m`, which already names a parked row. I first wrote a separate alert, then removed it as a duplicate.
3. **A refusal after a lost answer stays `unknown`** (`afterLostAnswer`). This was not asked for. Without it, the C5/C6 guesses being wrong could make a human place a SnapWear job twice.
4. **The success reader caps the printer's id at 200 characters**, the `printer_job_ref` CHECK. Before, a longer id would have aborted the completing batch. The fake's ids are UUIDs, so nothing changes there.
5. **The real client refuses a collected order** (`ship_to_missing`) instead of sending a job without an address.
6. **A migration** (0051). The reason is under "Migration 0051".
7. **`fulfilment.ts` (WB's committed file)** gained an export and one function. The brief allowed `cloudflare/src/**`; I kept the column's writer in its module.
8. **Tests outside my new files**: `fake-printer.test.ts` and `dispatch.test.ts`. Only the cases that pinned the stub changed, and the "client exception" case kept its purpose with a throwing fake transport.

---

## Tests and mutations

- `test/snapwear-client.test.ts`, 48 tests: the gate (one test per missing condition), staging never, the wire, no secret leak, one test per assumption, end to end through the dispatcher in a "production" env with a fake SnapWear transport (accepted; lost answer then duplicate; refusal after a lost answer; plain refusal; collected order), and holding.
- `test/print-job-status.test.ts`, 21 tests: 16 refusal cases on the route (404) and 18 bodies (400) with nothing written; the rules; the race; the three guards on real flows (fake-printer acceptance, the cancel route, a webhook-paid Connect order, the refund route, reconciliation); the seller's fulfilment for parcel, mixed and pickup orders; the mail (once, from processing too, racing, rendered without tracking, repeats and the seller's own marks); the seller's read (one word per line; no tracking, carrier or job reference anywhere in it); the 0051 backstops.

Each mutation was applied once to the working tree by a script (copy, edit, run the one test file, copy back), with no git:

| # | Mutation | Result |
|---|---|---|
| M1 | gate without `APP_ENV === "production"` | 4 failed |
| M2 | gate without the switch | 8 failed |
| M3 | base URL protocol not checked | 1 failed |
| M4 | `redirect: "follow"` | 1 failed |
| M5 | collected order sent anyway | 2 failed |
| M6 | any 400 is a duplicate | 3 failed |
| M7 | any 2xx with an id is accepted | 1 failed |
| M8 | `afterLostAnswer` removed | 2 failed |
| M9 | no parking (the old retry) | 2 failed |
| M10 | the sweeper never releases | 1 failed |
| M11 | printer hold uses the payment hold's sentinel | 1 failed |
| P1 | decision without the `accepted` check | 1 failed |
| P1b | the batch guard's `dispatch_state = 'accepted'` removed | 0 failed: equivalent. Nothing moves an accepted line's dispatch state, so only the decision can refuse; the guard is defence in depth. |
| P2 | no backwards check | 1 failed (the trigger aborts the batch) |
| P3 | a repeat is a move | 3 failed |
| P4 | no cancelled/refunded decision | 3 failed |
| P5 | auto-ship without "no unsent line" (per-line mail) | 1 failed |
| P6 | auto-ship of a mixed order | 1 failed |
| P7 | auto-ship of a pickup order | 7 failed (0046's trigger aborts the batch) |
| P8 | the mail row never written | 2 failed |
| P9 | the route does not nudge the mail | 1 failed |
| P10 | the route without the same-origin check | 1 failed |
| P11 | cancellation's guard ignores `production_state` | 1 failed |
| P12 | the full refund's stop ignores `production_state` | 1 failed |
| P13 | withholding line 96 removed | 0 failed: expected. A written state changes nothing for the money (see "On line 96"). |
| P14 | `printer_ships` refusal removed | 1 failed |
| P15 | 0051 tracking trigger made a no-op | 1 failed |
| P16 | 0051 forward trigger made a no-op | 1 failed |
| P17 | the batch guard without `openSql` (the race) | 1 failed |

## Gates

- `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`: clean.
- `npx vitest run`: **Test Files 104 passed (104), Tests 4390 passed (4390)**. HEAD had 102 / 4322. The difference: 2 files and +69 tests, minus the one stub test. Two `Network connection lost` uncaught-exception lines print during the run, as at HEAD.
- `npm run types:check`: "Types at worker-configuration.d.ts are up to date."
- `node guard/guards.test.mjs`: **guard: PASS**. The guard scans tracked files only, and my five new files are untracked until the reviewer commits. I grepped them and every changed file for the three families: no match.

## Reviewer wiring

- **Migration 0051** through the preflight on staging (additive: 3 `ADD COLUMN` + 2 triggers). `REQUIRED_MIGRATION` and the two test pins are already moved.
- **Staging: nothing.** `DISPATCH_TARGET` stays `"fake-printer"`. Give staging none of the SnapWear values (the code ignores them there anyway). A preflight check that refuses any `SNAPWEAR_*` var on staging would be cheap belt and braces.
- **Production: NONE of these until SnapWear has confirmed C4–C6 and the address.** Then:
  - `env.production.vars.SNAPWEAR_SUBMIT_ENABLED = "true"`
  - `env.production.vars.SNAPWEAR_API_BASE_URL = "https://<SnapWear's API host>"` (bare origin)
  - secret: `npx wrangler secret put SNAPWEAR_API_TOKEN --env production`
- **Types:** `src/env.d.ts` declares the three as optional. `worker-configuration.d.ts` is generated from `--env staging`, which gets none of them, so `npm run types` changes nothing. Nothing else needs to be in it.
- No `wrangler.jsonc`, `pinned.*.json` or `scripts/` change was made.

## Smoke steps on staging (after 0051 and the deploy)

1. Buy a POD product on the staging storefront with **delivery by parcel** and only that product. The webhook writes the order, and the dispatch is nudged. The fake printer accepts the job.
2. Open the order in the admin (`https://chopshop-admin-stg.kent-ee2.workers.dev/admin/orders/<orderId>`). The line reads `podState: "in_production"` and fulfilment `unfulfilled`. The job id is `<orderId>-<lineNo>`, with `lineNo` from `items[].lineNo`.
3. Signed in as the platform user, in the admin origin's console:
   ```js
   await (await fetch('/_api/v1/platform/print-jobs/<orderId>-1/status', {
     method: 'POST', credentials: 'same-origin',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ state: 'shipped', trackingNumber: 'SMOKE1', carrier: 'DPD' }),
   })).json()
   ```
   Expect `{ changed: true, orderShipped: true, job: { state: 'shipped', … } }`.
4. Reload the order. Expect `podState: "sent"`, fulfilment `shipped`, a history row `by: "platform"`, `shipments: []`, and no `SMOKE1` anywhere on the page.
5. Send the same call again. Expect `changed: false`. Then send `{ state: 'produced' }`. Expect 409 `backwards`.
6. Read-only D1 check: `SELECT item_index, dispatch_state, production_state, printer_tracking_number FROM order_items WHERE order_id = '<orderId>'`, and `SELECT event_type, status FROM outbox_events WHERE aggregate_id = '<orderId>'`. Expect exactly one `email.order_status`, `done`. Without a Resend key on staging, its ledger row stays `pending` (CP5_WE_REPORT).
7. For a **pickup** order, step 3 answers `orderShipped: false`. The seller can then set "ready for pickup", which before step 3 was refused with `printer_ships`.

## Open questions for Mikael

1. Should the buyer's shipped mail carry the printer's tracking number? That also shows it on the seller's order, because one shipment row feeds both. Default taken: no.
2. **Collected POD orders with SnapWear:** where should the parcel go? Until this is answered, the real client refuses them and a human places them by hand. Another option is to stop POD + pickup at checkout once SnapWear is live.
3. **One SnapWear order per line:** if SnapWear charges shipping per order, multi-line orders under-withhold shipping. Ask SnapWear together with C5/C6.
4. The automatic `shipped` for an all-printer parcel order (one mail when the last line ships): keep it, or leave every order to the seller?

## Follow-ups

- **The platform page control for the status route.** It needs a platform list of accepted lines (e.g. `GET /v1/platform/print-jobs?state=…`) and per-line buttons. Not built.
- **The seller's view of tracking:** a decision (open question 1), then the shipment row or a new seller field.
- **PS2:** the canvas PNG per line at `printFilesForPrinter` (`dispatch-effect.ts`). It waits on C2/C3 and the render container.
- **A7:** the design above, once the money side is decided.
- **A12:** the mail parser calls `recordProductionStatus` with `actorUserId = null`.
- **Mockups:** freeze the product's mockup ids into the snapshot and fill `mockupUrls`.

---

## Codex round 1 (review of `7347c8bc`)

### [P2] A job whose answer was lost was parked as `pending`

**The finding was real.** A row that went `unknown` (its answer lost, `unknown_since` set) can be claimed again after its backoff. If the printer client was gone by then (the switch off, a var removed), `parkForPrinter` turned it into `pending` with the far-future instant. That locked the operator out:
- `resolveDispatch` accepts only `unknown` or `failed`;
- the sweeper's `dispatch_unknown_30m` alert skips `pending`.

So a job SnapWear may already hold could be neither resolved nor named by its alert for as long as the client stayed off.

**The fix** (`cloudflare/src/dispatch/dispatch-effect.ts`, `cloudflare/src/outbox/sweeper.ts`):
- **`holdUnknownForPrinter`.** In `runDispatchEffect`, a client-less run of a row with `unknown_since` set goes here, never to `parkForPrinter`. It is `markUnknown` under the claim's fence with `next_attempt_at = PRINTER_HOLD_UNTIL_MS` and `last_error = 'printer_not_configured'`, and the line is set to `unknown` in the same batch.
  - **Resolvable:** the row is `unknown`, so the resolve route takes it.
  - **Alerted:** `dispatch_unknown_30m` selects by status and `unknown_since`, not by next attempt.
  - **No attempt spent:** an `unknown` row is claimed only when `next_attempt_at <= now`, so nothing claims it while it waits.
- **The sweeper's release** (`releasePrinterHolds`) now covers `status IN ('pending', 'unknown')` at the hold instant. When a client resolves again, the row is due, claimed and re-submitted with the SAME job id. `unknown_since` is one-way, so `afterLostAnswer` still applies: an unreadable refusal keeps it `unknown`, and the duplicate answer settles it.
- **Last attempt.** A row on its last attempt also stays `unknown`, not `failed`. `markUnknown` needs no remaining attempt, whereas the old fallback ended `failed`, which claimed the printer never got the job.

**Why this shape.** It is the simplest one that meets all three: one existing transition (`markUnknown`) and one widened `IN`. There is no new state, column or alert. The `pending` park is unchanged for a job that was never possibly at the printer.

**Seen but not changed (pre-existing CP2 behaviour, not in this finding).** The other retryable failures *before* the printer call (storage not configured or failing, presign failure, the payment-hold fallback, a client exception) still send a previously-`unknown` row back to `pending` with a backoff of minutes. They are bounded, and they end `failed` after the last attempt. The same reasoning would keep such a row `unknown`. That is a one-line follow-up in `retryLater`, if wanted.

### Tests (`cloudflare/test/snapwear-client.test.ts`, +2)

1. **"a job whose answer was LOST stays unknown while no client exists: resolvable, alerted, no attempt spent".** Two shipped orders.
   - Each submit loses its answer (`unknown`, attempts 1).
   - The switch goes off before the retry. Each is held as `unknown`: attempts 2, `next_attempt_at` at the hold instant, `last_error 'printer_not_configured'`, line `unknown`.
   - Sweeps at +40 min and +24 h spend no attempt, and both rows carry `dispatch_unknown_30m`.
   - One row is resolved accepted by a human through `resolveDispatch` (status ok, line `accepted`, the human's reference).
   - With the client back, the sweep releases the other (`printerReleased: 1`) and re-submits it. SnapWear answers an unreadable 400, so the row stays `unknown` (`unknown_rejected_after_unknown_bad_request`, attempts 3, line `unknown`). The next sweep gets the duplicate answer: `done`, attempts 4, line `accepted`. Both calls carried the same job id.
2. **"a lost-answer job on its LAST attempt with no client stays unknown, never failed".** Status `unknown`, line `unknown`, no `dispatch_failed`.

### Mutations

| Mutation | Result |
|---|---|
| fix removed: an `unknown_since` row goes to `parkForPrinter` again | 2 failed (both new tests) |
| the sweeper's release covers `pending` only | 1 failed (the release half of test 1) |

### Gates (round 1)

- `npx tsc --noEmit`, `-p web`, `-p admin`: clean.
- `npx vitest run test/dispatch.test.ts test/snapwear-client.test.ts test/print-job-status.test.ts test/fake-printer.test.ts test/outbox.test.ts test/outbox-email.test.ts test/money-followups.test.ts`: **7 files, 279 tests, all passed.**
- Full `npx vitest run`: **Test Files 104 passed (104), Tests 4392 passed (4392)**. That is round 0's 4390 plus 2. CP7-T1 had no Worker file in the tree at the time of the run (no 0052, `REQUIRED_MIGRATION` still 0051), so nothing of theirs affected it.
- `npm run types:check`: up to date. `node guard/guards.test.mjs`: PASS.

Files changed this round:
- `cloudflare/src/dispatch/dispatch-effect.ts`
- `cloudflare/src/outbox/sweeper.ts`
- `cloudflare/test/snapwear-client.test.ts`
- this report
