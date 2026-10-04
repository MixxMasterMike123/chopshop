Model: claude-opus-5-5 (Opus 5.5)

# CP5-FN1: the design studio's data layer in the admin build (loaders, quote, publish)

Built in the working tree on `cf-port` (HEAD `464b6af8`). No git command that writes, no network (localhost only), no wrangler, no deploy. The older build's dev server was not started. I did not touch `cloudflare/**` (unit WE's changes there are not mine).

`/admin/pod`'s Studio tab is now the real design studio in the admin build. FM's "kommer snart" stand-in is gone: its alias row is removed and `src/admin-app/replacements/podStudio.jsx` is deleted.

## (a) What leaves or changes, control by control (admin build only; the older build keeps every one)

The Worker's model forces these. Each one is a data-module flag or text (`STUDIO_FLAGS` / `STUDIO_TEXT` in `podStudioData.js`, `PANEL_TEXT` / `SERVER_PRICED` in `podPublishPanelData.js`). The older modules answer the older behaviour, so the older build renders exactly as before.

| Where | Control / text | In this build | Why |
|---|---|---|---|
| Step 1 · Plagg | **New: "Tryckeri och plagg" select** | Shown only when more than one (printer, model) makes the chosen garment. The first model with a frame is preselected. | A mapping names its printer AND article. The platform's default printer is not the seller's to read (D52). Seen rendered with a temporarily added second model (`step1-production-choice-1440`). The dev fixtures have one model per garment, so it is not shown there. |
| Step 1 | Garment cards | A garment no usable printer makes is never offered, even when the shop has no printer at all (the older studio offered every template before any printer existed). | `STUDIO_FLAGS.offerUnrouted: false`. With no printer, step 1 says "Inga plagg kan tillverkas just nu — inget tryckeri är kopplat." |
| Step 2 · Tryckytor | Slot cards | The frames are the chosen printer model's (e.g. "Yta upp till 25 × 35 cm"); a slot the model cannot print is gone. | `GET /v1/admin/pod/printers` model frames → `applyPrinterAreas`, the same code as before. |
| Step 4 · Placering | Drag, resize, the cm fields | **Leave**: the canvas is locked to the contain-fit placement (as the pocket always was). | A Worker mapping stores no placement. The server sizes each slot itself (`pod-mappings.ts sizeSlot`: contain-fit in the frame, capped at the DPI floor). The studio now shows exactly that size: the dev API's stored front 250×250 mm equals the studio's 25 × 25 cm. Anything else would be a print surprise. |
| Step 4 | Intro text | "Motivet trycks så stort som tryckytan och originalets upplösning tillåter, centrerat i ytan. Så här blir trycket — placeringen kan inte ändras här." | Same reason. |
| Step 4 | The line under the locked canvas | "Tryckeriet trycker motivet så stort som tryckytan och originalets upplösning tillåter, centrerat. Måtten ovan är trycket." | The older line ("Välj position ovan") is the pocket's. New prop `lockedNote` on `CompositorCanvas.jsx` (default = the older text). |
| Step 4 (pocket) | "Fickposition: Vänster / Mitten / Höger" | **Leave**. The pocket stays at "Vänster" (the default), and the note says it prints on the printer's left-chest spot. | A mapping stores no pocket position. The Worker's pocket frame is a spot inside the front (`printers.ts slotFrame`). |
| Step 6 · Godkänn | Strip previews | Locked contain placement for every slot. | As step 4. |
| Step 7 · Mockuper | 3D view (beta) | **Leaves** until FN2. In its place: "3D-vyn finns inte i den här versionen av adminen ännu." | `STUDIO_FLAGS.studio3d: false`. |
| Step 7 | Mockup upload to storage | Mockups are rendered and downloadable as before, but not stored. No "kunde inte sparas" warning is given, because nothing is attempted. | FN2. |
| Step 8 · Publicera | Green note | "Tryckkoppling ingår. Varje färg och storlek kopplas till tryckeriets artikel du väljer nedan, med motivet på de valda tryckytorna, och trycket följer med till tryckeriet vid beställning." | The older text promises the placement and "Printkön" (the print portal, PORT-LATER). |
| Step 8 | Size matrix cell: checkbox "erbjuds" | **Becomes a select**: "Säljs inte" + the model's articles ("Vit / S"…). It is preselected where exactly ONE article's label reads "<colour> / <size>" (colour by label or id; case, spacing and the separator `/ · \|` ignored). Otherwise it reads "Säljs inte". Help text: "Välj tryckeriets artikel (plagget i färg och storlek) för varje kombination som ska säljas. ”Säljs inte” utelämnar kombinationen." | Each variant must be mapped to one physical blank (an article). |
| Step 8 (no sizes) | — | **New**: one "Välj artikel…" select per colour. | A one-size variant also needs its article. |
| Step 8 | "· Marginal [?] [40] % [Sätt pris från marginal]" | **Leave**. | Client formula (`podPricing.js`); rule 15. Same as FC's form. |
| Step 8 | Floor line "(produktionskostnad X kr inkl. moms + avgift 8 % + 5 kr är inräknade)" | Now reads "Prisgolv: **254 kr** — vid det priset tjänar du 0 kr. Inköp: **175 kr** inkl. moms." | The floor is the server's (it holds the parcel, D41). Naming only the fee would be wrong (FC did the same). |
| Step 8 | Price table "Produktionskostnad (inkl. moms) · Pris · Vinst · Marginal" | Becomes "Inköp (inkl. moms) · Prisgolv · Pris", per colour row: the Inköp range of the row's articles and its strictest floor. | Server numbers per article. No profit or margin source exists. |
| Step 8 | "Hämtar produktionskostnaden…" / "Produktionskostnad saknas…" | Becomes "Hämtar inköpspris och prisgolv…" (pending), or the server's refusal / "Inköpspriset kunde inte hämtas just nu." plus **new "Försök igen"** (failed). Publishing is blocked in both. | A pending or failed quote is never "no floor" and never "0 kr". |
| Step 8 | A refusal about the price | Shown **under the price field** (red), not in the box under the button. | The brief: the server's `price_below_floor` at the price field. |
| Step 8 (existing) | "Ersätt även befintlig huvudbild/variantbilder" | **Leaves** until FN2. | No image is written in FN1. |
| Step 8 (existing) | — | **New table "Tryckeriets artikel per variant"**: one article select per active variant (preselected by an exact label match, e.g. "Vit · S" ↔ "Vit / S"), or one row for a product without variants. | Same reason as the matrix. |
| Step 8 result (new) | — | **New line**: "Produkten har inga produktbilder ännu: mockuperna sparas inte som produktbilder i den här versionen av adminen. Ladda ned dem i steg 7 och lägg till dem på produkten under Produkter." | FN2. The product IS published (see §Publish). |
| Step 8 result (existing) | "…uppdaterades med dina mockuper och trycket kopplades automatiskt." | "…har nu designens tryckkoppling på varje variant (på artikeln du valde)." plus a note that mockups are not added. | No images are written. |
| Step 8 result | The client brand-screening notice | Comes from the server's `screeningStatus` after publish (FC's `screeningNoticeFor`). | The client blocklist is gone (FC). |
| Whole studio while a save runs | — | The step header, "‹ Tillbaka" and the whole publish form are disabled (`<fieldset disabled className="contents">`). | Lesson: the editor is locked during a save. The older build keeps them enabled (`lockWhileSaving: false`). |
| Original tab | "Fortsätt till Designstudion" (upload modal) / "use in studio" | Offered again (`STUDIO_AVAILABLE` is true in both builds now). | FM had hidden it while the studio was a stand-in. |

