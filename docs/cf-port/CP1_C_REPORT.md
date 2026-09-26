# CP1-C report — render jobs with lease fencing, staging fake printer

Branch `cf-port`, worker in `cloudflare/`. Nothing committed, nothing deployed, no `wrangler` command reached Cloudflare, no state-changing git command run (the reviewer commits).

**Tests:** baseline `npm run check` green at **1097 tests / 31 files** → final **1229 tests / 33 files**, green (types:check, tsc, vitest). `node --test guard/guards.test.mjs` passes; a forbidden-string scan over every new or changed file is clean. No dependency added.

```
 Test Files  33 passed (33)
      Tests  1229 passed (1229)
   Start at  22:00:37
   Duration  31.03s (transform 18.65s, setup 210.35s, import 1.95s, tests 22.76s, environment 1ms)
```

| File | Before | After | Why |
|---|---|---|---|
| `test/render-jobs.test.ts` (new) | — | 64 | Part 1 contract |
| `test/fake-printer.test.ts` (new) | — | 59 | Part 2 |
| `test/pod-artwork.test.ts` | 102 | 109 | sync → async rewrite (below) |
| `test/email-queue-consumer.test.ts` | 39 | 41 | `-render-jobs` now routed, not held |
| `test/health.test.ts`, `test/public-catalog.test.ts` | 3, 22 | 3, 22 | `/ready` migration pin → `0018` |

**Mutation checks** (each applied to the source, the suite run, then the source restored; the tree was verified byte-identical to a snapshot afterwards). 24 of 26 mutations were killed:
- the commit-time fence ignoring lease expiry, or ignoring attempt and token;
- no reaping at 3 attempts;
- promotion without sha256, or overwriting a canonical key;
- sweeping on a wrong token;
- artwork delete not ending the job;
- no attempt-key check;
- the render token or the limiter disabled;
- a token floor of 16;
- newest-first acquire;
- no requeue;
- terminal failure keeping the artwork row;
- non-idempotent replay;
- the fake printer outside staging, or ignoring the target, SKU, quantity, duplicate precheck, token, or unknown order;
- any 400 treated as a duplicate.

Two mutations survive, both because a second independent layer catches the same defect:
- The JS freshness check ignoring the token: the SQL fence rejects the wrong token, and the fence mutation above proves the fence is load-bearing.
- Removing the HEAD size check: `promote()` re-checks the size on `get()`.

---

## Part 1 — `render_jobs` with lease fencing (PLAN §2.6)

### Files
- New:
  - `migrations/0017_render_jobs.sql`
  - `src/pod/render-jobs.ts` (the state machine)
  - `src/routes/render-jobs.ts` (the HTTP surface)
  - `src/pod/render-jobs-queue.ts` (the queue consumer)
  - `src/lib/bearer.ts` (bearer parsing, constant-time compare, sha256, token mint)
- Changed:
  - `src/pod/artwork-store.ts`: `enqueueArtwork`, `SYNC_RENDER_FALLBACK`, shared canonical keys; `deleteArtwork` ends live jobs.
  - `src/pod/render-farm-client.ts`: `isR2PresignerConfigured` split out of `isPodConfigured`; `parseFarmResult` extracted, so completion and the synchronous dispatch share one parser; redirect fix (see "Bug found").
  - `src/app.ts`: routes, the admin POST switch, `REQUIRED_MIGRATION` → `0018_fake_printer.sql`.
  - `src/queues.ts`.

### Schema (0017)
`alerts` did not exist, so it is created here.

**`render_jobs`**
- Columns: `id, tenant_id, artwork_id, version, attempt, state, lease_token_hash, lease_until, input_key, input_bytes, profile_json, output_prefix, error, created_at, updated_at, completed_at`.
- Differences from the brief's column list, deliberate:
  - `lease_token_hash` holds the SHA-256 of the lease token. The raw token is returned once to the farm and never stored, as with receipts. It is named `_hash` so nobody compares a raw token to it.
  - `input_bytes` and `profile_json` are frozen at enqueue, so every attempt is a replay of the same job even if the platform edits or retires the profile.
