# CP4 gap analysis — what exists, what is missing, how the work is split

Status: read-only investigation at HEAD `2fff0aca` (2026-09-27), before any CP4 code and before Mikael's "CP4 go". Staging serves the CP3 Worker (`f0db7a72`, migrations 0001–0038). Input for the CP4 builders and the reviewer. The open questions are in `DECISIONS.md` as D77–D82, on recommended defaults.

`$CF` = `cloudflare/`. Symbols are named instead of line numbers where the file is long: search for the symbol.

How this was made: a read-only agent did the first pass; the reviewer checked its claims against the code and the documents and corrected six of them (the `infringement_reports` table exists; the inventory counts; the hostname rule is in PLAN §2.1 and D7b; sitemap and JSON-LD are in PLAN §2.4; the class of page attachments is contradictory; there are four Firebase hosting targets). What could not be checked is marked "not verified".

**Three findings that shape everything:**

1. **An anonymous visitor gets a name and a price, nothing else.** `getPublicStorefront` / `getPublicStorefrontVersioned` (`$CF/src/storefront/public-storefront.ts`) select `shop_name, default_locale, default_currency, catalog_version` from `tenants`. No branding, template, theme, menu, pickup place or collection is in any public response. The store identity is stored (`tenant_settings.store_identity_json`, 0032) and an admin can read and write it (`handleAdminSettingsRoute`), but no public route reads it.
2. **Public images cannot be uploaded or served.** `ALLOWED_BUCKETS` (`$CF/src/storage/object-store.ts`) already places `product_media`, `shop_branding` and `preview_image` in the public bucket, and `wrangler.jsonc` binds `PUBLIC_BUCKET` in both environments. But `PRIVATE_KINDS` (`$CF/src/storage/object-routes.ts`) is the only admission list of the object routes, `deliverPrivateObject` answers for the private bucket only, and no public base URL is pinned or configured. Products have no image column at all (0005 and its later `ALTER TABLE`s: weight, shipping, takedown, `is_personalized`).
3. **The storefront finds its shop in the URL path; the Worker finds it in the hostname.** `resolveShopId` (`src/config/tenancy.js`) reads the first path segment (`/sillmans/cart`). `resolveRequestTenant` (`$CF/src/tenancy/resolve-tenant.ts`) and the `Internal` entrypoint (`$CF/src/index.ts`) resolve from the request's hostname, and staging's `workers.dev` host cannot carry one hostname per shop (D7b, which left this "until CP4 needs a second storefront"). CP4 needs four storefronts.

Next free migration: **0039**. `0020` does not exist and must never be used.

---

## 1. Gap table

### a. Products, variants, images

| | |
|---|---|
| **Exists** | `products`, `product_variants`, `product_publications` (`0005_catalogue.sql`; `UNIQUE (tenant_id, sku)` on products and on variants; tenant and product immutable by trigger). Later columns: `weight_grams`, `allow_shipping`, `allow_pickup`, `shipping_json` (0009), `takedown_at` (0025), `is_personalized` (0031). Admin: `POST /v1/admin/products`, `PATCH /v1/admin/products/:id`, `POST …/publish`, `POST …/unpublish` (`createAdminProduct`, `updateAdminProduct`, `publishAdminProduct`, `unpublishAdminProduct` in `$CF/src/catalog/admin-catalog.ts`). Public: `GET /v1/storefront`, `GET /v1/products`, `GET /v1/products/:id` through the ONE predicate (`PUBLIC_ELIGIBILITY_PREDICATE`, `$CF/src/catalog/eligibility.ts`), each with `ETag` = `catalog_version`. `PublicProductDetail` carries `variants[]` (`variantId, sku, label, priceMinor`) and the POD preview fields. |
| **Missing** | **Any admin read**: the products path answers POST only, the product path PATCH and POST only; there is no list and no read of one product (the seed script finds its product through the mappings list). **Any write of a variant.** **Any image**: no column, no route, no field in a public shape. Featured flag, manual order and the "only featured" rule (`src/utils/productSorting.js`). Tags. `reviewCount` / `ratingSum` on the public shape (the stars render from the product in Firebase). `products.internal_json` exists and no code reads or writes it. |
| **Firebase source** | `src/pages/shop/PublicProductPage.jsx`, `AllProductsPage.jsx`, `TagPage.jsx`, `PublicStorefront.jsx`; admin `ProductForm`; `src/utils/productSorting.js`; manifest row 51 for the field list. |

