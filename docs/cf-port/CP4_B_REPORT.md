# CP4-B report — collections

Builder: CP4-B. Branch `cf-port`, working tree only (no git writes, no network, no wrangler, no installs). Brief: `CP4_BRIEFS.md` §0, the address grammar, §B (and §A, §D for what B calls and what reads B); DECISIONS D87, D92, D93; `CP4_GAP_ANALYSIS.md` §1b, §3.1; `MIGRATION_MANIFEST.md` row 20. Started on HEAD `e872853d`; while I worked the reviewer committed A (`fd32bf8e`), the handover (`8d7ccc00`) and eleven review fixes (`661f6438`). None of their files was touched here.

`$CF` = `cloudflare/`.

---

## 1. Files

| File | |
|---|---|
| `$CF/migrations/0041_collections.sql` | new: `collections`, `collection_products`, their triggers |
| `$CF/src/catalog/collections.ts` | new: parsing, the namespace rule, admin reads and writes, the public reads |
| `$CF/src/routes/admin-collections.ts` | new: `/v1/admin/collections`, `…/:collectionId`, `…/:collectionId/products` |
| `$CF/src/routes/public-collections.ts` | new: `/v1/collections`, `/v1/collections/:ref`; CORS, the preflight, the rate limit |
| `$CF/test/collections.test.ts` | new: 99 tests (schema, admin routes) |
| `$CF/test/public-collections.test.ts` | new: 38 tests (public reads, predicate, paging, ETag, CORS, rate limit) |
| `$CF/src/app.ts` | only inside `CP4-IMPORTS-B` and `CP4-ROUTES-B` (5 mounts) |

Read only, imported: `src/catalog/public-catalog.ts` (`listPublicProductsByIds`, `listPublicProductPage`, `MAX_PUBLIC_PRODUCTS_BY_IDS`, `PublicProductSummary`), `src/catalog/admin-catalog.ts` (`addressSlug`, `productTagKey`), `src/catalog/admin-product-reads.ts` (`encodeDisplayCursor`, `decodeDisplayCursor`, `displayOrderBy`, `displayOrderAfter` — used with MY columns), `src/storage/public-objects.ts`, `src/content/pages.ts` (`publicTenantStatement`, the one public shop gate), `src/storefront/redirects.ts` (`collectionPath`), `src/storefront/public-routes.ts` (`versionedJsonResponse`), `src/routes/storefront-withdrawals.ts` (`withdrawalRateKey`), `src/lib/rate-limit.ts`, `src/legal/legal-pages.ts` (`readJsonBodyWithin`). Test fixtures used read-only: `test/storefront-fixtures.ts` (`seedProduct`, `publicObject`, `removeObject`, `attachImage`).

**This module writes no product query.** A manual collection's products come from `listPublicProductsByIds`, a smart one's from `listPublicProductPage({ tag: productTagKey(rule_tag), cursor, limit })`. The only SQL of mine that names `products` is the tenant-match trigger of `collection_products` (and a test fixture).

---

## 2. Schema (0041)

### `collections` — the brief's names, unchanged

