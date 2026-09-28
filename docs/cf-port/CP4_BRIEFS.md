# CP4 builder briefs

Status: written 2026-09-28 on HEAD `a9991384` + the CP4 pre-step. Input: `CP4_GAP_ANALYSIS.md`, `DECISIONS.md` D77–D95, PLAN §2.1, §2.4, §2.5. One brief per builder of the split (gap analysis §4). P is first: products, collections, branding and the storage copy stand on it.

`$CF` = `cloudflare/`.

## 0. Rules for every builder

1. **Working tree only.** No git command that writes, no network, no wrangler, no deploy. The reviewer commits.
2. **Own files only.** The brief lists them. `$CF/src/app.ts` is touched only inside the builder's own `CP4-IMPORTS-x` and `CP4-ROUTES-x` blocks. Reviewer-only files: `wrangler.jsonc`, `src/env.d.ts`, `test/env.d.ts`, `vitest.config.ts`, `pinned.*.json`, `scripts/cf-preflight.sh`, `scripts/cf-deploy.sh`, `REQUIRED_MIGRATION` (in `app.ts` and two tests). What a builder needs there goes into its report under "Reviewer wiring".
3. **Routes.** Exact paths, no prefix wildcard, each wrapped in `onMethods([...])`; a public route also in `storefront(...)`. Id segments come from the raw pathname and are decoded once by the handler. An admin route authorizes first (`authorizeTenantAdminRequest`), answers the opaque admin 404 to anyone else, and demands a same-origin request for every state change, before the body is read.
4. **Tenant.** Every query names the tenant. No route accepts a tenant id from the browser. A public read goes through the ONE predicate (`PUBLIC_ELIGIBILITY_PREDICATE`) wherever a product is shown.
5. **Writes** are audited in the same `batch()` as the change. D1: `meta.changes` counts rows changed by triggers too, so compare with `=== 0`, never `!== 1`. `INSERT OR REPLACE` bypasses DELETE triggers.
6. **Whatever a visitor can see bumps `catalog_version`** in the same batch or by trigger, so the ETag of every cached read changes (PLAN §2.4).
7. **Migrations** take the number the brief gives. `0020` is never used. Time columns of a NEW table are ISO-8601 text written by the server; a column added to an OLD table follows that table (`stored_objects`, `tenants`: integer milliseconds).
8. **Bounded reads.** Every list has `LIMIT` and a cursor; `IN (...)` is chunked at 90; no binary or base64 in a row.
9. **Tests** are part of the work: the refusals first (wrong tenant, no session, foreign origin, wrong method, malformed id, over the cap), then the happy path. Gate before the report: `cd cloudflare && npx tsc --noEmit && npx vitest run` — the whole suite, and the number of tests in the report.
10. **Names.** No file, identifier, comment or document carries a name of the source system's earlier brand or of its resale feature; `node guard/guards.test.mjs` scans every tracked file.
11. **Report:** `docs/cf-port/CP4_<X>_REPORT.md`, shaped as the CP3 reports: files, routes with request and response shapes, schema, what was NOT done, deviations from the brief with the reason, open questions, "Reviewer wiring". A claim in the report is one the builder has run.
12. **When the brief is wrong, say so** in the report and build what is right; do not build around it silently.

---

## P. Public objects

**Goal.** A shop's admin can upload an image that a visitor can see, and every other builder can turn an object id into an address with one call. Nothing that is not a proven image is ever readable in the public bucket.

