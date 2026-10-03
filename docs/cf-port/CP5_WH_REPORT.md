Model: claude-opus-5-5 (Opus 5.5)

# CP5-WH: the design studio's platform-owned assets on the Worker

Working tree only. Nothing is committed, deployed or run against staging, and the import script has not been run against anything but its local fake. Every number below comes from a run I made.

## Files

Created
- `cloudflare/migrations/0049_pod_studio_assets.sql`: seven tables, all platform-scoped
- `cloudflare/src/pod/studio-files.ts`: the platform file registry and its upload
- `cloudflare/src/pod/studio-assets.ts`: the parsers, the reads, the writes, and the three shapes (input, platform, seller)
- `cloudflare/src/routes/pod-studio-assets.ts`: the nine routes
- `cloudflare/test/pod-studio-assets.test.ts` (38 tests)
- `scripts/cf-port/migrate/import-studio-assets.mjs`: the import
- `scripts/cf-port/migrate/lib/transform-studio-assets.mjs`: the export's documents turned into the Worker's bodies (pure)
- `scripts/cf-port/migrate/lib/studio-copy-manifest.mjs`: the copy manifest, keyed by (sourceKey, kind)
- `scripts/cf-port/migrate/test/import-studio-assets.test.mjs` (11 tests)

Modified
- `cloudflare/src/app.ts`: the `CP5-IMPORTS-H` and `CP5-ROUTES-H` blocks, and `REQUIRED_MIGRATION` moved to `0049_pod_studio_assets.sql`
- `cloudflare/test/health.test.ts` and `cloudflare/test/public-catalog.test.ts`: the migration pin moved to 0049. `test/slice-harness.ts` does not pin a migration, so it needed no change.

No `wrangler.jsonc` var was added. No file outside the brief's list was touched.

## D101 as built: where platform-owned studio images live

I took the default as written:

- **Their own tables.** `pod_studio_files` is the file registry. Six more tables hold the templates and the models. No table has a tenant column. `stored_objects` cannot hold these files, because it requires a tenant and a `shops/<tenant>/` key (0006).
- **The PUBLIC bucket, under `platform/studio/<fileId>/v1/image.<ext>`.** A CHECK on `object_key` pins it to exactly `'platform/studio/' || file_id || '/v1/image.' || <ext of content_type>`. A platform file therefore cannot sit under `shops/`. A test inserts a `shops/…` key and a key under another file's id, and both are refused.
- **Rows hold file ids and keys, never addresses.** An address is built at read time from `PUBLIC_OBJECT_BASE_URL` with the CP4 helper `publicObjectUrl`. Without a valid base, the seller shapes leave out the URL fields and the upload route is dark (404).
- **Only platform routes write.** Each write requires a platform principal and is same-origin. Every write is audited (`tenant_id` NULL). Every other caller gets the opaque 404. No tenant route touches these tables.
- **The type comes from the file's own first bytes** (`image-sniff.ts`). Only PNG, JPEG, WebP and AVIF are accepted, and the stated `Content-Type` must equal the proven type. The cap is 15 MiB, which is D92's public cap.
- **No SVG, GIF or icon.** The studio draws its flat garments from its own React code (`garments/*.jsx`). Every uploaded studio asset is a raster photo, displacement map or mask: the seed's `.webp` files and `pod3dUpload.js`'s WebP/PNG derivatives.
- **A file's identity is its sha256** (`UNIQUE`). The same bytes uploaded again return the file that already holds them. A trigger keeps the key, the type, the hash and the size immutable, and stops an active file from going back to pending.
- **Nothing deletes a studio file.** Templates and models are deactivated, not deleted (see the open questions).

I found no better home in the code. One alternative was the old site's hosting paths (`/pod-garments/…` in `public/`), which the admin build would also serve. I rejected it: new garments or 3D models would then need a code deploy, and the 3D models were never there anyway (they were uploads to Storage).

**What a template is tied to:** a **garment**, in the printers' vocabulary (`PrinterModel.garment`; CHECKed lowercase token grammar). Its areas use `PRINT_SLOTS`. I store no printer id or model key. The studio already decides "is this template offered" by garment (`DesignStudio.jsx templateOffered`), and a template serves every printer that makes that garment. FN filters `templates` by `printers[].garments` from `GET /v1/admin/pod/printers`. If a per-printer tie is ever needed, a nullable column can be added later.

