# CP4-K report — consolidation

Builder: CP4-K. Branch `cf-port`, working tree only (no git writes, no network, no wrangler, no deploy). Started on HEAD `219f4301`, tree clean. `$CF` = `cloudflare/`.

Baseline before any change: `npx vitest run` — **88 files, 3810 tests passed**.

**While I worked, another agent changed files in the same tree** that I did not touch (I read only their `git diff --stat` and the diff of the two wrangler and pinned files): `$CF/wrangler.jsonc`, `$CF/web/wrangler.jsonc`, `$CF/pinned.*.json`, `scripts/cf-preflight.sh`, `guard/preflight.test.sh`, `vite.storefront.config.js`, `src/api/*`, `src/components/shop/*`, `src/pages/shop/*`, `src/storefront/*`, and new `src/api/lists.test.mjs`, `src/storefront/adapters/`, `src/storefront/replacements/`. The gate below ran on that tree.

**The rule I applied.** A difference is *named* when the brief names it or when the documents the brief tells me to read name it and the reviewer answered it (A's open question 5 and "Review round 1": "carried into … the one pass that moves D's reads to A's functions"). A difference I found myself is *not named*: there I stopped that part, left the code as it was, and describe the difference below. Every difference claimed here was run: a scratch suite (`test/zz-k-scratch.test.ts`, deleted after the runs; no copy is in the tree) exercised D's own reads against the functions of A, B and C on today's code. Its 8 difference cases passed before I changed anything; its 8 probes of the old product mounts assert a placeholder on purpose, so that the runner prints each actual answer.

| Step | State |
|---|---|
| 1 One address rule | **done**, except the `pagePath` pair (they differ; kept apart) |
| 2 The public gate | **done** |
| 3 D reads products through A | **partly done**: the product page moved; the three product lists **stopped** (their order would change) |
| 4 D reads collections and pages through B and C | **partly done**: the list of the four legal pages is one list; the collection page, the content page and the legal texts **stopped** |
| 5 The older product routes go | **done**, with one 404 kept (below) |
| 6 Small things | **done** |

---

## Step 1 — one address rule

**New:** `$CF/src/storefront/addresses.ts` — `slugify`, `encodePathSegment` (the segment rule the builders use), `HOME_PATH`, `ALL_PRODUCTS_PATH`, and the path builders `productPath`, `collectionPath`, `categoryPath`, `tagPath`, `pagePath`. I count five builders plus the two fixed paths; nothing else built a storefront path twice. `encodeStorefrontPath` (a stored forward target written as an address) stays in `redirects.ts`, using the segment rule from `addresses.ts`.

**Deleted duplicates:** from `redirects.ts` (D): `slugify`, `encodePathSegment`, `HOME_PATH`, `ALL_PRODUCTS_PATH`, and all five path builders. From `admin-catalog.ts` (A): `addressSlug`, `categoryKey`, `productTagKey`, `productPath`. `admin-catalog.ts` re-exports `addressSlug` (= `slugify`) and `productPath` because `test/admin-products.test.ts` imports them from there. `categoryKey` and `productTagKey` had no importer left and are gone; their callers use `slugify`.

**Importers moved to `addresses.ts`:** `admin-catalog.ts` (`productHandle`, the category/tag keys), `collections.ts`, `public-catalog.ts`, `seo.ts`, `sitemap.ts`, `identity-projection.ts` (`readProductPathsBySku` now uses the one `productPath`), `test/storefront-fixtures.ts`.

**Proof, before the merge.** A comparison run of each duplicate against its twin over 19 inputs: Swedish letters in both cases (`Rökt & Gött`, `Ärlig Åsa ÖL`, `åäö ÅÄÖ`), upper case, `&` alone and inside text, spaces/tab/newline, leading and trailing spaces, emoji (`🎉 fest 🎉`, `👍`), the empty string, only punctuation (`!!!`, `?#/%`, `---`, `-_-`), `a/b`, `tee_A B(1)`, 10 000 × `x`, and `"Å " × 3000 + 🎉`. Result: 43 passed, 15 failed.

- `addressSlug`, `categoryKey`, `productTagKey` (A) vs `slugify` (D): **equal on all 19** → merged.
- `productPath` (A) vs `productPath` (D): **equal on all 19** → merged.
- `pagePath` (C, `content/pages.ts`) vs `pagePath` (D): **different on 15 of 19 → NOT merged, both kept.** C's is `` `/${slug}` `` (no encoding); D's is `` `/${encodePathSegment(slug)}` ``. Example: C `"/Rökt & Gött"`, D `"/R%C3%B6kt%20%26%20G%C3%B6tt"`; C `"/a/b"`, D `"/a%2Fb"`; C `"/!!!"`, D `"/%21%21%21"`. They agree on `""`, `"-_-"`, `"---"`, the 10 000 × `x` string, and on every slug `PAGE_SLUG_PATTERN` admits (`[a-z0-9-]`, which 0042's CHECK enforces), so every path either answers today is the same. D's now lives in `addresses.ts`; C's stays in `pages.ts` with a comment that says why.

**Permanent test:** `$CF/test/addresses.test.ts` (new, 25 tests) pins the one module's answers for the same 19 inputs, proves that A's re-exports are the same function objects (`addressSlug === slugify`, `productPath === productPath`), and pins the kept-apart pair: equal on admitted slugs, different on exactly those 15 inputs.

Suites after step 1: tsc clean; 13 files, 794 tests passed (`addresses, admin-products, admin-catalog, collections, public-collections, public-catalog, seo, sitemap, identity-projection, public-storefront, redirects, pages, public-pages`).

## Step 2 — the public gate gets a home

**New:** `$CF/src/storefront/public-shop.ts` — `publicShopStatement(db, tenantId)` and its row type `PublicShopRow` (`shop_name, default_locale, default_currency, support_email, catalog_version`), `WHERE tenant_id = ? AND status = 'active' AND published = 1 LIMIT 1`.

**Deleted:** `publicTenantStatement` + `PublicTenantRow` (C, `content/pages.ts`); `shopStatement` + `ShopRow` (D, `public-storefront.ts`).

**Callers moved:** `content/pages.ts` (`readPublicPage`, `listPublicPages`), `catalog/collections.ts` (`listPublicCollections`, `readPublicCollection`), `routes/public-legal.ts` (three reads), `storefront/public-storefront.ts` (`isPublicShop`, which keeps its own "and the shop has a name" check, and `getPublicStorefrontVersioned`).

**Why nothing changes:** the WHERE clause is the same text in both old statements; the only difference is the column list, and every caller reads only its own columns from the row (C and B read `catalog_version`/`default_locale`; D reads all five). No row is copied into a response.

After this step the tenant condition `status = 'active' AND published = 1` is written in exactly one place in `$CF/src` besides THE predicate itself (which carries `tenant.status`/`tenant.published` and is not edited). The other `published = 1` hits in `$CF/src` are `collections.published` and `publication.published`.

Suites after step 2: tsc clean; 11 files, 653 tests passed (`pages, public-pages, public-legal, collections, public-collections, public-storefront, seo, sitemap, identity-projection, admin-settings, web-worker`).

## Step 3 — D reads products through A

**Done — the product page.** `seo.ts` `productPage` now calls `getPublicProductByRef(env, db, tenant, handle)`. Deleted from `seo.ts`: `findPublicProductByHandle`, `ProductRef`, `mainProductImage`, `PRODUCT_IMAGES_READ`, and the call of the deprecated `getPublicProduct`. The image, the canonical path (`product.path`), the category, the name, the description, the sku and the currency come from A's detail; the offer is built as before from:

- **lowest price** = `product.lowestPriceMinor`, **"from"** = `product.isFromPrice` — THE NAMED CHANGE: a variant priced 0 is never the lowest price;
- **highest price** = the highest active variant price above zero, else the lowest (only read when `isFromPrice`, so an `AggregateOffer` always has `highPrice > lowPrice`);
- `offerCount` = `product.variants.length`, unchanged (the active variants; a variant priced 0 still counts — see "Unsure").

What comes with A's function besides the price, both named in A's open question 5 and carried into this pass by the reviewer's answer, and both proven by the scratch run on the old code and again after the switch:

- **P2 — the lookup.** A finds a product by its id, its handle, or the source system's sku rule (the sku after the last `_`). D found it by exact handle only. Before: `/product/<productId>` and `/product/old-name_<sku>` answered 404. After: a page whose `canonicalPath` is the product's own handle path, as the storefront's `GET /v1/products/:ref` already shows a product at those addresses.
- **P3 — the main image.** A applies the group rule: an image row that names a variant whose group has no active variant (a sold-out colour) is not shown. D took the first row whose object resolved. Before: the sold-out colour's image led the SEO page; after: the storefront's main image does.

**Test for the named change:** no existing test pinned the old number. The only product of `seo.test.ts` with variants (`tee`) has active variants at 149 and 199 and an inactive one at 1: both rules answer 149–199. I **added** one case to `test/seo.test.ts` ("a product's price is the storefront card's: a variant priced 0 is never its lowest price"), in its own shop so no other case sees its products: variants [0, 129, 159] → `AggregateOffer` 129.00–159.00, "Från 129,00 kr" (D's read answered `lowPrice` "0.00"); [0, 119] → `Offer` 119.00 (D: `AggregateOffer` 0.00–119.00); [0] → `Offer` at the product's price 99.00 (D: 0.00). The same case reads `GET /v1/products/<handle>` and checks the card says the same.

**Stopped — the three lists** (`listAllProductLinks`, `listCategoryProductLinks`, `listTagProductLinks` stay in `seo.ts`). Moving them to `listPublicProductPage` changes their order. D orders by `sort_order IS NULL, sort_order, publication.public_name, product.product_id` with the column's default (binary) collation (`product_publications.public_name` is declared `TEXT` in 0005). A orders by `displayOrderBy`: the same columns but `name COLLATE NOCASE`. Proven: two public products `apple` and `Banana`, no sort order — D's `/produkter`, `/kategori/frukt` and `/tagg/frukt` list `Banana, apple`; `listPublicProductPage` lists `apple, Banana`. With more than 60 public products the set of the first 60 can differ too. The change would make the search-engine list agree with the storefront, but the brief does not name it.

`publicCategoryNames` / `publicTagNames` stay in `seo.ts`: A exports no such read. `readProductPathsBySku` stays in `identity-projection.ts` and now uses the one `productPath`.

Suites after step 3: tsc clean; 6 files, 191 tests passed (`seo, sitemap, public-storefront, identity-projection, public-catalog, web-worker`; run together with the scratch suite, whose P2/P3 cases then failed as expected: the SEO page now follows A).

## Step 4 — D reads collections and pages through B and C

**Done — one list of the four legal pages.** D's `LEGAL_PAGES` and `LegalPageKey` are deleted from `seo.ts`; `seo.ts` and `sitemap.ts` use C's `PUBLIC_LEGAL_PAGES` and `PublicLegalKey` (`routes/public-legal.ts`). Proven equal before the removal (a one-case run: `LEGAL_PAGES` mapped `label → title` `toEqual` `PUBLIC_LEGAL_PAGES`, four entries, same order). D's reads of `page.label` now read `page.title`, the same four strings.

**Stopped — `collectionPage` → `readPublicCollection`.** Proven on the old code:

- a **smart** collection's products come from `listPublicProductPage`, so they take A's NOCASE order (`/samling/frukt`: D `Banana, apple`; B `apple, Banana`) — the step-3 difference again;
- B resolves `:ref` by handle, external reference or id; D by handle only (`/samling/ext-1`: D 404, B the collection). This one is removable exactly: the three names share one namespace per shop (0041's triggers), so checking `collection.handle === handle` after B's read gives D's answer for every ref;
- a **manual** collection gives the same products in the same order both ways (proven for two members; B collects the first `limit` public members in position order, as D's `ORDER BY member.position` with `LIMIT 60` does).

**Stopped — `contentPage` → `readPublicPage`.** C's language pick and D's differ on rows the admin route itself writes. Proven with a post whose content is `{ "en": "<p>English</p>", "sv-SE": "   " }` and whose author is `" Kim "` (both admitted by C's parser: content values are not trimmed or dropped, and `parseAuthor` keeps surrounding spaces): D's page shows "English" and "· Kim"; C answers the content `"   "` and the author `" Kim "`. By reading, also: C's pick takes any non-empty value (`length > 0`), D's any non-blank (`trim().length > 0`); for an unknown language C falls back in sorted key order, D in the stored order (equal for rows C wrote, which are stored sorted; not for other writers); a title with no text falls back to the slug in D, to `""` in C.

**Stopped — `legalPageTexts` → `readPublicShopLegalPage` / `listPublicLegalPages`.** Proven on the old code:

- **the platform terms:** D shows `/legal/plattformsvillkor` while a version is published (the latest with `published_at <= now`); C lists and serves it only when that version's text is archived (`platform_terms_texts`). With the 0031 seed and no archived text, D answers a page and C does not. `test/seo.test.ts` ("the platform terms once a version is out") and `test/sitemap.test.ts` pin D's rule, and `seo.test.ts` calls `legalPageTexts` directly;
- **a blank adopted text** (`kopvillkor: "   "`): D has no page, C answers the page with `html: "   "`;
- by reading: the sitemap's `lastModified` of the legal pages is the adoption's `accepted_at` and the terms' `published_at`; `listPublicLegalPages` returns neither.

`readMenuResolutions` and the sitemap's sections stay as they are (B and C export no keyset read of their own).

Suites after step 4: tsc clean; 5 files, 154 tests passed (`seo, sitemap, public-legal, public-storefront, web-worker`).

## Step 5 — the older public product routes go

**New:** `$CF/src/routes/public-products.ts` — A's `PUBLIC_PRODUCTS_PATH`, `PUBLIC_PRODUCT_ROUTE`, `parsePublicProductListQuery`, `handlePublicProductListRoute`, `handlePublicProductRefRoute`, moved verbatim from `routes/admin-products.ts`; the ref segment is read by a local `refSegment` with the same rule as `admin-products.ts`'s `segment(request, 3, 1200)`. `admin-products.ts` keeps the admin routes; its header no longer lists the public ones.

**Deleted:**

- `app.ts`: the `PRODUCTS_PATH` mount and constant, the old handler call on the prefix mount, `productIdFromPath`, and the unused imports `getPublicProduct`, `listPublicProducts`, `getPublicStorefront`, `handlePublicProductRequest`, `handlePublicProductsRequest`. The CP4-IMPORTS-A block now imports the two public handlers from `routes/public-products.ts`.
- `storefront/public-routes.ts`: `handlePublicProductsRequest`, `handlePublicProductRequest` (the file keeps `versionedJsonResponse` and the storefront handler).
- `catalog/public-catalog.ts`: the four `@deprecated` functions (`listPublicProducts`, `getPublicProduct`, `listPublicProductsVersioned`, `getPublicProductVersioned`); with them the id-only branch of `detailStatement` (now `detailStatement(db, tenant, ref)`), the `Env | null` parameters of the private helpers (now `Env`: every caller has one), and `listPage` (folded into `listPublicProductPage`, its only caller).
- `storefront/public-storefront.ts`: `getPublicStorefront` and `StorefrontRow` (nothing called them).

**One 404 kept.** The brief says the older mounts are unreachable for GET. The exact-path mount was (A's `/v1/products` precedes it); the prefix mount was not. Run on the old code, these GETs reached it and answered `404 {"error":{"code":"not_found","message":"Product not found"}}`: `/v1/products/`, `/v1/products/a/b`, `/v1/products/<sku>/`, `/v1/products//x`. With the mount gone they would answer the router's `"Route not found"`. So the prefix mount stays as one line that answers that same 404 (`getOnly(storefront(() => notFoundResponse("Product not found")))`), and every other method falls through as it did. Run after the change: all eight probes (the four GETs; HEAD on `/v1/products` and `/v1/products/<sku>` → bodiless 404; POST on both → `"Route not found"`) answer byte for byte what they answered before. If the reviewer accepts `"Route not found"` for those four paths, the mount and `PRODUCT_PATH_PREFIX` can go.

**Suites moved to the replacements** (test changes are listed below). Suites after step 5: tsc clean; 11 files, 600 tests passed (`pod-publish, screening, screening-settings, public-catalog, admin-products, admin-catalog, web-routing, web-worker, seo, public-storefront, health`).

## Step 6 — small things

- **`TENANT_REFUSAL_CODES`**: one table, exported from `catalog/admin-catalog.ts` beside `AdminRefusalCode` and `refused()`, with the reason as its comment. `app.ts` (`adminResultResponse`) and `routes/admin-products.ts` (`refusedResponse`) import it. Both old copies were the same two entries.
- **`test/storefront-fixtures.ts`**: the `CREATE TABLE IF NOT EXISTS` of `product_images`, `product_tags`, `collections`, `collection_products`, `pages` and the `ALTER TABLE products ADD COLUMN` of `handle`, `featured`, `sort_order`, `category` are removed, and so are the column probes (`columnsOf`) of the seeders: `seedProduct` always writes `category_key`, and the tag rows always carry `tag_key` and `position`, which is what the probes chose on the migrated tables. `ensureStorefrontTables` is kept for its callers and now only checks that the five migrated tables exist (it throws naming the table otherwise). The INSERTs are unchanged.

Suites after step 6: tsc clean; 11 files, 473 tests passed (`collections, identity-projection, public-collections, public-storefront, seo, sitemap, admin-products, product-variants, admin-catalog, pod-publish, money-followups`).

---

## THE predicate: the files that name it

`grep -rln PUBLIC_ELIGIBILITY_PREDICATE $CF/src $CF/test`:

| Before | After |
|---|---|
| `src/catalog/eligibility.ts` | `src/catalog/eligibility.ts` |
| `src/catalog/public-catalog.ts` | `src/catalog/public-catalog.ts` |
| `src/catalog/screening.ts` | `src/catalog/screening.ts` |
| `src/commerce/checkout.ts` | `src/commerce/checkout.ts` |
| `src/storefront/identity-projection.ts` | `src/storefront/identity-projection.ts` |
| `src/storefront/seo.ts` | `src/storefront/seo.ts` |
| `src/storefront/sitemap.ts` | `src/storefront/sitemap.ts` |

Seven files before, seven after: never more, but not fewer. `seo.ts` still names it for the three lists (stopped) and for `publicCategoryNames`/`publicTagNames` (the brief keeps them); `sitemap.ts` and `identity-projection.ts` keep their reads by the brief. Lines naming `PUBLIC_ELIGIBILITY_PREDICATE` or `ELIGIBLE_PRODUCTS_FROM` outside `eligibility.ts`: 43 → 41 (`seo.ts` 15 → 13, `findPublicProductByHandle` gone). Every product a visitor sees still goes through the fragment: the product page now through A's `PUBLIC_PRODUCT_COLUMNS` + `stillPublic`.

## Every test changed

| File | Change | Why |
|---|---|---|
| `test/pod-publish.test.ts` | `getPublicProduct(env.DB, ctx, id)` → `getPublicProductByRef(env, env.DB, ctx, id)` (9 sites); `handlePublicProductRequest(env, request, "pdp-tee")` → `handlePublicProductRefRoute(env, request)` (3 sites; each request's URL is `/v1/products/pdp-tee`, from which the new handler reads the ref); `handlePublicProductsRequest(env, request)` → `handlePublicProductListRoute(env, request)` (1 site); imports | step 5: the functions are gone. Every assertion is unchanged; the list body is now `{ products, nextCursor }`, and the case reads only its status, ETag and `expectNoCostKeys` |
| `test/screening.test.ts` | `listPublicProducts(env.DB, ctx)` → `(await listPublicProductPage(env, env.DB, ctx, {})).products` (1 site); `getPublicProduct(env.DB, ctx, id)` → `getPublicProductByRef(env, env.DB, ctx, id)` (6 sites); import | step 5. Assertions unchanged |
| `test/screening-settings.test.ts` | `getPublicProduct(env.DB, …)` → `getPublicProductByRef(env, env.DB, …)` (1 site); import | step 5. Assertions unchanged |
| `test/seo.test.ts` | **one case added**; no existing case changed | step 3's named change; no existing case pinned the old number (above) |
| `test/addresses.test.ts` | **new file**, 25 tests | step 1's proof |
| `test/storefront-fixtures.ts` (a helper, not a test) | DDL and column probes removed; `ensureStorefrontTables` checks the tables; `slugify` from `addresses.ts` | step 6 |

No test was skipped, weakened or deleted.

## Line counts

| File | Before | After |
|---|---|---|
| `src/storefront/seo.ts` | 1183 | 1113 |
| `src/storefront/identity-projection.ts` | 741 | 741 (one import path) |
| `src/catalog/public-catalog.ts` | 779 | 681 |
| `src/app.ts` | 2811 | 2772 |

Also: `redirects.ts` 587 → 529, `admin-products.ts` 356 → 257, `public-routes.ts` 116 → 80, `public-storefront.ts` 224 → 170, `test/storefront-fixtures.ts` 512 → 424; new `addresses.ts` 79, `public-shop.ts` 33, `routes/public-products.ts` 107, `test/addresses.test.ts` 124.

## Unsure

1. **P2 and P3 counted as named** (the lookup by id and sku rule, the group-rule image), on the strength of A's open question 5 and the reviewer's answer. If the reviewer reads "one named change" strictly, P2 alone can be undone with `product.handle === handle` after A's read (exact except when a product's id equals another product's handle); P3 cannot without D's own image read.
2. **`offerCount`** still counts every active variant, a variant priced 0 included, while the prices skip it. The brief names only the prices.
3. **The kept 404 mount** in `app.ts` (step 5): a one-line answer to keep a message; delete it if `"Route not found"` is acceptable there.
4. **`ensureStorefrontTables` repurposed** as an existence check rather than deleted, because four suites call it and the brief allows test edits only for steps 3 and 5.
5. `admin-product-reads.ts` `resolveProductImages` still takes `Env | null`, and its comment still mentions callers without an env; no such caller remains in `public-catalog.ts`. Not changed (not needed by any step).
6. The web Worker and the client were not touched and no response shape changed; the only JSON that changes is the SEO answer of a product page (price, and P2/P3 above).

## Gate

Run after the last code change, on the tree as it stands (with the other agent's changes):

- `cd cloudflare && npx tsc --noEmit` — exit 0.
- `npx tsc --noEmit -p web` — exit 0.
- `npx vitest run` — **Test Files 89 passed (89); Tests 3836 passed (3836); 0 failed, 0 skipped.** (3810 + 25 in `addresses.test.ts` + 1 in `seo.test.ts`.) The two "Network connection lost" lines appeared, as known.
- `node --test src/api/api.test.mjs` — 20 tests, 20 pass, 0 fail.
- `node cloudflare/web/check-storefront-build.mjs` — built; "9 files (5 text) checked, no Firebase code, every file servable".
- Not part of the gate: `node guard/guards.test.mjs` **fails** on 15 stale entries of `guard/allowlist.txt`, every one a storefront page under `src/components/shop/` or `src/pages/shop/` that the other agent is rewriting. None of the 23 files I created or changed matches any of the guard's patterns (checked by hand; the guard reads tracked files only).

---

## Review round 1 (reviewer, 2026-09-28)

Read: the two new modules, the diff of `app.ts`, the diff of `seo.ts`; the rest of the diff in outline (it is removal and changed imports). Run by the reviewer: `tsc` clean for both projects; **the whole suite, 89 files, 3836 tests passed, 0 failed, 0 skipped** (read from the run's summary line).

**K stopped where a merge would have changed an answer, and proved each difference first.** That is what the brief asked for, and the stops are accepted as they stand.

**Changed by the reviewer:** `offerCount` of a product's offers counts the variants that were priced (above 0), the same ones the two prices come from. One pinned number changed with it (3 → 2).

**On what K was unsure of:** P2 and P3 are accepted: an older address of a product gets the page of the product with its canonical path, and the image a search engine is given is the one the storefront leads with. The kept 404 under the product prefix stays. `ensureStorefrontTables` as a check of existence stays.

**What the stops found, and what becomes of it.** Each is a place where two reads of the same thing answer differently today. None is a fault a visitor meets on the data of the export; each is settled with the page swap's gate, when the pages and the answer for search engines are looked at side by side:

| Where | The difference | Settled as |
|---|---|---|
| Product lists | D orders names byte by byte, A without regard to case | A's order is the storefront's. The lists of the answer for search engines move to A's when the gate has shown the pages |
| A content page | C answers a content of white space only, and an author with spaces around it; D falls back and trims | C's write refuses a content of white space only and trims the author (a fix of C, small) |
| The platform's terms | C shows them when their text is archived; D when a version is published | C's rule: a page without its text is no page |
| A legal page whose adopted text is blank | a page for C, none for D | D's rule: a blank text is no page. With the refusal at adoption a blank text cannot be adopted |
