# CP2-B report — outbox with claims, dispatch, cancellation

Branch `cf-port`, worker in `cloudflare/`. Nothing committed, nothing deployed, no `wrangler` command reached Cloudflare (only the local `wrangler types --check` inside `npm run check`), no state-changing git command. CP2-A and CP2-C worked in the same tree at the same time; none of their files was edited.

## Counts

| | Tests | Files |
|---|---|---|
| Baseline at start (`npm run check`) | 1257 | 34 |
| Final full run (includes CP2-A's and CP2-C's additions) | **1584** | **45** |
| CP2-B's own additions | **+96** | **+3** |

CP2-B's tests by file:

| File | Tests | Covers |
|---|---|---|
| `test/outbox.test.ts` (new) | 43 | claims, transitions, fence, schema, consumer, sweeper, `scheduled()` |
| `test/dispatch.test.ts` (new) | 40 | dispatch effect, failure injection, the four cancellation paths, platform list and resolution |
| `test/outbox-email.test.ts` (new) | 12 | order-confirmation effect, template, email ledger |
| `test/email-queue-consumer.test.ts` | 41 → 42 | `-outbox` now routes to its consumer, not "held" |

`test/dispatch-fixtures.ts` is a new helper; it is not a test file.

Last `npm run check` tail (types:check ✓, tsc ✓, vitest ✓):

```
 Test Files  45 passed (45)
      Tests  1583 passed (1583)
   Start at  01:52:13
   Duration  60.09s
```

A rerun straight afterwards showed 1584/45, green; one of the other builders had added a test in between.

While the other builders were mid-edit, `tsc` was briefly red in their files: first `test/pod-mappings.test.ts:136` (CP2-C), then `src/commerce/admin-orders.ts:130` (CP2-A). Both were fixed by the final run.

**Other checks:**
- `node --test guard/guards.test.mjs` passes.
- The forbidden-string scan (the four forbidden legacy-brand patterns (see guard/guards.test.mjs), `firebase`) over every file below is clean.

**Mutation checks: 16 of 16 killed.** Each mutation was applied, the relevant suite run, and the source restored byte-identical (hash-checked). Killed:
1. A claim ignoring `max_attempts`.
2. The fence ignoring expiry.
3. The fence ignoring the token.
4. No `cancel_requested` re-check at claimed → submitting.
5. Newest-first claiming.
6. No supersede before the claim.
7. No `printer_cancellation` when a completion arrives after a cancel.
8. Cancellation after a submit superseding blindly.
9. The cancel's order update without the production guard.
10. An exhausted in-flight row always becoming `failed`.
11. A random email delivery id.
12. `unknown` rows re-submitted automatically despite a cancel.
13. A printer `duplicate` treated like `unknown`.
14. The print-file sha256 not checked.
15. The resolution's move ignoring the state the operator saw.
16. The resolution's audit row ignoring that state.

Mutations 15 and 16 first survived. That led to the injected-race test "a row that moves between the operator's read and the write is refused whole".

## Files

**New:**
- `migrations/0021_outbox_claims.sql`
- `migrations/0022_dispatch_state.sql`
- `src/outbox/outbox.ts` (the core)
- `src/outbox/nudge.ts`
- `src/outbox/consumer.ts`
- `src/outbox/effects.ts`
- `src/outbox/email-effect.ts`
- `src/outbox/sweeper.ts`
- `src/outbox/scheduled.ts`
- `src/dispatch/dispatch-effect.ts`
- `src/dispatch/cancellation.ts`
- `src/dispatch/resolution.ts`
- `src/routes/dispatch-admin.ts`
- `src/routes/dispatch-platform.ts`
- the four test files above

**Changed:**
- `src/queues.ts`: routes `-outbox` to the consumer.
- `src/index.ts`: `scheduled()` export.
- `src/email/auth-email-job.ts`: the `order_confirmation` kind.
- `src/email/email-queue-consumer.ts`: comment only. The consumer sends order confirmations unchanged.
- `src/app.ts`: my imports plus the `CP2-ROUTES-B` block only; `REQUIRED_MIGRATION` is untouched.
- `test/email-queue-consumer.test.ts`: the routing table.

