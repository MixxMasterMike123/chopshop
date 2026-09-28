# CP4-S2 report — the rows, and the locale files

Builder: CP4-S2. Branch `cf-port`, working tree only: no git writes (one `git add -N`, see Deviation 12), no network, no wrangler. HEAD at start `1c7adaa5`; S1 worked in the same tree and the reviewer committed S1 (`91b58ced`) while I worked. None of S1's files is touched here. Brief: `CP4_BRIEFS.md` §0, §S ("Rules of S", "The copy manifest", S1, S2, "What was fixed earlier"). Every number below comes from a run I made; nothing of a row's content is quoted.

---

## 1. Files

| File | |
|---|---|
| `scripts/cf-port/migrate/import-catalogue.mjs` | new. The CLI and `runImportCatalogue`: bundle + copy manifest + target state → `plan.sql`, `plan.json` (with `expected`), `apply.md`. Also `--print-queries` / `--state-from` for the target state |
| `scripts/cf-port/migrate/verify-catalogue.mjs` | new. The actual state's queries, its builder, and `runChecks` (PASS/FAIL per check) |
| `scripts/cf-port/migrate/lib/transform-products.mjs` | new. Row 51 → `products`, `product_variants`, `product_tags`, `product_images`, `product_publications`, `product_screening`; the helpers the four transforms share (counting, rows, öre, e-mail scrub of texts, image resolution against the manifest) |
| `scripts/cf-port/migrate/lib/transform-collections.mjs` | new. Row 20 → `collections`, `collection_products` |
| `scripts/cf-port/migrate/lib/transform-pages.mjs` | new. Row 40 → `pages` |
| `scripts/cf-port/migrate/lib/transform-branding.mjs` | new. The branding images of row 56 (D76) → one UPDATE of `tenant_settings.store_identity_json` per shop |
| `scripts/cf-port/migrate/lib/worker-rules.mjs` | new, **not in the brief's list** (Deviation 1): loads the Worker's own rules from `cloudflare/src` |
| `scripts/cf-port/build-locales.mjs` | new. The export's translations → `src/locales/*.json`, scrubbed |
| `src/locales/sv-SE.json`, `en-GB.json`, `en-US.json` | generated (intent-to-add in the index, Deviation 12) |
| `scripts/cf-port/migrate/test/import-catalogue.test.mjs` | new: 16 tests (end to end on `node:sqlite`) |
| `scripts/cf-port/migrate/test/worker-rules.test.mjs` | new: 6 tests |
| `scripts/cf-port/migrate/test/build-locales.test.mjs` | new: 5 tests |
| `scripts/cf-port/migrate/test/catalogue-fixtures.mjs` | new: test support (migrated sqlite, wrangler-shaped query files, an invented copy manifest, the objects the copy would have written, an invented catalogue bundle). Also used by the rehearsal |

Not changed: `state-from-queries.mjs` and every other file of CP3's importer (the two tools carry their own queries and reuse `extractJsonArray` / `resultsOf`), S1's files (imported: `copy-manifest.mjs`, `copy-sources.mjs`), `cloudflare/**`.

---

## 2. The tools and their options

### `import-catalogue.mjs`

```
node scripts/cf-port/migrate/import-catalogue.mjs --print-queries --env staging
node scripts/cf-port/migrate/import-catalogue.mjs --state-from <dir> --state-out <target-state file>
node scripts/cf-port/migrate/import-catalogue.mjs --env staging --bundle <dir> --copy-manifest <file>
     --target-state <file> --out <dir outside the repo> [--email-map <file>] [--scrub-unmapped]
```

