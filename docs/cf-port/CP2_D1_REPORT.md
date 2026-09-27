# CP2-D1 report: the vertical slice, failure injection, and the staging scripts

Branch `cf-port`, worker in `cloudflare/`. Nothing was committed or deployed. No wrangler command reached Cloudflare, no state-changing git command ran, and nothing under `~/.config/chopshop/` was read. No `src/**` file was edited, and neither was `vitest.config.ts`: no new binding was needed.

## Counts

| | Tests | Files |
|---|---|---|
| Baseline at start (brief) | 1681 | 47 |
| HEAD `27190caf` (CP2-D2 + its Codex round + the CP2-C Codex commit), without this work | 1715 | 48 |
| **With CP2-D1** | **1741** | **50** |
| CP2-D1's share | **+26** | **+2** |

The per-file split is `test/slice/vertical-slice.test.ts` with 1 test and `test/slice/failure-injection.test.ts` with 25. `test/slice-harness.ts` is shared code, not a suite.

`npm run check` (types:check ✓, tsc ✓, vitest) on HEAD `27190caf` plus these files:

```
✨ Types at worker-configuration.d.ts are up to date.
 Test Files  50 passed (50)
      Tests  1741 passed (1741)
   Duration  50.60s
```

One intermediate full run, while CP2-D2 was mid-edit and the machine's load average was 11–13, showed two **timeouts** at the 5 s limit in other builders' suites: `money-codex-fixes` "a lost re-transfer answer…" and `pod-artwork` "a queue that refuses the nudge…". Both passed alone (138/138) and in the final run above. The slice suites passed on every run: 10 consecutive runs after the last edit, plus runs of single tests in isolation (`-t`).

Other checks:
- `node --test guard/guards.test.mjs` passes.
- A scan of every file below for the brief's forbidden strings (the legacy brand patterns, the retired B2B term, firebase imports) is clean.

## Files (all new)

- `cloudflare/test/slice-harness.ts`: the slice steps as real route calls, plus the fault seams and the ledger.
- `cloudflare/test/slice/vertical-slice.test.ts`: Part 1.
- `cloudflare/test/slice/failure-injection.test.ts`: Part 2.
- `scripts/cf-port/seed-staging-slice.mjs`: Part 3, seeding.
- `scripts/cf-port/reconcile-staging.mjs`: Part 3, reconciliation.
- `docs/cf-port/CP2_D1_REPORT.md`: this file.

The fixtures are reused, not forked:
- `money-fixtures`: `FakeMoneyStripe`, `postEvent` (real signatures), `refundOps`, `paymentEventRow`.
- `dispatch-fixtures`: `quietEnv` recording queues, `outboxRow`, `lineRow`, `printerJobs`.
- `pod-fixtures`: `testPrinter()`, `TEE_S`, `expectNoCostKeys`.

## How the harness works

**What is real.** Every step is a call to the route the plan names:
- bootstrap, platform users, tenants, admins, and Better Auth sign-in;
- `/v1/admin/objects` reserve and content;
- `/v1/admin/pod/artwork`;
- `/v1/render/jobs/*`, called as the farm;
- products, mappings, quote, publish, platform screening;
- the PDP;
- `/v1/checkout` and its payment route;
- the signed webhook;
- the real `-outbox` and `-email` consumers, reached via `worker.queue()`;
- the receipt claim and read;
- admin order, refunds, cancel;
- platform dispatch resolve.

**Written directly, not through a route.** Only two things, and the staging seed does the same:
1. The tenant's Connect id and flags, by SQL. The onboarding endpoints are not built.
2. The farm's uploads, put into the private bucket at the presigned keys.

**Third parties are faked, but only behind their production seams:**
- `FakeMoneyStripe`, through `STRIPE_GATEWAY_OVERRIDE`.
- The fake printer's in-process transport, through `FAKE_PRINTER_FETCH_OVERRIDE` (via `printerWire`).
- A `FakeResend`, through `RESEND_FETCH_OVERRIDE`. It models Resend's Idempotency-Key dedupe: `delivered` is what a buyer actually receives.
- A fake presigner.

**Queues are recording queues.** Every delivery is explicit, so nothing runs in the background.

