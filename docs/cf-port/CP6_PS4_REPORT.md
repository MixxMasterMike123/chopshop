Model: claude-opus-5-5 (Opus 5.5)

# CP6-PS4: the seller and the storefront agree with the checkout's stand-in refusal; the console handles the printer's out-of-stock exception

Built on HEAD `e162f2c4`, branch `cf-port`, in the working tree only. No git write, nothing on the network beyond localhost, no wrangler command that reaches Cloudflare, no deploy. At the start `git status --short` was empty.

## Design (written before any code)

### Part A: where the switch has to reach

Since PS3, with `PRINT_CANVAS_ENABLED` = `"true"`, checkout refuses a POD line whose printer SKU's model is a stand-in (`capabilities.models[skus[sku].model].provisional === true`). The publish gate, the mapping write and the public predicate do not know it.

**The public predicate's callers** (`PUBLIC_ELIGIBILITY_PREDICATE`, `src/catalog/eligibility.ts`), counted in the code:

| Caller | SQL sites | Gets the switch how |
|---|---|---|
| `catalog/public-catalog.ts` (list, detail, POD previews, collections through it) | 3 | `eligibilityPredicate(tenant)` (preview.ts) |
| `storefront/seo.ts` | 6 | `eligibilityPredicate(tenant)` |
| `storefront/identity-projection.ts` (the storefront's product links) | 1 | `eligibilityPredicate(tenant)` |
| `storefront/sitemap.ts` | 3 | the constant itself |
| `commerce/checkout.ts` (line resolution) | 1 | the constant itself |
| `catalog/screening.ts` (D8 "other live products") | 1 | the constant itself |
| `platform/tenant-directory.ts` (the console's "Synliga") | 1 | the constant itself |

Ten of the sixteen already pick their fragment per request through `eligibilityPredicate(tenant)`, where `tenant` is what `resolveStorefrontTenant(env, request)` returns. That function has the env. So the smallest way to carry the switch is the way the preview already rides: **the storefront tenant carries a mark**, set once at that edge from `printCanvasEnabled(env)`, and `eligibilityPredicate` picks the fragment. The ten sites are not edited. The other sites get the boolean their callers already have or can read at their own edge: sitemap (3 sites, its route marks the tenant the same way) and checkout (1, `CheckoutOptions.refuseStandInFrames` from PS3). Screening's D8 count and the tenant directory stay as they are (decisions A5, A7). So four SQL sites are edited, not sixteen.

**The cached read path.** Every versioned public answer has `ETag: "<catalog_version>"`, `Cache-Control: no-cache`, and a 304 when `If-None-Match` names the version (`storefront/public-routes.ts versionedJsonResponse`). A printer edit that marks or unmarks a model as a stand-in is an `UPDATE printers`, and 0025's `catalog_version_printers_update` bumps every tenant that maps to that printer, so the data half of the new term is invalidated by construction. The SWITCH is an env var: flipping it bumps nothing, so a browser holding a body from before the flip would get a 304 and keep showing the product. To prove invalidation, the ETag must name the switch: with it on, `"<catalog_version>-c"`; off, `"<catalog_version>"`, byte for byte as today. `versionedJsonResponse` takes the request's tenant instead of its `preview` boolean, so each of its seven callers changes one argument. The POD preview image's ETag (its sha256) is answered only after the eligibility check, which carries the mark, so it needs nothing. The sitemap is `no-store` at the API; the web Worker caches its XML `max-age=3600`, which every eligibility change already lives with (a takedown too).

Count: four predicate sites and seven ETag arguments, each a one-line change, plus the selector. Within the brief's "roughly a dozen", and the cached path's invalidation is proven, so I build it.

**The SQL term** (appended to the predicate only when the switch is on; the constant itself stays byte-identical):

```sql
AND NOT EXISTS (
  SELECT 1 FROM pod_mappings AS stand_in_mapping
  INNER JOIN printers AS stand_in_printer ON stand_in_printer.id = stand_in_mapping.printer_id
  WHERE stand_in_mapping.tenant_id = product.tenant_id
    AND stand_in_mapping.product_id = product.product_id
    AND stand_in_mapping.status = 'active'
    AND json_type(stand_in_printer.capabilities_json, <the path of models[skus[sku].model].provisional>) = 'true')
```

A JSON path built from a stored value is a parse error in SQLite when the value holds `"` or `\` (`bad JSON path`), which would fail the whole storefront read. `pod_mappings.sku` has only a length CHECK, so the path is built only from a SKU (and a model name) made of the capability document's own key characters (`[A-Za-z0-9._-]`, which `parsePrinterCapabilities` enforces on every key), and is NULL otherwise: a key outside that set can never name an entry of a valid document, so the answer is the TS answer (not a stand-in). `json_type(…) = 'true'` is exactly `=== true`. I measured both shapes on a 320-SKU document with 1 800 mappings (SQLite 3.54): two path lookups cost 2.5 µs per mapping; two `json_each` scans cost about 87 µs. The term is evaluated only with the switch on.

### Part A decisions (conservative defaults, for Mikael)

| # | Decision | Alternative |
|---|---|---|
| A1 | **Whole product.** A POD product with ANY active mapping routed to a stand-in model is hidden, as one with any suspended mapping is. Checkout's line predicate carries the switch too, so a stale cart's other variant is refused with the product (stricter than PS3's per-line refusal, only while the switch is on). | Per variant: the public detail would have to drop such variants, and the list's facts (price-from, swatches) be recomputed without them. |
| A2 | **An existing published product is hidden, not suspended, not unpublished.** No data is written: it leaves the storefront while the switch is on, and comes back by itself when the switch goes off or the platform confirms the frames (a printer edit, which bumps catalog_version). Its next publish is refused. | Suspend its mappings: a data write that outlives the switch and must be undone by hand. Refuse only at the next write: leaves it on the storefront, every checkout 422. |
| A3 | **A mapping write onto a stand-in model is refused while the switch is on**, on a draft and a live product alike, code `pod_frame_unconfirmed` (422): the seller learns at the earliest write. Checked right after the SKU, before the slots, like the other printer-side refusals (`sku_unavailable`, `slot_not_printable`, `unpriced`), which also do not depend on the product being live. | Allow it on a draft and refuse at publish only (the seller can prepare a product for the day the frames are confirmed). |
| A4 | **Publish is refused with `pod_frame_unconfirmed`** (422) when any active mapping of the product routes to a stand-in model. The gate (`evaluatePodGate`) checks it LAST, after every other rule passed, so a caller that acts on only some codes (the mapping delete acts on `price_below_floor` / `pod_too_large`) never loses the floor check to an earlier return. Only publish passes the switch to the gate. | Check it first (the seller then hears the reason they cannot fix before the ones they can). |
| A5 | **Not changed:** the mapping delete, the price edit, the variant writes, the quotes (`quoteForProduct`, `designQuote`) and screening's D8 count. None of the writes routes anything onto a model, so none can newly hide a product under A1; the quotes are still true; the tenant printer view already marks stand-ins (`provisional`, `provisionalAreas`). D8 counts a product hidden only by the switch as live: no new one can be published while the switch is on (A4), and a screening verdict that changed with a deploy setting would make the same publish land `pending` or `approved` by environment. | Carry the switch into `designQuote` (the studio would learn before the design) and into screening (every writer that screens). |
| A6 | **The ETag names the switch** (`-c` suffix while on), on all seven versioned answers, also the two whose body does not depend on eligibility (pages, the collection list): one rule, and a flip costs each browser one full answer. | Only the four answers that depend on eligibility. |
| A7 | **The platform's "Synliga" count keeps the base predicate (not built; changed during the build, see the build log step 1).** Its counts are also answered by three write paths (`updateTenant`, publish/unpublish, close each return `readTenantDetail`), so carrying the switch there means about eight more edits for a platform display that decides nothing a buyer sees. While the switch is on it counts a product hidden only for its stand-in frame. | Carry it: `readTenantCounts` → `listTenants` (the query) and `readTenantDetail` → its three writers → their routes. |
| A8 | **Seller copy.** `podRefusalMessage("pod_frame_unconfirmed")` in English as its neighbours; the two admin maps (`adapters/product.js` publish refusals, `adapters/pod.js` mapping refusals) get one Swedish sentence each. The code is not masked (`TENANT_REFUSAL_CODES`): it says nothing about prices, and the tenant printer view already shows `provisional`. | A neutral code. |

**No money computation changes; no migration.**

### Part B: the console and the exception

What the Worker does (read in `production-status.ts`, `fulfilment.ts`, `print-jobs-platform.ts`, `print-job-list.ts`), and therefore what the page offers:

| Line | "Slut i lager…" (`{exception:"out_of_stock"}`) | "Stäng undantaget…" (`{exception:"resolved"}`) | state steps |
|---|---|---|---|
| no exception, accepted, open order, line not cancelled, state none / in_production | offered | no | as today |
| no exception, produced or shipped | no (`produced`) | no | as today |
| open exception (set, not resolved, not shipped) | no (a repeat is a no-op) | offered, also on a closed order (D5 of PS3) | only `shipped`, when accepted and open |
| exception, then shipped (restocked) | no | no (`produced`) | none |
| resolved | no | no | none (`exception_resolved`) |

The row shows an open exception as a red pill "Slut i lager hos tryckeriet" (the console's existing `bg-red-500/15 text-red-300`), a resolved one as the neutral pill with its time, and a restocked one as "Skickad" with a line that the printer had been out of stock. A new filter "Undantag" (Alla / Slut i lager, inte stängda / Inget undantag): the list's `exception=out_of_stock` includes resolved and restocked lines, so "inte stängda" asks `exception=out_of_stock` and leaves the closed ones out on the page, as the default view leaves the shipped out.

The confirm texts are written from the code (each sentence's source in the text table below). The lost answer is read back as for a state: stored → done; as it was → not saved; else unclear.

---

## Build log

1. **Part A, the Worker.**
   - `src/catalog/eligibility.ts`: `STAND_IN_FRAME_TERM` (with the `[A-Za-z0-9._-]` key guard on both JSON paths), `CANVAS_ELIGIBILITY_PREDICATE`, `publicEligibilityPredicate(hide)`. `PUBLIC_ELIGIBILITY_PREDICATE` unchanged.
   - `src/storefront/preview.ts`: `StorefrontTenant.hideStandInFrames`, `hidesStandInFrames`, `withPrintCanvas(env, tenant)` (the one reading of the switch for public reads), `resolveStorefrontTenant` marks, `PREVIEW_CANVAS_ELIGIBILITY_PREDICATE`, `eligibilityPredicate` picks among four.
   - `src/storefront/public-routes.ts`: `etagFor` names the switch; `versionedJsonResponse(…, tenant)`; its seven callers (`public-routes.ts`, `routes/public-products.ts` ×2, `routes/public-pages.ts` ×2, `routes/public-collections.ts` ×2) pass the tenant. `handlePublicCollectionRoute` answers the no-tenant 404 before the read instead of through the switch (same answer; needed for the type).
   - `src/storefront/sitemap.ts` (3 sites) and `src/routes/public-seo.ts` (the sitemap's tenant marked).
   - `src/commerce/checkout.ts`: `resolveLines`/`resolveLine` take the boolean.
   - `src/pod/printers.ts`: `isStandInSku`. `src/pod/pod-mappings.ts`: the code in `RefusalCode`/`PodGateFailure`, its `podRefusalMessage`, `evaluatePodGate`'s `refuseStandInFrames` (checked last, `routesToStandIn`), `createMapping`'s option (after the SKU check), `decideProductionLine` reads through `isStandInSku` (same expression).
   - `src/catalog/admin-catalog.ts`: `AdminRefusalCode`, `publishAdminProduct`'s option. `src/app.ts` and `src/routes/pod-admin.ts` pass `printCanvasEnabled(env)`; the mapping 422 carries the sentence for this code.
   - Changed during the build: the tenant directory is not carried (A7, above): it would have meant three more write paths.
   - Frontend seller copy: `src/admin-app/adapters/product.js` and `pod.js` gain `pod_frame_unconfirmed` (+ a test line each).
   - New `cloudflare/test/stand-in-frames-seller-storefront.test.ts` (17 tests); `test/printers-platform.test.ts` walks the new sentence.
   - Gates: `tsc` clean; the new file 17/17; `pod-publish`, `checkout-stand-in-frames`, `storefront-preview`, `public-catalog`, `admin-products`, `printers-platform`, `pod-mappings`: 7 files / 202 tests; `pod.test.mjs` + `product.test.mjs` 57/57.
2. **Part B, the console.**
   - `src/admin-app/adapters/printJobs.js`: `exceptionState`, `nextStates` (only `shipped` while open, nothing after a resolution), `EXCEPTION_ACTIONS`, `exceptionActions`, `offersAction`, `actionBlockText` (a resolved line says itself), the `exception` filter (`EXCEPTION_FILTERS`, `listParams`, `keepsJob`), `sameJobFacts` with the two keys, `actionBody`, `statusHolds` for the two bodies, `exceptionConfirm` / `actionConfirm`, `exceptionText`, `actionMovedText`, `actionGoneText`, `exceptionDoneText` / `actionDoneText`, `actionToastText`, the four reasons and `produced` per body in `statusRefusalText(error, body)`.
   - `src/admin-app/pages/new/printJobsData.js`: the refusal gets the body; a lost answer compares the facts the body would move; the answer's job carries the two keys.
   - `src/admin-app/pages/new/PlatformPrintJobs.jsx`: the filter "Undantag", the pills and the row's line, the two buttons, one confirm path for every action.
   - `src/api/admin/platform.js`: `listPrintJobs` passes `exception`; the header's contract.
   - Dev: `src/admin-app/dev/fp-dev.mjs` (the two keys on a row, the filter, the two bodies, the Worker's decision order, the auto-ship after a resolution) and four new fixture orders (1051 open with its other line shipped, 1052 restocked, 1053 resolved, 2002 open on a cancelled order).
   - Tests: `adapters/printJobs.test.mjs` (+12), `pages/new/fpData.test.mjs` (+4), `dev/fp-dev.test.mjs` (+2), `src/api/admin/fp-calls.test.mjs` (+1 assertion). Existing assertions changed for the new shapes only (listed under "Existing tests changed").
   - Gates: the frontend command 1034/1034; the admin build built.
3. **Looked at it rendered** (dev server on 127.0.0.1:5297, the dev API, Playwright's headless Chromium, dark scheme). Two texts were untrue and are fixed: an open exception on a cancelled order said "Ordern hålls kvar…" (nothing holds a closed order), and the close confirm on a closed order said the shop could then ship it (`order_closed`). Both now say only what is true; a test pins each. Shots retaken on a fresh dev server after the fix.
4. **Tests that were missing, found while planning the mutations.** An inactive mapping on a stand-in model (the SQL term's `status = 'active'` and the TS twin's filter), the read-back of a lost exception body on the facts it moves, a closed exception on a cancelled order. Added (`stand-in-frames-seller-storefront.test.ts` now 18 tests).
5. **Mutations.** 47 mutations, run by a scratch script (copy aside, one exact replacement asserted to match once, the named test files, restore with `cp`, prove with `cmp`). The first run caught 46. A5 (the model path's key guard removed) survived. A probe in D1 showed why: SQLite parses a JSON path lazily, so a stray quote is a parse error only once the part before it named a key that exists. `$.models."x"y".provisional` is NULL with no error, because there is no model `x`, while `$.models."2000"x".provisional` is an error. The test's model name became `2000"x`. A5 is caught, and every file was restored `cmp`-identical (`git status` shows the same 31 entries before and after each run). The probe was a temporary test file, deleted at once.
6. **Final gates** on the tree as delivered (below). One full `vitest run` of four had 1 failed test that I did not capture. The three runs after it are 119 / 4663 each, and my new file with its two neighbours passed five runs in a row (57/57 each). See "Seen, outside scope" 5.

---

## What was built

### Part A: the seller and the storefront agree with the checkout (Worker)

All of it applies only while `PRINT_CANVAS_ENABLED` is exactly `"true"`. Off or unset (production today), every answer is what it was: `PUBLIC_ELIGIBILITY_PREDICATE` is the same constant, an unmarked tenant reads it, `withPrintCanvas` returns the very tenant object, the ETag is `"<catalog_version>"`, and the publish gate and the mapping write take their old paths. The new file proves it per route for `undefined`, `"false"`, `"TRUE"`, `" true"` and `"1"`, byte for byte. Every existing suite runs with `"false"` and passes unchanged.

- **The storefront does not offer it.** A POD product with any ACTIVE mapping whose printer SKU's model is a stand-in leaves:
  - the product list and detail, the collection, the storefront's product links, the SEO answer, the POD previews and the sitemap;
  - checkout's line resolution, so its other units are refused too.
  
  It comes back by itself when the switch goes off, or when the platform confirms the frames. The printer edit that confirms them bumps `catalog_version` (0025's trigger), so the ETag changes. A preview reads the same term.
- **The cached path.** The ETag names the switch: `"<v>"` off, `"<v>-c"` on. A body kept from before a flip is answered in full in both directions, and a 304 is given only on the current tag (tested on all seven versioned answers).
- **The seller is told: `pod_frame_unconfirmed`, 422.**
  - Publish (`POST /v1/admin/products/:id/publish`): refused when any active mapping routes to a stand-in. The gate checks it last, so a price under the floor is named first.
  - Mapping write (`POST /v1/admin/pod/mappings`): refused for a stand-in SKU, on a draft and a live product alike, with the sentence `podRefusalMessage("pod_frame_unconfirmed")`.
  - Mapping delete: never passes the switch, so a stand-in mapping can always be removed.
  - The admin shows its own Swedish sentence for the code (below).
- **One reading of the flag.** In code it is `isStandInSku` (`src/pod/printers.ts`, now also used by `decideProductionLine`); in SQL it is `STAND_IN_FRAME_TERM`. The SQL builds its two JSON paths only from keys made of the capability key characters, so a stored SKU or model name with a quote or a backslash never fails a read. Both cases are tested with names that would otherwise be parse errors.
- **No money computation changed. No migration** (next free number still 0055).

### Part B: the console handles the out-of-stock exception (frontend)

- **The row.**
  - An open exception gets the red pill "Slut i lager hos tryckeriet" and a line saying the order is held. On a closed order the line only says it is out of stock, and the existing "Ordern är avbruten…" follows.
  - A resolved one gets the neutral pill "Undantag stängt" and "Undantaget stängdes {tid}: tryckeriet skickar inte raden."
  - A restocked one keeps its "Skickad" pill and adds "Tryckeriet hade plagget slut i lager men har skickat raden."
- **The filter "Undantag":** Alla / Slut i lager, inte stängda (asked as `exception=out_of_stock`, the closed ones left out on the page) / Inget undantag (`exception=none`).
- **The two actions,** "Slut i lager…" and "Stäng undantaget…". Each opens the console's confirm, is re-read when the confirm opens and again at the click, sends exactly `{ exception }`, and has a lost answer read back as a state's is.
- **What is offered** follows the Worker's decision (`decideProductionStatus`):
  - record: on an accepted line of an open order, in no state or `in_production`, with no exception yet;
  - close: on an open exception, on any order (a closed one too);
  - while open: only "Skickad…";
  - after a resolution: nothing.
- **Refusals:** each of the four new reasons has its own sentence, and `produced` has one per body (it answers both).
- **The dev API** carries the keys, the filter, the bodies, the Worker's refusal order and the auto-ship after a close. New fixture orders: 1051 (open; its other line shipped, so closing it ships the order), 1052 (restocked), 1053 (closed), 2002 (open on a cancelled order).

## Decisions (Part A: A1–A8 in the design above; Part B here), for Mikael

| # | Decision taken | Alternative |
|---|---|---|
| B1 | The default view ("Inte skickade", "Mottagna av tryckeriet") still lists a resolved line: it is not shipped, and its pill and line say it is closed. | Leave resolved lines out of the default queue (they need nothing more). |
| B2 | The filter has three values. A resolved or restocked line shows under "Alla", with no value of its own. | A fourth value "Slut i lager, alla". |
| B3 | The close confirm uses the console's danger tone (the line is given up, for good). Recording uses the primary tone, as the state steps do. | Primary for both. |
| B4 | A lost answer of an exception body reuses the state's two failure sentences ("…statusen sparades inte…", "…oklart om statusen sparades…"). Only the done line after a read-back says "ändringen". | Their own wording. |
| B5 | "I butikens order står raden som misslyckad" says what the shop's order data holds (`podState: "failed"`). The seller's admin does not render `podState` today. | Leave the sentence out until it does. |
| B6 | The record button is the quiet one; the close button is the row's quiet-then-red one (`btnRowDanger`, from PlatformUsers). | Both quiet. |

## Deviations from the brief

1. **The platform's "Synliga" count is not carried** (A7). Carrying it means threading the switch through three write paths of the tenant directory. That would push the change past the brief's "roughly a dozen" for a display that decides nothing a buyer sees. While the switch is on it overcounts by the products hidden only for a stand-in frame. Proposed as a follow-up (below).
2. **Screening's D8 count keeps the base predicate** (A5).
3. **Seller copy in the admin.** The brief's Part A is Worker work, but "so the admin can say…" needs the Swedish sentence, so `src/admin-app/adapters/product.js` and `pod.js` each gain one entry.
4. **Checkout refuses the whole product while the switch is on** (A1). This is stricter than PS3's per-line refusal, so that "nothing hidden from the storefront is purchasable" still holds.
5. **`handlePublicCollectionRoute`** now answers the no-tenant 404 before the read rather than inside its switch. Same answer; it was needed so the tenant reaches `versionedJsonResponse` typed non-null.
6. **The page's subtitle** gained "eller att plagget är slut i lager".
7. **`vite.admin.config.js` is unchanged** (no alias was needed: the page is the admin build's own).

## Every new or changed text (Swedish copy, and the one English refusal)

Sources: `ps` = `cloudflare/src/dispatch/production-status.ts`, `fu` = `cloudflare/src/commerce/fulfilment.ts`, `0054` = `cloudflare/migrations/0054_printer_exception.sql`, `ao` = `cloudflare/src/commerce/admin-orders.ts`.

| Where | Text | Shown when | Source of the claim |
|---|---|---|---|
| Worker, `podRefusalMessage` | The printer has not confirmed the print area for this garment yet, so it cannot be sold now. Choose another garment, or try again once the printer has confirmed it. | 422 `pod_frame_unconfirmed` (publish, mapping write) | A3, A4 |
| Admin product, publish refusal | Tryckeriet har inte bekräftat tryckytan för plagget än, så produkten kan inte publiceras just nu. Den kan publiceras när tryckeriet har bekräftat tryckytan. | publish answers `pod_frame_unconfirmed` | A4 |
| Admin POD, mapping refusal | Tryckeriet har inte bekräftat tryckytan för det här plagget än, så det kan inte kopplas just nu. Välj ett annat plagg, eller försök igen när tryckeriet har bekräftat tryckytan. | a mapping write answers it | A3 |
| Page subtitle | …När tryckeriets mejl säger att ett jobb är i produktion, producerat eller skickat, eller att plagget är slut i lager, rapporterar du det här. | always | the two new bodies |
| Filter | Undantag · Alla · Slut i lager, inte stängda · Inget undantag | always | `print-job-list.ts` filter (closed ones left out on the page) |
| Pill | Slut i lager hos tryckeriet | open exception | `ps` header |
| Pill | Undantag stängt | resolved | `ps` header |
| Row | Tryckeriet har meddelat att plagget är slut i lager. Ordern hålls kvar tills raden skickas eller undantaget stängs. | open, order not cancelled/refunded | `fu` `unsentPodLinesSql` (open exception counts) |
| Row | Tryckeriet har meddelat att plagget är slut i lager. | open, order cancelled or refunded | `fu` `order_closed` (nothing to hold) |
| Row | Tryckeriet hade plagget slut i lager men har skickat raden. | exception, then shipped | `ps` decide: shipped allowed while open |
| Row | Undantaget stängdes {tid}: tryckeriet skickar inte raden. ("Undantaget stängdes: …" without a readable time) | resolved | `ps` header, 0054 |
| Buttons | Slut i lager… · Stäng undantaget… | per the offer table | `ps` `decideProductionStatus` |
| Record confirm, title | Rapportera "slut i lager" för order {n}, rad {l}? | record | |
| Record confirm | Tryckeriet har tagit emot jobbet men meddelar att plagget är slut i lager. Det sparas på raden och kan inte tas bort efteråt. | record | 0054 `exception_once` (never changed or cleared) |
| Record confirm | Ordern hålls kvar: butiken kan inte markera den som skickad eller klar att hämta, och den markeras inte som skickad av sig själv, förrän raden är skickad eller undantaget är stängt. | record | `fu` `printer_ships`, `unsentPodLinesSql`, `printerShippedOrderStatements` |
| Record confirm | I butikens order står raden som misslyckad, utan någon orsak. | record | `ao` `POD_STATE_SQL` → `failed` (decision B5) |
| Record confirm | Ett larm skapas för plattformen, ett per rad. | record | `ps` alert, id `print-job-out-of-stock:{jobId}` |
| Record confirm | Inga pengar flyttas, och köparen får inget mejl. | record | `ps` header "NO MONEY MOVES"; no mail statement in that batch |
| Record confirm | Därefter kan raden bara rapporteras som skickad (om tryckeriet får in plagget och skickar det), eller så stänger du undantaget. | record | `ps` `out_of_stock` refusal |
| Both confirms | Ändringen loggas med ditt konto och tidpunkten. | always | `ps` audit `print_job.exception` / `…_resolved` |
| Record confirm, button | Rapportera slut i lager | | |
| Close confirm, title | Stäng undantaget för order {n}, rad {l}? | close | |
| Close confirm | Gör det bara när tryckeriet inte kommer att skicka raden, och köparen och butiken redan har fått det utrett för hand (till exempel med en återbetalning av raden). | close | `ps` header ("the buyer refunded and the shop settled by hand"), PS3 "What a human must do" |
| Close confirm | Raden skickas inte, och ingen status kan rapporteras på den efteråt. Det går inte att ångra. | close | `ps` `exception_resolved`; 0054 `resolved_once`, `production` triggers |
| Close confirm | Raden håller inte längre kvar ordern: butiken kan markera ordern som skickad eller klar att hämta när de andra tryckraderna är skickade. | close, open order | `fu` `unsentPodLinesSql` resolved clause |
| Close confirm | Är det här den sista oskickade raden i en order där alla rader trycks och skickas med paket till köparen, och en annan rad redan är skickad, markeras hela ordern som skickad direkt, och köparen får ett mejl om att den är skickad. | close, open order | `fu` `printerShippedOrderStatements` (parcel, all printer lines, one shipped, none unsent, open, unfulfilled/processing); the route nudges the mail |
| Close confirm | Ordern är avbruten / återbetald, så ingenting mer händer med den, och inget mejl skickas. | close, cancelled / refunded order | `fu` `openSql` in the auto-ship's guard |
| Close confirm | Inga pengar flyttas av det här. Larmet om slut i lager stängs inte heller: det stängs för sig. | close | `ps` (no money); PS3 D7 (the alert is not resolved by the resolution) |
| Close confirm, button | Stäng undantaget | | |
| Done | Order {n}, rad {l}: slut i lager är rapporterat. Ordern hålls kvar tills raden skickas eller undantaget stängs. | record changed | |
| Done | Order {n}, rad {l}: slut i lager var redan rapporterat; ingenting ändrades. | record repeat (200 `changed: false`) | `ps` `unchanged` |
| Done | Order {n}, rad {l}: slut i lager är rapporterat. Svaret kom aldrig fram, men ändringen är sparad. | record, lost answer, stored | |
| Done | Order {n}, rad {l}: undantaget är stängt, och raden skickas inte. (+ " Hela ordern är nu markerad som skickad, och köparen får ett mejl om det." when `orderShipped`) | close changed | `ps` `orderShipped` |
| Done | Order {n}, rad {l}: undantaget var redan stängt; ingenting ändrades. | close repeat | `ps` `unchanged` |
| Done | Order {n}, rad {l}: undantaget är stängt. Svaret kom aldrig fram, men ändringen är sparad. Om hela ordern därmed markerades som skickad kunde inte läsas här. | close, lost answer, stored | |
| Toast | Slut i lager är rapporterat. · Undantaget är stängt. · Undantaget är stängt och ordern är skickad. | after the answer | |
| Moved before the confirm | Order {n}, rad {l} har ändrats sedan listan lästes, och slut i lager kan inte rapporteras nu. Raden visar läget. · …, och undantaget kan inte stängas nu. Raden visar läget. | the action is no longer offered when read | |
| Moved under the confirm | Tryckjobbet ändrades medan rutan var öppen, och ändringen kan inte göras nu. Ingenting skickades; raden visar läget. | an exception action, the job moved | |
| Refusal `out_of_stock` | Tryckeriet har rapporterat slut i lager för raden: nu kan den bara rapporteras som skickad, eller så stänger du undantaget. | 409 reason | `ps` |
| Refusal `exception_resolved` | Undantaget för raden är stängt: raden skickas inte, och ingen status kan rapporteras. | 409 reason | `ps` |
| Refusal `no_exception` | Tryckeriet har inte rapporterat slut i lager för raden, så det finns inget undantag att stänga. | 409 reason | `ps` |
| Refusal `produced`, record | Raden är redan producerad eller skickad, så plagget fanns i lager: slut i lager kan inte rapporteras. | 409 `produced` to `{exception:"out_of_stock"}` | `ps` ("Produced = printed on the blank: it was in stock") |
| Refusal `produced`, close | Raden är redan skickad, så det finns inget undantag att stänga. | 409 `produced` to `{exception:"resolved"}` | `ps` ("Restocked and sent: nothing left to close") |

No new text has an em dash or an exclamation mark (grepped).

## Files

| File | |
|---|---|
| `cloudflare/src/catalog/eligibility.ts` | the stand-in term, `CANVAS_ELIGIBILITY_PREDICATE`, `publicEligibilityPredicate`; header |
| `cloudflare/src/storefront/preview.ts` | the tenant mark, `withPrintCanvas`, `hidesStandInFrames`, the preview's canvas fragment, the selector |
| `cloudflare/src/storefront/public-routes.ts` | the ETag names the switch; `versionedJsonResponse(…, tenant)` |
| `cloudflare/src/routes/public-products.ts`, `public-pages.ts`, `public-collections.ts` | pass the tenant (7 calls); the collection route's early 404 |
| `cloudflare/src/storefront/sitemap.ts`, `cloudflare/src/routes/public-seo.ts` | the sitemap's predicate; its route marks the tenant |
| `cloudflare/src/commerce/checkout.ts` | the line predicate carries the switch |
| `cloudflare/src/pod/printers.ts` | `isStandInSku` |
| `cloudflare/src/pod/pod-mappings.ts` | the code, its sentence, the gate's option (checked last), the mapping write's option; `decideProductionLine` through `isStandInSku` |
| `cloudflare/src/catalog/admin-catalog.ts` | `AdminRefusalCode`, `publishAdminProduct`'s option |
| `cloudflare/src/app.ts`, `cloudflare/src/routes/pod-admin.ts` | pass `printCanvasEnabled(env)`; the mapping 422's sentence |
| `cloudflare/test/stand-in-frames-seller-storefront.test.ts` | new, 18 tests |
| `cloudflare/test/printers-platform.test.ts` | one code added to the neutral-text walk |
| `src/admin-app/adapters/printJobs.js` (+ test) | the exception's rules and texts |
| `src/admin-app/pages/new/printJobsData.js`, `PlatformPrintJobs.jsx` (+ `fpData.test.mjs`) | the data and the page |
| `src/api/admin/platform.js` (+ `fp-calls.test.mjs`) | `exception` on the list call; its contract |
| `src/admin-app/dev/fp-dev.mjs`, `print-jobs-fixtures.json` (+ `fp-dev.test.mjs`) | the dev API and four fixture orders |
| `src/admin-app/adapters/product.js`, `pod.js` (+ tests) | the seller's two sentences |
| `docs/cf-port/CP6_PS4_REPORT.md` | this report |

### Existing tests changed (the only ones)

- `cloudflare/test/printers-platform.test.ts`: `pod_frame_unconfirmed` added to the list of sentences walked for leaks.
- `src/admin-app/adapters/printJobs.test.mjs`: the two `listParams` expectations gain `exception: undefined` (the new key).
- `src/admin-app/pages/new/fpData.test.mjs`, adjusted for the four new fixture orders and the row's two keys:
  - the default view's job list gains 1051-1, 1053-1 and 2002-1;
  - the row's key set gains `exception` and `exceptionResolvedAt`;
  - the "shipped" filter gains 1051 and 1052;
  - shop C's list gains 2002.
- No assertion of behaviour changed.

## Tests

- **`stand-in-frames-seller-storefront.test.ts` (18).**
  - The fragments: off is the constant itself; the four selector cases; the preview's derivation; the switch read exactly; `isStandInSku`.
  - Off is byte-identical on ten public paths for five off values.
  - On, the product leaves the list, the detail, the collection, the sitemap, SEO and the previews.
  - The whole product: a variant's stand-in mapping hides it, and checkout refuses its base unit (on) but sells it (off).
  - Only active mappings count (the SQL term and the gate).
  - It comes back: frames confirmed (a new `catalog_version`) or the switch off.
  - A preview reads the term.
  - The ETag on all seven versioned answers, in both flip directions.
  - Seller side:
    - the mapping write is refused on a draft and a live product, allowed with real frames or with the switch off;
    - the mapping route answers 422 with the sentence and reads the switch exactly;
    - publish is refused through the route and published with every off value;
    - the gate's order (floor first);
    - the delete is always possible;
    - the sentence names no price.
  - The SQL key guards, on a SKU and on a model name that would otherwise be parse errors.
- **`printJobs.test.mjs` (+12).** Exception state; state steps; the record and close offers, each rule; the row's lines (open, closed order, restocked, resolved); the filter; bodies and read-back; both confirms (open and closed order); done texts, toasts, moved texts; each new refusal and `produced` per body.
- **`fpData.test.mjs` (+4), end to end against the dev API:**
  - the filter's URL and rows;
  - record → only "skickad" or close, plus the refusals in words;
  - close ships the last line's order; nothing after; a cancelled order is only noted; restocked is refused;
  - a lost answer: done, not done (also when the state moved meanwhile), unclear.
- **`fp-dev.test.mjs` (+2).** The dev rows' shapes, filter and refusal order.

## Mutations (47; every one caught; every file restored and `cmp`-identical)

The Worker rows ran `stand-in-frames-seller-storefront.test.ts`; A13 also ran `pod-publish`, A26 also `checkout-stand-in-frames`. The frontend rows ran `printJobs.test.mjs` + `fpData.test.mjs` (A27/A28: the adapter's own test; B18: also `fp-calls.test.mjs`).

| # | Mutation | Result |
|---|---|---|
| A1 | the stand-in term neutralised | 4 failed |
| A2 | the selector ignores the switch | 4 failed |
| A3 | the selector always on (off not byte-identical) | 5 failed |
| A4 | no key guard on the SKU path | 1 failed |
| A5 | no key guard on the model path | 1 failed (survived first; the test's model name fixed, build log 5) |
| A6 | an inactive mapping counts (SQL) | 1 failed |
| A7 | the term not correlated to the product | 5 failed |
| A8 | a preview ignores the mark | 2 failed |
| A9 | the edge never marks | 5 failed |
| A10 | any value of the switch is on | 4 failed |
| A11 | `resolveStorefrontTenant` does not mark | 4 failed |
| A12 | the ETag ignores the switch | 1 failed |
| A13 | the ETag suffix always | 3 failed |
| A14 | the sitemap ignores the mark | 1 failed |
| A15 | the sitemap route does not mark | 1 failed |
| A16 | checkout's line predicate ignores the switch | 1 failed |
| A17 | the gate never refuses | 2 failed |
| A18 | the gate checks the stand-in first | 1 failed |
| A19 | the gate ignores its option | 3 failed |
| A20 | the gate counts an inactive mapping | 1 failed |
| A21 | the mapping write never refuses | 2 failed |
| A22 | the mapping write ignores its option | 3 failed |
| A23 | the mapping route never passes the switch | 1 failed |
| A24 | the publish route never passes the switch | 1 failed |
| A25 | the mapping 422 without the seller's sentence | 1 failed |
| A26 | `isStandInSku` never true | 7 failed |
| A27 | the admin's publish copy missing | 1 failed |
| A28 | the admin's mapping copy missing | 1 failed |
| B1 | an open exception lets every state through | 3 failed |
| B2 | a resolved one lets states through | 2 failed |
| B3 | record offered on a produced or shipped line | 1 failed |
| B4 | record offered on a cancelled or refunded order | 1 failed |
| B5 | record offered before the printer accepted | 1 failed |
| B6 | close not offered on a closed order | 1 failed |
| B7 | a restocked line read as open | 6 failed |
| B8 | the open-exception filter keeps everything | 2 failed |
| B9 | the list is not asked for exceptions | 2 failed |
| B10 | a lost close always read as stored | 1 failed |
| B11 | the confirm blind to the exception facts | 1 failed |
| B12 | `produced` not told per body | 3 failed |
| B13 | a new reason falls to the generic sentence | 2 failed |
| B14 | the close confirm promises the mail on a closed order | 1 failed |
| B15 | a closed order said to be held | 1 failed |
| B16 | a lost exception compared on its state | 1 failed |
| B17 | the answer's exception keys dropped | 2 failed |
| B18 | the client drops the filter | 2 failed |
| B19 | a closed exception also told that the order is closed | 1 failed |

## Looked at it rendered

Admin dev server on `127.0.0.1:5297` (the dev API, no network), signed in as `platform@example.com`, Playwright's headless Chromium, dark scheme. The shots are in `/private/tmp/claude-501/-Users-mikaelohlen-Cursor-Apps-chopshop/bce9eb03-d6ce-4e8b-86eb-75f7384f31ac/scratchpad/ps4-shots/`:

| Shot | What |
|---|---|
| `ps4-printjobs-1440.png` | the default view: open (red pill), closed (neutral pill), the two buttons, a cancelled order's open exception |
| `ps4-filter-open-1440.png` | "Slut i lager, inte stängda": 1051-1 and 2002-1 only |
| `ps4-all-states-1440.png` | "Alla" states: the restocked 1052 ("Skickad" and its line) |
| `ps4-confirm-record-1440.png` | the record confirm |
| `ps4-recorded-1440.png` | after it: the row's pill, only "Skickad…" and "Stäng undantaget…" |
| `ps4-confirm-resolve-1440.png` | the close confirm on an open order |
| `ps4-resolved-order-shipped-1440.png` | after it: "…Hela ordern är nu markerad som skickad…" |
| `ps4-confirm-resolve-cancelled-1440.png` | the close confirm on a cancelled order |
| `ps4-lost-readback-1440.png` | a lost answer read back: "…Svaret kom aldrig fram, men ändringen är sparad." |
| `ps4-moved-under-confirm-1440.png` | the job moved under the open confirm: nothing sent, the amber notice |
| `ps4-printjobs-375.png` | 375 px: rows wrap, five filters stack; `scrollWidth` 375 |
| `ps4-confirm-resolve-375.png` | the close confirm at 375 (cancelled order) |

Only the console's existing classes are used: the pills (`pillCls` with the shops page's red and the neutral grey), `btnQuiet`, `btnRowDanger`, `ConfirmDialog` with its two tones, `noticeCls`, and the grid's fifth column. Console output: React Router's future-flag warnings and the login page's one 401 before sign-in, both there before this unit. In a full-page shot the sidebar does not stretch past the first viewport; that is the layout's own fixed sidebar, unchanged.

## Gates (final, on the tree as delivered)

- `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`: clean (exit 0).
- `cd cloudflare && npx vitest run`: **Test Files 119 passed (119), Tests 4663 passed (4663)**. Baseline 118 / 4645: +1 file, +18 tests. The two known `Network connection lost` lines print. One earlier run of four had 1 failed test; see "Seen, outside scope" 5.
- `cd cloudflare && npm run types:check`: "Types at worker-configuration.d.ts are up to date."
- `node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs`: **tests 1034, pass 1034, fail 0**. Baseline 1017: +17.
- `npx vite build --config vite.admin.config.js` ✓ built; `node cloudflare/admin/check-admin-build.mjs`: "admin build: 28 files (22 text) checked, no [old-backend] code, no source map, no secret, every file servable." The admin bundle holds the page and none of the dev data (`admin_dev_fp`, the new fixture references): grepped, 0 hits.
- `npx vite build` ✓ built; `node cloudflare/web/check-storefront-build.mjs`: "storefront build: 11 files (7 text) checked, no [old-backend] code, every file servable."
- `node guard/guards.test.mjs`: **guard: PASS** (baseline 294, unchanged). My two new files are untracked, so I grepped them and every added line for the three families: 0 matches.
- `node --test "scripts/cf-port/migrate/test/*.test.mjs"`: **tests 554, pass 554, fail 0**.

(In the two check lines, "[old-backend]" stands for the old backend's name, which the guard forbids in this file.)

## Reviewer wiring

- **Staging changes behaviour,** because `PRINT_CANVAS_ENABLED` is `"true"` there. Any product on the fake printer's stand-in models leaves the staging storefront at once, and publishing or mapping onto those models answers 422 `pod_frame_unconfirmed`. Production is unchanged until the switch is set there.
- **No migration, no configuration, no `scripts/`, `guard/` or `render/` change.** The next free migration number is still 0055.
- **Smoke on staging** (after a deploy):
  1. `GET /_api/v1/products` on a shop with a stand-in-model product: the product is absent, and the ETag ends in `-c"`.
  2. Publishing such a product from the admin: the Swedish sentence.
  3. `/platform/print-jobs`: the "Undantag" filter. Record on an accepted line, then close it.

## Follow-ups (not built), proposed

1. **The platform's "Synliga" count with the switch** (A7). Thread a boolean through `readTenantCounts`, `listTenants` (in the query) and `readTenantDetail`, its three writers (`updateTenant`, publish/unpublish, close) and their routes in `platform-tenants.ts`. About eight edits, no SQL change beyond `publicEligibilityPredicate(hide)`.
2. **The studio's design quote** could refuse a stand-in SKU too (A5), and the seller's printer list already marks `provisional`. Then the studio would say so before a design is made. That is a frontend change in the studio, plus `designQuote`'s option.
3. **The seller's product list** shows a stand-in-hidden product as published. It could carry a "not visible: the print area is not confirmed" mark, which needs a seller-facing read of the predicate per product.

## Seen, outside scope (not fixed)

1. **The predicate and `toPrinter` disagree on an invalid capability document** (pre-existing). The predicate shows a product whose printer row does not parse (it asks only that the printer is active), while checkout refuses it (`toPrinter` → null). Every writer validates, so it cannot happen through the routes.
2. **SQLite parses a JSON path lazily** (build log 5). Only the new term builds paths from stored values, and it is guarded. Other `json_extract` calls in `src/` use fixed paths (grepped).
3. **The web Worker caches the sitemap XML for an hour** (`cloudflare/web/src/index.ts`, `max-age=3600`). A switch flip, like any eligibility change (a takedown too), reaches the sitemap within the hour. The storefront's own reads revalidate every time.
4. **The seller's admin does not render `podState`** (`adapters/order.js` passes it through, and nothing shows it). So a line's `failed` is invisible to the seller today, which decision B5's sentence takes into account.
5. **One intermittent failure in a full `vitest run`.** On the run right after the last test edit, 1 of 4663 tests failed and I did not keep the output. The next three full runs were 4663/4663. My new file plus `checkout-stand-in-frames` and `printers-platform` passed five consecutive runs (57/57). I cannot say which test it was. The two known "Network connection lost" lines print on every run, and it may be related to them.

## Unfinished

Nothing in the brief is left unbuilt, except that the platform's "Synliga" count is deliberately not carried (deviation 1, follow-up 1).