| Option | |
|---|---|
| `--env` | `staging` only. Production is refused (Deviation 4) |
| `--bundle` | the export bundle; verified first (`verify-bundle.mjs`), schema version checked. The plan's clock is its `exportedAt` |
| `--copy-manifest` | S1's `copy-manifest.json`, read and validated by S1's `readCopyManifest`. Refused when its `env` is not `--env` or its `bundleManifestSha256` is not the sha256 of this bundle's `manifest.json` |
| `--target-state` | required: the read-only state of staging AFTER the file copy and BEFORE this apply (below) |
| `--out` | refused inside the repository (`lib/outside-repo.mjs`); files 0600 |
| `--email-map`, `--scrub-unmapped` | staging's rule D20/S3 applied to every e-mail address inside a TEXT the plan writes (descriptions, further information, page HTML, titles, …): mapped, or the placeholder, or the run refuses (Deviation 5). Pass CP3's map |
| `--print-queries` | prints the 10 read-only queries of the target state as commands through `scripts/cf-preflight.sh` |
| `--state-from` / `--state-out` | the query results (wrangler `--json` files) → the target-state JSON; strict (a row of another shape refuses); refused inside the repository |

**Target state** (10 queries): `counts` (rows per shop of every table the plan writes), `import_runs`, `tenants` (status, published, currency, catalog_version), `tenant_settings` (identity text, `updated_at`, `updated_by`), `users` (CP3's `legacy_id_map`), `products` (id, shop, sku, handle), `variants`, `collections`, `pages`, `objects` (every public `stored_objects` row).

**Refusals** (each a `problems` line; nothing written): production; no target state; a copy manifest of another bundle or environment; no completed CP3 run of THIS bundle in the target; this run id already there; any run still `running`; a completed catalogue run of this bundle already there; a product id, sku or handle, a variant id or sku, a collection id / handle, a page id / slug the target already holds (by kind, counted); an object the manifest names as copied that is not in the target as an active public object of that shop, of the kind of its use, under `objectKeyOf(entry)`; an unmapped e-mail address without `--scrub-unmapped`; everything `lib/plan-checks.mjs` refuses (verbs, one line per statement, 100 000 bytes, the storage hosts, on staging every e-mail address of the bundle's shops, users, products, collections and pages that is not mapped to itself).

**Run id:** `catalogue_staging_<bundle sha 16>_<options 16>`, the options being the copy manifest's sha, the target state's sha, the e-mail map and `--scrub-unmapped`. Same inputs → same bytes (rehearsed: two builds, byte-identical).

### `verify-catalogue.mjs`

```
node scripts/cf-port/migrate/verify-catalogue.mjs --print-queries --env staging
node scripts/cf-port/migrate/verify-catalogue.mjs --state-from <dir> --state-out <actual-state file>
node scripts/cf-port/migrate/verify-catalogue.mjs --env staging --bundle <dir> --plan <plan dir> --actual-state <file>
```

Two sides, never one: what the target holds from `--actual-state`, what it must hold from `plan.json` `expected` (the plan's rows and the target's counts BEFORE the apply). 11 queries (`import_runs`, `tenants`, `counts`, `products`, `public_now`, `public_if_live`, `bad_objects`, `tenant_settings`, `branding_objects`, `screening`, `storage_texts`). The public projection is counted with the Worker's own `ELIGIBLE_PRODUCTS_FROM` + `PUBLIC_ELIGIBILITY_PREDICATE`; `public_if_live` is the same query with only the shop gate lifted (the one `INNER JOIN tenants AS tenant` replaced by a subquery answering every shop as active and published; refused loudly if the Worker's FROM changes shape).

Checks, per shop of the plan: **run** completed; **counts** of the ten tables = before + plan; **ids** every product id present; **handle** none without; **public** once live = the plan's published non-POD products, and NOW = that for a live shop / empty for a shop not yet live; **objects** no image row, cover or page image without the shop's own active public `product_media`; **storage** no product or page text naming the source's storage (S1's marker list); **version** `catalog_version` moved; **branding** the identity names exactly the plan's image ids, each an active public `shop_branding` object of the shop; **public total** = source − POD (205 − 6 = 199); **screening** no product approved by the importer, and the count waiting for the re-screen (informational); **bundle** verifies. Exit 0 only when nothing fails.

