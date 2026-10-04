Model: claude-opus-5-5 (Opus 5.5)

# CP5-FO report: the platform's 3D models page on the API

I built this in the working tree on `cf-port`, starting from HEAD `7b7ef29d`. Rules I kept:
- No git command that writes, no network except localhost, no wrangler, no deploy.
- I did not touch `cloudflare/`. Another builder changed files there during my run (`app.ts`, `dispatch/*`, migration `0051`, …). They are not mine.
- The older build's dev server was never started.

## (a) What leaves or changes, control by control (admin build only; the older build is unchanged)

| Control | What happens | Why |
|---|---|---|
| **Card: "Ta bort"** (delete the model and its files) | **Leaves.** `DELETE_MODEL` is false, so the page passes no `onDelete`, and `ModelCardGrid` renders the button only when it gets one. The row closes up to "Redigera · Inaktivera/Aktivera". The confirm "… Alla uppladdade filer raderas." is not in the bundle (checked). | The Worker deletes no model and no studio file (CP5_WH: deactivate). The card already has "Inaktivera", so a delete-as-deactivate would be a second copy of it, under a label that promises something else. |
| **Editor: "Ta bort" on one colourway**: the confirm text | **Changed** in this build to: *Vill du ta bort färgvägen "X"? Den tas bort från modellen; de uppladdade bilderna finns kvar på servern.* The old text was "… Filerna raderas." | The colourway leaves the model (a PUT without it), but its images stay in the public bucket. Nothing deletes a studio file. |
| Card: "Redigera" | Kept. It now **re-reads the list first** and opens the editor on the server's model, never on the list's row. While it reads, the card's toggle shows "…". A failed read shows a toast and opens nothing. | Required by the brief: there is no revision fence, so the editor must not start from a stale row. |
| Editor: Avbryt, ✕, a click on the backdrop | Kept, but **locked while a write runs**: a click does nothing until the answer comes. | No closing that drops an in-flight answer. |
| Editor: Spara, Lägg till färgväg, Ta bort (colourway) | Kept, but **locked while any write runs**: a second click sends nothing. | No second write; the answer lands in the editor it was sent for. |
| "Ny modell", Aktivera/Inaktivera, the editor's fields and sliders, uploads, calibration | Kept. | Every one has a route (see the route map). |
| Error texts | Each place that showed a fixed "Kunde inte …" now shows `e.userMessage` first: a Swedish sentence with the server's reason. Those places are the list, the toggle, the delete, the create modal, and the new "open" toast. The editor already showed `err.message`; this build's errors carry the Swedish sentence there. | Lesson from Codex on FK. |

**Page code changes beyond imports and data calls:**
- `PlatformModels.jsx`:
  - `openEditor`: re-reads before the editor opens, and nothing else opens while a card is busy.
  - `saveFromEditor`: every editor write updates its card when the build answers the stored model.
  - The `DELETE_MODEL` flag on `onDelete`.
  - `stored || { …m, active }` on the toggle.
  - The `userMessage` fallbacks.
  - One new fallback text, "Kunde inte öppna modellen". The older build cannot reach it, because its `readModelForEditor` answers the row it is given.
- `ModelCardGrid.jsx`: `{onDelete && (…)}` around the button.
- `ModelEditor.jsx`:
  - the write lock (a ref, and `close()`);
  - `entry.fileIds` (one line: the new colourway names its images by id);
  - the resync after "Lägg till färgväg" and "Ta bort", from the stored model the write answers. In the older build that answer is `undefined`, so the editor keeps its own values as before;
  - the confirm text, from the data module.

No class, token or element changed except the conditional wrapper around the delete button.

## Route map

Every call is a `platformRequest`, so no request carries `X-Shop-Id`. The tests check this on every request. The API section is `CP5-FO` in `src/api/admin/platform.js`.

