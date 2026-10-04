Model: claude-opus-5-5 (Opus 5.5)

# CP5-FN2: the design studio's mockups become product images; the 3D view reads the Worker

Built in the working tree on `cf-port` (HEAD `959f7892`, clean at start). No git writes, no network (localhost only), no wrangler, no deploy. I did not touch `cloudflare/**`, the pixi compositor (`studio/pixi/*`, `displacementCompositor`) or the render maths. The older build's dev server was not started.

## Files

**Created**
- `src/admin-app/adapters/studioMedia.js` + `studioMedia.test.mjs` (12 tests). Pure code: the image-list planner (`planStudioImages`), the studio's alt-text mark (`mockupAlt`), coverage (`mockupCoverage`), `sameStudioList`, `droppedStudioObjects`, `studioObjectsBySide`, and the 3D adapter (`models3dFromApi`).
- `src/admin-app/replacements/podStudioImages.js`. The I/O of the image step:
  - hash each mockup (sha256);
  - keep, reuse or upload each object (`uploads.js`, kind `product_media`);
  - PUT the list only when it differs from the server's;
  - read the list back when an answer is lost;
  - remove the studio's replaced objects.
- `docs/cf-port/CP5_FN2_REPORT.md`

**Modified**
- `src/admin-app/replacements/podStudioPublish.js`: the image step in both flows, the mockup checks, the notes. `NO_IMAGES_NOTE` and `NO_IMAGES_UPDATE_NOTE` are removed.
- `src/admin-app/replacements/podStudioPublish.test.mjs`: the harness now passes Blob bodies through; FN1's first and update tests are adapted to the images; 18 new tests.
- `src/admin-app/replacements/podStudioData.js`:
  - passes the mockups (with their Blobs), `heroKey` and `replaceImages`;
  - `studio3d: true`;
  - `no3d: null`;
  - new texts `models3dFailed` and `exportUnreadable`.
- `src/admin-app/replacements/pod3dModels.js`: the real loader, replacing FN1's stub.
- `src/admin-app/replacements/podMockupUpload.js`: still answers null, with a new comment saying why. The unused `MOCKUP_UPLOAD_AVAILABLE` is removed.
- `src/admin-app/replacements/podPublishPanelData.js`: `PANEL_TEXT.updated` now mentions the mockups.
- `src/wagons/pod-wagon/studio/DesignStudio.jsx`, shared. Data-layer changes only:
  1. `entry.blob` is kept from the render.
  2. `loadPod3dModels().catch(() => null)`. When it is null, the line `STUDIO_TEXT.models3dFailed` is shown where the 3D view was.
  3. A render failure caused by unreadable images (an image load error or a `SecurityError`) is counted apart and shown as `STUDIO_TEXT.exportUnreadable`. This applies only where that text is non-null. The older build's texts are null, so it behaves exactly as before.
- `src/wagons/pod-wagon/studio/PublishPanel.jsx`, shared: the "Ersätt även befintlig huvudbild/variantbilder" checkbox is shown again. FN1 had hidden it under `!sp`, and the older build always showed it.
- `src/wagons/pod-wagon/studio/studioData.js` (older build): two new `STUDIO_TEXT` keys, both `null`.
- `src/admin-app/dev/studio-dev.mjs`:
  - `GET /v1/admin/pod/3d-models` with an invented tee model (Vit and Svart, as data: PNGs) and one unfinished model that the section filters out;
  - cookie scenarios `3d-fail`, `3d-broken` and `photo-404`.

`vite.admin.config.js` is unchanged: FN1's alias rows for `pod3dModels` and `mockupUpload` already point at these files. No other unit's file was edited. I briefly added a GET-object dev route to `products-dev.mjs`, found that `content-dev.mjs` already serves it, and restored the file byte for byte.

## The publish sequence as it is now (new product, `publishNewDesign`)

