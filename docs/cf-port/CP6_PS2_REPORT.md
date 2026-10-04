# CP6-PS2: the print canvas per line (LAUNCH_TODO A5)

## Design (phase 1)

HEAD `011d3e06`, branch `cf-port`. Design only: no code, no git write, no network.

### 1. What exists today

| Fact | Where |
|---|---|
| A frozen print slot is `{ slot, r2Key, sha256, widthMm, heightMm }`; the line adds `lineNo, sku, quantity` and its money. There is **no frame, no position and no artwork pixel size** in it. | `src/commerce/checkout.ts:985-987, 1055-1068` |
| The webhook copies each snapshot line object, re-serialised whole, into `order_items.production_json` (cap 64 KiB per line). New fields carry over with no webhook change. | `src/commerce/webhook.ts:883, 922-943, 604-626` |
| `widthMm`/`heightMm` come from `sizeSlot`: contain-fit in the printer's frame, capped at the width where the artwork still holds its minimum DPI (300), floored to whole mm | `src/pod/pod-mappings.ts:180-196, 857-872` |
| A mapping slot stores only `{ slot, widthMm, heightMm }`. **No placement exists on the server.** | `pod-mappings.ts:36-40` |
| The studio shows the server's print centred on BOTH axes of the frame, at `widthMm`, with height = width × the pixel aspect and no rotation. The seller cannot move it. | `src/admin-app/adapters/studio.js:430-438`; `src/admin-app/replacements/podStudioData.js:8-13, 35` |
| Frames are `PrintArea { w, h, offsetTopMm? }` in integer mm, per model and slot, plus a model flag `provisional`. `slotFrame` fails closed. Pocket = min(100×100, front). | `src/pod/printers.ts:33-48, 99, 461-485` |
| Checkout re-proves `frame.w >= widthMm && frame.h >= heightMm` | `pod-mappings.ts:1385-1386` |
| SnapWear data (PrintArea.xlsx, via the seed): 47 models. 42 have front and back frames (largest 390×490, offsetTopMm 20–60). 20 have a pallet size, which is **not** in capabilities. Per-SKU `frameVariants` (±3 mm) are collapsed to one frame per model. 5 have no frame: 64400 longsleeve, B445 beanie, SF500 hoodie, TRUCKER cap, W101 bag. These are seeded as provisional stand-ins. | `docs/SnapWearDocs/snapwear-catalog.json`; `src/pod/printer-catalog.ts:418-443, 720-747` |
| Spec: offsets are measured "below the neck seam"; 300 DPI; always transparent PNG, RGB. §6: the earlier printer wanted the motif only, with no canvas. | `docs/POD_PRINT_SPEC.md:29-30, 46, 76, 123-125` |
| Container: ONE job kind, `pod.process_artwork`, contract v1. The envelope holds an input GET and two output PUTs (presigned, R2-host allowlist). | `render/src/contract.ts:21-22, 39, 225-269` |
| Pull model: acquire, run, then complete or fail. Lease 10 min, 3 attempts. Output goes to attempt keys. sha256 is computed over the bytes PUT. | `contract.ts:42-50`; `render/src/worker.ts:299-427`; `render/src/transfer.ts:114-165` |
| sharp 0.35.4, cache off, concurrency 1, decode cap 10 000 px per side, input ≤ 200 MB | `render/src/pipeline.ts:39-45`; `contract.ts:29` |
| Completion promotes the attempt object to the canonical key: create-if-absent, with R2 verifying the reported sha256. Different bytes are a conflict, never an overwrite. So canonical objects carry `checksums.sha256`. | `src/pod/render-jobs.ts:767-807` |
| `render_jobs` is artwork-shaped. `input_key` is pinned to `shops/{t}/`, `output_prefix` to `pod/{t}/render/{artwork}/{v}/`, and it has UNIQUE(artwork_id, version). Its terminal path deletes a `processing` artwork row. | `migrations/0017_render_jobs.sql:77-125`; `render-jobs.ts:267-321` |
| Wake path: a queue nudge `{ renderJobId: <any uuid> }`, with no D1 read, calls the DO's `wake()`. One `standard-1` instance, one job at a time. The sweeper re-nudges jobs queued for more than 5 min. | `src/pod/render-jobs-queue.ts`; `src/render/wake.ts`; `wrangler.jsonc:43-44, 136-137`; `src/render/render-container.ts:51`; `src/outbox/sweeper.ts:42, 178` |
| Dispatch, one run: cancel re-check → load line → no client ⇒ park → build (front/back only, ≤ 2 files, keys under `pod/{t}/`) → **`printFilesForPrinter`** → `checkPrintFiles` → ship-to → presign 7 days → payment hold ⇒ park → submitting → submit | `src/dispatch/dispatch-effect.ts:607-719, 201-266, 278-280` |
| `checkPrintFiles` does an R2 HEAD per file. Missing → terminal `print_file_missing`. No stored sha256 → `print_file_unverified`. Mismatch → `print_file_mismatch`. No binding, no presigner or an R2 error → retry. Terminal means row failed + line failed + `dispatch_failed` alert. A retry backs off, for up to 10 attempts. | `dispatch-effect.ts:289-315, 397-468`; `0001:114` |
| Wire: `layouts[i] = { location }` only. **No offset, size or position is sent.** | `src/dispatch/printer-client.ts:71-83`; `snapwear-wire.ts:44-52` |

### 2. The canvas