Code changes beyond data calls in shared files:
- `DesignStudio.jsx`: imports; the moved publish/update bodies (now `settlePublish(await publishDesign(studioContext(), form))`); `studioContext()`; the flags above; one new state `production`; one new state `publishErrorField`.
- `PublishPanel.jsx`: imports via `./publishPanelData`; the `sp` (server pricing) branches listed above; three new props (`errorField`, `locked`, `production`).
- `CompositorCanvas.jsx`: one prop, `lockedNote`.

No class token or colour was added. Every new control uses classes the panel already had (`smallInputCls`, `inputCls`, `labelCls`).

**The older build:** `npx vite build` ✓. The moved Firebase code is the verbatim text of the two bodies (extracted by line range, not retyped), inside `publishDesign` / `updateProductFromDesign` of `studio/studioData.js`. Its state arrives as `ctx` under the same names, and its setters became the outcome. The only render differences in the older build:
- "‹ Tillbaka" gained `disabled:` classes, but it is never disabled there.
- The publish form sits in a `display: contents` fieldset that is never disabled.

Neither changes how it looks.

## Files

**Created**
- `src/admin-app/adapters/studio.js` + `studio.test.mjs` (15). Pure: templates, production (printer models → the studio's routing), article preselection, mapping groups and the per-scope mapping diff, quote summaries.
- `src/api/admin/podStudio.js` + `podStudio.test.mjs` (4): `GET /v1/admin/pod/mockup-templates`, `GET …/3d-models` (the latter for FN2).
- `src/admin-app/replacements/podMockupTemplates.js`: replaces `config/podMockupTemplates.js`.
- `src/admin-app/replacements/podPrintRouting.js`: replaces `config/printRouting.js`.
- `src/admin-app/replacements/podCostQuote.js`: replaces `config/podCostQuote.js`. It computes nothing: `quotePodCost` answers no number with no request, and `quoteDesign` asks the design quote.
- `src/admin-app/replacements/pod3dModels.js`: replaces `config/pod3dModels.js`. FN2 stub.
- `src/admin-app/replacements/podMockupUpload.js`: replaces `studio/mockupUpload.js`. FN2 stub.
- `src/admin-app/replacements/podStudioData.js`: replaces `studio/studioData.js`. Flags, texts, `useStudioEnv`, publish/update.
- `src/admin-app/replacements/podStudioPublish.js` + `podStudioPublish.test.mjs` (23): the sequence (no React).
- `src/admin-app/replacements/podPublishPanelData.js`: replaces `studio/publishPanelData.js`. `useArticleQuotes`, `useServerPricing`, the podPricing names answering null.
- `src/admin-app/dev/studio-dev.mjs`: the template route, invented templates, tiny generated PNG "photos" as `data:` addresses. Cookies `admin_dev_studio=fail|empty`.
- `src/wagons/pod-wagon/studio/studioData.js` (older build, **Firebase**: the moved code). **Needs its allowlist entry when committed.**
- `src/wagons/pod-wagon/studio/publishPanelData.js` (older build: podPricing + client notice, re-exported).
- `src/config/podMockupTemplateHelpers.js`: `getTemplateById`, `templateSlots`, `garmentOfTemplate`, moved unchanged out of `podMockupTemplates.js`, which re-exports them.
- `docs/cf-port/CP5_FN1_REPORT.md`

**Modified**
- `src/wagons/pod-wagon/studio/DesignStudio.jsx`, `PublishPanel.jsx`, `CompositorCanvas.jsx` (as above).
- `src/config/podMockupTemplates.js` (the three helpers re-exported).
- `src/wagons/pod-wagon/components/podStudio.js` (comment only).
- `vite.admin.config.js`: FM's `podStudio.js` row removed; 7 rows under "Unit FN1".
- `src/admin-app/dev/dev-api.mjs`: one import and `...STUDIO_ROUTES` (my lines only).
- `guard/allowlist.txt`: `studio/DesignStudio.jsx` out (it no longer imports Firebase), `studio/studioData.js` in. Net 0, size 296.

**Deleted:** `src/admin-app/replacements/podStudio.jsx` (FM's stand-in; nothing imports it).

## Route map

| Studio action | Older build | This build |
|---|---|---|
| Templates | `settings/podMockupTemplates` | `GET /v1/admin/pod/mockup-templates` (cached per shop; a failure rejects, so the studio says "kunde inte laddas" and offers its retry) |
| What can be produced | `settings/printRouting` + `printersPublic` | `GET /v1/admin/pod/printers` (FM's call): each (printer, model) with articles becomes one `printersById` entry plus `routing.byGarment` |
| Profiles (DPI for the canvas) | `settings/podProfiles` | FM's `GET …/pod/profiles` replacement (unchanged) |
| Artwork (motif grid) | `usePodLibrary` | FM's library (unchanged): only `status: ready` artwork, preview = presigned URL |
| Quote | callable `quotePodCost(garment, slots)` | `GET /v1/admin/pod/design-quote?printerId=&sku=&slots=` once per chosen article, after 250 ms, an aborted ask never shared; again (`fresh`) right before any write |
| 3D models | `pod3dModels` | none (FN2) |
| Publish (new) | Storage uploads + `addDoc products` + `setMapping` ×N | §Publish below |
| Update existing | Storage uploads + `setMapping` + `updateDoc` | `GET /v1/admin/products/:id`, fresh quotes, `GET /v1/admin/pod/mappings?productId=`, then only the differing `DELETE …/mappings/:id` and `POST …/mappings` |

Every request is `adminRequest` (X-Shop-Id). Every read is bound to the active shop through `readForShop`. **A bug found and fixed while testing:** a cache that stored the `readForShop` promise itself was poisoned forever once that promise was dropped (it never settles). All three caches (templates, printers, quotes) now store the shop's own request, and only the caller is dropped. There is a test for it.

## Publish: the sequence, and what a failure at each step leaves

`podStudioPublish.js publishNewDesign`. The studio validates first (unchanged), holds the latch, and passes a snapshot of the design.

| # | Step | A failure here leaves |
|---|---|---|
| 0 | Checks that write nothing:<br>• colour names are distinct<br>• every offered cell has an article, and no article is chosen twice<br>• **every article's quote is asked again** (a failure → "Inköpspriset kunde inte hämtas…", never 0 kr)<br>• product price ≥ the strictest floor, each colour's own price ≥ its articles' floor | **Nothing.** A price refusal is shown at the price field (`field: 'price'`). |
| 1 | SKU made unique against all the shop's products (`listAllProducts`) | Nothing. |
| 2 | `POST /v1/admin/products` (always a **draft**) | Nothing (refusal said). **A lost answer** (network or 5xx): the shop's products are searched for the SKU. If the product is found, it is remembered as the draft to continue, and the message says it exists. If not: "oklart om produkten skapades — kontrollera under Produkter". |
| 3 | Variants `POST …/variants`, one per colour × size (derived by `deriveVariantsFromGroups`, like the older studio and the product form) | A draft, not in the storefront. "Produkten ”X” (SKU y) finns som utkast och visas inte i butiken: 2 av 5 varianter är sparade. <cause> Tryck ”Skapa produkt” igen för att fortsätta med samma utkast, eller öppna det under Produkter." |
| 4 | Mappings: per variant, `mappingGroups` (the slots printing the same artwork share one mapping; a colour override gives that colour's variants another artwork) on the variant's article; `POST …/pod/mappings` one at a time (each write fences the product, so in parallel they would conflict) | The same draft message, with "… och 3 av 10 tryckkopplingar". |
| 5 | `PATCH {status:'active'}`, then `POST …/publish` (the server's POD gate, floor and screening decide) | The draft, all written but not live. `price_below_floor` → the message at the price field. |

**Re-run.** The tab remembers the draft per shop (`pendingRun`). The next "Skapa produkt":
1. reads it (an archived or missing draft → a new product);
2. PATCHes the product's body;
3. syncs the variants by SKU (`planVariantSync`);
4. plans the mappings against the server's (`planScopeMappings`: keep the identical ones, delete what differs first, then post; a POST of the same artwork, printer and article re-activates its row);
5. publishes.

Tests prove that no second product, variant or mapping is created.

**Images:** none. `publishAdminProduct` has no image requirement (it checks status, takedown and the POD gate), so the product is published, and the result says it has no images and how to add them (download in step 7, upload under Produkter). See open question 1.

**Update existing** (`updateExistingFromDesign`):
- a fresh read of the product (another shop's → "finns inte längre");
- scopes = its active variants, or the product's own scope;
- a colour-specific motif needs a variant group with exactly that colour's name (the older rule and message);
- every scope has its own article, none chosen twice;
- fresh quotes, each scope's price ≥ its floor;
- then only the differing mappings.

The product, its variants, prices and texts are not written. A second run writes nothing (tested). A live product's mapping change is checked by the server against its floor. A partial failure says how many changes were saved.

## What works against the dev API (`/private/tmp/fn1-shots/`)

Signed in as `admin@example.com` (Test Shop A), with the real `AppLayout`, port 5197.

- **Step 1:** 4 garments offered; the tote bag (no printer) is not (`step1-1440-light`). Production choice with two models (`step1-production-choice-1440`; fixture edit reverted).
- **Step 2:** "Bröst 25 × 35 cm" from the printer model, no sleeve (`step2-…`).
- **Step 3:** motif picks (`step3-…`).
- **Step 4:** locked 25 × 25 cm, the same as the server's stored size (`step4-1440-light`, `step4-1440-dark`).
- **Step 6:** Svart's front overridden with another motif (`step6-…`).
- **Step 7:** 4 mockups rendered with the override; the 3D line (`step7-…`).
- **Step 8:** articles preselected (Vit S/M, Svart S/M/L), Inköp 175 kr / floor 254 kr (`step8-1440-light-initial`).
  - Price 199: "Priset måste vara minst prisgolvet 254 kr" (`step8-under-floor-1440`).
  - 299: published. Read back from the dev API: 5 variants and 10 mappings, each on its article, Svart's front on the override motif, front 250×250 / back 300×400 mm (`step8-published-1440-light`).
- **Existing:** "T-shirt Fjäll" with a per-variant article table; Sand unmatched → blocker; after choosing it the update succeeded (`step8-existing-…`).
- **Dark** 1440 (`step8-1440-dark`) and **375** light and dark (`step8-375-…`): no page-level horizontal scroll (`scrollWidth` 375). The matrix and the price table scroll inside their own wrappers, as before.
- **Error and empty:** templates 500 → "Plaggmallarna kunde inte laddas…" with "Försök igen"; no templates → "Inga plaggmallar kunde hämtas…" (`error-templates-…`, `empty-templates-…`).

What I saw that is not this unit's:
- The caution box is bright in dark mode (the known dark status-token gap).
- **Every motif thumbnail carries the caution dot.** The studio compares `validation.tier !== 'pass'` (lower case), but the tier vocabulary is upper case (`PASS`, `podTier.js`). This is pre-existing in the older studio. Not changed (markup rule).
- Leaving step 8 resets the publish form (pre-existing).

## OFF until FN2, and exactly what FN2 fills

1. **3D:**
   - `src/admin-app/replacements/pod3dModels.js`: `loadPod3dModels` (from `list3dModels` in `src/api/admin/podStudio.js`, cache per shop the way `podMockupTemplates.js` does it, keep the `localeCompare(…,'sv')` sort), `getPod3dModelById`, `clearPod3dModelsCache`.
   - Then set `STUDIO_FLAGS.studio3d: true` in `podStudioData.js`.
2. **Mockup upload:**
   - `src/admin-app/replacements/podMockupUpload.js` `uploadMockup({blob,type,shopId,templateId,slot,colorwayId})`: return `{ url, storagePath: objectId }` from `uploadObject(blob, {kind:'product_media'})`, and set `MOCKUP_UPLOAD_AVAILABLE`.
   - DesignStudio already writes `entry.url` and `entry.storagePath` from the answer.
3. **Images in the publish:**
   - In `podStudioPublish.js publishNewDesign`, between steps 3 and 4: `PUT …/images` with the hero first, then each colour's mockups naming that colour's first variant (`orderedVariantMockupUrls` → objectIds; FC's `imageList`).
   - Pass `ctx.mockups`/`ctx.heroKey` through `podStudioData.js publishDesign`.
   - Drop `NO_IMAGES_NOTE`.
   - The same for `updateExistingFromDesign` (fill or replace).
   - Give `PublishPanel` a flag to show "Ersätt även befintlig huvudbild…" again (it is hidden under `!sp` today).
4. **CSP for FN2:** the older publish re-reads mockups with `fetch(blob:…)`. The admin CSP's `connect-src` has no `blob:`, so keep the `Blob` from `renderMockup` instead of fetching it back.

## Worker follow-ups (nothing built; the studio works around each as described)

1. **A mapping stores no placement and no pocket position.** The studio is locked to the server's contain-fit size, centred.
   - **Which vertical position does the printer actually use** (centred in the frame, or top-aligned at `offsetTopMm`)? If it is top-aligned, the mockups are off vertically for a motif shorter than the frame.
   - Either the mapping carries `{xMm, yMm, wMm}` (and a pocket position), or the rule must be stated so the studio can draw it.
2. **Articles have only a free-text label.** Colour and size are matched from "Vit / S". Structured `color` and `size` on the catalogue's SKU entries would make the preselection exact.
3. **The mapping tuple (product, artwork, printer, article) is unique across scopes, including removed rows.** If an article later moves to another variant of the same product with the same artwork, the write gets `variant_mismatch` (shown with FM's sentence).
4. **No atomic "create product + variants + mappings + publish".** A batch route would remove the draft half-states.
5. **`POST /v1/admin/products` has no idempotency key.** A lost answer is recovered by a lookup on the SKU.
6. **One design-quote request per article** (up to 12 for 2 colours × 6 sizes). A multi-SKU design quote would help.
   - Also: the server sizes a print at the **artwork's** profile DPI, while the studio's locked placement uses the **template's** profile. They are equal for the seeded `apparel_dtg`. Returning the stored slot sizes (`sizeSlot`) from the design quote, given an `artworkId`, would make the preview exactly the server's.
7. **The publish gate does not require an image for a POD product** (see open question 1).
8. **Presigned artwork previews expire.** A long studio session can outlive the presign TTL, and the canvas and mockups then fail to load the motif. A longer TTL, or a re-read on load failure, is needed.

## CORS / CSP before real use (reviewer)

- **Public bucket** (template photos and displacement maps): `mockupRender`, the pixi compositor and `TemplateBackground` load them with `crossOrigin='anonymous'`. The bucket must answer `Access-Control-Allow-Origin` for the admin origin (GET). Otherwise the photo templates fail to draw and the canvas export is tainted (no mockups). WH noted the same.
- **Private bucket presigned previews** (`*.r2.cloudflarestorage.com`): the compositor, `contrastGuard` and `mockupRender` load `previewUrl` with `crossOrigin='anonymous'`. This needs a CORS rule on the private bucket for the admin origin too, or every motif fails to compose.
- **CSP:** `img-src` already lists both hosts. `connect-src` matters only for FN2's blob fetch (above). The dev API uses `data:` addresses, so CORS was not exercised here.

## Gates (summary lines as printed)

- `node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs` → **tests 745, pass 745, fail 0** (703 at HEAD + 42 mine).
- `npx vite build --config vite.admin.config.js` → ✓ built. `node cloudflare/admin/check-admin-build.mjs` → "admin build: 27 files (21 text) checked, no Firebase code, no source map, no secret, every file servable."
  - Bundle searched for `admin-dev-api`, `Testtryckeriet`, `DEV-TEE`, `art-fjall`, `dev_tee_flat`, `studio-dev`, `garmentPhoto`, `hiddenPrices`: none.
  - The pixi chunks are now in the admin bundle (lazy, about 340 kB), because the studio's canvas uses them for photo templates.
- `npx vite build` (older) → ✓ built (the moved publish text is in its `pod-wagon` chunk). `node cloudflare/web/check-storefront-build.mjs` → "storefront build: 11 files (7 text) checked, no Firebase code, every file servable."
- `node --test src/wagons/pod-wagon/*.test.js src/wagons/pod-wagon/studio/*.test.js` (the repo has no vitest; these are `node:test`) → tests 20, pass 20. `node rules-tests/one-number-pure.test.cjs` → 53 passed, 0 failed.
- `node guard/guards.test.mjs` → **exit 1**: "(b) 1 stale guard/allowlist.txt entry … src/wagons/pod-wagon/studio/studioData.js". Expected: it is the new older-build data module (Firebase by design), untracked until the reviewer adds it. Allowlist size 296, unchanged. My files contain neither forbidden name (checked by hand).

**Mutations**, each made once with the suites run and then reverted. Every one was caught:

| Mutation | Tests failed |
|---|---|
| floor check skipped | 1 |
| failed quote read as ok | 1 |
| no resume | 4 |
| publish before mappings | 2 |
| mapping diff writes everything | 4 |
| same artwork not merged | 8 |
| templates not bound to the shop | 1 |
| failed template read cached | 1 |
| quote failure memoised | 1 |
| pending quote counted as ok | 1 |
| duplicate article allowed | 1 |
| update writes the product | 1 |

## Open questions for Mikael

1. **Publish without images.** The routes allow it, so a studio product goes LIVE with no product image until FN2 (or until the seller uploads the downloaded mockups under Produkter). Should FN1 save it as a draft instead? That is a one-line change in `podStudioPublish.js`: skip step 5 and say "sparad som utkast".
2. **Locked placement.** Until the Worker stores a placement, the seller cannot move or resize a print, or choose the pocket position (left only). Is that acceptable for launch? And which vertical alignment does SnapWear use (Worker follow-up 1)?
3. **Article preselection** by an exact label match ("Vit / S"). Is the seller choosing the article per colour and size acceptable? It shows the supplier's article labels (WG/FM open question on supplier visibility).
4. **Continuing the draft.** After a failed publish, the next "Skapa produkt" in that tab writes into the same draft, even if the seller changed the design meanwhile. That keeps orphans away. Is it the behaviour you want?
5. **The new and changed texts** in §(a) need your words.
6. **The caution dot on every motif** (the `'pass'` vs `PASS` mismatch, pre-existing). Fix it in both builds?