## Schema (0049)

Times are ISO-8601 UTC text, with the round-trip CHECK used by 0042, 0044 and 0046. Pixels are integers in 0..20000; a template rect's width and height must be at least 1. Millimetres are 1..2000 (the printers' `MAX_AREA_MM`). Blend is one of `normal | multiply | screen | overlay | add` (the compositor's `ALLOWED_BLENDS`). Alpha is 0..1, scale 0..1000, blur 0..100, contrast 0..20.

| table | key | holds |
|---|---|---|
| `pod_studio_files` | `file_id` (uuid) | `object_key` (CHECKed prefix), `content_type` (4 raster types), `size_bytes` ≤ 15 MiB, `sha256` UNIQUE, `width_px`/`height_px` (NULL = not found in the head), `status` pending/active, `created_by`, times; immutability trigger |
| `pod_mockup_templates` | `template_id` `[a-z0-9][a-z0-9_-]{0,63}` | `label`, `garment` `[a-z][a-z0-9_-]{0,39}`, `profile_id` (not an FK: the profile list is replaced wholesale), `active`, `provisional`, `sort_order`, `photo_w/h_px` (both or neither), the displacement `map_w/h_px`, `map_front/back_file_id` (FK), `map_scale/blur/contrast/blend/alpha`, `pocket_left/center/right_x_px`, `created_by`/`updated_by`, times. CHECKs: a map only on a photo template, a map needs at least one file, no map means no map fields |
| `pod_mockup_template_areas` | (`template_id`, `slot` ∈ PRINT_SLOTS) | `x/y/w/h_px`, `w/h_mm`, `offset_top_mm`, `slot_label` |
| `pod_mockup_template_colorways` | (`template_id`, `colorway_id`), UNIQUE `position` | `label`, `hex` (`#` + 6 hex), `front/back_file_id` (FK, NULL = "Foto saknas"), the colourway's tuning override (`blend`, `alpha`, `displacement_scale/blur/contrast`) |
| `pod_3d_models` | `model_id` `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` (keeps Firebase's 20-character ids) | `label`, `active`, the tuning, `output_w/h_px`, `per_colorway_json` (json_valid, object, ≤ 16 KiB; checked key by key by the parser) |
| `pod_3d_model_views` | (`model_id`, `view_id` ∈ front/back) | `w/h_px` (NULL until the first colourway), `print_x/y/w/h_px` (a zero rect = uncalibrated), `print_w/h_mm`, `original_w/h_px` |
| `pod_3d_model_colorways` | (`model_id`, `view_id`, `colorway_id`), UNIQUE `position` | `label`, `photo_file_id`, `displacement_file_id`, `mask_file_id` (FKs), `map_contrast_sd` (platform-only hint) |

D1 refuses a GLOB pattern longer than 50 characters. That is why the hex CHECK is `substr(hex,2) NOT GLOB '*[^0-9a-fA-F]*'` and not six character classes; the first version hit this in the tests.

Bounds enforced by the routes: at most 100 templates and 100 models (a new one past that gets 409 `limit_reached`), 40 colourways per template or model view, and 100 per-colourway overrides.

## Route contracts

All answers are `Content-Type: application/json`, `Cache-Control: no-store`. "The opaque 404" is `404 {"error":{"code":"not_found","message":"Route not found"}}`.

### Seller (tenant admin + `X-Shop-Id`, GET only)

Guard: `authorizeTenantAdminRequest`, the same guard as `/v1/admin/pod/printers`, `/mappings`, `/quote` and `/design-quote`. Membership, or the platform user's acting-as grant on that shop, is accepted. No session, no `X-Shop-Id`, a foreign shop or any other method gets the opaque 404. It is not gated on the shop's `pod` feature, because its sibling routes are not either.

**`GET /v1/admin/pod/mockup-templates`** → 200

```json
{ "provisional": false,
  "templates": [
    { "id": "tee_bc_e150", "label": "T-shirt", "garment": "tee", "profileId": "apparel_dtg", "provisional": false,
      "colorways": [ { "id": "white", "label": "Vit", "hex": "#f3f3f3" }, { "id": "black", "label": "Svart", "hex": "#363435" } ],
      "printAreas":  { "front": { "x": 342, "y": 411, "w": 276, "h": 322 }, "back": { … }, "pocket": { … }, "left_sleeve": { … } },
      "printAreaMm": { "front": { "w": 300, "h": 350 }, … },
      "printOffsetTopMm": { "front": 65, "back": 85 },
      "pocketPositions": { "left": { "x": 535 }, "center": { "x": 434 }, "right": { "x": 333 } },
      "photo": { "w": 960, "h": 1093,
                 "urls":     { "white": "https://<public base>/platform/studio/<fileId>/v1/image.webp" },
                 "backUrls": { "white": "https://…" },
                 "displacement": { "w": 1920, "h": 2186,
                                   "urls": { "front": "https://…", "back": "https://…" },
                                   "scale": 30, "blur": 6, "contrast": 2, "blend": "multiply", "alpha": 0.8,
                                   "perColorway": { "black": { "blend": "normal" } } } } },
    { "id": "bag_flat", "label": "Tygkasse", "garment": "bag", "profileId": "bag_dtg", "provisional": true,
      "colorways": [ … ], "printAreas": { "front": { … } }, "printAreaMm": { "front": { … } },
      "slotLabels": { "front": "Framsida" } } ] }
```

- Only ACTIVE templates are listed, in `sortOrder`, then by id.
- `provisional` at the top is true when any listed template is provisional. The studio's banner read this flag off the Firebase document.
- These keys appear only when they have content: `printOffsetTopMm`, `slotLabels`, `pocketPositions`, `photo` (a photo template only) and `photo.displacement`.
- A URL is left out when its file has none (no photo for that colourway, or no public base).
- Each `perColorway` override uses the Firebase names: `blend`, `alpha`, `displacementScale`, `displacementBlur`, `displacementContrast`.

**`GET /v1/admin/pod/3d-models`** → 200

```json
{ "models": [
  { "id": "AbCdEf0123456789wxyz", "label": "T-shirt på modell",
    "views": { "front": { "w": 1600, "h": 1936, "printArea": { "x": 548, "y": 875, "w": 525, "h": 700 },
                          "colorways": { "white": { "label": "Vit", "photoUrl": "https://…", "displacementUrl": "https://…", "maskUrl": "https://…" } } } },
    "printAreaMm": { "front": { "w": 300, "h": 400 } },
    "displacementScale": 30, "displacementBlur": 6, "displacementContrast": 1, "blend": "multiply", "alpha": 0.8,
    "perColorway": { "black": { "blend": "screen", "alpha": 0.9 } },
    "output": { "w": 1600, "h": 1936 } } ] }
```

- Only ACTIVE models are listed, ordered by label (byte order), then by id.
- A view's `w`/`h` can be `null` (uncalibrated). `printAreaMm` holds only the views that have a size. The tuning keys appear only when set.

Both seller shapes are built field by field. They never carry `active`, `sortOrder`, a file id, `sha256`, `sizeBytes`, `mapContrastSd`, `originalDims`, a time or a user. No money exists on these rows at all.

### Platform (live `platform_admin` session, NO `X-Shop-Id`, same-origin on POST/PUT/PATCH)

The guard runs in this order: `X-Shop-Id` present → 404 (this also covers acting-as); no live platform session → 404; a method the path does not own → 404; a state change whose `Origin` is not the request's origin → 404. The id and the body are read only after that.

**`POST /v1/platform/pod/studio-files`**: the body is the raw file bytes, with `Content-Type: image/png|jpeg|webp|avif` and `Content-Length` required. The route is dark (404) without `PUBLIC_BUCKET` and a valid `PUBLIC_OBJECT_BASE_URL`.
- 201 `{ "file": { "fileId", "contentType", "sizeBytes", "sha256", "width", "height", "url" } }` when this request activated the file.
- 200, same body, when those bytes are already stored (or a pending reservation of them was finished by an earlier request).
- 400 `{ error: { code: "invalid_request", message, reason } }`, where `reason` is:
  - `not_an_allowed_image` (not PNG, JPEG, WebP or AVIF by its bytes: an SVG, GIF, icon or text);
  - `type_not_as_stated`.
- 400 without a reason: `Content-Length` is missing or malformed, or the body is not exactly that length.
- 413 `payload_too_large`: the declared length is over 15 MiB. This is answered before the body is read.
- 409 `conflict`: the same bytes are being uploaded right now. Try again.

The steps: the row is reserved `pending`, the bytes are put (with an immutable cache header), the row is turned `active` and given its pixel size, and an audit row `pod.studio_file.upload` is written in the same batch.

**`GET /v1/platform/pod/mockup-templates`** → 200 `{ "templates": [PlatformTemplate…], "files": { "<fileId>": file… } }`. Inactive templates are included. `files` holds every active file the templates name, in the upload's `file` shape.
- `PlatformTemplate` = the PUT body (below), normalised, plus `templateId`, `createdAt` and `updatedAt`.
- GET followed by PUT round-trips: strip those three keys and send the rest back.

**`PUT /v1/platform/pod/mockup-templates/:templateId`** creates the template or replaces it whole, areas and colourways included. The body:

```json
{ "label": "T-shirt", "garment": "tee", "profileId": "apparel_dtg",
  "active": true, "provisional": false, "sortOrder": 10,
  "colorways": [ { "id": "white", "label": "Vit", "hex": "#f3f3f3", "frontFileId": "<uuid>|null", "backFileId": "<uuid>|null",
                   "tuning": { "blend": "normal", "alpha": 0.9, "displacementScale": 30, "displacementBlur": 6, "displacementContrast": 1 } } ],
  "printAreas":  { "<slot>": { "x", "y", "w", "h" } },
  "printAreaMm": { "<slot>": { "w", "h" } },
  "printOffsetTopMm": { "<slot>": 65 }, "slotLabels": { "<slot>": "Framsida" },
  "pocketPositions": { "left": { "x" }, "center": { "x" }, "right": { "x" } },
  "photo": null | { "w", "h", "displacement": null | { "w", "h", "frontFileId", "backFileId", "scale", "blur", "contrast", "blend", "alpha" } } }
```

- Defaults: `active` true, `provisional` false, `sortOrder` 0. `tuning`, `printOffsetTopMm`, `slotLabels` and `pocketPositions` are optional.
- Unknown keys refuse the body (an old `blankCostSek` among them). The slots of `printAreas` and `printAreaMm` must be the same set.
- Answers:
  - 201 `{ "changed": true, "template": PlatformTemplate }`: created.
  - 200 `{ "changed": true, … }`: replaced.
  - 200 `{ "changed": false, … }`: the identical document is already stored. Nothing is written and no audit row is added; this is what makes the import idempotent.
  - 400 `invalid_request`. Without a reason it is a shape error. With a `reason` it is one of:
    - `aspect_mismatch`: a slot's px rect and its mm size differ in aspect by more than 1 %. This is the studio's own tripwire; POD_PRINT_SPEC says the two MUST agree.
    - `area_outside_photo`: a rect, or a pocket position, leaves a photo template's photo.
    - `files_on_flat_template`.
    - `tuning_without_displacement`.
    - `pocket_positions_without_pocket`.
    - `duplicate_colorway`.
    - `file_not_found`: a file id that is not an active studio file.
  - 409 `limit_reached`: a new template past 100.
  - 413: the body is over 256 KiB.
  - 404: a malformed id, or a guard failed.
- Audit: `pod.mockup_template.create` or `pod.mockup_template.update`, with `{active, colorways, garment, slots}`.

**`PATCH /v1/platform/pod/mockup-templates/:templateId`** `{ "active": boolean }` → 200 `{ "changed", "template" }`. An unchanged value writes nothing. Audit: `pod.mockup_template.activate` or `pod.mockup_template.deactivate`. An unknown id gets 404, and a bad body gets 400.

**`GET /v1/platform/pod/3d-models`** → 200 `{ "models": [PlatformModel…], "files": {…} }`. `PlatformModel` = the PUT body plus `modelId`, `createdAt` and `updatedAt`.

**`PUT /v1/platform/pod/3d-models/:modelId`**:

```json
{ "label": "…", "active": true,
  "displacementScale", "displacementBlur", "displacementContrast", "blend", "alpha",
  "output": { "w", "h" } | null,
  "perColorway": { "<colourway id>": { "blend", "alpha", "displacementScale", "displacementBlur", "displacementContrast" } },
  "views": { "front": { "w": 1600|null, "h": 1936|null, "printArea": { "x", "y", "w", "h" },
                        "printAreaMm": { "w", "h" } | null, "originalDims": { "w", "h" } | null,
                        "colorways": [ { "id", "label", "photoFileId", "displacementFileId", "maskFileId": "<uuid>|null", "mapContrastSd": 41.5 } ] } } }
```

- At least one view is required (`front` or `back`). A zero print rect and an empty colourway list are valid: that is an uncalibrated model.
- Answers and reasons are as for templates, plus `not_registered`: a colourway's photo, map and mask have different known pixel sizes (`pod3dUpload.js validateModelAssetSet`).
- Audit: `pod.3d_model.create` or `pod.3d_model.update`.

**`PATCH /v1/platform/pod/3d-models/:modelId`** `{ "active" }`: as for templates (`pod.3d_model.activate` / `pod.3d_model.deactivate`).

## The import: run book for the reviewer

`$B` = the CP3 export bundle (the one CP4 used). `$W` = a work directory outside the repo, e.g. `~/chopshop-export/studio-import-<date>`. Run from the repo root. `--hosting-dir public` is the repo's `public/`: the template photos and maps live at the hosting paths the Firestore document names (`/pod-garments/tee-hanging/…`, `hoodie-hanging`, `longsleeve-hanging`). All 74 files of the seed are present: 26 + 22 + 26.

0. **Prerequisites (reviewer):** commit; apply 0049 to staging D1 through the preflight; deploy the API (`/ready` must report `0049_pod_studio_assets.sql`). The platform credentials come from the same place as for storage-copy (`CHOPSHOP_PLATFORM_EMAIL`, and the password from `~/.config/chopshop/secrets.staging.env`).

1. **Dry run.** It makes no request, writes nothing, and reads only the bundle and `public/`.
   ```
   node scripts/cf-port/migrate/import-studio-assets.mjs --env staging --bundle $B --out $W --hosting-dir public --dry-run
   ```
   It prints:
   - `templates: N to write (ids…)` and `models: M to write (ids…)`;
   - `left out: …`, with a reason per item (`guard_family_<n>`, `bad_id` or `no_garment`);
   - `template keys not carried: …`, the keys of the document that are not part of the template shape. Expect `none` after A13; any old price key would be listed here and is NOT carried;
   - `colourways left out`, 3D colourways without a photo and a map, and views other than front/back;
   - `3D originals not copied: k colourways`;
   - `files: F distinct (h from the hosting directory, r from the source's storage)`;
   - `files already copied (skipped)`;
   - `hosting paths that --hosting-dir does not hold: 0`. This must be 0.

   Expected, if production equals the seed: 8 templates (tee_bc_e150, hoodie_hanging, longsleeve_hanging, sweatshirt_flat, bag_flat, cap_flat, beanie_flat, flatcap_flat) and 74 hosting files, plus however many 3D models the export holds, with 2–3 storage files per colourway.

2. **The run:**
   ```
   node scripts/cf-port/migrate/import-studio-assets.mjs --env staging --bundle $B --out $W --hosting-dir public
   ```
   It prints, after the plan:
   - `signed in as the platform user`;
   - one line per file that was not copied (by key prefix and reason; never an address);
   - `files: copied X (uploaded now u, already stored s), refused, missing, failed`;
   - one line per item not written, refused or failed;
   - `rows: created, updated, unchanged, refused, not written, failed`;
   - `verify: T templates and M models read back, 0 mismatches`;
   - the request count.

   Exit 0 means everything was copied, written and verified. Exit 1 means some file or item was not, and is named. Exit 2 means the run was refused: production, `--out` inside the repo, a manifest from another bundle or environment, `/ready` not on 0049, or a sign-in failure.

3. **Idempotence check:** run step 2 again. Expect `files already copied (skipped): F; to try now: 0` and `rows: created 0, updated 0, unchanged T+M, …`. Nothing is written and no audit row is added. Even with the manifest deleted, the Worker returns the stored file for identical bytes (`already stored F`), so nothing is duplicated.

4. **Read it as a seller would.** With a tenant-admin session (or acting-as) on a POD shop:
   - `GET /_api/v1/admin/pod/mockup-templates` returns the 8 templates with `https://pub-…r2.dev/platform/studio/…` addresses;
   - `GET /_api/v1/admin/pod/3d-models` returns the active models.

   Open one photo URL in a browser to confirm it loads.

`--only templates|models` limits a run to one kind. A file that is `refused`, `missing` or `failed` stays in the manifest; `failed` ones are tried again on the next run. An item whose files are not all copied is not written: it is never written half-done.

## Tests and mutations

Worker (`cloudflare/test/pod-studio-assets.test.ts`, 38 tests):
- **Who.**
  - A tenant admin, with and without `X-Shop-Id`, gets the opaque 404 on every write and every platform read. The test counts rows and audit rows before and after: unchanged.
  - Signed out, a platform session naming a shop (acting-as), a cross-origin `Origin` or a missing `Origin` all get the opaque 404.
  - A method a path does not own gets 404.
  - A seller read with no session, no `X-Shop-Id`, a foreign shop, or a platform session without a shop gets 404. Write methods on the seller paths get 404.
- **Upload.**
  - The key is under `platform/studio/<id>/`, the bytes are in R2 with the proven type, the audit row is written, and there is no `stored_objects` row.
  - The same bytes return 200 with the same id and no new row.
  - Refused by the bytes, with nothing stored: PNG stated as WebP, PNG with no type, text stated as PNG, SVG, GIF.
  - A declared length over 15 MiB gets 413.
  - The table's key CHECK refuses `shops/…` and keys under another file's id.
- **Writes.**
  - Create gives 201; the same document gives 200 `changed:false` and no audit row; a change gives 200 with an `update` audit row.
  - Seven semantic refusals and eight shape errors.
  - A malformed path id gets 404.
  - PATCH deactivate and activate (audited, idempotent; an unknown id gets 404).
  - The platform list includes inactive templates and files.
  - Model create, no-op and `not_registered`; an uncalibrated model is valid; deactivation.
- **Seller.**
  - Only active templates and models are listed, in the exact Firebase shape (`toStrictEqual`).
  - A flat template has no `photo`, and the top-level `provisional` follows it.
  - Every answer is walked for platform-only keys and for the A13 cost keys (`expectNoCostKeys`).

Each mutation below was made once, the suite run, and the mutation reverted:

| mutation | result |
|---|---|
| a signed-out or tenant caller gets a platform principal | 2 failed |
| seller templates read inactive ones too | 2 failed |
| seller models read inactive ones too | 1 failed |
| the stated type is not compared with the proven one | 2 failed |
| any sniffable image type is admitted | 1 failed |
| a template's seller shape gains `sortOrder` | 2 failed |
| a model colourway's seller shape gains `photoFileId` | 1 failed |
| the unchanged-document check is removed (not idempotent) | 1 failed |
| the same-origin check is removed | 1 failed |
| the sha256 lookup before the insert is removed | 0 failed: the `UNIQUE(sha256)` constraint and the race path return the same 200. The behaviour is held twice |

Import (`scripts/cf-port/migrate/test/import-studio-assets.test.mjs`, 11 tests, against a fake of these routes that uses the Worker's own `image-sniff.ts`):
- argument parsing;
- the transform: the body shape, the placeholders, guard-family and no-garment items left out, the garment taken from the id prefix, an old price key dropped and counted, an incomplete 3D colourway left out, originals counted;
- a hosting path cannot leave `--hosting-dir` (`..` and `%2e%2e`);
- `--out` inside the repo is refused;
- the dry run makes no request;
- a full run: 7 files, 4 items, verified, and no address in the manifest. A second run uploads nothing and writes nothing (`unchanged 4`);
- a lost manifest still writes nothing new;
- a missing source file: that item is not written, the others are, exit 1;
- an SVG is refused locally and never sent;
- a document the Worker refuses is reported;
- no `--hosting-dir`: the hosting files are refused, and the flat template is still written;
- `--only models`.

Mutations: skipping the manifest check fails the idempotence test. Removing the local type check failed nothing at first, because the fake also refuses the SVG. I added "the SVG never reached the Worker" (6 uploads, not 7), and the mutation now fails 1.

## Gates

- `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`: clean.
- `npx vitest run`: **Test Files 101 passed (101), Tests 4292 passed (4292)**. HEAD was 100 / 4254, so this adds 1 file and 38 tests. Nothing was skipped. Two `Network connection lost` uncaught-exception lines are printed during the run, and the suite still passes.
- `npm run types:check`: "Types at worker-configuration.d.ts are up to date".
- `node --test "scripts/cf-port/migrate/test/*.test.mjs"`: **tests 451, pass 451, fail 0, skipped 0** (HEAD 440, plus 11). This includes `no-write-calls.test.mjs` over the new script and libs.
- `node guard/guards.test.mjs`: **guard: PASS**, exit 0. The guard scans tracked files only, and the new files are untracked until the reviewer commits. I grepped all nine new files for the guard's three families: no match.

## For unit FN (the studio's data layer)

**Templates.** Replace `loadPodMockupTemplates()` with `GET /v1/admin/pod/mockup-templates`. Set `_cache = body.templates` and `_meta = { provisional: body.provisional }`. Each template keeps the Firebase document's shape, so `TemplateBackground.jsx`, `placementMath`, `applyPrinterAreas`, `templateSlots` and `mockupRender` read it unchanged. The differences:
- `version` is gone (the studio never read it); `provisional` now also exists per template.
- Only active templates arrive; nothing to filter.
- `garment` is always present. `garmentOfTemplate`'s id-prefix fallback becomes a no-op, but keep it.
- Photo and map URLs are absolute public R2 addresses, not hosting-relative `/pod-garments/…` paths.
- `photo.urls` / `backUrls` hold only colourways that have a photo, as before. `displacement.perColorway` holds only colourways with an override.
- Keep sorting slots with `SLOT_ORDER` (`templateSlots`). The Worker emits slots in `PRINT_SLOTS` order, but do not depend on it.

**Offering a template.** The `printersById` / `routing` inputs of `templateOffered` and `applyPrinterAreas` come from `GET /v1/admin/pod/printers` (`printers[].garments`, `printers[].capabilities.models[*].{garment, printAreasMm}`). Match on `template.garment`.

**3D.** Replace `loadPod3dModels()` with `GET /v1/admin/pod/3d-models` → `models`. The shape is the `pod3dModels` document plus `id`, so `Studio3DSection` (`renderReady`, `readyColorwayIds`, `compositorConfigFor`) reads it unchanged. The differences:
- No `scope`, `active`, `createdAt`/`updatedAt`, `originalDims`, `originalPaths` or `mapContrastSd`.
- Inactive models are already removed.
- The order is label byte order. Keep the `localeCompare(…, 'sv')` sort the loader did.
- A view's `w`/`h` may be `null`, and `printAreaMm` lacks views without a size. `renderReady` already handles both.

**Images in the browser (check before FN ships).** The pixi compositor uploads these images as WebGL textures, and `mockupRender` exports a canvas. Both need the R2 public bucket to answer with CORS for the admin origin (`Access-Control-Allow-Origin`, GET), or the textures fail and the canvas is tainted. The admin CSP's `img-src` already includes `PUBLIC_OBJECT_BASE_URL` (CP5 §4). The bucket's CORS policy is the reviewer's to check or set.

**The platform's own editors (`PlatformModels`, `ModelEditor`, any template editor).** Upload each derivative with `POST /v1/platform/pod/studio-files` (raw bytes, the type stated), then PUT the document whole. There is no dot-path partial update; `PATCH` is only `{active}`. The raw originals have no home (see below), so the original upload in `pod3dUpload.js` has no equivalent. `originalDims` is still stored, so a new colourway can be checked against it.

## Open questions for Mikael

1. **D101.** The default was taken: platform tables, the public bucket under `platform/studio/`, written only by platform routes. Veto until the CP5 deploy.
2. **3D originals.** The raw masters each 3D colourway kept in Storage (`originalPaths`) are not carried. The studio only renders the 1600-px derivatives, and the masters can be over 15 MB (13 MB was noted). Should they be archived before Firebase Storage is closed, or dropped?
3. **`provisional`.** The Firestore document had one doc-level flag (true), so every imported template is provisional and the "preliminära" banner stays as it is today. Should the three photo templates be marked non-provisional after the import (one PUT each)?
4. **Nothing is deleted.** Templates and models are deactivated, and studio files stay in the bucket. Is a hard delete, or a sweep of unreferenced files, wanted later?
5. **The R2 bucket's CORS** for the admin origin (see "For unit FN"). Needed before the studio renders from the Worker.

## Reviewer wiring

- `REQUIRED_MIGRATION` is already moved to `0049_pod_studio_assets.sql` (`app.ts`, `health.test.ts`, `public-catalog.test.ts`).
- Apply 0049 to staging through the preflight before deploying the API.
- No `wrangler.jsonc` var. The upload route uses the existing `PUBLIC_BUCKET` and `PUBLIC_OBJECT_BASE_URL`, and stays dark without them.
- The admin Worker's allowlist already forwards `/v1/admin/` and `/v1/platform/` prefixes, so these routes need no admin-Worker change.
