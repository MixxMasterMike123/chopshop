Model: claude-opus-5-5 (Opus 5.5)

# CP5-FX report: seven of Codex's findings in the admin build's frontend (1, 2, 3, 5, 6, 7, 9)

Built in the working tree on `cf-port`, beside unit WJ4 (which writes `cloudflare/**`, `src/api/admin/platform.js`, the platform-users data and adapter files, `platform-dev.mjs`, `addShopUserData.js`; none of those is touched here, `platform.js` is only imported). No git command that writes, no network (localhost only), no wrangler, no deploy. The older build's dev server was not started.

Every fix has a test under Node that fails without it: each was broken once on purpose (the mutation is named per finding) and the test was read failing, then the file was restored and compared byte for byte with its copy.

## Controls that left a page

None. No markup, class name or token changed. Where a shared page changed, it is the data it reads (a text, a link's props, an outcome), listed per finding.

## Finding 1 (P1): the order list, the detail and the dashboard are bound to the active shop

**Cause.** `Orders.jsx` handed every page one frozen set of module-level functions. `AdminOrders`' loading effect depends only on `getAllOrders`, so after "Byt butik" it never ran again and the previous shop's orders stayed on screen. With no shop chosen yet, the first request failed with `no_shop`; that error stayed in the page's state after a shop was chosen. The same flaw sat in the order DETAIL: its `fetchAttempted` gate kept shop A's order on screen under shop B. The DASHBOARD reloaded on a new `shopId`, but an answer of the previous shop could still land last, and its error stayed. A list walk read the active shop per page, so a cursor of one shop could be sent to another.

**Fix.**
- `src/admin-app/providers/ordersForShop.js` (new, pure): `ordersForShop(shopId)` builds the context value for ONE shop. `readForShop(shopId, read)` asks nothing and never settles when there is no shop (the picker is up: no "no shop" error is left behind). It never settles either when the answer or the failure arrives after the tab moved to another shop: the previous shop's answer is dropped, never shown. Reads and writes send that shop's `X-Shop-Id` explicitly. `withUserMessage` and `CANCEL_REASON` moved here (still re-exported by `Orders.jsx`) so the order data modules can be imported under Node.
- `src/admin-app/providers/Orders.jsx`: `useMemo(() => ordersForShop(shopId), [shopId])`. A new shop gives new functions, so the pages' effects run again.
- `src/admin-app/replacements/adminDashboardData.js`: `loadDashboardStats(shopId)` goes through `readForShop` for the page's shop.
- `src/api/admin/orders.js`: `listOrders`, `listAllOrders`, `getOrder`, `changeFulfilment`, `cancelOrder` take `{ shopId }`. `listAllOrders` sends every page to ONE shop, by default the shop that was active when the walk began.
- `src/admin-app/AdminApp.jsx` (`ShopRequired`): the guarded page is mounted under `<Fragment key={shopId}>`. A new shop mounts the page afresh, so no list, form, error or pending answer of the previous shop survives. This is the admin build's router, not a shared page. It is what clears the detail's `fetchAttempted` gate and the list's and dashboard's error state without editing those pages. It also keeps any open form of shop A (a product, a collection) from being saved into shop B.

**Tests.** `src/admin-app/providers/ordersForShop.test.mjs` (12):
- each walk page carries the bound shop, even when the tab moves mid-walk;
- functions of shop A ask A even while B is active;
- a list, a detail or dashboard numbers that arrive after the switch never settle, and neither does a 500 of the previous shop;
- a failure while the shop is still active is reported;
- no shop (null or the sentinel): nothing is asked and nothing settles; a write is refused with `no_shop`;
- writes go to their own shop;
- another shop gives other functions.

**Mutations.** Dropping the "is it still the active shop" check: 5 tests fail. Asking the active shop instead of the bound one in the list, the detail, a write and the dashboard: 1 fails each. Dropping the no-shop check: 2 fail.

**Seen rendered** (dev API, `admin-multi@example.com`): on `/admin/orders` under Shop A, 9 orders. "Byt butik" → Shop C: 0 orders, no error banner. On A's order detail, switching to C gives the page's own "Order not found", not A's order.

## Finding 2 (P1): per-size prices survive the form

**Cause.** The rail holds ONE price per group. `productFromDetail` showed a group whose sizes have different prices with the first size's price. The save derived every size from that one price (`deriveVariantsFromGroups`), and `planVariantSync` wrote it to every size whose price differed. Saving a description change silently re-priced the other sizes.

**Fix (`src/admin-app/adapters/product.js`, `src/admin-app/replacements/productFormData.js`).** The form's `normalizeGroups` (ProductForm.jsx) keeps only label, sku, price, images and sizes, so a hidden field on the group would not survive. The per-size knowledge therefore rides on the hidden server snapshot the save already receives, and `ProductForm.jsx` is not touched:
- `productFromDetail` adds `_server.railPriceOf[variantId] = { shown, mixed }`: the price the form shows for the size's group, and whether the group's sizes have different prices.
- `desiredVariants(cleanVariants, cleanGroups)`: each row carries `groupPrice`, its group's price field as the seller left it.
- `planVariantSync(existing, desired, { railPriceOf })`: a size of a MIXED group keeps its own price while the group's price field equals what the form showed (compared as the derivation reads the field: a set price > 0, else inherited). Groups with one price, inherited groups and new sizes work as before.
- `repricedMixedGroups(plan, desired, railPriceOf)` names the mixed groups whose price the seller DID change. The save then says: "Storlekarna i "X" hade olika priser och har nu alla variantens pris."

**Documented behaviour of a deliberate change.** Changing a mixed group's price, or emptying it so it follows the product price, sets every size of that group to the new price. That is the rail's rule, as in the older build, and the save announces it. A new size takes the group's shown price. A renamed group keeps each size's price. A new product price moves inherited groups only.

**Tests** (`src/admin-app/adapters/product.test.mjs`, 7 new, in a describe that mirrors `normalizeGroups` and the save's variant step exactly):
- the form shows one price;
- **a save that changes anything else writes NO price** (the plan is empty);
- a new product price writes only the inherited group;
- a rename plus a new size writes only the new size's price;
- **a deliberate group price writes every size and is announced**;
- an emptied price makes every size follow the product price, announced;
- a one-price group is unaffected.

**Mutations.** "Never keep" the size's price: 4 fail. Not recording `railPriceOf` on load: 6 fail. "Always keep": 2 fail.

## Finding 3 (P2): a pending refund is said as pending

**Cause.** `refundWholeOrder` resolved the same way for a 202 `reserved` (Stripe's outcome unknown) as for a refund Stripe had confirmed. The page then announced "Ordern återbetalad".

**Fix.**
- `src/admin-app/replacements/adminOrderDetailData.js` resolves an outcome: `{ pending: true, message, refund }` for a 202 or `state: 'reserved'`, else `{ pending: false, refund }`. `failed` is still a refusal. `submitted` and `succeeded` count as done: Stripe has the refund.
- The older module `src/pages/admin/adminOrderDetailData.js` keeps the same contract: it now returns `{ pending: false }`, because the callable answers only when the refund is done.
- `src/pages/admin/AdminOrderDetail.jsx` (3 lines): `if (outcome?.pending) toast(outcome.message, { duration: 10000 }); else toast.success('Ordern återbetalad');`. The older build behaves as before.

**Tests.** `src/admin-app/replacements/adminOrderDetailData.test.mjs` (4):
- 202 `reserved` is pending, with the message, and never says "återbetalad";
- 201 `succeeded` and 201 `submitted` are done;
- `failed` is a refusal in words;
- nothing refundable means nothing is sent.

**Mutation.** Never pending: 1 fails.

## Finding 5 (P1): the publication words say what unpublishing does here

**Cause.** The platform detail, the list and the new-shop note were written for the older build, where `published === false` means noindex only. On Cloudflare it closes the storefront (D57), so "Butiken förblir öppen via länk" was untrue.

**Fix.** Each build's words live in a pure module, under the same names and keys:
- `src/pages/platform/publishCopy.js`: the older build's, today's text unchanged.
- `src/admin-app/replacements/publishCopy.js`: this build's.

Each build's data modules re-export them under the names the pages read. `platformShopDetailData.js` gives `PUBLISH_COPY`, `platformShopsData.js` gives `PUBLISH_COPY` and `provisionShopData.js` gives `NEW_SHOP_NOTE`, for both builds. `PlatformShopDetail.jsx`, `PlatformShops.jsx` and `ProvisionShopModal.jsx` render those values in their unchanged markup. A highlighted word is its own key, so every `<span>` and class stays.

The list page and the provisioning modal carried the same untrue wording and are fixed too. The provisioning data module's failure toast named the old button; that is fixed as well.

**Tests.** `src/admin-app/replacements/publishCopy.test.mjs` (6):
- both builds export the same keys;
- no text of this build promises an open shop (no "öppen via länk", "förblir öppen", "köpbar", "noindex", "dold för sök", "sökbar", "TA UR SÖK");
- the unpublish confirm says "stängs för besökare" and "förhandsgranskas";
- the card, the list and the note in full;
- **the older build's words are asserted string for string** as the JSX rendered them before.

**Mutation.** The old confirm put back into this build's copy: 2 fail.

**Seen rendered** (platform user):
- the list: column "Publicering", badges "Publicerad" and "Opublicerad", the new tooltips;
- Shop C's detail at 1440 and 375, and Shop A's detail with "AVPUBLICERA";
- the confirm text, captured from `window.confirm`;
- the modal's note.

The layout holds at both widths. The admin bundle has none of the old words; the older build's bundle still has "förblir öppen via länk" and no "AVPUBLICERA".

## Finding 6 (P2): the collection's baseline follows each save

**Cause.** `saveCollection` compared with `form.savedProductIds`, `savedType` and `savedImageUrl` from the first load, and the page never refreshes them. Add a product and save, then remove it and save: the second `PUT …/products` was skipped. The cover had the same flaw: set a cover and save, then clear it and save, and the clear was never written.

**Fix (`src/admin-app/replacements/adminCollectionEditData.js`).** A per-tab `held` map records what the server holds for each collection: the cover, the type and the members. `loadCollection` sets it, and each step that succeeds updates it:
- the cover after the PATCH;
- a manual collection's type and members only after their PUT succeeded, so a refused list is sent again next time;
- a new collection after its creation.

The save compares with `held`, and falls back to the form when the collection was never loaded through this module.

**Other FG modules checked.**
- The menu: `saveMenu` reads the identity fresh on every save. No baseline.
- The pages: `savePage` sends the whole body. No baseline.
- The look: `saveBranding` already refreshes `state.loaded` after a save. The gallery is sent whole.

None has this flaw.

**Tests** (`src/admin-app/dev/content-dev.test.mjs`, 3 new, against the dev API):
- add then remove across two saves: the second save sends `PATCH`, `PUT` and the server holds the original list;
- a cover set then cleared across two saves is cleared;
- a refused member list is sent again on the next save.

**Mutations.** Comparing with the first load again: 2 fail. Holding the members before the PUT succeeded: 1 fails.

## Finding 7 (P2): an image whose read failed is kept, not removed

**Cause.** `brandingImages.js` `look()` turned a failed object read (a network error, a 500) into "resolved, no address". The page then held the default for the hero, the favicon and the logo, which is empty for the hero and the favicon. `brandingPatch` read that empty value as a removal and cleared the stored id. `brandingFromIdentity` dropped the gallery entry's id with no address in its place, so the gallery lost its image ids too.

**Fix.**
- `src/admin-app/replacements/brandingImages.js`: a failed read is marked `unread` (`loaded[key].unread`, `addresses['unread:<id>']`). "Gone" (the API's 404) is still cleared as before.
- `src/admin-app/adapters/content.js` `brandingPatch`: an unread key is left out of the patch, so the stored id stays, unless the page names a known object, which means the seller uploaded a replacement. `brandingFromIdentity` keeps `imageObjectId` on an unread gallery entry (the page carries an entry's other keys along). `brandingPatch` keeps that id unless the entry got an uploaded address.
- `src/admin-app/replacements/adminStorefrontData.js`: when any read failed, the seller is told: "Några bilder kunde inte hämtas just nu och visas inte. De finns kvar och ändras inte när du sparar."

**Rule, stated.** An unread image cannot be removed on this page, because the page never showed it. It can be replaced by an upload. On the logo, "Ta bort" on the default the page shows keeps the stored logo. A removal needs a load where the preview was read. A removal of an image whose preview WAS read still clears it, as before.

**Tests.**
- `src/admin-app/adapters/content.test.mjs` (2 new): unread keys are kept, an upload replaces, a read-then-removed image is still cleared; an unread gallery entry keeps its id through `brandingFromIdentity` and `brandingPatch`, a gone one is cleared, a replaced one takes the upload.
- `src/admin-app/dev/content-dev.test.mjs` (1 new): against the dev API, with the object reads answering 500, a page-like save of the accent keeps `heroObjectId`, `faviconObjectId` and the gallery's ids.

**Mutations.**
- Unread treated as removed: 2 fail.
- The unread gallery id dropped on load: 2 fail.
- A failed read not marked: 1 fails.

## Finding 9 (P2): the storefront links go to the storefront, or to its preview

**Cause.** The admin build serves the admin on its own origin, but these links were relative paths on that origin:
- `AdminStorefront` "Förhandsgranska butik" opened `/`;
- `AdminPages` and `AdminPageEdit` "Visa sida" opened `/${slug}`;
- `AdminCollectionEdit` "Visa" opened `getCollectionUrl()`, which builds the unresolved shop prefix on an admin path.

**Fix. One helper, used by all four places.**
- `src/admin-app/adapters/storefrontLinks.js` (new, pure) builds the address: `<VITE_STOREFRONT_ORIGIN>/<shop><path>`. The paths follow the storefront router's grammar: `/`, `/<slug>`, `/samling/<handle>`.
- `storefrontLinkProps` gives `{ href }` for a published shop. For an unpublished shop, or one whose state is not known yet, it also gives an `onClick` that prevents the plain address (the not-found page) and opens the preview.
- `src/admin-app/replacements/storefrontLinks.js` (new): `useStorefrontLinks()` reads the active shop and `published` from `GET /v1/admin/shop`. `openStorefrontPreview` opens the tab inside the click, asks `POST /v1/admin/preview` for a grant (`requestStorefrontPreview`, already in `platform.js`), then points the tab at `<address>#preview=<grant>` (CP4-D2 reviewer wiring 1). The toast reads "Förhandsvisning öppnad – gäller i N minuter". On failure the tab closes and the toast reads "Förhandsvisningen kunde inte öppnas. Försök igen."
- `src/pages/admin/storefrontLinks.js` (new, the older build's) answers today's hrefs unchanged: `/`, `/${slug}` and `getCollectionUrl(handle)`.
- `vite.admin.config.js`: one alias row.
- The four pages each call `useStorefrontLinks()` at the top and spread `{...storefrontLinks.home()}`, `.page(slug)` or `.collection(handle)` where the `href` was. `AdminCollectionEdit` no longer imports `getCollectionUrl`, which moved into the older module.

**Tests.** `src/admin-app/adapters/storefrontLinks.test.mjs` (6):
- the home, a page and a collection address on the storefront's origin;
- no doubled slash, never an admin path;
- no shop gives no link;
- the preview fragment;
- published gives only `href`;
- unpublished or unknown: the click prevents the default and asks for the preview of the same place.

**Mutations.** Relative paths: 2 fail. No preview for an unpublished shop: 1 fails.

**Seen rendered** (dev server with `VITE_STOREFRONT_ORIGIN=https://storefront.example.com`):
- Shop C (unpublished): the look page's link is `https://storefront.example.com/test-shop-c/`. The click opened a tab (`window.open('', '_blank')`) and pointed it at `https://storefront.example.com/test-shop-c/#preview=devpreviewgrant.invented`, with the toast "Förhandsvisning öppnad – gäller i 30 minuter".
- Shop A (published): the pages list gives `…/test-shop-a/om-oss` and `…/test-shop-a/kontakt` (no click handler), the page editor `…/test-shop-a/om-oss`, the collection editor `…/test-shop-a/samling/hem-och-linne`, the look page `…/test-shop-a/`.

## Gates (run on the final tree, which also holds WJ4's work in progress)

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 557  # suites 168  # pass 557  # fail 0      (was 516 at HEAD; mine: 41 = 28 in 4 new files + 13 in 3 existing)
npx vite build --config vite.admin.config.js          ✓ built in 6.64s
node cloudflare/admin/check-admin-build.mjs           admin build: 13 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.  exit 0
  + my own grep of cloudflare/admin/dist for the two forbidden names: 0 files
npx vite build                                        ✓ built in 11.11s
node cloudflare/web/check-storefront-build.mjs        storefront build: 11 files (7 text) checked, no Firebase code, every file servable.  exit 0
node guard/guards.test.mjs                            guard: PASS (exit 0), allowlist size = 296 = baseline (unchanged)
  + my new, untracked files checked by hand for the forbidden names and Firebase imports: none
```

The Worker gates were not run: nothing under `cloudflare/` is mine.

## Visible text changed (old → new)

**Admin build only. The older build's words are unchanged, asserted by test.**

PlatformShopDetail:

| Where | Old | New |
|---|---|---|
| Heading | Sökbarhet | Publicering |
| Badges | Sökbar / Dold för sök | Publicerad / Opublicerad |
| Published status | Butiken är sökbar — Google och Bing får indexera ‹adress›. | Butiken är publicerad — öppen för besökare, och Google och Bing får indexera ‹adress›. |
| Unpublished status | Butiken är dold för sökmotorer (noindex). Den är fortfarande öppen och köpbar via länk — bara osynlig i Google/Bing tills du klickar GO LIVE. | Butiken är opublicerad — stängd för besökare och sökmotorer. Den kan bara förhandsgranskas inifrån admin tills du klickar GO LIVE. |
| Button | TA UR SÖK | AVPUBLICERA (GO LIVE unchanged) |
| Confirm, publish | Vill du göra "X" sökbar (GO LIVE)?… | Vill du publicera "X" (GO LIVE)? Butiken öppnas för besökare och sökmotorer.… |
| Confirm, unpublish | Vill du dölja "X" från sökmotorer? Butiken förblir öppen via länk. | Vill du avpublicera "X"? Butiken stängs för besökare och sökmotorer: dess sidor visas inte längre. Den kan fortfarande förhandsgranskas inifrån admin. |
| Toasts | Butiken är nu sökbar (indexeras) / Butiken är nu dold för sökmotorer / Kunde inte ändra sökbarhet | Butiken är nu publicerad / Butiken är nu stängd för besökare / Kunde inte ändra publiceringen |

PlatformShops:

| Where | Old | New |
|---|---|---|
| Column | Sök | Publicering |
| Badges | Sökbar / Dold | Publicerad / Opublicerad |
| Tooltip, published | Indexeras av Google/Bing | Öppen för besökare och sökmotorer |
| Tooltip, unpublished | Dold för sökmotorer (noindex) — butiken är ändå öppen via länk | Stängd för besökare och sökmotorer — kan förhandsgranskas inifrån admin |

ProvisionShopModal:

| Where | Old | New |
|---|---|---|
| Note | Butiken skapas dold för sökmotorer (öppen via länk) — gör den sökbar via GO LIVE … | Butiken skapas opublicerad (stängd för besökare och sökmotorer) — öppna den via GO LIVE … (the rest unchanged) |
| Failure toast item | dölj butiken (TA UR SÖK) | avpublicera butiken (AVPUBLICERA) |

New messages:

| Where | When | Text |
|---|---|---|
| Order detail | A 202 refund, instead of "Ordern återbetalad" | Återbetalningen är påbörjad men inte bekräftad ännu. Ladda om sidan om en stund. |
| Product save | A mixed group re-priced on purpose | Storlekarna i "X" hade olika priser och har nu alla variantens pris. |
| Look page, on load | An image's read failed | Några bilder kunde inte hämtas just nu och visas inte. De finns kvar och ändras inte när du sparar. |
| Storefront links | The preview opened | Förhandsvisning öppnad – gäller i N minuter (the platform list's words) |
| Storefront links | The preview failed | Förhandsvisningen kunde inte öppnas. Försök igen. |

## Files

**New**
- `src/admin-app/providers/ordersForShop.js` and `ordersForShop.test.mjs`
- `src/admin-app/replacements/adminOrderDetailData.test.mjs`
- `src/admin-app/replacements/publishCopy.js` and `publishCopy.test.mjs`
- `src/pages/platform/publishCopy.js`
- `src/admin-app/adapters/storefrontLinks.js` and `storefrontLinks.test.mjs`
- `src/admin-app/replacements/storefrontLinks.js`
- `src/pages/admin/storefrontLinks.js`
- this report

**Admin-build layer**
- `src/admin-app/AdminApp.jsx`
- `src/admin-app/providers/Orders.jsx`
- `src/api/admin/orders.js`
- adapters: `src/admin-app/adapters/{product,content}.js` and their tests
- data replacements: `src/admin-app/replacements/{adminDashboardData,adminOrderDetailData,productFormData,adminCollectionEditData,adminStorefrontData,platformShopDetailData,platformShopsData,provisionShopData}.js`
- `src/admin-app/replacements/brandingImages.js`
- `src/admin-app/dev/content-dev.test.mjs`
- `vite.admin.config.js` (one alias row)

**Shared pages (minimal)**
- `src/pages/admin/{AdminOrderDetail,AdminStorefront,AdminPages,AdminPageEdit,AdminCollectionEdit}.jsx`
- `src/pages/platform/{PlatformShopDetail,PlatformShops}.jsx`
- `src/components/platform/ProvisionShopModal.jsx`

**The older build's data modules (same contract)**
- `src/pages/admin/adminOrderDetailData.js`
- `src/pages/platform/{platformShopDetailData,platformShopsData}.js`
- `src/components/platform/provisionShopData.js`

## Found and NOT fixed

1. **`AdminRoute` calls `toast.error` while rendering** when signed out. React warns "Cannot update a component while rendering AdminRoute". This is older shared code, not part of any finding.
2. **Middle-click on a storefront link of an unpublished shop** (`auxclick`, no `click`) opens the plain address, which is the not-found page. A ctrl- or cmd-click goes through the preview.
3. **The platform console's "Öppna storefront"** (FI, `platformStorefront.js`) still opens the plain address of an unpublished shop when the platform user has no acting-as grant. I left it unchanged.
4. **The older build has the same latent page-state flaws on a shop switch**: the list's error is not cleared, and the detail's `fetchAttempted` gate holds. The remount fix is the admin build's router only.
5. **The product form gives no warning BEFORE saving** that a group's sizes have different prices; the form shows one price. The save announces a deliberate re-price afterwards. A hint in the form would be a markup change.
6. **The collection's `held` baseline lives in one tab.** An edit of the same collection made elsewhere meanwhile is not detected (as before).
7. **Without `VITE_STOREFRONT_ORIGIN`** (a local dev build), the links are relative to the admin host, as FI already noted. The staging env file sets it.

## For the reviewer to decide

1. **The publication wording.** I proposed it, the words are Mikael's to veto, and "AVPUBLICERA" replaces "TA UR SÖK" in this build.
2. **The page remount on a shop change** (`AdminApp.jsx`) applies to EVERY admin page. Unsaved edits are dropped on "Byt butik". That is intended: it keeps a form of shop A from being saved into shop B. The alternative was per-page edits to the shared pages.
3. **A deliberate change of a mixed group's price unifies all its sizes**, announced after the save. The alternative, refusing such a save, was not taken because the brief prefers carrying the prices.
4. **An unread logo or image cannot be removed until its preview loads** (it is kept by design).
