# CP2-C — POD product path: report

Builder: CP2-C (branch `cf-port`, worker `cloudflare/`). Scope: PLAN §2.3 ("Production eligibility at checkout"), §2.4, §2.5, §10 row CP2; DECISIONS D8; LAUNCH_TODO A1–A4, A10, A11, A13; PRISGOLV.
No git state was changed and no wrangler command was run.

## 1. What was built

| Step | Result |
|---|---|
| 1 Printers + tiers + mappings | `0023` (printers, printer_sku_tiers, pod_mappings, `checkouts.production_snapshot_json`); `src/pod/printers.ts`; `PUT /v1/platform/printers` |
| 2 quotePodCost + PRISGOLV | `src/pod/pod-quote.ts`; `GET /v1/admin/pod/quote` returns ONE number + the floor |
| 3 Mapping routes | `src/pod/pod-mappings.ts`, `src/routes/pod-admin.ts`: POST/GET/DELETE `/v1/admin/pod/mappings` (+ `GET /v1/admin/pod/printers`) |
| 4 Screening | `0024`; `src/catalog/screening-core.ts` (pure port), `src/catalog/screening.ts` (D1, same-batch statements, platform decision) |
| 5 Publish gate + eligibility + catalog_version | `src/catalog/eligibility.ts` (THE predicate), gate in `publishAdminProduct`/`updateAdminProduct`, `0025` (takedown_at, delete trigger, catalog_version by trigger, tenants.published), `src/storefront/public-routes.ts` (ETag/304 handlers) |
| 6 Storefront POD fields | `product.pod = { printAreas, previewUrls }` on the public detail; preview route `GET /v1/storefront/pod-previews/:productId/:artworkId` |
| 7 Checkout snapshot | `freezeProductionSnapshot` in `src/commerce/checkout.ts`; eligibility recomputed from current facts; any miss refuses |

Files touched (all within the ownership list): `migrations/0023–0025`, `src/catalog/{admin-catalog,public-catalog,eligibility,screening,screening-core}.ts`, `src/pod/{printers,pod-quote,pod-mappings}.ts`, `src/pod/artwork-store.ts` (delete guard), `src/commerce/checkout.ts`, `src/storefront/{public-storefront,public-routes}.ts`, `src/routes/pod-{admin,platform,storefront}.ts`, `src/app.ts` (imports + the `CP2-ROUTES-C` block only), tests `test/{pod-fixtures,pod-mappings.test,pod-publish.test,screening.test}.ts` (new) and `test/{admin-catalog,public-catalog,checkout}.test.ts` (adapted). `src/env.d.ts` and `vitest.config.ts` needed no change.

## 2. Schema

**0023_pod_printers_mappings.sql**
- `printers(id PK [a-z0-9-], tenant_id NULL=platform, type 'api'|'manual', name, status 'active'|'inactive', currency, shipping_cost_minor (platform-only), capabilities_json, created_at/updated_at ISO)` — tenant immutable trigger, `(tenant_id, status)` index. `capabilities_json = { models: { <model>: { garment, name?, printAreasMm: { front|back|pocket|left_sleeve|right_sleeve: {w,h,offsetTopMm?} } } }, skus: { <sku>: { model, label? } } }`.
- `printer_sku_tiers(printer_id FK, tenant_id (mirror of the printer's, trigger-pinned), sku, blank_cost_minor, print_costs_json {slot: minor}, … PK(printer_id, sku))` — platform-only readable: no tenant route selects it.
- `pod_mappings(id, tenant_id, product_id FK, variant_id FK NULL, artwork_id FK, printer_id FK, sku (printer SKU), slots_json [{slot,widthMm,heightMm}], status 'active'|'inactive'|'suspended', suspended_reason, created_at/updated_at ISO, UNIQUE(product_id, artwork_id, printer_id, sku))` — triggers: tenant immutable, identity immutable, product/artwork tenant match, variant belongs to product, printer is platform-or-own; indexes `(tenant_id, product_id, status)`, `(tenant_id, artwork_id)`, `(printer_id, status)`.
- `checkouts.production_snapshot_json` (JSON object or NULL) + trigger `checkouts_production_snapshot_frozen`: may only be purged to NULL, never rewritten or filled later.

