# CP4 builder briefs

Status: written 2026-09-28 on HEAD `a9991384` + the CP4 pre-step. Input: `CP4_GAP_ANALYSIS.md`, `DECISIONS.md` D77–D95, PLAN §2.1, §2.4, §2.5. One brief per builder of the split (gap analysis §4). P is first: products, collections, branding and the storage copy stand on it.

`$CF` = `cloudflare/`.

## 0. Rules for every builder

1. **Working tree only.** No git command that writes, no network, no wrangler, no deploy. The reviewer commits.
2. **Own files only.** The brief lists them. `$CF/src/app.ts` is touched only inside the builder's own `CP4-IMPORTS-x` and `CP4-ROUTES-x` blocks. Reviewer-only files: `wrangler.jsonc`, `src/env.d.ts`, `test/env.d.ts`, `vitest.config.ts`, `pinned.*.json`, `scripts/cf-preflight.sh`, `scripts/cf-deploy.sh`, `REQUIRED_MIGRATION` (in `app.ts` and two tests). What a builder needs there goes into its report under "Reviewer wiring".
3. **Routes.** Exact paths, no prefix wildcard, each wrapped in `onMethods([...])`; a public route also in `storefront(...)`. Id segments come from the raw pathname and are decoded once by the handler. An admin route authorizes first (`authorizeTenantAdminRequest`), answers the opaque admin 404 to anyone else, and demands a same-origin request for every state change, before the body is read.
4. **Tenant.** Every query names the tenant. No route accepts a tenant id from the browser. A public read goes through the ONE predicate (`PUBLIC_ELIGIBILITY_PREDICATE`) wherever a product is shown.
5. **Writes** are audited in the same `batch()` as the change. D1: `meta.changes` counts rows changed by triggers too, so compare with `=== 0`, never `!== 1`. `INSERT OR REPLACE` bypasses DELETE triggers.
6. **Whatever a visitor can see bumps `catalog_version`** in the same batch or by trigger, so the ETag of every cached read changes (PLAN §2.4).
7. **Migrations** take the number the brief gives. `0020` is never used. Time columns of a NEW table are ISO-8601 text written by the server; a column added to an OLD table follows that table (`stored_objects`, `tenants`: integer milliseconds).
8. **Bounded reads.** Every list has `LIMIT` and a cursor; `IN (...)` is chunked at 90; no binary or base64 in a row.
9. **Tests** are part of the work: the refusals first (wrong tenant, no session, foreign origin, wrong method, malformed id, over the cap), then the happy path. Gate before the report: `cd cloudflare && npx tsc --noEmit && npx vitest run` — the whole suite, and the number of tests in the report.
10. **Names.** No file, identifier, comment or document carries a name of the source system's earlier brand or of its resale feature; `node guard/guards.test.mjs` scans every tracked file.
11. **Report:** `docs/cf-port/CP4_<X>_REPORT.md`, shaped as the CP3 reports: files, routes with request and response shapes, schema, what was NOT done, deviations from the brief with the reason, open questions, "Reviewer wiring". A claim in the report is one the builder has run.
12. **When the brief is wrong, say so** in the report and build what is right; do not build around it silently.

---

## P. Public objects

**Goal.** A shop's admin can upload an image that a visitor can see, and every other builder can turn an object id into an address with one call. Nothing that is not a proven image is ever readable in the public bucket.