**Fault injection** uses `instrumentedDb`, the same proxy shape as `pod-publish.test.ts`'s `interleavedDb`, but keyed on SQL instead of a call count. Every operation is logged with its SQL, and a hook can await an interleaving or throw. On top of it:
- `dyingDb(armed, when)` kills exactly one operation, the first one that matches after the external effect happened.
- `printerWire(fault, onDelivered, log)` per job id can deliver, deliver and then lose the answer, or fail before reaching the printer. It logs every **submission**.

**The Stripe fake is fresh per test** (`world.reset()`). The crons are global, so a test's Stripe only knows the intents that test made, and other tests' checkouts are left alone.

**Time travel.** The crons, sweeper and effects take `now` as an argument. The render and email leases are expired on the row itself. `cronTick(env, now)` runs one tick exactly in `scheduled()`'s order:
1. replay
2. sweep
3. reconciliation
4. retention
5. alert digest

For the duration of the tick it pins `Date.now` to `now`, because `scheduled()` reads the wall clock and the digest job refuses a `createdAt` that lies in the future.

**`assertLedgerBalanced(db, orderId, { stripe?, payoutMinor? })`** cross-checks three independent sources, to the öre:
1. The order's money columns (`SELECT *`, so a later money column such as D36's `withholding_released_minor` is picked up).
2. `refund_operations`: succeeded equals `refund_succeeded_minor`, which equals `refunded_total_minor`; held equals `refund_reserved_minor`; succeeded + held ≤ charged; withheld ≤ fee ≤ charged; released ≤ withheld.
3. The fake Stripe's own record:
   - the intent amount, and the fee and destination of every create call;
   - Σ succeeded Stripe refunds = the ledger's figure;
   - each operation maps to exactly one Stripe refund, and each Stripe refund to exactly one operation;
   - D9 flags on every refund call;
   - dispute reversals and re-transfers;
   - D36 application-fee refunds, found by `metadata.withholding_release_id` exactly as the worker finds them.

It asserts the identity:

`charged = refunded + payout + fee + reversed − retransferred − released`

When the admin read's payout is passed in, it must equal the ledger's payout, which must equal what the connected account **nets at Stripe**:

`intent − fee + fee refunds − refunds − reversals + re-transfers`

This matches CP2-D2's `computePayoutAmount`, which uses the net fee.

**Negative controls.** These ran in scratch files that were then deleted:
- The ledger throws on a Stripe refund that D1 never heard of, and on a payout that is off by 1 öre.
- The wire log catches a double submission that the fake printer's table cannot show. Its `job_id` is UNIQUE, which is the printer-side dedupe the design relies on. **So "exactly once at the printer" is asserted on the wire, not only by counting accepted rows.**
- `dyingDb` dies once, and only when armed.
- The seed script's printer and profile documents were fed to the worker's own `parseReplacePrintersInput`, `printersAllowedIn("fake-printer")` and `parseReplaceProfilesInput`, and all accepted them.

## Part 1: the vertical slice (ONE test)

`test/slice/vertical-slice.test.ts` runs through the real routes, in order:

1. Platform bootstrap.
2. Tenant creation, then the Connect account and flags (SQL); commission 800 bps.
3. Printers: `PUT /v1/platform/printers`.
4. Profiles.
5. Reserve and upload the original.
6. Artwork **202**: one `queued` job, and the render nudge is sent.
7. Acquire, outputs, complete **200**. The artwork is `ready` with the attempt's sha256, and the canonical print is present.
8. Mapping.
9. Quote: exactly `{currency, inkopMinor, priceFloorMinor}`, no cost keys.
10. Publish. Screening is **`pending`** (D8, the first product) and the PDP is **404**. After the platform **approves**, the PDP is **200** with an ETag, `pod.printAreas`/`previewUrls`, and no cost keys; `If-None-Match` gives **304**.
11. Checkout, pickup. The snapshot is frozen: `fake-printer`, line 1, TEE_S, the print key and sha256.
12. PaymentIntent. The create call equals exactly:
    - `amount`;
    - `applicationFeeAmount = floor(total·800/10000) + snapshot.totals.withholdMinor`;
    - `transferDestination = acct_…`;
    - `statementDescriptorSuffix = "MELODIE SLIC"`;
    - `onBehalfOf: null`;
    - metadata holding only the join keys.

    The Connect facts are frozen on the checkout.