### `build-locales.mjs`

```
node scripts/cf-port/build-locales.mjs --bundle <dir> [--out <dir>]      (default out: src/locales/)
```

One flat `{ key: text }` per language, keys sorted, `JSON.stringify(…, null, 2)` + newline; key = document id, text = `value || translation` (the source's `TranslationContext.jsx`). The bundle is verified first. Refused/left-out rules in §5.

---

## 3. The mapping (source field → table and column)

**Ids** are kept (product, collection, page: the source document id, `[A-Za-z0-9_-]{1,128}`, else left out); a variant's id is `deterministicId('product_variant', env, productId, sku)` (`lib/ids.mjs`). Times: `products`/`product_variants`/`product_publications` integer ms; every newer table ISO. Every value of a row goes through the Worker's own parser of the admin route that writes that row (`parseCreateProductInput`, `parseCreateVariantInput`, `parseProductImagesInput`, `parseCollectionInput`, `parseCollectionProductsInput`, `parsePageInput`, `parseStoreSettingsInput`), field by field: an optional field the Worker refuses is left out and counted; a refused core refuses the row.

### products (0005, 0009, 0031, 0040)

| Source | Column |
|---|---|
| id | `product_id` |
| shopId | `tenant_id` (only shops CP3 imported; others counted) |
| isActive | `status`: `active`, else `draft` |
| sku | `sku` |
| name | `name` |
| descriptions.b2c ?? description | `description` (`''` → NULL) |
| b2cPrice ?? basePrice (kr) | `b2c_price_minor` — exact öre or the product is left out (`price_not_exact`) |
| tenants.default_currency (target) | `currency` |
| isPodProduct === true | `is_pod` |
| weight.value | `weight_grams` (the source prices carriage from the value as grams whatever the unit; a unit other than `g` is counted) |
| delivery.shipping !== false | `allow_shipping` |
| delivery.pickup !== false | `allow_pickup` (Deviation 7) |
| shipping.{eu,nordic,sweden,worldwide}.cost (kr) | `shipping_json` in the Worker's wire form (`toShippingRatesWire`), öre; a cost that is not exact drops the whole table (counted) |
| — | `is_personalized` 0 (D46; a source `true` is counted, never carried) |
| productHandle(name, size, sku) | `handle` (the Worker's function) |
| featured, else the legacy `featured` tag while unset | `featured` |
| sortOrder | `sort_order` |
| compareAtPrice > 0 (kr) | `compare_at_price_minor`; `0` = none → NULL (the source shows it only above 0) |
| category (non-blank) ?? group | `category` (the Worker's parser trims/NFC) + `category_key` = slugify |
| descriptions.b2cMoreInfo | `more_info` (the Worker's `checkHtml`; refused → left out, counted) |
| sizeGuide | `size_guide` |
| size | `size` |
| brand, eanCode, stock, launchDate | `brand`, `ean_code`, `stock`, `launch_date` (none in the export) |
| createdAt, updatedAt | `created_at`, `updated_at` (clamped `updated ≥ created`) |

Not carried (A's field table): hasVariants, options[], variantGroups as a structure, color, reviewCount/ratingSum, podCostSek, podPrinterUid, b2bPrice, availability.b2b, dimensions, migratedFrom, wooKey, shopifyKey.

### product_variants

| Source | Column |
|---|---|
| variants[i] (the embedded list, in its order) | one row each; `position` = i (the source's `variants[]` order equals group × sizes of `variantGroups` on every product of the export: checked) |
| variants[i].sku | `sku` (unique per shop; a repeat left out) — a sku over the admin's 64 characters is kept (Deviation 8) |
| .label, .group, .size | `label`, `variant_group`, `size` |
| .price (kr) | `price_minor`, exact or the variant is left out |
| — | `active` 1, `attributes_json` NULL, times = the product's |

### product_tags

`tags[]` → `tag` (trimmed, NFC), `tag_key` = slugify, `position`; a tag without an address, over 50 characters, a second tag with the same address, or past 20 is left out and counted.

### product_images (THE GROUP RULE)

The product's own list first: `b2cImageUrl`, else `imageUrl`, then `b2cImageGallery[]` in order (`variant_id` NULL). Then each colour once, in rail order, anchored on its FIRST variant: the images of its `variantGroups` entry (`image`, then `images[]`), else of its first variant. An address → an object id only when S1's manifest holds it `copied` for this shop and the kind of its use is `product_media`; otherwise the image is left out and counted by status (`refused`, `missing`, `failed`, `not_in_manifest`, `not_source_storage`, `wrong_kind`). One object once per owner. **The 30-row cap:** kept by priority — the main image, then each colour's first photo, then the rest of the product's own, then the rest of each colour's — and the kept rows keep their natural order. `alt` NULL, `created_at` = the plan's clock.

### product_publications + product_screening (published products only)

`isActive && availability.b2c === true` → `product_publications` (published 1, public name/description/price = the product's, `published_at` = `updated_at`), and `product_screening` = `status 'advisory'`, `reason` NULL, `hits_json '[]'`, `requires_approval` 0, `decided_by 'import'`, `terms_version` NULL, `screened_tokens`/`screened_raw` NULL, `version` 1 (Deviation 3). A draft or unpublished product has no screening row, as a new product of the Worker has none.

### collections, collection_products

| Source | Column |
|---|---|
| id | `collection_id` |
| title, handle | `title`, `handle` (the Worker's parser; a handle that is not a fixed point of slugify is refused, not repaired; absent → slugify(title)) |
| description | `description` (`''` → NULL) |
| imageUrl | `image_object_id` (copied, `product_media`, else NULL and counted) |
| type, rule.tag | `type`; `rule_tag` only when smart |
| published, featured, sortOrder | their columns |
| createdAt ?? updatedAt, updatedAt | `created_at`, `updated_at` |
| — | `external_ref`, `created_by`, `updated_by` NULL |
| productIds[] (manual only) | `collection_products` in order: only products this plan imports in the same shop; a repeat, a dangling id, past 500 left out and counted |

### pages

| Source | Column |
|---|---|
| id, slug | `page_id`, `slug` (the Worker's grammar and reserved list) |
| kind ?? type | `kind` (`post`, else `page`) |
| status | `status` (`published`, else `draft`) |
| title, content | `title_json`, `content_json` (a string → `{ "sv-SE": … }`; keys sorted as `pages.ts` `mapJson`) |
| summary, metaTitle, metaDescription | their `*_json` (blank → NULL) |
| author | `author` |
| imageUrl / image | `image_object_id` (copied, `product_media`) |
| createdAt | `published_at` (published pages; the source has no date of its own) |
| createdAt, updatedAt | `created_at`, `updated_at` |
| createdBy, updatedBy | `created_by`, `updated_by` through CP3's `legacy_id_map`, else NULL |
| attachments | not carried (D94), counted |
| an image of the source's storage inside the HTML (found by S1's `sourceAddressesInHtml`) | replaced by the copied object's public address `publicObjectUrl(publicObjectBase(pinned r2.publicBaseUrl), objectKeyOf(entry))`; an `<img>` whose file was not copied is removed and counted; any other such address makes `checkHtml` refuse the page |

### tenant_settings (the branding, D76)

ONE `UPDATE` per shop of the identity CP3 wrote (read from the target state): `sanitizeStoreIdentity`, any string still naming the source's storage removed (CP3 removed two hosts, the Worker refuses five markers), then `logoUrl → logoObjectId`, `heroImageUrl → heroObjectId`, `faviconUrl → faviconObjectId`, `emailLogoUrl → emailLogoObjectId`, `gallery[i].imageUrl → gallery[i].imageObjectId` — only copied objects of the shop whose use's kind is `shop_branding`, never over an id already set — and `menu` only when the target's identity has none. The whole object passes `parseStoreSettingsInput`, and `storeIdentityImageRefs` must read back exactly the ids written. `updated_at` = the plan's clock, `updated_by 'import'`. Guard: `WHERE tenant_id AND updated_at AND updated_by` as the target state read them `AND length(CAST(store_identity_json AS BLOB))` = its length, so an identity an admin changed since is not overwritten (tested; verify then FAILs the branding check). Row hash key `<tenant>#catalogue-branding` (CP3's is `<tenant>`).

### catalog_version

Every table the plan writes that a visitor sees has its bump trigger (0025, 0040, 0041, 0042, 0043); a draft product's own row does not bump (0025 bumps on UPDATE of `products`), and a draft is not seen. So the plan writes no bump of its own; `verify` checks the version moved for every shop.

---

## 4. The rehearsal (real bundle, invented manifest, local sqlite)

As item 12 asks: a `node:sqlite` database with every migration (0001–0045), CP3's applied plan (`import-2026-09-28/plan/plan.sql`) executed on it, S1's `collectCopySources` over the real bundle turned into an invented manifest marking every file `copied` (524 entries), the matching `stored_objects` rows inserted as the Worker would have written them, the target state read with this tool's own queries, the plan built (`--scrub-unmapped`), executed, and `verify-catalogue` run against it. Everything outside the repository (`~/chopshop-export/rehearsal-catalogue/`). The same CLI run gives a byte-identical `plan.sql`.

**The plan:** 4 888 statements (each row + its row hash, and the run bracket), 1 670 283 bytes, the longest statement **3 780 bytes**. Build time ~0.3 s.

**Rows per table and shop:**

| Shop | products | variants | tags | images | publications | screening | collections | members | pages | identity (image ids) |
|---|---|---|---|---|---|---|---|---|---|---|
| gif-sundsvall | 123 | 381 | 0 | 254 | 113 | 113 | 6 | 71 | 0 | 1 (7) |
| melodie-mc | 12 | 353 | 1 | 167 | 12 | 12 | 7 | 0 | 0 | 1 (4) |
| ninetone | 58 | 237 | 18 | 264 | 58 | 58 | 6 | 15 | 1 | 1 (3) |
| sillmans | 24 | 0 | 7 | 24 | 22 | 22 | 0 | 0 | 0 | 1 (3) |
| **total** | **217** | **971** | **26** | **709** | **205** | **205** | **19** | **86** | **1** | **4 (17)** |

Images: 709 rows (437 a product's own, 272 on a colour's first variant) over 495 distinct product objects; 12 of 12 covers; 17 branding ids; 524 objects named in all. Collections: 19 of 19, all 86 members resolve.

**The public projection:**

| Shop | source (active and b2c) | Cloudflare once live | difference | now on staging |
|---|---|---|---|---|
| gif-sundsvall | 113 | 113 | 0 | 0 (shop not published) |
| melodie-mc | 12 | 6 | 6 POD without mapping (D83) | 6 |
| ninetone | 58 | 58 | 0 | 0 (shop not published) |
| sillmans | 22 | 22 | 0 | 0 (shop not published) |
| **total** | **205** | **199** | **6** | **6** |

Three of the four shops are unpublished on staging (CP3 carried `published`), so the projection NOW is melodie-mc's only; with the shops published (as `staging-legal.mjs --publish-for-review` does, simulated by an UPDATE), verify's 41 checks all pass again with 199 public now.

**verify-catalogue:** 41 checks, 0 FAIL (before and after the simulated publish). Re-applying the same `plan.sql` refuses on its first line.

**Left out, by reason (counts):**

| Shop | What |
|---|---|
| gif-sundsvall | 10 inactive → draft; 12 products without an image in the source; 131 variant skus longer than the admin's 64 (kept); 1 compare-at price 0 → none |
| melodie-mc | 12 compare-at price 0 → none; 3 images over the 30-row cap (1 product) |
| ninetone | 4 further-information texts refused by `checkHtml` (`document_element`: a pasted `<meta>` tag) — the products imported without them; 19 images over the cap (1 product: 31 own images + its colours); 8 variant skus over 64 (kept); **1 page refused, `content_refused:unsafe_address`** (two links to `about:blank`); the menu already in CP3's identity (not rewritten) |
| sillmans | 20 products without `delivery` → shipping and pickup on; 2 inactive → draft |

- **Images left out by status:** 0 refused / 0 missing / 0 failed / 0 wrong_kind — the rehearsal's manifest marks every file copied, as item 12 asks; the real numbers come from S1's copy. The real bundle has no file under two uses (so `wrong_kind` cannot occur on it).
- **Pages:** 1 imported, 1 refused (`content_refused:unsafe_address`). No page holds an image; 0 attachments.
- **E-mail addresses inside texts:** 7 scrubbed (with `--scrub-unmapped`), 0 mapped — one shop's contact address inside product texts and a page.
- **Deferred rows:** 43 podArtwork (20), 44 podMappings (18), 33 infringementReports (0), each printed with its count.

**The translations (`src/locales/`), written and left out per language:**

| Language | read | written | empty | guard family 1 | guard family 2 | same key named in another language | build marker | e-mail | company | storage |
|---|---|---|---|---|---|---|---|---|---|---|
| sv-SE | 1 365 | 1 276 | 0 | 77 | 0 | 3 | 0 | 4 | 5 | 0 |
| en-GB | 1 365 | 1 276 | 0 | 77 | 3 | 0 | 0 | 4 | 5 | 0 |
| en-US | 1 364 | 1 275 | 0 | 77 | 0 | 3 | 0 | 4 | 5 | 0 |

Built twice: byte-identical. The storefront build carries `sv-SE` in the bundle and `en-GB`/`en-US` as lazy chunks; `check-storefront-build.mjs` finds no marker in them.

---

## 5. The locale scrub

A text is left out (the page shows its built-in text) when it or its key: is empty; matches a NAME family of `guard/guards.test.mjs` (read from the guard's own source at run time — the families it also applies to paths; counted as `guard_family_<n>`, never by name); matches a marker of `cloudflare/web/check-storefront-build.mjs` (`FIREBASE_MARKERS`, also read from that file); names the source's storage (the Worker's `isSourceStorageAddress`); holds an e-mail address; names a company by a Swedish legal form or an organisation number; holds a control character; or has a key a guard family refuses in ANOTHER language (the same key means the same thing everywhere: the Swedish texts of the three strings whose English text names the retired feature go with it, without this file spelling the Swedish word). The e-mail and company rules catch the earlier business's own address and name in footer strings that the guard's patterns do not know (5 + 4 per language); a shop's own company comes from its store identity. If the guard or the build check change shape, the tool refuses instead of scrubbing less (tested).

---

## 6. What was NOT done

- Nothing ran against staging, the source or the network; the plan was applied only to a local sqlite.
- The re-screen after the apply (`POST /v1/platform/screening-terms/rescreen`) is named in `apply.md` and not rehearsed (it needs the Worker).
- Row 43 (artworks), row 44 (mappings, D83), row 33 (no report in the export): deferred with their counts. No forwards (D88: the four shops keep their addresses).
- No repair of a text the Worker refuses: the refused page and the four refused further-information texts are counted, not rewritten.
- No production path (Deviation 4).

---

## 7. Deviations from the brief

1. **A file outside the S2 list: `lib/worker-rules.mjs`.** The brief wants the Worker's pure rules imported "where Node can". Node 22.14 cannot import these modules directly: they are TypeScript that import each other without file extensions, so type stripping alone (S1's `loadWorkerModule`) refuses them. The loader bundles the named exports with esbuild (already installed under `cloudflare/node_modules` by the Worker's toolchain) into one in-memory module and imports it from a `data:` URL. So the importer runs the Worker's own `productHandle`, `slugify`, `checkHtml`, `parseCreateProductInput`, `parseCreateVariantInput`, `parseProductImagesInput`, `parseCollectionInput`, `isCollectionHandle`, `parsePageInput`, `sanitizeStoreIdentity`, `parseStoreSettingsInput`, `storeIdentityImageRefs`, `isSourceStorageAddress`, `normalizeShippingRates`, `publicObjectUrl`, the eligibility predicate: one copy of every rule. `test/worker-rules.test.mjs` pins every export, A's slug and handle vectors, and that the bundle is deterministic.
2. **`state-from-queries.mjs` is not changed.** The brief allowed adding a query there; adding one to CP3's `target` set would make CP3's own run book require it. The catalogue's queries live in the two new tools (`--print-queries`, `--state-from`), which reuse `extractJsonArray` / `resultsOf` from it.
3. **Screening: `advisory` with the term version EMPTY, not literally "the state the Worker gives a new product".** A new product of the Worker has no row; on its first publish D8 makes it `pending` while the shop has fewer than 2 live products — and an imported shop has none, and a `pending` product is not live, so EVERY imported product would stay pending until a person approved each one, and the sweep would not change that (`decideScreening` is a no-op on an unchanged empty hit set). That contradicts the brief's own expected 199. What the importer writes is what D72 and CP3-D wiring 5 prescribe — one row per published product, term version NULL, no stored text — with the status a new product of an ESTABLISHED shop gets when nothing is found (`advisory`, `requires_approval` 0): public, and the sweep screens it (a hit → `flagged`, a hard-blocked term → `blocked`). Never `approved`; `decided_by 'import'`. **Consequence: between the apply and the sweep the products are public without their texts screened** — run the sweep at once (apply.md step 3). The reviewer should confirm or change this.
4. **Staging only.** 0033 lets production complete ONE import run (`import_runs_production_once_idx`), and CP3's run is that run, so a second plan can never land on production. The tool refuses production; how the cutover imports the catalogue (one combined run, or a migration that allows the second) is an open question.
5. **E-mail addresses inside texts are scrubbed on staging** (`--email-map` / `--scrub-unmapped`, CP3's rule D20). Needed to pass CP3's "no source address" check honestly: a shop's contact address stands in a product description and a page. To keep a shop's own public address, map it to itself in the e-mail map (the check exempts that).
6. **The branding UPDATE** reads the identity from the target state (not only the bundle), removes strings that still name the source's storage, and is guarded on `updated_at`, `updated_by` and the byte length rather than on the old text (the old text is not repeated in the plan). Object ids are checked against the target state before the plan is written.
7. **`delivery` absent → shipping AND pickup on**, as every reader of the source decides (`delivery?.pickup !== false`: Cart, PublicProductPage, ProductForm, createPaymentIntent). The Worker's own default for a NEW product is pickup off. 20 products of one shop. `compareAtPrice 0` → NULL (the source shows none).
8. **Variant skus longer than 64 characters are imported** (139): the column has no cap (0005), the source sells them, and the brief says the caps are the database's. The admin's parser refuses such a sku, so such a variant's sku cannot be edited in the admin as it is; its other fields can.
9. **The locale scrub is wider than the guard** (§5): build markers, storage, e-mail addresses, company names, and the cross-language rule. `build-locales.mjs` has an `--out` option (the tests write elsewhere).
10. **The 30-image cap** keeps by priority (§3) and not simply the first 30.
11. **Pages:** a plain-string text becomes `sv-SE` (C's instruction); a published page is dated by its `createdAt`.
12. **`git add -N src/locales/*.json`** was run so the guard scans them (allowed by the brief). The three files stand as intent-to-add in the index; nothing else was touched in git.

---

## 8. Open questions

1. Screening (Deviation 3): accept `advisory` + empty term version, or import unpublished and let the reviewer publish through the Worker (which would put every product of an imported shop into D8's queue)?
2. Production (Deviation 4): one combined import run at the cutover, or a migration change?
3. The refused page (two `about:blank` links) and the four further-information texts with a `<meta>` tag: leave them to the seller (today), or should the importer drop exactly those constructs?
4. The 139 variant skus over 64 characters: widen the admin parser, or shorten them (and the addresses and money keyed on them)?
5. `delivery` absent → pickup on (source) vs the Worker's default off for new products: keep the source's meaning?
6. On staging the scrubbed addresses show as placeholders in 7 texts; map the shop's contact address to itself for the review?
7. S1's manifest holds one `use` per file; a file used as both a product image and a branding image would be one `product_media` object that the identity cannot name (`wrong_kind`, counted). None in the export.
8. The plan is 1.67 MB (1 670 283 bytes) with 4 888 statements; CP3's was 285 KB. `wrangler d1 execute --remote --file` has not been tried with this size here.
9. `lib/worker-rules.mjs` needs `cloudflare/node_modules` (esbuild) installed; acceptable for a migration tool?

---

## 9. Run book for the reviewer (staging)

In order, from S1's copy onward. `B` = the bundle, `C` = S1's copy output dir, `W` = a work dir outside the repository.

```
# 0. S1: the files (storage-copy.mjs, see CP4_S1_REPORT.md) → $C/copy-manifest.json

# 1. Time Travel bookmark
scripts/cf-preflight.sh staging -- d1 time-travel info chopshop-stg

# 2. The target state (read-only), AFTER the copy, BEFORE the apply
node scripts/cf-port/migrate/import-catalogue.mjs --print-queries --env staging
#    run each printed command, each into $W/catalogue-target-queries/<name>.json
node scripts/cf-port/migrate/import-catalogue.mjs --state-from $W/catalogue-target-queries --state-out $W/catalogue-target-state.json

# 3. The plan
node scripts/cf-port/migrate/import-catalogue.mjs --env staging --bundle $B \
  --copy-manifest $C/copy-manifest.json --target-state $W/catalogue-target-state.json \
  --out $W/catalogue-plan --email-map <CP3's map> --scrub-unmapped
#    read the per-shop counts it prints (images left out by status, pages refused)

# 4. Apply (the plan's apply.md repeats this with the run id)
scripts/cf-preflight.sh staging -- d1 execute chopshop-stg --remote --file=$W/catalogue-plan/plan.sql

# 5. Screen the imported products (platform session), until "pending": 0
POST /v1/platform/screening-terms/rescreen

# 6. Verify
node scripts/cf-port/migrate/verify-catalogue.mjs --print-queries --env staging
#    run each printed command into $W/catalogue-actual-queries/<name>.json
node scripts/cf-port/migrate/verify-catalogue.mjs --state-from $W/catalogue-actual-queries --state-out $W/catalogue-actual-state.json
node scripts/cf-port/migrate/verify-catalogue.mjs --env staging --bundle $B --plan $W/catalogue-plan --actual-state $W/catalogue-actual-state.json

# 7. staging-legal.mjs (S1): terms text, legal pages, --publish-for-review; then step 6 again:
#    the projection NOW becomes 199 over the four shops

# 8. The locale files are in the tree; regenerating gives the same bytes:
node scripts/cf-port/build-locales.mjs --bundle $B
```

If step 4 stops halfway: confirm the run is `running`, apply the same file without its first statement (tested locally: the same run completes and verify passes). If an admin changed a store identity between steps 2 and 4, its UPDATE changes nothing and step 6 fails the branding check for that shop: build the plan again from a new target state.

---

## 10. Gate (run after the last change)

```
node --test "scripts/cf-port/migrate/test/*.test.mjs"                  tests 429, pass 429, fail 0 (353 + S1's 49 + mine 27)
node --test src/api/*.test.mjs src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
                                                                       tests 120, pass 120, fail 0
node cloudflare/web/check-storefront-build.mjs                         storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                                         exit 0 (built in 12.62s)
node guard/guards.test.mjs                                             2077 tracked files scanned, 299 match a pattern; allowlist 298, baseline 298; PASS
```
