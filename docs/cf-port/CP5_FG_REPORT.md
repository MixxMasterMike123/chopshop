Model: claude-sonnet-5-5 (Sonnet 5.5)

# CP5-FG report: the catalogue's content pages (collections, collection edit, menu, pages, page edit, storefront look)

Built on `cf-port` in the working tree. No git command that writes, no wrangler, no deploy, no network. The older build's dev server was not started.

## (a) What left, control by control (the admin build only; the older build keeps every one)

| Where | Control | Why it left |
|---|---|---|
| AdminPageEdit | the whole **"Bilagor"** tab (upload, manage, tips) and its tab button | D94: attachments are not built. `FileUpload`, `FileManager` and `utils/fileUpload` are not in this build: the tab's JSX moved unchanged to `src/pages/admin/PageAttachments.jsx`, which the alias list swaps for a component that renders nothing; the data flag `ATTACHMENTS_ENABLED` is false and the tab button is filtered out. |

Nothing else left. Every other control stays, with the behaviours below.

## Behaviour that differs from the older build (copy and markup are byte for byte)

- **Collections list:** the member count of a MANUAL collection is the list's `productCount`. The page's `memberCount` reads `productCount` first, then `productIds` (the older build's documents have no `productCount`).
- **Smart-collection tag picker and the menu's tag list:** `GET /v1/admin/products` carries no tags. The data layer reads each product's detail, 8 at a time, at most 300 products, held 30 s (`replacements/contentSources.js`). See open question 1.
- **Pages list:** the list route carries the title only. The "Översättningar" column and the "SEO:" line need content, so each page is read in full (4 at a time). See open question 2.
- **Empty content** is stored as `<p></p>` (the route refuses blank content; the older page allowed an empty draft).
- **Legal slugs** (`kopvillkor`, `angerratt`, `integritetspolicy`) are reserved by the Worker: typing one gives the "reserverad" refusal. The legal-edit stamp of the older save is therefore not part of this build's save (the seller's own legal text lives in the identity, FE).
- **New collection** is created unpublished, its members set, then published; if the members are refused the new collection is deleted again, so nothing half-made stays.
- **Cover images** of collections: kind `product_media` (the route requires it); the object id is written only when the cover changed.
- **Branding images** (logo, hero, favicon, gallery): kind `shop_branding`; the page keeps addresses, the identity gets `…ObjectId`. A page's addresses never go into the identity. An image removed on the page clears its key in the same save; so does a stored id whose object no longer answers (FE open question 5; also done in the menu save).
- **Errors:** the three pages that had a generic toast now show a specific sentence when the data layer supplies one (`error.userMessage`; absent in the older build, so its toasts are unchanged).

## How the files are laid out (the FC/FE pattern)

Each page's Firebase code moved UNCHANGED into `src/pages/admin/<page>Data.js` (the older build uses it); `vite.admin.config.js` swaps it for `src/admin-app/replacements/<page>Data.js`. The pages import neither Firebase nor the API client.

| Page | Data module (older / admin) | What the admin one calls |
|---|---|---|
| AdminCollections | `adminCollectionsData.js` | `GET /v1/admin/collections` (walked), `PATCH {featured}`, `DELETE`, `PATCH {sortOrder}` per moved collection (4 at a time; unchanged ones skipped) |
| AdminCollectionEdit | `adminCollectionEditData.js` | products + tags, `GET/POST/PATCH/DELETE …/collections[/:id]`, `PUT …/:id/products` (≤ 500, checked first), cover by `uploads.js` |
| AdminMenu | `adminMenuData.js` | products, collections (published), pages (published) lists; `saveShopConfig({menu})` of FE's `shopConfig.js` |
| AdminPages | `adminPagesData.js` | `subscribeToPages` keeps the page's shape: reads on open and again after each delete, no polling |
| AdminPageEdit | `adminPageEditData.js` (+ `PageAttachments.jsx`) | `GET/POST/PATCH …/pages[/:id]`, per-language maps |
| AdminStorefront | `adminStorefrontData.js` | categories from the product list, identity through `loadShopConfig`/`saveShopConfig`, uploads kind `shop_branding`, image addresses from `GET /v1/admin/objects/:id` (`url`) |