13. The signed `payment_intent.succeeded`. The instrumented DB proves that **exactly one batch** wrote all of:
    - the order;
    - 1 `order_items` row (with `production_json`);
    - 2 outbox rows (dispatch + email);
    - the receipt hand-off;
    - the `payment_events` ledger row;
    - the checkout update.

    **No other operation** wrote an order, a line or an outbox row. The dispatch payload is `{orderId, lineNo: 1, jobId: "{orderId}-1"}`. Ledger ✓.
14. The `-outbox` consumer, with the dispatch and email nudges. It makes **one submission on the wire**, and the printer holds exactly one job `{orderId}-1` (items, front layout, the print URL). The line is `accepted` with `printer_job_ref`, and the row is `done` with `result_ref`. The `-email` consumer sends **one** confirmation, to the buyer, with subject `Orderbekräftelse …`.
15. Receipt claim: `ready` once, then `issued`. The buyer read has **exactly** the allowlisted keys and a masked email. No denied key (withh/commission/production/cost/printer/snapshot/connect/transfer/stripe/fee split/sku/r2key/tier) appears, and neither the fee nor the withholding appears as any number.
16. Admin read: `money` has **one** `feeMinor`, the payout is `charged − fee` and `pending`, and neither half of the fee appears as any number. Ledger ✓, with the admin payout.
17. Partial refund of 10 000 while Stripe answers `pending`. The route answers 201 `submitted`. The Stripe call carries `idempotencyKey = op id`, `refund_application_fee:false` and `reverse_transfer:true`. The reservation is held (ledger ✓, held 10 000).
18. The settlement webhook `refund.updated` → `succeeded` (a replay moves nothing). Ledger ✓.
19. Payout facts: `partially_refunded`, payout `charged − 10 000 − fee`. Ledger ✓.
20. Full refund of the rest: `refunded`, payout **−fee** (D9; the job was already accepted, so D36 does not apply). Ledger ✓.
21. The dispatch was already accepted, so one `printer_cancellation` row is created, nudged by the route and delivered. The **only** open alert is `printer_cancellation_needed`. Still exactly one printer job.
22. Reconciliation now: `alertsRaised 0`, with no snapshot left without a terminal intent. Retention at +8 d: `purged 1`. The checkout snapshot becomes NULL with `snapshot_purged_at` set, and the **order keeps its copy**. Reconciliation at +8 d: `alertsRaised 0`, nothing unsettled, nothing stranded. Final ledger: payout −fee equals the Stripe net −fee, to the öre.

**Legal gate and consent are not in the slice, because they do not exist in the CF worker.** The checkout input is `deliveryMethod | discountCode | email | idempotencyKey | items | shippingCountry`. There is no terms or consent field, no seller-acceptance gate, and no migration for either. The existing checkout tests exercise pickup only, and so does the slice. See Findings, item 1.

## Part 2: the failure-injection suite, mapped to PLAN §10 CP2

"Exactly once" is always asserted against the third party's **own** record: the fake Stripe's intents and refunds, the printer wire log together with `fake_printer_jobs`, and FakeResend's `delivered`.