**Unchanged:** `fake-printer.ts`, `printer-client.ts`, `snapwear-wire.ts`, `routes/fake-printer.ts`, `vitest.config.ts`, `env.d.ts`. None needed a change.

## State machine (`outbox_events.status`, 0021)

| From | To | By | Condition |
|---|---|---|---|
| — | `pending` | CP2-A webhook (order batch), cancellation (`printer_cancellation` row) | the insert |
| `pending` | `claimed` | `claimNext` / `claimById` | due (`next_attempt_at <= now`), no live claim, `attempts < max_attempts`, known type. **One `UPDATE … RETURNING`**, oldest first. Sets a fresh `claimed_by` token, `claim_expires_at = now + 5 min`, `attempts + 1`. |
| `unknown` | `claimed` | same | due, `cancel_requested = 0`, attempts left (the automatic re-submit) |
| `claimed` / `submitting` | `claimed` | same | **claim expired** (the worker died). `submitted_at` is kept. |
| `claimed` | `submitting` | `markSubmitting` | fence + `status = 'claimed'` + **`cancel_requested = 0`**: the §2.3 re-check "before the HTTP call", atomic with the move. Sets `submitted_at` once. |
| `claimed` / `submitting` | `done` | `complete` | fence; `result_ref` = printer id / email delivery id |
| `claimed` / `submitting` | `pending` | `fail` (retryable) | fence; `next_attempt_at = now + 1,2,4… min (cap 1 h)` |
| `claimed` / `submitting` | `failed` | `fail` (terminal, or `attempts >= max_attempts`) | fence; an alert is written in the same batch |
| `claimed` / `submitting` | `unknown` | `markUnknown` | fence; `unknown_since` is set once |
| `claimed` / `submitting` | `superseded` | `supersede` | fence (cancellation seen by the consumer) |
| `pending` (never submitted) | `superseded` | cancellation route | in the cancel's own batch (path 1) |
| `claimed` / `submitting` (claim expired, attempts exhausted) | `failed` / `unknown` | sweeper | `failed` if `submitted_at IS NULL`, else `unknown` (it may have reached the receiver). Alerts. |
| `unknown` | `done` / `failed` | platform resolution | the row is still as the operator saw it |
| `failed` | `done` | platform resolution | "the printer did take it" |

**The fence** is `claimed_by = token AND claim_expires_at > now AND status IN ('claimed','submitting')` on every transition. A stale worker's late result changes nothing: tested for all five transitions after an expiry, and after a re-claim. Statements committed *with* a transition — the order line's state, alerts, the `printer_cancellation` row — get the same guard and run first in the same batch.

**Schema guarantees (triggers):**
- An edge allowlist.
- `done` and `superseded` are frozen.
- Identity is immutable: id, type, aggregate, `dedupe_key`, payload, `max_attempts`, `created_at`.
- One-way facts: `submitted_at` and `unknown_since` are never changed once set; `cancel_requested` never goes 1 → 0; `attempts` never decreases.
- CHECKs: a claim exists **exactly** while the row is claimed or submitting; terminal ⇔ `resolved_at`; `submitting` ⇒ `submitted_at`; `unknown` ⇒ `unknown_since`.
- `last_error` is a code (`[A-Za-z0-9_.:-]{1,100}`).

## Schema

**0021 — `outbox_events` recreated under the same name.** A CHECK cannot be ALTERed, and nothing references the table by foreign key.
- **Every 0001 column is kept by name:** `status` (not `state`), `next_attempt_at`, `attempts`, `max_attempts`, `dedupe_key UNIQUE`, `last_error`.
- **Added:** `claimed_by`, `claim_expires_at`, `cancel_requested INTEGER NOT NULL DEFAULT 0`, `result_ref`, and two more:
  - `submitted_at`: "may have reached the receiver". This separates a safe supersede from a human cancellation.
  - `unknown_since`: the start of the 30-minute clock.
