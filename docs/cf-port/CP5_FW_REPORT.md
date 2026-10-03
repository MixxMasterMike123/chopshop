claude-sonnet-5-5 (Sonnet 5.5)

# CP5-FW report: the admin pages read what unit WJ added

Built on `cf-port` (HEAD `14976ab0`), in the working tree, only under `src/**` and this file. No git command that writes, no network. Nothing of FM's files (`src/wagons/pod-wagon/**`, `src/api/admin/pod.js`, `pod*`, `pages.jsx`, `vite.admin.config.js`, `guard/allowlist.txt`) and nothing under `cloudflare/**` was touched. No page file (`src/pages/**`) was changed: every item is data layer, adapters and dev fixtures.

The "Frontend wiring" table of `CP5_WJ_REPORT.md` and the brief's list agree on all six items. Two differences in the means, not the aim: the table says the tag counts come from `GET /v1/admin/tags`; no page shows a count, and the list now carries every product's tags, so no tag route is called (see "Not done").

## Item 1: product list, `variantCount` and `tags`

- **Files:** `src/admin-app/adapters/product.js` (`productFromListItem`), `src/admin-app/replacements/adminProductsData.js` (`LIST_SHOWS_VARIANT_COUNT = true`), `src/admin-app/replacements/contentSources.js` (rewritten), dev: `src/admin-app/dev/products-dev.mjs`.
- **Page now:**
  - The "Varianter" column is back. The page reads `p.variants.length`, so the list row holds `variantCount` empty stand-ins (the form still reads the real rows from the detail).
  - `p.tags` is the list's, so the tag filter's `availableTags` is built from it.
  - The collection picker and the menu builder read tags from the list: `loadProductsWithTags` is now one list pass. The N `getProduct` reads, the 300-product cap (`TAG_READ_CAP`), the 30 s hold and `forgetProducts` are gone. `inPool` stays (`adminCollectionsData.js` uses it).
- **Tests:** `product.test.mjs` (count and tags reach the row; a bad count is 0; non-string tags dropped), `products-dev.test.mjs` (count is active-only: a deactivated variant stops counting; tags as typed), `content-dev.test.mjs` (the picker makes no single-product read).
- **Mutations (each failed the tests):** count always 0 (2 failed), tags dropped in the adapter (1), dev counts inactive variants (1), `contentSources` ignores `item.tags` (2).

## Item 2: pages list, SEO texts and languages

- **Files:** `src/admin-app/adapters/content.js` (`pageDocFromApi`, new `contentOfListRow`), `src/admin-app/replacements/adminPagesData.js` (the per-page `getPage` reads are gone: one list), dev: `src/admin-app/dev/content-dev.mjs`.
- **Page now:** the "SEO:" line reads `metaTitle` from the list; "Översättningar n/3" is computed by the page's own rule from `title`, `metaTitle`, `metaDescription` and the content stand-in. `contentLanguages` becomes `content = { <lang>: ' ' }` per language (the page only tests `length > 0`; the stand-in is for list rows only, a page's own read keeps its real `content`).
- **Tests:** `content-dev.test.mjs` (no page read on its own; SEO maps as stored; the page's status rule on the rows gives `[2, 0, 0]`), `content.test.mjs` (list row: SEO maps, language stand-ins with no text, a full page keeps its own content).
- **Mutations:** the languages ignored (2 failed), the dev list without SEO texts (1), the adapter drops `metaTitle` (2).

## Item 3: order search by name

- **Files:** `src/api/admin/orders.js` (`searchQueryOf`), dev: `src/admin-app/dev/orders-dev.mjs`, comment in `replacements/adminOrdersData.js`.
- **How the page searches:** the box already goes to the server (`searchOrders` → `q`, 300 ms pause); `searchQueryOf` only decided what is sent. It now follows the Worker's grammar exactly: `@` → e-mail (unchanged); otherwise the trimmed text must match `^[\p{L}\p{M}\p{N} '’.-]{1,100}$` (the order-number prefix is the same text, so it needs no separate branch). A text outside the grammar (`%`, `_`, `\`, `<`, empty, over 100) is not sent and matches nothing, so the page never meets the Worker's 400. The page's filtering is otherwise unchanged.
- **Tests:** `orders.test.mjs` (names with space, `Å Ä Ö`, `'`, `’`, `.`, `-`, a combining mark, 100 chars; the refused set), `orders-dev.test.mjs` (the dev router follows the Worker: name or number; 400 for the refused set; and `searchOrders` end to end: the trimmed name is the `q`, `50%` sends no request).
- **Mutations:** the old order-number-only grammar (2 failed), no `@` branch (2), the untrimmed text sent (2).