**Decisions:** D78 (the bucket's managed address on staging), D92 (which files), D93 (removal), D95 (the address is not switched on yet: build against the test value).

### Owns

| File | |
|---|---|
| `$CF/migrations/0039_public_objects.sql` | new |
| `$CF/src/storage/image-sniff.ts` | new, pure |
| `$CF/src/storage/public-objects.ts` | new: the interface of the other builders |
| `$CF/src/storage/object-routes.ts` | existing: admission of public kinds, upload, metadata, removal |
| `$CF/src/storage/object-store.ts` | existing: only what the above needs |
| `$CF/test/image-sniff.test.ts`, `$CF/test/public-objects.test.ts` | new |
| `$CF/test/object-routes.test.ts`, `$CF/test/object-store.test.ts` | existing: the cases that pinned "a public kind is refused" change; every other case stays as it is |

No block in `app.ts`: the admin objects route already calls the handlers of `object-routes.ts`, and its paths and methods do not change.

### Schema (0039)

`ALTER TABLE stored_objects ADD COLUMN width_px INTEGER` and `height_px INTEGER`, both nullable, both `CHECK (… IS NULL OR … BETWEEN 1 AND 100000)`. Nothing else. The kinds stay as the table's rule lists them.

### Admission

| Kind | Bucket | Types | Cap |
|---|---|---|---|
| `product_media` (product images, collection covers) | public | JPEG, PNG, WebP, GIF, AVIF | 15 MB |
| `shop_branding` | public | the same, plus ICO and SVG | 15 MB; SVG 512 KB |
| `preview_image` | — | not admitted: previews are written by the render service, not by an admin | — |
| the four private kinds | private | unchanged | unchanged |

The bucket follows from the kind (`ALLOWED_BUCKETS`); the caller never names it.

1. **Reserve** refuses a public kind whose stated type is not in its list, whose size is over its cap, or while `PUBLIC_BUCKET` or a valid `PUBLIC_OBJECT_BASE_URL` is missing. The refusal for a missing configuration is the same opaque answer an unknown kind gets.
2. **Upload proves the type before the first byte is stored.** The head of the body is read, the type is taken from the bytes (`image-sniff.ts`) and compared with the stated one; only then the whole body, head included, goes to R2 with the declared sha256 as R2's own checksum, as the private path does. R2 needs a body of known length: `FixedLengthStream`. A mismatch stores nothing, leaves the row `pending` and answers 400. An SVG is read whole (it is small by its cap) and checked whole before it is stored.
3. **Stored with** `contentType` = the proven type and `cacheControl: "public, max-age=31536000, immutable"`: a key is never written twice.
4. **Width and height** are read from the file and written to the row at activation. When they cannot be found within a bounded read (a JPEG whose size marker sits behind a large profile), they stay NULL and the upload still succeeds. For an SVG: from `width`/`height` or `viewBox` when they are plain numbers, else NULL.
5. **SVG (D92): refuse, never repair.** Refused when it holds any of: a `script` element, an attribute starting with `on`, `foreignObject`, `iframe`/`embed`/`object`, a `href`/`xlink:href`/`src` that is not a fragment (`#…`) or a `data:image/` of a raster type, `javascript:` anywhere, a `style` element or attribute with `url(` that is not a fragment or with `@import`, a DOCTYPE with an internal subset or any entity declaration, a processing instruction other than the XML declaration, or bytes that are not valid UTF-8. The check is a refusing scan of the text, written so that a doubt refuses. It is not a parser and must not try to be one.
6. **Metadata** (`GET /v1/admin/objects/:id`) of a public object gains `url`, `width`, `height`. The object key stays absent from every response except the reserve answer, as today.
7. **Content** (`GET …/content`) of a public object: the opaque 404. A public object is read at its address; the Worker does not proxy it.
8. **Removal** (D93): the row is tombstoned first, then the bytes leave the bucket the row names. Today's code deletes from the private bucket whatever the row says: that is the bug to fix first, with a test.

### `image-sniff.ts`

Pure functions over `Uint8Array`: no `env`, no I/O, nothing of the Workers runtime, so the importer's copy tool can run the same rules under Node.

- `sniffImageType(head): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif" | "image/x-icon" | "image/svg+xml" | null` from the magic bytes (AVIF: an `ftyp` box whose major or compatible brand is `avif`/`avis`; SVG: only through the full check, never from a glance at the head).
- `readImageDimensions(type, bytes): { width, height } | "need_more" | null` so the caller can fetch a further range.
- `checkSvg(bytes): { ok: true, width, height } | { ok: false, reason }`.
- The stated type `image/jpg` and `image/vnd.microsoft.icon` are read as `image/jpeg` and `image/x-icon`.

Tests use small real files built in the test (a few dozen bytes each is enough for every raster type), truncated files, a file of one type under the name of another, a polyglot (GIF header followed by markup), and one SVG per refusal reason.

### `public-objects.ts` — the interface

```ts
export interface PublicImage {
  objectId: string;
  url: string;            // base + "/" + key, each key segment percent-encoded
  contentType: string;
  width: number | null;
  height: number | null;
}

// A bare https origin from env.PUBLIC_OBJECT_BASE_URL (no path, query,
// fragment, credentials or port games), else null.
export function publicObjectBase(env: Env): string | null;

// For public shapes. Only rows that are active, in the public bucket, of this
// tenant and of one of `kinds`. Anything else is absent from the map, never
// an error. Ids are de-duplicated and chunked at 90.
export function resolvePublicImages(
  env: Env, db: D1Database, tenantId: string,
  objectIds: readonly string[], kinds: readonly PublicObjectKind[],
): Promise<Map<string, PublicImage>>;

// For admin writes: may this tenant reference this object as an image?
// Same conditions as above. The caller refuses the write with 400 on null.
export function getReferencablePublicImage(
  env: Env, db: D1Database, tenantId: string,
  objectId: string, kinds: readonly PublicObjectKind[],
): Promise<PublicImage | null>;
```

With no valid base both answer empty / null: a shape then carries no image, and an admin write that names an image is refused. No other module builds an address of a public object, and no address is stored in a row: rows hold object ids, addresses are made at read time, so the move to a domain of our own at CP7 changes one value.

### Must be proven by tests

- Tenant A cannot reserve into, upload to, read the metadata of, reference or remove an object of tenant B; an ordinary user and a request without a session get the opaque 404 on all of it.
- A public kind with a private bucket, a private kind with a public bucket, and `preview_image` through the admin route are refused.
- Each refusal of the admission list; the upload whose bytes are not what it states stores NOTHING in the bucket (asserted on the bucket itself) and leaves the row `pending`.
- A proven upload is in the PUBLIC bucket under `shops/<tenant>/<kind>/<id>/v1/<name>`, with the type and the cache header, and never in the private one.
- Removal takes the bytes out of the right bucket for both classes.
- `resolvePublicImages`: a pending row, a deleted row, a private row, another tenant's row and a kind outside `kinds` are each absent; 200 ids resolve (chunking); with the base unset the map is empty.
- The 2416 tests that exist stay green, except the named cases that pinned the refusal of public kinds.

### Not P's work

The columns and tables that hold an image on a product, a collection or the branding (A, B, D). The copy of the old images (S). Resized variants of an image: the storefront shows the file that was uploaded, as it does today.

### Reviewer wiring P will name

`PUBLIC_OBJECT_BASE_URL` in `wrangler.jsonc` for both environments, `r2.publicBaseUrl` in the pinned files, the preflight check that the two are equal, `REQUIRED_MIGRATION`.

---

## Order of work

```
P ──► A ──► B ──┐
  ├─► C ────────┼──► F ──► S (lands last; starts when 0040–0042 are drafted)
  └─► D ────────┤
E (starts at once) ┘
```

G (the withdrawal function, D96) stands beside the chain: it needs nothing of P–E and F needs it for two pages. A, C and D start when P's interface is reviewed. B starts when A's public product functions are in the tree. D's menu reads the tables of B and C, whose names and columns this file fixes, so D does not wait for them.

## The address grammar (fixed here, used by D, E, F and S)

The storefront keeps today's addresses. `<root>` is `/<shop>` on the shared host (D77) and empty on a shop's own domain.

| Page | Address |
|---|---|
| Home | `<root>/` |
| Product | `<root>/product/<handle>` |
| All products | `<root>/produkter` |
| Category | `<root>/kategori/<category>` |
| Collection | `<root>/samling/<handle>` |
| Tag | `<root>/tagg/<tag>` |
| Cart, checkout | `<root>/cart`, `<root>/checkout` |
| Order | `<root>/order-return`, `<root>/order-confirmation/<orderId>` |
| Withdrawal | `<root>/angra` |
| Infringement report | `<root>/rapportera-intrang` |
| Content page, post, legal page | `<root>/<slug>` |

The browser reaches the API under `<root-host>/_api/<shop>/v1/…` on the shared host and `/_api/v1/…` on a shop's own domain. Every address the API returns inside a body is a path **relative to the shop's root** (`/product/<handle>`); the web Worker and the client put the root in front. The API never builds an absolute storefront address: on the shared host it sees the shop's internal hostname, which no visitor can use.

---

## A. Products

**Goal.** Everything the product pages show has a home in D1, an admin can read and write all of it, and the public shapes carry it, images included.

**Decisions:** D82 (typed columns for what Cloudflare reads; the B2B fields are not carried), D83 (no mapping is imported; nothing in A depends on one), D92, D93.

### Owns

| File | |
|---|---|
| `$CF/migrations/0040_product_catalogue.sql` | new |
| `$CF/src/catalog/admin-catalog.ts` | existing: the new fields of create and update |
| `$CF/src/catalog/admin-product-reads.ts`, `product-variants.ts`, `product-images.ts` | new |
| `$CF/src/catalog/public-catalog.ts` | existing: the public shapes, the order, the filters, the cursor |
| `$CF/src/catalog/screening-core.ts` | existing: `productScreeningTexts` only |
| `$CF/src/routes/admin-products.ts` | new: the handlers of the new routes |
| `$CF/test/admin-products.test.ts`, `product-variants.test.ts`, `product-images.test.ts` | new |
| `$CF/test/admin-catalog.test.ts`, `public-catalog.test.ts` | existing: additions; a changed case is named in the report |

`handleAdminProductRoute` in `app.ts` keeps serving `POST /v1/admin/products`, `PATCH /v1/admin/products/:id`, `…/publish` and `…/unpublish` through `admin-catalog.ts`. New fields of create and update arrive through the parsers A owns, with no change of `app.ts`.

### First: the field table

Before the schema, A reads the pages that stay (`PublicStorefront`, `AllProductsPage`, `TagPage`, `CollectionPage`, `ProductCollectionPage`, `PublicProductPage`, `ShoppingCart`, `Checkout`, and what they import) and writes, in its report, one row per product field of manifest row 51: **who reads it → where it lives in D1 → in which public shape**. The rule: a field a staying page shows gets a typed home; a field no staying page reads is not carried, and is listed as such. Review counts and rating sums are not carried (D81).

### Schema (0040), the fixed part

- `products` gains `handle TEXT` (the last segment of the product's address today; A finds the rule the source uses, the importer fills it; `UNIQUE (tenant_id, handle)`; NOT NULL after a backfill from the sku for rows that exist), `featured INTEGER NOT NULL DEFAULT 0`, `sort_order INTEGER` (NULL = none), `compare_at_price_minor INTEGER`, `category TEXT`, and the text fields of the field table.
- `product_variants` gains what the variant rail needs: the group a variant belongs to, its size, its position. **Money stays keyed on the variant's sku**: checkout resolves a line by it and must keep doing so unchanged.
- `product_images (tenant_id, product_id, variant_id NULL, object_id, position, alt)`: ONE ordered list per product, the first is the main image; a variant's images are the rows that name it. `object_id` references `stored_objects`.
- `product_tags (tenant_id, product_id, tag)`, tags lowercased and trimmed, index on `(tenant_id, tag)`.
- Tenant-match triggers like those of 0005 on every new table; `catalog_version` bump triggers on insert, update and delete of every new table.

### Routes

| Route | |
|---|---|
| `GET /v1/admin/products` | list: `status?`, `q?` (name or sku prefix), `cursor?`, `limit?` 1–100; each row with its main image and its publication state |
| `GET /v1/admin/products/:id` | one product with variants, images, tags |
| `PUT /v1/admin/products/order` | `[{ productId, sortOrder }]`, at most 200, one batch |
| `POST /v1/admin/products/:id/variants` · `PATCH`, `DELETE …/variants/:variantId` | a variant a paid order names is deactivated, never deleted |
| `PUT /v1/admin/products/:id/images` | the whole ordered list `[{ objectId, alt, variantId? }]`, at most 30; every `objectId` through `getReferencablePublicImage(…, ["product_media"])` |

Every write that changes a text a visitor reads goes through the screening fence exactly as `updateAdminProduct` does, and the new texts (tags, category, the further description, variant labels, image alt texts) join `productScreeningTexts`. A price edit of a variant of a live POD product passes the same PRISGOLV rule as a product's price.

### Public shapes

```ts
interface PublicProductSummary {           // additive to today's
  handle: string; path: string;            // "/product/<handle>"
  image: PublicImage & { alt: string | null } | null;
  lowestPriceMinor: number;                // over the active variants, else the price
  compareAtPriceMinor: number | null;
  featured: boolean; category: string | null; tags: string[];
}
interface PublicProductDetail extends PublicProductSummary {
  images: (PublicImage & { alt: string | null; variantId: string | null })[];
  variants: PublicProductVariant[];        // gains group, size, position, image
}
```

- `GET /v1/products` gains `tag?`, `category?`, `featured?=1`, `cursor?`, `limit?` (1–100, default 100) and answers `nextCursor`. **One shop has 113 public products and today's list stops at 100 without saying so.** Order: `sort_order` ascending with NULL last, then name, then id (`src/utils/productSorting.js`).
- `GET /v1/products/:ref` accepts the product's id or its handle.
- Exported for B and D: `listPublicProductsByIds(env, db, tenant, productIds)` (keeps the order given, drops what the predicate refuses) and `listPublicProducts(env, db, tenant, filter)`. Every one of them through `ELIGIBLE_PRODUCTS_FROM` + `PUBLIC_ELIGIBILITY_PREDICATE`; the predicate itself is not changed.

### Must be proven by tests

Beyond rule 9: a draft's image, tag or variant never appears in a public shape; an image row whose object was removed (D93) is absent and the next one becomes the main image; tenant A cannot attach tenant B's object; the cursor walks 250 products without a gap or a repeat while one is unpublished in between; every write of the new tables changes the ETag; the checkout suite is untouched and green.

---

## B. Collections

**Goal.** Manual and tag-driven collections, readable by the storefront and by a shop's own website (D87).

### Owns

`$CF/migrations/0041_collections.sql`, `$CF/src/catalog/collections.ts`, `$CF/src/routes/admin-collections.ts`, `$CF/src/routes/public-collections.ts`, `$CF/test/collections.test.ts`, `$CF/test/public-collections.test.ts`.

### Schema (0041) — names fixed, D reads them

`collections (collection_id, tenant_id, handle, external_ref NULL, title, description NULL, image_object_id NULL, type 'manual'|'smart', rule_tag NULL, published 0|1, featured 0|1, sort_order NULL, created_at, updated_at)` with `UNIQUE (tenant_id, handle)`, a unique index on `(tenant_id, external_ref)` where it is set, and `CHECK` that a smart collection has a tag and a manual one has none.
`collection_products (tenant_id, collection_id, product_id, position)`, primary key `(collection_id, product_id)`.
Tenant-match and bump triggers as in A.

### Routes

| Route | |
|---|---|
| `GET`, `POST /v1/admin/collections` · `GET`, `PATCH`, `DELETE /v1/admin/collections/:id` | the cover through `getReferencablePublicImage(…, ["product_media"])` |
| `PUT /v1/admin/collections/:id/products` | the whole ordered list, at most 500; every product of the same tenant |
| `GET /v1/collections` | published only: `{ collections: [{ handle, externalRef, title, description, image, path, featured }] }` |
| `GET /v1/collections/:ref` | `ref` = handle, `external_ref` or id, tried in that order. `limit?` 1–100 (default 24), `cursor?`. `{ collection, products: PublicProductSummary[], nextCursor }` |

A handle and an `external_ref` share one namespace per shop: a write is refused when its handle equals another collection's `external_ref` or the reverse, so `:ref` names one collection.

**D87.** The two public routes answer a GET from any origin: `Access-Control-Allow-Origin: *`, no credentials, nothing but public fields, the ETag as every public read, and a rate limit per caller (`src/lib/rate-limit.ts`). What the shop's site needs per product is in A's summary: title, one image with alt, width and height, the lowest price, the path.

A collection's products come from A's exported functions: by ids for a manual collection, by tag for a smart one. B writes no product query of its own.

---

## C. Pages and legal pages

**Goal.** Content pages and posts with per-language text; the legal texts a shop adopted, shown to a visitor as they were adopted.

**Decisions:** D79 (legal pages have a route of their own), D84 (per language), D88 (a post is a kind of page), D94 (no attachments).

### Owns

`$CF/migrations/0042_pages.sql`, `$CF/src/content/pages.ts`, `$CF/src/content/html-refusal.ts`, `$CF/src/routes/admin-pages.ts`, `$CF/src/routes/public-pages.ts`, `$CF/src/routes/public-legal.ts`, `$CF/test/pages.test.ts`, `$CF/test/public-pages.test.ts`, `$CF/test/public-legal.test.ts`. Read-only use of `src/legal/legal-pages.ts` and `src/legal/platform-terms.ts`; a function C needs there is asked for in the report.

### Schema (0042) — names fixed, D reads them

`pages (page_id, tenant_id, slug, kind 'page'|'post', status 'draft'|'published', title_json, content_json, summary_json NULL, meta_title_json NULL, meta_description_json NULL, author NULL, image_object_id NULL, published_at NULL, created_at, updated_at)`, `UNIQUE (tenant_id, slug)`. Each `*_json` is an object keyed by language tag (`sv-SE`), every value a string. `content_json` at most 262 144 bytes.

A slug is refused when it equals a first segment the storefront owns (`product`, `produkter`, `kategori`, `samling`, `tagg`, `cart`, `checkout`, `order-return`, `order-confirmation`, `angra`, `rapportera-intrang`, `_api`, `assets`) or a legal page's key.

### Content is HTML

The storefront cleans page HTML when it renders it (DOMPurify in `DynamicPage.jsx`), and that stays. The server adds a **refusal at write**: content that holds a `script`, `iframe`, `object` or `embed` element, an attribute starting with `on`, or `javascript:` in an address is refused with 400, never repaired (`html-refusal.ts`, a refusing scan like P's SVG check). A Firebase Storage address in the content is refused too: an image of a page is a public object of kind `product_media`, named by its address from `resolvePublicImages`.

### Routes

| Route | |
|---|---|
| `GET`, `POST /v1/admin/pages` · `GET`, `PATCH`, `DELETE /v1/admin/pages/:id` | |
| `GET /v1/pages?kind=post` | published posts, newest first: `{ pages: [{ slug, path, title, summary, author, publishedAt, image }] }`, `lang?`, `cursor?`, `limit?` |
| `GET /v1/pages/:slug` | one published page or post, `lang?` (the shop's default language when absent or unknown) |
| `GET /v1/legal` | which legal pages the shop has: `{ pages: [{ key, path, title }] }` |
| `GET /v1/legal/:key` | the HTML of the latest adoption (`legal_acceptances.texts_json`), with its adoption date. No adoption → 404 |

**The baseline holds four legal pages** (`legal-angerratt`, `legal-integritetspolicy`, `legal-kopvillkor`, `legal-plattformsvillkor`) and `LEGAL_PAGE_KEYS` holds three. The fourth is the platform's own terms: `GET /v1/legal/plattformsvillkor` answers the text of the current published version of the platform terms. C reads `DynamicPage.jsx` for what else that page shows (it renders a second platform text beside the terms) and reports what has a source in D1 and what has none.

A page of an unpublished or suspended shop is a 404, as every public read of it is. Pages and posts are screened content only if the platform's screening reads them today: C checks the source system and reports; it does not add screening on its own.

---

## D. The storefront response, search engines, forwarding

**Goal.** One public read gives the storefront everything it paints from. A search engine gets a finished page and an old address gets a permanent forward.

**Decisions:** D77, D81 (a feature that is not ported reads as off), D87, D88, D57 (preview).

### Owns

`$CF/migrations/0043_storefront.sql`, `$CF/src/storefront/public-storefront.ts` (existing), `$CF/src/storefront/identity-projection.ts`, `$CF/src/storefront/seo.ts`, `$CF/src/storefront/redirects.ts`, `$CF/src/storefront/sitemap.ts`, `$CF/src/routes/public-seo.ts`, `$CF/src/routes/admin-redirects.ts`, `$CF/src/platform/tenant-config.ts` (existing: the branding image keys of the store identity only), and their tests (`test/public-storefront.test.ts` existing; `identity-projection`, `seo`, `redirects`, `sitemap` new).

### The storefront response

`GET /v1/storefront` keeps `name`, `locale`, `currency` and gains:

- `identity`: **an allowlist, key by key**, of `store_identity_json`. D reads `src/config/store.js` and the staying pages, and lists in its report every key with who shows it. A key that is not on the list is never in the response. Never on the list, whatever a page reads today: the return address's owner fields beyond what the legal pages print, VAT number unless a staying page prints it, notification and contact addresses that no page prints, anything under `legal.acceptance`, anything of payments.
- `branding`: `{ logo, hero, favicon, emailLogo }`, each a `PublicImage` or null. The store identity holds **object ids** under `logoObjectId`, `heroObjectId`, `faviconObjectId`, `emailLogoObjectId` and in `gallery[].imageObjectId`; `PUT /v1/admin/settings` accepts them through `getReferencablePublicImage(…, ["shop_branding"])` and keeps refusing every address of the source system's storage.
- `menu`: the shop's menu with every target resolved: an entry whose page or collection does not exist or is not public is left out. Each entry carries its `path`.
- `features`: every key of `FEATURE_KEYS` as a boolean: the stored or default value AND "ported". Ported today: `pod`. All others read `false` (D81). The list of ported keys is one constant, so porting a feature is one line.
- `pickupLocations`, `templateId`, `theme`, `accent` as stored.

0043 adds the `catalog_version` bump triggers on `tenant_settings` and `tenant_features`.

### Search engines and forwarding (D88)

`GET /v1/seo?path=<path relative to the shop's root>` answers ONE of:

- `{ redirect: { to, status: 301 } }` when the shop has a forward for that path;
- `{ page: { title, description, canonicalPath, image, robots, jsonLd, bodyHtml } }` for a home, product, collection, category, tag, page, post or legal page that is public. `jsonLd` holds relative paths under the key `@relative` wherever an address belongs, and the caller makes them absolute; `bodyHtml` is the text a search engine should read (a product's name, price and description; a post's article), built from public fields only and escaped by the server;
- 404 for anything else. The web Worker then serves the application as it is.

`redirects (tenant_id, from_path, to_path, created_at, created_by)`, primary key `(tenant_id, from_path)`. `from_path` is stored in ONE normal form (percent-decoded to UTF-8, NFC, no trailing slash, query dropped, lower-case kept as given) and the lookup normalises the same way: old addresses hold percent-encoded emoji. `to_path` is relative to the shop's root and must not itself be a `from_path` (no chain, no loop). Admin: `GET /v1/admin/redirects` (cursor), `PUT /v1/admin/redirects` (at most 500 per call, one batch), `DELETE`. The importer fills it; the admin page is CP5.

`GET /v1/sitemap` answers `{ entries: [{ path, lastModified }] }` for everything public, at most 5 000 per answer with a cursor. The web Worker writes the XML and `robots.txt`.

### The preview of an unpublished shop (D57) — D's second pass

After the first pass is reviewed. A grant the server mints for the shop's own admin (`POST /v1/admin/preview`), bound to the tenant, 30 minutes, signed; the storefront sends it on its reads; a read with a valid grant uses the predicate WITHOUT its `tenant.published = 1` term and answers `Cache-Control: no-store` with no ETag and `robots: noindex`. **Checkout, payment and every write ignore the grant**: a preview never sells. The predicate of `eligibility.ts` is not edited; the preview's fragment is derived from it in one place, with a test that the two differ in exactly that term.

---

## E. The client and the web Worker

**Goal.** The storefront runs from Cloudflare with no Firebase code in its bundle, and reaches the API through the web Worker.

**Decisions:** D77, D81, D88, D16 (translations as a static file).

### Owns

| | |
|---|---|
| `$CF/web/**` | new: the web Worker (`wrangler.jsonc`, `src/index.ts`, tests, its own `package.json` only if the API's tooling cannot serve it) |
| `src/api/**` | new: the client |
| `src/storefront/**` | new: the storefront's own entry, router and providers |
| `index.storefront.html`, `vite.storefront.config.js` | new |
| `$CF/src/index.ts` | existing: the `Internal` class only |
| `$CF/src/tenancy/shop-hostname.ts`, `$CF/test/shop-hostname.test.ts` | new |

E does not edit a page (that is F), `src/App.jsx`, `vite.config.js` or `index.html`: the build that exists keeps working as it is for the admin and platform pages, which are swapped in CP5.

### The web Worker

1. **Which shop.** A request whose host is the pinned web origin is on the shared host: the first path segment is the shop (`^[a-z0-9][a-z0-9-]{0,62}$`, and not one of the reserved first segments of `src/config/tenancy.js`). Any other host is a shop's own domain and carries no prefix.
2. **`/_api/…`** is forwarded to the API's `Internal` entrypoint over the service binding, method, body and headers as they came, minus every `X-Tenant-*` header. On the shared host through `Internal.fetchForShop(shop, request)`: the API looks up that shop's verified storefront hostname (`shop-hostname.ts`: tenant active, domain `kind = 'storefront'` and `status = 'verified'`, the lowest hostname when several), rewrites the request's host to it and routes it as any other internal request. No hostname → the opaque 404. The API keeps ONE rule, the hostname, and the public entrypoint still takes no tenant from a browser. Only `/_api/<shop>/v1/…` paths that a storefront uses are forwarded: **nothing under `/v1/admin`, `/v1/platform`, `/v1/render`, `/v1/webhooks`, `/v1/staging` or `/api/auth` passes the web Worker.**
3. **A navigation** (GET, `Accept` holds `text/html`, not an asset): one call to `GET /v1/seo?path=`. A redirect answer → `301` with `Location` = root + `to`. A page answer → the application's HTML with title, description, canonical, robots, Open Graph image, JSON-LD and `bodyHtml` (inside the root element) put in by `HTMLRewriter`. A 404 or a failure of that call → the application's HTML untouched: the shop must open when the API is slow or down. The call has a deadline of 1.5 s.
4. **`<root>/sitemap.xml`** from `GET /v1/sitemap`, **`/robots.txt`** with the sitemap's address.
5. **Assets** from the build, hashed files `immutable`, the HTML `no-cache`. Security headers as `firebase.json` sets them today, plus a Content-Security-Policy in report-only mode whose image source is the public object origin.
6. The visitor's address (`CF-Connecting-IP`) is forwarded: the API's rate limits count by it.

### The client (`src/api/`)

One `request()` that knows the root, sends no credentials, reads the API's error shape into a typed error, and lets the browser revalidate by ETag. One module per surface: `storefront`, `products`, `collections`, `pages`, `legal`, `checkout`, `orders` (the receipt poll: every 2 s, at most 90 s, cancelled on unmount, an explicit timeout state — PLAN §2.9), `withdrawal`, `reports`. Shapes are the ones of A–D in this file; where a builder's report differs, the report wins and E says so.

### The providers (`src/storefront/`)

`StoreSettings` keeps painting from the static defaults and overrides when the response arrives: that is what makes the first paint equal to the baseline. `ShopFeatures` from the response's `features`. `Translation` from a static file per language (`src/locales/<lang>.json`; until S delivers it, the keys fall back to the text in the code, as they do today when a key is missing). `Cart` without the discount field while the feature reads off. No sign-in, no account: the storefront tree holds no auth provider.

The router holds the staying addresses of the grammar above and nothing else; an address of a removed page (D81) shows the shop's not-found page.

### Must be proven

- `vite build --config vite.storefront.config.js` succeeds and **its output holds no Firebase code**: a test scans the built files.
- Web Worker: the shop from the path; the reserved segments; an admin path through `/_api` is refused; tenant headers are dropped; a navigation gets the injected head; a slow or failing SEO call still serves the application; a redirect is a 301; the injected text is escaped (a product named `</title><script>` stays text).
- `shop-hostname`: suspended tenant, pending domain, another kind of domain, an unknown shop and a malformed segment each answer nothing.

### Other builders work in `$CF/src` at the same time

E keeps `npx tsc --noEmit` green for its own files and runs its own suites. When the whole suite fails in a file E does not own, E reports it and does not repair it.

---

## G. The withdrawal function

**Goal.** A buyer without an account can withdraw from a purchase on the shop's site, and gets a receipt of it with the time the message arrived. It is a legal duty (DAL 2 kap. 10 a §), in force, and the port had no route for it (D96).

**Source:** `functions/src/withdrawal/functions.ts` — its header states the law and the rules; G reads it whole and ports the GUEST path. Pages: `src/pages/shop/WithdrawalPage.jsx`, `src/components/shop/OrderWithdrawal.jsx`.

### Owns

`$CF/migrations/0044_withdrawals.sql`, `$CF/src/commerce/withdrawals.ts`, `$CF/src/routes/storefront-withdrawals.ts`, `$CF/test/withdrawals.test.ts`, and in `$CF/src/app.ts` two blocks of its own, `CP4-IMPORTS-G` and `CP4-ROUTES-G`, which G adds directly after the D blocks. Read-only use of the order tables and of the outbox and email code; a change G needs there is asked for in the report.

### The rules

1. `POST /v1/withdrawals`, a storefront route, no session. The buyer states the order's number, the address the purchase was made with, a name, and the address the receipt shall go to. G takes the exact fields from the source and from the page.
2. **One answer for "no such order" and "the address does not match"**: the opaque 404. A rate limit per visitor address (`src/lib/rate-limit.ts`), so order numbers cannot be tried out.
3. **The time of receipt is the server's**, written once and never changed. The table is append-only, with the triggers that make it so (UPDATE and DELETE refused, and a BEFORE INSERT guard against `INSERT OR REPLACE`).
4. **The function never refuses while a withdrawal period could still run.** The source's absolute cap (450 days after the order) is the only age limit. Whether the withdrawal is valid is the shop's assessment afterwards; the receipt confirms that the message arrived.
5. **A personalised order** (`orders.is_personalized = 1`, waived at checkout after the disclosure) is answered as not eligible, with the reason. The answer is recorded too: showing it is the function.
6. **A second message for the same order** answers the first one's receipt and writes nothing.
7. **The receipt** is returned in the answer (the page shows it and lets the buyer save it) and sent by mail to the stated address through the outbox and the email queue, in the same batch as the row. A failing mail never fails the withdrawal.
8. **The shop is told**: a mail to the shop's support address through the same path, and the order's admin read shows the withdrawal with its time. **No money moves**: the refund stays the shop's own action.
9. **Personal data (D68):** the row holds the name and the address the buyer stated, because the receipt must name them. No visitor address (IP) is stored in the row.
10. The withdrawal of an order of another shop, of a suspended shop's order and of an order of an unpublished shop: G reads the source and the law's purpose and proposes; the default is that a buyer can always withdraw from an order that exists, whatever the shop's state is today.

The web Worker's allowlist gains `POST /v1/withdrawals` and the client's `withdrawal.js` is aligned by the reviewer when G is reviewed.

---

## F. The page swap

Written in full when A–E are reviewed, because every line of it depends on their final shapes. Fixed now:

- **The 16 files that stay** (`INVENTORY_CLIENT_DATA.md` §1.3), in this order: shell (`ShopGate`, `ShopNavigation`, `ShopFooter`) → catalogue (`PublicStorefront`, `AllProductsPage`, `TagPage`, `CollectionPage`, `ProductCollectionPage`, `PublicProductPage`) → content (`DynamicRouteHandler`, `DynamicPage`) → `InfringementReportPage` → money (`Checkout`, `OrderConfirmation`, `WithdrawalPage`, `OrderWithdrawal`). `ShoppingCart` and `OrderReturn` call no SDK themselves and stay as they are; they are shot and diffed with the rest.
- **Only the data layer changes.** Markup, class names, tokens and copy stay byte for byte; a page's diff shows imports, hooks and field names, nothing else.
- **The gate per page:** re-shoot at 375 / 768 / 1440 on staging and diff against `docs/cf-port/baseline/storefront` (`DESIGN_CONTRACT.md` §4). A difference is either fixed or written down with its cause and accepted by Mikael; the expected ones (no review stars, no account link, no discount field: D81) are listed before the first shot.
- The reviewer looks at every page rendered, not only at its diff.

---

## S. Scripts

Written in full when 0040–0042 are reviewed. Fixed now:

- **Rows:** 51 products (variants, images, tags), 20 collections, 40 pages, 43 artwork, the branding images of row 56 (D76), 33 infringement reports (none today). **Row 44 is not imported (D83):** the importer prints it as deferred to the admin, with the count.
- **The 6 POD products of melodie-mc are imported as POD products without a mapping.** The predicate keeps a POD product without an active mapping off the storefront, so they are not public on Cloudflare until they are tied again. `verify` counts them as an expected difference: the public projection is 205 in the source and 199 on Cloudflare. Importing them as plain products would sell a print that nobody prints.
- **The copy of the files goes through the Worker's own object routes**, not around them: reserve, upload, under a session that acts for the shop. The Worker then proves every file's type (D92), writes the row and the audit line, and the importer holds no second copy of the admission rules. The copy writes a manifest (source address → object id, sha256, size, type); the plan names an object only when the manifest holds its verified entry (C6). A file the Worker refuses is reported by shop and by reason, and the row that named it is imported without that image.
- 495 distinct product images, 12 covers, 17 branding images, 20 artworks. The 3 445 references collapse to the distinct files: one file, one object, many rows.
- **Forwarding (D88):** for the four shops of the export the addresses do not change, so the importer writes no forward. The rule that builds a product's handle is A's, used by both.
- **Translations (D16):** one static file per language from the export, scrubbed of the earlier brand's strings, under `src/locales/`.
- Each transform is rehearsed on the real bundle before its builder is called done, as CP3's were: counts and shapes only, nothing printed from a row's content.