- **Size.** Canvas = exactly the line's **frozen frame**, not the pallet: px = round(mm / 25.4 × DPI). At 300 DPI the largest frame, 390×490 mm, gives **4606 × 5787 px** (26.7 Mpx; 106.6 MB raw RGBA). The smallest, 260×180 mm, gives 3071 × 2126.
- **Placement** (ours, the same as the studio). Motif width = round(widthMm / 25.4 × DPI). Motif height = round(width × srcH / srcW), using frozen source px. left = floor((Cw − Mw) / 2), top = floor((Ch − Mh) / 2). The offset's reference is the **frame's top-left corner**, and the only offset is this centring. There is no rotation. Resampling is lanczos3 to that exact box. sizeSlot capped the motif at 300 DPI, so at 300 this is a downscale or about 1:1.
- **Exceeding the frame.** Whether the motif fits is decided in MILLIMETRES, as checkout decided it: `widthMm > frame.w` or `widthMm × srcH / srcW > frame.h` is refused (terminal), never cropped or shrunk; for a line that passed checkout this cannot happen, so a refusal means corrupt data. **Corrected by the reviewer after the build:** the design said the same held in pixels ("rounding is monotonic"); it does not. The width is rounded to pixels and the height rounded from that width, so a motif that fills the frame's height can land one or two pixels past the frame's own rounded height (about 1 in 600 random artworks on a 250×350 frame; e.g. 1268×8871 px → 4135 px in a frame of 4134). As built first, such a line failed at dispatch with `print_canvas_motif_exceeds_frame`. Now those pixels are clamped to the frame (`canvasSpec`; under 0.1 % of the motif). Tests: "a size checkout accepted is never refused for a pixel of rounding…" (the five cases and a property test over `sizeSlot`'s own output for five frame sizes), both guards mutation-checked.
- **Format.** Background fully transparent. PNG, 8-bit sRGB RGBA, pHYs = DPI, no other metadata, sharp's default zlib level. sha256 over the exact bytes. Deterministic for one sharp version.
- **Expected bytes, largest frame.** The transparent area costs about 0.1 MB. A logo gives 1–10 MB, a full-frame photo 40–80 MB. The theoretical worst case (noise) is about 107 MB.
- **The job body does not change:** `layouts[].location` only. SnapWear applies ITS offset once, when it places the frame (offsetTopMm from its reference, C2). OUR offset lives only in the pixels. A test pins the body's exact key set with the canvas on. If an offset or position field were ever sent too, the offset would apply twice.

### 3. When, and by what

**Recommended: lazily, at dispatch, by the render container.** At payment would mean changing the webhook's money batch. It would also render for orders cancelled before dispatch, and in production while the submit switch keeps every dispatch parked (PS1). The dispatcher is the only consumer and already holds the claim, the line and the frozen snapshot. The cost is one render (about 1 min) before the first submit, which does not matter against print lead time.

Inside `runDispatchEffect`, after `buildDispatchJob`, `printFilesForPrinter` becomes async and returns `ready(files) | pending | terminal(code) | retry(code)`, via the pure `decidePrintFiles`:

| Line's canvases | Switch | Row `submitted_at` | Result |
|---|---|---|---|
| all slots `completed` | any | any | `ready`: canvas key + recorded sha256 (a re-dispatch after a lost answer gets the same file) |
| any slot `failed` | on | null | `terminal print_canvas_failed`: the existing `dispatch_failed` alert, and a human places it by hand |
| not a complete set | any | set | `ready`: artwork files. This job was first sent without a canvas, so the file sent for one job id never changes |
| none / some pending | off | null | `ready`: artwork files, today's behaviour, byte for byte |
| missing or pending | on | null | **ensure + park** (below) |

**Ensure + park, in ONE D1 batch.** First the artwork files are checked as they are today (this also gives `input_bytes`). Then `canvasSpec` is computed (it may refuse, terminal: §5). The batch: `INSERT OR IGNORE` one `print_canvas_jobs` row per slot, with its spec frozen on the row. Then the dispatch row is parked: `status 'pending'`, claim released, `last_error 'print_canvas_pending'`, `next_attempt_at = CANVAS_HOLD_UNTIL_MS` (= `DISPATCH_HOLD_UNTIL_MS − 2000`, distinct from both other sentinels). The park runs under the claim's fence, only while `attempts < max_attempts`, **and only while one of the line's canvases is still queued or leased**. After the batch, the render queue is nudged (best effort). If the park did not apply: a lost claim → `lost_claim`; canvases already settled → decide again in the same run; on the last attempt → `retryLater`, which fails with its alert (the unchanged CP2 rule). No attempt is spent while parked.

*(Built as designed, plus one check not in the design: when every slot has a completed canvas, dispatch also checks that each was made from the very master the line froze (`input_key`/`input_sha256` = the frozen `r2Key`/`sha256`), else terminal `print_canvas_input_mismatch`. `dispatch-effect.ts` `printFilesForPrinter`/`ensureAndPark`.)*

**Release.** It is atomic, in the canvas job's own commit batch (completed, refused, or failed on its last attempt, including the acquire reaper). The same batch makes the line's parked dispatch row due (`dedupe_key = 'dispatch:{order}:{line}'`, at the hold instant). On completion it does this only when no sibling canvas is still pending; on failure, always. It then nudges the outbox. D1 serialises writers, so the park's EXISTS and the release's NOT EXISTS cannot both miss. As a backstop, the sweeper releases any canvas-held row whose canvases are all settled.

**Bounded.** Once a container runs, a canvas job settles within 3 attempts × 10 min. If no container ever runs, the row waits like PS1's printer hold: no attempt is spent, `dispatch_stranded_30m` names it (`crons.ts:1199-1230`, which selects every unsettled dispatch), and the sweeper re-nudges the container.

**Idempotency.** UNIQUE(tenant, order, line, slot). A row is never reset, and a settled row is final (trigger). The canonical key is deterministic and written create-if-absent with R2-verified sha256. So each slot of a line has at most one canvas, ever.

### 4. Where it is recorded: migration 0053 (needed)

Nothing existing fits honestly. `render_jobs` CHECKs pin the input to `shops/` and the output to the artwork prefix, and its terminal path deletes artwork rows. SQLite cannot relax a CHECK without rebuilding the table. `production_json` is the frozen snapshot, not derived state. `outbox_events.result_ref` is the printer's id. A lease queue needs state columns anyway.

*(Built: `cloudflare/migrations/0053_print_canvas_jobs.sql` is the source of truth. It departs from the draft below in four places: `id` must also be lower-case hex; `CHECK (state <> 'completed' OR attempt >= 1)`; FIVE triggers, not three (the two added are `print_canvas_jobs_insert_once`, `RAISE(IGNORE)` on a second row for the same line+slot, so `INSERT OR REPLACE` and upserts cannot delete or rewrite a settled row, and `print_canvas_jobs_never_deleted`); the identity trigger also freezes `input_bytes`, `output_prefix` and `created_at`.)*

```sql
CREATE TABLE print_canvas_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  slot TEXT NOT NULL CHECK (slot IN ('front', 'back')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'completed', 'failed')),
  lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
  lease_until TEXT CHECK (lease_until IS NULL OR lease_until IS strftime('%Y-%m-%dT%H:%M:%fZ', lease_until)),
  input_key TEXT NOT NULL CHECK (substr(input_key, 1, length('pod/' || tenant_id || '/print/')) = 'pod/' || tenant_id || '/print/'),
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  input_bytes INTEGER NOT NULL CHECK (input_bytes > 0),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json) AND json_type(spec_json) = 'object'),
  output_prefix TEXT NOT NULL CHECK (output_prefix = 'pod/' || tenant_id || '/render/canvas/' || order_id || '/' || line_no || '/' || slot || '/'),
  canvas_key TEXT NOT NULL CHECK (canvas_key = 'pod/' || tenant_id || '/print/orders/' || order_id || '/' || line_no || '-' || slot || '.png'),
  canvas_sha256 TEXT CHECK (canvas_sha256 IS NULL OR (length(canvas_sha256) = 64 AND canvas_sha256 NOT GLOB '*[^0-9a-f]*')),
  canvas_bytes INTEGER CHECK (canvas_bytes IS NULL OR canvas_bytes > 0),
  error TEXT CHECK (error IS NULL OR (length(error) BETWEEN 1 AND 100 AND error NOT GLOB '*[^A-Za-z0-9_.:-]*')),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  completed_at TEXT CHECK (completed_at IS NULL OR completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)),
  CHECK (updated_at >= created_at),
  CHECK (state <> 'queued' OR (attempt <= 2 AND lease_token_hash IS NULL AND lease_until IS NULL)),
  CHECK (state <> 'leased' OR (attempt >= 1 AND lease_token_hash IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((state = 'completed') = (canvas_sha256 IS NOT NULL AND canvas_bytes IS NOT NULL)),
  CHECK (state <> 'failed' OR error IS NOT NULL),
  UNIQUE (tenant_id, order_id, line_no, slot)
);
CREATE INDEX print_canvas_jobs_acquire_idx ON print_canvas_jobs (state, created_at, id);
-- triggers: (1) BEFORE INSERT: the order exists with this tenant_id and has the line (item_index = line_no - 1);
-- (2) BEFORE UPDATE OF tenant_id, order_id, line_no, slot, input_key, input_sha256, spec_json, canvas_key: ABORT on change;
-- (3) BEFORE UPDATE WHEN OLD.state IN ('completed', 'failed'): ABORT (a settled job is final).
```

Dispatch then checks the canvas exactly as it checks an artwork today: an R2 HEAD of `canvas_key`, comparing R2's sha256 (written by the promotion) with `canvas_sha256`. **Why nobody but the printer reads it:** `pod/` is the server-owned prefix that no client-reachable route reads or writes (`0012:20-27`, `artwork-store.ts:63`). Public routes serve only `pod/{t}/preview/` (`public-catalog.ts:682`, `pod-storefront.ts:17`). No tenant route selects this table. A URL exists only as the 7-day presign handed to the printer (stored nowhere, PS1) and as the container's 5- and 15-minute presigns. The table holds no money, so the one-number rule is untouched.

**Snapshot additions** (no migration, JSON): at checkout each print slot also freezes `frameMm {w, h, offsetTopMm?}`, `frameProvisional` and `sourcePx {w, h}`. *(Built: `sourcePx` is written only when both pixel values are positive integers; 0012's CHECK guarantees them for every `ready` artwork, so in practice it is always there, and checkout never refuses a cart over it.)* These are already read in `decideProductionLine` (`frame` at `pod-mappings.ts:1385`; add `width_px, height_px` to its artwork join at :1296-1300). Dispatch must not read the catalogue (`dispatch-effect.ts:44-46`).

### 5. Assumptions to confirm with SnapWear

Each is ONE constant or ONE function in `src/dispatch/print-canvas.ts`, with the assumption written beside it and a test.

| Q | Assumption | Holder | If the answer differs |
|---|---|---|---|
| C1 frames | The frozen model frame (PrintArea.xlsx) is SnapWear's print frame for every SKU of that model. Data exists for 42 models; missing for 64400, B445, SF500, TRUCKER, W101. Per-SKU variants (±3 mm) are ignored. | `canvasFrame(file)`: refuses `print_canvas_frame_missing` (no frozen frame) and `print_canvas_frame_provisional` (stand-in) → terminal. **Never prints at a guess.** | New frames go into the printer's capabilities (seed). Per-SKU frames need a SKU-level frame in capabilities + freeze. |
| C2 reference | The canvas IS the frame. offsetTopMm (collar seam or pallet edge) is SnapWear's when it places the frame, and is not drawn into the canvas. | `canvasReference(file)` → `{ canvasMm, frameOriginMm: {0, 0} }` | If they want a pallet-sized file: canvas = pallet, frame at (centred, offsetTopMm). That needs pallet sizes in capabilities (missing today) and C2's reference. Only this function and the seed change. |
| C3 DPI | 300 | `SNAPWEAR_CANVAS_DPI` | Only px sizes change. Above the motif's own DPI the motif is upsampled, losing nothing against the printer doing it. |
| C3 size | ≤ 100 MiB per file | `SNAPWEAR_MAX_CANVAS_BYTES`, checked at completion → `print_canvas_too_large`, terminal, never sent | Lower it. Large photos may then fail (follow-up: drop alpha when fully opaque). |
| C3 alpha | Transparent PNG accepted | `SNAPWEAR_CANVAS_TRANSPARENT = true`; false → `canvasSpec` refuses `print_canvas_background_unsupported` | Flattening would ink the whole frame; it needs the garment colour and their rule. Fails closed. |
| C3 1:1 (new) | They print the file as received: its top-left at the frame's top-left, at its DPI, with no trim or re-centring of transparent margins | precondition of the switch (§6) | If they trim, our offset is lost: keep the switch off and send the motif (today). |
| ours | Centred on both axes at the frozen width, no rotation (= the studio) | `motifPlacement(spec)` | Top-alignment would change this function AND `studio.js` `serverPlacement` in one release (open question 1). |
| colour | sRGB 8-bit, no ICC conversion (the master is already sRGB) | container `renderCanvas` | If they want CMYK or an embedded profile: one sharp option. |

### 6. Switch

`PRINT_CANVAS_ENABLED === "true"` (exact, like PS1). Off = today's file, byte for byte (tested). **Recommended: staging on** (it exercises the path end to end against the fake printer; the PS1 gate means staging can never build the SnapWear client). **Production off** until C1–C3 are answered. Runbook rule: turn it on before or with `SNAPWEAR_SUBMIT_ENABLED`. The rule "a job first sent with a file keeps it" (§3) makes either order safe. A switch rather than a replacement, because §6 of the spec shows a printer may want the motif only.

### 7. Limits

- **Container** (`standard-1`: ½ vCPU, 4 GiB, 8 GB disk; one job at a time). Peak memory is the decode of the master (≤ 10 000² px, 400 MB if materialised, as today's pipeline) plus a streamed resize, extend and encode into a canvas of ≤ 107 MB. Estimate 20–90 s per canvas, well inside the 10-minute lease; `render/bench` measures the worst case in phase 2. Canvas input ceiling: 512 MiB (a noisy 10 000² master can exceed the artwork path's 200 MB). Disk: ≤ 0.6 GB per job. A burst of N canvases is serial: about N × 30–60 s.
- **R2**: one PUT ≤ 5 GiB. Outputs go container → R2 by presigned PUT (900 s) and never pass through a Worker request body. The promotion is an R2 → R2 stream through the binding, the same as today's print PNG. Input GET presign: 300 s (checked at request start). Printer GET: 7 days (C4, unchanged).
- **Workers**: dispatch adds one indexed SELECT and at most one small batch. Completion does one HEAD, one GET → PUT stream and one batch. No image bytes touch Worker memory or CPU.

### 8. Phase-2 build plan (in order)

1. `migrations/0053_print_canvas_jobs.sql`; `src/app.ts` `REQUIRED_MIGRATION`; pins in `test/health.test.ts`, `test/public-catalog.test.ts`.
2. Freeze: `src/pod/pod-mappings.ts` (`PrintFile` + `decideProductionLine` + artwork join), `src/commerce/checkout.ts` (copy + header). Update the snapshot tests.
3. `src/dispatch/print-canvas.ts` (new): switch, constants, `canvasFrame`, `canvasReference`, `motifPlacement`, `canvasSpec`, keys.
4. `src/pod/render-jobs.ts`: export `promote` and the lease-claim helpers (no behaviour change). `src/pod/print-canvas-jobs.ts` (new): ensure statements, read per line, acquire (with reaper), complete, fail, release statement.
5. `src/routes/render-jobs.ts`: acquire reads an optional body `{ jobTypes }`. With no body (an old container), artwork jobs only, so a canvas job never reaches an old image. Artwork first, then canvas. New routes `POST /v1/render/canvas-jobs/{id}/complete|fail`.
6. `src/dispatch/dispatch-effect.ts`: parse the frozen fields, `decidePrintFiles`, the async seam, `parkForCanvas`, `CANVAS_HOLD_UNTIL_MS`. *(Built: the park is `ensureAndPark`, which returns `parked` rather than `pending`; `CANVAS_HOLD_UNTIL_MS` and `decidePrintFiles` live in `print-canvas.ts`, not here. Also built, not planned: `vitest.config.ts` pins the switch `"false"` for the suites, and `wrangler.jsonc` carries staging's `"true"`.)* `src/outbox/sweeper.ts`: re-nudge stale canvas jobs, plus the backstop release. `src/env.d.ts`: `PRINT_CANVAS_ENABLED?`.
7. Container: `render/src/contract.ts` (`pod.print_canvas` envelope, parser, bodies, paths, acquire body), `render/src/canvas.ts` (new: verify sha256 and dims, resize, extend, PNG with density), `render/src/worker.ts` (branch on `jobType`; deterministic refusals → `ok:false`, transient → `fail`), `render/src/api.ts`.
8. Tests (all local):
   - `test/print-canvas.test.ts`: one test per assumption; geometry; idempotent enqueue; e2e park → real canvas routes with `contract.ts` bodies → release → the fake receives the canvas URL; lost answer reuses key and sha; terminal failure → `dispatch_failed`; switch off identical; submitted-without-canvas rule; the park/complete race; staging with every SnapWear var never calls SnapWear.
   - `test/render-container.test.ts`: contract drift; an old acquire never gets a canvas.
   - Migration CHECK/trigger tests.
   - `cd render && npx vitest run`: `canvas.test.ts` (dims, transparent corners, alpha bbox = expected box, density, same bytes twice), contract and worker extensions.
   - Gates: `tsc` ×3, full `vitest`, `types:check`, guard. Mutations per rule, as in PS1.
9. **Staging smoke (the reviewer).** Apply 0053; set `PRINT_CANVAS_ENABLED="true"`; deploy (rebuilds the image). Buy a front+back POD tee, parcel delivery. Then:
   - Watch `print_canvas_jobs` (2 rows → `completed`) and the dispatch row (`pending`/`print_canvas_pending` → `done`, line `accepted`).
   - Fetch `pod/<t>/print/orders/<o>/1-front.png`: expect 4606×5787 for the 390×490 frame, density 300, transparent corners, motif bbox centred.
   - The fake's stored URL path ends with that key; the container log has `wallMs` and `peakRssMb`.
   - With the switch off, a second order sends `/print/<artworkId>.png` and gets no canvas row.

### 9. Open questions (recommended default in bold)

1. Vertical placement in the frame: **centre (what the studio shows today)**, or top-aligned (studio and canvas change together)?
2. The switch: **staging on, production off until C1–C3**?
3. A pre-PS2 order (no frozen frame) under the switch: **fail closed (terminal + alert)**, or send the artwork file?
4. Provisional frames (5 models): **fail closed at dispatch now**; a checkout gate for them while the switch is on is a follow-up?
5. Acquire priority: **artwork first** (a seller is waiting), then canvases?
6. File size assumption: **100 MiB** until C3?
7. A deadline for a canvas that never renders (no container): **none; wait + the 30-minute stranded alert, as PS1's hold**?
8. Canvas retention: **keep (reprints); no lifecycle rule in PS2**?
9. Touch checkout's snapshot (additive fields only) so dispatch never reads the catalogue: **yes**?

## Build log (phase 2)

1. Migration 0053 + pins: `migrations/0053_print_canvas_jobs.sql`, `src/app.ts` (`REQUIRED_MIGRATION`), `test/health.test.ts`, `test/public-catalog.test.ts`, new `test/print-canvas-migration.test.ts` (38 tests) — tsc clean; full `vitest run` 113 files / 4560 tests passed.
2. Snapshot freeze (money path, additive only): `src/pod/pod-mappings.ts` (`PrintFile` + `frameMm`/`frameProvisional`/`sourcePx`, artwork `width_px`/`height_px` in the production read), `src/commerce/checkout.ts` (copies the three; header); edited `test/pod-publish.test.ts:349-361` (the ONLY existing assertion of the slot's exact key set); new `test/print-canvas-snapshot.test.ts` (money byte-identical with/without the new fields' inputs) — tsc clean; full `vitest run` 114 files / 4561 tests passed.
3. Canvas module: new `src/dispatch/print-canvas.ts` (switch, C1–C3 holders, `canvasSpec`, keys, `decidePrintFiles`, `CANVAS_HOLD_UNTIL_MS`), `src/env.d.ts` (`PRINT_CANVAS_ENABLED?`), new `test/print-canvas.test.ts` (18 pure tests) — tsc clean; the new file 18/18 (nothing imports the module yet).
4. Canvas job queue: `src/pod/render-jobs.ts` (exports `parseLeaseClaim`, `parseMetrics`, `promote`, `ERROR_CODE_PATTERN`, `LeaseClaim`; no behaviour change), new `src/pod/print-canvas-jobs.ts` (ensure, read, acquire + reaper, complete, fail, release in every settling batch, sweeper helpers), new `test/print-canvas-jobs.test.ts` (14) — tsc clean; render-jobs + render-container + both canvas files 127/127 (nothing routes to the module yet).
5. Routes: `src/routes/render-jobs.ts` (acquire's optional `{ jobTypes }` body — none = artwork only; artwork first; `/v1/render/canvas-jobs/{id}/complete|fail`), `src/pod/render-farm-client.ts` (exports `JOB_TYPE`), route tests added to `test/print-canvas-jobs.test.ts` (19 total) — tsc clean; full `vitest run` 116 files / 4598 tests passed.
6. Dispatch + sweeper + switch: `src/dispatch/dispatch-effect.ts` (frozen canvas fields parsed leniently, async `printFilesForPrinter` via `decidePrintFiles`, `ensureAndPark`, `checkPrintFiles` also returns sizes), `src/outbox/sweeper.ts` (stale canvas re-nudge; backstop `canvasReleased`), `wrangler.jsonc` (staging `PRINT_CANVAS_ENABLED: "true"`; production untouched), `worker-configuration.d.ts` (`npm run types`: +1 var), `vitest.config.ts` (pins the var `"false"` so every older suite keeps proving the artwork path), `test/dispatch-fixtures.ts` (optional `canvas` on a print-file spec), dispatch e2e added to `test/print-canvas.test.ts` (34 total) — tsc clean; `types:check` up to date; full `vitest run` 116 files / 4614 tests passed.
7. Container: `render/src/contract.ts` (`pod.print_canvas` envelope, `parseCanvasLease`, `parseCanvasSpec`, `canvasCompletionBody`, `canvasReportPath`, `ACQUIRE_BODY`, `CANVAS_MAX_INPUT_BYTES`, `leaseJobType`), new `render/src/canvas.ts` (sha256 + pixel checks, resize → transparent extend → PNG with density), `render/src/worker.ts` (branch on `jobType`, `#runCanvasJob`, report kind threaded), `render/src/api.ts` (acquire body, canvas report path), `render/src/pipeline.ts` (exports `DECODE_PIXEL_LIMIT`); tests: new `render/test/canvas.test.ts` (6), `render/test/{contract,api,worker}.test.ts` extended, `test/render-container.test.ts` (+3 drift tests) — tsc ×4 clean; render vitest 7 files / 136 tests; full `vitest run` 116 files / 4617 tests passed.
8. Mutations (W1–W33, R1–R9; one equivalent, W9) + final gates: tsc ×4 clean; full `vitest run` 116 files / 4618 tests; render vitest 7 / 136; `types:check` up to date; guard PASS; migrate tools 554/554.

---

## What was built (phase 2)

Built on HEAD `011d3e06`, branch `cf-port`, in the working tree only. No git write, nothing on the network, no deploy. `npm run types` (local `wrangler types`) was run once, as PS1 did, after the staging var was added.

### Files

| File | |
|---|---|
| `cloudflare/migrations/0053_print_canvas_jobs.sql` | new. The table, one index, five triggers (line exists for this tenant; insert once, `RAISE(IGNORE)`; identity immutable; settled final; never deleted). |
| `cloudflare/src/dispatch/print-canvas.ts` | new, pure. The switch `printCanvasEnabled`; the SnapWear holders `SNAPWEAR_CANVAS_DPI`, `SNAPWEAR_MAX_CANVAS_BYTES`, `SNAPWEAR_CANVAS_TRANSPARENT`, `canvasFrame` (C1), `canvasReference` (C2); ours `motifPlacement`, `CANVAS_MAX_PIXELS`, `CANVAS_MAX_INPUT_BYTES`; `canvasSpec`; the keys; `decidePrintFiles`; `CANVAS_HOLD_UNTIL_MS`, `PRINT_CANVAS_PENDING`. |
| `cloudflare/src/pod/print-canvas-jobs.ts` | new. `ensureCanvasJobStatements`, `readLineCanvases`, `acquireCanvasJob` (with the reaper), `completeCanvasJob`, `failCanvasJob`, the release statement in every settling batch, the sweeper's `releaseSettledCanvasHolds` and `staleCanvasJobId`. |
| `cloudflare/src/dispatch/dispatch-effect.ts` | edited. The frozen canvas fields are parsed leniently into the built job (a malformed one is dropped; the artwork path never reads them). `printFilesForPrinter` is async and decides through `decidePrintFiles`; `ensureAndPark` checks the masters, freezes the specs, inserts the jobs and parks the row in one batch; `checkPrintFiles` also returns the sizes. The rest of the run is unchanged. |
| `cloudflare/src/outbox/sweeper.ts` | edited. Step 0b, the backstop release (`canvasReleased` in the summary); the stale re-nudge also looks at canvas jobs. |
| `cloudflare/src/routes/render-jobs.ts` | edited. `parseAcquireJobTypes` (no body = artwork only; else exactly `{ jobTypes }`, 1–2 distinct known kinds, ≤ 1 KiB, or 400); artwork jobs first; `/v1/render/canvas-jobs/{id}/complete|fail`. |
| `cloudflare/src/pod/render-jobs.ts` | edited, exports only: `parseLeaseClaim`, `parseMetrics`, `promote`, `ERROR_CODE_PATTERN`, `LeaseClaim`. No behaviour change. |
| `cloudflare/src/pod/render-farm-client.ts` | edited, `JOB_TYPE` exported. |
| `cloudflare/src/pod/pod-mappings.ts` | edited (money path, additive). `PrintFile` + `frameMm`, `frameProvisional`, `sourcePx?`; the production read also selects the artwork's `width_px`/`height_px`. No new refusal; no amount touched. |
| `cloudflare/src/commerce/checkout.ts` | edited (money path, additive). The three fields are copied onto each frozen print file; header comment. |
| `cloudflare/src/app.ts` | `REQUIRED_MIGRATION` → `0053_print_canvas_jobs.sql`. |
| `cloudflare/src/env.d.ts` | `PRINT_CANVAS_ENABLED?: string`. |
| `cloudflare/wrangler.jsonc` | `env.staging.vars.PRINT_CANVAS_ENABLED = "true"`. Production: nothing. |
| `cloudflare/worker-configuration.d.ts` | regenerated by `npm run types`: the one var added (diff: 3 lines + the hash). |
| `cloudflare/vitest.config.ts` | pins `PRINT_CANVAS_ENABLED: "false"` for the suites (staging's `"true"` would otherwise reach every older dispatch suite); the canvas suites turn it on. |
| `cloudflare/render/src/contract.ts` | edited. `CANVAS_JOB_TYPE`, `ACQUIRE_BODY`, `CANVAS_MAX_INPUT_BYTES`, `CanvasSpec`/`parseCanvasSpec` (refuses a motif outside the canvas, a canvas over 40 Mpx, any background but transparent), `parseCanvasLease`, `leaseJobType`, `canvasOutputKey`, `canvasCompletionBody`, `canvasReportPath`. The artwork contract is untouched. |
| `cloudflare/render/src/canvas.ts` | new. `renderCanvas`: input sha256 = the frozen one (else `input_mismatch`), decoded pixels = the frozen ones (else `dims_mismatch`), the motif inside the canvas (else `motif_exceeds_canvas`); then `ensureAlpha → resize(fill, lanczos3) → extend(transparent) → sRGB → density = DPI → PNG`, and the output's size and 4 channels are verified. |
| `cloudflare/render/src/worker.ts` | edited. A lease is routed by `jobType`; `#runCanvasJob` (download ≤ 512 MiB, render, one PUT, complete); the report helpers carry the kind. |
| `cloudflare/render/src/api.ts` | edited. acquire POSTs `ACQUIRE_BODY`; `report(…, kind)` picks the canvas path. |
| `cloudflare/render/src/pipeline.ts` | `DECODE_PIXEL_LIMIT` exported (the canvas decodes under the same cap). |
| tests | new `test/print-canvas.test.ts` (35), `test/print-canvas-jobs.test.ts` (19), `test/print-canvas-migration.test.ts` (38), `test/print-canvas-snapshot.test.ts` (1), `render/test/canvas.test.ts` (6); extended `test/render-container.test.ts` (+3), `test/dispatch-fixtures.ts` (optional `canvas` on a print-file spec), `render/test/{api,contract,worker}.test.ts` (+1, +3, +5); edited `test/pod-publish.test.ts:349-361`, `test/health.test.ts`, `test/public-catalog.test.ts` (the migration pin). |

### Existing tests changed (the only ones)

- `test/pod-publish.test.ts:349-361`, "freezes the exact contract shape": the ONE existing assertion of a frozen print slot's exact key set. Each slot gains `frameMm`, `frameProvisional`, `sourcePx`. Its money lines (`productionCostMinor: 36_000`, `withholdMinor: 45_000`, totals `40_900`/`51_125`) are unchanged.
- `test/health.test.ts:36`, `test/public-catalog.test.ts:572`: the migration pin, 0052 → 0053.
- Not changed: every checkout, webhook and money suite passes as it was.

### Money is untouched: how it is proven

`test/print-canvas-snapshot.test.ts` makes the same checkout twice. Between the two it changes every input of the new fields: the artwork's pixels (3543×4724 → 5000×6000), the model's stand-in flag (false → true) and the frames' offsets (removed). The frame sizes stay the same, because they decide eligibility. Asserted:
- the checkout row's money columns serialise to the same bytes (`currency, subtotal_minor, shipping_minor, vat_minor, vat_rate_bp, discount_minor, total_minor`);
- the snapshot minus the three keys serialises to the same bytes;
- each line's `productionCostMinor`/`withholdMinor` and the totals are byte-identical, and equal the hand-computed 54 000 / 67 500 / 58 900 / 73 625 öre.

### Compatibility of the two deploy units

| Combination | What happens | Proven by |
|---|---|---|
| New Worker, OLD container | The old image POSTs acquire with no body. `parseAcquireJobTypes("")` = artwork only, so it is never handed a canvas job. Canvas jobs wait (`dispatch_stranded_30m` after 30 min) until the new image runs. | `test/render-container.test.ts` "an OLD container (no acquire body) is never handed the canvas job…"; `test/print-canvas-jobs.test.ts` "an acquire without a body…" |
| OLD Worker, new container | The new image POSTs `{ jobTypes: [...] }`. The old route never reads an acquire body and has no canvas table, so it serves artwork jobs exactly as before. The artwork envelope, its parser, its reports and their paths are byte-identical (no artwork test changed). | the container's unchanged artwork suites; `render/test/api.test.ts` (the body is the only acquire change) |
| New + new | Artwork first, then canvases; each kind reports on its own path. | `test/print-canvas-jobs.test.ts` "artwork jobs go first"; `test/render-container.test.ts` canvas drift tests |

### Staging can never reach SnapWear

PS1's test stays green unchanged (`snapwear-client.test.ts` "Staging can never build it…"). The canvas-on variant is `test/print-canvas.test.ts` "staging with every SnapWear value set and the canvas on never calls SnapWear". It sets every SnapWear value and `SNAPWEAR_SUBMIT_ENABLED=true` on staging with the canvas on:
- pointed at the fake, the canvas goes to the fake;
- pointed at `snapwear`, there is no client, so the row is held for the printer before any canvas is made;
- the SnapWear transport records zero calls.

### One number

- `print_canvas_jobs` has no cost column, and no tenant route selects it.
- The new snapshot fields are a frame, a flag and pixel counts. No amount.
- `test/print-canvas.test.ts` "a canvas-dispatched order reads exactly like an artwork-dispatched one, with no canvas fact in it" compares the seller's order detail and the seller's order-list row for the two orders. The key paths are the same, and neither text contains `print/orders`, `canvas`, `frameMm`, `frameProvisional`, `sourcePx`, `pod/` or `spec`.

### To confirm with SnapWear

Each holder is ONE constant or ONE function in `cloudflare/src/dispatch/print-canvas.ts` unless another file is named, with its assumption written beside it. Test files: `test/print-canvas.test.ts` unless named.

| Q | Assumption taken | Holder | Test | If the answer differs |
|---|---|---|---|---|
| **C1** frames | The frame the line froze is the article's MODEL frame from PrintArea.xlsx (via the seed), and SnapWear prints every SKU of that model into it. Per-SKU `frameVariants` (±3 mm) are not modelled. | `canvasFrame` | "C1 (canvasFrame): a line with no frozen frame fails closed…"; "fails closed on a line frozen before CP6-PS2 (no frame)…" (end to end, with its alert) | Correct frames go into the printer's capabilities (the seed). Per-SKU frames need a SKU-level frame in capabilities plus the freeze (`pod-mappings.ts` `decideProductionLine`). |
| **C1** missing frames | 64400 longsleeve, B445 beanie, SF500 hoodie, TRUCKER cap and W101 bag have no frame in PrintArea.xlsx and are seeded as stand-ins (`provisional`). A stand-in frame is **never printed**: terminal `print_canvas_frame_provisional` with the `dispatch_failed` alert. | `canvasFrame` | "C1 (canvasFrame): a stand-in frame (64400, B445, SF500, TRUCKER, W101) fails closed…"; "fails closed on a stand-in frame…" (end to end) | Real frames arrive via the seed with `provisional: false`. Until then a paid order for those articles needs a human (see open question 2). |
| **C2** offset reference | The canvas IS the frame. SnapWear's `offsetTopMm` (whichever reference) is applied by SnapWear when it places the frame, and is not drawn into the canvas. | `canvasReference` | "C2 (canvasReference): the canvas IS the frame; SnapWear's offsetTopMm is not drawn into it" (an offset of 30, 60 or none gives the same spec) | If they want a pallet-sized file: return the pallet as `canvasMm` and the frame's place on it as `frameOriginMm`. Pallet sizes must first join the printer's capabilities (they are in PrintArea.xlsx for 20 models, not in capabilities). The second fit check in `canvasSpec` then matters (mutation W9). |
| **C3** DPI | 300 | `SNAPWEAR_CANVAS_DPI` | "C3 DPI (SNAPWEAR_CANVAS_DPI): 300; another answer only changes the pixel sizes" | Change the constant. New jobs get the new pixel sizes; jobs already queued keep their frozen spec. |
| **C3** file size | ≤ 100 MiB | `SNAPWEAR_MAX_CANVAS_BYTES`, checked at completion (`print-canvas-jobs.ts` `completeCanvasJob`) | "C3 size (SNAPWEAR_MAX_CANVAS_BYTES): 100 MiB"; `print-canvas-jobs.test.ts` "C3 size: a canvas over SNAPWEAR_MAX_CANVAS_BYTES is never promoted; the job fails and the row is released" | Lower it. A larger canvas fails closed with the alert. Follow-up if large photos hit it: a higher zlib level, or a palette PNG for flat-colour motifs. |
| **C3** transparency | A transparent PNG is accepted (ink only where the motif is) | `SNAPWEAR_CANVAS_TRANSPARENT` | "C3 alpha (SNAPWEAR_CANVAS_TRANSPARENT): accepted; if not, every line fails closed"; `render/test/canvas.test.ts` "makes the frame-sized RGBA PNG: transparent everywhere but the motif box…" | `false` makes `canvasSpec` refuse every line (`print_canvas_background_unsupported`). A flat background would need the garment colour and their rule. |
| **C3** 1:1 (new question) | They print the file as received: its top-left at the frame's top-left, at its DPI. No trimming or re-centring of the transparent margin. | precondition of the switch (no code can hold it) | "switch on: parks the row… and sends the canvas" (the body carries `layouts: [{ location }]` only, and exactly the five known keys) | If they trim, our offset is lost: leave `PRINT_CANVAS_ENABLED` off in production and send the motif (today's file). |
| ours: placement | Centred on both axes at the frozen width, no rotation, as the studio's `serverPlacement` draws it | `motifPlacement` | "OURS (motifPlacement): centred on both axes, the studio's placement, never top-aligned" | Top-alignment means this function AND `src/admin-app/adapters/studio.js` `serverPlacement`, in one release. |
| ours: colour | 8-bit sRGB RGBA, no ICC conversion (the master is already sRGB from the artwork pipeline), pHYs = the DPI | `render/src/canvas.ts` `renderCanvas` | `render/test/canvas.test.ts` (density 300, 4 channels) | If they want CMYK or an embedded profile: one sharp option there. |

### Reviewer wiring

- **Migration 0053** through the preflight on staging. It is additive: one table, one index, five triggers; no existing table changes. `REQUIRED_MIGRATION` and the two test pins are already on 0053. **The next free number is 0054.** HANDOVER's FP note about a print-jobs index "as migration 0053" now needs 0054 if it is ever built.
- **Staging var.** `wrangler.jsonc` `env.staging.vars.PRINT_CANVAS_ENABLED = "true"` is in the tree.
  - The preflight checks only named API vars (`APP_ENV`, `CANONICAL_ORIGINS`, `AUTH_BASE_URL`, `SERVICE_NAME`, `R2_PRIVATE_BUCKET_NAME`, `DISPATCH_TARGET`, `R2_JURISDICTION`, `PUBLIC_OBJECT_BASE_URL`), and `PLATFORM_ALERT_EMAIL` went in the same way.
  - `npm run types:check` is up to date.
  - **Production: nothing.** No var. Turn it on only after C1–C3, and before or with `SNAPWEAR_SUBMIT_ENABLED`.
- **The container image changes** (`render/src/*`), so the API deploy rebuilds it from `render/Dockerfile` (Docker must run locally).
  - Either order of rollout is safe (see "Compatibility").
  - Until the new image runs, canvas jobs wait and staging's POD dispatches park; `dispatch_stranded_30m` names them after 30 minutes.
- No `pinned.*.json`, `scripts/` or `guard/` change was made.

### Staging smoke (after 0053 and `scripts/cf-deploy.sh staging api`)

1. **Buy.** On the staging storefront, buy a POD product with a front and a back print (a tee whose SnapWear model has real frames, e.g. 64000), delivery by parcel. The webhook writes the order and nudges the dispatch.
2. **The park and the jobs** (read-only D1). Within seconds of payment:
   ```
   npx wrangler d1 execute chopshop-stg --env staging --remote --command "SELECT line_no, slot, state, attempt, error, canvas_key, canvas_sha256, canvas_bytes, spec_json FROM print_canvas_jobs WHERE order_id = '<orderId>' ORDER BY line_no, slot"
   npx wrangler d1 execute chopshop-stg --env staging --remote --command "SELECT outbox_id, status, attempts, last_error, next_attempt_at FROM outbox_events WHERE aggregate_id = '<orderId>' AND event_type = 'dispatch'"
   ```
   - First, expect: 2 rows `queued` or `leased`; the dispatch row `pending`, `last_error = 'print_canvas_pending'`, `next_attempt_at = 253402300797999`.
   - Within about 1–2 minutes, expect: both rows `completed`, with `canvas_sha256` and `canvas_bytes` set; the dispatch row `done`, `attempts = 2`; the line `accepted`.
   - For a 64000 front, expect `spec_json` with `canvasPx {w: 4606, h: 5787}`, `dpi 300`.
3. **The container's own numbers.** Worker logs: `"message":"canvas job metrics"` per job (`wallMs`, `peakRssMb`, `canvasBytes`). Container logs: `job_started` / `job_ok` with `"jobType":"pod.print_canvas"`.
4. **The file.** Fetch the canvas and read it back:
   ```
   npx wrangler r2 object get "chopshop-stg-private/pod/<tenantId>/print/orders/<orderId>/1-front.png" --jurisdiction eu --remote --file /tmp/canvas-front.png
   cd cloudflare/render && node -e "const s=require('sharp');s('/tmp/canvas-front.png').metadata().then(m=>console.log(m.width,m.height,m.density,m.channels));s('/tmp/canvas-front.png').trim().toBuffer({resolveWithObject:true}).then(r=>console.log('motif',r.info.width,r.info.height,'at',-r.info.trimOffsetLeft,-r.info.trimOffsetTop))"
   ```
   - Expect `4606 5787 300 4`.
   - Expect a motif box centred: left ≈ (4606 − w) / 2, top ≈ (5787 − h) / 2, matching `spec_json.offsetPx` and `motifPx`. The trim is approximate if the motif has its own transparent margin.
   - `sha256sum /tmp/canvas-front.png` equals `canvas_sha256`.
5. **The printer got the canvas.** Platform console → Tryckjobb (or `SELECT payload_json FROM fake_printer_jobs WHERE order_id = '<orderId>'`). Each `artworks[].url` path ends in `/print/orders/<orderId>/1-front.png` and `…/1-back.png`, front first. `layouts` is `[{"location":"front"},{"location":"back"}]`, with no offset field.
6. **The seller sees nothing new.** Open `https://chopshop-admin-stg.kent-ee2.workers.dev/admin/orders/<orderId>` as the shop's admin. The page reads like any POD order: no canvas, frame or key anywhere.
7. **Switch off.** Set `PRINT_CANVAS_ENABLED` to anything but `"true"` and buy again. Expect no `print_canvas_jobs` row, and the fake's `artworks[].url` ends in `/print/<artworkId>.png` (today's file). Turn it back on afterwards.
8. **Not testable on staging:**
   - a lost printer answer (tested in `test/print-canvas.test.ts`);
   - a canvas failing for good (would need a broken master);
   - the old-image/new-Worker mix (tested in `test/render-container.test.ts`).

### Mutations

Each one was applied once to the working tree by a script (copy, edit, run the named test files, copy back), with no git. Every file was restored afterwards: the final gates below ran on the restored tree.

| # | Mutation | Result |
|---|---|---|
| W1 | switch on for any value | 4 failed |
| W2 | C1: a stand-in frame accepted | 2 failed |
| W3 | C1: a missing frame guessed (390×490) | 2 failed |
| W4 | C2: the offset drawn into the canvas | 6 failed |
| W5 | C3: DPI 300 → 301 | 5 failed |
| W6 | C3: size limit not enforced | 1 failed |
| W7 | C3: transparency not checked | 1 failed |
| W8 | placement top-aligned | 3 failed |
| W9 | `canvasSpec`'s motif-vs-frame check removed | **0 failed: equivalent today.** With the canvas = the frame (C2), the second check (motif inside the canvas) refuses the same cases. The first one matters only if C2's answer makes the canvas larger than the frame (a pallet). Kept as that guard. |
| W10 | the "already submitted keeps its artwork file" rule removed | 2 failed |
| W11 | a failed canvas not terminal | 2 failed |
| W12 | park without "a canvas is still pending" (the race) | 1 failed |
| W13 | a completion releases while a sibling is pending | 2 failed |
| W14 | a completion releases nothing | 8 failed |
| W15 | the reaper releases nothing | 1 failed |
| W16 | a completed canvas not checked against the frozen master | 1 failed |
| W17 | a bodiless (old) acquire gets canvas jobs | 2 failed |
| W18 | canvas jobs before artwork jobs | 1 failed |
| W19 | the completion's key not checked | 1 failed |
| W20 | a canonical conflict ignored | 1 failed |
| W21 | checkout does not freeze the frame | 2 failed |
| W22 | dispatch never uses canvases | 12 failed |
| W23 | the sweeper's backstop removed | 1 failed |
| W24 | the sweeper's canvas re-nudge removed | 1 failed |
| W25 | the frozen stand-in flag not parsed | 12 failed |
| W26 | 0053 `line_exists` a no-op | 1 failed |
| W27 | 0053 `insert_once` a no-op | 1 failed |
| W28 | 0053 `identity_immutable` a no-op | 1 failed |
| W29 | 0053 `settled_final` a no-op | 1 failed |
| W30 | 0053 `never_deleted` a no-op | 1 failed |
| W31 | 0053 CHECK "completed ⇔ sha256 + bytes" removed | 6 failed |
| W32 | a failure waits for its siblings before releasing | 1 failed |
| W33 | PS1's gate without `APP_ENV = production` (staging would build SnapWear) | 1 failed (the canvas-on staging test) |
| R1 | container: input sha256 not checked | 2 failed |
| R2 | container: decoded pixels not checked | 1 failed |
| R3 | container: opaque background | 2 failed |
| R4 | container: density not written | 1 failed |
| R5 | container: the motif-outside refusal removed | 1 failed |
| R6 | container: acquire without the `jobTypes` body | 1 failed |
| R7 | container: canvas report on the artwork path | 1 failed |
| R8 | container: spec bounds unchecked | 1 failed |
| R9 | container: canvas leases run as artwork jobs | 5 failed |

### Limits, measured (in addition to §7)

- **Local, on the build Mac** (sharp 0.35.4 through `renderCanvas`, the same settings; a one-off scratch script, not committed). This is not the container's ½ vCPU, so the times are indicative only.
  - Logo 3543×4724 → canvas 4606×5787: 0.4 s, 0.24 MB, peak RSS 124 MB.
  - Noise-like 3543×4724: 1.2 s, 53.7 MB, peak 262 MB.
  - Noise-like 10 000×10 000 master (the decode ceiling) → 4606×4606 motif: 1.5 s, 51.4 MB, peak RSS **687 MB**.
- On `standard-1` (½ vCPU, 4 GiB), expect roughly 5–15× the time, i.e. well under a minute, against the 10-minute lease. Memory: under 1 GiB of 4.
- The staging smoke's `canvas job metrics` give the real numbers.
- A truly random full-frame motif would approach the 106.6 MB raw size and be refused by C3's 100 MiB. Real photographs compress far below that.

## Decisions taken on defaults (the owner must confirm)

The coordinator answered "defaults" to the nine phase-1 questions. Built accordingly:

1. **Vertical placement: centred**, as the studio shows (`motifPlacement`).
2. **Switch: staging on** (`wrangler.jsonc`), **production off** (no var).
3. **A pre-PS2 line under the switch fails closed** (`print_canvas_frame_missing` + `dispatch_failed`), and is never sent as the artwork file.
4. **Stand-in frames fail closed at dispatch** (`print_canvas_frame_provisional`). No checkout gate was built.
5. **Artwork jobs before canvas jobs** on acquire.
6. **100 MiB** file-size assumption.
7. **No deadline** beyond the 30-minute stranded alert. A canvas waits for a container indefinitely, without spending attempts.
8. **Canvases kept**, with no lifecycle rule.
9. **The three additive snapshot fields at checkout.** Done; money byte-identical (proven, above).

## Open questions

1. **For SnapWear, with C1–C3:** do they print a received PNG 1:1 from the frame's top-left, at its DPI, without trimming transparent margins? (C3 "1:1" above.) If not, the canvas must stay off.
2. **For Mikael:** five SnapWear articles (64400, B445, SF500, TRUCKER, W101) have stand-in frames. With the canvas on, a paid order for one of them fails at dispatch, and a human places it. Should checkout refuse those articles while `PRINT_CANVAS_ENABLED` is on? That is a small gate in `decideProductionLine`, but it is the money path, so it is not built without a yes.
3. **For Mikael:** a canvas that fails for good (`print_canvas_failed`) ends the dispatch for good, like every terminal dispatch. Should the platform get a "render again" action (a new canvas row is impossible by design; it would need a reset that the `settled_final` trigger forbids today)? Default: no; a human places the job by hand.

## Not done

- No `render/bench` extension (the measurement above was a scratch script).
- No admin or console page shows canvas state. A platform view of `print_canvas_jobs` is a follow-up.
- No alert kind of its own for a canvas failure. It surfaces as `dispatch_failed` with `last_error = 'print_canvas_failed'` (or the refusal's code); the canvas row holds the container's code.
- `LAUNCH_TODO.md` A5 was not edited (the orchestrator's document).

## In existing code, believed wrong or worth a look (not fixed)

- `cloudflare/src/pod/render-jobs.ts:575` and `:943`/`:1054` (`recordAttemptFailure`, the conflict path, `commitVerdict`): the commit-time fence uses `Date.now()`, while the freshness check uses the request's `now`. Harmless in production (they are milliseconds apart), but a test that injects a clock cannot drive these paths consistently. `print-canvas-jobs.ts` mirrors it on purpose, to stay one pattern.
- `cloudflare/src/dispatch/dispatch-effect.ts` `retryLater`: PS1 already noted that a previously-`unknown` row that hits a retryable failure before the printer call goes back to `pending`. Still so.
- `docs/cf-port/HANDOVER.md` (14:41 entry) suggests a print-jobs index as "migration 0053": that number is now taken by this unit.

## Gates (final, on the restored tree)

- `cd cloudflare && npx tsc --noEmit`, `-p web`, `-p admin`, and `cd render && npx tsc --noEmit -p .`: all clean.
- `cd cloudflare && npx vitest run`: **Test Files 116 passed (116), Tests 4618 passed (4618).** Before this unit: 112 / 4522. That is 4 new files, +96 tests, 0 changed outcomes. Two `Network connection lost` uncaught-exception lines print during the run, as at HEAD.
- `npm run types:check`: "Types at worker-configuration.d.ts are up to date."
- `cd cloudflare/render && npx vitest run`: **Test Files 7 passed (7), Tests 136 passed (136)** (before: 6 / 121).
- `node guard/guards.test.mjs`: **guard: PASS** (allowlist 294 = baseline). The guard scans tracked files only. My new files are untracked, so I grepped every new file and every added line for the forbidden word families: no match.
- Extra: `node --test scripts/cf-port/migrate/test/*.test.mjs` (the migrate tools read every migration): 554 / 554 passed.