### b. Collections

| | |
|---|---|
| **Exists** | Nothing. No table, no route, no test. |
| **Missing** | `collections` + `collection_products`, admin CRUD for manual and smart (by tag) collections, public list and detail, cover image, the `catalog_version` bump (PLAN §2.4 names collection pages as a cached surface). |
| **Firebase source** | Readers `PublicStorefront.jsx`, `ProductCollectionPage.jsx`, `CollectionPage.jsx`, `AdminMenu.jsx`; writer `AdminCollectionEdit.jsx`. Fields (manifest row 20): title, handle, description, imageUrl, type, productIds[], rule.tag, published, featured, sortOrder. |

### c. Pages and legal pages

Two different things, and the names collide.

| | Content pages (manifest row 40) | The four legal pages |
|---|---|---|
| **Exists** | Nothing. | The seller's ADOPTION of the texts: `legal_acceptances` (0037), `POST /v1/admin/legal/accept-pages`, the texts kept as a snapshot with their hash. |
| **Missing** | `pages` table, admin CRUD, public page by slug, attachments. | A public route that shows a visitor the adopted text. Firebase renders it from `src/utils/legalPageRenderer.js` + the templates + the shop's own fields (`DynamicPage.jsx`, `DynamicRouteHandler.jsx`, `ShopFooter.jsx`). The baseline holds four legal pages. |

### d. Menu, branding, pickup places

| | |
|---|---|
| **Exists** | All three live inside `store_identity_json` and round-trip through `GET` / `PUT /v1/admin/settings` today (`parseStoreSettingsInput`, `readTenantSettings`, `writeTenantSettings` in `$CF/src/platform/tenant-config.ts`). |
| **Missing** | The public projection: which keys of the identity a visitor may see (an allowlist, never the whole object), the menu's targets resolved against pages and collections that exist and are public, the `catalog_version` bump when the identity or a feature changes (CP3-A's report names this for CP4: triggers on `tenant_settings` and `tenant_features`). Branding image upload. |

### e. Features that are not ported

`tenant_features` holds six keys (`FEATURE_KEYS`). `productReviews`, `discountCodes` and `abandonedCheckout` default ON, and none has a route: `ProductReviews.jsx`, the discount field of `CartContext.jsx` (`validateDiscountCode`) and the two recovery pages would call nothing. The public storefront response must say which features the shop has, and until a feature is ported the answer must be "no" whatever the row says. Otherwise the default turns on a button that fails.

### f. SEO and the unpublished shop

Nothing exists: no sitemap, no robots, no JSON-LD, no meta. PLAN §2.4 lists the sitemap and the JSON-LD feed among the cached surfaces, so they are in scope. An unpublished shop answers 404 on every catalogue read (D57); Firebase showed it with `noindex`. D57 promised a preview in CP4. It cannot be a query flag: it has to be minted by the server for the shop's own admin, as the acting-as grant is.

### g. Translations

D16: a static JSON file per language, built from the export. No file and no build step exist. The storefront's `TranslationContext.jsx` reads Firestore today.

---

## 2. Frontend scope

**Today.** One Vite app, one build (`dist`), four Firebase hosting targets (`admin`, `shop`, `platform`, `print`), each a single-page catch-all. The Firebase SDK is a build dependency (`optimizeDeps.include` in `vite.config.js`). There is no `src/api/`, no web Worker, no Cloudflare hosting of any page. `origins.web` is pinned for both environments and nothing answers there.

**The 37 storefront files** (`INVENTORY_CLIENT_DATA.md` §1.3): 32 trivial, 4 moderate (`Checkout.jsx`, `CustomerAccount.jsx`, `EmailVerificationHandler.jsx`, `AffiliateAnalyticsTab.jsx`), 1 heavy (`OrderConfirmation.jsx`, the one realtime listener, which becomes the receipt poll the seed script already uses).

