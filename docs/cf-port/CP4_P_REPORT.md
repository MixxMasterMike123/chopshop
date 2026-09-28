# CP4-P report — public objects

Builder: CP4-P. Branch `cf-port`, working tree only (no git writes, no network, no wrangler). Brief: `CP4_BRIEFS.md` §0 and §P, DECISIONS D78, D92–D95. Started on HEAD `3257c074`; the two docs commits that landed meanwhile (`d2ef1372`, `42b6dda1`) leave §P unchanged (diffed). Builder E was working in the same tree at the same time; none of its files are touched here (list at the end).

## Files

| File | What |
|---|---|
| `cloudflare/migrations/0039_public_objects.sql` | new: `stored_objects.width_px`, `height_px` |
| `cloudflare/src/storage/image-sniff.ts` | new, pure: type from magic bytes, pixel size, the SVG check |
| `cloudflare/src/storage/public-objects.ts` | new: the base, the address, the two resolvers (the interface of A–D and S) |
| `cloudflare/src/storage/object-routes.ts` | public admission at reserve, the public upload leg, metadata with address and size, removal from the bucket the row names |
| `cloudflare/src/storage/object-store.ts` | `bucketForKind`, dimensions at activation, `getAuthorizedObjectWithDimensions` |
| `cloudflare/test/image-sniff.test.ts` | new: 156 tests |
| `cloudflare/test/public-objects.test.ts` | new: 37 tests |
| `cloudflare/test/object-routes.test.ts` | one case changed (below), 58 added (38 → 96) |
| `cloudflare/test/object-store.test.ts` | 8 added (23 → 31), none changed |

Not touched: `app.ts`, `wrangler.jsonc`, `env.d.ts` (both), `vitest.config.ts`, `pinned.*.json`, `scripts/`. No new env var, binding or secret.