| PLAN item | Test(s) | What it proves |
|---|---|---|
| **1 Crash after each external success, before the local commit** | PaymentIntent create | Stripe creates the intent, then the attach `UPDATE` dies, which is a failed invocation and never a false 2xx. The buyer's retry reuses the same idempotency key, so it gets the **same** intent (201), and a later call re-serves it (200). Stripe holds **one** intent. The Connect fee is frozen once, and the order pays through with a balanced ledger and 1 job. |
| | refund create → webhook | Stripe refunds, then the settlement batch dies. The operation stays `reserved` with no refund id, and the reservation is held (ledger ✓). Stripe's `refund.created`, which carries `refund_operation_id`, settles it. The same fact again, as `refund.updated` or as a replay, moves nothing. **One** Stripe call, one refund; the ledger balances with the admin payout. |
| | refund create → reconciliation | The same crash with no webhook. Reconciliation at +31 min lists the refund and settles the operation. No `refund_unsettled_30m` and no release. One Stripe call. |
| | printer submit | The printer accepts, then the completion batch dies. The consumer retries the nudge and the row stays `submitting`. The sweeper runs after the claim TTL and re-submits **the same job id**; the printer answers duplicate. The row is `done`, attempts 2, line `accepted`. The wire shows exactly 2 submissions of `{orderId}-1`, and the printer holds **1** job. |
| | render complete | The promotion to the canonical key lands, then the verdict commit dies: the artwork is still `processing`, and the canonical print is present. The farm resends the same completion (the container does, on 5xx, `render/src/api.ts`). The result is 200, `ready` with the reported sha256, job `completed` at attempt 1, **exactly one** completion audit (`render-job-completed:{jobId}`), and the attempt prefix swept. |
| | email, outbox effect | The job is enqueued, then the commit dies. The re-run after the claim TTL queues the **identical** job. The `-email` consumer is given both copies, acks both, calls Resend **once**, and delivers one email. |
| | email, `-email` consumer | Resend accepts, then the ledger's `sent` write dies. The message is retried. The lease expires (on the row), the message is redelivered, and Resend is called again with the **same** `Idempotency-Key`: 2 calls, 1 key, **1 email delivered**, and the ledger ends `sent`. |
| **2 Duplicate webhook replay** | `payment_intent.succeeded` ×2 (same id), then a new id for the same intent | One order. The rows are exactly dispatch + email. One `payment_events` row for the id; the third event is recorded `ignored` (checkout not payable). 1 job, ledger ✓. |
| | dashboard refund as `refund.created`, `charge.refunded` (embedded), `refund.updated` and a replay | Creates one `origin: stripe` operation and moves 7 000 **once**. Ledger ✓ against Stripe. |
| | admin refund settled by its API answer, then echoed by `refund.updated` + `charge.refunded` | Nothing moves a second time. |
| **3 Delayed success vs the retention sweep** | live abandoned intent | The +8 d sweep **cancels at Stripe first**; the checkout becomes `abandoned`/`canceled`, and the snapshot is **kept**, because the cancel is itself a state change. It is still there at +14 d, and purged at +16 d. No order. |
| | already succeeded | The sweep's cancel is **tried and refused**, and Stripe's `succeeded` is recorded (`skippedSucceeded`). The checkout stays `open` and the **snapshot survives, byte-identical**. The late webhook makes the order with that snapshot, and there is 1 printer job. The checkout's copy is purged only once the order holds it; the order keeps its own. |
| **4 Two concurrent partial refunds** | interleaved at the reservation batch | Both requests read the same version; B runs to completion inside A's reservation. B gets 201 and A **409 `refund_not_allowed`**. Only the reserved refund reaches Stripe. Ledger ✓. A partial refund leaves production alone. |
| | 5 × 30 % racing for real (`Promise.all`) | Only 201/409 answers, 1–3 granted. Σ asked of Stripe = granted × share ≤ charged. Ledger ✓. |
| | interleaved refunds that together cover the charge | Both 201 (the loser re-reads and still fits). The completing settlement **supersedes dispatch before any claim** (`superseded`, `submitted_at` NULL, line `cancelled`). A sweep 1 h later leaves **0 printer jobs**. Status `refunded`, ledger ✓ with the admin payout. |
| **5 Duplicate dispatch delivery** | the same row nudged twice in one batch, then redelivered | Every message acked. Attempts 1, and **one submission on the wire**, one job. |
| | three consumers at once | One claim, **one submission**. The losers are acked or retried, so nothing is dropped. |
| **6 Lost printer response → `unknown` → manual resolution** | delivered, answer lost → **accepted** | Row and line `unknown`, 1 job at the printer. `POST /v1/platform/dispatch/:id/resolve` with `accepted` and the ref: `done`, line `accepted` with the ref, and an audit row carrying who and why. A sweep 1 h later **does not re-submit** (still 1 submission). |
| | never reached → **failed** | `unknown` with 0 jobs. Resolved `failed`: line `failed`, and a sweep 1 h later leaves the row `failed`. The wire shows exactly one (unreachable) attempt, 0 jobs. |
| **7 Cancel during submitting** | `cancel_requested` after the claim, before the call | The cancel route answers `cancel_requested`. The claimed worker is **superseded at the re-check**, nothing goes on the wire, the line is `cancelled`, 0 jobs. |
| | the cancel lands while the request is on the wire | The row is **`submitting`** at that instant, and the cancel answers `cancel_requested`. The result is `done` with 1 job and exactly **one** `printer_cancellation` row. Delivered twice, it gives **one** open `printer_cancellation_needed` alert. |
| **8 Expired render lease with late completion** | | Attempt 1's lease is expired and attempt 2 is leased. Attempt 1 uploads late and completes: **409 `lease_lost`**, its prefix is **swept**, and the artwork is still `processing`. Attempt 2 completes with 200, `ready` with attempt 2's sha256. Attempt 1 resending afterwards still gets 409, and the canonical print holds attempt 2's bytes. |

