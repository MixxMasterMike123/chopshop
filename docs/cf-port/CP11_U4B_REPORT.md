# CP11 U4B report: Kent's garments and non-apparel on Prodigi (2026-10-20)

Model: claude-sonnet-5-5. Sandbox only (`https://api.sandbox.prodigi.com/v4.0`), <= 2 requests/s, key read at run time and never printed. Nothing under `cloudflare/` touched.

## Result in one paragraph

Five of the eight missing garments are now in the catalogue (64000L, 18600, 64200, JH001F, STAU773 tote). **Three do not exist for Sweden on Prodigi**: 64400 (US only), 2200 (US + BR only), 18000 (US + BR only). They answer 200 as products but have **zero variants that ship to SE**, so no quote or order is possible. The catalogue is now 14 models / 1,586 SKUs, 0 unquoted.

## 1. SKU discovery (`GET /products/{sku}`)

The right strings were found by reading the SKU tables on the prodigi.com product pages (fetch the page, grep the SKU cell); the guessed `GLOBAL-<type>-GIL-<n>` pattern fails for tank, long-sleeve and sweatshirt.

| Garment | String tried | Answer | Note |
|---|---|---|---|
| 64000L | GLOBAL-TEE-GIL-64000L | 200 | 217 variants, 126 ship to SE; USED |
| 64400 | GLOBAL-TEE-GIL-64400 | 404 | |
| 64400 | **GLOBAL-LS-TEE-GIL-64400** | 200 | page SKU; 18 variants, **US only**; NOT SE-shippable |
| 2200 | GLOBAL-TEE-GIL-2200, GLOBAL-TANK-GIL-2200, GLOBAL-VEST-GIL-2200 | 404 | |
| 2200 | **GLOBAL-TT-GIL-2200** | 200 | 30 variants, US 15 + BR 15; **not SE-shippable** |
| 64200L | GLOBAL-TANK-GIL-64200L, GLOBAL-TEE-GIL-64200L | 404 | |
| 64200 | **GLOBAL-TT-GIL-64200** | 200 | "Unisex Tanktop" (no `L` product exists on Prodigi); 64 variants, all ship to SE; USED |
| 18600 | GLOBAL-ZIP-GIL-18600 | 404 | |
| 18600 | **GLOBAL-HOOD-GIL-18600** | 200 | 41 variants, all SE; USED |
| 18000 | GLOBAL-SWEAT-GIL-18000, GLOBAL-SWE-GIL-18000, GLOBAL-HOOD-GIL-18000 | 404 | |
| 18000 | **GLOBAL-TEE-GIL-18000** | 200 | the real string (a `TEE` prefix on a sweatshirt, as printed on the Gildan 18000 page); 172 variants, US 144 + BR 28; **not SE-shippable** |
| JH001F | GLOBAL-HOOD-AWD-JH001F | 404 | |
| JH001F | **HOOD-AWD-JH001F** | 200 | no `GLOBAL-` prefix; 107 variants, all SE; USED |
| STAU773 tote | GLOBAL-BAG-SS-STAU773, BAG-SS-STAU773, TOTE-SS-STAU773, GLOBAL-TOTE-SS-STAU773, GLOBAL-BAG-STAU773 | 404 | |
| STAU773 tote | **H-BAG-LTOTE** | 200 | "SKU prefix" on the STAU773 page; 13 colours, all SE; USED |

## 2. Models added (garment value, print area, colours, labs)

Frame rule unchanged (smallest SE-shipping area). Garment values: `tee` (64000L), `hoodie` (18600 zip, JH001F), **`tank`** (64200, new value), **`tote`** (STAU773, new value). `isGarment` only checks a 1..N-char string, so no Worker change is needed, but the studio/DTG profile must know `tank` and `tote`; `hoodie` stands in for "zip hoodie" (no `zip` value exists).