| Page action | Older build | This build |
|---|---|---|
| load | `getDocs(pod3dModels)` | `GET /v1/platform/pod/3d-models`. It answers every model (inactive ones too) and the `files` they name. |
| Redigera (open) | the list's row | the same GET again; the editor opens on the stored model |
| Ny modell | `addDoc` (Firestore mints the id) | `PUT …/3d-models/:id`. The id is made in the browser. The answer is 201. |
| Aktivera / Inaktivera | `updateDoc {active}` | `PATCH …/3d-models/:id {active}` |
| Lägg till färgväg | originals + derivatives to Storage, then a dot-path `updateDoc` | `POST /v1/platform/pod/studio-files` once per derivative (photo, map, mask), then a `PUT` of the whole document |
| Ta bort (colourway) | Storage prefix sweep + `updateDoc` with `deleteField()` | a `PUT` of the whole document without that colourway. The files stay. |
| Spara | dot-path `updateDoc` | a `PUT` of the whole document |
| Ta bort (model) | Storage sweep + `deleteDoc` | none (the control leaves; `deleteModel` refuses with `not_available`) |

## How each operation maps onto the Worker

**Shapes** (`src/admin-app/adapters/platformModels.js`, pure, 17 tests):
- `pageModelOf(model, files)` turns the Worker's `PlatformModel` into the older document the page reads:
  - colourways become a map by id, with `photoUrl` / `displacementUrl` / `maskUrl` taken from `files`;
  - `printAreaMm` moves to the top, keyed by view;
  - `originalDims`, the tuning, `perColorway` and `output` are kept;
  - each page colourway also carries `fileIds: { photo, displacement, mask }`, which no markup reads.
- A view the editor does not show (`back`) is carried through untouched.
- Round trip: `modelBodyOf(pageModelOf(x))` gives exactly what the Worker stores (tested with `workerShape`).

**Create.**
- `newModelId()` makes 20 characters of `[A-Za-z0-9]` from Web Crypto. It skips any byte ≥ 248, so every character is equally likely. That matches the Worker's `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` and looks like Firestore's own ids.
- `newModelBody(label)` is the older page's defaults: one front view, `w/h` null, a zero print rect, 30 × 40 cm, no colourways, scale 30, blur 6, multiply, alpha 0.8, `output` null. This is the uncalibrated model the Worker accepts.
- Firestore's `scope: 'platform'` has no column and is not sent.
- The 201 answer is the model the editor opens on.

**Partial updates.** The editor still writes Firestore-style dot-path patches. In this build `deleteField()` and `serverTimestamp()` are markers from the data module, not Firebase's. Each write goes through `saveModelDoc(modelId, patch)`:
1. **The base** is the model as the server last answered it. A module-level map holds it; every GET, PUT and PATCH answer replaces it. So a toggle's `active` is never overwritten by a later save.
2. **`applyModelPatch`** applies the dot-paths. `DELETE_FIELD` removes a key. The server time is dropped. A path with an empty or unsafe segment throws.
3. **`modelBodyOf`** builds the PUT body. It also lists, as Swedish sentences, every value the Worker would refuse, and nothing is sent while there is one:
   - a name longer than 80 characters;
   - a print rect that is not whole pixels in 0..20 000;
   - a print size over 200 × 200 cm;
   - `output` outside 1..20 000;
   - tuning values out of the Worker's ranges (opacity 0..1, …);
   - an unknown blend;
   - more than 40 colourways;
   - a bad colourway id or name;
   - a colourway without its file ids.
4. **The answer** becomes the new base, and the editor follows it:
   - after "Lägg till färgväg" and "Ta bort", the colourways, the view's `w`/`h`, `originalDims` and a seeded print rect come from the answer;
   - unsaved field edits stay local, as before;
   - "Spara" closes the editor and reloads the list, as before;
   - the card behind the editor follows every write (`saveFromEditor`).

