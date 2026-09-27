# CP3-C — Printers: report

Builder: CP3-C (branch `cf-port`, worker `cloudflare/`). Scope: CP3_GAP_ANALYSIS §1c, §1h rows 6–7, §4; DECISIONS D12, D41, D45, D52, D59.
No git state was changed, no wrangler command was run, nothing touched the network.

## 1. What was built

| Brief item | Result |
|---|---|
| Platform read | `GET /v1/platform/printers` (paged) and `GET /v1/platform/printers/:id`: every stored field, tiers with prices, shipping, revision, catalogue fingerprint, default flag |
| Partial edit | `PATCH /v1/platform/printers/:id`: name, status, shipping, whole capability document, tier upserts/removals. Shares one core (`editPrinter`) with the catalogue apply |
| Default printer | `GET/PUT /v1/platform/printers/default` + table `print_defaults` (single row) |
| Catalogue | `GET/PUT /v1/platform/printers/:id/catalog` + table `printer_catalog` (sha256), `POST …/catalog/apply` (dry run by default) |
| Tenant view | `GET /v1/admin/pod/printers` gains `garments` + `provisionalAreas`, built by allowlist |
| Hardening found on the way | tenant-facing refusal codes and mapping reasons that revealed the pricing structure are translated (§8, deviation 3) |

Files (all inside the ownership list):
- `cloudflare/migrations/0035_print_defaults.sql` (new)
- `cloudflare/src/pod/printers.ts` (extended), `cloudflare/src/pod/print-defaults.ts` (new), `cloudflare/src/pod/printer-catalog.ts` (new)
- `cloudflare/src/routes/pod-platform.ts` (CP3 section appended; CP2 handlers byte-identical), `cloudflare/src/routes/pod-admin.ts`
- `cloudflare/src/app.ts`: only inside `CP3-IMPORTS-C` and `CP3-ROUTES-C`
- `cloudflare/test/printers-platform.test.ts`, `print-defaults.test.ts`, `printer-catalog.test.ts` (new); `cloudflare/test/pod-fixtures.ts` (additions only, no existing helper changed)
- `docs/cf-port/CP3_C_REPORT.md`
- Review round 1 (§14): `cloudflare/src/pod/pod-mappings.ts` (only `podRefusalMessage`, whose ownership was extended to me) and `cloudflare/test/pod-publish.test.ts` (only the one expected text line 135)

## 2. Migration `0035_print_defaults.sql`

Additive only: two tables, one column, triggers.

**`print_defaults`**, one row, like `platform_state` (0029):
```
id INTEGER PRIMARY KEY CHECK (id = 1)
default_printer_id TEXT NULL REFERENCES printers(id) ON UPDATE/DELETE RESTRICT
updated_at TEXT NOT NULL  (ISO, the strftime round-trip CHECK)
updated_by TEXT NULL      (1..128 chars, no FK)
```
- The migration seeds row 1 with `default_printer_id = NULL`.
- Triggers: `print_defaults_no_delete`, and `print_defaults_platform_printer_insert` / `_update` (the default must be a platform printer, `tenant_id IS NULL`).
- "Active" is checked by the PUT route, deliberately not by the schema, so the importer can carry an inactive default verbatim (D59).
- Importer: `UPDATE print_defaults SET default_printer_id = ?, updated_at = ?, updated_by = ? WHERE id = 1` (or an upsert on `id`). A plain INSERT collides with the seeded row.

**`printer_catalog`**, one row per printer:
```
printer_id TEXT PRIMARY KEY REFERENCES printers(id)
catalog_json TEXT NOT NULL        json_valid, json object, ≤ 1 048 576 BYTES (length(CAST(… AS BLOB)))
source TEXT NULL                  1..500 chars
pricing_basis_json TEXT NULL      json object, ≤ 16 384 bytes
content_sha256 TEXT NOT NULL      64 lowercase hex
imported_at TEXT NOT NULL         ISO
imported_by TEXT NULL             1..128 chars, no FK
```
- Trigger `printer_catalog_platform_printer`: the row belongs to a platform printer.
- **Size cap, 1 MiB:** the SnapWear catalogue is 48 KB as stored (JSON.stringify) and 77 KB pretty-printed on disk, for 47 models / 323 SKUs. That is more than 20× headroom, well inside D1's 2 MB value limit, and small enough to parse whole in one request.
- **sha convention (importer, read this):** `content_sha256` is the sha256 hex of the UTF-8 bytes of `catalog_json` EXACTLY as stored. The route stores `JSON.stringify(parsedBody.catalog)`.
- `_by` columns carry no FK, like `audit_events.actor_user_id` and `product_screening.decided_by`, so an import can write rows before (or without) the matching user.