| Model | Prodigi SKU | frame used px -> mm | other px sizes (SE variants) | colours shipping to SE | labs quoted (EUR, 1 front print) |
|---|---|---|---|---|---|
| 64000L | GLOBAL-TEE-GIL-64000L | 2480x3507 -> 210x297 | 4677x5881 (39), 4650x5844 (19) | 14 of Kent's 15: Azalea, Black, Charcoal, Daisy, Dark Chocolate, Irish Green, Light Blue, Navy Blue, Orange Heather, Purple, Red, Royal Blue, Sport Grey, White. Not shipping: Dark Heather, Heather Grey etc. (Kent's "Heather ..." names do not match Prodigi's) | pl1 23 SKUs at 8.00; nl2 45 SKUs 10.00-11.00. 68 SKUs |
| 18600 | GLOBAL-HOOD-GIL-18600 | 5787x4606 -> 490x390 (landscape: w > h) | none | 7: Ash, Black, Dark Heather Grey, French Navy, Royal Blue, Sport Grey, White | all pl1 at 25.00. 41 SKUs |
| 64200 | GLOBAL-TT-GIL-64200 | 2480x3507 -> 210x297 | 4680x5790 (30) | 7: Black, Charcoal, Heather Grey, Navy Blue, Red, Royal Blue, White (Kent: "white only") | pl1 5 SKUs at 12.00; **uk2 30 SKUs 9.54-11.92 (non-EU: customs)**. 35 SKUs |
| JH001F | HOOD-AWD-JH001F | 3070x3070 -> 260x260 | none | 18 (Airforce Blue, Arctic White, Ash, Black, Bottle Green, Burgundy, Charcoal, Fire Red, French Navy, Heather Grey, Hot Pink, Jade, Orange Crush, Plum, Purple, Red Hot Chili, Royal Blue, Sun Yellow) | **ALL 107 quoted from uk9 (non-EU) at 21.36-21.46; no EU lab quoted** |
| STAU773 | H-BAG-LTOTE | 3188x3188 -> 270x270 (slot `default`, no front/back) | none | 13: Anthracite, Black, Burgundy, Caribbean Blue, Cotton Pink, French Navy, Khaki, Natural Raw, Red, Royal Blue, Sky Blue, Spectra Yellow, White | **ALL 13 from uk9 at 11.87-11.92; no EU lab** |

Shipping per lab (single-item probes, SE): pl1 11.85 (+1.00 per extra), nl2 5.35 (+1.00), uk2 5.84 (+1.19), uk9 21.78 (+0), au3 21.46 (+7.46). uk9 shipping dominates the JH001F/tote economics (about 21.78 on top of 21.4 for a hoodie).

### Importer changes needed (this is where the new products differ)

- **18600 needs a third attribute `edge`.** Quotes without it fail `MissingRequiredAttributes` (400). Values: **Zip for white** (6 variants), **Drawstring for every other colour** (35). `edge: Zip` + ash/m answered `NotAvailable`, `Drawstring` quoted. The importer now carries `edge` into quote/catalogue attributes **only when a product lists more than one edge value** (so no other model changes). **U12's adapter cannot derive `edge` from the key**: read `attributes.edge` from the catalogue SKU entry (`skus[key].attributes`) or hard-code white=Zip. Caveat to confirm with a sandbox order: the colour/size matrix is what Prodigi lists; whether a white "Zip" and a coloured "Drawstring" are different physical hoodies is not stated by the API.
- **The tote has no `size`**, and its print area slot is `default`, not `front`. The importer keys it `H-BAG-LTOTE.<colour>.one-size`, sends no `size` in attributes, quotes with `printArea: "default"`, and puts the area in `front` of the model document. **U12 must send no size and `printArea: "default"` for it.** `splitSkuKey` returns size `one-size`, which the adapter must treat as "omit".
- `buildPricing` now leaves a model out of `applyPricingEur` when it has no EU-lab quote (JH001F, STAU773) instead of pricing it at 0.

## 3. Non-apparel (separate product class; NOT in the garment catalogue)

Source: `docs/cf-port/prodigi-nonapparel-2026-10-20.json` (print areas, attributes, the quote request and response summary). One Standard quote to SE, 1 copy, first SE-shippable variant, EUR ex VAT. All 23 SKUs answered 200 and ship to SE. "px" is the `default` print area as the API gives it.

