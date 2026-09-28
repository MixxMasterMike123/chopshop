# CP4-D report — the storefront response, search engines, forwarding (first pass)

Builder: CP4-D. Branch `cf-port`, working tree only (no git writes, no network, no wrangler, no deploy). Brief: `CP4_BRIEFS.md` §0, "The address grammar", §D (and §A–C for the tables D reads); DECISIONS D57, D62, D73, D76, D77, D81, D87, D88; `CP4_GAP_ANALYSIS.md` §1d–f; PLAN §2.4. Started on HEAD `419c8e98` (E and P committed). Builders A, C and G worked in the same tree at the same time; their migrations 0040, 0042 and 0044 appeared while I worked, and my suites run with them present.

**Not in this pass: the preview of an unpublished shop (D57), D's second pass.**

---

## 1. The ALLOWLIST: every key of the store identity

`GET /v1/storefront` carries `identity` = `projectStoreIdentity()` (`cloudflare/src/storefront/identity-projection.ts`): an object literal written key by key, each read by its own rule (type, trim, length, no control characters, no string naming the source system's storage, own properties only). A key that is not in this table's "public" rows never leaves: the test writes an identity full of unknown and sensitive keys and asserts none of them, nor any of 13 markers, is in the response.

"Staying pages" = the 16 files of brief F plus the components they render (`NordProductCard`, `SocialMediaShare`, `ProductSocialShare`, `utils/productUrls.js`).

| Key | Who shows it (today) | In the response | Why |
|---|---|---|---|
| `legalName` | `ShopFooter` (© line), `Checkout` (seller name) | `identity.legalName` | printed |
| `tagline` | `PublicStorefront` hero, SEO title/description (`productUrls.getShopSeoTitle`) | `identity.tagline` | printed |
| `heroHeadline`, `heroSubtitle`, `heroCtaLabel`, `heroSecondaryLabel`, `heroMark` | `PublicStorefront` hero | `identity.*` | printed |
| `introTitle`, `introBody` | `PublicStorefront` intro block | `identity.*` (`introBody` keeps line breaks) | printed |
| `featuredTitle`, `productsTitle`, `productsSubtitle`, `collectionsTitle`, `storyTitle`, `reviewsTitle`, `reviewsSubtitle` | `PublicStorefront` section headings | `identity.*` | printed (the reviews heading is printed today; whether F hides the reviews section under D81 is F's) |
| `frontpageCategory` | `PublicStorefront` (showcase mode, `__utvalda__` sentinel) | `identity.frontpageCategory` | drives what the home shows |
| `featuredLimit` | `PublicStorefront` (clamped 1–12) | `identity.featuredLimit` (integer 1–12, else absent) | drives what the home shows |
| `blocks.{gallery,story,bestseller,trust,collections}` | `PublicStorefront` block toggles | `identity.blocks` (booleans only; other keys dropped) | drives what the home shows |
| `story[].{title,text}` | `PublicStorefront` story band (first 3) | `identity.story` (≤ 3) | printed |
| `gallery[].{imageObjectId,label,linkSku}` | `PublicStorefront` gallery band (first 4) | `identity.gallery` (≤ 4) as `{ image, label, path }`: the object id resolved to a `PublicImage` (else null), the SKU resolved to the path of that product while it is public (else null) | printed; the SKU itself is not needed by a visitor |
| `gallery[].imageUrl` (old address) | — | **no** | images are object ids (D92/D95); an old address is never shown |
| `companyDescription` | `ShopFooter`, SEO description | `identity.companyDescription` | printed |
| `address` (HTML) | `ShopFooter` (DOMPurify) | `identity.address` (as stored, bounded; the page sanitises as today) | printed |
| `orgNumber`, `businessInfo` | `ShopFooter` legal line | `identity.*` | printed |
| `social.{facebook,instagram,youtube,tiktok,pinterest,linkedin,website}` | `ShopFooter`, `SocialMediaShare`, home JSON-LD `sameAs` | `identity.social` — only absolute http(s) addresses without credentials; any other key dropped | printed as links; `javascript:` and relative values would be live links |
| `trustpilot.domain` | `PublicProductPage` (widget), `ReviewsSection` | `identity.trustpilot.domain` (a hostname) | printed |
| `trustpilot.email` | no page (the review-invite sender) | **no** | an address no page prints |
| `supportEmail` | `ShopFooter` (two `mailto:` links), home JSON-LD `contactPoint.email` | **`identity.supportEmail`, from `tenants.support_email`** (the identity key itself is refused on write and ignored on read) | printed; see Deviation 1 |
| `contactEmail`, `notificationEmail` | no staying page | **no** | addresses no page prints |
| `logoObjectId`, `heroObjectId`, `faviconObjectId`, `emailLogoObjectId` (new, CP4) | `ShopNavigation`, `PublicStorefront`, `Checkout`, tab icon, e-mails | `branding.{logo,hero,favicon,emailLogo}`: `PublicImage` or null (active public `shop_branding` of this shop only) | the brief's `branding` |
| `logoUrl`, `heroImageUrl`, `faviconUrl`, `emailLogoUrl` (old addresses) | — | **no** | replaced by the object ids |
| `accent` | all pages (theme) | top-level `accent` (a CSS value, see below) | brief: "as stored" |
| `templateId` | all pages (template) | top-level `templateId` (`^[a-z0-9-]{1,64}$`, else null) | brief |
| `theme.{colors,fonts,shape,motion,layout}.*` | all pages (`nordTokens.resolveTheme`) | top-level `theme`: only the token keys of `TOKEN_CSS_VAR`/`TOKEN_ENUMS`; values strings or numbers with no `url(`, `image-set(`, `@import`, `expression(`, `; { } < > \` | brief: "as stored"; values become CSS custom properties |
| `pickupLocations[].{id,name,address,hours,dates}` | `Checkout` (one option per place and date), `PublicProductPage` | top-level `pickupLocations` (≤ 50; entries without an id dropped; dates only `YYYY-MM-DD`; other keys dropped) | brief: "as stored" |
| `menu[].{type,target,label}` | `ShopNavigation` | top-level `menu`, resolved (§4.1) | brief |
| `legal.acceptance` | — | **no** (refused on write since CP3) | brief's never-list |
| `legal.custom`, `legal.customUpdatedAt` | no staying page (C serves legal pages from the adopted snapshot) | **no** | not printed |
| `legal.noWithdrawalNotice`, `legal.withdrawalNoticeVersion` | `Checkout` (the no-withdrawal notice) | **no** | the server records the platform's FIXED disclosure text and version (`legal/consent.ts`); a shop's own text on the page would differ from the recorded proof. Checkout falls back to the same default text the server records (open question 4) |
| `returnAddress`, `vatRegistered`, `vatNumber`, `sellerType` | legal pages (from the adopted snapshot), `Checkout`'s client legal gate | **no** (columns, refused in the identity since CP3) | brief's never-list; the legal pages print the snapshot, not these fields |
| `shopName` | everywhere | top-level `name` from `tenants.shop_name` (identity key refused) | unchanged |
| `currency`, `vatRate`, `defaultLocale`, `defaultCurrency` | — | top-level `currency`, `locale` from `tenants`; identity keys refused | unchanged |
| `payments.*`, `stripeAccountId`, `commissionBps`, `features`, `platformTerms`, `published`, `status`, `shopId`, `tenantId`, `vatRateBp` | — | **no** (refused since CP3) | brief's never-list |
| `cartRecovery`, `productReviews` (inert add-on settings) | — | **no** | not ported (D81), no page |
| any other key, today or tomorrow | — | **no** | allowlist |

Also in the response, not from the identity: `features` (§4.1), `name`, `locale`, `currency`.

---

## 2. Files

| File | What |
|---|---|
| `cloudflare/migrations/0043_storefront.sql` | new: `redirects` + 3 triggers; bump triggers on `tenant_settings`, `tenant_features`, `tenants.support_email`, public `stored_objects`, `redirects` |
| `cloudflare/src/storefront/identity-projection.ts` | new: the allowlist, branding, theme, pickup places, menu; the reads they need |
| `cloudflare/src/storefront/public-storefront.ts` | the full response, `PORTED_FEATURE_KEYS`, `publicFeatures`, `isPublicShop`; `getPublicStorefront` kept unchanged for its import in `app.ts` |
| `cloudflare/src/storefront/public-routes.ts` | `handlePublicStorefrontRequest` passes `env` (one call changed, comments) |
| `cloudflare/src/storefront/redirects.ts` | new: THE path normal form, the address grammar (`slugify`, path builders, segment encoding), the forward store |
| `cloudflare/src/storefront/seo.ts` | new: the SEO answer, text helpers, reads of A/B/C tables |
| `cloudflare/src/storefront/sitemap.ts` | new: sections, keyset cursor |
| `cloudflare/src/routes/public-seo.ts` | new: `GET /v1/seo`, `GET /v1/sitemap` |
| `cloudflare/src/routes/admin-redirects.ts` | new: `GET`/`PUT`/`DELETE /v1/admin/redirects` |
| `cloudflare/src/platform/tenant-config.ts` | the branding image keys only: `STORE_IDENTITY_IMAGE_KEYS`, `GALLERY_IMAGE_KEY`, `storeIdentityImageRefs`, `unreferencableStoreIdentityImages`, `isSourceStorageAddress`; two checks added to `parseStoreSettingsInput`. Every CP3 refusal stays, in the same order (a refused key still answers before any image check; tested) |
| `cloudflare/src/app.ts` | only `CP4-IMPORTS-D` and `CP4-ROUTES-D` |
| `cloudflare/test/storefront-fixtures.ts` | new: foreign tables `IF NOT EXISTS`, direct-SQL seeders |
| `cloudflare/test/public-storefront.test.ts` | 3 → 13 tests; one existing case changed (§9) |
| `cloudflare/test/identity-projection.test.ts`, `seo.test.ts`, `sitemap.test.ts`, `redirects.test.ts` | new |

---

## 3. Schema (0043)

```sql
CREATE TABLE redirects (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  from_path  TEXT NOT NULL CHECK (length 2..2048, starts '/', no trailing '/', no '//', no '\',
                                  no '/./' or '/../' segment),
  to_path    TEXT NOT NULL CHECK (length 1..2048, starts '/', no trailing '/' unless '/', no '//',
                                  no '\', no dot segment),
  created_at TEXT NOT NULL CHECK (ISO round-trip),
  created_by TEXT NOT NULL CHECK (length 1..128),
  PRIMARY KEY (tenant_id, from_path),
  CHECK (from_path <> to_path)
);
CREATE INDEX redirects_tenant_to_path_idx ON redirects(tenant_id, to_path);
```

Triggers: `redirects_tenant_immutable`; `redirects_no_chain_insert` / `_update` (a `to_path` that is a `from_path` of the shop, or a `from_path` that is a `to_path` of the shop, aborts: with both directions refused no chain of two exists, so no loop). Bumps: `catalog_version_tenant_settings_{insert,update,delete}`, `catalog_version_tenant_features_{insert,update,delete}`, `catalog_version_tenants_support_email` (only when the value changes), `catalog_version_public_objects_insert` (an active public row) and `_update` (`status`, `bucket` or `object_key` of a public row), `catalog_version_redirects_{insert,update,delete}`.

---

## 4. Routes

Errors: 400 `{"error":{"code":"invalid_request","message":"Request is not valid"}}`; the admin opaque 404 `{"error":{"code":"not_found","message":"Route not found"}}`; a public 404 `{"error":{"code":"not_found","message":"<X> not found"}}`. Every route is an exact path in `onMethods([...])`; the public ones also in `storefront(...)`. An unknown, suspended, provisioning, closed or **unpublished** shop, or one with no name, answers 404 on all three public routes.

### 4.1 `GET /v1/storefront` → `200 { storefront }`, `ETag: "<catalog_version>"`, `Cache-Control: no-cache`, 304 on `If-None-Match`

```ts
{ storefront: {
    name: string, locale: string, currency: string,
    identity: PublicStoreIdentity,                        // §1; absent key = not set
    branding: { logo, hero, favicon, emailLogo },         // PublicImage | null each
    menu: Array<{ label: string, type: "home"|"all-products"|"category"|"tag"|"collection"|"page"|"url",
                  target: string, path: string | null, url: string | null }>,
    features: { abandonedCheckout, contentStudio, discountCodes, marketingMaterials, pod, productReviews }, // booleans
    pickupLocations: Array<{ id, name?, address?, hours?, dates: string[] }>,
    templateId: string | null, theme: PublicTheme, accent: string | null } }
```

- `features[key]` = (explicit row ?? `FEATURE_DEFAULTS[key]`) AND `PORTED_FEATURE_KEYS.includes(key)`; `PORTED_FEATURE_KEYS = ["pod"]` is the one constant (D81).
- `menu`: `home` → `/`, `all-products` → `/produkter`, `category`/`tag` → `/kategori/<slugify>` / `/tagg/<slugify>` (dropped when the slug is empty), `collection` → `/samling/<handle>` only when a **published** collection has that handle, `page` → `/<slug>` only when a **published** page or post has that slug, `url` → `url` only when an absolute http(s) address. Anything else, an entry without a label, an unknown type: left out. `target` is kept so today's `buildMenuHref` keeps working.
- Read: the shop row (`status='active' AND published=1`), the identity and the features in ONE batch (the version labels them); images (`resolvePublicImages(…, ["shop_branding"])`), menu targets and gallery links after it — each of those bumps by trigger, so a body can be newer than its label, never older.

### 4.2 `GET /v1/seo?path=<path under the root>` → `Cache-Control: no-store`, no ETag

Exactly one `path`, no other parameter (else 400). The path goes through `normalizeStorefrontPath` (§5); a path that is not one → 404.

1. A forward for the normal path → `200 { redirect: { status: 301, to } }`, `to` encoded segment by segment (`/samling/%C3%A5r`). Forwards win over pages.
2. A public page → `200 { page: { title, description, canonicalPath, image, robots, jsonLd, bodyHtml } }`:

| Path | Page | title | description | image | jsonLd |
|---|---|---|---|---|---|
| `/` | home | `<name> - <tagline>` or `<name>` | companyDescription ?? tagline ?? name | hero ?? logo | `Organization` (url, logo, description, `contactPoint.email` = supportEmail, `sameAs`) |
| `/produkter` | all products | `Alla produkter \| <name>` | productsSubtitle | null | `CollectionPage` + `ItemList` (≤ 60) |
| `/product/<handle>` | a product behind THE predicate | `<product> \| <name>` | public description ?? `<product> – <name>` | main image (first of `product_images` whose object still resolves) | `Product`, `Offer` or `AggregateOffer` (lowest/highest of the active variants) |
| `/kategori/<slug>` | every category of public products that slugifies to `<slug>` | `<first such name> \| <name>` | — | null | `CollectionPage` + `ItemList` |
| `/tagg/<slug>` | the same for tags | | | | |
| `/samling/<handle>` | a published collection (manual: member order; smart: its tag by address) | `<title> \| <name>` | its description | its cover (`product_media`) | `CollectionPage` + `ItemList` |
| `/<slug>` | a published page (`WebPage`) or post (`BlogPosting`: date, author, image) | meta title ?? title (as `DynamicPage` does) | meta description ?? summary | its image | as named |
| `/legal/kopvillkor`, `/legal/angerratt-och-returer`, `/legal/integritetspolicy` | when the shop's latest adoption holds that text | `<label> \| <name>` | `<label> – <name>.` | null | `WebPage` |
| `/legal/plattformsvillkor` | when a platform terms version is published | same | same | null | `WebPage` |

`robots` is `null` everywhere. `description` ≤ 160 characters, `title` ≤ 200. **`jsonLd`**: every storefront address is `{ "@relative": "<path>" }`, an object of that ONE key (E's reading, open question 3 of E: confirmed); image and logo addresses are absolute public object addresses. **`bodyHtml`**: fixed tags (`article`, `h1`, `h2`, `p`, `ul`, `li`, `nav`, `a`, `img`, `time`) whose every text and attribute value goes through `escapeHtml`; stored HTML (page content, adopted legal text) is first reduced to plain text by `htmlToText` (a linear scan: tags dropped, script-like elements with their content, entities decoded) and then escaped. Blocks are added whole under a budget of 100 000 characters (E accepts 200 000); text ≤ 20 000 characters, lists ≤ 60 products.

3. Anything else → 404, including `/cart`, `/checkout`, the order pages, deeper paths, drafts, taken-down or foreign products, unpublished collections, draft pages, legal pages not adopted.

### 4.3 `GET /v1/sitemap?cursor=&limit=` → `200 { entries: [{ path, lastModified }], nextCursor }`, `no-store`

`limit` 1–5 000 (default 5 000); `cursor` only one this route wrote (`<section>.<base64url of the last key>`, ≤ 512 characters); any other parameter → 400. Sections, in order, each a keyset: static (`/`, `/produkter`), products (by `product_id`, THE predicate), published collections (by `collection_id`), categories and tags of public products (by the text; two names of one address give one entry per answer), published pages and posts (by `page_id`), legal pages (adopted ones + the platform terms when published). `lastModified`: ISO or null (products: the later of product and publication `updated_at`; collections/pages: `updated_at`; legal: adoption / publication date). At most 24 queries per answer; a walk that needs more continues from its cursor.

### 4.4 `/v1/admin/redirects` (shop admin; acting-as admitted, audited with the grant)

| | Request | Answer |
|---|---|---|
| `GET` | `cursor?` (from this list), `limit?` 1–500 (default 100); nothing else | `{ redirects: [{ fromPath, toPath, createdAt, createdBy }], nextCursor }` by `fromPath` |
| `PUT` | `{ redirects: [{ fromPath, toPath }] }`, 1–500, no other key | `200 { redirects }` in the normal form; `400 { error: { code: "refused_redirects", message, problems: [{ index, reason }] } }` with `reason` ∈ `invalid_path`, `reserved_path`, `same_path`, `duplicate`, `chain`; `409 conflict` when a concurrent write makes the batch meet the triggers. One batch, one audit row `storefront.redirects_put { count }` |
| `DELETE` | `{ fromPaths: [...] }`, 1–500 | `204`; unknown paths are no-ops; audit `storefront.redirects_delete { count }` |

Anyone else, another method, a cross-origin or origin-less `PUT`/`DELETE` → the opaque 404, checked before the body is read.

---

## 5. The path normal form (`normalizeStorefrontPath`, used at write and at lookup)

Query and fragment dropped; must start with `/`; trailing slashes dropped (root stays `/`); each segment percent-decoded as UTF-8 (a malformed escape or invalid UTF-8 refuses) and put in NFC; refused: an empty segment, `.`/`..` (also `%2e`), a segment that decodes to hold `/` or `\`, a raw backslash, C0/C1 controls, more than 2 048 characters; case kept. A target (`parseRedirectToPath`) must start with `/` as written and carry no `?` or `#`, so no scheme, host, `//`, `/\`, encoded host or dot segment passes. A source (`parseRedirectFromPath`) may not be `/` or start with `cart`, `checkout`, `order-confirmation`, `order-return`, `angra`, `rapportera-intrang`, `_api`, `assets`, `images`, `sitemap.xml`, `robots.txt` (any case).

---

## 6. Not done

- **The preview of an unpublished shop (D57)** — second pass.
- The admin page for forwards (CP5), the importer's forwards (S).
- The admin settings route does not yet call the image check (Reviewer wiring 1).
- No rate limit on `/v1/seo` and `/v1/sitemap` (the other public reads have none; the limiter writes a D1 row per request).
- No product feed (Google Shopping XML, `utils/productFeed.js`): not in brief D; its category line is the earlier brand's.
- No switch to A's, B's or C's exported functions (Reviewer wiring 5).

## 7. Deviations from the brief, with the reason

1. **`identity.supportEmail` is public**, from `tenants.support_email`. The brief's list does not name it; its never-list excludes "contact addresses that no page prints", and this one is printed by `ShopFooter` (two `mailto:` links) and named by the home's JSON-LD. Without it every footer would show the static placeholder address. A bump trigger on the column is added. The CP1 case that pinned "the support address never appears" is the changed case (§9).
2. **Bump triggers beyond `tenant_settings`/`tenant_features`**: on `tenants.support_email` (it is in the response), on public `stored_objects` (a removed branding image changes the response without touching the row that names it, D93), on `redirects` (rule 6). Builder A's 0040 also adds `catalog_version_public_objects_status` (status only): both fire; harmless (double bump), one can go at consolidation.
3. **The brief says the settings route "keeps refusing every address of the source system's storage"; it did not refuse any.** Added: the parser refuses a string naming `firebasestorage.googleapis.com`, `storage.googleapis.com`, `firebasestorage.app`, `.appspot.com` or `gs://` anywhere in the identity (`400 refused_store_identity_keys` with the paths, e.g. `gallery[0].imageUrl`); the projection also drops such strings on read. The image keys take an object id or null (else 400 `invalid_request`).
4. **The referencability check runs outside the parser** (`unreferencableStoreIdentityImages(env, db, tenantId, json)`): the parser has no `env` and the route does not pass one. It uses `resolvePublicImages` once for all references, which is `getReferencablePublicImage`'s own implementation (same conditions, one batch).
5. **`GET /v1/storefront` of an unpublished shop is now 404** (it answered 200). The brief's rule for all of D; D57 preview is the second pass.
6. **SEO and sitemap answer `no-store` with no ETag**, although PLAN §2.4 lists the sitemap among the cached surfaces: the SEO answer is built from forwards, adopted legal texts and the platform's terms as well, and the only caller (the web Worker) never revalidates; it caches the sitemap XML for an hour itself.
7. **`DELETE /v1/admin/redirects` takes `{ fromPaths }` in its body** (the brief says only "DELETE"): paths with emoji and slashes do not fit an id segment, and it batches like PUT.
8. **A forward may not start from `/` or a purchase page** (§5): a forward there would take the page away from every visitor. **A target may carry no query or fragment.** **The chain rule is checked against what is stored as well as within the batch, stricter than the final state needs**, so no order of the batch's statements can meet a trigger.
9. **Legal pages are at today's addresses, `/legal/<slug>`** (two segments; C uses the same four paths), not `<root>/<slug>` as the grammar table says (open question 2).
10. **`/produkter` has an SEO page** (not in the brief's list; it is the catalogue's crawl page).
11. **`theme`, `accent`, `pickupLocations` are "as stored" by key allowlist, not verbatim**: token keys and pickup keys the pages read; CSS values that could fetch or break a declaration dropped.
12. **Menu entries** are `{ label, type, target, path, url }`; **gallery entries** `{ image, label, path }` (the SKU link resolved to the product's path while it is public).
13. **A's schema differs from the brief**: `product_tags` keeps the tag's case in `tag` and adds `tag_key`; `products` adds `category_key`. My queries name only `tag`/`category` and group names by `slugify` — the same rule as A's keys. The fixtures fill A's extra NOT NULL columns only when the table has them.

## 8. Open questions

1. **Is the support address public?** (Deviation 1.) If not, the footer needs another source.
2. **Legal page addresses.** Today they are `/legal/kopvillkor` etc.; C's `PUBLIC_LEGAL_PAGES` and my `LEGAL_PAGES` use those. E's router has a one-segment content route (its deviation 10), so `/legal/...` reaches its not-found page. E or F must route `/legal/:slug`.
3. **Checkout's client legal gate** (`getLegalReadiness(loadShopConfig())`) reads `returnAddress`, `vatRegistered` and the rest of the full identity, which is not public. F should drop it (the server is the gate) or D adds a boolean.
4. **`legal.noWithdrawalNotice`** stays private: checkout then shows the default notice, which is what the server records. If shops must be able to word their own notice, the server's proof must record that text first.
5. **The platform terms page's body** is the heading only (its text is in R2; C reads it with `readTermsText`).
6. **CP7 base address change**: cached storefront bodies keep the old image addresses until the next bump; bump every tenant once when `PUBLIC_OBJECT_BASE_URL` changes.
7. **Cursor length**: a category of 100 four-byte characters gives a 536-character cursor, over E's 512 cap (E then stops the sitemap there). Only emoji-heavy categories reach it.
8. **Very long non-ASCII handles** (> ~680 characters) give a canonical path over E's 2 048 cap: E then drops the whole answer and serves the page without a head. Likewise a forward target that encodes over 2 048.

## Reviewer wiring

1. **`src/routes/admin-settings.ts`** — after `parseStoreSettingsInput` and before `writeTenantSettings`:
   ```ts
   if (parsed.input.storeIdentityJson !== undefined) {
     const keys = await unreferencableStoreIdentityImages(env, env.DB, principal.tenantId, parsed.input.storeIdentityJson);
     if (keys.length > 0) {
       return jsonResponse({ error: { code: "unreferencable_images", keys, message: "The store identity names an image this shop cannot use" } }, 400);
     }
   }
   ```
   (import from `../platform/tenant-config`). Tested directly in `identity-projection.test.ts`.
2. **`test/admin-settings.test.ts` › "nothing in tenant_settings reaches a public response"** now fails by design: its markers sit in `heroHeadline` and `pickupLocations[].address`, which the storefront shows. Keep the marker in `returnAddress`, `vatNumber`, `sellerType`/`vatRegistered` and move the identity markers to keys that stay private (e.g. `contactEmail`, `legal.noWithdrawalNotice`).
3. **`test/web-worker.test.ts` › "serves the application through the real API, which has no head route yet"** now fails by design: the real API answers `/produkter` with a head (title `Alla produkter | Shop web-shop-a`). Flip it to expect the injected head.
4. **E's `settingsFromStorefront`** (`src/storefront/providers/StoreSettings.jsx`): map `identity.gallery[].image?.url` → `imageUrl` (the page filters on it) and give F `gallery[].path` for the tile link (today it builds `/product/<slug>_<sku>` from `linkSku`, which is no longer sent). `ShopNavigation` keeps working from `type`/`target`; `path`/`url` are there for `shopHref` on a shop's own domain.
5. **Switch to the other builders' functions** once reviewed (A's are now in the tree: `getPublicProductByRef`, `listPublicProductPage`, `listPublicProductsByIds` in `src/catalog/public-catalog.ts`; C's `readPublicPage`, `readPublicShopLegalPage`, `listPublicLegalPages`, `PUBLIC_LEGAL_PAGES`):
   - `seo.ts` `findPublicProductByHandle` + `getPublicProduct` + `mainProductImage` → A's `getPublicProductByRef(env, db, tenant, handle)` (image, `lowestPriceMinor`, `isFromPrice`, category, path). Note A's lowest price skips variants priced 0; mine does not.
   - `seo.ts` `listAllProductLinks`, `listCategoryProductLinks`, `listTagProductLinks` → A's `listPublicProductPage` with no filter / `category` / `tag`.
   - `seo.ts` `publicCategories`, `publicTags` → A (distinct keys of public products), if A exports them.
   - `seo.ts` `collectionPage` (the `collections` row), `listCollectionMemberLinks` and the smart rule → B's collection read (products through A's `listPublicProductsByIds` / tag filter).
   - `seo.ts` `contentPage` → C's `readPublicPage`; `legalPageTexts` + `LEGAL_PAGES` → C's `readPublicShopLegalPage` / `listPublicLegalPages` / `PUBLIC_LEGAL_PAGES`.
   - `identity-projection.ts` `readMenuResolutions` → B's published-handle and C's published-slug reads; `readProductPathsBySku` → A (a by-sku read; A has none yet).
   - `sitemap.ts` sections `products`, `collections`, `categories`, `tags`, `pages` → the builders' keyset lists, if they export them.
   - `redirects.ts` `productPath` / `pagePath` → A's `productPath` (`admin-catalog.ts`, same rule) and C's `pagePath`.
6. **B's 0041** must bump `catalog_version` on `collections` and `collection_products` (the menu and the SEO answer read them). C's 0042 already bumps on `pages` and `legal_acceptances`; A's 0040 on its tables.
7. **Duplicate trigger**: 0040 `catalog_version_public_objects_status` and 0043 `catalog_version_public_objects_update` — keep one (mine also covers an inserted active public row and a change of bucket or key).
8. **`REQUIRED_MIGRATION`** → the highest of 0039–0044 at consolidation (`app.ts`, `test/health.test.ts`, `test/public-catalog.test.ts`).
9. `app.ts` still imports `getPublicStorefront`, which nothing calls; it is kept unchanged.
10. **The importer (S)**: branding goes into `logoObjectId`, `heroObjectId`, `faviconObjectId`, `emailLogoObjectId` and `gallery[].imageObjectId` (object ids from the copy manifest); forwards are stored in the normal form (`normalizeStorefrontPath`), with no chain.

---

## 9. Test numbers

Gate on the final tree (A, C and G mid-work in it): `cd cloudflare && npx tsc --noEmit` — clean. `npx vitest run` — **84 files, 3 586 tests: 3 583 passed, 2 failed, 1 skipped**. The two failures are Reviewer wiring 2 and 3, pinned expectations of files I do not own, failing because the response and the SEO route now exist as the brief asks. In one earlier full run `password-reset.test.ts` › "records a ledger row and enqueues a job…" failed once and passed alone and in the final full run (a timing flake, not in my files). The two `Network connection lost` log lines are P's known R2-simulator lines.

My suites: **199 tests, all passed** —

| File | Tests |
|---|---|
| `public-storefront.test.ts` | 13 (3 existing; **1 changed**: "returns only allowlisted public fields for the hostname tenant" pinned `{ currency, locale, name }` exactly and the absence of the support address; it now pins the full empty response with `identity.supportEmail`, and still that `settings_json` and the other shop's id never appear. The method case now also tries PUT, DELETE, HEAD.) |
| `identity-projection.test.ts` | 31 |
| `seo.test.ts` | 43 |
| `sitemap.test.ts` | 18 |
| `redirects.test.ts` | 94 |

What they prove, per the reviewer's list: the allowlist (an identity of 29 sensitive and unknown top-level keys plus unknown nested keys → none of 13 markers in the response; exact expected identity); no source-storage address and no unprinted e-mail address in any response; every not-ported feature `false` whatever its row (every key set true → only `pod` true); `bodyHtml` escaped (a product and a hero named `</title><script>…` stay text; page HTML reduced to text; `htmlToText` linear on 50 000 unclosed `<script`); every `@relative` an object of one key; a forward never leaves the root (11 hostile targets refused by the parser, 10 bad rows refused by the schema), never chains or loops (in the batch, against what is stored, and by trigger); one normal form at write and lookup (four spellings of an emoji path find one forward); unpublished, suspended and unknown shops 404 on the storefront, the SEO answer, forwards and the sitemap; every list bounded with a keyset (the admin list walks 500 forwards in 3 pages; the sitemap walks 261 addresses in pages of 100 and of 7 with no gap or repeat, and stays whole while a product is unpublished mid-walk); every write the response is built from moves the ETag (identity insert/update, feature insert/update/delete, support address, a removed branding object); authorization (anonymous, another shop's admin, platform without a grant, foreign and missing origin, other methods → opaque 404; acting-as audited with the grant).

Name guard: the three pattern families of `guard/guards.test.mjs` run by hand over every file I created or changed: no match (the guard itself reads tracked files only).

---

## Review round 1 (reviewer, 2026-09-28)

Read line by line: the migration, `identity-projection.ts`, `public-storefront.ts`, the diffs of `public-routes.ts` and `tenant-config.ts`, `redirects.ts`, and of `seo.ts` the text functions, the address grammar, every page builder and `resolveSeoAnswer`. Read in outline: `sitemap.ts`, the two route files. Run by the reviewer after the wiring: `tsc` clean; D's five suites with `admin-settings` and `web-worker`, 312 tests passed.

**Wiring applied by the reviewer:**

1. `PUT /v1/admin/settings` refuses an identity that names an image the shop cannot use (`400 unreferencable_images`, with the paths), and writes nothing. Two route tests added (`admin-settings.test.ts`), the second for an address of the source system's storage.
2. `admin-settings.test.ts`, the privacy case: its markers moved to keys that stay private, among them a key nobody has named yet.
3. `web-worker.test.ts`: the page served through the real API now carries the API's head.
4. The storefront's `settingsFromStorefront` gives a gallery tile its `imageUrl`.
7. **One set of triggers on public objects: D's, in 0043.** C's trigger and its index are removed from 0042; A's goes from 0040 when A is reviewed.

**Waiting:** 5 (the switch to the functions of A, B and C) is done in ONE pass when A and B are reviewed, with D's own tests as the proof that nothing changed. 6 is in B's brief. 8 and 9 at the consolidation.

**Deviations accepted:** 1–13. On 1: the shop's support address is public. The law on electronic commerce makes a seller state how it is reached, and the footer prints it today. The same holds for the legal name, the address and the registration number of the allowlist.

**Answers to the open questions:** 2 is done (the router has `<root>/legal/:slug`, the API answers the address's last segment). 3: F drops the client's legal gate at checkout; the server is the gate and answers the refusal. 4 stays as built. 5: accepted; the text of the platform's terms is read by the page. 6: recorded for CP7, with the rewrite of D78. 7 and 8: the caps of the web Worker are raised to fit when F meets a real case; none of the export's names comes near them.

**A consequence to keep in mind:** the menu and the answer for search engines read `collections`, which exists from B's 0041. Nothing of D is deployed before B is in the tree.