**0024_product_screening.sql**
- `product_screening(product_id PK FK, tenant_id, status 'pending'|'approved'|'flagged'|'blocked'|'advisory', reason (code), hits_json, earlier_hits_json, requires_approval 0|1, decided_by ('system' | platform user id), decided_at, version, created_at, updated_at)` — tenant immutable + tenant-match + version-monotonic triggers; `(tenant_id, status)` and `(status, decided_at)` indexes.
- `content_screening_terms(term PK, kind, hard_block, created_at)` — the platform blocklist (empty until CP3's settings route; then only D8 applies, like Firebase with no settings doc).

**0025_takedown_catalog_version.sql**
- `products.takedown_at` (ISO) + `products_takedown_no_delete` BEFORE DELETE trigger.
- `tenants.catalog_version INTEGER NOT NULL DEFAULT 1`, `tenants.published INTEGER NOT NULL DEFAULT 1` (the §2.4 go-live gate; writer = CP3).
- 13 `catalog_version_*` AFTER triggers: products (update), product_publications (ins/upd/del), product_variants (ins/upd/del), pod_mappings (ins/upd), product_screening (ins/upd), printers (update → every tenant mapped to it), tenants (update OF status, published, shop_name, default_locale, default_currency). The bump is therefore inside the same statement/batch as every eligibility transition, whichever code path writes it (incl. `setTenantStatus`, which is not mine).

## 3. Routes (exact JSON)

All tenant-admin routes: live session + `X-Shop-Id` membership guard, same-origin on non-GET; every guard failure and unknown/foreign id = the opaque `404 {"error":{"code":"not_found","message":"Route not found"}}`.

- `GET /v1/admin/pod/printers` → `200 {"printers":[{"printerId","name","capabilities":{"models":…,"skus":…}}]}` (capability only).
- `POST /v1/admin/pod/mappings` body `{"productId","artworkId","printerId","sku","slots":["front","back",…],"variantId"?:string|null}` →
  `201` (new) / `200` (re-activated tuple) `{"mapping":{"mappingId","productId","variantId","artworkId","printerId","sku","slots":[{"slot","widthMm","heightMm"}],"status":"active","suspendedReason":null,"createdAt","updatedAt"},"inkopMinor":n,"priceFloorMinor":n,"currency":"SEK"}`;
  `422 {"error":{"code":"artwork_not_ready|printer_unavailable|sku_unavailable|slot_not_printable|resolution_too_low|unpriced|currency_mismatch|price_below_floor",…}}`;
  `409 {"error":{"code":"slot_taken|sku_mismatch|variant_mismatch|product_archived|conflict",…}}`; `400` malformed; `404` unknown/foreign product/variant/artwork.
- `GET /v1/admin/pod/mappings[?productId=]` → `200 {"mappings":[mapping…]}` (all statuses).
- `DELETE /v1/admin/pod/mappings/{id}` → `204` (soft: `inactive`; idempotent), `404` unknown/foreign.
- `GET /v1/admin/pod/quote?productId=…[&variantId=…]` → `200 {"inkopMinor":n,"priceFloorMinor":n,"currency":"SEK"}`; `422 {"error":{"code":"not_quotable"}}`; `404`.
- `PUT /v1/platform/printers` (platform session, same-origin; **dark 404 unless** `DISPATCH_TARGET` is `snapwear`, or `fake-printer` with `APP_ENV=staging`) body `{"printers":[{"printerId","type","name","status","currency","shippingCostMinor","capabilities",…,"tiers":[{"sku","blankCostMinor","printCostsMinor":{slot:n}}]}]}` → `200 {"printers":[{"printerId","type","name","status","currency","skuCount","pricedSkuCount"}],"suspendedMappings":n}`; `400` malformed or env policy (an `api` printer must BE the env's target; every SKU ∈ `SNAPWEAR_SKUS`); `409` id taken by a tenant printer. Replace-all: unlisted platform printers → `inactive`; listed printers' tiers replaced; active mappings the new document cannot honour → `suspended` (same batch).
- `GET /v1/platform/screening[?status=pending|approved|flagged|blocked|advisory]` → `200 {"screening":[{"productId","tenantId","productName","status","reason","hits","decidedBy","decidedAt","version","takenDown"}]}` (default: pending+flagged+blocked, oldest first, ≤ 100).
- `POST /v1/platform/screening/{productId}` body `{"decision":"approved"|"blocked"}` → `200 {"screening":{…same…}}`; `approved` clears `requires_approval` and lifts a takedown; `blocked` = takedown (`takedown_at` stamped). `400` bad decision, `404` unknown product.
- `GET /v1/storefront/pod-previews/{productId}/{artworkId}` (storefront host) → `200 image/webp` (private-bucket bytes), `ETag: "<preview sha256>"`, `Cache-Control: no-cache`, `304` on `If-None-Match`; `404` unless the product passes THE predicate and an active mapping prints that artwork.
- Public product detail (`/v1/products/:id`) gains `"pod": null | {"printAreas":[{"slot","widthMm","heightMm"}],"previewUrls":["/v1/storefront/pod-previews/<p>/<a>"]}`.
- Admin product responses gain `"isPod": boolean, "screeningStatus": null|"pending"|"approved"|"flagged"|"blocked"|"advisory"`.

Denylist: `test/pod-fixtures.ts expectNoCostKeys` walks every key (case-insensitive substrings `productioncost, withhold, supplier, cut, printcost, tier`) of: mapping POST/GET, quote, admin printers, admin product create/PATCH/publish, platform printers PUT, platform screening GET/POST, public detail/list/storefront, checkout (function + HTTP). The checkout test also asserts the body has none of `r2Key`, `pod/`, `printFiles`, `withhold`, the printer SKU or printer id.

## 4. Ported formulas (Firebase refs)

- **quotePodCost** — `functions/src/pod/quotePodCost.ts` → `functions/src/print/printRouting.ts` `quoteRoutedCost` (L190–203) over `tierCostForSlots` (L158–172) + `PLATFORM_CUT_SEK = 40` (L32): `unit = blank + Σ print[slot] + 40 kr` (ex VAT, per ITEM — one blank, cut once), `productionCostMinor = unit × quantity`. Routing (`resolvePrinterUid` L93–117) is replaced by the mapping's explicit printer + SKU; an inactive printer quotes null as before. **Divergence (fail closed):** Firebase counted an unpriced slot as 0; here it makes the quote null (would under-withhold, A1).
- **PRISGOLV** — `src/wagons/pod-wagon/podPricing.js` L33–34, L69–73: `ceil((cost·(1+vat) + 5) / (1 − 0.08))` kr. Ported in exact integer öre: `floorKr = ceil((cost·(10000+vatBp) + 500·10000) / (100·(10000−800)))`, `floorMinor = floorKr·100`, vat = the tenant's `vat_rate_bp` (PublishPanel passes the shop's vatRate). Verified equal to the JS float formula for every whole-kronor cost 0–100 000 kr (the only costs Firebase ever produced); at öre granularity the float version over-rounds by 1 kr in 69 of 500 000 cases, the integer one is exact. Enforced like PublishPanel.jsx L169–195 / ProductForm.jsx L416, L763–767: at publish (every sellable unit: the variants, else the product), on a PATCH of a POD product's price, and on a mapping change to a LIVE product.
- **Withholding** — `functions/src/payment/productionWithholding.ts` L69–140: Σ(item cost × qty) + printer shipping once per printer, × 1.25 (`DEFAULT_PRODUCTION_VAT_RATE`, L34), rounded to öre ONCE at the end. `withholdMinorFor(c) = floor((c·12500 + 5000)/10000)`.
- **decideScreening** — `functions/src/catalog/contentScreening.ts` L172–217, verbatim (all Firebase parity cases from `rules-tests/content-screening-parity.test.cjs` pass); matcher `foldText/tokenize/findScreeningHits` L26–94 verbatim (texts adapted: name, description, artwork original file name — CF has no tags/b2c descriptions/artwork label). `productUsesMappingSku` (L121) becomes `productUsesMapping` = FK equality: a CF mapping carries the product id (and its `sku` is the printer's), so the SKU-membership join Firebase needed collapses to "the mapping names the product".
- **Slot capability** — `isSlotPrintableInAreas` (printRouting.ts L132–140), fail closed: unknown SKU, model without frames, and `other` are "cannot print" (Firebase: ungated). Pocket = 100×100 (POD_PRINT_SPEC §1) clamped into the front frame.
- **Slot size** — contain-fit of the artwork (verdict `width_px/height_px` from render-jobs.ts) in the printer frame (render/src/pipeline.ts `maxPrintMmFor` geometry), capped at the width where it holds the artwork profile's `min_dpi` (default 300), floored to whole mm.

## 5. D8 on the state machine

The Firebase machine runs unchanged; `overlayDecision` maps its status to the CF vocabulary: review→pending, ok→advisory, flagged→flagged, blocked→blocked, cleared→approved, taken_down→blocked (+`takedown_at`). `requires_approval` is set on a product's FIRST screening when the shop has < 2 OTHER publicly-eligible products (Firebase counted the live set; pending products are not live, so publishing dummies does not clear the rule) and is cleared only by a platform approval; while set, every automatic outcome short of a block is `pending`. Screening runs only for LIVE products (published + active — Firebase `isLive`), synchronously, as statements appended to the mutating batch: publish, product update (text), mapping create/delete. The write is guarded on the version it read, so a seller edit never overwrites a platform decision it did not see. The machine's `deactivate` is realised by the predicate (`blocked` is never public) rather than by flipping the product.

## 6. THE eligibility predicate (`src/catalog/eligibility.ts`)

```sql
FROM product_publications AS publication
INNER JOIN products AS product ON product.product_id = publication.product_id AND product.tenant_id = publication.tenant_id
INNER JOIN tenants AS tenant ON tenant.tenant_id = product.tenant_id
LEFT JOIN product_screening AS screening ON screening.product_id = product.product_id AND screening.tenant_id = product.tenant_id
WHERE …
      publication.published = 1
  AND product.status = 'active'
  AND product.takedown_at IS NULL
  AND tenant.status = 'active'
  AND tenant.published = 1
  AND (screening.status IS NULL OR screening.status IN ('approved', 'advisory', 'flagged'))
  AND (product.is_pod = 0 OR EXISTS (SELECT 1 FROM pod_mappings m JOIN printers p ON p.id = m.printer_id
        WHERE m.tenant_id = product.tenant_id AND m.product_id = product.product_id
          AND m.status = 'active' AND p.status = 'active'))
  AND NOT EXISTS (SELECT 1 FROM pod_mappings s WHERE s.tenant_id = product.tenant_id
        AND s.product_id = product.product_id AND s.status = 'suspended')
```

Used by the product list, product detail, POD preview route, checkout line resolution and the D8 live count.

## 7. Checkout snapshot (the shared contract)

Frozen in the checkout INSERT for carts with POD lines (`products.is_pod = 1`, sticky once a product is first mapped); NULL otherwise. Per POD line, from current facts: active mapping set for the line's scope (variant's own set, else product-level), one printer + one SKU, no suspended mapping, printer active and (when the caller names it) == the env's dispatch target and one of `fake-printer|snapwear`, SKU + every slot still framed and large enough, every artwork `ready` with its print master under `pod/{tenant}/print/`, SKU priced for every slot, one printer per order, printer currency == checkout currency, `totals.withholdMinor ≤ total_minor`. Any miss → `invalid_items` (the route's existing opaque **422**, the same answer as any unresolvable line — the task text said "404 opaque"; see Q5). Shape, verbatim from the test:

```json
{"printer":"fake-printer",
 "lines":[{"lineNo":2,"sku":"2700003","quantity":2,
   "printFiles":[{"slot":"front","r2Key":"pod/<t>/print/<a>.png","sha256":"…","widthMm":299,"heightMm":399},
                 {"slot":"back", "r2Key":"pod/<t>/print/<b>.png","sha256":"…","widthMm":299,"heightMm":399}],
   "productionCostMinor":36000,"withholdMinor":45000}],
 "totals":{"productionCostMinor":40900,"withholdMinor":51125}}
```

`lineNo = item_index + 1` (only POD items appear; a mixed cart skips numbers). `totals.productionCostMinor` = Σ lines + the printer's `shipping_cost_minor` once; `totals.withholdMinor` is authoritative (rounded once) — per-line `withholdMinor` is informational. CP2-A's `payment.ts` reads `totals.withholdMinor`, CP2-B's dispatcher reads `lines[].lineNo/sku/printFiles` (checked against their current code).

## 8. `src/app.ts` — consolidation patches (outside my anchor, NOT applied)

The existing handlers live outside the `CP2-ROUTES-C` block, and Hono dispatches in registration order, so routes mounted in my anchor cannot shadow them. Behaviour today, fail-closed: a refused publish/PATCH answers **404** (the `adminResultResponse` fallthrough) and publishes nothing; public reads carry no ETag; a mapped artwork's DELETE answers 404. Four patches for the reviewer:

1. `adminResultResponse`, before the `conflict` branch:
   ```ts
   if (result.status === "refused") {
     return jsonResponse({ error: { code: result.code, message: "Product cannot be published" } }, 422);
   }
   ```
2. Public reads with `ETag: "<catalog_version>"`/304 (import from `./storefront/public-routes`):
   ```ts
   app.all(STOREFRONT_PATH, getOnly(storefront((c) => handlePublicStorefrontRequest(c.env, c.req.raw))));
   app.all(PRODUCTS_PATH, getOnly(storefront((c) => handlePublicProductsRequest(c.env, c.req.raw))));
   app.all(`${PRODUCT_PATH_PREFIX}*`, getOnly(storefront((c) =>
     handlePublicProductRequest(c.env, c.req.raw, productIdFromPath(new URL(c.req.url).pathname)))));
   ```
   Bodies are byte-identical to today's; 404s unchanged.
3. `handleCheckoutRoute`: `createCheckout(env.DB, tenant, input, now, { dispatchTarget: dispatchTargetOf(env) })` (import from `./pod/printers`). Without it the freeze still requires `fake-printer|snapwear`, which only the env's own seed can create; with it a POD line must route to exactly the env's target and an env with no target refuses POD carts.
4. `handleAdminPodRoute` DELETE: `if (deleted.status === "conflict") return jsonResponse({ error: { code: "conflict", message: "Artwork is used by a POD mapping" } }, 409);`

