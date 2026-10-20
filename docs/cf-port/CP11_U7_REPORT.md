claude-opus-5-5

# CP11 — U7: the Codex Prodigi audit, fix set (F2 F3 F4 F5 F6 F9 + the alert text)

Built in the worktree `cp12-wt` (branch `cp12-prints`, HEAD `ea89ab5e`). No git write, no network, no wrangler. No migration was needed (next stays **0058**). Nothing under `scripts/` and no catalogue JSON was touched (U8's).

## Gate (final tree)

- `npx tsc --noEmit` (API), `-p web`, `-p admin` → all clean.
- `npx vitest run` → `Test Files 142 passed (142)`, `Tests 5140 passed (5140)`. The baseline before U7 was 141 files and 5115 tests.
- `node guard/guards.test.mjs` → `guard: PASS`.
- Frontend:
  - `node --test` on `src/storefront/adapters/*.test.mjs` and `src/admin-app/adapters/*.test.mjs` → 510 pass, 0 fail.
  - The whole `src/**/*.test.mjs` run → 1048 pass, 5 fail. The 5 failing files are `content-dev`, `fpData`, `legal-signer`, `podLibraryLoad` and `shells`. Each fails with `ERR_MODULE_NOT_FOUND` (`@heroicons/react`, `react-hot-toast`) because this worktree has no root `node_modules`. None of them is a file I changed.
  - `node cloudflare/admin/check-admin-build.mjs` **cannot run here**, because `vite` is not installed at the root. The reviewer must run it, together with `cloudflare/web/check-storefront-build.mjs`.
  - The edited JSX parses: `esbuild` on `Checkout.jsx` and `Cart.jsx` is clean.

## Findings → change → proving test

**F2 (front required)**
- The capability model gained `requiredSlots?`. Each entry must be a slot the model frames.
- `requiredSlotsOf(provider, caps, sku)` reads it. With no list, Prodigi defaults to `["front"]` and every other provider to `[]`.
- Where the rule is enforced:
  - The publish gate refuses with the new code `pod_required_slot_missing` (it has a seller sentence and a Swedish admin message).
  - Checkout's line resolution refuses the line.
  - Dispatch preparation fails the line with `front_missing`; a sibling row waits with `sibling_front_missing`.
  - `toProdigiOrderBody` is the last guard: it now returns `{body}` or `{refusal: "sku_invalid" | "front_missing"}`.
- `buildFromCatalog` now carries a catalogue model's `requiredSlots`. Before this, the apply dropped it; U8's posters catalogue has `requiredSlots: ["front"]`.
- Tests:
  - `prodigi-presale-rules.test.ts` covers F2: publish refused; the audit's case (live back-only, then checkout) now refused; the override in both directions; the fake unchanged.
  - `prodigi-client.test.ts` covers the wire-level `front_missing`.
  - `dispatch-order-unit.test.ts` covers F2 in dispatch.

**F3 (pickup)**
- New rule `providerTakesCollectedOrders`:
  - Prodigi: false.
  - SnapWear: follows `SNAPWEAR_SUBMIT_WITHOUT_SHIP_TO`, which is false.
  - The fake: true.
- Checkout's line resolution refuses a pickup order when the line's printer cannot take one.
- The public product read answers `allowPickup = the seller's flag AND the printer rule`. The storefront already reads `allowPickup`, so it follows with no change of its own.
- Tests: `prodigi-presale-rules.test.ts` F3 (checkout, public read, the seller's flag untouched).

**F4 (destination)**
- The capability document gained a top-level `shipsTo?` (ISO 3166-1 alpha-2, upper case).
- `printerShipsTo` reads it. With no list, Prodigi defaults to `["SE"]` and every other provider to null (no restriction).
- Checkout's line resolution refuses any other country.
- A catalogue apply keeps the printer's current `shipsTo` unless the catalogue names its own.
- The public detail gained `shipsTo: string[] | null` (the countries only, never the printer).
- On the storefront:
  - the adapters put it in `delivery.shipsTo` (only when the API gives a list);
  - `Cart.jsx` adds `cartShipsTo`, the intersection over the cart's lines;
  - `Checkout.jsx` maps the same six `<option>`s from an array, filtered by `cartShipsTo`.
- Tests: `prodigi-presale-rules.test.ts` F4 (the audit's US/CA/AU/NZ/JP refused; the override; the public read); `adapters.test.mjs`; `recovery.test.mjs`.

**F5 (provider issues)**
- `createdWithIssues` → `accepted` + `issueCodes`. The dispatcher raises one critical `printer_order_issues` alert per code in the accepting batch.
- The intake raises the same kind of alert for:
  - each `status.issues[].errorCode`;
  - each `details_<step>_error`;
  - each item or asset in `Invalid` or `Error` (`item_<status>`, `asset_<status>`).
- No state changes. The alerts carry codes and ids only.
- Tests: `dispatch-order-unit.test.ts` F5 and `prodigi-intake.test.ts` F5.

**F6 (cancelled shipment)**
- A `Cancelled` shipment that lists the item raises `printer_order_cancelled` for that line.
- This check runs after the Shipped check and before the order-level stage and in-production checks.
- Test: `prodigi-intake.test.ts` F6 (the audit's case of two lines under an InProgress order).

**F9 (unreadable duplicate)**
- `alreadyExists` with no readable id → `unknown` `duplicate_unreadable`. SnapWear is untouched.
- Test: `dispatch-order-unit.test.ts` F9 (a re-submit with the same key settles it).

**Alert text**
- `printer_cancellation_needed` now says that SnapWear has no cancellation API and that Prodigi refuses a cancel once the order is in production.
- Test: `dispatch.test.ts` PATH 3.

**Error names added**
- `pod_required_slot_missing`
- `front_missing`
- `sibling_front_missing`
- `duplicate_unreadable`
- alert kind `printer_order_issues`

## Deviations, argued

1. **Pickup and destination refusals answer `invalid_items`** (the opaque 422), not a new `pickup_not_available_for_print`.
   - That is the existing vocabulary for "this basket cannot be delivered that way" (`quoteCarriage`).
   - The checkout header refuses to name which line fails, because that would be an oracle.
   - The storefront never offers the refused option, because the API now says so.
2. **The pickup rule is per provider, not "any `api` printer".**
   - The staging fake takes collected jobs, so it keeps doing so.
   - SnapWear now also refuses POD pickup. Its client already rejected those orders after payment with `ship_to_missing`, so this only moves the refusal before payment.
3. **One alert per (order, code), not one alert carrying every code.** This lets the dispatcher's and the intake's alerts share one dedupe.

## Reviewer wiring

None. No config, no secret, no migration. The reviewer should run `check-admin-build.mjs` and `check-storefront-build.mjs` with the root dependencies installed.

## Open questions

- A product already published back-only stays visible on the storefront, but checkout refuses it. The public predicate does not apply the required-slot rule. Only staging carries Prodigi.
- The tenant printer view does not expose `requiredSlots`, so the studio cannot warn before publish.
- The importer (`scripts/`) could emit the apparel `requiredSlots` and `shipsTo`. The defaults cover them in the meantime.
- `applyCatalog` reads the current `shipsTo` outside `editPrinter`'s revision fence. A concurrent PATCH in that window could be lost (minor).

## Codex round 1 (on ccf6babc): P2, a saved cart keeps its old delivery restriction

**The problem.** A cart persisted before U7 has no `delivery.shipsTo` and may still allow pickup. `reconcileCart` (`src/storefront/providers/Cart.jsx`) refreshed only price, label, image and variant id, so a returning buyer was offered pickup or countries that checkout now refuses.

**The fix.**
- Two pure helpers in `src/storefront/adapters/products.js`:
  - `cartDeliveryOf(product)` reads the restriction from either shape: the public read (`allowShipping` / `allowPickup` / `shipsTo`) or the page shape (`delivery`).
  - `sameDelivery(a, b)` compares two restrictions.
- `reconcileCart` now refreshes each surviving line's `delivery` from the fresh product. A change in delivery alone now counts as a change, so the cart is written and `cartAllowsPickup` / `cartShipsTo` recompute.
- `addToCart` uses the same helper.
- There is no reconcile notice for updated lines: only removed lines are toasted, as before.

**Tests.**
- `adapters.test.mjs` adds 2 tests: both shapes are read alike, and a pre-U7 line (pickup allowed, no `shipsTo`) differs from the live product.
- `node --test src/storefront/adapters/*.test.mjs` → 103 pass, 0 fail.
- `node cloudflare/web/check-storefront-build.mjs` was run with the main tree's `node_modules` symlinked in, and the link removed afterwards. Result: "storefront build: 11 files (7 text) checked, no Firebase code, every file servable."

Only `src/storefront/**` was touched. `cloudflare/web/dist` is gitignored.