| SKU | Variants (SE/all) | Print area px | Unit EUR | Shipping EUR | Lab |
|---|---|---|---|---|---|
| GLOBAL-POST-MOH-7X5 | 1/1 | 4322x1559 | 1.35 | 7.55 | prodigi_eu |
| GLOBAL-POST-MOH-6X4-BLA | 1/1 | 3708x1263 | 1.05 | 7.55 | prodigi_eu |
| GLOBAL-POST-GLOS-6X4 | 1/1 | 3708x1263 | 0.48 | 10.25 | prodigi_gb2 (UK) |
| GLOBAL-POST-GLOS-7X5 | 1/1 | 4322x1559 | 0.71 | 10.21 | prodigi_gb2 (UK) |
| M-STI-3X4 | 1/1 | 900x1200 | 0.95 | 8.96 | prodigi_gb2 (UK) |
| M-STI-5_5X5_5 | 1/1 | 1650x1650 | 2.97 | 8.96 | prodigi_gb2 (UK) |
| M-STI-8_5X8_5 | 1/1 | 2550x2550 | 5.34 | 11.52 | prodigi_gb2 (UK) |
| M-STI-14X14 | 1/1 | 4200x4200 | 7.72 | 11.52 | prodigi_gb2 (UK) |
| GLOBAL-BFP-5X7 | 2/2 | 1535x2125 | 11.87 | 31.99 | prodigi_gb3 (UK) |
| GLOBAL-BFP-11X14 | 2/2 | 3307x4192 | 17.00 | 13.95 | prodigi_eu |
| GLOBAL-BFP-12X16 | 1/1 | 3543x4724 | 19.00 | 13.95 | prodigi_eu |
| GLOBAL-BFP-16X20 | 2/2 | 4724x5905 | 24.00 | 13.95 | prodigi_eu |
| GLOBAL-BFP-18X24 | 2/2 | 5314x7086 | 28.00 | 13.95 | prodigi_eu |
| H-MUG-W | 1/1 | 2700x1119 | 5.34 | 5.88 | uk2 (UK) |
| GLOBAL-MUG-W | 1/1 | 2670x1110 | 5.07 | 5.88 | uk2 (UK) |
| ECO-CAN-8X8 | 4/4 | 2472x2472 (+ 3600x3600, 2400x2400) | 9.00 | 12.89 | prodigi_eu |
| ECO-CAN-16X16 | 4/4 | 4872x4872 (+ 6000, 4800) | 19.00 | 13.95 | prodigi_eu |
| ECO-CAN-8X12 | 4/4 | 2472x3672 (+ 3600x4800, 2400x3600) | 11.00 | 13.95 | prodigi_eu |
| ECO-CAN-20X30 | 4/4 | 6072x9072 (+ 7200x10200, 6000x9000) | 32.00 | 19.40 | prodigi_eu |
| ECO-CAN-16X24 | 4/4 | 4872x7272 (+ 6000x8400, 4800x7200) | 26.00 | 13.95 | prodigi_eu |
| ECO-FRA-CAN-8X8 | 24/24 | 2472x2472 (+ 3600x3600) | 22.00 | 12.89 | prodigi_eu |
| ECO-FRA-CAN-12X12 | 24/24 | 3672x3672 (+ 4800x4800) | 28.00 | 13.95 | prodigi_eu |
| ECO-FRA-CAN-16X16 | 24/24 | 4872x4872 (+ 6000x6000) | 38.00 | 13.95 | prodigi_eu |
| ECO-FRA-CAN-20X20 | 24/24 | 6072x6072 (+ 7200x7200) | 45.00 | 13.95 | prodigi_eu |
| ECO-FRA-CAN-20X30 | 24/24 | 6072x9072 (+ 7200x10200) | 55.00 | 19.40 | prodigi_eu |

