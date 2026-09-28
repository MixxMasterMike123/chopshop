# CP4-A report — products

Builder: CP4-A. Branch `cf-port`, working tree only (no git writes, no network, no wrangler). Brief: `CP4_BRIEFS.md` §0, the address grammar, §A (and §B for what B calls); DECISIONS D81, D82, D83, D92, D93; `CP4_GAP_ANALYSIS.md` §1a, §3.1; `MIGRATION_MANIFEST.md` row 51. Started on HEAD `25db76e0`; builders C, D, E (committed meanwhile) and G worked in the same tree. None of their files is touched here.

`$CF` = `cloudflare/`.

---

## 1. The field table (manifest row 51)

Rule of the brief: a field a staying page shows gets a typed home; a field no staying page reads is not carried. "Staying pages" = `PublicStorefront`, `AllProductsPage`, `TagPage`, `CollectionPage`, `ProductCollectionPage`, `PublicProductPage`, `ShoppingCart`, `Checkout`, `CartContext`, and what they import to render a product (`NordProductCard`, `productSorting.js`, `productPricing.js`, `productUrls.js`, `productFeed.js` `generateProductSchema` = the product page's JSON-LD, `collectionResolver.js`, `ShopNavigation`, `ProductSocialShare`, `productImages.js`).

| Field (source) | Who reads it | D1 home | Public shape |
|---|---|---|---|
| id | every page (keys, cart line) | `products.product_id` | `productId` |
| name | every catalogue page (title, card, alt, breadcrumb), cart line, SEO title, JSON-LD | `products.name` (+ `product_publications.public_name`, the mirror) | `name` |
| sku | PDP "Art.nr", the product address, cart line, JSON-LD | `products.sku` | `sku`; the end of `handle` |
| (the address segment) | `getProductUrl` on every card and link | `products.handle` **new** | `handle`, `path` |
| category | CollectionPage (`/kategori`), PublicStorefront (nav categories, showcase mode), ShopNavigation breadcrumb, JSON-LD | `products.category` + `products.category_key` **new** | `category`; filter `?category=<key>` |
| group (product-level, legacy) | CollectionPage / PublicStorefront read `category \|\| group` | not a column: the importer writes it into `category` when `category` is empty | via `category` |
| tags | TagPage, `collectionResolver` (smart collections), `isProductFeatured` (legacy tag) | `product_tags (tag, tag_key)` **new** | `tags`; filter `?tag=<key>` |
| featured | PublicStorefront featured grid and "Endast utvalda" (`isProductFeatured`) | `products.featured` **new** | `featured`; filter `?featured=1` |
| sortOrder | `productSorting.js` on every listing page | `products.sort_order` **new** | `sortOrder`; the list order |
| hasVariants | no staying page (the PDP derives it from the rows, says its comment) | not carried | derived: `variants.length` |
| b2cPrice / basePrice | every price (`b2cPrice \|\| basePrice`), cart line, JSON-LD | `products.b2c_price_minor` (+ `public_price_minor`); importer: `b2cPrice ?? basePrice`, kr → öre | `priceMinor`, `lowestPriceMinor` |
| compareAtPrice | PDP and cards (`getCompareAtPrice`, "Rea") | `products.compare_at_price_minor` **new** | `compareAtPriceMinor` |
| b2cImageUrl, b2cImageGallery[], imageUrl | cards (`imageOf`), PDP gallery, og:image, JSON-LD, cart line image | `product_images` rows without a variant **new**; importer: `b2cImageUrl` first, then the gallery; `imageUrl` only when there is no `b2cImageUrl` | `image` (main), `images[]` |
| size | the address (`getVariantProductSlug`), SEO title (`getProductSeoTitle`), feed label | `products.size` **new** | detail `size` (and inside `handle`) |
| color | only the generated placeholder of `productImages.js` (`getProductImage`) when a product has NO image | **not carried**: the placeholder draws a fixed illustration of the source's first product line and is not ported; a product without an image has `image: null` | — |
| description, descriptions.b2c | PDP short description, SEO description, PublicStorefront card, JSON-LD | `products.description` (+ `public_description`); importer: `descriptions.b2c ?? description` | `description` |
| descriptions.b2cMoreInfo | PDP "Mer information" (HTML, cleaned by DOMPurify on render) | `products.more_info` **new** | detail `moreInfo` |
| delivery.{shipping, pickup} | PDP `DeliveryInfo`; cart line → `CartContext` `cartAllowsHome` / `cartAllowsPickup` → Checkout's delivery method | `products.allow_shipping`, `allow_pickup` (0009) | detail `allowShipping`, `allowPickup` — **public now, see Deviation 5** |
| reviewCount, ratingSum | PDP reviews, card stars, JSON-LD rating | **not carried** (D81) | — |
| launchDate | PDP button ("Kommer snart") | `products.launch_date` (YYYY-MM-DD) **new** | detail `launchDate` |
| sizeGuide | PDP "Storleksguide" | `products.size_guide` **new** | detail `sizeGuide` |
| isPersonalized | PDP notice, cart line, Checkout consent | `products.is_personalized` (0031) | detail `isPersonalized` |
| weight | `CartContext.calculateShipping` (the cart's client-side carriage estimate) | `products.weight_grams` (0009) | **not public** (0009: the checkout engine prices carriage). Open question 1 |
| shipping | same | `products.shipping_json` (0009) | **not public**. Open question 1 |
| stock | JSON-LD `availability` (`generateProductSchema`) | `products.stock` **new** (NULL = not tracked; nothing sells by it) | detail `stock` |
| brand | JSON-LD `brand` | `products.brand` **new** | detail `brand` |
| eanCode | JSON-LD `gtin13` | `products.ean_code` **new** | detail `eanCode` |
| isActive, availability.b2c | the filter of every storefront query | `products.status` + `product_publications.published` → THE predicate; importer: active and b2c → `active` + published | not a field (eligibility) |
| variants[].sku / label / price | PDP picker, cart line, `reconcileCart`, JSON-LD offers | `product_variants.sku / label / price_minor` (0005) | detail `variants[]` |
| variants[].group / size | PDP rail picker (model v2.2), card swatches (`NordProductCard`) | `product_variants.variant_group / size` **new** | detail `variants[].group / size`; summary `swatches` |
| (rail order) | the rail | `product_variants.position` **new** | detail `variants[].position` |
| variants[].image / images[] | PDP gallery per variant, card swatch thumbs, cart line image | `product_images` rows naming a variant (the group rule, §4) **new** | detail `variants[].image / images`; `swatches[].image` |
| variants[].optionValues, options[] | PDP v2.1 matrix picker — used only when EVERY variant has `optionValues` | **not carried**: the bundle's variant keys are `sku, label, group, size, price, image, images[]` (gap analysis §3.1); no variant has `optionValues`, so the page never takes that path | — |
| variantGroups[] | the admin rail (ProductForm) only; the storefront reads `variants[]` | not carried as a structure: expanded by the importer into `product_variants` (group, size, position) and images | via `variants` |
| isPodProduct | checkout, the PDP's POD fields | `products.is_pod` | detail `pod` (existing) |
| shopId | — | `tenant_id` | never |
| podCostSek, podPrinterUid | no Cloudflare reader (cost from the printer tiers, routing from `pod_mappings`) | **not carried** (D82, D83) | never |
| b2bPrice, availability.b2b | B2B (PORT-LATER) | **not carried** (D82) | never |
| dimensions | no reader | **not carried** (D82) | never |
| screening{…} | the platform's review | `product_screening` (0024) | never |
| takedown{…} | the platform | `products.takedown_at` (0025) | never |
| createdAt, updatedAt | — | `products.created_at / updated_at` | never (the admin list shows `updatedAt`) |

---

## 2. Files

| File | What |
|---|---|
| `$CF/migrations/0040_product_catalogue.sql` | new (§3) |
| `$CF/src/catalog/admin-product-reads.ts` | new: the product READ layer — rows, tags, variants, image lists, THE GROUP RULE, `loadProductScreeningInput`, the display order and its cursor, the admin list and read. Imports no write path, so `screening.ts` can import it (Reviewer wiring 1) |
| `$CF/src/catalog/admin-catalog.ts` | the new fields in parsers, create, update, publish; the address rules; the order write. `AdminProduct`, `ProductStatus`, the row select, `toAdminProduct` and the stored-carriage readers **moved** to `admin-product-reads.ts` (re-exported here; every importer keeps working) |
| `$CF/src/catalog/product-variants.ts` | new: variant parse, create, update, delete (deactivate when named) |
| `$CF/src/catalog/product-images.ts` | new: image list parse and replace |
| `$CF/src/catalog/public-catalog.ts` | the public shapes, order, filters, cursor; the functions for B and D; the pre-CP4 functions kept as thin wrappers |
| `$CF/src/catalog/screening-core.ts` | `productScreeningTexts` and its input type `ProductScreeningInput` only |
| `$CF/src/routes/admin-products.ts` | new: the 7 admin handlers and the 2 public product handlers (Deviation 7) |
| `$CF/src/app.ts` | only `CP4-IMPORTS-A` and `CP4-ROUTES-A` (8 mounts) |
| `$CF/test/admin-products.test.ts` | new: 50 tests |
| `$CF/test/product-variants.test.ts` | new: 37 tests |
| `$CF/test/product-images.test.ts` | new: 26 tests |
| `$CF/test/admin-catalog.test.ts` | 3 cases changed, none added (73) |
| `$CF/test/public-catalog.test.ts` | 2 cases changed, none added (22) |

**The five changed existing cases:**
1. `admin-catalog` › "creates, publishes, reprices and unpublishes a product": the created product's `toEqual` gains the 14 new fields (all unset; `handle: "lifecycle-tee_SKU-LIFECYCLE"`).
2. `admin-catalog` › "does not expose the collection through another method": `GET /v1/admin/products` is now the admin list, so the "other method" is `DELETE`.
3. `admin-catalog` › "keeps the delivery fields out of the public projection" → "keeps the carriage inputs out of the public projection; the delivery flags are public": weight and carriage table still absent; `allowShipping` / `allowPickup` now asserted present (Deviation 5).
4. `public-catalog` › "returns only the hostname tenant's published active products": the summary's new fields and `nextCursor`.
5. `public-catalog` › "returns public fields and active variants only": the detail's new fields and the variants' rail fields.

Not touched: the rest of `app.ts`, `wrangler.jsonc`, both `env.d.ts`, `vitest.config.ts`, `pinned.*.json`, `REQUIRED_MIGRATION`, `scripts/`, `eligibility.ts`, `src/commerce/**`, `screening.ts`, `pod-mappings.ts`, `public-routes.ts`. No new env var, binding or secret.

---

## 3. Schema (0040)

**`products` gains** (all `ALTER TABLE ADD COLUMN`, each with its own CHECK):

| Column | Type / rule |
|---|---|
| `handle` | TEXT, 1–1200 chars, no `/`. Backfilled `replace(sku, '/', '-')` for rows that exist; `UNIQUE INDEX (tenant_id, handle)`; trigger `products_handle_fill` gives a row inserted without one the same fallback; trigger `products_handle_not_null` refuses clearing it. So: NOT NULL in effect, without breaking the ~15 test fixtures that insert products without a handle. |
| `featured` | INTEGER NOT NULL DEFAULT 0, 0/1 |
| `sort_order` | INTEGER NULL, ±1 000 000 000 |
| `compare_at_price_minor` | INTEGER NULL, 0–100 000 000 |
| `category`, `category_key` | TEXT NULL (1–100; key 1–500, no `/`); two triggers: set together or not at all; index `(tenant_id, category_key)` |
| `more_info` | TEXT NULL, ≤ 20 000 (HTML) |
| `size_guide` | TEXT NULL, ≤ 5 000 |
| `size` | TEXT NULL, 1–50 |
| `brand` | TEXT NULL, 1–100 |
| `ean_code` | TEXT NULL, 1–32 |
| `stock` | INTEGER NULL, 0–1 000 000 000 |
| `launch_date` | TEXT NULL, `launch_date IS date(launch_date)` (only real calendar dates; tested: `2026-02-30` refused, `2028-02-29` accepted) |

**`product_variants` gains** `variant_group` (TEXT NULL, 1–100; `group` is a keyword), `size` (TEXT NULL, 1–50), `position` (INTEGER NOT NULL DEFAULT 0, 0–10 000), index `(product_id, position)`. Nothing about sku, price, `active` or the 0005/0025 triggers changes.

**`product_images`** (new): `tenant_id, product_id, position (0–29), variant_id NULL → product_variants, object_id → stored_objects, alt NULL (1–500), created_at` (ISO text, round-trip CHECK). `PRIMARY KEY (product_id, position)`; unique index `(product_id, COALESCE(variant_id,''), object_id)` (one object once per owner). Triggers: tenant immutable; tenant matches product (insert, update); a named variant belongs to the same tenant and product (insert, update); **the object is this tenant's `active` `product_media` in the `public` bucket** (insert; update OF object_id, tenant_id — so a row whose object was later removed under D93 can still be re-anchored); `catalog_version` bump on insert, update, delete.

**`product_tags`** (new): `tenant_id, product_id, tag_key (1–250, no '/'), tag (1–50), position (0–19)`; `PRIMARY KEY (product_id, tag_key)`, `UNIQUE (product_id, position)`, index `(tenant_id, tag_key)`; tenant triggers; bump triggers.

**On `stored_objects`** (P's table, trigger only): `catalog_version_public_objects_status` — a PUBLIC object whose status changes bumps its tenant's version. This is what makes the ETag move when an image is removed (D93); it also covers B's covers and D's branding. Nothing in `src/storage` reads `meta.changes` (checked).

---

## 4. Rules

**The handle.** The source builds a product's address as `slugify(name + " " + size) + "_" + sku` (`src/utils/productUrls.js` `getVariantProductSlug`) and its product page finds the product by the sku after the LAST `_` (`getSkuFromSlug`). The Worker: `productHandle(name, size, sku)` = `addressSlug(\`${name} ${size ?? ""}\`) + "_" + sku.replace(/\//g, "-")`, where `addressSlug` is `slugify` byte for byte (vectors pinned in `admin-products.test.ts` for the importer). Derived by the server at create; **recomputed when name, size or sku change** (the source's address follows the name too); no admin field. Unique per shop: two products whose name and sku produce one handle → the second write is 409 (tested with `Clash_x`/`y` vs `Clash`/`x_y`). A `/` in a sku becomes `-` (the source's address of such a product never resolved; a path segment cannot carry `/`). `path` = `/product/` + the handle as ONE segment (`encodeURIComponent` plus `!'()*`, the same rule as D's `encodePathSegment`).

**`GET /v1/products/:ref`**: the id, then the handle, then the source's rule — `<anything>_<sku>` finds the product whose sku is the part after the last `_`. An address made before a rename therefore still resolves, as it does today (Deviation 6).

**Category and tag addresses.** `category_key = addressSlug(category)`, `tag_key = addressSlug(tag)` — exactly what `/kategori/<slug>` and `/tagg/<slug>` are made of today. The text is kept as typed (trimmed, NFC) for display. A category or tag whose address is empty (`"!!!"`) is refused with 400. Two tags with one address on one product are refused (a client bug), never collapsed.

**THE GROUP RULE (images).** One ordered list per product; the first row a visitor may see is the main image. A row without a variant is the product's own. A row naming a variant belongs to that variant's GROUP: every size of "Svart" shows the photos of "Svart"; a variant without a group shows only the rows that name it. A group's row is public only while the group has an ACTIVE variant (a sold-out colour's photo is not shown); when the named size itself is inactive, the public shape names the colour's first active size instead, so every `variantId` in a public shape is `null` or a listed variant. Deleting the size a photo is attached to moves the photo to the next size of its group (`UPDATE OR IGNORE`), or removes it when there is none. Why: the source repeats a colour's photos on every size row (3 445 references, 495 distinct files); one row per size would pass the 30-row cap on real products.

**The display order and the cursor.** `sort_order` ascending with NULL last, then the name `COLLATE NOCASE`, then the id — a total order; the cursor is a keyset over it (base64url of `[sortOrder, name, id]`, only the canonical encoding accepted), no OFFSET. The pages sort again with `localeCompare` (`productSorting.js`) as they do today, so the server order only has to be total; the visible order stays theirs.

**Card price.** `lowestPriceMinor` / `isFromPrice` = `getCardPrice` (`productPricing.js`): the cheapest ACTIVE variant priced above zero, else the product's price; "från" when active variants differ.

**Screening.** Every text a visitor reads joins `productScreeningTexts`: the further description (HTML stripped), size guide, category, tags, brand, the product's size, the label, group and size of every ACTIVE variant, every image alt — AFTER the texts of before, so the stored haystack of a product with none of them is byte-identical to CP3's. Every write that changes one of them (product PATCH, variant create/patch/delete, image PUT, publish) goes through THE FENCE exactly as `updateAdminProduct`: guard first, re-screen from the post-write texts when the product stays live, the fence statement otherwise, `products.updated_at` moved forward (the first-publish fence), one retry, then 409. Reads inside a write are plain reads, never a read `batch()` (the race suites count batches). **See Reviewer wiring 1**: the sweep and the mapping paths of `screening.ts` still load only name + description.

**PRISGOLV per variant.** On a POD product that is live after the write: a variant that BECOMES sellable (created active, reactivated) and an active variant whose price is LOWERED must pass (a) `evaluatePodGate` as the product stands and (b) its own floor at the new price — `quoteForProduct` for the set that prints it (the same quote and floor function the gate uses; `null` = a new variant, which the product-level set prints). Removing the LAST active variant makes the base unit required, so the base price is gated then. A raise, or a write to a product that is not live, is not gated (the next publish is, tested). Refusals: 422 with the gate's codes, `pod_unpriced`/`currency_mismatch` read as `pod_unavailable`.

**Money stays keyed on the variant.** Checkout is not touched. A variant a checkout line, a paid order line or a print mapping names is **deactivated**, never deleted (decided in SQL inside the delete batch; the audit row says which happened). Proven through the real checkout, payment and signed webhook.

---

## 5. Routes

Guard order on every admin route: the live session (`authorizeTenantAdminRequest`; tenant = `X-Shop-Id`, acting-as admitted) → the opaque 404 for anyone else; a state change must be same-origin, checked before the body is read; reads need none. Id segments from the raw pathname, decoded once, 1–128 chars, no `/` (else 404). Errors: 400 `{error:{code:"invalid_request",message}}` (the image route adds `reason`), 404 `{error:{code:"not_found",message:"Route not found"}}`, 409 `{error:{code:"conflict"|"variant_limit",message}}`, 422 `{error:{code,message}}`.

| Method + path | Request | Answer |
|---|---|---|
| `GET /v1/admin/products` | `status?` (draft\|active\|archived), `q?` (name or sku prefix, ASCII case-insensitive, `%`/`_` literal, 1–100), `cursor?`, `limit?` 1–100 (50); any other or repeated parameter → 400 | `{ products: AdminProductListItem[], nextCursor }`, display order. `AdminProductListItem = { productId, sku, name, handle, status, priceMinor, currency, featured, sortOrder, category, isPod, published, screeningStatus, takenDown, image: PublicImage & {alt} \| null, updatedAt }` |
| `GET /v1/admin/products/:productId` | — | `{ product: AdminProduct, publication: {published, publishedAt} \| null, variants: AdminVariant[] (≤ 200, rail order, inactive included), variantsTruncated, images: AdminProductImage[] }` |
| `PUT /v1/admin/products/order` | `[{ productId, sortOrder: int \| null }]`, 1–200, each product once | `{ products: [...] }`; 404 (nothing written) when one id is not this shop's; one batch, one audit row `product.reorder` |
| `POST /v1/admin/products/:productId/variants` | `{ sku, label, priceMinor, group?, size?, position?, active? }` | 201 `{ variant: AdminVariant }`; 409 `conflict` (sku taken in the shop) / `variant_limit` (100 active, 200 in all); 422 PRISGOLV |
| `PATCH /v1/admin/products/:productId/variants/:variantId` | non-empty subset of the same | `{ variant }`; same errors |
| `DELETE /v1/admin/products/:productId/variants/:variantId` | — | `{ outcome: "deleted", variant: null }` or `{ outcome: "deactivated", variant: AdminVariant }` |
| `PUT /v1/admin/products/:productId/images` | `[{ objectId, alt?, variantId? }]`, 0–30 | `{ images: AdminProductImage[] }`; 400 `reason: image_not_referencable \| variant_not_found` |
| `POST /v1/admin/products`, `PATCH /v1/admin/products/:id` (existing, `app.ts`) | gain `brand, category, compareAtPriceMinor, eanCode, featured, isPersonalized, launchDate, moreInfo, size, sizeGuide, sortOrder, stock, tags` (absent = unchanged; `null` or `""` clears a text; `tags` replaces the list, ≤ 20) | `{ product: AdminProduct }` |
| `GET /v1/products` (public) | `tag?` (a tag's key), `category?` (a category's key), `featured?=1`, `cursor?`, `limit?` 1–100 (100); other or repeated parameters → 400 | `{ products: PublicProductSummary[], nextCursor }`, ETag = `catalog_version`, 304 |
| `GET /v1/products/:ref` (public) | id, handle, or `…_<sku>` | `{ product: PublicProductDetail }`, ETag, 304; 404 "Product not found" |

`AdminProduct` = `{ productId, sku, name, description, priceMinor, currency, status, isPod, screeningStatus, weightGrams, allowShipping, allowPickup, shippingRates, handle, featured, sortOrder, compareAtPriceMinor, category, tags, moreInfo, sizeGuide, size, brand, eanCode, stock, launchDate, isPersonalized }`. `AdminVariant` = `{ variantId, sku, label, priceMinor, active, group, size, position }`. `AdminProductImage` = `{ position, objectId, alt, variantId, image: PublicImage \| null }` (null = the object no longer resolves; the admin sees it to fix the list).

**Public shapes:**

```ts
interface PublicProductSummary {
  productId; sku; name; description; priceMinor; currency;            // as before
  handle: string; path: string;                                       // "/product/<handle, one encoded segment>"
  image: (PublicImage & { alt: string | null }) | null;               // the main image
  lowestPriceMinor: number; isFromPrice: boolean;                     // getCardPrice
  compareAtPriceMinor: number | null;
  featured: boolean; sortOrder: number | null; category: string | null; tags: string[];
  swatches: { label: string; image: PublicProductImage | null }[];    // NordProductCard's variant hint
}
interface PublicProductDetail extends PublicProductSummary {
  images: (PublicProductImage & { variantId: string | null })[];
  variants: { variantId; sku; label; priceMinor; group; size; position; image; images }[]; // active only, rail order, ≤ 100
  pod; allowShipping; allowPickup; isPersonalized; moreInfo; sizeGuide; size; brand; eanCode; stock; launchDate;
}
```

---

## 6. Exported for B and D (exact signatures)

`src/catalog/public-catalog.ts`:

```ts
listPublicProductPage(env: Env, db: D1Database, tenant: TenantContext, filter: PublicProductFilter): Promise<PublicProductPage>
listPublicProductsByIds(env: Env, db: D1Database, tenant: TenantContext, productIds: readonly string[]): Promise<PublicProductSummary[]>
getPublicProductByRef(env: Env, db: D1Database, tenant: TenantContext, ref: string): Promise<PublicProductDetail | null>
listPublicProductPageVersioned(env, db, tenant, filter): Promise<Versioned<PublicProductPage> | null>
getPublicProductByRefVersioned(env, db, tenant, ref): Promise<Versioned<PublicProductDetail | null> | null>
interface PublicProductFilter { tag?: string | null; category?: string | null; featured?: boolean; cursor?: DisplayCursor | null; limit?: number }
interface PublicProductPage { products: PublicProductSummary[]; nextCursor: string | null }
PUBLIC_PRODUCT_LIMIT = 100; MAX_PUBLIC_PRODUCTS_BY_IDS = 100
```

- `listPublicProductsByIds`: the order given, duplicates once, whatever THE predicate refuses (draft, hidden, another shop's) dropped. More than 100 distinct ids throws `RangeError` (a caller bug: B pages its collection first).
- `listPublicProductPage`: `filter.tag` / `filter.category` are the ADDRESS forms — call `productTagKey(tag)` / `categoryKey(category)` from `admin-catalog.ts`. `filter.cursor` is decoded: `decodeDisplayCursor(string)` from `admin-product-reads.ts` (null → 400). A limit outside 1–100 throws `RangeError`.
- B's smart collection: `listPublicProductPage(env, db, tenant, { tag: productTagKey(ruleTag), cursor, limit })`.
- Also exported: `addressSlug`, `productHandle`, `productPath`, `productTagKey`, `categoryKey` (admin-catalog.ts); `loadProductScreeningInput`, `encodeDisplayCursor`, `decodeDisplayCursor` (admin-product-reads.ts).
- Every one of them runs through `ELIGIBLE_PRODUCTS_FROM` + `PUBLIC_ELIGIBILITY_PREDICATE`, naming the tenant twice; the predicate is not changed.

The pre-CP4 `listPublicProducts(db, tenant)`, `getPublicProduct(db, tenant, id)`, `listPublicProductsVersioned`, `getPublicProductVersioned` keep their signatures (three suites I do not own, `public-routes.ts` and D's `seo.ts` call them). They run the same queries with no `env`, so they carry no image. Marked `@deprecated`.

---

## 7. What was NOT done

- `screening.ts` is not edited: the sweep (`rescreenStaleScreenings`) and the mapping create/delete rescreens still load only name + description (Reviewer wiring 1).
- No HTML refusal on `moreInfo` (C's `html-refusal.ts` did not exist when I wrote this; the storefront cleans it with DOMPurify as today). Open question 3.
- No admin page, no storefront page, no client change (F, E).
- No importer (S). What S needs is in Open question 4.
- The base-unit PRISGOLV case (removing the last active variant of a live POD product) is implemented but **not covered by a test** (it needs the floor to move after publish).

---

## 8. Deviations from the brief

1. **Tags keep their case; the key is separate.** The brief: "tags lowercased and trimmed, index on (tenant_id, tag)". TagPage shows the tag as its page title (`Nyhet`, not `nyhet`) and matches the URL by `slugify`, which a lowercase column cannot do (`Sommar 2026` ↔ `sommar-2026`). So `product_tags` holds `tag` (as typed, trimmed) and `tag_key` (`slugify`), index on `(tenant_id, tag_key)`. D's queries on `tagged.tag` keep working.
2. **Category gets a key too** (`category_key`), for the same reason (`/kategori/<slug>`).
3. **`listPublicProducts(env, db, tenant, filter)` is `listPublicProductPage`**, and "by id or handle" is `getPublicProductByRef`: the name `listPublicProducts` belongs to a 2-argument function that suites outside my files call.
4. **The summary carries more than the brief's shape**: `isFromPrice`, `swatches` and `sortOrder` (every card shows "från" and the variant hint; every listing page re-sorts by `sortOrder`); the detail carries every PDP field of the field table; each public variant carries `images` besides `image`.
5. **The delivery flags are public.** CP2's decision (pinned by the changed case 3) kept `allowShipping`/`allowPickup` out of every public shape. The product page prints them and the cart restricts the delivery method with them, so F cannot keep the pages as they are without them; weight and the carriage table stay out. **The reviewer should accept or reject this explicitly.**
6. **`GET /v1/products/:ref` also resolves the source's sku rule**, not only id and handle, so no old address breaks after a rename (D88 assumed the addresses do not change).
7. **The public product handlers live in `routes/admin-products.ts`**, the one route file I own; the old mounts in `app.ts` and the old handlers in `public-routes.ts` still exist and are shadowed for GET by the `CP4-ROUTES-A` mounts.
8. **Images follow the group rule** (§4), not "the rows that name the variant" literally.
9. `product_images` has a `created_at` column, `PRIMARY KEY (product_id, position)` and a CHECK of 30 positions; the `stored_objects` status trigger lives in 0040.
10. Caps not in the brief: 100 active and 200 variants in all per product (the public read and the POD gate read bounded sets), 20 tags per product.
11. The read layer moved out of `admin-catalog.ts` (§2) so that the reviewer's wiring of `screening.ts` does not create an import cycle.
12. `PATCH /v1/admin/products/:id` writes `sort_order` only when it names it: the order route is a second writer with no screening fence, and the old code wrote every column it had read.
13. `isPersonalized` is now writable by the admin (0031 said "no CF route writes it yet (CP5)"); the admin must be able to write every field the pages show.

---

## 9. Open questions

1. **The cart's carriage estimate.** `CartContext.calculateShipping` reads each line's `weight` and `shipping`; on Cloudflare they are not public (0009). Either the cart shows the checkout quote's `shippingMinor`, or the reviewer decides the rates and the weight may be public. F needs the answer before `ShoppingCart`.
2. **A product with no image.** The source draws a generated placeholder; Cloudflare answers `image: null`. F decides the empty tile.
3. Should `moreInfo` (HTML) get C's write-time refusal (`html-refusal.ts`), as pages do?
4. **For S (the importer):** handle = `productHandle(name(sv-SE), size, sku)`; `category_key`/`tag_key` = `addressSlug`; `category` = `category || group`; `featured` = the boolean, or the legacy `featured` tag while the boolean is unset (and whether that tag stays a tag — it would show at `/tagg/featured`); one variant row per source variant with `variant_group`, `size`, `position`; images written once per colour (anchored on its first size), product images first; at most 30 image rows, 100 active variants and 20 tags per product — the rehearsal must count these on the real bundle; any sku with `/` is reported.
5. D's `seo.ts` finds a product by exact handle and picks its main image without the group rule; `getPublicProductByRef(...)` gives both the source's sku rule and the same main image the storefront shows. D's `slugify`/`productPath` and my `addressSlug`/`productPath` are the same rules in two files.

---

## 10. Reviewer wiring

1. **REQUIRED before deploy — `src/catalog/screening.ts`:** (a) `ScreeningStatementsInput.texts?: ProductScreeningInput` (import the type from `./screening-core`); (b) in `screeningStatementsFor`, when `texts === undefined`, replace the `SELECT name, description FROM products …` read with `await loadProductScreeningInput(db, tenantId, productId)` from `./admin-product-reads` (null → the same fence-only return). Until then the rescreen sweep and a POD mapping change re-screen — and re-store `screened_tokens`/`screened_raw` — from name + description only, so a later term change's SQL safety check cannot see a product's tags, category or other new texts. (My write paths pass the full texts today: a `ProductScreeningInput` is structurally a `{description, name}`, and `productScreeningTexts` reads the rest.) No cycle: `admin-product-reads.ts` imports nothing from `screening.ts`.
2. `REQUIRED_MIGRATION` → `0040_product_catalogue.sql` (or the last CP4 migration), in `app.ts` and the two tests that pin it.
3. Consolidation: remove the old `PRODUCTS_PATH` / `PRODUCT_PATH_PREFIX*` mounts and the product handlers of `public-routes.ts`, move D's `seo.ts` to `getPublicProductByRef`, then delete the four `@deprecated` functions; the unused `getPublicProduct, listPublicProducts` imports at the top of `app.ts` go with them.
4. `TENANT_REFUSAL_CODES` is restated in `routes/admin-products.ts`; one copy should remain.
5. Optional: an `evaluatePodGate` option to price one unit at a proposed price would replace the two-step PRISGOLV check of `product-variants.ts` with one call.

---

## 11. Tests

- `npx tsc --noEmit`: exit 0.
- My suites: `admin-products.test.ts` 50, `product-variants.test.ts` 37, `product-images.test.ts` 26 (113 new), `admin-catalog.test.ts` 73 (3 changed), `public-catalog.test.ts` 22 (2 changed) — all green. Also run green with them: `checkout`, `screening`, `screening-settings`, `pod-publish`, `pod-mappings` (473 tests with the two catalog suites).
- Proven: refusals first (no session, a platform session without a grant, another shop's admin, a foreign or missing Origin, a method the route does not own, malformed and over-long ids, every cap, every invalid field); a draft's image, tag and variant never in a public shape; a removed object (D93, through `DELETE /v1/admin/objects/:id`) absent, the next row the main image, the ETag moved; tenant A cannot attach tenant B's object (route and trigger); the cursor walks 250 products with no gap and no repeat while one is unpublished between pages; the first page stops at 100 and says there is more (113); every write of the new tables and every variant write moves `catalog_version`; checkout prices a line at the variant's price under its sku, follows an edit, keeps the frozen line, refuses an inactive variant; named variants deactivated (checkout, paid order after the webhook), unnamed deleted; PRISGOLV on create, lower, raise, reactivate, and on a product that is not live (its publish refuses); every new text screened on PATCH, on publish, on variant writes and on image alts; the fence re-runs a variant write and an image write that a platform approval raced, and answers 409 with nothing written when it keeps racing.
- **Whole suite** (`npx vitest run`, after my last change): 86 files, 3 649 tests — **3 646 passed, 2 failed, 1 skipped.** Both failures are outside my files and come from builder D's work in progress:
  - `test/admin-settings.test.ts` › "the storefront, the product list and the product page carry none of it": `/v1/storefront` now answers `identity.heroHeadline` and `pickupLocations` (D's identity projection) and the CP3-A leak test forbids them.
  - `test/web-worker.test.ts` › "serves the application through the real API, which has no head route yet": D's `/v1/seo` now exists, so the navigation gets an injected head.

---

## Review round 1 (reviewer, 2026-09-28)

Read line by line: the migration, `public-catalog.ts`, `product-variants.ts` (the gate, the three writes, the delete), the update path of `admin-catalog.ts`, the change of `screening-core.ts`. Read in outline: `admin-product-reads.ts`, `product-images.ts`, the route file. Run by the reviewer after the changes below: `tsc` clean; **the whole suite, 86 files, 3656 tests passed.**

**Changed by the reviewer:**

1. **Wiring 1 done: a screening that is handed no texts reads every text of the product** (`screening.ts` loads through `loadProductScreeningInput`). The sweep after a change of terms and a change of a print mapping now screen what a publish screens. One test added.
2. **Deviation 8, the personalised flag: reverted.** `isPersonalized` is not a field a seller can write; a body that names it is refused. The flag takes a buyer's right of withdrawal away (with the disclosure and the box at checkout), and D46 gives it to the studio's buyer flow (CP6). A seller who could set it on a catalogue product could remove the right from every purchase. It stays readable.
3. **Open question 3 answered: the further description passes the HTML refusal at write** (`src/content/html-refusal.ts`), as a page's content and the adopted legal texts do. Test added for both refusals.
4. **Wiring 7 of D: the trigger on public objects is removed from 0040.** 0043's cover every public object.

**Deviations accepted:** 1–7 and the rest of 8. **On 4** (`allowShipping`, `allowPickup` public): accepted. They say which ways of delivery a product offers, the product page prints them and the cart needs them; the weight and the carriage table stay private.

**Answers to the open questions:** 1: the cart shows the carriage of the checkout's own quote, when the buyer has chosen a country; an estimate before that is not shown. F builds it so; the rates stay private. 2: a product without an image shows none; the generated placeholder of the source is a matter of the page, not of the API. 4 and 5: carried into S's brief and into the one pass that moves D's reads to A's functions.

**Waiting for the consolidation (after B):** wiring 3 (the older public product mounts and the deprecated functions go, D's reads move to A's functions), wiring 4 (one list of refusal codes), `REQUIRED_MIGRATION`.
