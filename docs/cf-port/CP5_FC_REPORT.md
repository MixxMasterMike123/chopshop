Model: claude-opus-5-5 (Opus 5.5)

# CP5-FC report: products (list, form, images, variants rail, POD numbers)

Built on `cf-port` (HEAD `d052d522`), in the working tree. No git command that writes, no wrangler, no deploy, no network. The older build's dev server was not started.

## (a) What left, control by control (the admin build only; the older build keeps every one)

| Where | Control / text | Why it left |
|---|---|---|
| AdminProducts list | the **"Varianter"** column | `GET /v1/admin/products` carries no variant count (`AdminProductListItem`). Showing "—" would say "no variants", which is false. The column is filtered out by the data flag `LIST_SHOWS_VARIANT_COUNT = false`. |
| ProductForm → Pris | the line **"Vid N kr tjänar du ca X kr per försäljning (Y % marginal)"** | It is computed from a cost with the client fee formula (`podPricing.js`). Rule 15 / the brief: not in this build. `profitAt` answers null, so the existing `profitNow != null` condition hides the line. |
| ProductForm → Pris | the **"Önskad marginal … Rekommenderat pris … Använd priset"** tool | The same formula (`priceForMargin`). It is gated by `pod.suggestPrice` (null here). |
| ProductForm → Pris | the tail **"(avgift 8 % + 5 kr inräknad)"** of the Prisgolv line | The two numbers are client constants of `podPricing.js`. The server's floor also holds the parcel cost (D41), so naming only the fee would be wrong. The line now ends "…tjänar du 0 kr." (`pod.feeNote`). |
| ProductForm → Publicering | the **"Print on demand-produkt"** checkbox and its help text | `is_pod` is set by the first print mapping. No product route writes it, so the box would be a no-op. `POD_FLAG_EDITABLE = false`. The live-gate box and "✓ Tryckkoppling finns" stay, driven by the server's quote. |
| ProductForm | the whole **"Ångerrätt"** card (the "Specialtillverkad / personlig produkt" checkbox) | `isPersonalized` is refused by design (D46: the studio's buyer flow sets it; `admin-catalog.ts` UPDATE_KEYS has no such key). The card's only control has no route, so the card goes. `PERSONALIZED_EDITABLE = false`. |
| ProductForm → Status | for a **platform user acting as the shop**: the unlocked "Aktiv" box on a taken-down product, and the copy "Markera Aktiv och spara för att återpublicera — spärren tas då bort." | A takedown is reinstated by the platform's review routes (`infringement-reports.ts`), not by a product write. `publish` refuses `taken_down`. The box is locked for everyone, and the platform user sees the seller's sentence. `TAKEDOWN_REINSTATE_IN_FORM = false`. |
| ProductForm (after save) | the client **brand-screening notice** (`screenProduct` + `loadScreeningBlocklist` → `settings/contentScreening`) | The client blocklist is gone. The notice now comes from the server's `screeningStatus` after the write or publish: `pending`, `blocked` and `flagged` each have a sentence (`screeningNoticeFor`). |
| ProductForm | **Grossistpris** and **"Tillgänglig i grossistportalen"** | No change: they were already gated by `isEnabled('b2b')`, which is false here (D81). |

Copy otherwise unchanged. The delete confirm ("…kan inte ångras") is kept as it is. "Delete" archives (`PATCH {status:'archived'}`) and the list hides archived products, and a seller has no way to restore one. So the text is still true for the seller, and I did not change it.

## How each file reaches its data (and how the older build keeps working)

The brief's pattern, the same as FF's `adminPaymentsData.js`: **a data module next to the page holds the page's former inline Firebase code, moved and unchanged (the older build uses it); the admin build's alias list swaps it for an API implementation.** The page files import neither Firebase nor the API client.

| File | Approach |
|---|---|
| `src/pages/admin/AdminProducts.jsx` | Inline calls → `./adminProductsData` (new; old impl). Alias → `src/admin-app/replacements/adminProductsData.js`. Edits: the imports; `fetchProducts` builds categories/tags from the returned array; delete, star and order call the module; `onRowClick` calls `openProduct(p)` (async: the API form needs the detail; the old impl returns the list document as before); the columns array gets one `.filter` for the variants column. No markup or class changed. |
| `src/components/admin/ProductForm.jsx` | Inline calls → `./productFormData` (new; old impl), which exports `useProductPod` (the mappings/live-gate state, floor, Inköp, profit/margin/suggest functions), `useProductSave` (the save from the SKU check to the screening notice) and three flags. Alias → `src/admin-app/replacements/productFormData.js`. Form edits: the imports (`:61-83`); the POD block (`:374-418`) became one hook call; `deleteImageFromStorage` moved out; `handleSubmit` keeps the client validations and calls the save; the price card reads `pod.inkopKr`, `pod.feeNote`, `pod.profitAt/marginAt`, `pod.suggestPrice`; the flag conditions above. One comment word changed (see "Guard"). |
| `src/components/admin/ProductImages.jsx` | **Not edited.** It has no data layer (pure presentation; the form passes `maxBytes`). |

**The older build:** `npx vite build` builds (✓ 11.96 s). Its behaviour is the same, with one deliberate change in a failure path. The "Varje variant behöver ett namn" and "Två varianter heter …" checks now run **before** the uploads. Before, the old save had already uploaded new images, and run the orphan sweep that deletes Storage files, before it refused. So a refused save could delete images the product document still named. The checks and their copy are unchanged.

## What works against the dev API

Everything below was exercised in the browser through the admin build with FB's real `AppLayout` (it became Firebase-free in this build while I worked).

- **List:** read page after page; archived products hidden; the star (`PATCH {featured}`); "Ändra ordning" → `PUT /v1/admin/products/order` (200 per request; draft index = place); delete = archive. After a save the list reloads.
- **Open:** `GET /v1/admin/products/:id`. The adapter turns it back into the document the form reads:
  - images: rows without a variant, in order, the first = Huvudbild;
  - the rail: active variants grouped by `group` in `position` order, with a group's sizes, price (empty = inherited) and images (rows naming any variant of the group, the group rule).
  - A test proves that an untouched rail derives the same skus and plans **zero** variant writes.
- **Save** (`replacements/productFormData.js`):
  1. the SKU made unique against every product of the shop (as before, with the same toast);
  2. the body checked against the API's limits, the field named before anything is written;
  3. `POST` (a draft) or `PATCH` (with `status`);
  4. the variant sync: match by sku, then by group + size; create, `PATCH` or `DELETE` (a variant an order names comes back `deactivated`, and the seller is told);
  5. new images through `uploads.js` (`kind: product_media`), then `PUT …/images`: own images first, each group's images naming its first variant, ≤ 30 checked before writing;
  6. `publish` / `unpublish` (the server's POD gate and screening decide);
  7. the product's own images it no longer uses get `DELETE /v1/admin/objects/:id` (as the old Storage sweep).
- **Verified end to end on the T-shirt** (rail + 4 images): renamed a group (rows kept their skus), removed a group (deleted), added a size XL, added a new group with an uploaded image, removed a gallery image, uploaded a new one. The server's rows and image list matched exactly.
- **Verified on a new product:** created, activated, published with its image.
- **POD:**
  - "Inköp" and "Prisgolv" come from `GET /v1/admin/pod/quote`. In the fixture, 140.00 kr ex VAT is shown as "Inköp: 175 kr inkl. moms" and "Prisgolv: 253 kr".
  - The client floor check uses the server's floor ("Priset 250 kr ligger under prisgolvet 253 kr …").
  - A product without a mapping shows the live-gate block and "Prisgolv och vinstkalkyl aktiveras när …", exactly as the old page did for a product without a cost.
  - When the product has no product-level set, each group's first variant is quoted (≤ 20). The strictest floor is used, and "connected" means every group is quotable.
- **Refusals, in the page's existing style (toasts; the form has no inline error markup to reuse):**
  - Before any write, the form stays open: a field over the API's limit (named), > 30 images, > 200 variants, the client floor, the `PATCH` refusals `price_below_floor` / `pod_unavailable` / …, and a 400 on the product write when "Mer information" is non-empty, read as the HTML refusal at that field ("Mer information innehåller kod som inte är tillåten …").
  - After the product write, the form closes to the list with the refusal and "Det som hann sparas finns kvar — öppna produkten igen för att fortsätta." This avoids a second create from stale state. Seen live: the variant-sku 409 and the session lost after a dev restart.
  - A publish refusal (`pod_mapping_missing`, `price_below_floor`, `taken_down`, …) is said with 🔒. The product is saved.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 397  # pass 397  # fail 0            (mine: products 8, adapter 23, dev catalogue 5)
npx vite build --config vite.admin.config.js     ✓ built
node cloudflare/admin/check-admin-build.mjs
  admin build: 11 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs
  storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                   ✓ built in 11.96s
node guard/guards.test.mjs
  guard: FAIL — (b) 8 stale allowlist entries, none of them mine (CredentialLanguageSwitcher,
  PlatformTermsGate, ShopPicker, PlatformLayout, AdminOrderDetail, AdminPayments,
  AdminPlatformTerms, AdminSettings: the other units' files)
```

**Guard, my part:**
- I removed my two stale entries from `guard/allowlist.txt`: `AdminProducts.jsx` (it no longer imports Firebase) and `ProductForm.jsx`, where I reworded one comment so the file no longer matches.
- The two **new** old-build data modules, `src/pages/admin/adminProductsData.js` and `src/components/admin/productFormData.js`, import Firebase **by design**. They are untracked, so the guard does not see them yet. **When they are committed they need allowlist entries** (net 0 against the two I removed, so the baseline holds).
- None of my new files contains either forbidden name (checked by grep). The scripts this unit ran are listed above.

## What I looked at (`/private/tmp/fc-shots/`)

- **List:** 1440 light (`list-1440-light`), 1440 dark (`list-1440-dark`), 375 light (`list-375-light`), sort mode (`sort-mode-1440-light`), after a create (`list-after-create-1440`).
- **Form:**
  - T-shirt (variant rail, several images, POD with a quote): 1440 light (`form-tee-1440-light`, first shot taken on a bare stand-in layout before the shell landed), 1440 dark (`form-tee-1440-dark`), 375 (`form-tee-375-light`), the edited state before saving (`form-tee-edited-1440`), and reopened after the save (`form-tee-reopened-1440`).
  - Hoodie, POD without a mapping: `form-hoodie-nomapping-1440-light`.
  - New product: `form-new-1440-light`.
  - Taken-down product: `form-takedown-1440-light`.
- **Refused states:** the client floor (`refused-floor-client-1440`; the toast text read from the DOM) and the variant-sku 409 (`refused-variant-sku-1440`).

What I saw:
- The markup is the old form's, card for card. The Ångerrätt card and the POD box are absent, the right rail closes up, and the price card ends after the floor line.
- In dark mode, "✓ Tryckkoppling finns" (`text-admin-success-text`) is low-contrast. That is the known dark status-token gap of the shared tokens, not this unit's.
- At 375 the shell's top bar clips the avatar. That is FB's shell.
- The dev server restarted often as other units edited shared files. Each restart drops the dev sessions, which showed the "session gone" path working.

## Deviations

1. **Toasts, not inline errors.** "At the field it concerns" is done by naming the field or the variant in the page's existing toast. The form has no per-field error markup, and adding it would break rule 17.
2. **The partial-save rule.** The API has no atomic "save the product". A failure after the product write closes the form with what happened, rather than keeping the form open on stale server state.
3. **Inköp incl. VAT** = `inkopMinor × 1.25`, rounded to whole kr (production VAT 25 %, `pod-quote.ts PRODUCTION_VAT_BP`). This is the server's own instruction ("the UI converts to inkl. moms at the edge"). It is a unit conversion, not a recomputed floor or payout.
4. **Name.** The API requires a name. An empty title is saved with the sku as its name (the old page showed the sku in that case anyway).
5. **Launch date** is a date on the server: the time part of the datetime field is dropped. Clearing the field now clears it (before, a cleared field kept the old date).
6. **Dev API.**
   - My routes are in their own module, `src/admin-app/dev/products-dev.mjs`, with their own invented fixtures `products-fixtures.json` (generated SVG placeholders), to avoid edit races on the shared `fixtures.json`.
   - In `dev-api.mjs` I added the import, the spread into `ADMIN_ROUTES`, and a raw body for non-JSON uploads.
   - In `dev-api.test.mjs` the "unknown route" case used `/v1/admin/products`, which now exists. It points at `/v1/admin/no-such-route`.
7. **Variant images left by a removed group** are not deleted (the old sweep never deleted variant images either). Only the product's own dropped images are.

## Open questions / what the Worker cannot express today

1. **The list has no variant count and no tags.** That costs the "Varianter" column and the tag autocomplete: `availableTags` is empty, so no suggestions appear. Both are cheap to add to `listAdminProducts`: a `COUNT` per product, and `loadTagsFor` already exists.
2. **No atomic product save.** Product, variants, images and publication are separate writes. A refused variant leaves the product and earlier variants written. A batch route (or `PATCH` carrying variants and images) would let the form save all or nothing.
3. **The HTML refusal of `moreInfo` answers a bare 400** (`invalidRequestResponse`, no reason), so the page attributes it by elimination. A `reason: 'more_info_html'` would make that exact.
4. **Variant sku uniqueness is shop-wide.** The client cannot pre-check it (the list carries product skus only), so a collision is found on write (409, after the product write).
5. **`isPersonalized`.** The seller cannot set it in this build (D46). Today's sellers set it on made-to-order products. Confirm that the studio (CP6) covers every such product, or the PDP's "no withdrawal" notice will never show for a hand-made POD product.
6. **The mapping list (`GET /v1/admin/pod/mappings`) carries `printerId`.** Rule 15 forbids a printer's internal id on any admin route. This unit does not read that route (the quote is enough), but WC/FN should know.
7. **The copy "Prisgolv och vinstkalkyl aktiveras …"** still promises a "vinstkalkyl" that this build no longer shows. I left it unchanged (rule 17). Mikael may want "Prisgolvet visas när …".

## Files

**Created**
- `src/api/admin/products.js`, `src/api/admin/products.test.mjs`
- `src/admin-app/adapters/product.js`, `src/admin-app/adapters/product.test.mjs`
- `src/admin-app/replacements/adminProductsData.js`, `src/admin-app/replacements/productFormData.js`
- `src/pages/admin/adminProductsData.js` (old build, Firebase), `src/components/admin/productFormData.js` (old build, Firebase)
- `src/admin-app/dev/products-dev.mjs`, `src/admin-app/dev/products-fixtures.json`, `src/admin-app/dev/products-dev.test.mjs`
- `docs/cf-port/CP5_FC_REPORT.md`

**Modified**
- `src/pages/admin/AdminProducts.jsx`, `src/components/admin/ProductForm.jsx` (data layer only, as listed)
- `src/admin-app/pages.jsx` (the AdminProducts line)
- `vite.admin.config.js` (two alias rows)
- `src/admin-app/dev/dev-api.mjs` (import, spread, raw body), `src/admin-app/dev/dev-api.test.mjs` (one path)
- `guard/allowlist.txt` (my two stale lines removed)
