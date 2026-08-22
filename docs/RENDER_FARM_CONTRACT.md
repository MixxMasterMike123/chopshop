# Render Farm Contract — v0 draft (2026-08-22)

The hybrid architecture's one seam. **Decision (2026-08-22):** the platform's end-state is
hybrid — the Cloudflare Worker is the system of record and the entire synchronous HTTP
surface; Firebase is demoted to a **render farm**: a stateless media-compute appliance
(sharp today, ffmpeg later) reached only through the job contract in this document.
This supersedes the "Container for Sharp/FFmpeg" line in the migration architecture:
Containers are no longer required for cutover. The same contract could later be served
by a Cloudflare Container without the caller changing — that is the point of having it.

## Principles (non-negotiable)

1. **The farm knows nothing.** No Firestore, no Firebase Auth in the job path, no tenant
   model, no reading CF data. A job is self-contained: everything the farm needs rides in
   the payload; everything it produces goes back through the payload's output URLs.
   Storage paths are opaque strings to the farm.
2. **One direction.** The Worker calls the farm; the farm never calls the Worker. The
   synchronous response IS the callback for v0 job types.
3. **Pure function.** Same job in → same bytes and verdict out. Replays are safe by
   construction; `jobId` exists for logging correlation, not for dedupe state.
4. **The Worker owns all authorization** (admin-of-shop, path prefixes, quotas) before a
   job is ever created — mirroring today's split where `processPodArtwork`'s guards wrap
   the pure `runPipeline` core. The farm's only auth question is "is the caller the
   platform?".

## Transport & auth

- HTTPS POST to a dedicated `onRequest` Firebase function (NOT `onCall` — there is no
  Firebase client, no App Check, no Firebase Auth token in this path).
- Auth: `Authorization: Bearer <RENDER_FARM_TOKEN>` — a high-entropy shared secret held
  in the Worker's secrets and Firebase Secret Manager. Constant-time compare. Anything
  else → 401 with a constant body. Rotation = set new on both sides (farm may accept two
  during a rotation window).
- Synchronous request/response. Prod parity: the artwork pipeline is admin-time work the
  uploader already waits ≤300 s for behind a spinner. Async job types (video) get a
  contract revision with a queue + polling, not a bolt-on.
- Farm-side limits carried over from prod experience: 2 GiB memory, 300 s timeout,
  `sharp.cache(false)`, concurrency 1 (the 2026-07-27 OOM lessons stay encoded).

## Job envelope

```json
{
  "contract": 1,
  "jobType": "pod.process_artwork",
  "jobId": "uuid — caller-generated, for log correlation",
  "input": {
    "url": "signed GET URL (R2 presigned, short TTL)",
    "maxBytes": 157286400
  },
  "profile": {
    "id": "front_a3",
    "min_dpi": 300,
    "print_area_mm": { "w": 250, "h": 350 },
    "max_file_mb": 150,
    "accepted_formats": [{ "ext": "png" }, { "ext": "jpg" }, { "ext": "tiff" }, { "ext": "webp" }]
  },
  "output": {
    "printPngPutUrl": "signed PUT URL (R2 presigned)",
    "previewWebpPutUrl": "signed PUT URL (R2 presigned)"
  }
}
```

`profile` is the exact field set today's `runPipeline` consumes (verified against
`functions/src/pod/processArtwork.ts` 2026-08-22) — resolved by the WORKER from its own
profile store and passed inline, which is what frees the farm from Firestore.

## Response

- `200 { ok: true, fields: { ...the artwork-doc field set runPipeline returns today:
  dimensions, dpi verdict, tier, alpha profile, pipelineVersion, ... }, notices: [...] }`
  — outputs already PUT to the given URLs before the 200 is sent.
- `200 { ok: false, reasons: [{ code, message }] }` — gate rejection is a RESULT, not an
  error; codes/messages unchanged from prod (Swedish user-facing messages stay).
- `4xx/5xx` only for job-level faults: bad auth (401), malformed envelope or unknown
  `contract`/`jobType` (400), input fetch/output PUT failure or pipeline crash (502).
  Error bodies are constant and detail-free; detail goes to farm logs keyed by `jobId`.

## Farm-side hardening

- Fetch the input URL only if its host is on the platform storage allowlist (the R2
  endpoints) — the SSRF discipline from the migrators applies here too.
- Enforce `input.maxBytes` while streaming the download, before sharp sees a byte.
- Never log URLs (they are bearer capabilities); log `jobId` + sizes + verdict only.
- Hold nothing after the response: no temp files, no caches, no queues.

## Adaptation plan (the keystone checkpoint)

1. Extract `runPipeline`'s pure core so the existing `processPodArtwork` callable and the
   new job endpoint share it byte-for-byte (the `migrationShared.ts` extraction pattern —
   the Firebase app keeps working unchanged through the transition).
2. New `onRequest` endpoint implementing this contract beside it. No behavior change for
   the live app; the endpoint is dark until the Worker calls it.
3. Worker side lands with the CF POD checkpoint: profile store, artwork upload flow, job
   dispatch, verdict persistence.

## Reserved / open

- `jobType: "studio.render_video"` (ffmpeg, content-studio) — reserved; needs the async
  revision; deferred until the add-on ports.
- R2 presigned PUT specifics (headers signed into the URL, content-type pinning) — decide
  at implementation against the R2 SDK.
- Whether the farm double-reports output sha256 in the response for the Worker to verify
  the PUTs — cheap, probably yes.
