Model: claude-opus-5-5 (Opus 5.5)

# CP5-FM report: the POD artwork library and the product-mapping page (`/admin/pod`)

Built in the working tree on `cf-port` (HEAD `14976ab0`) while FW worked on its own files. I did not touch `cloudflare/**` or any of FW's files. No git command that writes, no network (localhost only), no wrangler, no deploy. The older build's dev server was not started.

The page's line in `src/admin-app/pages.jsx` is swapped: `/admin/pod` is the real page in the admin build. The Studio tab is a clearly worded "kommer snart" card until unit FN.

## (a) What leaves or changes, control by control (admin build only; the older build keeps every one)

**Original tab (ArtworkLibrary)**

| Control | In this build | Why |
|---|---|---|
| "Validera om" (per row) and "Validera om alla" | Leave | Every artwork on the Worker went through the server's pipeline. No unvalidated legacy rows exist, and the same bytes get the same verdict. |
| "Ersätt fil" | Leaves | No route replaces an artwork's file in place. The seller deletes the original and uploads it again. |
| The "Tryckfil" / "Original" link | Leaves | The print file belongs to the print shop. The original is private: its content route needs the shop header, which a link cannot send. |
| **New: "Byt namn"** | Added (same class as "Ersätt fil", in its place) | The brief asks for rename: `PATCH …/artwork/:id { label }`. A `window.prompt`, the same style as the page's `window.confirm`. Nothing is written when the name is unchanged or the prompt is cancelled. The row is locked while its save runs, and the library is read again afterwards. |
| **New: status pill "Bearbetas…"** (caution style, the markup of the existing "Ej omvaliderad" pill) | Added | A 202 upload is `processing` until the render ends. It is said as pending, never as done. |
| **New: status pill "Misslyckades"**, a line "Filen kunde inte bearbetas på servern — ladda upp den igen.", and a button "Ladda upp igen" (opens the upload modal) | Added | A failed render reads `status: "failed"` (WG). The trash button on such a row only dismisses it, and nothing is sent. |
| The "Används av SKU · Bröst" pill | Shows every slot of the mapping ("Bröst + Rygg") | A Worker mapping prints one artwork on several slots. |
| The meta line (· PNG · 4.0 MB) | Comes from the original's object metadata. Missing when that read fails. | The artwork summary has no file type or size. |
| A row without a name | "Namnlöst original" | Rows from before migration 0048 have `label: null`. |
| A rejected artwork | Stays in the library (Underkänd + the server's reason). Delete removes it. | The Worker keeps rejected rows. Firebase never stored them. |

**Upload modal (ArtworkUploadModal)**

| Control | In this build | Why |
|---|---|---|
| The client pre-check (`gateArtwork`: DPI, format by extension) | Never blocks. The pill always reads "Kontrolleras vid uppladdning". No client DPI figure is shown. | The brief: the 300-DPI contain gate, the print areas and the formats are the SERVER's verdict, so they are not re-implemented. The profile's own file-size cap still refuses before sending (the server's number, from `/profiles`). |
| The text after a successful upload | "Originalet finns nu i biblioteket. Koppla det till en produkt under Avancerat: där väljer du tryckeri, artikel och placering." | The older text sends the seller to the studio, which is not here. |
| "Fortsätt till Designstudion" | Not shown | No studio in this build. |
| **New: pending** | A toast "Originalet bearbetas fortfarande…" if no verdict comes within 120 s. The modal then closes and the library shows "Bearbetas…". | Lesson 3. |
| Replace mode | Unreachable (the button left) | |
| The duplicate hint | Ignores the artwork this modal itself just stored | Without this, a kept rejection would announce itself as a duplicate. |

**Avancerat tab (ProductMapping)**

| Control | In this build | Why (the route forces it) |
|---|---|---|
| "Plagg" select, "Placering" (one slot), "Detalj (valfritt)" | **Replaced** by "Tryckeri" (preselected when the shop may use exactly one printer), "Artikel" (the printer's catalogue: colour/size, garment, model, article number) and "Placering" as checkboxes (only the slots the article's model has a frame for, plus the pocket inside the front, as the Worker's `slotFrame`). One full-width line below shows the **server's** "Inköp X kr inkl. moms · prisgolv Y kr" for the choice (`GET …/pod/design-quote`), or why there is none. | A Worker mapping is product (or variant) → artwork + printer + **printer article** + slots[]. No free-text placement exists. The garment follows from the article. |
| The intro paragraph | New text: how to map, and that each variant whose size or colour is its own article is mapped to it | The older text calls this view a repair tool for the studio's mappings. Here it is the only way to map. |
| "Original" select | Only artworks with status ready | The server refuses any other (`artwork_not_ready`). |
| List rows | One row per mapping. The slot chip shows every slot. The second line shows the printer and article instead of the free-text detail. | |
| **New: a caution chip** on a row | "Pausad — …" for a suspended mapping, "Tryckeriet eller artikeln finns inte längre — …" when the printer or article is not offered any more. The older "Plagg saknas" chip is hidden when this one shows. | The Worker suspends mappings (WG). The old chip's advice ("med plagg valt") does not apply. |
| The strand guard (unpublishing a product from the browser after its last mapping goes) | Leaves | The server does it: a live POD product with no mapping leaves the storefront by the catalogue's own rule, and a delete that would push a price under the floor is refused (shown as the refusal). |
| Toasts | "Koppling sparad · Inköp … · prisgolv …" or "Kopplingen uppdaterad · …" (the server's quote of the whole scope). Refusals are said in Swedish at the form, and the form keeps its values. | |
| After "Lägg till" | Product, original, article and slots reset. The printer stays selected. | |

**Studio tab**: a card "Designstudion kommer snart i den nya adminen…" pointing to Original and Avancerat (`replacements/podStudio.jsx`).

**Page code changes beyond data calls** (all four components in `src/wagons/pod-wagon/components/`): the imports, the moved Firebase code (→ `…Data.js`), the flags/constants above, the new controls listed, two `e?.userMessage ||` fallbacks, and the extra conditions. No class, token or existing element changed. `PodProductPicker.jsx`, `podTier.js` and `usePodLibrary.js` are untouched.

## How each file reaches its data (and how the older build keeps working)

The FC/FK pattern applies: each component's inline Firebase code moved **unchanged** into a data module beside it, which the older build keeps using. `vite.admin.config.js` aliases that module (and the POD utils/config modules) to `src/admin-app/replacements/pod*.js`.

| Imported by the components | Older build | Admin build |
|---|---|---|
| `components/usePodLibrary.js` | (untouched) | `replacements/podLibrary.js`: the hook (same return value). It polls processing renders at 2 → 10 s and quietly re-reads the library on a verdict. |
| `components/artworkLibraryData.js` (new) | the `processPodArtwork` revalidate callable + flags | `replacements/podArtworkLibraryData.js`: rename, `rowAction` (failed → reupload), no replace |
| `components/artworkUploadData.js` (new) | upload → callable → create/replace (moved unchanged) + `gateArtwork` | `replacements/podArtworkUploadData.js`: object upload → POST artwork → poll → verdict / pending / failed |
| `components/productMappingData.js` (new) | `setMapping`, the delete + strand guard (moved unchanged) | `replacements/podProductMappingData.js`: `usePrinterChoice` (printers, article, slots, design quote), `addMapping`, `removeMapping` |
| `components/podStudio.js` (new) | re-exports `DesignStudio` | `replacements/podStudio.jsx` (the stand-in) |
| `utils/podArtwork.js` | (untouched) | `replacements/podArtwork.js` (delete with the 409 sentence; a failed render is only dismissed) |
| `utils/podUpload.js` | (untouched) | `replacements/podUpload.js` (pure helpers copied; the original as a private `artwork_original` object through `uploads.js`) |
| `config/podProfiles.js` | (untouched) | `replacements/podProfiles.js` (`GET …/profiles`, cached **per shop**, degrades to `[]`) |

The reads for one shop are in `replacements/podLibraryLoad.js`, which has no React. **Every read goes through `readForShop`**, so an answer that arrives after the tab changed shop is dropped (lesson 1). Its caches (printers, original metadata, remembered renders) are keyed by shop. The page also remounts on a shop change (`ShopRequired`).

**Not written:** replacements for `utils/podMappings.js` and `config/printRouting.js`. Nothing in this build imports them: the mapping component's data module took over its calls, and only the studio imports them. Their shapes belong to FN's studio, which must choose a printer **article**: the old garment routing has no equivalent for a seller (D52).

**`src/admin-app/Pending.jsx` is now unused** (every line of `pages.jsx` is swapped; I removed its import). The reviewer may delete it.

## Route map

| Page action | Older build | This build |
|---|---|---|
| load | `podArtwork`, `podMappings`, `products`, `settings/podProfiles` | `GET /v1/admin/pod/artwork` + per artwork `GET …/artwork/:id` (preview, notices, reasons) + `GET /v1/admin/objects/:originalObjectId` (type, size, sha256; cached) · `GET …/pod/profiles` · `GET …/pod/mappings` · `GET /v1/admin/products` (all pages) + `GET …/products/:id` for products with variants · `GET …/pod/printers`. At most 4 reads of a kind at once. |
| Ladda upp original | Storage upload + `processPodArtwork` + `addDoc` | `POST /v1/admin/objects {kind: artwork_original}` → `PUT …/content` → `POST /v1/admin/pod/artwork {objectId, profileId, rightsConfirmed: true, label}` (202) → `GET …/artwork/:id` until ready / rejected / failed (or pending after 120 s). A refused create deletes the uploaded object again. |
| Byt namn | — | `PATCH /v1/admin/pod/artwork/:id {label}` |
| Ta bort (original) | Storage delete + `deleteDoc` | `DELETE /v1/admin/pod/artwork/:id` (409 → "har använts i en tryckkoppling…") |
| quote of a choice | — | `GET /v1/admin/pod/design-quote?printerId=&sku=&slots=` (slots = the chosen ones plus those the scope's other active mappings on the same article print) |
| Lägg till | `setMapping` (Firestore) | `POST /v1/admin/pod/mappings {productId, variantId?, artworkId, printerId, sku, slots}` |
| Ta bort koppling | `deleteDoc` + `updateDoc products` | `DELETE /v1/admin/pod/mappings/:id` |

Every request is `adminRequest` (X-Shop-Id). **One number:** the only figures any answer carries are `inkopMinor` and `priceFloorMinor`. They are shown through the product adapter's `podFigures` (öre → kr; Inköp × the production VAT, as FC's form shows it). The tests walk the library's whole output and the printer choices for price fields. The only browser comparison is the server's floor against the product's own price, for an advisory note before saving. The server's refusal decides.

## What works against the dev API

The dev server ran on port 5193 with its own browse session (`BROWSE_STATE_FILE=/private/tmp/fm-browse.json`), signed in as `admin@example.com`, shop Test Shop A, with the real `AppLayout`. Screenshots are in `/private/tmp/fm-shots/`. The dev routes are `src/admin-app/dev/pod-dev.mjs` (invented `pod-fixtures.json`). They reuse FC's products and uploaded objects and keep FC's product quote in step with the mappings, so the product form shows the same Inköp.

**Upload:**
- PNG → "Kontrolleras vid uppladdning" → rights box → "Bearbetar…" → "Tryckfil godkänd och sparad", with the new row ready and its thumbnail (`upload-picked`, `upload-processing`, `upload-done`).
- A name containing **avvisa** → the server's reason in the modal, and the rejected row in the library (`upload-rejected`).
- **misslyck…** → the toast "Filen kunde inte bearbetas på servern — ladda upp den igen."; the modal stays usable (`upload-failed`).
- **långsam** → the library shows "Bearbetas…" at once and keeps polling (`library-processing`).
- The duplicate hint fires for the same bytes under another name.

**Library:**
- Rename via the prompt → PATCH 200, and the new name is shown after the re-read.
- Delete of a mapped original → 409 sentence (`delete-refused`).
- Delete of an unmapped one → gone.

**Mapping:**
- Pick the variant "Vit · S", an original and the article "Vit / S — T-shirt · Unisex t-shirt"; front is preselected; tick Rygg → the line "Inköp 175 kr inkl. moms · prisgolv 254 kr" (`mapping-quote`).
- Lägg till → 201 and the toast with the numbers; the row reads "Bröst + Rygg" (`mapping-saved`).
- **Floor refusal:** the sand variant (329 kr, published) on a hoodie article → the caution line "…produktens pris 329 kr ligger under prisgolvet…", then on save the toast "Produktens pris ligger under prisgolvet för den här kopplingen…". The form keeps its values (`mapping-floor-refused`).
- **Unmap:** the confirm "(Bröst + Rygg)" → DELETE 204 → the row is gone.
- A suspended fixture mapping shows its "Pausad" chip.

**States:**
- 1440 light and dark (`library-1440-*`, `mapping-1440-*`, `studio-1440-dark`).
- 375 light (`library-375-light`, `mapping-375-light-full`): no page-level horizontal scroll (scrollWidth 375). The mapping grid stacks.
- Empty (`admin_dev_pod=empty`): "Inga original ännu…".
- Error (`admin_dev_pod=dark`, a Worker whose POD surface is unconfigured): the toast "Kunde inte ladda POD-data." over the empty block, as the older page does.

**What I saw:**
- The rejected reason and the "Pausad" chip are low-contrast in dark mode. That is the known dark status-token gap (FC noted it), not this unit's.
- At 375 the library rows are tight (the "Används av" pills wrap). The older row had more buttons in the same space.
- Long article texts are cut in the narrow select, so the article's own label (colour / size) comes first.

## Tests (Node), each important behaviour broken once to see its test fail

| File | Tests | Covers |
|---|---|---|
| `src/api/admin/pod.test.mjs` | 13 | Paths, X-Shop-Id, the rights refusal before any request, bodies, 404 → null, refusal codes, the design-quote query |
| `src/admin-app/adapters/pod.test.mjs` | 24 | Profiles, artwork rows (a failed extra read keeps the row), failed rows, render states, names/rename, printer choices with no price fields, pocket rule, picker + exact SKU targets, mapping rows (inactive hidden, paused/lost said), scope slots, quote text, refusal sentences |
| `src/admin-app/dev/pod-dev.test.mjs` | 12 | The dev routes in the Worker's shapes and refusal codes, one number on printers and quotes |
| `src/admin-app/replacements/podLibraryLoad.test.mjs` | 24 | End to end against the dev API: load, shop binding (a late answer after a shop change never settles), per-shop profile cache, upload ready / rejected / failed / pending, a remembered render whose detail read fails stays visible, rename, delete 409, map / unmap, floor and slot refusals |

These mutations were each caught by a failing test: the rights check removed; inactive mappings listed; `readForShop` bypassed; a tracked render forgotten on a failed read; a rename of an unchanged name written; a failed poll read taken as a verdict; pending said as done; a product-level mapping sending a variantId; a preview shown for a non-ready artwork; dismissing a failed row sending a DELETE.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 703  # suites 205  # pass 703  # fail 0     (604 at HEAD + 73 mine + FW's in the tree)
npx vite build --config vite.admin.config.js          ✓ built in 7.01s
node cloudflare/admin/check-admin-build.mjs           admin build: 13 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
  + the bundle searched: no dev marker, no fixture name (Testtryckeriet, hiddenPrices, DEV-TEE, art-fjall), no processPodArtwork, neither forbidden name
npx vite build                                        ✓ built in 11.10s (the older bundle still holds processPodArtwork and the garment form)
node cloudflare/web/check-storefront-build.mjs        storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
node guard/guards.test.mjs                            exit 1: FAIL (b) 3 stale entries: src/wagons/pod-wagon/components/{artworkLibraryData,artworkUploadData,productMappingData}.js
```

**The guard result is expected:**
- The three entries are the new older-build data modules. They import Firebase by design, but they are untracked, and the guard reads `git ls-files`. Once the reviewer adds them, the guard passes at 296.
- **Allowlist:** `ArtworkLibrary.jsx`, `ArtworkUploadModal.jsx` and `ProductMapping.jsx` out (they no longer import Firebase); the three data modules in. The size is unchanged at 296.
- Neither forbidden name appears in any file I created or edited (searched by hand).

## Worker follow-ups (nothing built; the page works around each as described)

1. **The artwork list has no preview address, original type, size or checksum**, so the page reads each artwork's detail plus its original's metadata: 2N reads per load. A `previewUrl` (and the original's `contentType`/`sizeBytes`/`sha256`) in the list would make it one read.
2. **A failed render is not in the list.** Only a tab that saw it processing can show it failed. A co-admin, or the same seller after a reload, never sees it. Suggested: failed renders in the list for some days, or `GET …/artwork?include=failed`.
3. **An artwork can never be deleted once ANY mapping named it**, even after that mapping was removed, because rows stay inactive. So the library only grows. Suggested: an "archive" that hides it from the library and the mapping form while keeping the print file.
4. **No in-place file replace** (the old "Ersätt fil": the same id, so every product picks up the new file). Today: delete (only if never mapped) and upload again, then re-map.
5. **The design quote does not know the product's scope.** The page sends the union of the slots the scope already prints on that article. A `productId`/`variantId` parameter would let the server answer exactly what the mapping write will check.
6. **Artwork creation is limited to 5 per minute per IP.** Uploading melodie-mc's artworks in one sitting will hit it. The page says "Vänta en minut och försök igen" (429).
7. The seller sees the printer's name and the supplier's article numbers (WG open question 1). The label is not screened (WG open question 2).

## How Kent brings a hidden POD product of melodie-mc back (staging)

Kent signs in **himself** (not a platform user acting as the shop: see open question 1) at `https://chopshop-admin-stg.kent-ee2.workers.dev/login`. Then:

1. Open **Print on demand** in the menu (the shop's `pod` feature must be on).
2. **Original → Ladda upp original**:
   - Tryckändamål "Textiltryck…" (whatever the platform's profile is called).
   - A name ("Logga – bröst").
   - The full-resolution file.
   - Tick **"Jag har rätt att använda detta motiv"**, then **Spara original**.
   - Wait for "Tryckfil godkänd och sparad". If the server rejects the file, the reason is shown: upload a larger original. "Bearbetas…" means wait. Repeat for each motif (front and back are separate originals).
3. **Avancerat**, for each of the six products:
   - Under **Produkt**, choose the product ("— alla varianter") if it is one article at the printer. If each size or colour is its own article at the printer, choose **each variant** in turn.
   - Under **Original**, the approved motif.
   - **Tryckeri** (preselected when there is one).
   - **Artikel**: the colour/size that matches the product or variant.
   - **Placering**: Bröst and/or Rygg.
   - Read the line **"Inköp … · prisgolv …"**, then press **Lägg till**.
   - A different motif on the back of the same article is a second mapping with "Rygg" only.
4. If the toast says the price is under the floor, raise the product's (or variant's) price under **Produkter** to at least the floor shown, then press Lägg till again.
5. Once the whole product, or every one of its variants, is mapped, it leaves "hidden". Check it in **Produkter** (the form now shows Inköp and Prisgolv) and on the storefront.

**On staging today**, the only printer a shop can map to is `fake-printer`, with the two SKUs the slice seed put on it (`2700003`, `2700004`: SnapWear model 18000, a **sweatshirt**, "White / S" and "White / M"). The imported SnapWear printer is inactive on staging. So a real mapping of all six products needs the platform to activate a printer whose catalogue holds their articles (the FK page), or to extend `fake-printer`'s catalogue.

## Open questions for Mikael

1. **Rights confirmation while acting-as.** The Worker accepts an artwork upload from a platform user acting as the shop, and the rights box is then the operator's confirmation (`created_by` = the operator). The terms and the legal pages are refused while acting-as. Should artwork uploads be refused too, so that only the seller confirms rights to a motif?
2. **The new texts need your words:** the mapping intro, the line after an upload, the pending note, the Studio card, the caution chips. Also: the older "Preliminära trycksparametrar" banner is kept. Is it still true?
3. The pill "Kontrolleras vid uppladdning" uses the green "pass" tone, as the older page did for files it could not measure. Do you want a neutral tone?
4. Supplier visibility (WG open question 1) now shows on a seller page: the printer's name and the supplier's article numbers in the Artikel select and the list.
5. "Ladda upp igen" opens a new upload, so the seller picks the file and confirms rights again. It does not re-post the failed object silently. Is that right?

## Files

**Created**
- `src/api/admin/pod.js`, `src/api/admin/pod.test.mjs`
- `src/admin-app/adapters/pod.js`, `src/admin-app/adapters/pod.test.mjs`
- `src/admin-app/replacements/podLibrary.js`, `podLibraryLoad.js`, `podLibraryLoad.test.mjs`, `podArtwork.js`, `podArtworkLibraryData.js`, `podArtworkUploadData.js`, `podProductMappingData.js`, `podProfiles.js`, `podUpload.js`, `podStudio.jsx`
- `src/admin-app/dev/pod-dev.mjs`, `pod-dev.test.mjs`, `pod-fixtures.json` (invented)
- `src/wagons/pod-wagon/components/artworkLibraryData.js`, `artworkUploadData.js`, `productMappingData.js` (older build, Firebase, moved code), `podStudio.js`
- `docs/cf-port/CP5_FM_REPORT.md`

**Modified (mine)**
- `src/wagons/pod-wagon/components/PodAdminPage.jsx` (the studio import through `podStudio`, the studio link flag)
- `ArtworkLibrary.jsx`, `ArtworkUploadModal.jsx`, `ProductMapping.jsx` (data layer and the controls listed in (a))

**Modified (shared, my lines only)**
- `src/admin-app/pages.jsx`: the `PodAdminPage` line swapped; the now-unused `pending` import dropped
- `vite.admin.config.js`: 8 alias rows under "Unit FM"
- `src/admin-app/dev/dev-api.mjs`: one import, `...POD_ROUTES` at the end of the admin table
- `guard/allowlist.txt`: three entries out, three in