- States `queued → leased → completed | failed`. `attempt` counts attempts started (queued 0–2, leased 1–3).
- CHECKs:
  - Per-state shape: a queued row has no lease; a leased row has a lease; completed ⇔ `completed_at`; failed ⇒ `error`.
  - ISO-8601 canonical time via the strftime round-trip, as in 0013/0014.
  - `error` is a code (`[A-Za-z0-9_.:-]{1,100}`), never farm text or a URL.
  - `input_key` is contained under `shops/{tenant}/`.
  - `output_prefix` is pinned exactly to `pod/{tenant}/render/{artwork}/{version}/`.
  - `UNIQUE (artwork_id, version)`.
- `artwork_id` is deliberately **not** a foreign key. The job row must outlive a deleted or terminally failed artwork, so a still-running farm can be answered 409 and its attempt outputs swept; both need the row's prefix. The tenant match is enforced by an insert trigger.
- Triggers:
  - `tenant_id` immutable.
  - Identity immutable: artwork, version, input, profile, prefix, created_at.
  - Terminal rows fully frozen.
  - `attempt` never decreases.
  - `queued → completed` impossible.
  - The artwork must belong to the job's tenant at insert.
- Indexes: `(tenant_id, created_at DESC)`, `(state, created_at, id)` for acquire, `(state, lease_until)`.
- Rows are deletable, for a future retention sweep.

**`alerts`**
- Columns: `id, tenant_id NULL, kind, severity ∈ info|warning|critical, message, resource_type, resource_id, created_at, resolved_at NULL`.
- Facts are immutable; resolution is final; no delete.
- Indexes `(tenant_id, created_at DESC)`, `(resolved_at, created_at)`, `(resource_type, resource_id)`.
- Writers use deterministic ids (`render-job-failed:{jobId}`), so the primary key is the dedupe.

### Endpoints
Common to all three:
- Authentication is **only** `Authorization: Bearer <RENDER_FARM_TOKEN>`, constant-time (hash both sides, then `timingSafeEqual`). No session, no tenant hostname.
- The whole `/v1/render/*` prefix is one handler, in this order:
  1. **Configuration gate**, before any D1 access. It requires all of:
     - `RENDER_FARM_TOKEN` ≥ **32** characters;
     - presigner configuration (R2 keys, account id, bucket name, known jurisdiction);
     - the `PRIVATE_BUCKET` binding.

     It does **not** require `RENDER_FARM_URL`: the pull surface never calls the farm.
  2. **Per-IP limiter**, `render-api-ip`, 120 per minute. It answers 429 with `Retry-After`.
  3. **Token check.**
  4. **Path and method.** Anything wrong is the opaque 404 `{"error":{"code":"not_found","message":"Route not found"}}`.

**`POST /v1/render/jobs/acquire`** (no body)
- One atomic D1 batch:
  1. End expired leases already on attempt 3: `failed` (`error: lease_expired`) + alert + tenant audit + removal of the still-`processing` artwork row.
  2. Lease the oldest `queued`, or `leased` with `lease_until < now`, job: `attempt + 1`, fresh token, 10-minute lease; `error: lease_expired` when it was a re-lease.
- The previous attempt's prefix is swept.
- `204` with an empty body when nothing is acquirable.
- `200`:
```json
{
  "contract": 1,
  "jobType": "pod.process_artwork",
  "jobId": "<render job uuid>",
  "input": { "url": "<presigned GET on the original, 300 s>", "maxBytes": 4000000 },
  "profile": { "id": "apparel_dtg", "min_dpi": 300, "print_area_mm": { "w": 300, "h": 400 },
               "max_file_mb": 50, "accepted_formats": [{ "ext": "png" }, { "ext": "jpg" }] },
  "output": { "printPngPutUrl": "<presigned PUT, content-type image/png pinned, 900 s>",
              "previewWebpPutUrl": "<presigned PUT, content-type image/webp pinned, 900 s>" },
  "attempt": 1,
  "leaseToken": "<43-char base64url>",
  "leaseUntil": "2026-09-26T20:10:00.000Z",
  "outputPrefix": "pod/<tenant>/render/<artwork>/1/attempt-1/"
}
```
This is the unchanged contract-v0 envelope, so the farm's existing validator and pipeline work as they are, plus the lease fields. The brief's shape had no output URLs and no profile. The farm holds no R2 credentials and cannot run the gate without the profile (RENDER_FARM_CONTRACT principle 1), so both are included. The PUT URLs point at `{outputPrefix}print.png` and `{outputPrefix}preview.webp`.