| Column | Rule |
|---|---|
| `collection_id` | PK, 1–128 of `[A-Za-z0-9_-]` (new: UUID; imported: its Firestore id); immutable (trigger) |
| `tenant_id` | FK `tenants`; immutable (trigger) |
| `handle` | 1–200, only `[a-z0-9_-]`, no `--`, at least one letter or digit = **exactly the fixed points of the source's slugify** (`isCollectionHandle`; a test pins code and CHECK to the same rule); `UNIQUE (tenant_id, handle)` |
| `external_ref` | NULL or 1–128 URL-unreserved characters `[A-Za-z0-9._~-]` with at least one letter or digit (one path segment, never a dot segment, never needs an escape); unique index `(tenant_id, external_ref) WHERE external_ref IS NOT NULL` |
| `title` | 1–200 |
| `description` | NULL or 1–5 000 |
| `image_object_id` | FK `stored_objects`; triggers: this shop's **active public `product_media`** on insert, and on an update only when the named object CHANGES (a write of other fields after the cover was removed is admitted, D93) |
| `type` | `'manual' \| 'smart'` |
| `rule_tag` | NULL or 1–50 (A's tag rule) |
| `published`, `featured` | 0/1, default 0 |
| `sort_order` | NULL or ±1 000 000 000 |
| `created_at`, `updated_at` | ISO-8601 with the strftime round-trip CHECK; `updated_at >= created_at` |
| `created_by`, `updated_by` | **added**: NULL or 1–128 (C's pattern; NULL for an imported row) |
| row CHECK | `(type = 'manual' AND rule_tag IS NULL) OR (type = 'smart' AND rule_tag IS NOT NULL)` |

Index `(tenant_id, published)`.

### `collection_products` — the brief's names, unchanged

`tenant_id, collection_id → collections, product_id → products, position`; `PRIMARY KEY (collection_id, product_id)`; **added** `UNIQUE (collection_id, position)` and `CHECK (position BETWEEN 0 AND 499)` (so the table itself holds at most 500 members); index `(product_id)` (the FK child index). Triggers: tenant immutable; tenant matches the collection (insert, update); **tenant matches the product** (insert, update; a product that does not exist fails here too); members only in a **manual** collection (insert, update of `collection_id`) and, on `collections`, a collection with member rows cannot be turned smart (`collections_smart_has_no_products`).

### The namespace of `:ref` — both fences, all three names

Per shop, a handle, an external reference and an id each name at most one collection, and none equals another collection's handle, external reference or id. Unique constraint (handle = handle), unique index (external_ref = external_ref), and five triggers for the crossings: `collections_handle_namespace_insert/update` (handle vs others' external_ref / id), `collections_external_ref_namespace_insert/update` (external_ref vs others' handle / id), `collections_id_namespace_insert` (a new id vs others' handle / external_ref; the id is immutable). A collection's OWN names may coincide. The code checks the same before the write (`refConflict`, a clear 409) — **proven both ways**: with the code check disabled (mutation, reverted) every 409 test still passes through the triggers alone (`writeRefusal` maps each constraint to its code).

Comparison is exact (binary), as `:ref` resolution is: `ext-409` and `EXT-409` are two names (tested).

### `catalog_version`

`AFTER INSERT/UPDATE/DELETE` bump triggers on **both** tables (six). No trigger on `stored_objects` (0043 already bumps for every public object; tested: a removed cover moves the ETag).

### D's fixture DDL (`test/storefront-fixtures.ts`)

It declares `collections (collection_id TEXT PK NOT NULL, tenant_id, handle NOT NULL, external_ref, title NOT NULL, description, image_object_id, type NOT NULL, rule_tag, published INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0, sort_order, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (tenant_id, handle))` and `collection_products (tenant_id, collection_id, product_id, position INTEGER NOT NULL, PK (collection_id, product_id))`. **Mine matches every name and type**; I add only nullable columns (`created_by`, `updated_by`), constraints and triggers. With 0041 applied its `CREATE TABLE IF NOT EXISTS` is a no-op, and D's five suites (`public-storefront`, `identity-projection`, `seo`, `sitemap`, `redirects`) pass: 199/199 (with my two: 340/340). D's seeds (ids `coll-<tenant>-<n>`, lower-case handles, a `product_media` cover, a smart rule `NYHET`, same-shop members) all satisfy my CHECKs and triggers.

---

## 3. Routes

Registered in `CP4-ROUTES-B`: exact paths, `onMethods`, the public ones in `storefront(...)`. Segments from the raw pathname, decoded once (`decodeSegment`). HEAD and unclaimed methods fall through to the 404 (tested).

### Admin (`X-Shop-Id` + live session; acting-as admitted and audited with the grant)

Order: method → session (`authorizeTenantAdminRequest`) → same-origin for every state change, **before the body is read** → id (`[A-Za-z0-9_-]{1,128}`) → body (`readJsonBodyWithin`).

| Method + path | Request | Answer |
|---|---|---|
| `GET /v1/admin/collections` | `cursor?`, `limit?` 1–100 (50); other or repeated parameters → 400 | `200 { collections: AdminCollectionSummary[], nextCursor }`, display order: `sort_order` (NULL last), title `COLLATE NOCASE`, id — keyset (A's display cursor over my columns) |
| `POST /v1/admin/collections` | `{ title, handle?, externalRef?, description?, imageObjectId?, type?, ruleTag?, published?, featured?, sortOrder? }` | `201 { collection }` |
| `GET /v1/admin/collections/:collectionId` | — | `200 { collection }` |
| `PATCH /v1/admin/collections/:collectionId` | any non-empty subset of the POST fields | `200 { collection }` |
| `DELETE /v1/admin/collections/:collectionId` | — | `204` (members deleted in the same batch) |
| `PUT /v1/admin/collections/:collectionId/products` | a JSON **array** of product ids, 0–500, each once | `200 { collection }` |

```
AdminCollectionSummary = { collectionId, handle, externalRef, title, type: "manual"|"smart",
  ruleTag, published, featured, sortOrder, path: "/samling/<handle>", imageObjectId,
  image: PublicImage | null, productCount, createdAt, updatedAt }
collection = AdminCollectionSummary + { description, productIds: string[] (in order), createdBy, updatedBy }
```

Field rules: texts NFC + trimmed, no control character (the description may break lines), no lone surrogate. `handle` absent → `addressSlug(title)` (the source's `handle || slugify(title)`); a handle that is not a fixed point of slugify is **refused, not repaired**. `externalRef`/`description`: `null` or `""` clears. `ruleTag`: 1–50 with a non-empty address (`productTagKey`). `type` default `manual`; smart needs a tag, manual refuses one; a PATCH to `manual` clears the stored tag; a PATCH that leaves the collection smart deletes its member rows in the same batch (the source wrote `productIds: []`). The cover is checked through `getReferencablePublicImage(…, ["product_media"])` and written only when it changes. `published` default false. Members: any product of this shop, any status (the admin keeps drafts; the public read filters). Every write: one batch with its audit row (`collections.create|update|delete|products`, resource `collection`; metadata `{handle, published, type}`, `{fields, handle}`, `{count}`).

| Status | Body | When |
|---|---|---|
| 400 | `{ error: { code: "invalid_request", message: "Request is not valid" } }` | shape, grammar, lengths; smart without tag / manual with tag; tag without address; malformed JSON; product list not an array, over 500, a repeat, a non-string, an empty or over-128 id |
| 400 | `{ error: { code: "image_not_referencable", message } }` | cover not an active public product image of this shop (foreign, branding, pending, removed, unknown) |
| 400 | `{ error: { code: "product_not_found", message } }` | a listed product is not one of this shop's; nothing written, no audit, no bump |
| 409 | `{ error: { code: "handle_taken" } }` / `{ code: "external_ref_taken" }` | the name equals another collection's handle, external ref or id in this shop |
| 409 | `{ error: { code: "collection_not_manual" } }` | a product list for a smart collection |
| 409 | `{ error: { code: "conflict" } }` | a concurrent write the checks could not see (id namespace, a smart flip racing a member write) |
| 413 | `{ error: { code: "payload_too_large" } }` | body over 64 KiB (256 KiB for the product list) |
| 404 | the opaque `Route not found` | no session, no membership or grant, cross-origin or origin-less write, malformed or unknown id, another shop's collection |

### Public (tenant by hostname; D87)

| Method + path | Request | Answer |
|---|---|---|
| `GET /v1/collections` | `cursor?`, `limit?` 1–100 (**100**) | `200 { collections: PublicCollection[], nextCursor }`, published only, display order, keyset |
| `GET /v1/collections/:ref` | `cursor?`, `limit?` 1–100 (**24**) | `200 { collection: PublicCollection, products: PublicProductSummary[], nextCursor }` |
| `OPTIONS` on both | — | `204`, no body: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET`, `Access-Control-Allow-Headers: If-None-Match`, `Access-Control-Max-Age: 86400`, `Cache-Control: no-store` |

```
PublicCollection = { handle, externalRef, title, description, image: PublicImage | null,
                     path: "/samling/<handle>", featured, sortOrder }
```

`products` are A's `PublicProductSummary` **as A builds them** (tested: every summary `toEqual` A's own from `GET /v1/products`): title, one image with alt/width/height, `lowestPriceMinor`, `path`, … — what D87 names. Manual: the admin's order. Smart: the display order (`sort_order`, name, id), the tag matched by its **address** (`productTagKey`), as `product_tags.tag_key`, the `/tagg/<key>` page and D's search-engine read do.

Statuses: `200` (ETag `"<catalog_version>"`, `Cache-Control: no-cache`); `304` bodiless on `If-None-Match`; `400 invalid_request` (unknown or repeated parameter, bad limit, a cursor of neither kind, a cursor of the other kind of collection); `404 { error: { code: "not_found", message: "Collection not found" } }` (unknown host, suspended or unpublished shop, unknown ref, unpublished collection, a ref over 200 characters, a malformed segment); `429 { error: { code: "rate_limited", message: "Too many requests" } }` with `Retry-After`.

**Cursors.** List: A's display cursor (base64url of `[sortOrder, title, id]`, canonical form only). Detail: a manual collection pages by member **position** (a decimal `0`–`499`); a smart one by A's product display cursor. The two forms cannot be confused (a display cursor always starts with `W`, the base64 of `[`).

**Manual paging** (`manualProductPage`): the member ids after the cursor's position (at most 500, one query), handed to `listPublicProductsByIds` in chunks until `limit + 1` public products are found or the members run out; the first chunk is exactly `limit + 1` ids (every member public → one call), later chunks A's maximum of 100. `nextCursor` = the position of the last product answered, and only when a further public product was actually found. Tested: 150 hidden members ahead of the public ones (beyond one call of A); exactly `limit` public members → `null`; 30 members walked 4 at a time while one ahead of the cursor is unpublished: every public member once, in order.

**The snapshot.** The collection row and the shop's version are read in one batch (`publicTenantStatement` + the ref query); members, products and the cover follow, and every change to them bumps the version (0040, 0041, 0043) — at worst a body newer than its label, never a stale 304 (A's reasoning, same code shape).

---

## 4. How `:ref` is resolved

`decodeSegment` once (a `/` after decoding, `%ZZ`, an empty segment → 404); length 1–200; then ONE query under the shop gate:

```sql
WHERE collection.tenant_id = ? AND collection.published = 1
  AND (collection.handle = ? OR collection.external_ref = ? OR collection.collection_id = ?)
ORDER BY CASE WHEN handle = ? THEN 0 WHEN external_ref = ? THEN 1 ELSE 2 END LIMIT 1
```

Handle, then external reference, then id, as the brief orders them; the namespace (§2) guarantees at most one row can match, so the order only makes the choice deterministic. Tested: the same body by handle, external ref and id; another shop's collection with the SAME handle and external ref is never answered on this host; another shop's id → 404; a draft by any ref → 404.

---

## 5. Cross-origin and the rate limit

**CORS.** Every answer my two handlers produce — 200, 304, 400, 404, 429 and the preflight's 204 — carries `Access-Control-Allow-Origin: *` and no other CORS header: no `Access-Control-Allow-Credentials`, no reflected Origin, no `Vary`. The preflight is the first thing each handler does: no rate limit, no tenant, no query — tested through the mounted app with an env whose `DB` throws on any access (204 for OPTIONS; the GET with the same env rejects). Admin routes and the other public routes (`/v1/products`, `/v1/storefront`, `/v1/pages`) carry no CORS header, and `OPTIONS /v1/products` is a plain 404 (tested). Bodies hold public fields only (tested: no `collectionId`, `type`, `ruleTag`, `published`, `createdBy`, `productIds`).

**Rate limit** (`src/lib/rate-limit.ts`, scope `collections-ip`): **120 requests per minute per caller, the two routes together**. It runs first after the method, **before the query is parsed and the tenant looked up**, so every attempt counts (400s and 404s included, tested) and the refusal is byte-identical whatever the ref, the query, the shop or an unknown host (tested: one distinct `Retry-After|body` over five variants). Key: `withdrawalRateKey(clientIp(request))` — `CF-Connecting-IP` only (X-Forwarded-For ignored, tested), IPv6 by its /64 (rotation inside a /64 buys nothing, a neighbouring /64 is unaffected, tested), no header → the one shared `unknown` bucket (tested). The address is hashed with the scope and never stored (tested). A preflight is answered and not counted while the caller is over the limit (tested). Enforced on the mounted routes (tested with a pre-seeded window).

---

## 6. What was NOT done

- No admin page, no storefront page, no client change (F, E), no importer (S).
- No order route for collections (`sortOrder` is written per collection by PATCH; the source's drag-sort wrote every collection at once). Open question 3.
- No `hasProducts`/count on the public list (open question 1).
- No screening of collection texts: the source system screens products only (its rules and functions have no screening of `collections`); nothing added.
- No D switch: D's reads of my tables are valid against 0041 as they are (§2); the switch to my functions is the reviewer's consolidation (Reviewer wiring 4).

---

## 7. Deviations from the brief

1. **The namespace includes the id.** The brief makes handle and `external_ref` one namespace; an id that equals another collection's handle (a UUID pasted into the handle field) would still make `:ref` name two collections. So the id is in the namespace too, in code and by trigger.
2. **`PublicCollection` gains `sortOrder`**, and the list gains `cursor`/`limit` and answers `nextCursor` (rule 8, bounded lists). The home sorts featured collections by `sortOrder`, then title with `localeCompare('sv')`; the server's order is the same except that ties compare `NOCASE`, so the page needs `sortOrder` to keep its order byte for byte. Additive to E's client.
3. **Smart collections match the tag by address**, as the brief says; the source's `collectionResolver.js` matched the exact text (`p.tags.includes(tag)`). So a rule `Nyhet` now also holds products tagged `nyhet` or `NYHET` (tested) — the same widening A's `/tagg` filter and D's search-engine read already have.
4. **The handle is refused, never repaired**, when it is not what slugify leaves; when absent it is derived from the title (the source's form behaviour). A derived handle over 200 characters or with no letter or digit → 400 (name one).
5. **`external_ref` is URL-unreserved characters only.** A shop's numeric id (`412345678`) fits; a Shopify GID (`gid://shopify/Collection/1`) does not (a `/` cannot be one path segment). D87 says the value is entered by hand.
6. **Added columns and constraints**: `created_by`, `updated_by`; `UNIQUE (collection_id, position)` and the 0–499 position CHECK (the 500 cap in the table); members only in manual collections, both directions; the cover must be active at write (A's `product_images` rule; C's pages only check tenant/bucket/kind).
7. **`PUT …/products` takes a bare array** of ids (A's convention for its PUT routes), not `{ productIds }`.
8. **Turning a collection smart deletes its members** in the same batch (the source's behaviour); a stale product list is never kept.
9. **The public 404 says `Collection not found`** (as C's `Page not found`), not the admin's opaque `Route not found`.
10. **The preflight admits `If-None-Match`** so a cross-origin script can revalidate by ETag itself; nothing else.
11. Defaults the brief does not give: list limit 100 (max 100), admin list 50.

---

## 8. Open questions

1. **The home's "only a featured collection with a live product" rule** (`PublicStorefront.jsx`: a card is shown only if the collection resolves to ≥ 1 live product). The list carries no count. F can call `GET /v1/collections/:handle?limit=1` per featured collection (k + 1 requests, each counted by the limit), or the reviewer decides a `hasProducts` flag on the list — which costs up to six calls of A per listed collection. I chose not to build the fan-out.
2. **The limit's value.** 120 per minute per caller is my estimate for a visitor browsing through the web Worker (each forwards the visitor's address) and for a shop's own server that caches for an hour (D87). Many visitors behind one carrier NAT share a bucket. Every public collection read now costs one D1 write (the counter).
3. **An order route** `PUT /v1/admin/collections/order` (as A's products) for the admin's drag-sort, or PATCH per collection (today)?
4. **For S (the importer)**: `handle` must be a fixed point of slugify (every source handle is, since the admin slugified each keystroke — the rehearsal should count exceptions); `title` 1–200 and `description` ≤ 5 000 characters (count on the bundle); `imageUrl` → the copied object's id (kind `product_media`, active); `productIds[]` in order, dangling ones dropped and reported (manifest row 20), at most 500; `rule.tag` → `rule_tag` only for `type = 'smart'` (1–50, must have an address), `null` for manual; `published`/`featured` booleans; `sortOrder` integer or NULL; `createdAt`/`updatedAt` → ISO; `created_by`/`updated_by` NULL; `external_ref` NULL (the export has none, D87). A collection id that equals another collection's handle in the shop is refused by trigger.

---

## 9. Reviewer wiring

1. **`REQUIRED_MIGRATION`** — the last CP4 migration (`0044_withdrawals.sql` per the handover); 0041 sits between 0040 and 0042 and nothing is deployed past 0038.
2. **`withdrawalRateKey`** is imported from G's ROUTE file (`src/routes/storefront-withdrawals.ts`); it is a general visitor key and belongs in `src/lib/rate-limit.ts` (e.g. `visitorRateKey`), used by both.
3. **`publicTenantStatement`** (`src/content/pages.ts`) is the one public shop gate of C and B; a neutral home (e.g. `src/storefront/`) would suit it.
4. **D's consolidation**: `seo.ts` `collectionPage` + `listCollectionMemberLinks` + its smart rule → `readPublicCollection(env, db, tenant, handle, { cursor: null, limit })` (the same members, through A; D keeps resolving by handle only, which is right for `/samling/<handle>`). `readMenuResolutions` and `sitemap.ts`'s collections section are correct against 0041 as written. D's fixture DDL of my tables can be dropped.
5. **Web Worker allowlist** (`$CF/web/src/api-allowlist.ts`): `GET /v1/collections` and `GET /v1/collections/:id` already pass. `OPTIONS` does not: a cross-origin *script* sending `If-None-Match` through a shop's domain would be refused at the web Worker (a simple GET needs no preflight; D87's site calls server to server). Add `OPTIONS` to the two rows only if that case is wanted. Through `Internal.fetchForShop` (shared host) the shop's hostname is looked up before routing — outside my handler.
6. **E's client** `src/api/collections.js`: `listCollections` reads `collections` (it drops `nextCursor`, fine up to the default 100); `getCollection` reads `collection`, `products`, `nextCursor` — all answered; its comment lists the collection keys without `sortOrder` (additive).
7. **`collectionPath`** is D's (`src/storefront/redirects.ts`), imported so `/samling/<handle>` has one rule.

---

## 10. Tests

- `npx tsc --noEmit`: exit 0.
- `test/collections.test.ts` **99**, `test/public-collections.test.ts` **38** (137 new) — green. With D's five suites: 7 files, **340** green.
- **Proven** (refusals first): anonymous, another shop's admin, a platform user without a grant → the opaque 404 on every route and method, nothing written or audited; cross-origin and origin-less writes refused before the body (a malformed body included); unclaimed methods and HEAD fall through; malformed and unknown ids; 33 invalid bodies; 413; five kinds of unreferencable cover; the six 409 cases on create and the rename cases, and the same names admitted in another shop; product lists (object, repeats, non-strings, 501); another shop's or an unknown product → 400 with nothing written and no bump; a smart collection's list → 409. Schema: 28 refused rows, the code/CHECK handle rule, uniqueness per shop, the namespace in both directions (insert and update), immutability, the cover rule and D93, members (foreign, unknown, wrong tenant, smart, duplicate position, 500), every insert/update/delete of both tables bumps. Happy paths: create with every field (exact shape, audit, bump), derived handle, partial PATCH with clears, a removed cover kept on an unchanged write, manual ↔ smart, the product list (order, replace, clear, drafts and archived kept, audit count), 500 products in one list, delete with members. Admin list order, shape and cursor walk. Public: the one 404 (unknown ref, draft, foreign id, malformed segment, unknown host, unpublished and suspended shop — and back); 400s; the list (order, exact shape, public fields only, cursor walk, empty shop); one collection by handle / external ref / id with ONLY public products in the admin's order and A's exact summaries; smart by tag address in the display order, paged with A's cursor; archive, takedown and unpublish of members never break the read and move the ETag; a removed cover → `image: null` and a new ETag; manual paging (§3); defaults 24 / max 100; 304 and the ETag moving on every kind of change; CORS on every answer, never with credentials, the preflight without the database, no CORS elsewhere; the rate limit (§5).
- **Mutations run and reverted** (each failed the suite as expected): no `published = 1` on the detail (2 fail); a raw IP key without the /64 (1); the preflight after the limit (2); the limit after the parse and the tenant (1); "more" when exactly `limit` were found (1); the tag matched by text instead of address (3). And the reverse check: with the code's namespace check disabled, all 137 still pass — the triggers alone give every 409.
- **Whole suite** (`npx vitest run`, after my last change): 88 files, 3 809 tests — **3 803 passed, 6 skipped, 0 failed tests; 1 file failed outside my files**: `test/pod-publish.test.ts`, two `beforeAll` hooks (`large products are read completely, or refused — never truncated`, `pod_too_large on a live product is refused by every caller of the gate`) throw `variant limit reached`: the reviewer's commit `661f6438` added `product_variants_limit_insert` to 0040 (at most 100 active variants), and that CP2 suite's fixture (`test/pod-fixtures.ts seedProduct`) seeds 101 active variants. The 6 skipped are that file's. Not repaired (not my file).
- `node guard/guards.test.mjs`: PASS; my new files hold none of the guarded names (grepped: they are untracked, so the guard does not scan them yet).

---

## Review round 1 (reviewer, 2026-09-28)

Read line by line: the migration, the public route file, and of `collections.ts` the public reads (the list, the read by `:ref`, the page of a manual collection). Read in outline: the parsers, the admin writes, the admin route file. Run by the reviewer after the change below: `tsc` clean; **the whole suite, 88 files, 3810 tests passed, none skipped.**

**Changed by the reviewer:**

- Wiring 2: the key a limiter counts a visitor by (`visitorRateKey`) lives in `src/lib/rate-limit.ts`; the withdrawal route and the collection routes both take it from there.

**B's finding on the reviewer's own commit** (`pod-publish.test.ts` failing on the variant trigger) was right and is corrected in `2a3aabc2`.

**Deviations accepted:** 1–11. On 3: a tag rule matches by the tag's address, so `Nyhet`, `nyhet` and `NYHET` are one tag, as they are one tag page. On 5: an id of the source system that holds a `/` does not fit; the ids the shop's own site asks by are numbers.

**Answers to the open questions:** 1: the home asks each FEATURED collection for one product (`?limit=1`), and shows the card when the answer holds one; F builds it so. No flag in the list. 2: 120 a minute per caller stands. It costs one row written per public read of a collection; it is looked at again with real traffic, and the product reads have no such limit. 3: the order of collections is written by PATCH per collection; a route for the whole order is CP5's, with the page that drags.

**Waiting for the consolidation:** wiring 1, 3 and 4 (the public gate gets a home of its own; D's reads of collections move to `readPublicCollection`; D's fixture DDL of B's tables goes). 5 is not built: the shop's own site asks server to server. 6 with the client's alignment.
