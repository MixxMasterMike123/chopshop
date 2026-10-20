# CP12 — Flat prints (postcards, stickers, framed posters; later canvas, mugs): concept and plan

Written 2026-10-20 on cf-port `d888996a`, from Kent's list (`KENT_PRODUCT_LIST_2026-10-20.md`) and the sandbox facts in `prodigi-nonapparel-2026-10-20.json`. Design only; nothing built. Decisions for Mikael are marked **D**.

## 0. The one idea

A garment product is "a motif placed on a body at a chosen size, on a colour, in sizes". A flat print is "a motif that IS the product, at a fixed size, with no colour and no body". The platform already has every layer a flat print needs except two: the studio's placement step and the garment mockup. So flat prints are a second PRODUCT KIND inside the existing POD module, not a second module: same artwork library, same catalogue and tiers, same mapping, same checkout snapshot, same dispatcher and Prodigi adapter, same seller-sees-one-number money. What differs is one flag on the catalogue model (`kind: "flat"`), one print-area name on the wire (`default`), and a shorter studio.

## 1. What Prodigi gives us (verified on the sandbox 2026-10-20)

| Family | SKUs | Print area | Lab | Unit EUR ex VAT | Shipping EUR (first item) |
|---|---|---|---|---|---|
| Framed poster (budget) | GLOBAL-BFP-11X14 / 12X16 / 16X20 / 18X24 | one `default` area, exactly 300 dpi of the sheet (e.g. 12×16" = 3543×4724 px = 300×400 mm) | prodigi_eu | 17 / 19 / 24 / 28 | 13.95 |
| Framed poster 5×7" | GLOBAL-BFP-5X7 | 1535×2125 | prodigi_gb3 (UK) | 11.87 | 31.99 |
| Postcard, Mohawk matte | GLOBAL-POST-MOH-7X5, -6X4-BLA (with envelope) | one `default` area that holds BOTH sides: 4322×1559 for 7×5" (two 2102×1500 panels plus bleed) | prodigi_eu | 1.35 / 1.05 | 7.55 |
| Postcard, gloss | GLOBAL-POST-GLOS-6X4 / -7X5 | same two-panel area | prodigi_gb2 (UK) | 0.48 / 0.71 | 10.2 |
| Kiss-cut sticker | M-STI-3X4 / 5_5X5_5 / 8_5X8_5 / 14X14 | `default`, 300 dpi of the sheet (900×1200 … 4200×4200) | prodigi_gb2 (UK) | 0.95 / 2.97 / 5.34 / 7.72 | 8.96–11.52 |
| Mug | GLOBAL-MUG-W | wrap area 2670×1110 | uk2 (UK) | 5.07 | 5.88 |
| Eco canvas / framed canvas | ECO-CAN-*, ECO-FRA-CAN-* | `default` with THREE sizes per SKU (bleed/wrap variants) + `edge`/`wrap` attributes | prodigi_eu | 9–55 | 12.89–19.40 |

Attributes the order must send: posters `frame`, `color`, `glaze`, `mount`, `paperType`, `substrateWeight`; postcards `finish`, `paperType`, `substrateWeight` (+ `style`); canvas `edge`, `wrap`, … These are PER SKU constants we choose once at import (e.g. black frame, no mount) — not buyer choices at launch.

## 2. Scope by phase

- **Phase 1 — framed posters, the four EU sizes.** One area, 300 dpi, EU lab, the highest price point, the cleanest fit to what exists. This is the pilot of the whole kind.
- **Phase 2 — postcards (Mohawk, EU).** The two-panel asset is the only new thing: the studio makes ONE PNG with the motif on the left panel and a back panel that is blank, or carries the shop's logo/name (the "signature" the tees cannot have, since Prodigi prints no packing slip on them). **D1:** what goes on the back by default — blank, or shop name + one line the seller writes?
- **Phase 3 — stickers (UK).** Kiss-cut means Prodigi cuts around the motif's outline: the asset must be a PNG with a transparent background, and the 300 dpi gate applies at the sticker's size. Shipping from the UK (~9–12 EUR on a 1–8 EUR item) makes a single sticker a poor order; **D2:** sell stickers only in packs (e.g. 3 of the same) or alongside a garment, or not at all until a sheet product exists.
- **Later — canvas (three print-area variants per SKU need the same "which variant" answer as the tees), mugs (wrap area, UK only), the 5×7" poster (UK, 32 EUR shipping: drop it).

**D3:** confirm Phase 1 only for the launch with 10–20 artists, phases 2–3 after.

## 3. Data model (small)

- Catalogue model gains `kind: "garment" | "flat"` (default garment) and, for flat, ONE area `front` = the product's `default` area in mm and px, plus `prodigiPrintArea: "default"` and the fixed `attributes` object. SKU key stays `<prodigiSku>.<variant>.<size>` where colour is a constant slug (`black-frame`) and size the sheet size (`12x16`), so nothing in the key grammar changes. The importer (U4) gets `--kind flat` and writes these from `prodigi-nonapparel-*.json`.
- `printer_sku_tiers` unchanged (blank cost + per-print cost; a flat print has one print). `shipping_cost_minor` stays per printer: **D4:** posters cost 13.95 EUR to ship against the tees' 11.85 — either one Prodigi printer row per family (`prodigi` and `prodigi-prints`, each with its own shipping figure; the order-level "one printer per order" rule then keeps a poster and a tee in separate orders, which is also what Prodigi would ship anyway), or one row and accept the 2 EUR gap. Recommendation: **two printer rows**, it is honest and costs nothing in code.
- Product: a flat product has one "colour" (the finish) and N sizes (the sheet sizes) → the existing variants rail fits as is: size = variant, mapping per variant SKU, one artwork per product. No `garment` slot vocabulary beyond `front`.
- Adapter: for a model with `kind: "flat"`, `assets[].printArea = "default"`, `attributes` = the model's fixed object (+ nothing from the key), `sizing: "fitPrintArea"` with the canvas at the area's exact px (so fit = 1:1, the F1 rule). Same change the 18600 `edge` and the tote need; one unit.
- Print spec: a flat print's gate is "≥ 300 dpi at the chosen sheet size, contain-fit": a 12×16" poster needs 3543×4724 px. That is stricter than the tee gate for big sheets (18×24" needs 5314×7086). **D5:** keep 300 dpi (Prodigi's own figure for these products) and let the studio show which sizes an artwork qualifies for, greying out the rest, rather than refusing the upload.

