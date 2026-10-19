claude-opus-5-5

# CP11 — U12: provider registry + Prodigi printer adapter

Built in the worktree `cp11-prodigi` (HEAD `80757401` + this unit's working tree). No git write, no network, no wrangler, no deploy. No key appears anywhere: the tests use made-up keys shaped like Prodigi's (`test_only-not-a-real-prodigi-key-0000`, `live-only-not-a-real-prodigi-key-0000`).

Two coordinator corrections came in during the build, and both are built: (1) Prodigi `outcome` values are compared without regard to case, and `onHold` counts as accepted; (2) a Prodigi SKU key is `<prodigiSku>.<colour-slug>.<size>`, and the body builder splits it into `sku` + `attributes: { color, size }`. A key that does not split is `rejected` `sku_invalid`. I checked the split against U4's saved product sample: Prodigi's own attribute values are lower case (`size: "2xl"`, `color: "heather navy"`), so the split values go to Prodigi exactly as Prodigi lists them.

## Gate (run, final tree)

- `cd cloudflare && npx tsc --noEmit` → clean (no output).
- `cd cloudflare && npx vitest run` → ` Test Files  140 passed (140)` / `      Tests  5078 passed (5078)`.
- `node guard/guards.test.mjs` (repo root) → `guard: PASS` (2583 tracked files). My new files are untracked, so the guard does not scan them. I grepped them by hand for its two patterns: no match.
- `DISPATCH_TARGET` is read nowhere in `cloudflare/src/`. It appears only in comments that say it is retired. `env.d.ts` no longer types it, but the generated `worker-configuration.d.ts` still does until the var leaves `wrangler.jsonc`.

## Files changed

Mine per the brief:
- `cloudflare/migrations/0057_printer_provider.sql` (new)
- `cloudflare/src/dispatch/printer-client.ts`: the `PrinterJob` reshape (D5), `PrinterClient.unit`, `MULTI_LINE_JOB`, the registry `resolveProviderClient(env, provider)` + `configuredProviders(env)`; the SnapWear gate loses its DISPATCH_TARGET condition.
- `cloudflare/src/dispatch/prodigi-client.ts` (new): the gate `prodigiSubmitConfig`, `createProdigiClient`, `PRODIGI_FETCH_OVERRIDE`.
- `cloudflare/src/dispatch/prodigi-wire.ts` (new): `toProdigiOrderBody`, `prodigiRecipient`, `splitProdigiSkuKey`, `classifyProdigiResponse`, `prodigiRejectionCode`, `prodigiOrderId`.
- `cloudflare/src/dispatch/dispatch-effect.ts`: provider routing, the order unit (D4) and the shared tail.
- `cloudflare/src/dispatch/fake-printer.ts`: the gate (D2).
- `cloudflare/src/pod/printers.ts`: `PRINTER_PROVIDERS`, `providerAllowedIn`, `printerEnvironmentOf`, the per-row `printersAllowedIn`, and `provider` in parse / PUT / PATCH / view / editPrinter.
- `cloudflare/src/pod/printer-catalog.ts`: `applyCatalog(…, environment)`.
- `cloudflare/src/pod/pod-mappings.ts`: the D3 refusal (`ProductionPolicy`), and `provider` on `ProductionLine`.
- `cloudflare/src/commerce/checkout.ts`: `SNAPSHOT_PRINTERS` is gone, `printerEnvironment` option, and the snapshot freezes `provider`.
- `cloudflare/src/routes/fake-printer.ts`: comment only.
- `cloudflare/src/env.d.ts`, `cloudflare/test/env.d.ts`: PRODIGI_* added, DISPATCH_TARGET typing removed.
- `scripts/cf-port/seed-staging-slice.mjs`: `provider: "fake"` in the printer document (the PUT now requires it for `api`).
- Tests: `test/prodigi-client.test.ts` (new), `test/dispatch-order-unit.test.ts` (new); updated: `dispatch-fixtures.ts`, `dispatch.test.ts`, `fake-printer.test.ts`, `snapwear-client.test.ts`, `print-canvas.test.ts`, `pod-fixtures.ts`, `pod-mappings.test.ts`, `printers-platform.test.ts`, `printer-catalog.test.ts`, `print-defaults.test.ts`, `pod-publish.test.ts`, `checkout-no-code-golden.test.ts`, `checkout-stand-in-frames.test.ts`, `checkout-discount-holds.test.ts`, `print-canvas-snapshot.test.ts`, `stand-in-frames-seller-storefront.test.ts`, `money-followups.test.ts`.

Outside the brief's list. Each was necessary; the reasons are under "Deviations":
- `cloudflare/src/routes/pod-platform.ts`
- `cloudflare/src/outbox/sweeper.ts`
- `cloudflare/src/outbox/outbox.ts`
- `cloudflare/src/pod/print-canvas-jobs.ts`
- `cloudflare/src/dispatch/printer-transport.ts` (new)

Not touched: `src/app.ts`, `wrangler.jsonc`, `pinned.*.json`, `vitest.config.ts`, `guard/*`, U4's files.

## Decisions beyond D1–D7

1. **The snapshot freezes `provider`** beside `printer`. The dispatcher still resolves the client from the printer ROW (D1). But if the row's provider is no longer the frozen one, the job is terminal `printer_mismatch`: a printer re-pointed at another system after a sale never receives an order that was priced and validated for the first one. A snapshot made before CP11 has no `provider` and is judged by the row alone. This changes one expected value in `checkout-no-code-golden.test.ts` (the golden gains `"provider":"fake"`; every amount is unchanged, and I documented the edit in the test header) and the exact-shape assertion in `pod-publish.test.ts`.
2. **What the dispatcher does with the printer row:**
   - no row, or another tenant's, or a frozen provider that differs → terminal `printer_mismatch`;
   - a row of type `manual`, or a provider whose gate fails here → park, `printer_not_configured` (D2).
   - Order change: a snapshot with no readable printer is now terminal (`production_snapshot_missing` / `printer_mismatch`) even when no client exists. Before, the "no client" park came first. The printer can no longer be known without reading the snapshot.
3. **A sibling's problem never fails this row.** In the order unit, a sibling line with bad data, a failed canvas or a failed file check makes this row `retryLater` with `sibling_<code>`, never terminal. The sibling's own row fails that line with its own alert. Once the line is `failed` it is no longer carried, so the good lines go out without it. Without this rule, one bad line would fail every line of its order, which SnapWear's per-line model never did.
4. **Which lines a job carries** (D4.1): the row's own line, plus every sibling whose line is not `cancelled` or `failed` and whose row is not `superseded` or `failed` and is not flagged `cancel_requested`. `failed` is excluded as well as cancelled: a failed line belongs to its own row and to a human.
5. **The submitting guard has two conditions** (`orderSubmitGuard`, exported for tests): no OTHER dispatch row of the order is `submitting`, AND no line of the order is already `accepted` with a reference. The second closes the window between a row's reads and its move: if a sibling won the race, the row waits one backoff and then adopts, instead of making a redundant call. When the move is refused but the claim is still ours and no cancellation is pending → `retryLater(order_submitting)`.
6. **Waking siblings on acceptance:** the accepting batch also makes the order's other `pending`/`unknown` rows due now (never a payment-held row, never one flagged for cancellation), and nudges them after the commit. They adopt within seconds instead of waiting out a canvas or backoff hold.
7. **`duplicate` may carry `printerJobId`** (Prodigi's `AlreadyExists`, or an adoption). It is then recorded exactly like an acceptance: the reference on the lines, `result_ref` on the row, the siblings marked. A `duplicate` with no id behaves as before: own line accepted, reference null.
8. **Classifier details beyond D6:**
   - `onHold` → accepted (coordinator).
   - An unknown outcome on a 2xx → `unknown` `unexpected_outcome` (fail closed; the next attempt's `AlreadyExists` settles it).
   - `outcome` is required on a 2xx; without it → `unknown` `malformed_response`.
   - `order.id` must match `^ord_[A-Za-z0-9]{1,60}$`.
   - Rejection codes are cut down to the outbox code alphabet and at most 60 characters. `issues[].errorCode` is also read from `order.status.issues`.
   - **CreatedWithIssues is accepted** (D6): the order exists and the issues are Prodigi's to raise. Nothing reads the issues yet. U3's intake re-reads the order and can surface them.
9. **The callback URL** comes from `AUTH_BASE_URL` and must be https. If it is not, the gate fails. Condition 5 of the gate.
10. **The Prodigi refusals before any call:** `ship_to_missing` (no parcel address), `no_lines`, `sku_invalid` (a key that does not split).
11. **Printer ids `fake-printer` and `snapwear` stay reserved against MANUAL printers** (as before). An `api` printer may take any id, its provider decides.
12. **0057 adds a trigger pair:** a `manual` printer's provider is `manual`. The UPDATE trigger watches only `type, provider`, so a deactivation of a backfilled row never trips it.

## dispatch-effect.ts invariants touched, and why each still holds

The header lists them; numbering follows it.

- **The job is built only from frozen data.** Unchanged. The printer's provider is read from the printer row, which is routing, not job content. The provider frozen in the snapshot is compared, never trusted over the row.
- **Step 1, cancellation re-check after claiming.** Unchanged, and it still runs first. Cancellation (`cancellation.ts`, `refund-dispatch-stop.ts`) is whole-order, so every row of an order is flagged in one batch. An order-unit row can never carry a sibling that was cancelled before the build. A sibling cancelled after the build: this row has `cancel_requested` too, and its own accept batch inserts the `printer_cancellation`.
- **Step 2, validation failures are terminal.** Still true for the row's OWN line, with the same codes. Sibling problems retry instead (decision 3): a deliberate change, for the order unit only.
- **Step 2, a canvas not yet made parks the row.** Still the same park statement, fenced, applied only while an attempt remains and only while something in its scope is pending. Scope is the own line for line unit (byte-identical SQL) and the whole order for order unit (`orderCanvasPendingSql`). On release:
  - every canvas-settling batch still releases the line's row exactly as before;
  - it now ALSO releases every parked row of the order once nothing of the order is pending (`releaseOrderStatement`, same `when` fence);
  - the sweeper backstop now judges by the order.

  D1's single writer still guarantees that park and release cannot both miss. For SnapWear/fake rows the extra release only wakes rows whose own line has nothing pending, so it is never premature. One known cost: an order-unit row parked on a sibling can be woken once by its own line's release, re-parks, and that claim spends one attempt. That is bounded at one per line, and the test covers it.
- **The file sent under one job id never changes** (`decidePrintFiles` rule 2). For the order unit, "submitted" means ANY row of the order has `submitted_at`, because all rows share one printer order. Line unit is unchanged (`row.submitted_at`).
- **Step 3, claimed → submitting atomically refused on a cancellation.** Unchanged: `markSubmitting` keeps `cancel_requested = 0`. The order unit adds its guard in the SAME statement (an optional `guard` on `markSubmitting`). The line-state companion statements still run first under `existsGuard`.
- **Step 4, a stable job id.** Line unit: `{orderId}-{lineNo}` as before; the outbox payload's jobId is unchanged for every row. Order unit: `{orderId}` as the idempotency key (D5). Re-submission after a lost answer sends the same key, and `AlreadyExists` settles it.
- **accepted → done + line accepted; a cancellation that arrived during the call → `printer_cancellation` in the same batch.** Unchanged. The sibling-line update and the sibling wake are added to that same batch, under the same guard. The sibling update never overwrites a `cancelled` or `failed` line, or a different reference (0022 forbids changing one anyway).
- **rejected → failed + alert / superseded if cancelled / unknown after a lost answer (`afterLostAnswer`).** Unchanged. Siblings are untouched (D4.4); their own rows try, and adopt on `AlreadyExists`.
- **unknown → re-submitted after backoff; 30-minute alert.** Unchanged.
- **No client → park (`parkForPrinter`) / `holdUnknownForPrinter`; the sweeper releases once a client exists.** Same statements. The release is now per provider (`configuredProviders` + a join to the order's printer row in `sweeper.ts`). Without that, a production with Prodigi on would wake SnapWear-held rows every sweep, each wake spending an attempt, until they failed.
- **Every line-state write, alert and follow-up row in the batch of its transition, under its fence.** Holds for every new statement (sibling lines, sibling wake, canvas jobs of several lines).
- **The printer_cancellation effect is a human alert.** Unchanged and deliberate (D4.6). Prodigi's cancel answers `ActionNotAvailable` once the order is in production. A cancelled multi-line Prodigi order raises one alert per accepted line, each naming the same `ord_…`.

## Migration 0057 and its backfill

```sql
ALTER TABLE printers ADD COLUMN provider TEXT NOT NULL DEFAULT 'manual'
  CHECK (provider IN ('snapwear','prodigi','fake','manual'));
UPDATE printers SET provider = 'snapwear' WHERE id = 'snapwear' AND type = 'api';
UPDATE printers SET provider = 'fake'     WHERE id = 'fake-printer' AND type = 'api';
-- + triggers printers_manual_provider_insert / _update (manual ⇒ manual)
```

The staging backfill, reasoned from the migrations and scripts (no D1 was read):
- No migration inserts a printer.
- Staging's rows come from `seed-staging-slice.mjs` (`fake-printer`, api → **fake**) and from the Firebase import (D12/D59: one `snapwear` api row, inactive → **snapwear**).
- Manual rows were never seeded; if any exist they stay `manual`.
- Unknown api rows left `manual`: **none expected**. The old policy refused any api id other than the dispatch target, so none could have been written through the Worker.
- The two UPDATEs fire `catalog_version_printers_update`, which bumps the catalogue version of shops mapping to those printers: a cache refresh only.

## Exact env names (D7)

- `PRODIGI_SUBMIT_ENABLED` (var, exactly `"true"`)
- `PRODIGI_API_BASE_URL` (var, bare https origin)
- `PRODIGI_API_TOKEN` (secret)

Also read: `APP_ENV`, `AUTH_BASE_URL` (for `callbackUrl` = `AUTH_BASE_URL + /v1/webhooks/prodigi`). Test seam: the symbol `PRODIGI_FETCH_OVERRIDE`.

## Tests added

`test/prodigi-client.test.ts` (69 tests):
- **The gate:** both environments build it with the exact config, and the registry answers `unit: "order"`. `configuredProviders` lists Prodigi only when it is on.
- **31 refusals, each one condition:**
  - pairings crosswise: a live key on staging, the live host on staging, both; a `test_` key in production, the sandbox host in production, both;
  - a `TEST_` key, look-alike hosts each way;
  - APP_ENV missing, mis-cased or other;
  - five bad switch values;
  - eight bad origins;
  - six bad keys;
  - an http or missing `AUTH_BASE_URL`.
- A stale `DISPATCH_TARGET` changes nothing.
- **The wire:**
  - the exact JSON of a two-line order: lines 1 and 3, front/back assets, `attributes`, no `branding`/`email`/`metadata`/`stateOrCounty`;
  - the `x-api-key` header, `redirect: "manual"`, a signal;
  - the recipient's optional fields;
  - the SKU split, including the coordinator's round trip `GLOBAL-TEE-GIL-64000.heather-navy.2xl` → `GLOBAL-TEE-GIL-64000` / `heather navy` / `2xl`, and 8 bad keys;
  - `sku_invalid`, `ship_to_missing` and `no_lines` before any call;
  - a 307 is never followed;
  - the 30 s constant, and a `TimeoutError` → `unknown network`;
  - no key, host or asset URL in any result or log.
- **The classifier table (26 rows):** Created, created, CreatedWithIssues, onHold, AlreadyExists with and without an order, ValidationFailed on a 200, 400 with failures, 400 without a body, 422, 409, 401/403/404/408/429/500/503/302, a 200 that is not JSON, no outcome, no id, a numeric id, a non-`ord_` id, an over-long id, an unknown outcome. Also through the client, and the code-bounding rule.

`test/dispatch-order-unit.test.ts` (13 tests, the real outbox path, a fake Prodigi keyed on `idempotencyKey`):
- **Two-line order:** exactly ONE POST, items `1`/`2` with sku/copies/attributes, both lines `accepted` `ord_1186010`, the sibling woken and nudged, the second row done with no call and `submitted_at` null.
- The second line's row first: the same single order.
- **AlreadyExists adopts:** a lost answer, then the sibling's call gets AlreadyExists and marks both lines; the unknown row adopts with no call (2 POSTs total, same key).
- A cancelled and a failed sibling are left out of the body and keep their states.
- **A sibling's bad data:** this row waits (`sibling_print_slot_unsupported`), the sibling fails itself, then line 1 goes alone.
- `sku_invalid` and `ship_to_missing` through the dispatcher.
- **The SQL guard:** two rows claimed, one proceeds, the other is refused. The guard also refuses after an acceptance with a reference. Through the dispatcher, a submitting sibling → `order_submitting`, no call, then adoption.
- **Canvas:** row 1 ensures both lines' canvases and parks; the order-wide backstop does not wake it while line 2 pends; line 2's settle wakes it; ONE POST carrying canvas keys; row 2 adopts.
- **Per-provider holding:** with Prodigi on and the fake off, the sweep releases only the Prodigi-held row (`printerReleased: 1`) and the fake-held row keeps attempts 1.
- A printer re-pointed to another provider → `printer_mismatch`, no call.

Updated suites, reworded for D1–D3: the fake and SnapWear gates lose their DISPATCH_TARGET rows. A new fake test proves D5's `multi_line_job` before any call. Printer policy tests cover several api printers, Prodigi's own SKUs, fake not allowed in production, snapwear not allowed on staging, and `provider` being required/forced on parse. `printer_mismatch` cases now use a missing printer and a changed provider. `dispatch-fixtures.seedOrder` seeds the snapshot printer's row (provider `fake`/`snapwear`, or `printerProvider`) and can freeze `snapshotProvider`.

## Reviewer wiring

- `wrangler.jsonc` **staging** vars: `"PRODIGI_SUBMIT_ENABLED": "true"`, `"PRODIGI_API_BASE_URL": "https://api.sandbox.prodigi.com"`. **Production:** leave all three unset (the gate is off until go).
- **Secret** (staging): `wrangler secret put PRODIGI_API_TOKEN --env staging`, the `test_` sandbox key from HANDOVER's CP11 entry (the live key must never be set on staging; the gate refuses it anyway).
- **`DISPATCH_TARGET`:** the code reads it nowhere. Remove it from `wrangler.jsonc` (both envs), `pinned.*.json` and `scripts/cf-preflight.sh` when convenient; `vitest.config.ts` still binds it harmlessly. Then `wrangler types` regenerates `worker-configuration.d.ts` without it.
- **`src/app.ts`:**
  - line 105 `import { dispatchTargetOf }` → `import { printerEnvironmentOf }`;
  - line 1279 `dispatchTarget: dispatchTargetOf(env)` → `printerEnvironment: printerEnvironmentOf(env)`;
  - then delete the `dispatchTargetOf` alias in `printers.ts` and the deprecated `dispatchTarget` option in `checkout.ts`. Both exist only so app.ts compiles untouched.
- `REQUIRED_MIGRATION` (app.ts + its two tests) → `0057_printer_provider.sql`, after 0057 is applied to staging.
- **Platform data on staging:** create the Prodigi printer row with `PUT /v1/platform/printers`, `{ printerId: "prodigi", type: "api", provider: "prodigi", currency, … }`. Remember the PUT is replace-all, so list `fake-printer` too. Then store U4's catalogue and apply it.

## Deviations from the brief, with reasons

1. **`src/routes/pod-platform.ts`** carried one of the five literal unions (`target: "fake-printer" | "snapwear"`) and the call sites of `printersAllowedIn`/`editPrinter`/`applyCatalog`. D3 cannot be built without editing it. Only those lines changed; the surface is now dark only when APP_ENV is not `staging`/`production`.
2. **`src/outbox/sweeper.ts`:** `resolvePrinterClient(env)` no longer exists (a client is per provider now). A provider-blind release would re-wake held rows that still have no client and burn their attempts. The release now joins the order's printer row and passes only `configuredProviders(env)`.
3. **`src/outbox/outbox.ts`:** an optional `guard` on `markSubmitting`. D4.3 requires the condition to be in the claimed → submitting statement itself, and `transition` is private.
4. **`src/pod/print-canvas-jobs.ts`:** the brief's "reuse the existing park" was not enough. The settle release and the sweeper backstop judged by the LINE, so a row parked on a sibling's canvas would either never be released by the sibling's settle, or be released by the backstop every 15 minutes, spending an attempt each time (failing after ~2.5 h). Added `orderCanvasPendingSql`, `releaseOrderStatement` in both settle batches, and an order-wide backstop. I left the acquire-reap release line-scoped; the backstop catches an order-unit row there within one sweep.
5. **`src/dispatch/printer-transport.ts` (new):** the origin rule, the token rule, the timeout and the seam helper, shared by `printer-client.ts` and `prodigi-client.ts` without an import cycle.
6. **app.ts compatibility aliases** (see Reviewer wiring), because app.ts is not this unit's.
7. **PATCH does not edit `provider`** (like `type`). A provider changes only through the replace-all PUT. The PATCH and the catalogue apply carry the row's provider into the policy check; the view shows it (platform-only).
8. **Test files touched beyond "those these touch":** `money-followups.test.ts` froze a snapshot naming `fake-printer` without a printer row, so it now seeds the row.

## Open questions

1. **The importer** (`scripts/cf-port/migrate/lib/transform-printers.mjs`) inserts the `snapwear` api row without `provider`. Run after 0057, that row would be `manual`: never dispatched, and parked with an alert. Add `provider: 'snapwear'` there (not my file).
2. **U3 (intake):** one `ord_…` maps to SEVERAL lines (`printer_job_ref` is shared by the order's carried lines). The intake must update every line with that reference, and `production-status.ts`'s per-job (`{orderId}-{lineNo}`) entry point may need an order-level loop.
3. **Multi-lab orders and partial lines.** A line left out (failed or cancelled) means the Prodigi order is missing it. Placing it later needs a second Prodigi order, but the idempotency key `orderId` would answer AlreadyExists. Today a human handles it (the failed line's alert). If Prodigi binds the key on a `ValidationFailed` answer too, a rejected first submission would block the rest of the order. Worth one sandbox check by U5.
4. **The 0057 trigger allows `api` + `manual`** (the backfill's "unknown api row"). If the reviewer prefers, a later migration can forbid it once staging and production are confirmed clean.

## Review fix F2 (after the coordinator's read)

`isDispatchableSibling` used to carry a sibling whose line was `accepted` with NO printer reference. That is a line a human resolved by hand (`resolution.ts`), and carrying it would have sent it to Prodigi a second time. Siblings are now carried by allowlist: the line's `dispatch_state` must be NULL, `pending` or `unknown` (a lost answer under the same idempotency key is the same Prodigi order). The row-status and `cancel_requested` exclusions stay as they were.

Never carried:
- `accepted` of any kind (one with a reference is adopted, not carried);
- `failed`;
- `cancelled`;
- `submitting`.

Since the accepting batch only updates carried siblings, a hand-placed line keeps its state, its `dispatched_at` and its NULL reference.

New test in `test/dispatch-order-unit.test.ts`: "a sibling accepted WITHOUT a reference (placed by hand) is left out of the body and untouched by the accepting batch".

Re-run after the fix:
- `npx tsc --noEmit` → clean.
- `npx vitest run test/prodigi-client.test.ts test/dispatch-order-unit.test.ts test/dispatch.test.ts` → `Test Files  3 passed (3)`, `Tests  137 passed (137)`.

`app.ts` and the two compatibility aliases were not touched; the coordinator is removing them.

## Codex round 1 (on e6650207)

All three fixes are in `src/dispatch/dispatch-effect.ts`. The Prodigi files (`prodigi-wire.ts`, `prodigi-client.ts`) and `app.ts` are unchanged; `splitProdigiSkuKey` is imported from `prodigi-wire.ts` as it was.

- **P1 — adoption.** A row now adopts a reference only when an order-wide submission recorded it (`isOrderWideReference`): another dispatch row of the order that is `done`, has a `result_ref`, and went to the printer (`submitted_at` set). A reference a human typed on one LINE (`resolution.ts`, on a row that never submitted) is neither adopted nor carried. The remaining lines then submit their own Prodigi order. `orderSubmitGuard`'s second condition now uses the same test on the dispatch rows instead of on the lines, so a hand-resolved line can no longer block the rest of the order forever. The `submitted_at` requirement is one step stricter than the review asked: it keeps out a FAILED row that a human resolved as done with a hand reference.
- **P2 — lost answer across siblings.** When an order-unit row is refused, `orderAnswerUncertain` checks the order after the call. If any other dispatch row of the order has `unknown_since` set, is `unknown`, or submitted without ending `done` with a reference, the refusal goes through `afterLostAnswer`. The row is then held `unknown` for a human, never `failed` ("never received"). With no lost answer anywhere in the order, a refusal fails exactly as before.
- **P3 — an invalid SKU key.** For a `prodigi` route (the route now carries `provider`), each carried line's key is checked with `splitProdigiSkuKey` during preparation. A bad key fails through `failPreparation`: terminal `sku_invalid` for its own row, `sibling_sku_invalid` (a wait) for the others. The client's own `sku_invalid` stays as the last resort.

Tests in `test/dispatch-order-unit.test.ts`:
- **P1:** a line resolved by hand with a reference is neither adopted nor carried, and line 1 submits its own order.
- **P1:** the guard is free with a hand reference on a line, and blocked once a submitted sibling row is done with `ord_77` (this replaces the previous line-based guard test).
- **P2:** A's answer is lost and B's 400 is then held `unknown` (`unknown_rejected_after_unknown_items_1_.sku`), with no `dispatch_failed`.
- **P2:** with no lost answer, a 400 still fails (`rejected_items_0_.sku`).
- **P3:** valid line 1 with invalid line 2: row 1 waits `sibling_sku_invalid`, row 2 fails `sku_invalid`, then row 1 submits line 1 alone.
- The earlier single-line `sku_invalid` case now expects `last_error: "sku_invalid"` (judged in preparation) instead of `rejected_sku_invalid`.

Gate:
- `npx tsc --noEmit` → clean.
- `npx vitest run test/dispatch-order-unit.test.ts test/dispatch.test.ts test/prodigi-client.test.ts` → `Test Files  3 passed (3)`, `Tests  141 passed (141)`.
- Whole `npx vitest run` → `Test Files  140 passed (140)`, `Tests  5083 passed (5083)`.