**Uploads.** The derivatives are made in the browser by `validateModelAssetSet`, `makeWebDerivative` and `measureMapContrastSd`. I kept those helpers byte for byte in `pod3dUpload.js`; only the Firebase half moved out. Then:
1. The size check: a derivative over 15 MiB is refused with a Swedish sentence before any request (`derivativeSizeProblem`, rounded up, e.g. "15,1 MB"). With a 1600-px long edge this practically never happens; the check is there anyway.
2. Each derivative is sent with its own type stated (`image/webp`, or `image/png` when the browser cannot make WebP). I saw WebP in Chromium.
3. The editor gets `photoUrl` etc. and `fileIds` from the answers. `derivative` is the server's measure of the stored photo.
4. **The raw originals are not uploaded**: the Worker has no home for them. Their size (`original`) is still stored as the view's `originalDims`, and it still checks the next colourway (`expectedOriginalDims`). I saw this work: a second 2000 × 2500 colourway passed, and a map in another size was refused in the browser.

**Delete.**
- A model cannot be deleted; deactivating it is the existing toggle.
- Removing one colourway is a PUT without it, plus its `perColorway` entry. **Its three files stay in the public bucket**, readable at their unguessable `platform/studio/<uuid>/…` address; I checked in the dev state that they are still there.
- **Orphan cleanup** after a failed upload or save has no equivalent. `deleteColorwayAssets` does nothing in this build, so the images already uploaded stay in the bucket, unreferenced. This includes the photo and map when the mask then failed.

**A lost answer** is `network_error`, an unreadable 2xx, or any 5xx. It is read back before the page says anything:
- **PUT** (create or save): GET the list, then compare the stored model with the body sent (`sameModel`: Worker-shaped, defaults filled, empty overrides dropped, colourway order counted).
  - Equal → success, with the stored model.
  - Not equal or missing → "Anslutningen bröts och ändringen sparades inte / modellen skapades inte. Försök igen."
  - The GET fails too → "Anslutningen bröts och det är oklart om …. Ladda om sidan och kontrollera innan du försöker igen."
- **PATCH**: the same steps, comparing `active`.
- **Upload**: there is nothing to read a file back by, so the same bytes are sent once more. The Worker answers 200 with the file that already holds them, so no copy is stored. If the second try is also lost: "Anslutningen bröts när plaggfotot laddades upp. Försök igen — samma bild sparas inte två gånger."
- D1 writes a model in one batch, so a 5xx thrown in the middle of the write leaves either everything or nothing, and the read-back decides which.

**The seller's cache.**
- The page and the editor still call `clearPod3dModelsCache()` after each write. The alias list resolves that to FN2's admin `pod3dModels.js`.
- The data module also clears it after every write attempt, including one whose outcome is unknown.
- A test shows the seller's studio reads the models again after a platform write in the same tab.

**Images and the CSP.** I read `cloudflare/admin/src/headers.ts`; I did not change it.
- The calibration preview is an `<img>` with a CSS overlay. **No canvas on this page reads a bucket image.** The only canvases (the derivatives and the contrast measure) draw the operator's own file through a `blob:` address, which is same-origin, so they are never tainted.
- So I added no `crossOrigin`. It would change markup, and it would make the `<img>` fail if the bucket ever lost its CORS rule, for no gain. **The brief assumed a canvas here; there is none.**
- What the page loads is allowed by the enforced CSP as it is:
  - `img-src` has `blob:`, `data:` and the public object origin;
  - `connect-src 'self'` covers the uploads to `/_api`.

## What I exercised and saw

The dev API ran on port 5197 with the browse session at `/private/tmp/fo-browse.json`. I signed in as `platform@example.com`. Shots are in `/private/tmp/fo-shots/`. The input files are invented PNGs (2000 × 2500, so the derivatives are 1280 × 1600) in `/private/tmp/fo-shots/inputs/`.

