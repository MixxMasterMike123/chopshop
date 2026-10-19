claude-sonnet-5-5

# CP11 U4 report: the Prodigi catalogue importer (2026-10-19)

Built: `scripts/cf-port/prodigi-catalog.mjs`, `scripts/cf-port/test/prodigi-catalog.test.mjs` (14 tests, fixtures only, `node --test` green), `docs/cf-port/prodigi-catalog.json` (the catalogue, 9 models / 1,322 SKUs, 291 KB stored), `docs/cf-port/prodigi-pricing-2026-10-19.json` (the pricing sibling), `docs/cf-port/prodigi-api-samples/` (18 raw responses, 2.9 MB, nothing stripped but the key, which is never written). Nothing under `cloudflare/` touched. `node guard/guards.test.mjs`: PASS (2583 files scanned, baseline 292).

## Where the brief was wrong (build what is right)

1. **A Prodigi SKU is a product, not a colour x size.** Colour and size are `attributes` of an order item (`{ color: "black", size: "m" }`) and of a quote item. "SKU key = Prodigi's SKU string" would collapse 1,322 variants into 9 keys. The catalogue key is therefore `<prodigiSku>.<colour-slug>.<size>`, e.g. `GLOBAL-TEE-GIL-64000.black.m` (inside the Worker's `[A-Za-z0-9._-]{1,64}` grammar; the longest key is under 64, the script refuses longer). **U12's adapter must split the key**: sku = text before the first `.`; size = text after the last `.`; colour = the middle with `-` replaced by a space (the script warns if any colour does not survive that round trip: none of the 9 models warns). The Worker's capability document keeps only `{model, label}`, so the key is the only carrier of the attributes at dispatch time. `splitSkuKey()` in the script is the reference implementation.
2. **The Creator is `TEE-SS-STTU755`, not `...STTU169`.** The page titled "Stanley/Stella Creator 2.0 STTU169" lives at `.../stanley-stella-creator-sttu755/`. `TEE-SS-STTU169` answers 200 but is a single US-only variant (no quote for SE possible); `TEE-SS-STTU755` has 367 variants shipping to SE. Our model key stays `STTU169`.
3. **SS products carry no `GLOBAL-` prefix** (Stanley/Stella: `TEE-SS-…`, `HOOD-SS-…`).
4. **Quotes need `attributes`** to price a colour x size; without them the quote is for no specific variant. Quote items also give no print-area information.
5. **`applyCatalog` prices a MODEL, not a SKU** (see below), and requires the printer row to be priced in SEK.

## SKU discovery (every string tried; `GET /products/{sku}` on the sandbox)

| String | Answer |
|---|---|
| GLOBAL-TEE-GIL-64000 | 200 |
| GLOBAL-TEE-GIL-5000 | 200 |
| GLOBAL-TEE-GIL-2000 | 200 |
| GLOBAL-TEE-GIL-64V00 | 200 |
| GLOBAL-TEE-BC-3001 | 200 |
| GLOBAL-HOOD-GIL-18500 | 200 (first guess GLOBAL-HOD-GIL-18500: 404) |
| GLOBAL-HOOD-AWD-JH001 | 200 (GLOBAL-HOD-AWD-JH001: 404) |
| GLOBAL-SWEAT-AWD-JH030 | 200 (GLOBAL-SWE-AWD-JH030: 404) |
| TEE-SS-STTU755 | 200 (used for model STTU169) |
| TEE-SS-STTU169 | 200 but US-only, single variant: unusable |
| TEE-SS-STTU755, HOOD-SS-STSU822 | 200 (the latter not used) |
| GLOBAL-TEE-STTU169, -STS-, -SS-, -STA-, -STL-, -STSTE-, -STT-, -SST-, -S-STTU169; GLOBAL-TSHIRT-SS-STTU169; GLOBAL-TEE-SS-STTU755; GLOBAL-HOOD-SS-STSU822 | 404 |

Sources: prodigi.com product pages (SKU table; the SS SKU pattern from the Cruiser page `HOOD-SS-STSU822`).

## Models: garment, SKU and frames

`front`/`back` are the same size for every model. mm = round(px / 300 x 25.4), `offsetTopMm: 0` (Prodigi places the file with `sizing: "fitPrintArea"`; there is no collar offset). Garment vocabulary: `tee`, `hoodie`, `sweatshirt`.

| Model | Prodigi SKU | garment | frame used (px, smallest SE-shipping variant) | mm w x h | other px sizes among SE variants |
|---|---|---|---|---|---|
| 64000 | GLOBAL-TEE-GIL-64000 | tee | 2480x3507 | 210x297 | 4677x5881 (87), 4665x5844 (5) |
| 5000 | GLOBAL-TEE-GIL-5000 | tee | 2480x3507 | 210x297 | 4677x5881, 4665x5844, 4680x5790, 3600x4800 |
| 2000 | GLOBAL-TEE-GIL-2000 | tee | 3307x4606 | 280x390 | none |
| 64V00 | GLOBAL-TEE-GIL-64V00 | tee | 4680x5790 | 396x490 | 4677x5881 |
| BC3001 | GLOBAL-TEE-BC-3001 | tee | 2480x3507 | 210x297 | 4680x5790, 4677x5881 |
| STTU169 | TEE-SS-STTU755 | tee | 3307x4606 | 280x390 | 4677x5881 (178) |
| 18500 | GLOBAL-HOOD-GIL-18500 | hoodie | 3307x4606 | 280x390 | none |
| JH001 | GLOBAL-HOOD-AWD-JH001 | hoodie | 2480x2480 | 210x210 | 3186x3186, 3188x3188 |
| JH030 | GLOBAL-SWEAT-AWD-JH030 | sweatshirt | 4606x5787 | 390x490 | none |

**OPEN QUESTION for the reviewer (the biggest risk in this unit).** Prodigi lists several regional *variants* per colour x size. The EU-region variant (shipsTo = 30 countries) carries an A4-sized area (2480x3507, identical to its sleeve and neck-label areas, which looks like a placeholder), the global variants carry 4665-4677 x 5844-5881. The handover's "64000 = 4665x5844 = 395x495 mm" is the global figure. The API does not say which variant a Swedish order is printed on, nor does a quote. I chose the **smallest** area (rule `modelFrame()`): a canvas built to it can never exceed any variant's area, so `fitPrintArea` only places it; the cost of being wrong is a smaller printable frame for 64000, 5000 and BC3001 than the lab may really allow. The alternative (largest) risks the lab shrinking the design relative to what the studio showed. `printAreaVariants` per model in the document lists every size and its variant count, so the reviewer can override with `frames` at apply time or change the rule in one function. To settle it: open sandbox order `ord_1186010` (64000 + 18500) in `sandbox-beta-dashboard.pwinty.com` and read the print-ready asset size, or ask Prodigi support.

## Quote table (sandbox, SE, Standard, 1 copy, EUR ex VAT, 2026-10-19)

1,322 SKUs quoted, 0 unquoted. Unit cost includes one front print; back print is free (every quote's additional costs are 0.00). Per-SKU `unitCostMinor` and `lab` sit on each SKU entry of the catalogue (the pricing basis is capped at 16 KiB, so per-SKU data cannot live there).

| Model | pl1 (PL) | nl2 (NL) | non-EU lab quoted (uk2/uk9/au3) |
|---|---|---|---|
| 64000 | 144 SKUs at 8.00 | 10 at 10.68-11.00 | 10 |
| 5000 | 147 at 8.00 | 39 at 10.00-12.00 | 29 |
| 2000 | 84 at 13.00 | none | 0 |
| 64V00 | none | 54 at 10.00-11.00 | 1 |
| BC3001 | 25 at 10.00 | 107 at 10.00-25.00 | 10 |
| STTU169 | 189 at 14.00 | none | 76 |
| 18500 | 134 at 20.00 | none | 0 |
| JH001 | 87 at 20.00 | 20 at 21.00 | 63 |
| JH030 | 44 at 20.00 | 25 at 17.00 | 24 |

Shipping, from single-item probes per lab: **pl1 first item 11.85, nl2 5.35, +1.00 per extra item** (both confirmed by 1- and 2-copy quotes). Non-EU labs: uk2 5.82 (+1.18), uk9 21.78 (+0), au3 21.46 (+7.46). 213 SKUs were quoted from a non-EU lab (UK or Australia) at quote time: customs/duty and different shipping apply. They stay in the catalogue with `lab` named; the document carries a warning. Prices and labs move with stock: a quote today is not a promise (the handover's black M 64000 was PL 8.00, today's black M quotes nl2 11.00).

## What applyCatalog can and cannot take

- **PUT body**: `{ catalog, source, pricingBasis }`. `catalog` = the file minus `pricingBasis`; `pricingBasis` (2.8 KB, inside the 16 KiB cap) = currency EUR, quote date, `shippingCostMinor` 1185 (PL first item), `shippingByLab`, `extraItemMinor` 100, the VAT note, per-model min/max by EU lab. Verified by bundling the real `parseCatalogPutInput` and `buildFromCatalog` (esbuild, scratch only): PUT parses ok (291,236 bytes of 1 MiB), a models-selection with `pricing: { basis: "keep" }` builds 1,322 SKUs / 9 models. Extra keys in catalogue entries (`prodigiSku`, `attributes`, `unitCostMinor`, `lab`, `printAreaPx`) are ignored by the builder, which reads only `model`, `colour`, `size`, `garment`, `name`, `front`, `back`.
- **Taken**: models (garment, name, front/back frames), SKUs with label `"<Colour> / <SIZE>"`, e.g. `Black / M`.
- **Cannot take**: per-SKU or per-lab cost. `basis: "eur"` prices a MODEL (`baseEurCents`, one price for all its SKUs) and converts to SEK; `basis: "sek"` likewise. So colour-dependent and NL-versus-PL prices collapse to one figure per model. The sibling `prodigi-pricing-2026-10-19.json` holds `applyPricingEur`: `{ basis: "eur", extraPrintEurCents: 0, printSlots: ["front","back"], models: { code: { baseEurCents } } }` with the HIGHEST EU-lab unit cost per model (64000 1100, 5000 1200, 2000 1300, 64V00 1100, STTU169 1400, 18500 2000, JH001 2100, JH030 2000, BC3001 2500). `eurSek` and `bufferBp` are for the platform to add. Note BC3001's 25.00 is a few colours; use `frames`/model choices or per-model override to avoid pricing every BC3001 tee at 25 EUR (most are 10.00-12.00).
- **Cannot take**: the printer row must be priced in SEK or `applyCatalog` refuses an `eur`/`sek` basis (`invalid_selection`); the Prodigi printer row therefore needs `currency: "SEK"` for pricing via the catalogue, or use `basis: "keep"` and edit tiers by hand. The `provider` field (U12) is not in the catalogue document.
- **Not carried anywhere**: the lab pinning (impossible), sleeve/neck areas (front/back only, as the brief says).

## What the script cannot know

Sizes/colours Prodigi lists but does not ship to SE are excluded (a `shipsTo` filter on `SE`); stock is not visible (a listed SKU may quote from a far lab or be out of stock at order time); the lab can change between quote and order; the true print area per variant (open question above); that `fitPrintArea` centres the file.

## Re-run

```
PRODIGI_API_TOKEN="$(grep -oE 'test_[0-9a-f-]{36}' docs/cf-port/HANDOVER.md | head -1)" PRODIGI_QUOTE_DATE=2026-10-19 node scripts/cf-port/prodigi-catalog.mjs
```
Full fetch is about 13 minutes (the sandbox answers a quote in 3-10 s; the script throttles to 2 req/s and retries a 429 once). Variants: `--offline` rebuilds from the saved samples with no network; `--only=STTU169,JH001` re-fetches those models only; `--probe` adds the shipping probes to the saved quote logs. The key must start with `test_` (otherwise the script refuses unless `--live`, which this unit never used) and is never logged or written. Tests: `node --test scripts/cf-port/test/prodigi-catalog.test.mjs`.
