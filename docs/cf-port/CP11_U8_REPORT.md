# CP11 U8 report: F8 importer correlation + the flat catalogue for posters (2026-10-20)

Model: claude-sonnet-5-5. Sandbox only, <= 2 req/s, key read at run time, never printed. Nothing under `cloudflare/` touched.

## F8 (audit finding: positional quote item ids)
- `readQuote` now also returns `list` (id, returned sku, attributes, assets, unitMinor, lab); a duplicate or non-string id makes the quote unusable (null).
- New `matchQuoteItem(quote, requestItem)`: correlates by SKU + attributes + asset print areas; throws on no match and on ambiguity. Ids are used only to link items to shipments (unchanged).
- `pickProbes` and the price fold use it (the `String(i + 1)` lookups are gone). Every quote request (jobs and probes) now sends `currencyCode: "EUR"`; the sandbox accepted it (200, EUR amounts).
- Tests: a real saved quote rewritten with `qit_` ids, reversed order, rewritten shipment references; `pickProbes` finds the same probes (it found none before); no-match / ambiguous / duplicate-id cases.
- Garment catalogue regenerated `--offline` (with PRODIGI_GENERATED_AT pinned to the committed value): byte-identical; the pricing files did not change either. Without pinning only `generatedAt` differs.

## Posters (`--kind flat`, output `docs/cf-port/prodigi-prints-catalog.json`)
Fresh `GET /products/{sku}` (200) and one SE Standard quote each (EUR, lab prodigi_eu, shipping 13.95 = 1395 in the pricing fragment).

DEVIATION: there is no black frame. The budget frame lists `color` natural/white for SE; 12X16 lists white only. White is the only value common to all four, so the fixed frame is white and the key is `<sku>.white-frame.<size>`. `FLAT_FRAME_PREFERENCE` puts black first, so it would be picked if Prodigi adds it. Other attributes as listed: frame Budget, glaze Acrylic / Perspex, mount No mount / Mat, paperType Silk, substrateWeight 150gsm.

| SKU key | unit EUR | front area px -> mm |
|---|---|---|
| GLOBAL-BFP-11X14.white-frame.11x14 | 17.00 | 3307x4192 -> 280x355 |
| GLOBAL-BFP-12X16.white-frame.12x16 | 19.00 | 3543x4724 -> 300x400 |
| GLOBAL-BFP-16X20.white-frame.16x20 | 24.00 | 4724x5905 -> 400x500 |
| GLOBAL-BFP-18X24.white-frame.18x24 | 28.00 | 5314x7086 -> 450x600 |

Models `BFP-11X14` ... carry `kind: "flat"`, `garment: "poster"`, `prodigiPrintArea: "default"`, `attributes`, `requiredSlots: ["front"]`, `front` (mm, the key the Worker's apply reads), `printAreaPx`. The document also carries `pricingBasis` and an `applyPricingEur` fragment (`printSlots: ["front"]`, extraPrintEurCents 0, baseEurCents = unit cost). Offline rebuild: `node scripts/cf-port/prodigi-catalog.mjs --kind flat --offline`. Samples: `product-GLOBAL-BFP-*.json`, `quotes-GLOBAL-BFP-*.json`.

## Parser verdict for the extra keys (cloudflare/src/pod)
- Catalogue PUT: ACCEPTED, stored verbatim. `parseCatalogPutInput` checks only top-level `{catalog, pricingBasis, source}` (`printer-catalog.ts:107`), `catalog.models`/`.skus` are objects and each SKU names a string `model` (`:113-121`); the doc is stored as-is (`:140`, "carried as is"). Extra model/SKU keys are tolerated.
- Apply (`buildFromCatalog`, `printer-catalog.ts:646`): reads from a model only `garment` (`isGarment`, `:777`), `name` (`:778`) and the `front`/`back` frames via `catalogFrames` (`:611`); from a SKU only `model`, `colour`, `size` (`skuLabel`, `:628`). **`kind`, `prodigiPrintArea`, `attributes`, `requiredSlots` are silently dropped** from the printer document: they never reach the capabilities.
- If anyone writes them into `capabilities` directly (PUT/PATCH printer), they are REFUSED: `parsePrinterCapabilities` (`printers.ts:244`) uses `hasOnlyKeys` for the model (`printers.ts:264`, allowed: garment, name, printAreasMm, provisional) and the SKU (`:298`, allowed: label, model); a refusal returns null for the whole document. `PrinterModel` (`:44`) has no such fields.
- So today the catalogue imports fine and a poster printer can be applied (front frame becomes the one area), but the flat semantics (default area, fixed attributes, required slots) are not carried into the printer row: the Worker side needs `PrinterModel`/`parsePrinterCapabilities`/`buildFromCatalog` extended (CP12 F2) before the adapter can use them.