| # | Step | A failure here leaves |
|---|---|---|
| 0 | Checks that write nothing (FN1's, plus two new ones):<br>• each published colour has ≥ 1 mockup with its bytes ("Det finns ingen mockup för Svart. Generera mockuperna igen i steg 7 …")<br>• the planned image list fits the 30-row cap (placeholder ids)<br>• FN1's article, quote and floor checks | Nothing. |
| 1 | Unique SKU | Nothing. |
| 2 | `POST /products` (a draft) | FN1's lost-answer recovery, unchanged. |
| 3 | Variants | A draft: "… finns som utkast och visas inte i butiken: 2 av 5 varianter är sparade …". |
| **4** | **Images.** Each mockup (in the studio's order, published colours only):<br>• **kept** when the product already holds an object for the same colour and side (by its alt text) whose `sha256` (`GET /v1/admin/objects/:id`) equals the new bytes;<br>• else **reused** when this tab already uploaded the same bytes *for this product* and the object is still active;<br>• else **uploaded** (`uploadObject`, reserve → PUT content; a failed content PUT removes its reservation).<br>Then the list is PUT if it differs from the server's. A lost answer (no answer or 5xx) is read back with `GET /products/:id`. | A draft, not live, with **no mappings**: "… 5 av 5 varianter är sparade. Produktbilderna kunde inte sparas (2 av 4 uppladdade): Anslutningen bröts. Tryck ”Skapa produkt” igen …".<br>Refused list: "Produktbilderna kunde inte sparas: En bild kunde inte användas …".<br>Lost answer, list not stored: "… Anslutningen bröts innan bilderna sparades."<br>Lost answer, read-back fails too: "… Anslutningen bröts, och det är oklart om produktbilderna sparades." Still a draft, which is true: nothing can be live before step 6. |
| 5 | Mappings (FN1) | A draft (FN1's message). |
| 6 | Active, then publish (FN1, with its read-back) | FN1's outcomes. |

**Re-run.** The same draft is continued, as before.
- Images: the draft's rows are re-read after the variant sync. Objects with the same bytes are kept or reused, so only missing ones are uploaded.
- An identical list is not written again. Tested: after a failed mapping, the next run makes 0 uploads and 0 image PUTs. After a failed 3rd upload, the next run makes exactly 2 reservations.

**Missing side (point 2, my choice).**
- **A colour with no mockup at all stops the publish before any write**, naming the colour. The older studio could not reach Publicera in that case either: step 7 requires a finished mockup per colour.
- **A colour missing one printed side is published with a visible note** in the success box: "Ingen mockup kunde göras för Svart (baksida): den bilden saknas på produkten." The older studio published that case too, with the warning shown only in step 7.
- The older studio filled a colour that had no image with the hero, i.e. *another colour's* picture. That fallback is dropped.

**Update existing (`updateExistingFromDesign`).**
1. FN1's checks, plus the two new mockup checks (coverage, cap) against the product's current rows. These write nothing.
2. FN1's mappings.
3. The image step as above, with `fresh: false`.

A failure in step 3 after mappings were written says: "Produktbilderna kunde inte sparas: … Tryckkopplingen är redan uppdaterad. Tryck ”Uppdatera produkten” igen …" (`changed: true`). The re-run writes no mappings, reuses the uploaded objects and PUTs the list once (tested). A lost answer with a failed read-back says "… oklart om produktbilderna sparades. Kontrollera produkten under Produkter …".

**Layout (the older studio's order kept):**
- The product's own rows: the hero first, then every other published mockup in the studio's order (colour × side).
- Each colour's rows, naming its **first variant by id**: front then back (the older `orderedVariantMockupUrls`). A design printed on the back only shows the back first. Pocket and sleeve mockups stay only in the product's own rows, as before.
- Over 30 rows: the own rows keep only the hero, each colour keeps its own, and a note says so. Still over 30: refused before any write.

## Which images are "the studio's" on update

**A row is the studio's when its `alt` is the studio's text for one of the colours this run publishes and a printed side.** The text is `"<colour label> – <side>"`, with side = framsida, baksida, bröstficka, vänster ärm, höger ärm or övrigt tryck, e.g. "Svart – baksida". It doubles as real alt text for customers.

Nothing else writes an alt in this build: the product form sends none, and the import sends none. Everything else is the seller's and is kept, in its order. The rules (the older studio's "fill, replace only on opt-in", translated):
- The studio's rows of the published colours are replaced, **in place**. If the bytes are unchanged, the same object is kept and nothing is written. Tested: change only Svart's back, and exactly 1 upload, 1 PUT, 2 rows change object (gallery + colour), and the old object is removed.
- **The main image** becomes the hero only when:
  - the product has none, or
  - the main image was the studio's, or
  - the seller ticks "Ersätt även befintlig huvudbild/variantbilder".

  The old main image is then kept as the next image, never dropped. The older build overwrote it.
- **A colour whose rows are all the seller's** keeps them untouched unless the box is ticked. With the box, the studio's rows come first and the seller's follow. The success note names the colours whose own images were kept.
- **Colours not published in this run:** none of their rows are touched, not even the studio's.
- **A published colour with no variant of that exact name:** its mockups go only into the product's own rows, as in the older studio. The note says so.
- **After a confirmed write**, objects of the studio's earlier rows that the list no longer names are deleted (D93, as the form deletes its own dropped images). This is best effort. The upload memory is keyed by product, so an object is never shared between two products.
- **Known limitation:** the product form's image PUT drops alt texts. FC's `imageList` sends only `{objectId, variantId}`, and it re-PUTs whenever images or variants change. After such a save, the studio no longer recognises its old rows, so it **keeps** them as the seller's (safe direction, never removed) and adds new ones. See Worker/front follow-up 1.

## The 3D view

- `pod3dModels.js` reads `GET /v1/admin/pod/3d-models`:
  - cached per shop, the shop's own request in the cache;
  - a late answer after a shop switch is dropped (`readForShop`);
  - a failure **rejects and is not cached**.
- `models3dFromApi`:
  - sorts with `localeCompare(…, 'sv')`;
  - drops `output: null`, so the compositor uses its own default;
  - drops entries without `id` or `views`.

  `Studio3DSection.renderReady` already filters unfinished models (null `w`/`h`, zero print area). The section is unchanged and read-only: model picker, colour picker, image-only sliders, PNG download. It does no editing and no upload, and its render is not part of publish (as in the older studio, where "Lägg till i produkt" was retired).
- When the model list cannot be read, DesignStudio still loads. Where the view was, it says: "3D-modellerna kunde inte läsas just nu, så 3D-vyn visas inte. Ladda om sidan för att försöka igen."
- When a model's photo or map cannot be drawn (CORS, 404), the existing `DisplacementPreview` error panel shows "Kunde inte läsa bilden för 3D-mockupen." instead of a blank canvas. Seen with `3d-broken`.

## Point 4: images drawn to a canvas

Every image that reaches a canvas or a WebGL texture goes through one of three loaders, and all three set `img.crossOrigin = 'anonymous'`:
- `mockupRender.js loadImage`: template photos, SVG flats, artwork previews;
- `contrastGuard.js loadImage`: artwork previews;
- `pixi/displacementCompositor.js loadImage`: 3D photos, fabric and displacement maps, masks, artwork.

`Texture.from` is only fed loaded images or canvases. `TemplateBackground`'s `<img>` is display only and never read back.

A missing CORS header therefore shows up as an image *load* error, not a tainted canvas. Both that error and a `SecurityError` from `toBlob` are now shown as: "Bilderna kunde inte läsas för export (plaggfotot eller motivet nåddes inte). Kontrollera anslutningen och generera igen; hjälper det inte, kontakta plattformen. (2 av 4 mockuper saknas.)" Before, they were counted as "foto saknas". Seen with `photo-404`.

Not changed: the 3D section's "Ladda ner 3D-bild (PNG)" still only logs a failed export (pre-existing; the markup rule applies).

## What works against the dev API (`/private/tmp/fn2-shots/`, port 5198, WebGL on via `GSTACK_DISABLE_GPU=off`)

- **Step 7, mockups** (photo tee, Vit + Svart, front + back): `step7-1440-light`.
- **3D view.** With Svart, the first mount reported "3D-vyn tappade grafikminnet …": headless GPU context loss. It was said, not blank. After switching to Vit it rendered the Worker-shaped model: `step7-3d-1440-light`, `step7-3d-vit-1440-light`. At 375 dark it rendered Svart: `step7-375-dark`; no page-level horizontal scroll (`scrollWidth` 375).
- **Publish "Fjälltröja Studio"**: "… nu LIVE i butiken" (`step8-published-1440-light`).
  - Produkter shows its main image (`products-list-1440-light`).
  - The form shows Huvudbild + 3 gallery images, and Vit's variant holds front + back (`product-form-studio-1440-light`).
  - Also published at 375 dark: `step8-published-375-dark`.
- **Update existing, one colour changed.** I regenerated with Svart's chest on another motif, then ran "Uppdatera produkten" on that product. The network log showed:
  - 3 mapping swaps;
  - **1** object upload (Svart front; the other three were byte-identical renders, recognised by sha256);
  - 1 `PUT …/images`;
  - 1 `DELETE` of the old Svart-front object.

  The form shows the new Svart front (`step8-existing-*`, `product-form-after-update-1440-light`).
- **Errors:**
  - `error-export-unreadable-1440-light`: `photo-404`; Svart cannot render, and step 8 stays locked.
  - `error-3d-broken-1440-light`: the panel names the failure. The model thumbnail `<img>` is then a broken-image icon (pre-existing markup).
  - `error-3d-fail-1440-light`: the caution line.

## Every visible difference from the older studio

| Where | Difference | Why |
|---|---|---|
| Step 7 | No draft copy is stored while generating. The old "kunde inte sparas till lagringen" part of the warning can no longer occur. | Mockups are uploaded at publish. An object per generation would be an orphan. |
| Step 7 | Unreadable images get "Bilderna kunde inte läsas för export …" instead of "… hoppades över (foto saknas)". | The brief (point 4). The two causes are now told apart. |
| Step 7 | A failed 3D model read shows a caution line where the view was. The older loader silently hid the section. | A failed read is not "no models". |
| Step 8 (existing) | The "Ersätt även befintlig huvudbild/variantbilder" checkbox is back; FN1 had hidden it. | Images are written again. |
| Step 8 result (new) | FN1's "inga produktbilder" line is gone. A note appears only for a missing side, compaction over 30, a colour without a variant, or colours whose own images were kept. | The images are written. |
| Step 8 result (existing) | "uppdaterades med dina mockuper och har nu designens tryckkoppling på varje variant (på artikeln du valde)." | FN1's text, plus the images. |
| The product's images | The hero is not stored twice: the older build uploaded a separate `b2c_main` copy plus the same mockup in the gallery. Here, one object serves as both. The old main image is kept (moved to second) when the box replaces it. A colour with no image is never filled with another colour's hero. | One list, unique per (variant, object). Never drop the seller's image. |
| The product's images | Each studio image carries alt text ("Svart – baksida"). | It marks the studio's rows (above). It is also real alt text. |

## CORS (the reviewer's, before real use)

The admin origin needs `Access-Control-Allow-Origin` (GET) on:
1. **The public bucket** (`PUBLIC_OBJECT_BASE_URL`): template photos, displacement maps, **3D model photos, maps and masks**. Without it, mockup export and the 3D view fail. Both failures are now said: "Bilderna kunde inte läsas för export …" and "Kunde inte läsa bilden för 3D-mockupen."
2. **The private bucket** (`*.r2.cloudflarestorage.com`, presigned artwork previews): the compositor, `contrastGuard` and `mockupRender` all draw the motif.

The upload itself is same-origin (`/_api` → Worker) and needs no CORS. No `blob:` fetch is made: the Blob is kept from the render, so the CSP's `connect-src` needs no change.

## Worker follow-ups (nothing built; the studio degrades as described)

1. **Durable "studio image" mark.** The image rows have only `alt`, and the product form's PUT drops it (front-end FC: carry `_server.imageRows[].alt` through `imageList`, a one-line fix). A real fix would be a `source` field on an image row (e.g. `studio:<colour>:<side>`), or keeping `alt` on a PUT that omits it.
2. **No idempotent "attach images" with sha dedupe.** Each re-upload after a lost content-PUT answer creates a new object. A reserve that answers the existing active object for the same `(tenant, sha256, kind)` would remove the client's sha memory.
3. **`GET /v1/admin/objects/:id` per row** to learn a sha256 (≤ 30 requests on update). `sha256` on the product detail's image rows would make it one read.
4. FN1's #4, unchanged: no atomic product + variants + images + mappings + publish.

## Gates (summary lines)

- `node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs` → **tests 786, pass 786, fail 0** (756 at HEAD + 30).
- `npx vite build --config vite.admin.config.js` → ✓ built. `node cloudflare/admin/check-admin-build.mjs` → "admin build: 27 files (21 text) checked, no Firebase code, no source map, no secret, every file servable." A bundle grep for `admin-dev-api`, `Testtryckeriet`, `DEV-TEE`, `art-fjall`, `dev_tee_flat`, `studio-dev`, `garmentPhoto`, `dev-tee-3d` and `dev-missing` found nothing.
- `npx vite build` (older) → ✓ built in 11.01s. `node cloudflare/web/check-storefront-build.mjs` → "storefront build: 11 files (7 text) checked, no Firebase code, every file servable."
- `node --test src/wagons/pod-wagon/*.test.js src/wagons/pod-wagon/studio/*.test.js` → tests 20, pass 20.
- `node guard/guards.test.mjs` → **guard: PASS (exit 0)**, allowlist size 296. My three new files are untracked; a hand grep for the guard's families found nothing.

**Mutations**, each made once with both suites run, then reverted (scripted). Every one was caught:

| Mutation | Failed |
|---|---|
| no read-back on a lost list answer | 4 |
| failed read-back said as "not saved" | 1 |
| no reuse of the product's same-bytes object | 1 |
| no reuse of this tab's upload | 3 |
| identical list written again | 4 |
| replaced objects not removed | 1 |
| the box ignored | 3 |
| seller's own rows dropped | 7 |
| seller's colour rows replaced without the box | 2 |
| not back-first | 6 |
| no colourless check | 2 |
| missing side not said | 1 |
| upload failure ignored (images not gating mappings/publish) | 4 |
| 3D failure cached | 1 |
| 3D not bound to the shop | 1 |
| 3D not sorted | 2 |

## Open questions for Mikael

1. **The alt text as the studio's mark** ("Svart – baksida") is also what screen readers and image search see. Is that wording acceptable? And should FC's form keep alt texts (follow-up 1)?
2. **A colour missing one side publishes with a note**, and a colour with none stops the publish. Is that the rule you want, or should a missing side stop it too?
3. **The main image on update** follows the older opt-in rule, but the old main image is now kept as the second image instead of being lost. OK?
4. **Removing replaced studio objects (D93) on update** is immediate after a confirmed write. Should they instead be left for a later sweep?
5. **Over 30 images** (more than about 7 colours with front and back), the gallery keeps only the hero and each colour shows its own images. Is that acceptable, or should the studio limit the number of colours?