| Group | Files | Needs |
|---|---|---|
| Catalogue pages | `PublicStorefront`, `AllProductsPage`, `TagPage`, `PublicProductPage`, `CollectionPage`, `ProductCollectionPage` | §1 a, b, d |
| Content and legal | `DynamicPage`, `DynamicRouteHandler`, `ShopFooter` | §1 c |
| Shell | `ShopGate`, `ShopNavigation` | the public storefront response, finding 3 |
| Money (CP2 routes exist) | `Checkout`, `OrderConfirmation`, `OrderWithdrawal`, `WithdrawalPage` | the client only |
| Reports (CP3 route exists) | `InfringementReportPage` | the client only |
| Customer account | `ResetPassword`, `VerifyEmailPage`, `EmailVerificationHandler`, `CustomerRegister`, `CustomerAccount` | customer accounts are PORT-LATER (PLAN §3.2; guest checkout and guest withdrawal stay): these five leave the build with them, unless D81 says otherwise |
| Not ported (PLAN §3.2) | 6 affiliate, 5 B2B, 3 review, 2 recovery pages: 16 files | removed from the routes of the Cloudflare build, per the retirement procedure (§3.4) |

**Shared code the pages stand on** and that calls Firebase itself (§1.7, §1.8): `AuthContext.jsx`, `CartContext.jsx`, `TranslationContext.jsx`, `StoreSettingsContext.jsx`, `shopConfig.js`, `legalAcceptance.js`, `productFeed.js`. These are swapped before the pages or with the first of them. `StoreSettingsContext` paints from static defaults and overrides when the data arrives: keep that, it is what makes the first paint equal to the baseline.

**The design gate** applies to every swapped page: re-shoot at 375 / 768 / 1440 on staging and diff against `docs/cf-port/baseline/storefront` (`DESIGN_CONTRACT.md` §4).

---

## 3. Migration scripts

Rows moved into CP4 by D53, D72 and D76. The importer of CP3 prints each as deferred and writes nothing for it.

| Row | Target | Target exists | Needs first | Refuses on (C7) | Checklist (e) |
|---|---|---|---|---|---|
| 51 products | `products`, `product_variants` | yes, without images, tags, featured, order | tenants (done); image copy | `(tenant, sku)` for products and for variants | 12: the predicate's count per shop = the export's public projection (205), identical ids |
| 43 podArtwork | `pod_artwork`, `stored_objects` | yes; lacks `label`, `rights_confirmed`, `created_by`, the legacy print id (D53) | tenants; the copy of originals and print masters | the original's sha256 | 9: every mapped artwork `ready`; the 7 without a print master imported as needing reprocessing |
| 44 podMappings | `pod_mappings` | yes | 51 and 43 | `(tenant, sku, placementSlot)`; a row with no garment | 8: no mapping without a garment, every artwork resolves, every POD product quotes |
| 33 infringementReports | `infringement_reports` | **yes** (0036) | 51: a report names a product | — | none; production holds no report today |
| 20 collections | `collections`, `collection_products` | no | 51 | `(tenant, handle)` | none yet: add one |
| 40 pages | `pages` | no | — | `(tenant, slug)` | 13: no Firebase URL in content or attachments |
| — branding (D76) | `tenant_settings.store_identity_json` | yes | the image copy | — | 13 |

**The storage copy** is new work: about 900 MB (D53), against 4 MB of branding. The manifest (§b) prescribes a server-side copy through the S3 API with multipart upload and a checksum per object, a copy manifest, and that a row holding a rewritten URL is written only when the manifest holds a verified entry (C6). No such tool exists. The largest object moved so far was one 34.5 MB render.

**Facts the importer must respect:**
- The product importer writes one screening row per product with the term version empty, so the re-screen sweep screens it (D72).
- A shop's `published` and its commission follow the rules fixed in CP3 (`CP3_S_REPORT.md` §10.7).
- Prices are kronor in the source and öre in D1: exact conversion or refusal, as the printer tiers do.
- The plan must stay under D1's 100 000 bytes per statement: a product description or a page's HTML can exceed it. The importer refuses such a row today; CP4 needs an answer for it (split the write, or a loader route).
- None of the six rows has been rehearsed on the real bundle. CP3's rehearsal found six defects that invented data could not show.