**`printers.revision INTEGER NOT NULL DEFAULT 0`**, with trigger `printers_revision_step`: an `UPDATE OF revision` must set exactly `OLD.revision + 1`, otherwise `RAISE(ABORT, 'printer revision conflict')`. This is the fence for read-modify-write edits (§6).
- The replace-all PUT now bumps `revision` on every printer row it writes (the upsert and the deactivation). Its behaviour and response are unchanged.
- An UPDATE that does not name `revision` (an import script) is neither fenced nor moves it.

**Reserved id:** triggers `printers_id_not_reserved_insert` / `_update` refuse the id `default`.

## 3. Routes

Every CP3 printer route uses the same guard, in this order:
1. **Dark** unless the environment has a dispatch target (`dispatchTargetOf`, the replace-all PUT's rule).
2. A request that carries **`X-Shop-Id`** is refused. That header is how a tenant-admin request presents itself, including a platform user ACTING AS a shop (acting-as = platform session + `X-Shop-Id` + grant). See deviation 1.
3. A live `platform_admin` session.
4. The route's own methods only.
5. Same-origin on every non-GET.

Every guard failure answers the opaque `404 {"error":{"code":"not_found","message":"Route not found"}}`, and only after the guard are the id, the query or the body read. A malformed path id, an unknown id, and `default` also get the opaque 404.

| Method, path | Request | 200 response | Errors |
|---|---|---|---|
| `GET /v1/platform/printers[?cursor=<id>&limit=1..50]` (default 20) | — | `{printers:[PlatformPrinterView], nextCursor: string\|null, defaultPrinterId: string\|null}` | 400 bad query |
| `GET /v1/platform/printers/:id` | — | `{printer: PlatformPrinterView}` | 404 |
| `PATCH /v1/platform/printers/:id` | `{name?, status?:"active"\|"inactive", shippingCostMinor?, capabilities? (whole doc), tiers?:{upsert?:[{sku,blankCostMinor,printCostsMinor}], remove?:[sku]}, expectedRevision?}`, at least one edit | `{printer: PlatformPrinterView, diff: PrinterEditDiff, suspendedMappings: n}` | 400 malformed; 400 `{code: invalid_tiers\|invalid_capabilities\|printer_not_allowed, problems:[…]}`; 409 `revision_mismatch\|concurrent_edit\|tenant_printer\|too_many_mappings`; 404 |
| `GET /v1/platform/printers/default` | — | `{defaultPrinter:{printerId, printerActive: bool\|null, updatedAt, updatedBy}}` | — |
| `PUT /v1/platform/printers/default` | `{printerId: "<id>"}` or `{printerId: null}` | same as GET | 400 malformed (incl. `"default"`); 422 `printer_not_found\|printer_inactive\|tenant_printer` |
| `GET /v1/platform/printers/:id/catalog` | — | `{catalog:{printerId, catalog:<document>, contentSha256, sizeBytes, modelCount, skuCount, source, pricingBasis, importedAt, importedBy}}` | 404 (unknown printer or no catalogue) |
| `PUT /v1/platform/printers/:id/catalog` | `{catalog:{models:{…}, skus:{…}, …}, source?: string\|null, pricingBasis?: object\|null}` | `{catalog: <same minus the document>}` | 400 `{problems}`; 409 `tenant_printer`; 413 `payload_too_large`; 404 |
| `POST /v1/platform/printers/:id/catalog/apply` | see §4 | `{dryRun, catalogSha256, diff, suspendedMappings[, printer]}` (`printer` only when applied) | 400 malformed / `invalid_selection` / `printer_not_allowed` (with `problems`); 409 `no_catalog\|catalog_changed\|revision_mismatch\|concurrent_edit`; 404 |

- **`PlatformPrinterView`**: `{printerId, tenantId, type, name, status, currency, shippingCostMinor, capabilities (stored document, parsed), capabilitiesValid, tiers:[{sku, blankCostMinor, printCostsMinor, createdAt, updatedAt}], revision, isDefault, catalog: null|{contentSha256, importedAt, sizeBytes}, createdAt, updatedAt}`.
  - It lists every row: platform and tenant printers, active and inactive.
  - A stored capability document that fails validation (an imported row) is still shown, with `capabilitiesValid: false`.
- **`PrinterEditDiff`**: `{fields:[…], models|skus|tiers:{added, changed, removed}, unpricedSkus:[…], suspensions:[{mappingId, tenantId, productId, sku, reason}]}` (at most 1 000 listed; `suspendedMappings` is the full count).
- **Audits:** every write writes exactly one audit row in the same batch: `pod.printers.edit`, `pod.printers.catalog.apply`, `pod.printers.catalog.put`, `pod.printers.default`. The metadata carries names, counts, revision and sha, never a price. Dry runs write nothing.

**Tenant route change:** `GET /v1/admin/pod/printers` → `{printers:[{printerId, name, capabilities, garments, provisionalAreas}]}`.
- `capabilities` is rebuilt field by field: models `{garment, name?, printAreasMm:{slot:{w,h,offsetTopMm?}}, provisional?}`, skus `{model, label?}`.
- `garments` = the sorted distinct garments of the models at least one SKU points at.
- `provisionalAreas` = those garments that have a model flagged `provisional`.
- Capability documents gain an optional per-model `provisional: true` (stored only when true). The Firebase printer doc kept a garment list; frames here are per model, so the flag is per model and the garment list is derived.

**Route registration (choice + why):** all new routes sit in my `CP3-ROUTES-C` anchor, each wrapped in `onMethods`:
- `GET /v1/platform/printers`
- `/default` (GET, PUT), registered BEFORE `/:printerId` (GET, PATCH)
- `/:printerId/catalog` (GET, PUT)
- `/:printerId/catalog/apply` (POST)

I did not extend the CP2 handler:
- The four sub-paths had no registration at all, so they needed new routes anyway.
- One anchor keeps every CP3 registration in one place.
- The CP2 PUT handler stays byte-identical, and the PUT still falls through to it. The test "the CP2 replace-all PUT keeps working through the router" proves it, and the CP2 PUT tests in `pod-mappings.test.ts` pass unchanged.

The literal `default` can never be a printer id, enforced three ways:
- routing order,
- `isPrinterId` in every id handler (so `PATCH …/default` falls through to `/:printerId` and is refused; `%64efault` decodes to `default` and is refused),
- the replace-all parser and the schema trigger.

## 4. The catalogue apply

What the seed scripts did on the operator's machine, now a Worker route:
- `scripts/cf-port/seed-staging-slice.mjs` `printerDocument()`
- `scripts/seed-snapwear-printer.cjs` `buildAreas` / `buildPricing`

Request:
```
{ apply?: boolean                      default false = DRY RUN
  models?: [model], skus?: [sku]       at least one; selection = every SKU of the listed models ∪ the listed SKUs
  frames?: { <model>: { fromModel } | { printAreasMm }, provisional? }   stand-in frames; provisional unless provisional:false
  pricing: { basis: "keep" }
         | { basis: "sek", models: { <model>: { blankCostMinor, printCostsMinor } } }
         | { basis: "eur", eurSek, bufferBp, extraPrintEurCents, printSlots, models: { <model>: { baseEurCents } } }
  expectedRevision?, expectedCatalogSha256? }
```

**The selection REPLACES the printer's capability document.** Only the selected SKUs and the models they point at remain, so SKUs can be "removed". Unless the basis is `keep`, it also replaces the tier list:
- Each SKU becomes `{model, label: "<colour> / <size>"}`.
- Each model becomes `{garment, name, printAreasMm: {front, back}}` from the catalogue frames. `offsetTopMm` is kept when it is an integer, exactly as the slice seed's `frame()` does.
- A stand-in frame (`fromModel` or explicit `printAreasMm`) is marked `provisional` unless the request says `provisional: false`. This mirrors the Firebase seed's AREA_SOURCE / FIXED_AREAS; its hoodie JH050 stand-in is not provisional.
- A model with no catalogue frames and no stand-in is refused with a problem line.

The built document then goes through `editPrinter`, the PATCH code path, so the environment policy and the suspension logic are identical to a PATCH. The dry run returns the same diff the apply then writes; a test asserts the two are equal.

## 5. Pricing formula (exact, integer öre)

The Firebase seed (`buildPricing`): SnapWear's EUR price per garment INCLUDES the first print, and each further location costs €3.30. The price is converted at `rate × (1 + buffer)` and rounded to WHOLE KRONOR, which is the POD money path's convention. Here it is the same formula in integers, evaluated in BigInt:
```
blankCostMinor = 100 × roundHalfUp((P − X) × R × (10000 + B) / 10¹⁰)
printCostMinor = 100 × roundHalfUp(     X  × R × (10000 + B) / 10¹⁰)   for each slot in printSlots
P = base price in euro CENTS, X = extra-print price in euro cents,
R = EUR→SEK rate × 10⁴ ("11.20" → 112000; at most 4 decimals, 5 < rate < 20 as in the seed),
B = buffer in basis points (3 % → 300; 0..4999)
roundHalfUp(n/d) = floor((2n + d) / 2d)
```
- A rate given as a JSON number is read through its shortest decimal string (`11.2` → `"11.2"`). More than 4 decimals, or an exponent, is refused, never rounded.
- The `sek` basis stores the given öre as is (the slice seed: blank 6 000, front/back 4 000).
- **Equality with the Firebase seed:** at 11.20 SEK/EUR + 3 %, its whole table (tee 31, longsleeve 102, sweatshirt 99, hoodie 120, cap 26, beanie 65, bag 22, print 38 kr) is reproduced exactly (tested).
- **One deliberate divergence:** on an EXACT half krona the float formula can round down. Example: €4.35 at 10.00, no buffer = 10.50 kr → 11 kr here; the seed's float expression gives 10.499999999999998 → 10 kr. A 40 000-case sweep proves the integer result is exact half-up, and that every float disagreement is exactly such a half.

## 6. Concurrency and atomicity

- `editPrinter` reads the printer (with its revision), its tiers and its active mappings in ONE D1 batch. More than 10 000 active mappings on one printer is refused (409), never truncated.
- It then writes in ONE batch, all or nothing:
  - the printer row, with `revision = read + 1` (fenced by the trigger),
  - the tier deletes and upserts (`created_at` kept on an upsert),
  - the mapping suspensions (the replace-all's `mappingSuspendReason` + shared `suspensionStatements`),
  - the audit row.
- A replace-all or another edit that lands between the read and the write moves the revision, so the batch aborts and the answer is `409 concurrent_edit`. The edit is never written over a state it did not see. Tested by interleaving an edit and a replace-all before the write batch.
- The catalogue apply also fences on the stored catalogue's sha inside the same statement: a catalogue replaced mid-apply aborts the batch (tested).
- `expectedRevision` / `expectedCatalogSha256` let an operator pin the state they dry-ran against.
- Setting the default re-checks exists + platform + active inside its own statement. A deactivation racing the write leaves the default untouched, and the audit row is inserted only if the write took effect (tested).
- **Residual race (same as CP2's replace-all, not closed):** `createMapping` (not my file) can read the printer before an edit commits and insert after it, leaving one active mapping on a SKU or frame the edit removed. The checkout freeze re-validates SKU, frames and prices from one snapshot, so nothing unproducible is sold; the product can stay listed until the next edit. See open question 3.

## 7. What consumes the default printer

**Nothing in the Worker consumes it.**
- `POST /v1/admin/pod/mappings` requires `printerId`, and a printer SKU only means something inside one printer's catalogue, so there is nothing to default.
- The quote and the checkout freeze price the mapping's own printer.

The value is stored for the importer's verification (D52) and for the studio (CP6) to preselect a printer. A test pins this: with a default set, a mapping POST without `printerId` is still a 400.

## 8. The one-number walk

- `expectHandHidden(body, secrets)` (`test/pod-fixtures.ts`) walks EVERY key and EVERY value of a tenant-received body. It fails on:
  - a key fragment naming cost, tier, blank, shipping, parcel, catalogue, pricing, basis, sha, brand, eur, buffer, fee, margin, import, source, generator, frame variants, row count, pallet or neck;
  - a string describing the pricing structure (`tier`, `blank`, `shipping`, `parcel`, `supplier`, `catalog`, `pricing`, `basis`, `withh`, `platform cut`, `unpriced`, `no price`, `priced in`/`prices in`, `another currency`, `exchange rate`, `eur/sek`, `print cost`);
  - a number equal to any hidden figure, or a string spelling one (digits, or `61.37`/`61,37` for figures of 60 kr or more);
  - a string containing a secret: catalogue canaries, its sha256, supplier brand names.
- `secretsOf()` builds the secret set from the actual printer tiers and shipping, the 40 kr platform cut, and the extra values.
- `hiddenPrinter()` uses distinctive prices (7 137 / 6 211 / 6 223 / 6 039 / 7 071 / 6 017, shipping 6 957), so an allowed sum (`inkopMinor`, `priceFloorMinor`) can never collide with one.
- **Coverage** (`printers-platform.test.ts`, run as a tenant admin AND as a platform user acting as the shop):
  - with a canary-laden SnapWear catalogue and pricing basis stored, and a default printer set;
  - `GET /v1/admin/pod/printers` (with an exact key-set assertion);
  - mapping POST 201 and GET (one product, all);
  - quote 200;
  - every mapping refusal: `artwork_not_ready`, `printer_unavailable`, `sku_unavailable`, `slot_not_printable`, the translated `unpriced`→`sku_unavailable` and `currency_mismatch`→`printer_unavailable`, `price_below_floor`, `slot_taken`, `sku_mismatch`, 404 foreign artwork, 400 malformed;
  - quote 422/400/404;
  - DELETE 404 and 204 (empty body);
  - the 404 answers of all eight platform printer routes.
  - `printer-catalog.test.ts` also walks the tenant view after the full SnapWear catalogue is applied at the EUR basis.
- **The walker is not vacuous:** it is asserted to FAIL on the platform view and on the catalogue GET. It also caught two real leaks during the build:
  - The tenant mapping list returned `suspendedReason: "unpriced"`. It is now translated (deviation 3).
  - Test product ids containing `unpriced` / `tier` were rejected, which proves value fragments are checked.
- **Mutation-checked** (in an isolated copy). Each mutation below made at least one test fail:
  - no revision trigger: 2 fail;
  - no `X-Shop-Id` refusal: 9;
  - tenant view leaking shipping: 2;
  - suspensions left out of the edit batch: 6;
  - no catalogue fence: 2;
  - `unpriced` shown to tenants: 2;
  - `default` not reserved: 3;
  - no same-origin check: 4;
  - unconditional default audit: 1;
  - float pricing: 1;
  - no automatic tier drop: 1.

## 9. Deviations (from the brief or from Firebase), and why

1. **"Acting as a shop" = a request carrying `X-Shop-Id`.** A platform user's session is still a platform session; acting-as is expressed by the `X-Shop-Id` header plus a grant. So my platform routes refuse ANY request that names a shop, as the brief's "opaque 404 to a platform user acting as a shop" requires.
   - The CP2 routes (`PUT /v1/platform/printers`, the screening queue) do NOT do this. I left them unchanged per the brief. Their answers carry no price. See reviewer wiring 3.
2. **Replace-all PUT: two tightenings, no behaviour change for valid input.**
   - `printerId: "default"` is now refused (400).
   - Models may carry `provisional: boolean`.
   - Internally it now bumps `revision`.
3. **Tenant refusals that revealed the pricing structure are translated in `pod-admin.ts`.** Mapping POST `unpriced` → `sku_unavailable`, `currency_mismatch` → `printer_unavailable`; a mapping's `suspendedReason: "unpriced"` → `"sku_unavailable"`. The quote 422 message is "Product has no POD mapping that can be produced", no longer "…priced…".
   - The mapping FUNCTIONS keep the precise codes; the existing function-level assertions are unchanged.
   - Cost: the admin UI can no longer tell "not offered" from "not priced". The seller's remedy is the same for both.
4. **PATCH / apply: the environment policy is the replace-all's, strict.** An `api` printer that is not the env's dispatch target cannot be edited even while inactive, so staging's D59-imported inactive `snapwear` is not editable. See open question 2.
5. **The whole platform printer surface is dark without a dispatch target**, including the reads, the default and the catalogue: the PUT's rule, applied to one surface.
6. **Firebase deltas:**
   - Tiers are per SKU, not per garment.
   - `provisional` is per model; `provisionalAreas` is derived per garment.
   - `garments` lists only garments some SKU is offered in.
   - The pocket frame is not written explicitly; `slotFrame` derives it from the front frame, as in CP2.
   - EUR rounding is exact half-up (§5).
   - The apply does not store its pricing parameters. The catalogue PUT carries a `pricingBasis` verbatim, as Firebase kept it on `printerCatalog`.

## 10. Reviewer wiring

1. **`REQUIRED_MIGRATION`** (app.ts + its two tests): 0035 must be applied before these routes work. Bump to the consolidated CP3 head. No new env var or binding is needed.
2. **Publish/PATCH refusal TEXTS: done in review round 1** (§14). Two tenant-visible CODES remain, and they come from files I do not own; see §14 for the file:line list and the suggested translation.
3. **`X-Shop-Id` refusal on the older platform routes:** the reviewer makes it one rule for every platform route in the shared authorization function at consolidation (ruling 1). The CP2 printers PUT and the screening routes were left unchanged.
4. **Importer (CP3-S):**
   - `printer_catalog.content_sha256` = sha256 of the exact stored `catalog_json` bytes.
   - Recommended mapping of Firestore `printerCatalog/snapwear`: `catalog_json` = the document minus `source`, `pricingBasis`, `importedAt`; `source` = `JSON.stringify(doc.source)` (fits the 500-char limit); `pricing_basis_json` = `doc.pricingBasis`.
   - `print_defaults` must be UPDATEd (the row exists).
   - `printers.revision` defaults to 0.
   - The id `default` is refused.
   - To rebuild SnapWear's tiers from its catalogue after import, the apply route reproduces the Firebase seed exactly: the `FULL_EUR_APPLY` body in `test/printer-catalog.test.ts` is the whole offer at 11.20 / 3 %.

## 11. Open questions

None left open. The four raised in round 0 were answered by the reviewer (see §14, "Answered").

## 12. Tests: exact output

New tests: `printers-platform` 26, `print-defaults` 13, `printer-catalog` 19 = **58**. `pod-mappings.test.ts` was not changed; `pod-fixtures.ts` gained helpers only.

My suites + the CP2 POD suites, shared tree (2026-09-27 ~17:35):
```
npx vitest run test/printers-platform.test.ts test/print-defaults.test.ts test/printer-catalog.test.ts \
  test/pod-mappings.test.ts test/pod-publish.test.ts test/pod-artwork.test.ts test/screening.test.ts test/fake-printer.test.ts
 Test Files  8 passed (8)
      Tests  335 passed (335)
```

`npx tsc --noEmit`, shared tree: exit 0, no output.

Full `npx vitest run`, SHARED tree (other builders mid-work, 2026-09-27 17:36, 244 s under load):
```
 Test Files  3 failed | 66 passed (69)
      Tests  38 failed | 2346 passed (2384)
```
None of the 38 is in my files:
- 36 in `test/slice/failure-injection.test.ts`: checkout answers `404 Checkout not found`, the new legal readiness gate (CP3-E, in progress);
- 1 in `test/slice/vertical-slice.test.ts`: the terms-status shape gained `acceptedVersion`/`graceDeadline`/`inGrace`/`readiness` (CP3-E);
- 1 in `test/auth-routes.test.ts`: a 5 s timeout under load.

An earlier shared-tree run also showed failures in `platform-tenants`, `provision-tenants` (CP3-A) and `connect-onboarding` (CP3-F), all in their own files.

**Isolation proof:** HEAD `1936a32c` + ONLY my files (my two app.ts anchor blocks spliced into HEAD's app.ts), in a scratch copy:
```
tsc --noEmit: exit 0
 Test Files  1 failed | 53 passed (54)
      Tests  1 failed | 1833 passed (1834)
```
The one failure is `password-reset.test.ts`: `expiresAt − createdAt` was 3 599 999 instead of 3 600 000, a 1 ms timing flake under load. That file alone: `19 passed (19)`.

## 13. Not done / not tested

- No wrangler, no staging deploy, no D1 remote: 0035 is proven only against miniflare's D1.
- A `Content-Length` above the cap is refused before the body is read, but that branch is untested: workerd sets the header itself, so the test exercises the parsed-size path (> 1 MiB → 413).
- `listPlatformPrinters` loads all tiers of a page (at most 50 printers × at most 5 000 tiers); realistic sizes are tiny. Nothing streams.
- `node guard/guards.test.mjs` was not run; the guard reads `git ls-files` and my new files are untracked. I wrote none of the forbidden strings; the reviewer should run the guard after staging.

## 14. Review round 1

Accepted with two follow-ups (coordinator, 2026-09-27). Rulings on §9's deviations 1–5: all accepted. Ownership extended to `podRefusalMessage` in `cloudflare/src/pod/pod-mappings.ts`. The round was interrupted once by an API spend limit and then resumed; on resuming, both files written just before the stop were re-read and found complete.

### Follow-up 1: tenant-visible refusal texts

**Changed:** only the three texts of `podRefusalMessage` (`cloudflare/src/pod/pod-mappings.ts`), plus a doc comment above it. No code changed: the mapping and gate functions return the same codes as before.

The final tenant-visible texts (`podRefusalMessage`, every case):

| Code | Text |
|---|---|
| `pod_too_large` | "The product has more than 200 active variants, so its price floor cannot be checked. Unpublish it and reduce its active variants to 200 or fewer, then change it and publish again." (unchanged) |
| `pod_mapping_suspended` | "A print mapping is suspended because the printer can no longer make it. Re-post or delete that mapping first." (unchanged) |
| `pod_mapping_missing` | "A sellable variant has no active print mapping." (unchanged) |
| `pod_unpriced` | "The printer cannot make this product with its current print mappings. Re-post or delete the mappings, or contact support." (was: "The printer has no price for this garment and print areas.") |
| `currency_mismatch` | "The printer cannot make this product as it is set up. Contact support." (was: "The printer prices in another currency than the product.") |
| `price_below_floor` | "The price is below this product's price floor. Raise it to at least the floor shown with the product's print quote." (was: "The price is below the break-even floor for this production cost.") |
| `taken_down` | "The product has been taken down by the platform." (unchanged) |
| any other | "Product cannot be published" (unchanged) |

The mapping routes' own texts (`src/routes/pod-admin.ts`, from round 0) are unchanged:
- "Mapping cannot be created"
- "Request conflicts with the current mapping state"
- "Product has no POD mapping that can be produced"
- `podRefusalMessage` for `price_below_floor` / `pod_too_large`

**`cloudflare/test/pod-publish.test.ts`**: one expected text changed, line 135. The `price_below_floor` sentence was updated from the old wording to the new one; it is still an exact `toEqual`. Nothing else in that file changed.

**Walker extended** (`test/pod-fixtures.ts` `HAND_VALUE_PARTS`): `"cost"`, `"currency"` and `"price row"` are added to the forbidden value fragments. It already denied `tier`, `supplier`, `no price`, `prices in`, `another currency`, `unpriced` and others. It applies to success and error answers alike.

New tests in `test/printers-platform.test.ts`:
- **Every refusal sentence is neutral.** Every `podRefusalMessage` case passes the walker, and the three old texts are asserted to FAIL it, so the walk is not vacuous.
- **Every publish and price-edit refusal**, for a tenant admin and for a platform user acting as the shop. The requests are `POST /v1/admin/products/:id/publish` and `PATCH /v1/admin/products/:id`, answered through `adminResultResponse`.
  - Codes covered: `price_below_floor` (at publish, and on a live product's price cut), `pod_mapping_missing`, `pod_mapping_suspended`, `taken_down`, `pod_unpriced` and `currency_mismatch`.
  - Each 422 body is walked, and each message is asserted to equal `podRefusalMessage(code)`.

**Tenant-visible text still coming from files I do not own: two CODES, not messages.**
- `cloudflare/src/pod/pod-mappings.ts:551` `return "pod_unpriced";` and `:554` `return "currency_mismatch";` (in `evaluatePodGate`; I was allowed to change only `podRefusalMessage`)
- → `cloudflare/src/catalog/admin-catalog.ts:79` `refused(code)` passes the code on
- → `cloudflare/src/app.ts:465` (`adminResultResponse`, line 452) prints `code: result.code` to the tenant.

The code values name the pricing structure (`unpriced`) and the printer's currency (`currency_mismatch`). The messages beside them are now neutral. Suggested fix at consolidation, in `adminResultResponse`: map `pod_unpriced` and `currency_mismatch` to one neutral code, for example `pod_unavailable`, like the mapping routes already do.

The test documents the two with a `KNOWN_CODE_LEAKS` set. For those two codes it walks the message only; any other code gets the full-body walk. Once the codes are translated, the full-body walk applies to them too.

### Follow-up 2: `belowFloor` in the edit diff

**Shape** (in `diff`, for PATCH and the catalogue apply, dry run and real run alike):
```
belowFloor: { count, products: [{ tenantId, productId, variantId, priceMinor, newFloorMinor, live }] }   // at most 200 listed
          | { count: null, tooManyToCheck: true }
```
Two fields are added beyond the brief:
- `variantId`: the sellable unit with the largest shortfall; null means the base price.
- `live`: published + active, the gate's own definition, so the operator can tell a product on sale from one that will be gated at its next publish.

The edit acts on none of them; the audit row carries only the count.

**Which products:** every product with an ACTIVE mapping on this printer, read in the edit's own read batch, so the report comes from the same snapshot as the suspensions.
- Units and sets follow `evaluatePodGate`: the base price and every active variant, each served by its variant's own active mapping set, else the product-level set.
- A product with a suspended mapping (before this edit, or because of it) is not listed: it cannot be sold, and it appears under `suspensions`.
- An inactive printer after the edit gives `{count: 0, products: []}`: it makes nothing. The gate's `quotePodCost` reads active printers only.
- Products already under their floor before the edit are listed too. The brief asks for products "whose current selling price is below the floor computed from the NEXT printer document".

**The floor: the existing functions, no second formula.** `floorOnNextDocument` calls `quoteFromTier` and `podPriceFloorMinor` from `src/pod/pod-quote.ts`: the same two functions the quote route and the publish gate reach through `quoteSet → quotePodCost`. `quoteFromTier` takes the tier as facts, so the NEXT document's tier, currency and parcel are passed in without being stored.
- What I could NOT reuse is the gate's unit/set selection (`evaluatePodGate`, `setFor`, `setRouting` in `pod-mappings.ts`). Those are private, and `quoteSet` reads the tier from D1, so they cannot price a document that is not stored. I re-expressed that selection (about 30 lines: variant set else product set; one printer, one SKU, no slot twice).
- Smallest change to remove this duplication: give `evaluatePodGate` / `quoteSet` an optional `tierFor(printerId, sku): TierFacts | null` parameter, defaulting to the D1 read; the floor report would then call `evaluatePodGate` itself. It lives in `pod-mappings.ts` beyond `podRefusalMessage`, so I did not make it.

**Bounded:** more than 1 000 products, 20 000 live mappings of those products, or 20 000 active variants gives `{ count: null, tooManyToCheck: true }`. The reads use `LIMIT n + 1`, so a list is never silently truncated.

**Platform-only:** the diff exists only in the platform PATCH and apply answers; tenant and acting-as sessions get the opaque 404 there (tested).

New tests in `test/printers-platform.test.ts`:
- **Raising a tier lists the affected products with the right floor.** Raising TEE_M's front print by 10 kr lists:
  - the live product priced exactly at its old floor, and a variant with its own TEE_M set;
  - each `newFloorMinor` equals what the quote route computes from the stored document after the edit;
  - the product priced far above is not listed;
  - the dry run and the real PATCH report the same list;
  - products and mappings are untouched, and the audit carries only the count.
- **An edit that moves no cost lists none of them** (a price exactly at the floor is not below it).
- **A suspended product appears under suspensions, not `belowFloor`;** an inactive printer gives count 0.
- **Platform-only:** tenant and acting-as sessions get the opaque 404 on the PATCH, and no tenant answer contains `belowFloor` or `newFloorMinor`.
- **Bounded:** 1 001 products (inserted in one statement) give `{count: null, tooManyToCheck: true}` in the dry run and in the real PATCH answer.

### Answered (moved out of "open")

1. **Staging default printer:** the importer writes NULL on staging, and verification reports it as an expected difference. Production imports the real default.
2. **Editing an inactive non-target `api` printer:** no. The strict policy stands.
3. **A schema trigger for the mapping-versus-edit race:** no. The residual is the same as the replace-all's, and the checkout freeze re-validates.
4. **A price raised above a live product's floor:** follow-up 2 makes it visible. Acting on it is the admin checkpoint's job.

### Round 1: exact test output

My suites + the existing POD suites, shared tree:
```
npx vitest run test/printers-platform.test.ts test/print-defaults.test.ts test/printer-catalog.test.ts \
  test/pod-mappings.test.ts test/pod-publish.test.ts test/pod-artwork.test.ts test/screening.test.ts test/fake-printer.test.ts
 Test Files  8 passed (8)
      Tests  343 passed (343)
```
- `printers-platform`: 26 → 34 tests (belowFloor 4 + bound 1 + refusal texts 1 + publish/price-edit refusals 2).
- `print-defaults`: 13. `printer-catalog`: 19.
- CP3-C total: 58 → 66.

`npx tsc --noEmit`: exit 0, no output.

Full `npx vitest run`, run once, shared tree, 2026-09-27 (111 s):
```
 Test Files  5 failed | 64 passed (69)
      Tests  26 failed | 2355 passed | 24 skipped (2405)
```
None of the 26 is in my files:
- **`test/pod-artwork.test.ts` (12), e.g. "platform PUT replaces the list…": `expected 404 to be 200`.** Cause: the consolidation change in `src/auth/request-authorization.ts` (D70). `authorizePlatformRequest` now refuses any request carrying `X-Shop-Id`, and this suite's harness sends `x-shop-id` (by host) on its `PUT /v1/platform/pod/profiles` calls. This suite passed in my targeted run minutes earlier, before that change landed. It needs a harness update; I did not touch it.
- **`test/connect-onboarding.test.ts` (9): `acting_as GET /v1/platform/tenants/…/connect: … expected 404 to be 200`.** The same D70 rule meets that suite's acting-as-on-platform expectation.
- **`test/legal-pages.test.ts` (5): `expected { acceptance: { …(10) } } to deeply equal { acceptance: null }` and `expected 'worker' to be 'import'`** (CP3-E, in progress).
- **`test/legal.test.ts`, `test/legal-grace.test.ts` (whole file): `D1_ERROR: UNIQUE constraint failed: tenant_settings.tenant_id`** (CP3-A / CP3-E fixtures, in progress).
- The two slice suites are among the 24 skipped tests this run; they are the known legal readiness gate case, outside my area.

Note for consolidation: with D70 in the shared function, the `X-Shop-Id` check in my `guardPlatformPrinters` (`src/routes/pod-platform.ts`) is now redundant but harmless; it can be removed.

No mutation checks were run in round 1 (per instructions).