| Step | Seen | Shot |
|---|---|---|
| The list | Always dark, inside PlatformLayout, with "3D-modeller" back and active in the menu. Three invented models (one inactive, one uncalibrated). No "Ta bort" on the cards. | `list-1440`, `list-375` (scrollWidth 375: no page scroll) |
| Open the editor | A `GET …/3d-models` before the editor opens; the colourways and the override (screen / 0.9) come from the server. | `editor-open-1440` |
| Create | `PUT …/3d-models/Ao5NPbmvt2EwCOgLjETq → 201`; the editor opens on the answer. | `created-editor-1440` |
| Add a colourway (photo, map, mask) | 3 × `POST studio-files → 201` (WebP 1280 × 1600, sizes read by the dev API), then `PUT → 200`. The thumbnail shows, the print rect is seeded and drawn on the photo, and the card behind turns blue. | `colorway-added-1440`, `calibration-seeded-1440` |
| Calibrate and save | Rect 380/470/520/693 and a new name; `PUT → 200`, "Modell sparad", the list reloads. | `calibrated-before-save-1440` |
| Reload and reopen | Name and rect held; `originalDims` 2000 × 2500 and `mapContrastSd` stored. | `reload-held-1440` |
| Refused in the browser | A map in another size: "Fotot och displacement-kartan måste ha exakt samma pixelmått (foto: 2000×2500, karta: 1000×1250) …". No request. | `refused-registration-1440` |
| Refused upload (`reject-file`) | "Plaggfotot togs inte emot: servern tar bara emot PNG, JPEG, WebP eller AVIF." | `refused-upload-1440` |
| Refused save (`refuse:not_registered`) | The toast "Foto, displacement-karta och mask har inte samma pixelmått på servern …"; the editor stays open. | `refused-save-1440` |
| Refused before any request | 250 cm wide: "Tryckytans storlek får vara högst 200 × 200 cm." 0 requests. | `refused-before-request-1440` |
| Lost answer (`lost`) | `PUT → 502`, then the read-back `GET → 200`, then "Modell sparad". | `lost-answer-saved-1440` |
| Not done (`drop`) on Inaktivera | `PATCH → 502`, read-back, then "Anslutningen bröts och statusen ändrades inte. Försök igen." | `drop-toggle-1440` |
| Unclear (`unclear`) | `PATCH → 502`, read-back `GET → 500`, then "… det är oklart om statusen ändrades. Ladda om sidan …". | `unclear-toggle-1440` |
| Deactivate, then activate | `PATCH → 200`, the badge says Inaktiv, then Aktiv again; held after a reload. | `deactivated-1440` |
| Remove a colourway | The new confirm text (read from the dialog), `PUT → 200`, "Färgväg borttagen"; the files are still in the dev state. | `colorway-removed-1440` |
| Second colourway with a flat map | It registers against `originalDims`; 2 × POST (no mask) + PUT; the low-contrast warning shows. | `second-colorway-low-contrast-1440` |
| The lock (`drop`, after an edit) | In one tick: Spara × 2, Avbryt, ✕, a backdrop click. Result: **one** PUT, the editor stays open with the draft, then "… sparades inte". | `locked-during-save-1440` |
| Editor at 375 | Usable. | `editor-375`, `editor-calibration-375` |
| Empty / error | "Inga modeller ännu." / the empty block plus "Modellerna kunde inte läsas: servern svarade med ett fel (HTTP 500)." The toast appears twice: that is React StrictMode's double effect in dev, as FK saw. | `empty-1440`, `error-1440` |
| Create past the limit (`limit`), at 375 | `PUT → 409`: "Plattformen har redan 100 modeller. Inaktivera eller återanvänd …" in the modal. | `refused-create-375` |

The dev environment's scenarios are set with the cookie `admin_dev_fo`: `empty`, `error`, `dark`, `reject-file`, `limit`, `refuse:<reason>`, `lost`, `drop`, `unclear`. They are listed in `models-dev.mjs`.

Two things I saw that are not caused by this unit:
- **The browse tool reloads the page** when a cookie is set and on some of its own timeouts, which closed an open editor twice. To rule out the app, I opened the editor, set a mark on `window`, and dispatched `focus` and `visibilitychange`: the mark and the editor survived.
- **At 375 the modal's own content is 25 px wider than the modal** (`w-40` / `ml-40` on the slider rows). The page itself does not scroll sideways. The markup is unchanged and the older page has the same overflow.