- The retired `lease_token` / `lease_until` are kept but pinned NULL, so a claim has one source of truth.
- **Old-row map:** processing → claimed (lease → claim), sent → done, skipped → superseded. Terminal rows get `resolved_at = COALESCE(resolved_at, updated_at)`; a non-code `last_error` becomes `legacy_error`. This was verified in sqlite against hand-inserted 0001 rows; no environment holds any rows.
- `event_type` is pattern-checked (`[a-z0-9_.]`), not enum-checked, because `platform-foundation.test.ts` inserts `tenant.created`.
- **Indexes:**
  - due: `(status, next_attempt_at)`
  - claim: `(status, claim_expires_at)`
  - aggregate
  - `(tenant_id, created_at DESC)`
  - `(event_type, status, created_at, outbox_id)` for the platform list
- **Timestamps stay INTEGER ms** (0001's convention).

**0022**, all additive:
- `order_items`:
  - `dispatch_state`, one of `pending|submitting|accepted|unknown|failed|cancelled`. NULL means "no dispatch recorded yet". The webhook does not know the column, and the dispatcher writes `submitting` at the first call.
  - `printer_job_ref`
  - `dispatched_at` (ISO)
  - `production_state`, one of `in_production|produced|shipped`, set later by a platform route
  - a one-way trigger
  - index `(tenant_id, dispatch_state, order_id)`
- `orders`: `cancelled_at` (ISO) and `cancel_reason` (1–500 characters), write-once and set together (trigger).
- `email_deliveries` recreated: identical shape, rows, triggers and indexes, with `kind` also admitting `order_confirmation`.

## Delivery: queue nudge + sweeper + cron

- **`nudgeOutbox(env, outboxIds)`** (`src/outbox/nudge.ts`) sends `{ outboxId }` per row through `sendBatch` (chunks of 100) and **never throws**. The sweeper is the backstop.
  - **CP2-A's webhook does not call it** (grep: no call). Its dispatch and email rows are therefore picked up by the 15-minute sweep, which meets the §2.2 30-minute SLA.
  - For prompt dispatch, A (or the reviewer) should add `await nudgeOutbox(env, [ids…])` after the order batch commits.
- **The `-outbox` consumer** (`src/outbox/consumer.ts`), per message:

  | Case | Action |
  |---|---|
  | malformed | ack (body never logged) |
  | row missing or settled | ack |
  | live claim elsewhere, or not due | `retry(delaySeconds)` until it could be claimed (≤ 12 h) |
  | claimed and run | outcome `retry` / `unknown` with auto re-submit → `retry(delay)`; otherwise ack |
  | the run threw | `retry(30 s)` |

  A duplicate delivery never runs the effect twice: the claim is atomic.
- **The sweeper, `runOutboxSweep(env, now)`** (`src/outbox/sweeper.ts`), in order:
  1. Settles claims that expired on their last attempt.
  2. Drains up to 10 due rows inline, which keeps work moving when the queue is down.
  3. Nudges the rest that are due (up to 500).
  4. Raises `dispatch_unknown_30m` once per dispatch that has been unknown for 30 minutes or more.
  5. **Re-nudges the render container** for a render job `queued` for over 5 minutes or on an expired lease. This is CP1-D open question 4. It uses the existing `nudgeRenderJob`; `render-jobs-queue.ts` is untouched.
- **`scheduled()`** (`src/index.ts` → `src/outbox/scheduled.ts`) routes on `controller.cron`:
  - `*/15 * * * *`: the outbox sweep, **then** CP2-A's `runReconciliation`, **then** `runRetentionSweep`. A's module is loaded by a guarded `import("../commerce/crons")`; it landed during this build and is wired (tested).
  - Each step is isolated; if any failed, the invocation rejects after all have run.
  - Any other cron is logged and ignored.

### Block for `wrangler.jsonc` (not my file). Add inside **both** `env.staging` and `env.production`:

```jsonc
      // PLAN §2.2/§2.3: outbox sweeper + reconciliation + retention, every 15 min
      // (src/outbox/scheduled.ts routes on this exact expression).
      "triggers": { "crons": ["*/15 * * * *"] },
```

The `-outbox` queue consumers already exist in both environments. After adding the block, run `npm run types`. The preflight should pin the cron list.

## Effects

**`dispatch`** (`src/dispatch/dispatch-effect.ts`). The job is built only from `order_items.production_json` (the line at `item_index = lineNo − 1`) and `orders.production_snapshot_json`. The `jobId` is `{orderId}-{lineNo}`, and the payload's `jobId`, `orderId`, `lineNo` and the row's `aggregate_id` must agree.

Refused before any printer call, each terminal with a `dispatch_failed` alert and line `failed`:

| Code | Cause |
|---|---|
| `printer_mismatch` | `snapshot.printer ≠ DISPATCH_TARGET` |
| `production_snapshot_missing` | no snapshot |
| `print_slot_unsupported` | a slot other than front or back |
| `production_line_invalid` | a key outside `pod/{tenant}/` or with `..`; bad quantity or SKU shape; more than two files |
| `print_file_missing` | the private-bucket HEAD finds nothing |
| `print_file_mismatch` | the stored sha256 ≠ the snapshot's |
| `print_file_unverified` | no stored checksum |

No usable printer client (unset `DISPATCH_TARGET`, or the fake without its gate) **holds**: retry with backoff, and an alert after 10 attempts. It is checked before building, so a misconfigured environment never judges the order.

Artwork URLs are presigned private-bucket GETs with a **7-day** TTL (see question 3). Front is sent before back.

Printer results:

| Result | Outbox | Line |
|---|---|---|
| `accepted` | `done`, `result_ref` = printer id | `accepted` + `printer_job_ref` + `dispatched_at` |
| `duplicate` | `done` | `accepted` |
| `rejected` | `failed` + `dispatch_failed` alert (`superseded` if a cancel arrived) | `failed` (`cancelled`) |
| `unknown` | `unknown`, re-submitted after backoff with the same id; duplicate ⇒ done | `unknown` |

The SnapWear stub throwing gives a retry with the line back to `pending`: it never pretends to submit.

**`email`** (`src/outbox/email-effect.ts`) builds an `order_confirmation` job for `EMAIL_QUEUE`:
- recipient: `orders.customer_email`
- content: from `orders`, `order_items` and `tenants.shop_name`
- `deliveryId`: **derived from the dedupe key** (a v4-shaped SHA-256)
- `createdAt`: the outbox row's
- `expiresAt`: `createdAt + 24 h`

It records the ledger row, then enqueues. The job is identical on every retry, so the ledger plus Resend's Idempotency-Key send it **once**. This is tested with a crash between enqueue and commit: two identical jobs, one Resend call.

The Swedish template shows the order number, lines (`2 st …`), Delsumma, Frakt or Upphämtning, Rabatt, Totalt, "varav moms", and "Leverans till Sverige" or "Upphämtning i butiken". Names are HTML-escaped.

The job carries no link (`actionUrl: ""`): the receipt token is stored only hashed.

Failure handling:
- An effect that could not run within the 24-hour window fails with an `outbox_failed` alert rather than mail late.
- A missing queue retries.

**`printer_cancellation`** raises the human-action alert `printer_cancellation_needed` once (deterministic id) and goes `done`. `result_ref` is the alert id. Neither SnapWear nor the fake has a cancellation API.

## Cancellation vs dispatch (§2.3): the four paths and where each is tested

`POST /v1/admin/orders/:orderId/cancel`: tenant admin (membership or acting-as), same-origin, `X-Shop-Id`.

Request body:

```json
{ "reason": "Kunden ångrade sig" }
```

- 1–500 characters, trimmed, no control characters.
- Only the `reason` key is allowed; anything else is a 400.

`200` response:

```json
{ "cancellation": { "orderId": "…", "cancelledAt": "2026-09-27T01:40:00.000Z", "reason": "…",
    "lines": [ { "lineNo": 1, "jobId": "{orderId}-1",
                 "outcome": "cancelled|cancel_requested|printer_cancellation|awaiting_resolution|not_at_printer" } ] } }
```

Other answers:
- `409 {"error":{"code":"return_case","message":"The order has been produced; handle it as a return"}}`
- `400 invalid_request`
- the opaque `404` for everything else: another shop, no session, cross-origin, GET, a bad id.

The route is idempotent: a repeat returns the recorded cancellation, and the audit event is written once.

| Path | Behaviour | Tests (`test/dispatch.test.ts`, describe "cancellation vs dispatch") |
|---|---|---|
| **1. before claim** | `superseded` **in the cancel's own batch**, line `cancelled`, **zero printer jobs** | "PATH 1 — before claim…", "is idempotent…" |
| **2. while claimed / submitting** | `cancel_requested = 1`; the consumer re-checks after claiming and atomically at `markSubmitting`. Call already out → accepted/duplicate ⇒ `printer_cancellation` row **in the completing batch**; rejected ⇒ superseded; died mid-submit ⇒ `unknown` + `dispatch_cancel_unconfirmed`, never re-submitted | "PATH 2a — while claimed, before the call" (zero jobs), "PATH 2b — … the call already out", "PATH 2c — … the printer rejects", "PATH 2d — a worker died mid-submit…", "PATH 2e — cancelled while the printer's answer is unknown…" |
| **3. after acceptance** | `printer_cancellation` outbox row → `printer_cancellation_needed` alert, exactly once | "PATH 3 — after acceptance…" |
| **4. after production** | `order_items.production_state` ∈ produced/shipped, or order status printed/shipped/ready_for_pickup/delivered/completed → **409 `return_case`**, nothing written | "PATH 4 — after production…", "PATH 4 — an order already shipped…" |

**How it is built.** Every statement is conditioned on the current state and on a "not produced" guard (`dispatchCancellationStatements`, exported), so:
- a production mark that races the cancel cannot be overridden;
- the set can run inside any batch. **CP2-A's full refund can include it to stop production atomically.**

**Cancelling moves no money.** The refund is CP2-A's separate call (`POST …/refunds`). The route does not change `orders.status`, whose refund transitions are CP2-A's; it records `orders.cancelled_at` / `cancel_reason` and the `order.cancel` audit event instead. The confirmation email row is not touched.

## Manual resolution and the platform list

`GET /v1/platform/dispatch?state=unknown|failed[&limit=1..100][&cursor=…]`
- Platform principal. GET only; no same-origin requirement, as for admin GETs.
- Unknown query keys are a 400.

`200`:

```json
{ "dispatches": [ { "outboxId": "…", "tenantId": "…", "orderId": "…", "lineNo": 1, "jobId": "…-1",
    "state": "unknown", "attempts": 1, "maxAttempts": 10, "lastError": "unknown_network",
    "cancelRequested": false, "submittedAt": "…Z", "unknownSince": "…Z", "resolvedAt": null,
    "printerJobRef": null, "createdAt": "…Z", "updatedAt": "…Z" } ],
  "nextCursor": "1790000000000~<outboxId>" }
```

The response is paged by a `(created_at, outbox_id)` cursor.

`POST /v1/platform/dispatch/:outboxId/resolve`: platform principal, same-origin. Request body:

```json
{ "outcome": "accepted", "printerJobRef": "SW-4711", "note": "Found in the SnapWear dashboard" }
```

- `note` is 1–1000 characters.
- `printerJobRef` is allowed only with `accepted`.
- Unknown keys are a 400.

Answers:
- `200 { "dispatch": <same view> }`
- `409 {"error":{"code":"conflict","message":"The dispatch is not awaiting resolution"}}`
- `404`: not a dispatch row, unknown id, not a platform user, or cross-origin.

**Resolvable rows:**
- `unknown`: `accepted` → `done`; `failed` → `failed`.
- `failed`: `accepted` → `done`; `failed` acknowledges the failure (`last_error = 'resolved_failed'`, alerts closed).

**One batch**, conditioned on the row still being as the operator read it (status, `cancel_requested`, `updated_at`):
- the move;
- the order line: `accepted` + ref, or `failed` / `cancelled`;
- a `printer_cancellation` if the order was cancelled and the answer is `accepted`;
- every open alert on the row resolved at `MAX(created_at, now)` (clock-skew safe);
- an **`audit_events` row `dispatch.resolve`**: actor = platform user, when, `reason` = note, metadata `{from, lastError, outcome, printerJobRef, orderId, lineNo, jobId}`.

A row moved by the automatic re-submit in between gets 409 and **nothing** is written (the injected-race test).

## Failure injection covered (CP2 gate items that are mine)

| Item | Tests |
|---|---|
| Duplicate dispatch delivery | 3 concurrent runs → 1 job; also duplicate nudges in the consumer suite |
| Lost printer response (`unknown`) → re-submit → fake `400 duplicate` → `done`, 1 job | item 6; `losingTransport` delivers, then drops the answer |
| Crash after the printer accepted, before the local commit | a dying-DB proxy → the sweeper re-claims the expired claim → duplicate → `done`, 1 job |
| Crash after the email was enqueued, before the commit | one email |
| Stale worker after a re-claim | rejected |
| `unknown` for 30 minutes | alert, then manual resolution with who/when |
| Cancel during `submitting` | paths 2b–2d |
| End to end | through a **real queue nudge** (the pool consumer) and through **`worker.scheduled()`** |

## For the other builders / the reviewer

1. **Reviewer:**
   - Add the `triggers.crons` block above.
   - Bump `REQUIRED_MIGRATION` in `src/app.ts` to the highest migration (0025 now); I did not touch it or the readiness tests.
2. **CP2-A:**
   - (a) Call `nudgeOutbox(env, [dispatchIds…, emailId])` after the order batch commits. Without it, dispatch waits up to 15 minutes.
   - (b) `crons.ts`'s `DISPATCH_SETTLED = ["done","superseded"]` makes the 15-minute net re-raise `dispatch_stranded_30m` after an operator resolves a dispatch as failed; `money-alerts.ts` re-raises once the open alert is resolved. Suggested: also treat `status='failed' AND last_error='resolved_failed'` as settled.
   - (c) A full refund that must stop production can put `dispatchCancellationStatements(db, { nowMs, orderId, tenantId })` in its own batch.
3. **Test pool:** `chopshop-test-outbox` has a pool consumer (unchanged config), so any suite that calls `nudgeOutbox` with the real env gets its effects run in the background. My suites inject recording queues (`quietEnv`), except the one deliberate end-to-end test.

## Open questions

1. **Order status on cancel.** `orders.status` stays `paid` after a cancel, to avoid colliding with CP2-A's refund state machine. Should cancel move it to `cancelled`, and in whose code?
2. **Print-file source.** Print files are read from the **private** bucket by the key in `production_json` (the render canonical `pod/{t}/print/…`). PLAN §2.5 puts order print masters in the **production** bucket (A5). Switch when A5 lands?
3. **Download URL TTL: 7 days** (R2's maximum), because SnapWear may fetch at print time (C4 open). Shorten once C4 is answered.
4. **Slots.** Only `front` and `back` are dispatched (the SnapWear `layouts[].location` set). Any other slot in a snapshot fails the line with an alert. Confirm with CP2-C that no other slot name can reach an order.
5. **Human action is an alert row only.** The `printer_cancellation` effect is not an email to ops (CP1-C question 5 still stands), and there is no route yet to mark a printer cancellation as carried out. The line then stays `accepted`, with the order's `cancelled_at` and the open alert telling the story.
6. **The confirmation email's retry window.** It is built with `createdAt` = the outbox row's creation, so an outage longer than about 24 hours fails it with an alert instead of mailing late. Acceptable, or should a late confirmation be re-issued under a new id?
7. **SnapWear stub in production.** Paid POD orders retry for about 4.5 hours, then fail with alerts, until A6 is built. That is fail-closed and loud.

---

## Codex fixes (on top of 9542636)

Both fixes are in, each with regression tests. `npm run check` is fully green: types:check ✓, tsc ✓, vitest **1604 tests / 45 files**. No git, no wrangler, and no CP2-A (`src/commerce/**`) or CP2-C file touched.

| File | Before | After |
|---|---|---|
| `test/outbox-email.test.ts` | 12 | 15 |
| `test/dispatch.test.ts` | 40 | 53 |

**Changed files:**
- `src/email/auth-email-job.ts`
- `src/email/email-delivery-store.ts`: only the fingerprint function and its import. This is where `fingerprintAuthEmailJob` lives; outside my original file list, but required by the fix.
- `src/dispatch/dispatch-effect.ts`
- `src/dispatch/resolution.ts`
- `test/outbox-email.test.ts`
- `test/dispatch.test.ts`

**Mutation checks: 5 of 5 killed**, sources restored byte-identical:
1. Exhaustion leaving the line `pending`.
2. An acknowledged failure skipping the line.
3. The fingerprint without the order.
4. The fingerprint missing the order number.
5. An `order` key added to auth-job fingerprints.

### [P2] The ledger fingerprint covers the order content
- `canonicalOrderContent(order)` (in `auth-email-job.ts`) lists every rendered field in a fixed key order: currency, delivery method and country, every line (name, quantity, line total), the order number, shop name and all five totals.
- `fingerprintAuthEmailJob` adds it under an `order` key **only for `order_confirmation` jobs**. For the auth kinds the key is absent, so their canonical string and fingerprint are byte-identical to before.

Tests (`describe "the ledger fingerprint covers the order content (Codex P2)"`):
- **Auth fingerprints unchanged.** Two auth jobs have golden fingerprints pinned; the values were computed with the pre-change algorithm and verified against the unchanged code before the fix.
- **Different content, different fingerprint.** Confirmations differing only in VAT, discount/total, a line name, the order number or the shop name all get distinct fingerprints; the same content is deterministic.
- **Tampering is refused.** A tampered copy (same delivery id, discount = total, total 0) is refused by `claimAuthEmailDelivery` as `{ status: "conflict" }`. Through the real `-email` consumer it is acked unsent, while the genuine copy is sent exactly once with the true total.

Both new behaviour tests failed on the unchanged code (the bug reproduced) and pass now.

### [P2] The line follows an exhausted dispatch row
`retryLater` now **always** carries the order line. All pre-submission exhaustion paths — `printer_not_configured`, `storage_not_configured`, `storage_error`, `presign_failed` — pass it, as does the call-time `printer_client_error`. The line update is one statement in the transition's own batch, under its fence:

```sql
dispatch_state = CASE
  WHEN (SELECT attempts >= max_attempts FROM outbox_events WHERE outbox_id = ?) THEN 'failed'
  WHEN dispatch_state = 'submitting' THEN 'pending'
  ELSE dispatch_state END
```

That is the same condition under which `fail()` makes the row `failed`, read from the same pre-transition row, so the row and the line cannot disagree.

`resolveDispatch` now updates the line on **every** resolution, including an acknowledged failure (failed → failed), which previously skipped it:
- `failed` → line `failed`. For an order whose cancellation was requested it is `cancelled`, the 0022 meaning of "never accepted and cancelled"; PATH 2d pins this.
- `accepted` → line `accepted` + `printer_job_ref`.

Tests (`describe "the line follows an exhausted row (Codex P2)"`):
- For each of the five paths: on the last attempt, the row goes `failed`, the line goes `failed`, one `dispatch_failed` alert is raised, and there are zero printer jobs. With attempts left, the row stays `pending` and the line is `pending` after a call, or untouched before one.
- The sweeper's settlement of an exhausted in-flight dispatch: `unknown` for both row and line if it may have been sent, `failed` for both if not.
- Resolving `failed` on an `unknown` row, and acknowledging a `failed` row whose line was left `pending`: both lines become `failed`.
- Resolving `accepted` gives the line `accepted` with the printer reference.

### Commit-boundary note
Commit 9542636 does not contain `src/routes/dispatch-admin.ts` or `src/routes/dispatch-platform.ts`; they are untracked in the tree. The `CP2-ROUTES-B` mounts in `src/app.ts` import them, so they must be committed with the reviewer's `app.ts` consolidation.

### [P2, follow-on to 4543f11] The confirmation is frozen at its first build
**The problem.** The fingerprint covers the rendered content, which includes the live `tenants.shop_name`, and `buildJob` reloaded it on every attempt. Suppose an attempt recorded the ledger row and then failed to enqueue, and the shop was renamed before the retry. The retry built a different job, the consumer answered `conflict` and never sent it, and the outbox row still went `done`. The confirmation was silently lost.

**The fix.**
- **`0022`** adds `outbox_events.frozen_json`: a JSON object of at most 64 KiB, write-once and never cleared (trigger `outbox_events_frozen_write_once`). It is additive only; nothing in 0021 changed.
- **`src/outbox/email-effect.ts`.** The first build writes `{ "confirmation": <order content> }` there **in one batch** with the ledger record and the move to `submitting`, all conditioned on the claim. Every retry reuses the frozen content, which the job constructor re-validates. A frozen row can therefore never produce a different fingerprint.
  - The recipient is **not** copied into the outbox row; it stays the order's own `customer_email`, which 0011 makes immutable.
  - Every other job field is already deterministic: delivery id from the dedupe key; `createdAt` and `expiresAt` from the row.
- **`src/email/email-delivery-store.ts`.** The new `prepareAuthEmailDeliveryRecord(db, job, now)` returns a synchronous builder for the ledger insert, optionally conditioned on a guard. The insert became `INSERT … SELECT … WHERE <guard | 1>`. `recordAuthEmailDelivery` behaves exactly as before; the ledger, consumer and password-reset suites are unchanged and green.
- **`src/outbox/outbox.ts`.** The row type and the claim's `RETURNING` include `frozen_json`.

**Tests** (`test/outbox-email.test.ts`, describe "a confirmation is frozen at its first build (Codex P2)"): 15 → **18**.
- **Record → rename the shop → retry.** The first attempt records the ledger row and the enqueue fails; the shop is renamed; the retry enqueues the job with the **original** name. The real `-email` consumer sends it **exactly once** with "Tack för din beställning hos Gamla Butiken!", and the ledger row ends `sent`. On the old code this test failed: the retry carried "Nya Butiken".
- **What is frozen.** Exactly `{ confirmation: job.order }`, written on the first build, and the recipient address is not in it.
- **Schema.** The column CHECK (non-object, non-JSON) and the write-once trigger (change, or clear to NULL).

**Mutation checks: 3 of 3 killed.** Sources restored byte-identical:
1. The retry ignoring the frozen content.
2. The first build never freezing.
3. The write-once trigger disabled.

**Check status.**
- `npm run check` was red **only in CP2-C's still-changing files**: tsc in `src/pod/pod-mappings.ts` and `src/catalog/admin-catalog.ts`, and one failing test in `test/screening.test.ts`. The full vitest run was 1606 of 1607.
- Run individually, my suites and the shared email suites are green: `outbox`, `dispatch`, `outbox-email`, `email-queue-consumer`, `email-delivery-store`, `password-reset`, `auth-email-job`, `fake-printer` — **246 tests / 8 files**.
- Excluding CP2-C's files, tsc is clean.
