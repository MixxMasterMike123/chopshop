# Prodigi API and order-flow audit — 2026-10-19

Verdict: the v4 request format and basic dispatch path are aligned, but the full process is not ready for production. There are seven high-priority findings and two medium-priority findings below. No application code, deployed configuration, orders, or account settings were changed in this audit.

Reviewed local HEAD `37eb93cb` on `cf-port`. Read the [documentation landing page](https://www.prodigi.com/print-api/docs/) and the complete [v4 reference](https://www.prodigi.com/print-api/docs/reference/) before inspecting the implementation. Traced catalogue import → mapping/publication → checkout snapshot → Stripe success/order creation → render/dispatch → authenticated callback read-back → line/order fulfilment and cancellation. Saved sandbox responses were used as evidence; no new Prodigi order was placed.

Severity: P1 means address before production orders can exercise the affected path. P2 means correct the contract/defensive handling, although the ordinary saved sandbox responses work today.

## Findings

### F1 · P1 · A model-wide minimum canvas does not guarantee the intended physical print size

Locations: [catalogue modelFrame](../../scripts/cf-port/prodigi-catalog.mjs#L116), [canvas geometry](../../cloudflare/src/dispatch/print-canvas.ts#L245), [order sizing](../../cloudflare/src/dispatch/prodigi-wire.ts#L144).

The importer chooses the smallest print area across all Swedish variants of a model. The renderer places the motif at its selected millimetre width inside that full-frame canvas, and the adapter sends it with `fitPrintArea`. Prodigi's documented behaviour is to fit the supplied image into the selected product's print area; this does not promise to preserve the image's configured DPI or millimetre dimensions. See [image resizing](https://www.prodigi.com/print-api/docs/reference/#order-object-image-resizing).

Concrete fixture: the imported model 64000 frame uses 2480 × 3507 pixels, while the only Swedish-eligible `cherry red / m` variant reports 4677 × 5881. Scaling the first to fit the second would produce a factor of `min(4677/2480, 5881/3507) = 1.6769`. Under the application's existing 300-DPI interpretation, a 100 mm motif would become approximately 168 mm if Prodigi scales to those full-area dimensions. This is an inference from the resizing contract and saved product data, not a measured physical print; the precise scaling needs provider confirmation. A separately confirmed frame override can avoid this particular imported-frame mismatch.

The statement in [PRODIGI_MONEY_DECISION.md §2.6](PRODIGI_MONEY_DECISION.md) that the smaller frame merely leaves space unused and that “nothing prints wrong” is therefore not established. This was already an open print-area question in the handover; the audit confirms it is a correctness blocker.

Minimum correction: resolve the applicable variant/frame before rendering, or restrict launch to combinations whose actual frame has been confirmed. If Prodigi can choose between different frames for the same attributes, obtain a supported sizing approach from Prodigi before promising exact physical dimensions. With the canvas switch off, the bare-motif path also does not encode the selected width.

### F2 · P1 · Checkout accepts back-only products that omit a required front asset

Locations: [catalogue construction](../../scripts/cf-port/prodigi-catalog.mjs#L182), [production eligibility](../../cloudflare/src/pod/pod-mappings.ts#L1485), [asset serialization](../../cloudflare/src/dispatch/prodigi-wire.ts#L140).

All nine saved product-detail responses say `printAreas.front.required = true`. The importer retains front/back dimensions but loses the required-area constraint. A mapping containing only `back` can be published, pass checkout, and serialize to an order with only a back asset. This violates the published [required print-area contract](https://www.prodigi.com/print-api/docs/reference/#product-details-object-print-area), leaving validation to happen after payment.

Reproduced locally: a valid active Prodigi printer, a back-only mapping, a published product, and a shipping recipient produced checkout `ok`; the wire builder emitted only `back`.

Minimum correction: retain required print areas and enforce them at publication/checkout, with a final adapter guard. Until a supported back-only representation is confirmed, refuse that configuration before payment.

### F3 · P1 · Pickup orders are sold although the adapter cannot fulfil them

Locations: [checkout delivery gate](../../cloudflare/src/commerce/checkout.ts#L703), [production snapshot](../../cloudflare/src/commerce/checkout.ts#L1071), [adapter refusal](../../cloudflare/src/dispatch/prodigi-client.ts#L110), [dispatch address lookup](../../cloudflare/src/commerce/recipient.ts#L527).

When a seller enables pickup on a Prodigi product, checkout checks the product flag and pickup location and accepts the sale. Production eligibility does not check whether that delivery method can be submitted. After payment, `readDispatchShipTo` returns null for pickup, and the adapter terminates dispatch with `ship_to_missing`. Prodigi requires a [recipient and shipping address](https://www.prodigi.com/print-api/docs/reference/#order-object-recipient).

Reproduced locally with a valid fixture pickup location: checkout `ok`, adapter `rejected/ship_to_missing`. The refusal itself is appropriate; it occurs too late.

Minimum correction: refuse Prodigi pickup checkouts until an explicit ship-to-shop fulfilment route exists, and have the storefront use the same eligibility rule.

### F4 · P1 · Destination eligibility is lost between import and checkout

Locations: [SE-only import](../../scripts/cf-port/prodigi-catalog.mjs#L95), [capability projection](../../cloudflare/src/pod/printer-catalog.ts#L707), [checkout production read](../../cloudflare/src/commerce/checkout.ts#L1096), [storefront country selector](../../src/pages/shop/Checkout.jsx#L775).

The importer selects variants that ship to Sweden, but applied SKU capabilities retain only model/label, not the destination list. Checkout offers other countries, including the US, while the production eligibility call does not receive the destination. The order subsequently forwards the buyer's country to Prodigi without proving that the chosen variant can ship there. Product details explicitly expose [variant `shipsTo`](https://www.prodigi.com/print-api/docs/reference/#product-details-object-variant).

Concrete saved-data example: `GLOBAL-TEE-GIL-64000.azalea.3xl` is in the imported offer and has Swedish availability, but no matching saved variant ships to US, CA, AU, NZ, or JP. Nothing in checkout's production check rejects those destinations for that SKU. This destination example is established from saved data and code tracing; it was not submitted to the live API.

Minimum correction: restrict Prodigi launch destinations to SE, or preserve and validate destination availability and obtain the destination-specific quote before freezing payment amounts.

### F5 · P1 · Provider issues disappear after order acceptance

Locations: [create-response classifier](../../cloudflare/src/dispatch/prodigi-wire.ts#L232), [callback mapper](../../cloudflare/src/dispatch/prodigi-intake.ts#L182), [intake](../../cloudflare/src/dispatch/prodigi-intake.ts#L295).

`CreatedWithIssues` is reduced to normal acceptance; no issue reaches an alert or operator-visible exception. Callback read-back likewise ignores `status.issues`, asset failures, and `Error` detail states. Prodigi documents issues requiring merchant intervention, including failed asset downloads, unavailable products and payment authorisation. See [create outcomes](https://www.prodigi.com/print-api/docs/reference/#create-order) and [status/issues](https://www.prodigi.com/print-api/docs/reference/#status-status-object-issues).

Reproduced through dispatch and intake: `CreatedWithIssues`, an exhausted asset-download issue and `downloadAssets: Error` left the line accepted, its production state and exception null, no alert, and intake returned `ok`. Completed dispatch rows are outside the existing stranded-dispatch checks, so those checks do not recover this condition.

Minimum correction: retain the accepted provider reference, but record/deduplicate actionable issue codes and alert operators. Inspect issues on every authenticated read and reconcile accepted orders that stop progressing. Do not resubmit with a new key to fix an already-created order.

### F6 · P1 · A partially cancelled shipment is reported as still in production

Location: [shipment and cancellation mapping](../../cloudflare/src/dispatch/prodigi-intake.ts#L192).

The mapper recognises shipped shipments and whole-order `Cancelled`, but never handles `shipment.status = Cancelled`. Prodigi permits [partial cancellation](https://www.prodigi.com/print-api/docs/reference/#cancel-an-order), where the overall order remains uncancelled.

Reproduced with two accepted lines: one shipment cancelled and the other processing, under an overall `InProgress` order. The cancelled line was mapped and persisted as `in_production`; intake returned `ok` and raised no alert. It then holds order completion indefinitely without explaining why.

Minimum correction: match cancelled shipments to their item IDs before applying aggregate production progress, and raise a deduplicated exception/alert for affected live lines. Keep money movement separate from this provider fact.

### F7 · P1 · Supplier shipping is frozen as one flat charge despite quantity and split shipments

Locations: [checkout cost total](../../cloudflare/src/commerce/checkout.ts#L1150), [imported shipping facts](../../scripts/cf-port/prodigi-catalog.mjs#L269), [quote samples](prodigi-api-samples/).

One API order is correctly created for the basket, but that does not make supplier carriage a fixed amount. Prodigi may [split lab allocation into shipments](https://www.prodigi.com/print-api/docs/reference/#the-order-process-3-lab-allocation), and its [quote response](https://www.prodigi.com/print-api/docs/reference/#quote-object) includes their costs.

The saved samples already demonstrate the mismatch:

| Case | Saved supplier shipping, EUR ex VAT |
| --- | ---: |
| One PL item | 11.85 |
| Two PL copies | 12.85 |
| Six azalea 64000 sizes, split NL + PL | 21.20 |
| One AU item | 21.46 |
| Two AU copies | 28.92 |

The frozen supplier-cost calculation adds `printer.shippingCostMinor` exactly once regardless of quantity, destination or labs. The importer records per-extra-item/per-lab data, but checkout does not consume it. Non-EU SKUs are also retained while the suggested model pricing excludes non-EU quotes. A buffer can absorb some difference; it does not make the recorded supplier cost accurate. This is already partly acknowledged in [the money decision](PRODIGI_MONEY_DECISION.md#25-non-eu-labs-decide).

Minimum correction: quote the complete basket with its actual copies, attributes, print areas, destination and shipping method before freezing supplier cost; otherwise enforce and price a deliberately restricted offer. Keep buyer shipping prices distinct from supplier costs. Define how to reconcile actual provider charges when allocation differs from the quote.

### F8 · P2 · The importer assumes quote item IDs are sequential numbers

Locations: [shipping probe correlation](../../scripts/cf-port/prodigi-catalog.mjs#L357), [price correlation](../../scripts/cf-port/prodigi-catalog.mjs#L478).

Both paths use `q.items[String(i + 1)]`. This matches the saved sandbox responses, but the published [quote examples and item schema](https://www.prodigi.com/print-api/docs/reference/#quote-object-item) use opaque IDs such as `qit_…`; there is no positional numeric-ID guarantee.

Reproduced by changing only the response IDs and shipment references in a real saved quote to valid opaque strings: `readQuote` still parsed all six items, but `pickProbes` returned zero probes instead of two. The price-folding path makes the same failed lookup and drops the item prices. Existing fixture tests repeat this numeric-ID assumption.

Minimum correction: correlate returned items by their returned SKU, attributes and asset specification; use returned IDs only for linking those items to response shipments. Fail explicitly on ambiguous or missing matches. Also request `currencyCode: EUR` rather than depending on merchant account defaults.

### F9 · P2 · An unreadable duplicate response permanently loses the provider reference

Locations: [duplicate classifier](../../cloudflare/src/dispatch/prodigi-wire.ts#L240), [completion write](../../cloudflare/src/dispatch/dispatch-effect.ts#L1516), [callback binding](../../cloudflare/src/dispatch/prodigi-intake.ts#L281).

`AlreadyExists` without a readable `order.id` becomes a duplicate with no reference. The dispatcher completes the row and accepts the line with `printer_job_ref = null`; subsequent callbacks cannot bind the order because intake requires that exact reference. This is defensive error handling: Prodigi's [documented duplicate response](https://www.prodigi.com/print-api/docs/reference/#create-order) returns the existing order, so a missing ID should be treated as unreadable success, not complete success.

Reproduced through the real outbox path: the dispatch became done with null result/reference and intake for the authenticated provider order returned `not_found`.

Minimum correction: require a readable order ID for Prodigi duplicates, keep the dispatch unknown otherwise, and recover through the same idempotency key or a verified reference lookup. Do not weaken the separate SnapWear duplicate contract.

## What is aligned

Authentication uses `X-API-Key` and JSON; the v4 paths, environment host gates and redirect refusal are appropriate. SKU/colour/size serialization matches the saved products. Optional recipient fields are omitted cleanly. The stable order ID is used as the idempotency key and order merchant reference, with stable per-line merchant references.

The order-unit dispatch path sends all ready lines together, prevents concurrent sibling submissions in SQL, adopts an existing provider reference, and retries uncertain outcomes using the same key. Rendering/payment holds and frozen recipient copying remain intact. CloudEvents are treated as notifications: the handler re-reads the order using our API key instead of trusting an unsigned callback payload. Shipment-to-item mapping uses provider item IDs, and successful shipments flow through the guarded production/fulfilment writer. Provider completion is not mislabelled as customer delivery. See the [idempotency](https://www.prodigi.com/print-api/docs/reference/#order-object-idempotency-key), [callbacks](https://www.prodigi.com/print-api/docs/reference/#callbacks) and [status](https://www.prodigi.com/print-api/docs/reference/#status) contracts.

## Intentional limits and unverified cases

- Cancellation after acceptance currently raises human-action alerts. That is an intentional D4.6 limit, not a claim that Prodigi lacks cancellation endpoints. The alert text incorrectly says the printer has no cancellation API and should be corrected. If cancellation is automated later, inspect the action availability and response outcome; HTTP 200 alone is insufficient.
- Printer tracking is stored on platform-only line fields and deliberately excluded from buyer/seller shipment records. That is an existing product decision, not a missing API field parser.
- `onHold` with an ID inside `order` is accepted, but an actual paused-order response/release sequence was not exercised here. Check that account pause duration, signed asset URL validity and issue monitoring work together before enabling account pause windows.
- The seven-day presigned URLs are compatible with a plain unauthenticated GET while valid. This audit did not externally fetch a newly signed URL or verify deployed bot-protection rules. Prodigi documents its [asset-fetch requirements](https://www.prodigi.com/print-api/docs/reference/#the-order-process-2-assets-download-how-we-fetch-your-assets).
- No physical print was measured, no live payment/refund was made, and no production credentials or deployed settings were inspected. Prior staging smoke evidence in the handover is historical evidence, not a new end-to-end verification by this audit.

## Verification

- `cd cloudflare && npm run build`: passed (`tsc --noEmit`).
- Seven existing suites (`prodigi-client`, `prodigi-intake`, `dispatch-order-unit`, `dispatch`, `admin-order-fulfilment`, `checkout`, `webhook`): **463 tests passed**.
- Existing `pod-publish` and `pod-mappings` suites: **59 tests passed**.
- `node --test scripts/cf-port/test/prodigi-catalog.test.mjs`: **14 tests passed**.
- Five temporary Workers/D1 probes reproduced F2, F3, F5, F6 and F9. They asserted the observed problematic behaviour, so their passing result is evidence of the gaps, not a conformance result. Node probes separately established the F1 resizing calculation and F8 opaque-ID mismatch; saved product/quote inspection established F4 and F7.
- Workers tests initially hit the sandbox's localhost-listener restriction, then passed with permission for the local test runtime. Its configured outbound service disables external network access. Only the report remains as a repository change from this audit; the pre-existing `CP10_OB_DESIGN.md` edit was left untouched.

Recommended order: fix pre-payment feasibility (F2–F4), establish safe print geometry (F1), correct supplier cost coverage (F7), then handle provider exceptions and reference recovery (F5–F6, F9) and harden importer correlation (F8). Add tests for those contracts before enabling production submission.