## Visible differences from the older page

1. Cards have no "Ta bort"; the colourway confirm says the images stay. See (a).
2. Redigera reads the server first (the card's toggle shows "…" for that moment).
3. While a write runs, the editor cannot be closed and no second write starts.
4. Errors say the server's reason, or what was refused before sending, in Swedish.
5. After "Lägg till färgväg" or "Ta bort", the card behind the editor already shows the change. The older page updated it only after Spara.
6. New colourways keep only the web derivatives; no raw originals are stored anywhere. Their addresses are public-bucket URLs.
7. A colourway whose id is all digits (named e.g. "2") is listed first after it is read back, because JavaScript orders such object keys first. The older Firestore map had no order of its own either.
8. The Aktiv/Inaktiv badge is hard to read over a light photo (`bg-green-500/15`, `bg-gray-500/15`). The markup is unchanged; the older page looks the same.

## Worker follow-ups (not built)

1. **No revision fence on `PUT …/3d-models/:id`.** The last write wins: two tabs or two operators silently overwrite each other's edits. This includes "Lägg till färgväg" in one tab while the other tab later saves an older base. Suggested: `expectedUpdatedAt` (or a revision column) with a 409 on mismatch. I invented no fence.
2. **No create-only precondition.** A PUT with an existing id replaces that model. The client's random 20-character id makes a collision practically impossible, but the Worker cannot refuse one. Suggested: `If-None-Match: *` or a POST create.
3. **No single-model GET.** Opening the editor and every read-back read the whole list with every file entry. That is fine at today's size, but the limits allow 100 models and 24 000 files.
4. **A partial update** (a PATCH of one view or colourway) would remove the read-modify-write window altogether.
5. **Nothing deletes a studio file** (WH open question 4). Removed colourways and failed uploads leave public files in the bucket; a sweep of unreferenced files is needed eventually.
6. **No lookup of a studio file by sha256.** A lost upload answer is resolved by sending the same bytes again: that works, but costs a second transfer of up to 15 MiB.

## Open questions for Mikael

1. **Deleting a model:** I removed the button, since deactivating exists. Is deactivate enough, or should the Worker get a real delete (with its file sweep)?
2. **Raw originals:** new colourways keep no master anywhere, only the 1600-px derivatives (this follows WH question 2). Is that acceptable?
3. **Orphaned public files:** the images of a removed colourway, or of a save that failed after the upload, stay readable at their unguessable addresses. Is that acceptable until a sweep exists?
4. **The new confirm text** (colourway removal) needs your words if you want others.
5. **The faint status badge** over light photos is a design follow-up for the card (pre-existing).

## Reviewer wiring

- **Track `src/pages/platform/platformModelsData.js`.** It is in `guard/allowlist.txt`, and until it is tracked the guard reports it as stale (b). Once added, the guard passes at **294** and refreshes the baseline (296 → 294).
- Nothing under `cloudflare/` is needed:
  - the admin Worker forwards `/v1/platform/`;
  - the CSP already allows what the page loads (see "Images and the CSP");
  - this page needs no CORS on the bucket (the studio's need for CORS is FN2's and stays).
- On staging, the upload route is dark without `PUBLIC_BUCKET` and a valid `PUBLIC_OBJECT_BASE_URL`. The page then says "Uppladdning av studiobilder är inte påslagen i den här miljön." `0049` is on staging according to the handover.
- **Shared lines I changed because 3D-modeller came back:**
  - FB's alias row description in `vite.admin.config.js` ("(3D-modeller, DAC7, Leads leave)" became "(DAC7, Leads leave)");
  - FB's assertion in `src/admin-app/replacements/shells.test.mjs` (`LEFT_PLATFORM_PATHS` is now `/dac7`, `/leads`; the nav keeps `/models`).
- **Not mine, for the reviewer:** FN's alias row for `src/config/pod3dModels.js` still says "the 3D view is off until unit FN2: no models are read". FN2 made it the real loader. I left it.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 837  # suites 246  # pass 837  # fail 0     (789 at HEAD, not 786 as briefed; +48 in 4 new files: 17 + 6 + 11 + 14)
npx vite build --config vite.admin.config.js          ✓ built in 9.00s
node cloudflare/admin/check-admin-build.mjs           admin build: 27 files (21 text) checked, no Firebase code, no source map, no secret, every file servable.
npx vite build                                        ✓ built in 12.31s (the older bundle still holds the Firebase page and its delete)
node cloudflare/web/check-storefront-build.mjs        storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
node guard/guards.test.mjs                            exit 1: FAIL (b) 1 stale entry: src/pages/platform/platformModelsData.js
node rules-tests/one-number-pure.test.cjs             53 passed, 0 failed
```

- **The guard failure is expected.** The new older-build data module is untracked, and the guard reads `git ls-files`. The module does import Firebase. Allowlist: 3 out (`ModelEditor.jsx`, `PlatformModels.jsx`, `pod3dUpload.js`), 1 in (`platformModelsData.js`). The count goes from 296 to 294, so it never grew.
- **Bundle checks.** In the admin bundle:
  - the page's texts are present ("3D-modeller", "Ny modell", the new confirm, both routes);
  - no dev data (`admin_dev_fo`, fixture ids and names, `models-dev`, the dev marker);
  - no older delete texts;
  - no match of the guard's two name families. I scanned every file of `dist` with the guard's own expressions.
- **My files.** No created or edited file of mine matches the two name families. Only `src/pages/platform/platformModelsData.js` matches the Firebase family, which is expected.
- **Mutation checks** (each run once, then restored and compared byte for byte):

| Mutation | Result |
|---|---|
| no read-back after a lost PUT | 2 failed |
| no seller-cache clear | 1 failed |
| no second upload try | 1 failed |
| the PUT body drops `maskFileId` | 3 failed |

## Files

**Created**
- `src/pages/platform/platformModelsData.js`: the older build's data module. It holds the page's and the editor's Firebase code and the Storage half of `pod3dUpload.js`, moved unchanged.
- `src/admin-app/replacements/platformModelsData.js`: the alias target. It adds the browser half of the upload to the core.
- `src/admin-app/replacements/platformModelsCore.js` + `.test.mjs`: the API, the last-answer cache, the read-back, the network half of the upload. The test runs end to end against the dev API, with the editor's own patches.
- `src/admin-app/adapters/platformModels.js` + `.test.mjs`
- `src/api/admin/platform-models.test.mjs`
- `src/admin-app/dev/models-dev.mjs`, `models-dev.test.mjs`, `models-fixtures.json` (invented)
- `docs/cf-port/CP5_FO_REPORT.md`

**Modified (mine)**
- `src/pages/platform/PlatformModels.jsx`
- `src/components/platform/ModelEditor.jsx`
- `src/components/platform/ModelCardGrid.jsx`
- `src/utils/pod3dUpload.js`: the Firebase upload and delete moved out; the three browser helpers are byte for byte as before.

**Modified (shared, my lines only)**
- `src/api/admin/platform.js`: the `CP5-FO` section, appended.
- `vite.admin.config.js`: 1 alias row, plus FB's row description (see Reviewer wiring).
- `src/admin-app/pages.jsx`: the `PlatformModels` line.
- `src/admin-app/PlatformApp.jsx`: the `/models` route and the header comment.
- `src/admin-app/replacements/platformLayoutData.js`: `/models` removed from `LEFT_PLATFORM_PATHS`, and the header comment.
- `src/admin-app/replacements/shells.test.mjs`: FB's assertion of what leaves.
- `src/admin-app/dev/dev-api.mjs`: one import, and `...MODEL_ROUTES` at the end of the platform table.
- `guard/allowlist.txt`: 3 entries out, 1 in.