---

## 4. The split

| Builder | Migration | Owns | Depends on |
|---|---|---|---|
| **P public objects** | 0039 if a column is needed | `object-routes.ts` public admission, a public delivery, the pinned public base URL | D78 |
| **A products** | 0040 | variants CRUD, product images and gallery, tags, featured and order, admin list and read; the public shapes gain images | P's interface |
| **B collections** | 0041 | tables, admin CRUD, public list and detail, the version bump | P's interface |
| **C pages and legal pages** | 0042 | `pages`, admin CRUD, public page by slug, the public legal page from the adopted snapshot | D79, D80 |
| **D storefront response** | 0043 (bump triggers) | the public projection of the identity, menu, features, pickup places; sitemap, robots, JSON-LD; the preview of an unpublished shop | D77, D81 |
| **E client and web Worker** | — | `src/api/*`, the web Worker that serves the build and forwards to `Internal`, the shared contexts | D77 |
| **F page swap** | — | the 16 storefront files that stay (37 − 16 not ported − 5 customer account), in the order trivial → moderate → heavy, the design diff per page | A–E |
| **S scripts** | — | six transforms, the storage copy tool, `verify.mjs` items 8, 9, 10, 12, 13 | the schemas of A, B, C |

P first, or its interface fixed first. A, B, C and D then run in one tree with disjoint files, as the six builders of CP3 did. E can start at once. F is last and is the part a person sees. S starts when the migrations of A, B and C are drafted and lands last.

---

## 5. Open questions (D77–D82 in `DECISIONS.md`)

| # | Question | Recommended default |
|---|---|---|
| D77 | How does the storefront name its shop to the Worker on staging, where one host must serve four shops? | The browser keeps today's path (`/sillmans/cart`): links and baseline stay as they are. The web Worker reads the first segment, looks up that shop's registered hostname and forwards to `Internal` with that hostname. The API keeps ONE rule (hostname), and a browser still cannot name a tenant to the API. A shop on its own domain has no prefix. |
| D78 | How are public images delivered? PLAN §2.5 says a custom domain, D55 says the bucket's `r2.dev` address on staging. | `r2.dev` on staging, pinned; a custom domain with the real domain at CP7. Keys are immutable and versioned, so the change of base is a rewrite of stored URLs, done once. |
| D79 | Are the four legal pages content pages? | No. A route of their own that shows the adopted snapshot. A legal text must not be editable where a content page is. |
| D80 | Page attachments: PLAN §2.5 lists them as private, the manifest (§b row 12) as public. | Public, as Firebase serves them today and as the manifest decided later. Production holds none. |
| D81 | What does the storefront show for a feature that is not ported (reviews, discount codes, recovery)? | Nothing: the public response reports such a feature as off whatever the stored row says. The 16 pages of not-ported features and the 5 customer-account pages leave the Cloudflare build; a visitor buys as a guest. |
| D82 | Product fields with no column (`podPrinterUid`, `podCostSek`, dimensions, B2B price). | Typed columns for what Cloudflare reads; the B2B fields are not carried (B2B is PORT-LATER) and stay in the bundle. |

---

## 6. Risks

1. **Public delivery sits under four builders.** Branding already slipped out of CP3 for this reason (D76). If P is not first, it slips again inside CP4.
2. **The shop in the path** (finding 3) blocks every page at once if it is met during the swap and not before it.
3. **The storage copy is an order of magnitude larger** than anything moved so far, and it writes to R2: the permission rules that make Mikael run the D1 writes will apply to it.
4. **No row of CP4 has met the real bundle.** Rehearse each transform as CP3 did, before its builder is called done.
5. **A statement over 100 000 bytes** is likely among 217 product descriptions and the pages' HTML.
6. **D68 is open** and `infringement_reports` is imported here: a reporter's name and address go into permanent evidence.
7. **CP4 is the first checkpoint a person looks at.** The exit is a visual diff, page by page, and the 21 removed pages change what a visitor can reach: no login, no account, no review form.
