# CP12 F2 report: flat models end to end in the Worker (framed posters), plus the 18600 `edge` and the tote

Model: claude-opus-5-5. Worktree `cp12-prints` (HEAD 809d91ad + this unit's working tree). No git write, no network, no wrangler, no migration (placement is JSON; nothing needed a column).

## Gate (run on the final tree)

- `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`: clean.
- `cd cloudflare && npx vitest run`: 143 files, 5165 tests passed. One earlier full run had one failure in `test/checkout-recovery-routes.test.ts` ("a forged signature"). That test flips the last base64url character of a signature, and the flip sometimes leaves the decoded bytes unchanged. It is unrelated to this unit and passed 3 of 3 times when re-run alone.
- Render package (`cloudflare/render`): `npx tsc --noEmit -p .` clean; `npx vitest run`: 7 files, 143 tests passed (138 before, 5 new). The worktree has no `cloudflare/render/node_modules`, so I symlinked the main tree's for the run and removed the link afterwards. **Side effect to know about:** vitest wrote its results cache through that link to `/Users/mikaelohlen/Cursor Apps/chopshop/cloudflare/render/node_modules/.vite/vitest/…/results.json`. That file is a gitignored test-order cache, and no source file in the main tree was touched.
- `node --check scripts/cf-port/seed-staging-slice.mjs`: OK. `node guard/guards.test.mjs`: PASS (baseline 292). The new untracked test file contains none of the guard's three patterns.

## Files

- `cloudflare/src/pod/printers.ts`
  - `PrintArea.px`, `PrinterModel.kind/attributes/prodigiPrintArea`, `PrinterSkuEntry.attributes`.
  - Parsers with caps: `parsePrintArea` (px), `parseFixedAttributes`, `isPrintAreaName`, and the flat rules in `parsePrinterCapabilities`.
  - `slotFrame` gives a flat model its `front` only.
  - Helpers: `flatAreaPx`, `flatReachesPx`, `FLAT_FITS`, the defaults, `printerItemFacts`, `parsePrinterItemFacts`.
  - The tenant view allowlist gains `kind` and `px`.
- `cloudflare/src/pod/printer-catalog.ts`: `buildFromCatalog` carries kind, px, attributes, the area name and a SKU's own attributes. It also adds `CATALOG_PRINT_AREA_BY_SUPPLIER_SKU` (the tote).
- `cloudflare/src/pod/pod-mappings.ts`
  - Placement in `parseCreateMappingInput`, and `flatSlotMm`.
  - The flat sizing and refusals in `createMapping`.
  - The gate code `pod_resolution_too_low`.
  - `decideProductionLine` freezes `flat` and `printerItem`.
- `cloudflare/src/catalog/admin-catalog.ts`: the refusal code type.
- `cloudflare/src/commerce/checkout.ts`: the snapshot carries `flat` per file and `printerItem` per line, only where they apply.
- `cloudflare/src/dispatch/print-canvas.ts`: `FlatCanvasSpec`, `flatCanvasSpec` and `parseFrozenFlat`.
- `cloudflare/src/dispatch/dispatch-effect.ts`
  - Strict reads of `flat` and `printerItem`.
  - A flat line takes the canvas path whatever the switch.
  - The job line carries `printerItem`.
- `cloudflare/src/dispatch/printer-client.ts`: `PrinterJobLine.printerItem`.
- `cloudflare/src/dispatch/prodigi-wire.ts`: the asset area and `prodigiItemAttributes`. `prodigi-client.ts` needed no change, because it only calls the body builder.
- `cloudflare/render/src/contract.ts` and `cloudflare/render/src/canvas.ts`: parse and render a flat spec.
- `scripts/cf-port/seed-staging-slice.mjs`: `--printer prodigi-prints`.
- Tests:
  - `cloudflare/test/flat-prints.test.ts` (new, 23 tests).
  - `cloudflare/test/dispatch-order-unit.test.ts`: 2 new end-to-end tests. `renderOne` was moved to module scope.
  - `cloudflare/test/dispatch-fixtures.ts`: `printerItem` and `flat` added to the line spec.
  - `cloudflare/render/test/canvas.test.ts` (+4) and `cloudflare/render/test/contract.test.ts` (+1).

## The contract as built (exact shapes)

**Capability document, platform view** (`GET /v1/platform/printers/prodigi-prints` → `printer.capabilities`, the stored document):

```json
{ "models": { "BFP-12X16": {
    "attributes": { "color": "white", "frame": "Budget", "glaze": "Acrylic / Perspex", "mount": "No mount / Mat", "paperType": "Silk", "substrateWeight": "150gsm" },
    "garment": "poster", "kind": "flat", "name": "Budget Framed Poster, 30x40cm / 12x16\"",
    "printAreasMm": { "front": { "h": 400, "offsetTopMm": 0, "px": { "h": 4724, "w": 3543 }, "w": 300 } },
    "prodigiPrintArea": "default", "requiredSlots": ["front"] } },
  "skus": { "GLOBAL-BFP-12X16.white-frame.12x16": { "label": "White frame / 12x16", "model": "BFP-12X16" } } }
```

The 18600 SKU entry is `{ "attributes": { "edge": "Zip" }, "label": "White / M", "model": "18600" }`, or `Drawstring` for the other colours. The tote model is unchanged except for `"prodigiPrintArea": "default"`.

Caps:
- `kind`: `garment` or `flat`. `garment` is accepted and not stored.
- A flat model has exactly one area, `front`, with `px`. It is never provisional, and `requiredSlots` may only be `["front"]`.
- `px`: integers from 1 to 20000.
- `attributes`: 1 to 12 entries. Keys match `^[A-Za-z][A-Za-z0-9_]{0,31}$`; values are strings of 1 to 64 characters with no control character.
- `prodigiPrintArea`: matches `^[A-Za-z][A-Za-z0-9_-]{0,31}$`.
- A SKU's `attributes` follow the same caps.
- Any breach refuses the whole document.

**Tenant view** (`GET /v1/admin/pod/printers`, the allowlist; no attributes, no area name, no costs):

```json
{ "capabilities": { "models": { "BFP-12X16": { "garment": "poster", "kind": "flat", "name": "Budget Framed Poster, 30x40cm / 12x16\"",
      "printAreasMm": { "front": { "h": 400, "offsetTopMm": 0, "px": { "h": 4724, "w": 3543 }, "w": 300 } } } },
    "skus": { "GLOBAL-BFP-12X16.white-frame.12x16": { "label": "White frame / 12x16", "model": "BFP-12X16" } } },
  "garments": ["poster"], "name": "Prodigi prints (sandbox)", "printerId": "prodigi-prints", "provisionalAreas": [] }
```

**Mapping placement.** In the `POST /v1/admin/pod/mappings` body, each `slots` entry is either a slot name or `{ "slot": "front", "fit": "contain"|"cover", "background": "#rrggbb" }`. `fit` and `background` are each optional, and the colour is stored lower-case. A flat slot is stored and returned like this:

```json
{ "background": "#ffffff", "fit": "contain", "heightMm": 300, "slot": "front", "widthMm": 300 }
```

The defaults are `contain` and `#ffffff`, and the background is stored for `cover` too. `widthMm`/`heightMm` are the contained motif box (or the whole sheet under `cover`). A garment slot is unchanged, byte for byte.

**Frozen snapshot.** Each file of a flat line gets `"flat": { "background": "#ffffff", "canvasPx": { "w": 3543, "h": 4724 }, "fit": "contain" }`. The line gets `"printerItem": { "attributes": {…6…}, "kind": "flat", "printArea": "default" }`. For the 18600 the line gets `printerItem: { attributes: { edge } }`, and for the tote `printerItem: { printArea: "default" }`. A garment without extras freezes neither key.

**Canvas job spec, flat.** A 3600² master on the 12×16 sheet:

```json
{ "background": "#ffffff", "canvasPx": { "h": 4724, "w": 3543 }, "dpi": 300, "fit": "contain",
  "motifPx": { "h": 3543, "w": 3543 }, "offsetPx": { "left": 0, "top": 590 },
  "sourceCropPx": { "h": 3600, "left": 0, "top": 0, "w": 3600 }, "sourcePx": { "h": 3600, "w": 3600 }, "version": 1 }
```

Under `cover`, `motifPx` is the whole sheet, `offsetPx` is 0,0, and `sourceCropPx` is the centred crop at the sheet's aspect. A 4000×6000 master gives `{h:5333,left:0,top:333,w:4000}`. The container crops, flattens onto the background, resizes (lanczos3) and extends with the background. The output is an opaque 8-bit sRGB RGB PNG at the exact sheet size with pHYs 300. A garment spec is unchanged.

**Prodigi items:**

```json
{ "sku": "GLOBAL-BFP-12X16", "attributes": { "color": "white", "frame": "Budget", "glaze": "Acrylic / Perspex", "mount": "No mount / Mat", "paperType": "Silk", "substrateWeight": "150gsm" },
  "assets": [{ "printArea": "default", "url": "…/1-front.png" }], "copies": 1, "merchantReference": "1", "sizing": "fitPrintArea" }
{ "sku": "GLOBAL-HOOD-GIL-18600", "attributes": { "color": "white", "edge": "Zip", "size": "m" },
  "assets": [{ "printArea": "front", … }, { "printArea": "back", … }], … }
{ "sku": "H-BAG-LTOTE", "attributes": { "color": "anthracite" }, "assets": [{ "printArea": "default", … }], … }
```

The rule: attributes are the model's fixed set with the SKU's own set on top. A garment then adds the key's `color` and `size`, with `size` dropped when it is `one-size`; the key wins for those two only. A flat model sends the fixed set alone. The `front` slot is sent as `printArea ?? "front"`, and other slots keep their own names.

## Deviations from the brief (each is deliberate)

1. **Each SKU can carry its own `attributes`.** The contract named model attributes only. The 18600's `edge` depends on the colour (white is Zip), so it cannot live on the model. A SKU keeps only what its catalogue attributes add beyond `color`, `size` and its model's set.
2. **The tote's `default` area comes from a lookup table.** The U4B catalogue gives the tote no `prodigiPrintArea`, so `CATALOG_PRINT_AREA_BY_SUPPLIER_SKU` maps `H-BAG-LTOTE` to `default`. A model's own value always wins.
3. **The resolution rule depends on the fit.** Under `contain` the master must reach the sheet on one axis, which is exactly the brief's rule. Under `cover` it must reach both axes, because otherwise the poster prints below 300 dpi. F3's `flatQualifies` already applies the same rule.
4. **Two refusal codes depending on where the check runs.**
   - The mapping write refuses with the existing `resolution_too_low`. A placement on a garment is refused with the new `placement_unsupported`.
   - The publish gate returns the new `pod_resolution_too_low`, with a seller sentence. That covers a sheet that grew after the mapping was made, which the millimetre-based suspension check cannot see. Checkout refuses such a line as unproducible.
5. **A flat line always goes through the canvas, even with `PRINT_CANVAS_ENABLED` off.** It is the only way the fit and background reach the print. Garment lines are unchanged.
6. **`px` is carried for flat models only.** The garment catalogue's `printAreaPx` is not carried, so garment documents and snapshots stay byte for byte.

## Open questions

- **Deploy the render container before the Worker sells a poster.** An older image refuses a flat spec as `invalid_envelope`, and the line then fails after its attempts.
- **The 100 MiB canvas cap now applies to posters.** That is `SNAPWEAR_MAX_CANVAS_BYTES`. An 18×24 sheet is 37.6 Mpx, and a noisy photo saved as RGB PNG can come close to the cap. Prodigi's own file-size limit is unknown.
- **The importer should write the tote's area itself.** If `scripts/cf-port/prodigi-catalog.mjs` writes `prodigiPrintArea: "default"` for STAU773, the lookup table in deviation 2 can go.
- **The two new codes have no Swedish admin messages yet.** `placement_unsupported` and `pod_resolution_too_low` need text in `src/admin-app/adapters/pod.js` and `product.js`. Those files are outside this unit (F3/F4).
- **The studio must re-post a mapping when only fit or background changes.** `planScopeMappings` compares slot ids only. Re-posting the same tuple re-activates the mapping and overwrites its slots.
- **Still unconfirmed from U4B:** whether a white "Zip" 18600 and a coloured "Drawstring" 18600 are physically different garments.
- **Seed command:** `node scripts/cf-port/seed-staging-slice.mjs --printer prodigi-prints --purchase`. It creates the row `prodigi-prints` with shipping at 15 000 öre and a tier of 22 000 öre with a 0-öre front print (both placeholders), and the product `SLICE-POSTER-…`. The mapping is the 12×16 with `contain` on white. The purchase ships to SE.