### Exit criteria

| Criterion | Test | Proof |
|---|---|---|
| One accepted printer job per eligible order, zero for pre-dispatch cancellations | "one accepted printer job per eligible order line…" | This test creates its own cases so the check is never vacuous: 2 eligible orders, 1 cancelled before dispatch, 1 fully refunded before dispatch. It then walks **every** POD line the file made, with these outcomes: <ul><li>always ≤ 1 job;</li><li>`accepted` ⇒ exactly 1;</li><li>superseded unsubmitted ⇒ 0 jobs and line `cancelled`;</li><li>`failed` ⇒ 0;</li><li>anything else must be the stranded test's `unknown`, with 0.</li></ul> |
| Stranded work alerts within 30 min | "stranded work alerts within 30 minutes…" | Sets up four stuck situations: <ul><li>(a) an order whose printer is unreachable;</li><li>(b) a refund Stripe keeps `pending`;</li><li>(c) an intent Stripe charged whose success webhook never came;</li><li>(d) a refund of (c) parked until its order exists.</li></ul>Real cron ticks (`cronTick`, `scheduled()`'s order): <ul><li>**+15 and +29 min: nothing.**</li><li>**+31 min:** `dispatch_stranded_30m`, `refund_unsettled_30m`, `order_missing_for_succeeded_pi` and `payment_event_deferred_30m`, and the same tick **enqueues the D40 alert digest** to `PLATFORM_ALERT_EMAIL` naming all four kinds.</li><li>**+46 min:** `dispatch_unknown_30m` too, 30 min after the answer was first lost at +15. Each alert exists **once**, never duplicated. 0 printer jobs.</li></ul> |
| Refund race cannot over-refund | item 4 | as above |
| Guest receipt cannot read another shop's order | "a guest receipt cannot read another shop's order" | B's storefront cannot claim A's receipt (404). Four cross combinations of order, token and host all get **404 with the identical opaque body**. Only the matching host, order and token combination gets 200. |
| Late render completion rejected | item 8 | as above |
| Money reconciles to the öre | every money step | `assertLedgerBalanced` with the fake Stripe, as above; on staging, `reconcile-staging.mjs` |
| Design diff clean on the slice pages | not in the pool | The staging run plus the §7 baseline diff. |

## Part 3: the staging scripts (the reviewer runs them)

Both scripts refuse unless all of these hold:
- `CHOPSHOP_API_URL` equals `cloudflare/pinned.staging.json` `origins.api`;
- `/health` says `staging` (seed script);
- the Stripe key is `sk_test_`/`rk_test_`;
- `GET /v1/account` is the pinned sandbox platform `stripeAccountId`.

Credentials come only from `CHOPSHOP_API_URL`, `CHOPSHOP_PLATFORM_EMAIL`, `CHOPSHOP_PLATFORM_PASSWORD`, `STRIPE_SECRET_KEY` and `FAKE_PRINTER_TOKEN`. Nothing is written to disk. No secret, cookie or receipt token is printed. Neither script runs wrangler; they print the exact `scripts/cf-preflight.sh staging -- d1 execute …` commands instead.

Offline checks done:
- `node --check` passes for both.
- The refusals were exercised (unset env, the production origin, a live key, no orders given).
- The generated PNG decodes as 3600 × 3600 (`sips`).
- The printer and profile documents are accepted by the worker's own parsers.

They were **not** run against staging: no credentials here.

**`seed-staging-slice.mjs [--tenant slice-YYYYMMDD] [--purchase] [--refund <orderId>:<amountMinor>]`**

Each step is idempotent:
1. Platform sign-in.
2. Tenant `slice-<yyyymmdd>` (UTC) with **hostname = the API host**. A 409 is resolved through `GET /v1/storefront`: the same shop name means it is reused. If another shop holds the host, the script stops and prints the SQL to find it and `--tenant` to reuse it.
3. A sandbox **Express** account: `accounts.create`, type express, SE, `card_payments` + `transfers` requested, `metadata.chopshop_slice_tenant`, `Idempotency-Key`. It is found by metadata on later runs. While charges are disabled, the script prints an **account onboarding link**. It prints the exact D1 `UPDATE tenants SET stripe_account_id=…, stripe_charges_enabled=…, stripe_payouts_enabled=…, stripe_details_submitted=…, stripe_account_synced_at=NULL WHERE tenant_id=…;` with Stripe's real flags, wrapped in the preflight command.
4. Acting-as: an audited platform grant, 1 h.
5. Printers: `PUT /v1/platform/printers`. It refuses to replace-all over other platform printers unless `SLICE_ALLOW_PRINTER_REPLACE=1`. The capabilities are built from `docs/SnapWearDocs/snapwear-catalog.json` model 18000 (front/back 390 × 490 frames, SKUs 2700003/2700004). The tiers are staging placeholders.
6. Profile `apparel_dtg`: added to the active set only if missing (replace-all keeps the others).
7. Artwork: reused by the original's sha256, otherwise reserve, upload and create (202). The original is `.bench/render-bench-typical.png` (3600², 304.8 DPI at 300 mm) or a generated 3600² PNG; the real container's 300-DPI gate needs one of that size. The script polls until `ready`; `SLICE_RENDER_TIMEOUT_S` defaults to 600.
8. Product, reused via its mapping, then: `status: active`, mapping, quote (raised to the floor if needed), publish, platform approval of `pending`, and a check that the public PDP answers 200.
9. `--purchase`: checkout (pickup), PaymentIntent, **Stripe confirm with `pm_card_visa`**, then the receipt poll until the webhook has made the order. Prints the order id.
10. `--refund`: a partial refund through the admin route.

It ends with a summary of every id.

**`reconcile-staging.mjs --tenant … (--orders-json <file> | --order <orderId>:<pi_…>…) [--alerts-json <file>]`**

- **Order ↔ intent pairs come from D1.** There is no order-listing route before CP5, and the admin read deliberately carries no Stripe id. Without them the script prints the preflight `d1 execute --json` commands for orders and open alerts, and exits 2.
- **Per order** it reads the admin view (acting-as) and, from Stripe:
  - the intent and its charge (`expand[]=latest_charge`);
  - the charge's transfer (`amount_reversed`);
  - the application fee (`amount_refunded`, which is where D36 shows);
  - all refunds of the intent, paged;
  - any further transfer to the destination whose `metadata.order_id` names the order (dispute re-transfers);
  - the fake printer's job list.
- **It checks:**
  - charged = `amount_captured`;
  - fee = `application_fee_amount` = the fee object;
  - refunded = Σ succeeded = `charge.amount_refunded`;
  - pending = Σ pending;
  - **payout (D1) = the connected account's net at Stripe** (transfer − reversed − (fee − fee refunded) + further transfers).
- **Output:** a per-order table, the tenant's `unknown`/`failed` dispatch rows (`GET /v1/platform/dispatch`), and the open alerts from `--alerts-json`. The last line is `BALANCED — n order(s), Δ 0 öre` (exit 0) or `UNBALANCED — k of n order(s) disagree, Σ|Δ payout| X öre` (exit 1).

**Staging run for the reviewer:**
1. `seed` (prints the UPDATE and, if needed, the onboarding link).
2. Run the UPDATE through the preflight.
3. Re-run `seed --purchase`.
4. `seed --refund <order>:10000`.
5. Refund the rest in full.
6. `reconcile` with the orders JSON.

Expect `BALANCED`. Also check the fake printer jobs (1 per order) and the alerts (only `printer_cancellation_needed` for a refunded, accepted order).

## What the pool cannot exercise (the staging run must)

1. **Real Stripe:**
   - destination-charge settlement;
   - the transfer = gross and application-fee mechanics the ledger assumes;
   - proportional `reverse_transfer`;
   - asynchronous refund states;
   - real webhook delivery and signatures on both endpoints (platform + Connect `account.updated`);
   - Express onboarding flipping the flags;
   - D36 application-fee refunds.

   The fake models these; staging proves them.
2. **The real render container:** sharp, the 300-DPI gate, R2 honouring presigned PUTs, and on real R2 the `sha256` verification plus `If-None-Match: *` promotion. The pool's R2 is miniflare. Also the container's resend-on-5xx behaviour, which is read from `render/src/api.ts`, not executed.
3. **Real Queues:** at-least-once redelivery, `retry({ delaySeconds })`, batch sizes, no DLQ. The pool test drives `worker.queue()` by hand.
4. **Cron triggers** actually firing every 15 min, with the real wall clock. `cronTick` mirrors `scheduled()`'s order at an explicit `now`.
5. **Real concurrency.** The pool is one isolate, so concurrency is interleaving at awaits. On staging, D1's cross-isolate serialization and clock skew between isolates apply.
6. **The edge:** `Content-Length` normalization (the payment route's zero-length body), and the fake printer reached over HTTPS rather than in-process.
7. **Resend's** real 24-hour Idempotency-Key dedupe.
8. **The design diff** of the slice pages (PLAN §7).

## Findings

1. **The legal gate and consent are absent** from the CF checkout. PLAN §3.1's CP2 slice lists "legal gate + acceptance"; the CP2 exit row says "(legal gate, consent, pickup)". Neither the seller's platform-terms acceptance gate (Firebase's HARD checkout gate) nor buyer consent fields exist: no input key, no table, no test. This needs its own work item before CP2 can close.
2. **The webhook does not nudge the outbox.** A paid order's dispatch and confirmation therefore wait for the next 15-minute sweep. That meets the 30-minute SLA, but a paid POD order reaches the printer up to 15 minutes late. (CP2-B already flagged this.) The slice delivers the nudges explicitly.
3. **`POST /v1/admin/orders/:id/refunds` has no client idempotency.** The operation id is minted by the server. If an admin retries after a lost response (a network error, a double-click), a **second real refund** is made whenever the remainder allows it. Reserve-first prevents over-refunding, not duplicate partial refunds. Suggestion: accept an `Idempotency-Key` header and derive the operation id from it with a hash of tenant and key (a unique index).
4. **No read routes for orders or alerts yet**, so the staging reconciliation needs a D1 export through the preflight for the order ↔ intent pairs and the open alerts. A `GET /v1/platform/alerts` (CP3) would remove one of the two.
5. **A dispatch resolved as failed stays "stranded".** `DISPATCH_SETTLED = done|superseded`, so after an operator resolves a dispatch as `failed`, every reconciliation re-raises `dispatch_stranded_30m` once the previous alert is resolved (CP2-B raised this too). It is arguably correct while the paid order is neither produced nor refunded; it needs a decision.
6. **The digest step uses the wall clock** (`createAlertDigestEmailJob` checks `createdAt ≤ Date.now() + 5 min`), while `runAlertDigest` takes `now`. This is harmless in production. In a test it forces pinning `Date.now` (done in `cronTick`).

## Seams for the reviewer (optional; the suites pass without them)

- **`src/outbox/scheduled.ts` (2 lines).** Let `handleScheduled` take the clock, so the suites call the real tick instead of `cronTick`'s mirror of its order:
  ```ts
  export async function handleScheduled(controller: Pick<ScheduledController, "cron" | "scheduledTime">, env: Env, now: () => number = () => Date.now()): Promise<void> {
  ```
  Then delete `const now = () => Date.now();`.
- **`test/money-fixtures.ts` (test-only, no `src/**` change).** Move `FakeFeeStripe` out of `test/money-followups.test.ts` (it cannot be imported from a test file without registering its tests) and export it. Failure test 4c ("…cover the charge…") could then add `runReconciliation` + `assertLedgerBalanced(…, { stripe })` and assert the D36 release end to end (payout −commission). The ledger already reads `withholding_released_minor` and finds fee refunds by `metadata.withholding_release_id`.