**Decisions:** D78 (the bucket's managed address on staging), D92 (which files), D93 (removal), D95 (the address is not switched on yet: build against the test value).

### Owns

| File | |
|---|---|
| `$CF/migrations/0039_public_objects.sql` | new |
| `$CF/src/storage/image-sniff.ts` | new, pure |
| `$CF/src/storage/public-objects.ts` | new: the interface of the other builders |
| `$CF/src/storage/object-routes.ts` | existing: admission of public kinds, upload, metadata, removal |
| `$CF/src/storage/object-store.ts` | existing: only what the above needs |
| `$CF/test/image-sniff.test.ts`, `$CF/test/public-objects.test.ts` | new |
| `$CF/test/object-routes.test.ts`, `$CF/test/object-store.test.ts` | existing: the cases that pinned "a public kind is refused" change; every other case stays as it is |

No block in `app.ts`: the admin objects route already calls the handlers of `object-routes.ts`, and its paths and methods do not change.

### Schema (0039)

`ALTER TABLE stored_objects ADD COLUMN width_px INTEGER` and `height_px INTEGER`, both nullable, both `CHECK (… IS NULL OR … BETWEEN 1 AND 100000)`. Nothing else. The kinds stay as the table's rule lists them.

### Admission

| Kind | Bucket | Types | Cap |
|---|---|---|---|
| `product_media` (product images, collection covers) | public | JPEG, PNG, WebP, GIF, AVIF | 15 MB |
| `shop_branding` | public | the same, plus ICO and SVG | 15 MB; SVG 512 KB |
| `preview_image` | — | not admitted: previews are written by the render service, not by an admin | — |
| the four private kinds | private | unchanged | unchanged |

The bucket follows from the kind (`ALLOWED_BUCKETS`); the caller never names it.

1. **Reserve** refuses a public kind whose stated type is not in its list, whose size is over its cap, or while `PUBLIC_BUCKET` or a valid `PUBLIC_OBJECT_BASE_URL` is missing. The refusal for a missing configuration is the same opaque answer an unknown kind gets.
2. **Upload proves the type before the first byte is stored.** The head of the body is read, the type is taken from the bytes (`image-sniff.ts`) and compared with the stated one; only then the whole body, head included, goes to R2 with the declared sha256 as R2's own checksum, as the private path does. R2 needs a body of known length: `FixedLengthStream`. A mismatch stores nothing, leaves the row `pending` and answers 400. An SVG is read whole (it is small by its cap) and checked whole before it is stored.
3. **Stored with** `contentType` = the proven type and `cacheControl: "public, max-age=31536000, immutable"`: a key is never written twice.
4. **Width and height** are read from the file and written to the row at activation. When they cannot be found within a bounded read (a JPEG whose size marker sits behind a large profile), they stay NULL and the upload still succeeds. For an SVG: from `width`/`height` or `viewBox` when they are plain numbers, else NULL.
5. **SVG (D92): refuse, never repair.** Refused when it holds any of: a `script` element, an attribute starting with `on`, `foreignObject`, `iframe`/`embed`/`object`, a `href`/`xlink:href`/`src` that is not a fragment (`#…`) or a `data:image/` of a raster type, `javascript:` anywhere, a `style` element or attribute with `url(` that is not a fragment or with `@import`, a DOCTYPE with an internal subset or any entity declaration, a processing instruction other than the XML declaration, or bytes that are not valid UTF-8. The check is a refusing scan of the text, written so that a doubt refuses. It is not a parser and must not try to be one.
6. **Metadata** (`GET /v1/admin/objects/:id`) of a public object gains `url`, `width`, `height`. The object key stays absent from every response except the reserve answer, as today.
7. **Content** (`GET …/content`) of a public object: the opaque 404. A public object is read at its address; the Worker does not proxy it.
8. **Removal** (D93): the row is tombstoned first, then the bytes leave the bucket the row names. Today's code deletes from the private bucket whatever the row says: that is the bug to fix first, with a test.

### `image-sniff.ts`

Pure functions over `Uint8Array`: no `env`, no I/O, nothing of the Workers runtime, so the importer's copy tool can run the same rules under Node.

- `sniffImageType(head): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif" | "image/x-icon" | "image/svg+xml" | null` from the magic bytes (AVIF: an `ftyp` box whose major or compatible brand is `avif`/`avis`; SVG: only through the full check, never from a glance at the head).
- `readImageDimensions(type, bytes): { width, height } | "need_more" | null` so the caller can fetch a further range.
- `checkSvg(bytes): { ok: true, width, height } | { ok: false, reason }`.
- The stated type `image/jpg` and `image/vnd.microsoft.icon` are read as `image/jpeg` and `image/x-icon`.

Tests use small real files built in the test (a few dozen bytes each is enough for every raster type), truncated files, a file of one type under the name of another, a polyglot (GIF header followed by markup), and one SVG per refusal reason.

### `public-objects.ts` — the interface

```ts
export interface PublicImage {
  objectId: string;
  url: string;            // base + "/" + key, each key segment percent-encoded
  contentType: string;
  width: number | null;
  height: number | null;
}

// A bare https origin from env.PUBLIC_OBJECT_BASE_URL (no path, query,
// fragment, credentials or port games), else null.
export function publicObjectBase(env: Env): string | null;

// For public shapes. Only rows that are active, in the public bucket, of this
// tenant and of one of `kinds`. Anything else is absent from the map, never
// an error. Ids are de-duplicated and chunked at 90.
export function resolvePublicImages(
  env: Env, db: D1Database, tenantId: string,
  objectIds: readonly string[], kinds: readonly PublicObjectKind[],
): Promise<Map<string, PublicImage>>;

// For admin writes: may this tenant reference this object as an image?
// Same conditions as above. The caller refuses the write with 400 on null.
export function getReferencablePublicImage(
  env: Env, db: D1Database, tenantId: string,
  objectId: string, kinds: readonly PublicObjectKind[],
): Promise<PublicImage | null>;
```

With no valid base both answer empty / null: a shape then carries no image, and an admin write that names an image is refused. No other module builds an address of a public object, and no address is stored in a row: rows hold object ids, addresses are made at read time, so the move to a domain of our own at CP7 changes one value.

### Must be proven by tests

- Tenant A cannot reserve into, upload to, read the metadata of, reference or remove an object of tenant B; an ordinary user and a request without a session get the opaque 404 on all of it.
- A public kind with a private bucket, a private kind with a public bucket, and `preview_image` through the admin route are refused.
- Each refusal of the admission list; the upload whose bytes are not what it states stores NOTHING in the bucket (asserted on the bucket itself) and leaves the row `pending`.
- A proven upload is in the PUBLIC bucket under `shops/<tenant>/<kind>/<id>/v1/<name>`, with the type and the cache header, and never in the private one.
- Removal takes the bytes out of the right bucket for both classes.
- `resolvePublicImages`: a pending row, a deleted row, a private row, another tenant's row and a kind outside `kinds` are each absent; 200 ids resolve (chunking); with the base unset the map is empty.
- The 2416 tests that exist stay green, except the named cases that pinned the refusal of public kinds.

### Not P's work

The columns and tables that hold an image on a product, a collection or the branding (A, B, D). The copy of the old images (S). Resized variants of an image: the storefront shows the file that was uploaded, as it does today.

### Reviewer wiring P will name

`PUBLIC_OBJECT_BASE_URL` in `wrangler.jsonc` for both environments, `r2.publicBaseUrl` in the pinned files, the preflight check that the two are equal, `REQUIRED_MIGRATION`.

---

## A–F, S

Written after P's interface is reviewed, one section each, in this file.