## 4. The studio for a flat print

The wizard keeps its frame (steps, publish panel, platform review, one number) and drops what has no meaning. Proposed steps for "Nytt tryck":

1. **Produkt** — tile picker: Affisch (ramad), Vykort, Klistermärke (phases 2–3 greyed until built). Picks the family, shows its sizes with the per-size price the shop would pay (as today's "Inköp").
2. **Motiv** — the artwork library as today; each size tile shows ✓ or "för låg upplösning (minst 3543×4724 px)". The seller ticks the sizes to sell.
3. **Placering** — a flat canvas of the sheet with bleed (3 mm) and safe area marked; the motif is placed FILL (cover, cropped at the edges) or FIT (contain, with a background colour the seller picks, default white). No free rotation, no multiple motifs at launch. Postcards show two panels (front / back). Stickers show the cut line = the motif's alpha outline.
4. **Förhandsvisning** — the mockup: a flat photographic template (poster on a wall, postcard on a table, sticker on a laptop) from the existing template mechanism (`settings/podMockupTemplates` → the CF import), one template per family; the 3D view and "Finjustera plaggbilden" are skipped.
5. **Pris och publicering** — the existing publish panel: name, description, the seller's price per size over the one number, platform review for a new shop's first products.

Steps 1–2 are new screens (small), 3 is a new compositor mode on the existing Pixi canvas (the garment compositor already does placement maths; the flat mode is a subset: one rectangle, cover/contain), 4 reuses the mockup renderer with a flat template, 5 is unchanged. The upload gate text and the DPI check get the per-size rule.

## 5. Admin and storefront

- Admin product list and form: the product's kind shows as a badge ("Tryck"); variants = sizes with the mapping's SKU; images = the studio's flat mockups + the print itself; "Inköp" per size. Nothing else changes (AppLayout, Admin-Neutral tokens).
- Storefront PDP (NORD): the size selector replaces the colour selector; the gallery shows the mockups; the ångerrätt text already covers personalised goods. Collections work as for any product.
- Platform console: `/platform/printers` shows the second printer row and its catalogue; `/platform/print-jobs` shows flat jobs like any other (reference `ord_…`).

## 6. Money

Same as garments: tier = blank cost + per-print cost (SEK from EUR at the rate/buffer Mikael chooses in `PRODIGI_MONEY_DECISION.md`), withholding = Σ line cost + the printer row's shipping, one deduction shown to the seller. UK-lab families carry their higher shipping on their own printer row (D4). Prodigi's Pro plan saves 15 % on these (vs 10 % on apparel).

## 7. Build units (after Mikael's D1–D5), each with the usual gates

| Unit | What | Size | Model |
|---|---|---|---|
| F1 | Catalogue `kind: flat` + importer `--kind flat` for the four EU posters + the printer row `prodigi-prints` on staging | 1 builder unit | Sonnet |
| F2 | Adapter: flat models → `printArea: "default"`, fixed attributes, exact-px canvas; the same change carries 18600's `edge` and the tote's no-size; tests | 1 unit | Opus |
| F3 | Studio "Nytt tryck": steps 1–3 (picker, size qualification, flat placement cover/contain) + the DPI-per-size gate | 2 units | Opus |
| F4 | Flat mockup template(s) + preview step; admin badge + variants-as-sizes; storefront size selector | 1 unit | Opus (design gate: look at it rendered) |
| F5 | Staging smoke: a poster bought and reaching the sandbox | ½ unit | Sonnet |

Not in these units: postcards' back panel (phase 2), stickers' transparency and packs (phase 3), canvas variants, mugs. The F1 print-area question of the tees does not block posters: their one area is unambiguous.