New in the admin build: `src/api/admin/content.js` (collections + pages calls), `src/admin-app/adapters/content.js` (pure), `replacements/contentSources.js` (products + tags, pool), `replacements/brandingImages.js` (object id ⇄ address, dead references). Page edits are imports, data calls, and `userMessage` in the catch toasts; plus `memberCount` (above) and the attachments tab in AdminPageEdit.

**The object's public address.** `GET /v1/admin/objects/:id` now answers `url` (app.ts uses `getAdminObjectMetadataWithUrl`; `url` is null only while `PUBLIC_OBJECT_BASE_URL` is unset). The admin turns a stored id into an address through that route only; nothing is constructed by hand. An object that answers 404 (removed) shows the page's own missing-image state.

## What works against the dev API (checked in the browser inside FB's real shell, and by tests)

- **Collections:** list (cover thumbnails, star, count, status), star toggle, "Ändra ordning" with save, delete, create/edit manual and smart, product search + chosen list, cover upload/replace/remove, refusals (taken slug, removed member).
- **Menu:** the five source lists fill (tags Linne/Nyhet/Tryck, collections without drafts, published pages), the page's own validation toasts, save and reload round trip.
- **Pages:** list with metrics, filters, translations 2/3, SEO line; edit, create, publish/draft; refusals as toasts: reserved slug (seen), taken slug, unsafe HTML with the reason (tests), bad slug format (before sending).
- **Storefront:** loads the identity; logo upload shows the preview, save, reload shows the saved logo; removal clears the key.
- Dev routes and invented fixtures are in their own files (`dev/content-dev.mjs`, `content-fixtures.json`); `dev-api.mjs` has one import and one spread.

## Looked at (`/private/tmp/fg-shots/`)