Attributes: postcards `finish` (matte Mohawk / gloss), `paperType`, `substrateWeight`; stickers none; BFP `frame` Budget, `color` natural/white (12X16: white only), `glaze` Acrylic/Perspex, `mount` none, 150gsm silk (a `color` attribute is required on order); mugs `color` white, `size` 313ml / 11oz; eco canvas `wrap` (Black / ImageWrap / MirrorWrap / White, **required on order**), edge 38mm; framed eco canvas also `color` (6 values) and `wrap`. Several canvas SKUs list 2-3 print-area sizes (the 38 mm wrap needs bleed); a quote shows no area, so the studio rule "smallest" applies again.

Points to read before building the class:
- **Everything is shippable to SE.** The UK-printed items (gloss postcards, ALL stickers, mugs, BFP-5X7) are quoted from UK labs: customs/duty on EU-bound parcels and Royal Mail/DHL/DPD shipping apply. EU-printed (prodigi_eu): Mohawk postcards, BFP 11X14..18X24, all eco canvas.
- **Prices are far above Kent's "from" figures**: postcards 1.35 vs 1.00 GBP, stickers 0.95-7.72, mugs 5.34 (from 3.59), posters 17-28 (from 10), mostly because the "from" is the cheapest size/region.
- **Shipping dwarfs the unit cost on small items**: postcard 7.55-10.25 shipping on 0.48-1.35 product; a sticker 8.96-11.52 on 0.95-7.72. No multi-item discount was probed for these.
- The postcards' print areas (4322x1559, 3708x1263) are strange proportions for a 7x5/6x4 card (about 2.8:1): they look like a two-panel (front + message side) canvas. Check before building a postcard studio.

## 4. What is missing on Prodigi's side (for Kent)

| Kent's item | Status |
|---|---|
| Gildan 64400 long sleeve (NOW? "later") | exists, **US only**: cannot be sold to SE |
| Gildan 2200 tank | exists, **US + BR only**: cannot be sold to SE |
| Gildan 18000 sweatshirt (NOW) | exists, **US + BR only**: cannot be sold to SE. Alternative already in the catalogue: AWDis JH030 (sweatshirt, pl1/nl2) |
| Gildan 64200L (women's tank) | no such product; Prodigi sells the **unisex 64200** (added), 7 colours |
| Gildan 64000L colours | 14 of 15 ship; "Heather ..." colour names (Heather Orange, Heather Irish Green, Heather Purple) do not exist as such (Prodigi has Orange Heather) |
| Gildan 18600 colours | 7 of 7 ship; but see `edge` |
| JH001F, STAU773 | exist, ship to SE, but **only from UK labs (uk9)**: duty/shipping ~21.8 |

## 5. Verification

- `node --test scripts/cf-port/test/prodigi-catalog.test.mjs`: 18/18 green (4 new: SKU registration; 18600 `edge`; tote one-size/default slot; committed catalogue has the five models, 0 unquoted).
- `node guard/guards.test.mjs`: PASS (baseline 292).
- Catalogue: 14 models, 1,586 SKUs, 0 unquoted; one warning (360 SKUs quoted from a non-EU lab: au3, uk2, uk9).
- Dating: the 9 original models' quotes are from 2026-10-19; the five new ones from 2026-10-20. The pricing sibling `docs/cf-port/prodigi-pricing-2026-10-20.json` is stamped 2026-10-20 and covers all 14 (the 10-19 file stays as the history of the first nine).

## 6. Re-run

```
PRODIGI_API_TOKEN="$(grep -oE 'test_[0-9a-f-]{36}' docs/cf-port/HANDOVER.md | head -1)" PRODIGI_QUOTE_DATE=2026-10-20 node scripts/cf-port/prodigi-catalog.mjs --only=64000L,18600,64200,JH001F,STAU773
```
`--offline` rebuilds from the saved samples (`PRODIGI_QUOTE_DATE=2026-10-20 node scripts/cf-port/prodigi-catalog.mjs --offline`). About 5 minutes. The non-apparel probe was a scratch script (one product read + one quote per SKU, retrying with the variant's full attributes when the first quote fails); its output is the JSON above.