**The one changed existing case:** `object-routes.test.ts` › "admin object reserve validation" › `["public kind", { kind: "product_media" }]` pinned the refusal of a public kind. It is now `["preview kind", { kind: "preview_image" }]`, which is still refused (previews are the render service's). Every other existing case is unchanged and green.

---

## Schema (0039)

```sql
ALTER TABLE stored_objects ADD COLUMN width_px INTEGER
  CHECK (width_px IS NULL OR width_px BETWEEN 1 AND 100000);
ALTER TABLE stored_objects ADD COLUMN height_px INTEGER
  CHECK (height_px IS NULL OR height_px BETWEEN 1 AND 100000);
```

Nothing else: the kinds and buckets stay as 0006 lists them. Written once, by `activateObject`. NULL = not an image, or a size not found in the bounded read. `activateObject` checks the same range itself (safe integers, 1..100000), so a bad size is an `invalid` answer, not a failed batch; the CHECK is tested separately with direct UPDATEs.

---

## Routes (paths and methods unchanged; `handleAdminObjectRoute` in `app.ts` unchanged)

Guard order, as before: the live admin session (`authorizeTenantAdminRequest`) → the opaque 404 for anyone else; a strict same-origin check on every state change before the body is read. Error bodies: 400 `{"error":{"code":"invalid_request","message":"Request is not valid"}}`, 404 `{"error":{"code":"not_found","message":"Route not found"}}`, 409 `{"error":{"code":"conflict",…}}`, 413 `{"error":{"code":"payload_too_large",…}}`.

| Method + path | Request | Answer |
|---|---|---|
| `POST /v1/admin/objects` | `{ contentType, kind, sha256, sizeBytes, fileName? }`, no other key. `kind` ∈ the four private kinds, `product_media`, `shop_branding`. The bucket follows from the kind (`bucketForKind`); the caller never names one. | `201 { object: { objectId, objectKey } }`, key `shops/<tenant>/<kind>/<id>/v1/<safe name>`. `400` for anything outside the admission table, including `preview_image` and `temp_upload`. For a public kind the row stores the stated type in its canonical spelling (`image/jpg` → `image/jpeg`). |
| `PUT /v1/admin/objects/:id/content` | the bytes; `Content-Length` = the declared size | `200 { object }` (shape below). `400` bad/missing length, wrong type, refused SVG, checksum mismatch, short body. `404` unknown/foreign/non-pending-target row, and for a public row while `PUBLIC_BUCKET` or a valid `PUBLIC_OBJECT_BASE_URL` is missing. `409` not pending. `413` length over the cap of the row's kind and type. |
| `GET /v1/admin/objects/:id` | — | `200 { object }` for an active row of this tenant; `404` otherwise |
| `GET /v1/admin/objects/:id/content` | — | private: the bytes, as before. **Public: the opaque 404** — read at its address, never proxied (`deliverPrivateObject` refuses every non-private row; tested). |
| `DELETE /v1/admin/objects/:id` | — | `204`; `409` frozen or already deleted; `404` unknown/foreign |

**`object` in the upload and metadata answers.** A private object: exactly the 7 fields of before, `{ contentType, immutable, kind, objectId, sha256, sizeBytes, status }` (a test pins `toEqual`). A public object adds three: `{ …, url: string | null, width: number | null, height: number | null }`. `objectKey` is absent from both, as before; the public address necessarily contains the key's path, and grants nothing the public bucket does not grant anyone.

**Via the route today the metadata's `url` is `null`**, because `app.ts` calls `getAdminObjectMetadata(env.DB, …)` with no `env` (see Deviations 2 and Reviewer wiring 2). The upload answer carries the address (its handler has `env`).

### The public upload leg (`uploadPublicObject`)

1. Row must be `pending` (else 409) with a declared hash and size (else 404). Its stated type must still be one its kind admits, and `PUBLIC_BUCKET` and a valid base must exist (else 404).
2. `Content-Length`: present, numeric, ≤ the cap for kind and type (else 413), equal to the declared size (else 400).
3. **Raster:** at least `min(64 KiB, size)` bytes are read from the body; exactly the first 64 KiB are sniffed (`sniffImageType`) and must equal the stated type, else the reader is cancelled and the answer is 400 with nothing stored. The size is read from the same 64 KiB (`"need_more"` or null → NULL). Then the head that was read and the rest of the body are piped through one `FixedLengthStream(declared size)` into `PUBLIC_BUCKET.put(key, …, { sha256, httpMetadata: { contentType: <proven type>, cacheControl: "public, max-age=31536000, immutable" } })`. A short or long body fails the stream and R2 stores nothing; a hash mismatch fails R2's own checksum.
4. **SVG:** read whole (at most declared size + 1 bytes), must be exactly the declared size, `checkSvg` must pass; then put as a buffer with the same options, type `image/svg+xml`.
5. `activateObject` with the size. If activation fails (the row moved on while the bytes were in flight), the row is re-read: when it is tombstoned or gone, the bytes are deleted from the public bucket; when it is active (a concurrent upload of the same row won, with the same declared hash), the bytes stay. Both outcomes are tested deterministically with a bucket wrapper that changes the row right after the put.

### Removal (D93)

Row tombstoned first (unchanged), then the bytes leave **the bucket the row names** (`bucketBinding`: private → `PRIVATE_BUCKET`, public → `PUBLIC_BUCKET`, temp → none). The old code deleted from `PRIVATE_BUCKET` whatever the row said. Proven both ways with a decoy under the same key in the other bucket: removing a public object empties the public key and leaves the private decoy; removing a private object empties the private key and leaves the public decoy. As before, only an active row's bytes are removed; a pending row is tombstoned without touching R2.

---

## Admission table as built

| Kind | Bucket | Stated types admitted (canonical) | Cap |
|---|---|---|---|
| `product_media` | public | `image/jpeg` (also `image/jpg`), `image/png`, `image/webp`, `image/gif`, `image/avif` | 15 MiB = 15 728 640 bytes |
| `shop_branding` | public | the same, plus `image/svg+xml` and `image/x-icon` (also `image/vnd.microsoft.icon`) | 15 MiB; SVG 512 KiB = 524 288 bytes |
| `preview_image` | — | not reservable here | — |
| `temp_upload` | — | not reservable here (as before) | — |
| `artwork_original`, `document`, `export`, `print_file` | private | unchanged (any type the object store's pattern accepts) | 100 000 000 bytes, unchanged |

Stated types are matched case-insensitively and without parameters. Exactly-at-cap is admitted (tested).

---

## Interfaces

### `src/storage/public-objects.ts`

```ts
export type PublicObjectKind = Extract<ObjectKind, "preview_image" | "product_media" | "shop_branding">;

export interface PublicImage {
  contentType: string;
  height: number | null;
  objectId: string;
  url: string;            // base + "/" + key, each key segment percent-encoded
  width: number | null;
}

export function publicObjectBase(env: Env): string | null;
export function publicObjectUrl(base: string, objectKey: string): string | null;
export function resolvePublicImages(
  env: Env, db: D1Database, tenantId: string,
  objectIds: readonly string[], kinds: readonly PublicObjectKind[],
): Promise<Map<string, PublicImage>>;
export function getReferencablePublicImage(
  env: Env, db: D1Database, tenantId: string,
  objectId: string, kinds: readonly PublicObjectKind[],
): Promise<PublicImage | null>;
```

- `publicObjectBase`: a string of 1–200 characters that the URL parser reads as `https:` with no port, and that equals the parsed origin exactly or the origin plus one `/`. Returns the origin without the slash. Refused (tested one by one): absent, empty, non-string, not a URL, http, another scheme, `javascript:`, a path, `//`, a query, a fragment, credentials, a port, `:443` written out, upper-case host letters, leading white space, over 200 characters.
- `publicObjectUrl`: `null` for a key with an empty, `.` or `..` segment (a client would resolve those, so the address could point outside the object's own key); the resolvers leave such a row out. Exported because the admin metadata builds its address with it: no other module builds one.
- `resolvePublicImages`: base invalid, no kinds or no ids → empty map. Kinds de-duplicated and filtered to the three public kinds; ids de-duplicated and read 90 per statement, all statements in one `db.batch`. `WHERE tenant_id = ? AND status = 'active' AND bucket = 'public' AND kind IN (…) AND object_id IN (…) LIMIT 90`. Anything else is absent, never an error.
- `getReferencablePublicImage`: `resolvePublicImages` for one id.

### `src/storage/image-sniff.ts` (pure: no `env`, no I/O, no Workers-only API; `TextDecoder` with `fatal: true` and `DataView` only)

Run once under plain Node 22 (`node --experimental-strip-types`, importing the `.ts` file unchanged): sniff and size of the 1×1 PNG, `checkSvg` admitting a logo and refusing a script and a UTF-16 file, `normalizeImageType("image/jpg")` — all as in the Worker suite.

```ts
export type RasterImageType = "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp" | "image/x-icon";
export type ImageType = RasterImageType | "image/svg+xml";
export interface ImageDimensions { height: number; width: number }
export type SvgRefusal =
  | "doctype_subset" | "embedded_content" | "encoding" | "entity_declaration" | "entity_reference"
  | "escape" | "event_attribute" | "foreign_content" | "invalid_character" | "javascript_url"
  | "malformed" | "not_svg" | "not_utf8" | "outside_reference" | "processing_instruction"
  | "script" | "style_import" | "too_large";
export type SvgCheckResult =
  | { height: number | null; ok: true; width: number | null }
  | { ok: false; reason: SvgRefusal };

export const IMAGE_DIMENSION_MAX = 100_000;
export const SVG_MAX_BYTES = 512 * 1024;

export function normalizeImageType(stated: string): ImageType | null;
export function sniffImageType(head: Uint8Array): RasterImageType | null;
export function readImageDimensions(type: RasterImageType, bytes: Uint8Array): ImageDimensions | "need_more" | null;
export function checkSvg(bytes: Uint8Array): SvgCheckResult;
```

- **Magic bytes:** JPEG `FF D8 FF`; PNG the 8-byte signature; GIF `GIF87a`/`GIF89a`; WebP `RIFF…WEBP` + a `VP8 `/`VP8L`/`VP8X` chunk; AVIF an `ftyp` box (size ≥ 16, multiple of 4) whose major or a compatible brand is `avif`/`avis`; ICO `00 00 01 00`, at least one entry, ≥ 22 bytes.
- **Dimensions:** PNG IHDR; GIF logical screen; WebP per chunk kind; JPEG a marker walk (fill bytes, standalone markers, stops at SOS/EOI) to the first SOF; AVIF `meta → iprp → ipco → ispe`, the largest extent (a grid's full size over its tiles, the picture over its thumbnail), NULL when `mdat` comes before `meta`; ICO the largest entry (0 = 256). A side outside 1..100000 → null. Every read checks the length first; all prefixes of every sample and 400 random mutations per sample are run without a throw (tested).
- **`checkSvg`** — a refusing scan, not a parser. It never skips anything: comments, CDATA and text are scanned like markup, so a tag inside a comment or CDATA is refused like any other, and every `<` is read as a tag, a declaration or an end tag, or makes the file `malformed`. Order and rules:
  1. over 512 KiB → `too_large`; not UTF-8 (fatal decoder; tested with a UTF-16 LE byte-order mark and an overlong `<`) → `not_utf8`; one leading UTF-8 BOM is dropped, a second is text before the root → `not_svg`;
  2. a character XML forbids (C0 controls except tab/LF/CR, U+FFFE/FFFF; this also catches UTF-16 without a BOM) → `invalid_character`;
  3. `<!ENTITY` anywhere → `entity_declaration`; a reference other than a numeric one to an allowed character or the five predefined entities → `entity_reference`;
  4. the prolog: XML declaration (only at offset 0; an `encoding` other than `utf-8` → `encoding`), white space, comments, a DOCTYPE read quote-aware (`[` → `doctype_subset`); a `<?` → `processing_instruction`; then the root must be `<svg` or `<prefix:svg`, else `not_svg`;
  5. every `<` in the file: `<!DOCTYPE` with a subset → `doctype_subset`; any other `<!` than a comment or CDATA → `doctype_subset`; `<?` anywhere but offset 0 → `processing_instruction`; a start tag is read as XML reads it (name, `name = "value"` pairs, `>` or `/>`); anything else — no value, no quotes, an unterminated value, a `<` inside a value, a duplicate attribute, a stray `<` — → `malformed`. Element local names (ASCII-lower-cased, prefix stripped): `script`, `handler`, `listener` → `script`; `foreignObject`, `meta`, `link`, `base` → `foreign_content`; `iframe`, `embed`, `object`, `frame`, `frameset`, `applet`, `audio`, `video` → `embedded_content`. Attributes: a name or local name starting with `on` → `event_attribute`; local name `href`, `src` or `ping` whose value (references resolved, tab/LF/CR removed, trimmed) is not `#…` or `data:image/(avif|gif|jpeg|jpg|png|webp)[;,]` → `outside_reference`; `xml:base` → `outside_reference`; an `xmlns`/`xmlns:*` value containing `xhtml` or `mathml` → `foreign_content`; `attributeName` naming `…href` → `outside_reference`, naming `on…` → `event_attribute`;
  6. text-wide, on the raw text and on the text with references resolved: `javascript:` with all white space removed → `javascript_url`; a backslash anywhere (CSS escapes can spell `url(`/`@import`) → `escape`; `@import` → `style_import`; `image-set(` or `src(` → `outside_reference`; every `url(` whose argument does not start (after white space and one optional quote) with `#` → `outside_reference`.
  7. Size: the root's `width` and `height` when both are plain numbers (optionally `px`), rounded; else the 3rd and 4th numbers of `viewBox`; else null.

### Additions to existing modules

- `object-store.ts`: `bucketForKind(kind): ObjectBucket`; `ActivateObjectInput.dimensions?: ImageDimensions | null`; `interface AuthorizedObjectWithDimensions { dimensions; object }`; `getAuthorizedObjectWithDimensions(db, tenant, objectId)`. `StoredObject` itself is unchanged (a pinned `toEqual` case depends on its exact keys).
- `object-routes.ts`: `interface PublicObjectMetadata extends ObjectMetadata { height; url; width }`; `PUBLIC_IMAGE_SIZE_BYTES_MAX`; `isKindReservable(env, kind): boolean`; `getAdminObjectMetadataWithUrl(env, db, principal, objectId)`. The six names `app.ts` imports keep their names and parameter lists; `UploadRouteResult`'s statuses are unchanged (the `ok` member's `object` widened to `ObjectMetadata | PublicObjectMetadata`); `getAdminObjectMetadata`'s return type is widened the same way.

---

## What was NOT done

- No `app.ts` change; the two gaps it causes are under Deviations 1–2 and Reviewer wiring.
- No resized variants; no decoding of images. A raster is "proven" by its magic bytes and header, as the brief specifies: a file with a correct header and garbage after it is admitted with its proven type.
- No second range read for a size behind the 64 KiB head; it is NULL.
- No sweep of orphaned public bytes (PLAN §2.5 "nightly orphan sweep" is not built).
- No reference register (D93: none is kept).
- No product/collection/branding columns (A, B, D); no copy of old images (S).
- No `X-Content-Type-Options` on public objects: R2's `httpMetadata` has no field for it (open question 2).

---

## Deviations from the brief, with the reason

1. **Reserve does not refuse a missing public configuration** (brief P.1). `parseReserveObjectInput(body)` and `reserveAdminObject(db, …)` receive no `env` from `app.ts`, and the lead's instruction forbids changing their parameter lists. The **upload** refuses instead (404, nothing stored, row stays `pending`; tested for no bucket, no base, a base with a path, an http base). `isKindReservable(env, kind)` is exported and tested for the one-line reserve refusal (Reviewer wiring 1), which then answers the same 400 an unknown kind gets.
2. **Metadata through the route carries `url: null`** (brief P.6). The lead's note says the metadata handler receives `env`; it does not: `app.ts` calls `getAdminObjectMetadata(env.DB, principal, route.objectId)`. Width and height are served already. `getAdminObjectMetadataWithUrl(env, …)` is the same read with the address, tested directly (Reviewer wiring 2). The route test pins `url: null` today and names why.
3. **`sniffImageType` returns `RasterImageType | null`**, never `image/svg+xml` (the brief's union lists it). A head cannot prove an SVG ("only through the full check"): only `checkSvg` over the whole file admits one. The narrower type is assignable to the brief's union. `readImageDimensions` takes a `RasterImageType` for the same reason; an SVG's size comes from `checkSvg`.
4. **The SVG check refuses more than the brief's list**, each on the "a doubt refuses" rule: a declared encoding other than UTF-8 (the browser would decode other bytes than were scanned), XML-forbidden characters, unknown entity references, a backslash anywhere, `image-set(`/`src(`, `xml:base`, an animation targeting `href` or an `on…` attribute, the XHTML/MathML namespaces, `meta`/`link`/`base`/`handler`/`listener`/`frame`/`frameset`/`applet`/`audio`/`video`, the `ping` attribute, malformed markup, and a root that is not `svg`. The `url(` and `javascript:` rules apply to the whole text, not only `style`: presentation attributes (`fill`, `filter`, `cursor`, …) and animation values also take them.
5. **SVG size** also accepts `px` and fractions (rounded); the brief says "plain numbers". `px` equals user units, and the size is only a layout hint.
6. **Caps are binary units** (15 MiB, 512 KiB), matching the source system's storage rules (`N * 1024 * 1024`).
7. **Reserve stores the canonical stated type** (the upload compares the proof with it, and metadata shows it).
8. **The upload cleans up after a failed activation** (bytes removed only when the row was tombstoned meanwhile): not asked for, but public bytes are readable by anyone with the address.

---

## Open questions

1. **The importer's "by reason"** (`CP4_BRIEFS.md` §S: "a file the Worker refuses is reported by shop and by reason"). The upload answers a bare 400 for every refusal. Either S runs `image-sniff.ts` under Node on a refused file to name the reason (the module is pure for this), or the `invalid` result gains a `reason` field and `app.ts` puts it in the 400 body (an `app.ts` change). Which?
2. **`nosniff` and a CSP on public objects.** R2 `httpMetadata` cannot set `X-Content-Type-Options` or `Content-Security-Policy`, and what the `r2.dev` address sends is not verified here (no network). An SVG opened directly at its address is a document on that origin; the check refuses whatever can run or fetch, but a response header (`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `nosniff`) at the CP7 custom domain would be a second fence. Decide at CP7?
3. `preview_image` is a `PublicObjectKind` (the resolvers accept it) although no writer exists yet. Keep, or drop until the render service writes previews?
4. A failed R2 delete after a tombstone leaves the bytes readable at their address until a sweep that does not exist yet (D93 accepts the order; the sweep is PLAN §2.5).

---

## Reviewer wiring

1. **Reserve refusal** — `app.ts`, `handleAdminObjectRoute`: `if (input === null) {` → `if (input === null || !isKindReservable(env, input.kind)) {`, and import `isKindReservable` from `./storage/object-routes`.
2. **Metadata address** — `app.ts`: `getAdminObjectMetadata(env.DB, principal, route.objectId)` → `getAdminObjectMetadataWithUrl(env, env.DB, principal, route.objectId)` (+ import). Then flip `object-routes.test.ts` › "public object reads" › "gives a public object's metadata its size, and its address when env is passed": the route's `url: null` becomes `` `${PUBLIC_BASE}/shops/${TENANT_A}/product_media/${reserved.objectId}/v1/photo.png` ``. `getAdminObjectMetadata` is then unused and can go.
3. **`PUBLIC_OBJECT_BASE_URL`** in `wrangler.jsonc` for staging (the `r2.dev` address once D95 switches it on) and production; `r2.publicBaseUrl` in `pinned.staging.json` / `pinned.production.json`; the preflight check that the two are equal. Until then every upload of a public kind answers 404 on a deployed Worker (by design, D95). `npm run types` then adds the var to `worker-configuration.d.ts`.
4. **`REQUIRED_MIGRATION`** → `"0039_public_objects.sql"` in `app.ts`, `test/health.test.ts` (line 36) and `test/public-catalog.test.ts` (line 446).

---

## Test numbers

Gate: `cd cloudflare && npx tsc --noEmit && npx vitest run` — tsc clean; **75 files, 2971 tests, all passed** (last run 04:58).

- Before: 2416 tests in 69 files (HANDOVER).
- Mine: 259 new tests — `image-sniff.test.ts` 156, `public-objects.test.ts` 37, `object-routes.test.ts` +58, `object-store.test.ts` +8 — and 1 changed case. My four files together: 320.
- Builder E's work in progress in the same tree accounts for the rest: `shop-hostname`, `web-html`, `web-routing`, `web-worker` (4 files, 288 tests, run separately) and 8 tests in its `entrypoints.test.ts` changes. 2416 + 259 + 288 + 8 = 2971.
- `node guard/guards.test.mjs`: PASS; a grep of my nine files for the forbidden name patterns finds nothing.

**Two log lines in the run:** `uncaught exception; source = Uncaught (in promise); stack = Error: Network connection lost.` (twice). They come from the test "refuses a body that ends before its declared length and stores nothing" and are the local R2 simulator's reaction to an upload body that errors mid-stream, not an unhandled promise of this code: a throwaway probe (not kept) that fed a short `FixedLengthStream` into `PUBLIC_BUCKET.put` with every promise handled printed the same two lines, and the same stream read without R2 printed nothing. The test passes and asserts the bucket holds nothing.

Two built test files were decoded by an independent decoder (Pillow): the 1×1 PNG (real CRCs, stored-deflate IDAT) and the 1×1 GIF are valid images. The other raster samples are header-true, not decoded.

Files of builder E present in the tree and not touched by P: `cloudflare/src/index.ts`, `cloudflare/test/entrypoints.test.ts`, `cloudflare/src/tenancy/shop-hostname.ts`, `cloudflare/test/{shop-hostname,web-html,web-routing,web-worker}.test.ts`, `cloudflare/web/`, `src/api/`, `src/storefront/`, `index.storefront.html`, `vite.storefront.config.js`.

---

## Review round 1 (reviewer, 2026-09-28)

Read line by line: the migration, `public-objects.ts`, `image-sniff.ts`, the diffs of `object-routes.ts` and `object-store.ts`. Gate after the changes below: `tsc` clean, **75 files, 2971 tests passed**.

**Changed by the reviewer:**

1. **Deviation 1 closed.** The reserve route asks `isKindReservable(env, kind)` before it reserves (`app.ts`): a public kind is refused while the public bucket or its address is not configured.
2. **Deviation 2 closed.** The metadata route passes `env`; a public object's metadata carries its address. `getAdminObjectMetadata` without `env` is removed; the route test expects the address.
3. **Open question 1 answered: the refusal carries its reason.** A refused public upload answers 400 with `error.reason`: `type_not_as_stated`, `bytes_not_as_declared` or `svg_<reason>`. The caller is the shop's own admin, so the reason tells nobody anything it should not know, and the importer counts refusals by it without a second copy of the rules.

**Answers to the open questions:**

2. `nosniff` and a Content-Security-Policy on public objects: at CP7, with the domain of our own, as response headers of that domain. Recorded for CP7. Until then the fence is the check at upload and the rule that public objects are never served from the storefront's or the admin's own address (D92).
3. `preview_image` stays resolvable. No caller asks for it today.
4. A failed delete in R2 after the row is tombstoned leaves the bytes readable at an address nothing links to. Accepted with D93; the sweep of PLAN §2.5 is not built and is carried forward in `HANDOVER.md`.

**Checked and found sound:** every `<` of an SVG is visited, and a tag read can never run across another `<` (a name or an attribute name stops at it, a value that holds it is malformed), so nothing can hide a real tag from the scan. No read of a raster header goes past the bytes at hand. The dimensions reach the row only through `withinRange`, so an activation cannot fail on them and leave bytes beside a pending row. A removal that lands during an upload takes the bytes with it; a second upload of the same row keeps the winner's.

**Left for later, by design:** `PUBLIC_OBJECT_BASE_URL` in `wrangler.jsonc` and the pinned files (after D95); `REQUIRED_MIGRATION` (once, at the consolidation of 0039–0043). The three SVG branding files of the export have not met the check yet: they are rehearsed by S, and a refusal there means a new export of that logo.