## 9. Decisions taken (defaults, flag if wrong)

- **Preview delivery = a worker path, not a signed URL.** The PDP body is ETag-cached by `catalog_version`; a per-request presigned URL would make every body different and expire inside a 304-revalidated cache. The path re-checks THE predicate per request (a takedown stops the image at once), reads only `pod/{tenant}/preview/` keys, never the print master. CP4's public-bucket copy replaces it.
- **Screening row missing = advisory.** Only rows written outside `publishAdminProduct` (fixtures, a future import) lack one; other builders' suites seed publications by SQL, and a stricter rule would break them. The CP3 import must write rows.
- **Artwork delete refused while any mapping row references it** (mapping rows are never hard-deleted), so a print master a frozen snapshot/order may still need cannot disappear; hence artwork delete needs no rescreen. CF artwork has no rename/replace (immutable verdicts), so those §2.4 triggers have no CF counterpart.
- **A suspended mapping blocks the whole product** (public, publish, freeze) until the seller re-posts or deletes it — found by the test suite: otherwise a front+back product whose back frame vanished sold the front alone.
- **Per-variant mapping sets** (`variant_id`, not in the task's column list) — a SnapWear SKU is per colour+size, so a sized garment needs one SKU per variant. UNIQUE stays the task's `(product_id, artwork_id, printer_id, sku)`.
- **Printer shipping** is in `totals` only (contract shape unchanged).

## 10. Counts

- Baseline: `npm run check` green, **34 files / 1257 tests**.
- CP2-C adds **88 tests** (screening 45, pod-mappings 26, pod-publish 17) and adapts 7 existing assertions (admin-catalog 4, public-catalog 1, checkout 2 — the 0009 schema-survival lists became `arrayContaining` because CP2-A and CP2-C add triggers/indexes to `checkouts`).
- Full check after (shared tree, others mid-build) — see the tail below.

Final run (2026-09-27 01:51, shared tree with CP2-A/B mid-build):

```
> npm run types:check   ✨ Types at worker-configuration.d.ts are up to date.
> npm run build (tsc)   1 error — src/commerce/admin-orders.ts(130,7) TS2353 'productionMinor'
                        (CP2-A's file, work in progress; zero errors in CP2-C files)
> npx vitest run        Test Files  45 passed (45)
                             Tests  1583 passed (1583)
                          Duration  67.86s
```

Earlier full `npm run check` runs in this session were green on types + build; their only test failures were other builders' suites caught mid-edit (`test/outbox.test.ts`, `test/payment-connect.test.ts`), each green when re-run. `node guard/guards.test.mjs`: PASS, and a manual grep of every CP2-C file for `<the guard's forbidden patterns>|from 'firebase` is empty.

## 11. Open questions

1. **Apply the four `src/app.ts` patches (§8)** at consolidation — especially #1 (422 codes to the admin UI) and #2 (ETag).
2. **Blocklist + `reviewFirstProducts` settings** are CP3 (`content_screening_terms` has no write route; N=2 is a constant `REVIEW_FIRST_PRODUCTS`). Seed the 63 Firebase terms with the CP3 import?
3. **Print placement** (A5): slot size = largest contain-fit at ≥ min DPI inside the printer frame; no seller-chosen size/offset until the CP6 studio. `offsetTopMm` is carried in capabilities, not yet in the snapshot. OK for CP2?
4. **Tier price edits vs live prices**: a PUT that raises a SKU's price can leave live products under the new floor (Firebase has the same gap). Suspend, warn, or leave to the next publish?
5. **"404 opaque" vs 422**: a production-ineligible cart answers the checkout route's existing opaque 422 (`unprocessable`), identical to any unresolvable line. Keep, or special-case to 404?
6. **Mapping delete on a live product with variants**: removing the product-level set of a product whose variants have their own sets keeps it public (variants still producible). Intended?
7. **Seeding**: the SnapWear capability document for `PUT /v1/platform/printers` must be built from `docs/SnapWearDocs/snapwear-catalog.json` (models' front/back frames → `printAreasMm`, skus → `{model,label}`) plus the tier table (Firebase seed: blank per garment, 40 kr per print — expand per SKU). Who writes that script (CP2 seed or CP3)?