**`POST /v1/render/jobs/{id}/complete`**
The body is the farm's existing verdict body plus the lease fields. Allowed keys are exactly those shown; anything else is a 400.
```json
{ "attempt": 1, "leaseToken": "…", "ok": true,
  "fields": { "widthPx": 3200, "heightPx": 3200, "effectiveDpi": 325, "maxPrintMm": { "w": 250, "h": 250 },
              "pipelineVersion": 1, "profileId": "apparel_dtg" },
  "notices": [{ "code": "opaque", "message": "…" }],
  "outputs": { "printPng":    { "key": "<outputPrefix>print.png",    "sha256": "<64 hex>", "bytes": 500000 },
               "previewWebp": { "key": "<outputPrefix>preview.webp", "sha256": "<64 hex>", "bytes": 2000 } },
  "metrics": { "wallMs": 41250, "peakRssMb": 812 } }
```
A rejection verdict is `{ "attempt", "leaseToken", "ok": false, "reasons": [{ "code", "message" }] }`.

How it is processed:
- **Fence.** Accepted only while `state = leased`, `attempt` equals the current attempt, the token hash matches, and `lease_until > now`. The fence is checked in JS and again in SQL on every write.
- **Extend.** The fenced completion first extends its lease by a 2-minute promotion window in one conditional UPDATE. From that moment no other attempt can be leased while it copies.
- **Verify.** For `ok: true`, both reported keys must equal this attempt's keys (else 400). Both attempt objects are then HEADed and their sizes compared.
- **Promote.** Each object is copied through the binding to the canonical key; R2 bindings have no server-side copy. The copy is `put(..., { sha256: reported })`, **so R2 itself verifies the reported hash against the bytes** (a mismatch is refused with 10037 and nothing is written). This is stronger than the synchronous path's size-only check. Canonical keys are immutable:
  - an existing object with the same sha256 and size is accepted as this output (a duplicate completion);
  - anything else is `canonical_conflict`, which fails the job with an alert;
  - an existing object with no recorded sha256 is also a conflict (fail closed).
- **Commit.** One D1 batch:
  - job → `completed`, fenced again against the clock **at commit time**;
  - the artwork row, written exactly as the synchronous path writes it (same fields, same `status = 'processing'` guard), conditioned on "this attempt completed the job";
  - an audit row `pod.artwork.ready` or `pod.artwork.rejected`, with actor NULL and metadata `{ …same as sync, attempt, renderJobId }`.

  The attempt prefix is swept afterwards.
- **Metrics.** Optional; at most 20 finite numbers. They are logged keyed by job id, for the D6 benchmark, and never stored.

Responses:
- `200 {"status":"completed"}`. An exact replay of the accepted completion also gets 200 (idempotent).
- `400 {"error":{"code":"invalid_request","message":"Request is not valid"}}`. The lease is left untouched, so the farm may resend.
- `404 {"error":{"code":"not_found","message":"Job not found"}}` for an unknown job.
- `409 {"error":{"code":"lease_lost","message":"The lease on this job is no longer held"}}`. This covers an expired lease, an older attempt, a wrong token, or an ended job. The attempt's outputs are **swept** only when that attempt is certainly dead: an older attempt, or the current attempt reporting with its own token. A wrong token never deletes a live holder's bytes.
- `409 {"error":{"code":"canonical_conflict",…}}`: the job is failed with an alert.
- `422 {"error":{"code":"outputs_unverified","message":"The reported outputs could not be verified"}}`: an object is missing, a size is wrong, or the sha256 was refused by R2. This counts as a failed attempt: requeued, or failed with an alert after the third.

**`POST /v1/render/jobs/{id}/fail`**
- Body `{ "attempt": 1, "leaseToken": "…", "error": "input_fetch_failed" }`. The error must be a code; text or a URL gets a 400.
- Same fence as complete.
- The attempt's outputs are swept. Then:
  - attempts 1–2: requeued, `200 {"status":"queued"}`, error stored;
  - attempt 3: `failed` + alert + audit + artwork row removed, `200 {"status":"failed"}`.
- Otherwise 400, 404 or 409, as for complete.