## Item 4: who signed, and when

- **Files:** `src/admin-app/adapters/signer.js` (new, `signerLabelOf`), `adapters/settings.js` (`acceptanceFromView`), `adapters/platformTerms.js` (`acceptanceOf`); dev: `src/admin-app/dev/shells-dev.mjs` (terms status carries `latestAcceptance`, an acceptance records its signer), `src/admin-app/dev/dev-api.mjs` and `fixtures.json` (`acceptedBy` on the legal-pages adoption).
- **Rule:** a person of the shop reads as the address, else the name; a platform signer reads **"Plattformen"** (the shop is told no name). Where the platform console is told a person it reads the person (see item 6). No one named gives no `email` key, so the page prints its own "okänd användare" as before.
- **Page now:**
  - AdminSettings "Godkända av …" reads the signer of the adoption (`GET /v1/admin/legal/pages` `acceptedBy`). An adoption just made keeps the signed-in user's address, because the POST answer names no signer and `acceptanceFromView` adds no `email` key then.
  - AdminPlatformTerms "Godkända av … · version …" reads `status.latestAcceptance`, so the date and signer of an OLDER version now show too (the status page's old "no date" hole). Without `latestAcceptance` the old fields are used.
- **Tests:** `signer.test.mjs` (new), `settings.test.mjs`, `platformTerms.test.mjs`, `dev-api.shells.test.mjs`, `dev-api-settings.test.mjs`, and `src/admin-app/replacements/legal-signer.test.mjs` (new: the two reads end to end against the dev API, including a platform signer on an older version).
- **Mutations:** "Plattformen" label dropped (4 failed), `latestAcceptance` ignored (3), `email` not read in `acceptanceFromView` (2).

## Item 5: a refused legal text names its page

- **Files:** `src/admin-app/adapters/settings.js` (`refusedTextKeys(details)` now reads `error.details.pages`; new `LEGAL_PAGE_NAMES`, `pageNamesOf`), `src/admin-app/replacements/legalAcceptance.js` (`errorOfAnswer`), dev: `dev-api.mjs` (accept-pages answers `page`, `pages`, `reason` after the shape check).
- **Page now:** the toast reads "Texten för Ångerrätt innehåller HTML som inte kan publiceras (…). Ändra texten och godkänn igen." (several: "Köpvillkor och Integritetspolicy", "Köpvillkor, Ångerrätt och Integritetspolicy"), and `error.refusedKeys` is exactly the named pages, so the settings page opens and marks those. A 400 without `pages` is a malformed body and keeps "Villkoren kunde inte godkännas: förfrågan avvisades." (This changes the older guess, which blamed every custom page.)
- **Tests:** `settings.test.mjs` (`refusedTextKeys`, `pageNamesOf`), `dev-api-settings.test.mjs`, `legal-signer.test.mjs` (one page and two pages end to end: message and `refusedKeys`).
- **Mutations:** `pages` ignored (3 failed), the page name left out of the message (2).

## Item 6: platform shop detail

- **Files:** `src/admin-app/adapters/platformShops.js` (`toDetailShop` now spreads `legalFactsOf(detail.legal)`; new `legalFactsOf`, `legalReadinessFromLegal`; `legalSummary`, `legalReadinessFromSummary` and `ACCEPTANCE_UNKNOWN` removed), `src/admin-app/replacements/shopCellsData.js` (`LEGAL_FACTS = true`, `legalReadinessOf` → `legalReadinessFromLegal(shop.legal)`, a live `PLATFORM_TERMS_VERSION`, `noteCurrentTermsVersion`), `src/admin-app/replacements/platformShopDetailData.js` (one line: hands the read's `legal.terms.currentVersion` to the cells), dev: `src/admin-app/dev/platform-dev.mjs` + `platform-fixtures.json` (a `legal` per shop).
- **Page file:** unchanged. `PlatformShopDetail.jsx` and `shopCells.jsx` read the same names as before.
- **Page now:**
  - `ready` is the checkout's own answer (`legal.checkoutOpen`: the terms gate and the three legal conditions, one predicate with the checkout), so "Juridik OK" and the GO LIVE warning ("juridiska sidor ej klara") mean what the checkout decides. The blockers list, in the seller's order, the missing part: platform terms, return address, VAT answer, adoption of the pages. A shop in the terms grace period reads ready, as its checkout is open.
  - The "Juridik" card's rows are shown: "Butikens villkor godkända" (`pagesAdoption`: signer, time, template version) and "Plattformsvillkor godkända" (`terms.latestAcceptance`: signer, time, version), and the "gammal version" pill.
  - The platform console is told the signer's person by the Worker, so a platform signer with a name or address reads that; only one with neither reads "Plattformen".
  - The pill compares the accepted version with `PLATFORM_TERMS_VERSION`, a module constant in the page. It is now a live binding of `shopCellsData.js`, set from each detail read (the same for every shop). It is `null` until the first read, which the page never renders before.
  - A detail without `legal` (should not happen) is never ready.
- **Tests:** `platformShops.test.mjs` (the facts and the readiness, ready = `checkoutOpen`, grace, every blocker, no `legal`), `platform-dev.test.mjs` (the new key), `src/admin-app/replacements/platform-legal.test.mjs` (new: three shops through the adapter and the cells; `platformShopDetailData.js` cannot be loaded under Node because `urls.js` reads `import.meta.env`, so its one added line is checked in the source).
- **Mutations:** `ready` from the pieces instead of `checkoutOpen` (1 failed), terms gate not a blocker (2), the version not noted (1), the adoption's signer dropped (2).
- **The platform's `legal` stays in platform modules:** `platformShops.js`, `shopCellsData.js`, `platformShopDetailData.js`. The only shared file is `signer.js`, a pure label function. No commission or cost entered an admin-tree module.

## Not done, and listed

- **`GET /v1/admin/tags` has no client call.** The list now carries every product's tags, so the picker and the menu build their distinct tag lists from it (no cap, no extra request). The route's merged-by-key spelling and `productCount` would only matter for a page that shows counts; none does. If wanted later, one function in `src/api/admin/products.js` is all it needs.
- **The order list's search to a 400:** not reachable from the page any more (the client does not send text outside the grammar), so there is no "400 as no match" branch.
- Nothing needed a markup change; no page file changed.
- Not touched, as before: the Worker's items for payment method (`CP5_WJ_REPORT.md` item 7) and FC's open question about a bare 400 on `moreInfo`.

## Files

**Created:** `src/admin-app/adapters/signer.js`, `src/admin-app/adapters/signer.test.mjs`, `src/admin-app/replacements/legal-signer.test.mjs`, `src/admin-app/replacements/platform-legal.test.mjs`, `docs/cf-port/CP5_FW_REPORT.md`.

**Modified (adapters, data modules, client):** `src/admin-app/adapters/{content,platformShops,platformTerms,product,settings}.js`, `src/admin-app/replacements/{adminPagesData,adminOrdersData,adminProductsData,contentSources,legalAcceptance,platformShopDetailData,shopCellsData}.js`, `src/api/admin/orders.js`.

**Modified (dev API and fixtures):** `src/admin-app/dev/{content-dev,dev-api,orders-dev,platform-dev,products-dev,shells-dev}.mjs`, `src/admin-app/dev/{fixtures,platform-fixtures}.json`.

**Modified (tests):** `src/admin-app/adapters/{content,platformShops,platformTerms,product,settings}.test.mjs`, `src/admin-app/dev/{content-dev,dev-api-settings,dev-api.shells,orders-dev,platform-dev,products-dev}.test.mjs`, `src/api/admin/orders.test.mjs`.

## Gates

- `node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs`: **tests 630, pass 630, fail 0** (604 at HEAD; 26 added by this unit).
- `npx vite build --config vite.admin.config.js`: built. `node cloudflare/admin/check-admin-build.mjs`: "13 files (7 text) checked, no Firebase code, no source map, no secret, every file servable."
- `npx vite build` (older build): built. `node cloudflare/web/check-storefront-build.mjs`: "11 files (7 text) checked, no Firebase code, every file servable."
- `node guard/guards.test.mjs`: **exit 0, PASS** (2332 tracked files scanned, allowlist 296 = baseline). The new files are untracked, so it does not scan them yet; they hold no earlier brand name.
- Not run: the Worker's own gate (nothing under `cloudflare/**` changed).