All six pages inside the shell: 1440 light and dark, and 375 light for each; loaded state; empty state (Test Shop C: collections, pages, menu, new collection form); one error state each for the two lists (collections list shows the page's red box; pages shows its toast); refusal toast (reserved slug); menu validation toast; storefront with an uploaded logo. What I saw: markup is the old pages' card for card; the page edit has no Bilagor tab and the tabs close up. Observations that are not this unit's: in dev the template thumbnails (`/template-thumbs/*.png`) and the default `/images/logo.svg` answer HTML (FA open question 6, files outside what the dev/Worker serves); the dark-mode label contrast of `ContentLanguageIndicator`; the shell clips the avatar at 375; the dev server restarted on other builders' edits and dropped the dev sessions several times (I logged in again each time).

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 467  # pass 467  # fail 0   (mine: api 6, adapters 14, data modules against the dev API 13)
npx vite build --config vite.admin.config.js     ✓ built in 8.02s
node cloudflare/admin/check-admin-build.mjs      admin build: 11 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs   storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                   ✓ built in 12.28s
node guard/guards.test.mjs                       FAIL: only (b) stale entries (14: my six pages below, the rest other units' platform files)
```

My new files contain neither forbidden name (checked by grep).

## Guard: for the reviewer (I did not edit `guard/allowlist.txt`)

**(a) Stale entries that are mine (the page no longer imports Firebase), remove:**
`src/pages/admin/AdminCollections.jsx`, `AdminCollectionEdit.jsx`, `AdminMenu.jsx`, `AdminPages.jsx`, `AdminPageEdit.jsx`, `AdminStorefront.jsx`.

**(b) New old-build data modules that import Firebase on purpose (need an entry when tracked):**
`src/pages/admin/adminCollectionsData.js`, `adminCollectionEditData.js`, `adminMenuData.js`, `adminPagesData.js`, `adminPageEditData.js`, `adminStorefrontData.js`. (`PageAttachments.jsx` needs none: it has no Firebase import itself; it reaches `utils/fileUpload`, which is the older build's only.) Net: 6 out, 6 in.

## Deviations

1. **Toasts, not inline errors.** The pages have no per-field error markup; each refusal names its field in the page's toast (rule 17 forbids new markup).
2. **No atomic save.** A page save is one write; a collection save is several. Create undoes itself; an update that saved the fields but not the members says so ("Samlingen sparades, men produktlistan …").
3. **`PUBLIC` branding address on upload:** a branding or cover upload whose object answers no `url` is refused with a sentence (the page cannot show it).
4. **The "product picker" of the brief:** AdminStorefront has none; it reads products only for the frontpage category list. The collection and menu pickers are done as above.
5. **Tests that hit the dev API** run the data modules end to end (a fetch stub hands the admin client's requests to the dev router).

## Open questions / what the routes cannot express

1. **Tags.** Neither the product list nor any route carries tags. A `tags` field on the list item (or a tag-list route) would turn up to 300 reads into none, and make the "N produkter matchar taggen" count and the menu's tag list exact for large shops. Beyond 300 products the tags of the rest are not offered.
2. **Pages list** lacks `metaTitle` and per-language completeness; one extra field (or a count of complete languages) would remove the per-page reads.
3. **Cover and branding refusal reasons.** A cover that is not a product image answers `image_not_referencable`; fine. The identity PUT answers `unreferencable_images {keys}`: the page words it generally ("En av bilderna …"). The keys could be named in the sentence.
4. **"Visa" / "Visa sida" / "Förhandsgranska butik"** link to `/samling/…`, `/<slug>` and `/` on the admin's own origin, which is not the storefront's. `getCollectionUrl` and the plain hrefs come from the older build; FF/WX should decide the storefront origin (the `urls.js` replacement has it) and whether those links get it.
5. **Template thumbnails and the default logo** (`/template-thumbs/*.png`, `/images/logo.svg`) are not served by the admin Worker (FA open question 6): the template picker shows broken images until WX serves them.
6. **Hero and gallery** share kind `shop_branding` (the gallery has always used the hero upload). The gallery's `linkSku` stays a text field (no product picker exists in the page).
7. **Legacy URL keys.** An identity that still holds a plain `logoUrl`/`heroImageUrl` (not an object id) keeps showing it (the page merges the stored key); this build never writes those keys and cannot clear one.
8. **`saveShopConfig` lost-update window** (FE) applies to the menu and the look: another admin's concurrent identity write between its GET and PUT is lost.

## Files

**Created**
- `src/api/admin/content.js`, `src/api/admin/content.test.mjs`
- `src/admin-app/adapters/content.js`, `src/admin-app/adapters/content.test.mjs`
- `src/admin-app/replacements/{adminCollectionsData,adminCollectionEditData,adminMenuData,adminPagesData,adminPageEditData,adminStorefrontData}.js`, `PageAttachments.jsx`, `contentSources.js`, `brandingImages.js`
- `src/pages/admin/{adminCollectionsData,adminCollectionEditData,adminMenuData,adminPagesData,adminPageEditData,adminStorefrontData}.js` (older build, Firebase), `src/pages/admin/PageAttachments.jsx`
- `src/admin-app/dev/content-dev.mjs`, `content-fixtures.json`, `content-dev.test.mjs`
- `docs/cf-port/CP5_FG_REPORT.md`

**Modified**
- `src/pages/admin/{AdminCollections,AdminCollectionEdit,AdminMenu,AdminPages,AdminPageEdit,AdminStorefront}.jsx` (data layer only, as above)
- `src/admin-app/pages.jsx` (my six lines), `vite.admin.config.js` (seven alias rows), `src/admin-app/dev/dev-api.mjs` (one import, one spread)