### Producer: artwork creation is now asynchronous
- `POST /v1/admin/pod/artwork` → `enqueueArtwork`:
  - same profile and ownership resolution as before;
  - one batch: `pod_artwork` 'processing' + `render_jobs` 'queued' + the `pod.artwork.dispatch` audit, whose metadata gains `renderJobId`;
  - then a best-effort `RENDER_JOBS_QUEUE.send({ renderJobId })`. A queue failure is logged and does not fail the request: the row is the truth.
- Response: **202** `{ "artwork": { …the existing detail projection, "status": "processing", verdict fields null } }`.
- The existing `GET /v1/admin/pod/artwork/{id}` is the poll. The UNIQUE (tenant, original, profile) conflict answers 409 as before.
- **Terminal failure** (three attempts, or a canonical conflict) removes the `processing` artwork row, keeping the synchronous path's "replay is the retry" rule: the same body can be posted again, and the job row + alert + `pod.artwork.render_failed` audit remain as the record. The poll then answers 404.
- **`DELETE` of an artwork** now also ends its `queued`/`leased` job in the same batch (`error: artwork_deleted`, no alert, because it is the user's own cancellation). A farm still working on it gets a 409 and its outputs swept.
- **`SYNC_RENDER_FALLBACK = false`** (exported from `src/pod/artwork-store.ts`, with a comment). The route calls `createArtwork` (synchronous, unchanged apart from sharing `canonicalOutputKeys`) only if it is flipped. It is kept for review diffing; delete it with the farm dispatch once async runs on staging.
- Canonical keys are unchanged (`pod/{t}/print/{artwork}.png`, `pod/{t}/preview/{artwork}.webp`), so both paths produce identical rows.
- The brief mentions `decideScreening` inputs. There is no `decideScreening` in the worker yet: it is the product-screening machinery of PLAN §2.4, CP2. The completion writes exactly the artwork fields the synchronous path writes.

### Queue consumer (`-render-jobs`)
- `routeQueue` returns `render_jobs` for the suffix.
- The consumer acks every message, valid or malformed, and never logs a body. It does no D1 read: with a pull farm there is nothing to do, and a read whose answer changes nothing would only be a way to fail.
- The header documents the push-host hook: read the row and, if it is `queued`, wake a renderer, which still leases through acquire.

### Tests changed in `pod-artwork.test.ts`, and why
All of these follow from sync → async:
- **Old blocks replaced.** "dispatch — the happy path" (5) and "verdicts and failures" (7) are replaced by "creation — queued, then polled" (4), "render — the happy path" (5), "render — verdicts and failures" (7) and "the synchronous fallback" (3). The fallback block calls `createArtwork` directly, so the kept code stays proven.
- **Same assertions, new driver.** The farm is now driven through the **real** `/v1/render` routes (`runFarm`), with the same envelope validator pin.
- **Expectations that changed:**
  - POST 201 → 202.
  - A farm failure is now three failure reports, then the row is removed and a retry succeeds.
  - A size or upload lie → 422 + requeue, not 502.
  - A race → `[202, 409]` plus one job.
  - The placeholder hashes `"c"*64` are replaced by real sha256s, because R2 now verifies them.
- **Ownership and validation.** These now assert "no job queued" instead of "farm not called", which would pass vacuously now.
- **Rate limiter.** 5×202 then 429.
- **Helpers and hygiene.** The `createReadyArtwork` helper runs the farm. The mid-flight verdict race is reproduced between acquire and report. The response-hygiene "502 body" case became "a farm failure shows the admin `processing` and nothing about the farm". `beforeEach` now also clears `render_jobs`: acquire is global, and storage persists across the tests of a file (it is isolated per file, which I probed).

### Bug found and fixed (existing code)
`src/pod/render-farm-client.ts` passed `redirect: "error"` to `fetch`. **workerd rejects that with a TypeError on every call** (probed in the pool: *"Invalid redirect value, must be one of "follow" or "manual""*). So every real synchronous dispatch threw, was caught, and became `failed` (a 502). No test could see it, because every test injects a fake farm. It is fixed to `redirect: "manual"`: a 3xx is non-`ok` and therefore `failed`, never followed. The new printer client uses `manual` too, and classifies a 3xx as `unknown`. If the CP1 staging smoke ever dispatched to the farm, it would have hit this.

---

## Part 2 — fake printer (staging only)

### Files
- New:
  - `migrations/0018_fake_printer.sql`
  - `src/dispatch/snapwear-wire.ts` (wire shape, job-id helpers, SnapWear messages)
  - `src/dispatch/fake-printer.ts` (gate, validation, store)
  - `src/dispatch/snapwear-skus.ts` (the 323 SnapWear SKUs, copied from `docs/SnapWearDocs/snapwear-catalog.json`; a drift test compares them to the JSON)
  - `src/dispatch/printer-client.ts`
  - `src/routes/fake-printer.ts`
- Changed: `src/env.d.ts`, `vitest.config.ts`, `test/env.d.ts`.

**There is no SnapWear client in Firebase to mirror.** A6 was never built; the grep finds only comments. The wire shape comes from what is recorded as confirmed in `LAUNCH_TODO.md` and the SnapWear memory:
- `POST /api/order/add` with `x-api-token`;
- a duplicate `job_id` answers 400;
- a validation failure answers `422 {"status":"error","message":"Validation Failed","errors":{…}}`;
- `artworks[].url`, `mockups[].url`, `layouts[].location` ∈ front|back.

Provisional parts are listed in `snapwear-wire.ts`: the `items[]` wrapper, the pairing of `artworks[i]` with `layouts[i]`, the duplicate text (C5), the success body (C6), and address fields.

### Schema (0018)
- `fake_printer_jobs(id, tenant_id, job_id UNIQUE, order_id → orders, payload_json ≤ 64 KiB JSON object, received_at ISO)`.
- Triggers: tenant immutable, tenant must equal the order's tenant, write-once (no UPDATE). DELETE is allowed, for staging cleanup.
- Indexes `(tenant_id, received_at)`, `(order_id, received_at, id)`.
- The table exists in production too, because migrations are shared, but nothing can write it there.

### Endpoint `/v1/staging/fake-printer/jobs`
- **Exists only when** `APP_ENV === "staging"` AND `DISPATCH_TARGET === "fake-printer"` AND `FAKE_PRINTER_TOKEN` is at least 32 characters. Everything else is the opaque 404, decided before any D1 access: production, staging pointed at SnapWear, an unset or mis-cased target, a missing or short token, a wrong bearer (including the farm's token), wrong methods, sub-paths.
- No rate limiter: an unauthenticated caller reaches nothing but a hash compare.

`POST` (bearer):
```json
{ "job_id": "<orderUuid>-<lineNo>",
  "items":   [{ "sku": "2500170", "quantity": 2 }],
  "artworks":[{ "url": "https://…/print.png" }],
  "layouts": [{ "location": "front" }],
  "mockups": [{ "url": "https://…/mockup.webp" }] }
```
- **Duplicate check first**, the idempotent-API order: a resubmitted accepted id is always "already have it".
- **Then validation.** Unknown top-level fields, for example a shipping address, are accepted and stored verbatim.
- **Unknown order.** The fake is stricter than SnapWear in one respect: the order in `job_id` must exist in D1, because the job is filed under the order's tenant. Otherwise it answers 422 on `job_id`.
- `201 {"id":"<uuid>","status":"accepted"}`.
- `400 {"status":"error","message":"Job with this job_id already exists"}`. The message text is provisional (C5). The UNIQUE constraint arbitrates races: of 5 concurrent submissions, exactly one is accepted.
- `422 {"status":"error","message":"Validation Failed","errors":{"items.0.sku":["The selected items.0.sku is invalid."]}}`. Keys are Laravel-style field paths. The cases:
  - a missing, empty or non-https artwork URL, or no artworks;
  - an unknown SKU;
  - a quantity that is below 1, fractional, or a string, or no items;
  - a location other than front/back, or layouts not paired with artworks;
  - a bad mockup URL;
  - a missing or malformed `job_id` (line 0, no line), or an unknown order;
  - a non-object, non-JSON or oversized body.

`GET ?orderId=<uuid>` (bearer) returns `200 {"jobs":[{"id","jobId","orderId","tenantId","receivedAt","payload"}]}` in arrival order, at most 100. A bad or missing `orderId` gets `400 invalid_request`.

### Printer client (`src/dispatch/printer-client.ts`)
- `PrinterClient.submit(job) → accepted{printerJobId} | duplicate | rejected{code} | unknown{reason}`.
- **`unknown` is a deliberate fourth variant**, meaning "outcome not determined, resubmit the same id later". It covers network failures, 3xx, 401/403/404 (our configuration), 408/429/5xx, and an unreadable 2xx. A transport failure must be handled by the CP2 dispatcher, so it is in the type rather than a throw that could be forgotten.
- A 400 counts as `duplicate` **only** with the duplicate marker. Any other 400 is `rejected/bad_request`: treating an unrecognised 400 as "already accepted" could mark a job printed that the printer never took.
- `fakePrinterClient`:
  - The default transport calls the route handler **in-process** (a full Request/Response round trip through auth, validation and status codes), not a network self-fetch to the Worker's own hostname.
  - `FAKE_PRINTER_FETCH_OVERRIDE` is the symbol seam; tests route it through the public entrypoint.
  - The URL is `AUTH_BASE_URL + path`, with a 30 s timeout and `redirect: "manual"`.
- `snapwearClient` is a stub that rejects with `not_implemented` (A5/A6).
- `resolvePrinterClient(env)`:
  - `"fake-printer"` gives the fake, and only when the route gate holds; otherwise null;
  - `"snapwear"` gives the stub;
  - unset or anything else gives null, so the dispatcher holds.
- Helpers: `printerJobId(orderId, lineNo)` and `parsePrinterJobId`.

---

## For the reviewer to add (I did not touch `wrangler.jsonc`, pinned files or `worker-configuration.d.ts`)

| Name | Kind | Where | Value / note |
|---|---|---|---|
| `DISPATCH_TARGET` | var | `env.staging.vars` | `"fake-printer"` |
| `DISPATCH_TARGET` | var | `env.production.vars` | `"snapwear"`. Recommended so `resolvePrinterClient` gives the stub, not null; the preflight already pins `dispatchTarget` |
| `FAKE_PRINTER_TOKEN` | secret | staging only | ≥ 32 characters, high entropy. **Never set it in production** (the route is dark there regardless) |
| `RENDER_FARM_TOKEN` | secret (exists) | both | **must now be ≥ 32 characters**, or `/v1/render` stays 404. The admin POD surface still needs ≥ 16 |

After adding the vars, run `npm run types` (regenerate `worker-configuration.d.ts`), otherwise `types:check` fails. Both are declared optional in `src/env.d.ts` and injected in `vitest.config.ts` (`DISPATCH_TARGET: "fake-printer"`, a test-only token).

---

## Open questions / decisions for the reviewer

1. **Auth model vs PLAN §2.6.** PLAN says Containers means a private binding and Cloud Run means an audience-bound OIDC token. The brief (and this build) uses the shared bearer `RENDER_FARM_TOKEN` over the public entrypoint. The D6 host decision may want the OIDC variant, or `/v1/render` confined to the `Internal` entrypoint.
2. **The limiter answers 429**, not the bootstrap-style hidden 404. It runs before the token check, so an unauthenticated prober sending more than 120 requests a minute learns that the surface exists. I chose 429 because the honest farm needs `Retry-After`. Say if you prefer 404.
3. **Terminal failure deletes the `processing` artwork row**, so the admin poll gets 404. An artwork `failed` status would need a `pod_artwork` table rebuild, because a CHECK cannot be ALTERed. Is 404-after-processing acceptable for the CP5 UI?
4. **The admin POD gate still requires `RENDER_FARM_URL`** (`isPodConfigured`, unchanged), although the async path never uses it. Drop it when the sync fallback is deleted?
5. **Alerts are rows only.** PLAN §2.2 says alerts plus email; the email and reconciliation cron are CP2.
6. **Orphans.** An attempt prefix is swept on requeue, re-lease, late report and promotion. A farm that PUTs after its re-lease and never reports leaves objects under `pod/…/render/` for the (unbuilt) nightly orphan sweep. The same applies to canonical objects of a job that failed after promoting its print but hitting a conflict on the preview.
7. **Versions.** Only version 1 is produced, and canonical keys are unversioned. A future reprocess (version 2) must version the keys; until then it would hit `canonical_conflict` and fail closed.
8. **The SnapWear wire shape is provisional** (C5/C6, `items[]` wrapper, artworks↔layouts pairing, shipping address; orders currently carry no address). The fake stores unknown fields verbatim, so CP2 can add an address without touching it.
9. **Audit parity.** The `pod.artwork.ready` audit on completion is conditioned on the job completing, not on the artwork row actually changing. This is the same as the synchronous path, whose audit was unconditional beside a guarded UPDATE.
