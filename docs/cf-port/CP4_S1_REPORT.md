# CP4-S1 report: the files, and the data steps of staging

Builder: CP4-S1. Branch `cf-port`, working tree only: no git writes, no network, no wrangler. HEAD at start: `1c7adaa5`. Brief: `CP4_BRIEFS.md` §0 and §S ("Rules of S", "The copy manifest", S1). Builder S2 worked in the same tree at the same time. None of its files are touched here.

Nothing here has run against staging, the source's storage or any other network address. Fakes on 127.0.0.1 inside `node --test` prove every tool. The reviewer runs the tools against staging (run book at the end).

## Files

| File | What |
|---|---|
| `scripts/cf-port/migrate/lib/copy-manifest.mjs` | new. The ONE format S1 writes and S2 reads: `sourceKeyOf`, `emptyCopyManifest`, `entryProblems`, `copyManifestProblems`, `readCopyManifest` (validates), `writeCopyManifest` (validates, then writes beside and renames), `indexCopyManifest`, `lookupEntry`, `lookupAddress`, `lookupCopied`, `upsertEntry`, and `kindOfUse`, `uploadFileName`, `objectKeyOf` (see "The object key" below) |
| `scripts/cf-port/migrate/lib/copy-sources.mjs` | new. Lists which addresses of the bundle name a file of the source's storage, per shop and use (`collectCopySources`). Also `isSourceStorageAddress` (the Worker's rule restated, pinned by a test), `sourceAddressesInHtml` (S2 finds page images with the same function), `fetchAddressOf`, `isFetchable`, and `loadWorkerModule` (runs a self-contained module of `cloudflare/src` under plain Node) |
| `scripts/cf-port/migrate/lib/api-session.mjs` | new. `stagingTarget` (refuses production, takes the pinned staging origin), `platformCredentials`/`secretValue`/`parseEnvFile`, `createApiSession` (sign-in, acting-as with renewal, one request helper with Origin, cookie and optional X-Shop-Id, 429 + Retry-After), `preflight` |
| `scripts/cf-port/migrate/storage-copy.mjs` | new. The copy tool |
| `scripts/cf-port/staging-legal.mjs` | new. The legal data steps of staging, plus publish and unpublish for the review |
| `scripts/cf-port/migrate/test/copy-manifest.test.mjs` | new, 9 tests |
| `scripts/cf-port/migrate/test/copy-sources.test.mjs` | new, 6 tests |
| `scripts/cf-port/migrate/test/api-session.test.mjs` | new, 7 tests |
| `scripts/cf-port/migrate/test/storage-copy.test.mjs` | new, 14 tests |
| `scripts/cf-port/migrate/test/staging-legal.test.mjs` | new, 13 tests |
| `scripts/cf-port/migrate/test/fake-staging-api.mjs` | new. Test helper, not a test: the fake staging API, the fake source storage, and `writeTestBundle` |
| `docs/cf-port/CP4_S1_REPORT.md` | this report |

No existing file was changed.

## The copy manifest (unchanged from the brief)

The format is exactly the brief's: `{ schemaVersion: 1, env, apiOrigin, bundleManifestSha256, createdAt, entries: [{ shopId, sourceKey, use, status, objectId, sha256, sizeBytes, contentType, reason }] }`. The validation is strict:
- Unknown or missing keys are refused. `sourceKey` and `sha256` are 64 lower-case hex characters.
- `copied` needs an `objectId`, a `sha256`, `sizeBytes ≥ 1`, an image `contentType` and `reason: null`.
- Every other status needs `objectId: null` and a `reason`.
- A (shopId, sourceKey) pair may appear only once.

`bundleManifestSha256` is the sha256 of the bundle's `manifest.json`.

These rules are fixed here, beyond the brief:
- **`use` is the first use under which a file was found**, in the order `product_image`, `collection_cover`, `branding`, `page_image`. A file named by rows of two uses is still one entry and one object. S2 looks entries up by (shop, sourceKey) and never by use. The real bundle has no file under two uses (rehearsal below).
- **Two addresses of one shop with the same bytes and the same kind share one object.** Their two entries carry the same `objectId`. So "one file, one object" holds by content as well as by address.
- **Addresses inside page HTML.** The sourceKey hashes the raw attribute or `url()` text as `sourceAddressesInHtml` returns it, with entities not decoded (`&amp;` stays). The copy decodes the entities only to fetch. The bundle holds no page image today (0 of 2 pages).

### The object key (for S2's page images)

The manifest holds no `objectKey`, and the upload answer does not return one either (`object-routes.ts` `toMetadata`, "the object key is deliberately absent"). S2 still needs the key to build the public address of a page image: `r2.publicBaseUrl` + key. The format was not changed. Instead, the key is made derivable:
- The copy reserves every object with a file name fixed by its proven type (`image.png`, `image.jpg`, …; `uploadFileName`). Each of these names passes the Worker's `safeFileName` unchanged.
- The Worker's reserve rule is `shops/<tenant>/<kind>/<objectId>/v1/<safe name>` (`cloudflare/src/storage/object-store.ts:254`), and the kind follows from the use (`kindOfUse`). So `objectKeyOf(entry)` gives the key of every `copied` entry.
- The copy checks that the reserve answered exactly this key before it uploads. On any difference the entry is `failed` with reason `key_mismatch`.

S2 builds the address as `publicObjectUrl` does: each key segment percent-encoded (`public-objects.ts:82`).

## `storage-copy.mjs`

```
node scripts/cf-port/migrate/storage-copy.mjs --env staging --bundle <dir> --out <dir outside the repo>
     [--shop <id>] [--limit <n>] [--dry-run]
```

| Option | Meaning |
|---|---|
| `--env` | must be `staging`. `production` is refused with its own message, and anything else is refused too. The API origin is `cloudflare/pinned.staging.json` `origins.api`; a `CHOPSHOP_API_URL` that differs from it is refused |
| `--bundle` | the export bundle (read-only) |
| `--out` | refused when it resolves inside the repository (`lib/outside-repo.mjs`, symbolic links included). Holds `copy-manifest.json` and, while a reservation is open, `copy-pending.json`. Directory mode 0700, files 0600 |
| `--shop` | only this shop |
| `--limit` | at most n files this run, counting only the files not yet copied |
| `--dry-run` | no request and no write. Prints the counts per shop and use, the addresses that are not files of the source's storage, and the page attachments |

**Credentials** are needed only without `--dry-run`:
- `CHOPSHOP_PLATFORM_EMAIL`, from the environment.
- The password: `CHOPSHOP_PLATFORM_PASSWORD`, else `PLATFORM_ADMIN_PASSWORD` from `~/.config/chopshop/secrets.staging.env`. `CHOPSHOP_SECRETS_FILE` can point elsewhere.

Neither is ever printed.

**Per distinct (shop, address)**, in the order shop, use, sourceKey:
1. **Skip** it when the manifest already holds it as `copied`.
2. **Fetch** it from the source with a GET, 60 s timeout, following redirects. The body is streamed under a 15 MB cap; a declared Content-Length over the cap stops the fetch before the body is read.
   - 404 → `missing`, reason `http_404`.
   - A timeout, a network error, a 429 or a 5xx → up to 3 tries in all → `failed` with the last reason.
   - Any other status → `failed` at once with reason `http_<status>`. A 403 does not change by trying again, so it is not retried.
3. **Type**: the Worker's own `sniffImageType` over the first 64 KiB (`cloudflare/src/storage/image-sniff.ts`, loaded through `loadWorkerModule`).
   - No raster type, but the source says `image/svg+xml` or the text begins with `<…<svg` → stated as SVG. The Worker proves it with `checkSvg` at upload.
   - Otherwise → `refused`, `not_an_image`.
   - An SVG over 512 KB → `refused`, `too_large`. So is any file over 15 MB. An empty body → `refused`, `empty`.
4. **Shared object**: when the same shop already has a `copied` object of the same kind and sha256, that object is reused and no request is made.
5. **Acting-as** for the shop. It is renewed when less than 10 minutes are left, and minted again after an admin 404.
6. **Earlier reservation**: `copy-pending.json` may hold a reservation for this (shop, sourceKey) with the same sha256, size and type. The tool then reads the object: if it is `active` with that hash and size → `copied` with no upload; if it is still `pending` → it uploads into that object.
7. **Reserve.**
   - A 400 → `refused` with the Worker's `error.reason`, else `http_400`. The reserve's 400 carries no reason, for example for an SVG named as a product image.
   - Any status other than 201 → `failed`.
   - A key other than `objectKeyOf` → `failed` with `key_mismatch`.
   - The reservation is written into `copy-pending.json` before the upload.
8. **Upload.**
   - 200 with `status: "active"` and the same sha256 and size → `copied`.
   - A 400 or 413 → `refused` with `error.reason` (`type_not_as_stated`, `bytes_not_as_declared`, `svg_<reason>`) or `http_413`.
   - Anything else, including a lost answer or a 409 → the tool reads the object. If it is active with the same hash → `copied`; otherwise → `failed`.
9. **Write** the manifest atomically after every file. When the entry is `copied` or `refused`, its reservation is dropped from `copy-pending.json`.

At the end the tool ends the acting-as grant of each shop it opened. It prints the counts per shop, use and status, the shared and resumed objects, and the request and 429 counts.

**Exit codes:** 0 when no entry is `failed`, 1 otherwise, 2 when the tool refused to run.

**Output:** only counts, shop ids, object ids and reasons. Tests assert that no source host, password or cookie appears in the output or the manifest.

**The acting-as reason** is written on the grant and on its `acting_as.granted` audit row: "CP4 staging import for the design review: storage-copy.mjs copies the source images of this shop".

**The preflight** requires `/health` to answer `environment: "staging"` and `/ready` to be on migration `0039` or later (0039 is the public-object admission).

### The requests of `storage-copy.mjs`, and the Worker code that proves each

| # | Request | Headers | Body → answer | Proven by |
|---|---|---|---|---|
| 1 | `GET /health`, `GET /ready` | none | → `{ environment }`, `{ migration }` | `app.ts` `readinessResponse`; the same check as `seed-staging-slice.mjs:352-365` |
| 2 | `POST /api/auth/sign-in/email` | `content-type: application/json`, `origin: <api>` | `{ email, password }` → 200, `Set-Cookie`, `{ user: { id } }` | `cloudflare/src/auth/auth-routes.ts:18`; the same call as `seed-staging-slice.mjs:380-395` |
| 3 | `POST /v1/platform/tenants/:shop/acting-as` | cookie, `origin`, **no** `x-shop-id` | `{ reason }` (1–500 characters) → 201 `{ tenantId, expiresAt }` (1 h) | `cloudflare/src/routes/acting-as.ts:34-74`, `platform/acting-as.ts:44-78` (body), `:17` (TTL); X-Shop-Id refused on platform routes: `auth/request-authorization.ts:58-61` (D70) |
| 4 | `POST /v1/admin/objects` | cookie, `origin`, `x-shop-id: <shop>` | `{ contentType, fileName, kind, sha256, sizeBytes }` (no other key) → 201 `{ object: { objectId, objectKey } }`; 400 without a reason | `app.ts:800-821`; `storage/object-routes.ts:79-85` (`RESERVE_KEYS`), `:107-110` (the types each kind admits), `:203-238` (`parseReserveObjectInput`), `:285` (`isKindReservable`); key rule `object-store.ts:254` |
| 5 | `PUT /v1/admin/objects/:id/content` | cookie, `origin`, `x-shop-id`, Content-Length (set by fetch for a Buffer) | the bytes → 200 `{ object: { contentType, immutable, kind, objectId, sha256, sizeBytes, status, url, width, height } }`; 400 `{ error: { reason } }`; 409; 413 | `app.ts:829-853`; `object-routes.ts:516-610` (`uploadPublicObject`: pending, declared hash, Content-Length, sniff, R2 checksum, activate); reasons at `:62-68`, `:385`; the test request shape `cloudflare/test/object-routes.test.ts:223-237`, `:601-606` |
| 6 | `GET /v1/admin/objects/:id` | cookie, `x-shop-id` (origin sent; not required for GET) | → 200 `{ object }` | `app.ts:873-881`; also used this way in `seed-staging-slice.mjs:656` |
| 7 | `DELETE /v1/platform/tenants/:shop/acting-as` | cookie, `origin` | → 204, or 404 when none was live | `acting-as.ts:76-81` |

A 429 on any request waits `Retry-After` seconds (1–300, at most 5 waits) and tries again (`lib/responses.ts:51-64`).

The source requests are plain GETs of the address as the bundle holds it, with HTML entities decoded. The rehearsal found that every address carries its access token.

## `staging-legal.mjs`

```
node scripts/cf-port/staging-legal.mjs --env staging --bundle <dir> --out <dir outside the repo>
     [--shop <id>] [--dry-run] [--publish-for-review]
node scripts/cf-port/staging-legal.mjs --env staging --out <dir> [--dry-run] --unpublish-after-review
```

| Option | Meaning |
|---|---|
| `--env` | `staging` only; production is always refused (`stagingTarget`) |
| `--bundle` | the shops, their store identity (`storeIdentity`), `features.pod` and `published`. Required except with `--unpublish-after-review` |
| `--out` | outside the repository. Holds `published-for-review.json` |
| `--shop` | one shop |
| `--dry-run` | no request. Prints whether the terms text hashes to what 0031 seeded; per shop, what the source lacks, the page sizes, the `checkHtml` result, and whether the shop would be published |
| `--publish-for-review` | also publishes, after the legal steps |
| `--unpublish-after-review` | only this: reads the file and unpublishes those shops. It takes no `--bundle`, `--shop` or `--publish-for-review` |

**Credentials** are the platform user's, as for the copy. For the adoption there is also a review admin password: `CHOPSHOP_REVIEW_ADMIN_PASSWORD`, else `CHOPSHOP_SLICE_ADMIN_PASSWORD`, from the environment or the secrets file, at least 12 characters.

**(a) The platform's terms text.**
1. `GET /v1/platform/legal/terms-versions` and take the version with `current: true`.
2. If its text is already archived, nothing is sent.
3. If it is not the version of `src/config/platformTerms.js` (`2026-09-07`), or the local text does not hash to its `sha256`, nothing is sent and the run reports a problem.
4. Otherwise `PUT …/terms-versions/2026-09-07/text` with `{ text }`, where text = `JSON.stringify({ version, terms: PLATFORM_TERMS_TEMPLATE, dpa: PLATFORM_DPA_TEMPLATE })`, keys in that order. This is the format `toPagePlatformTerms` parses and the hash 0031 seeded; a test reads the hash from the migration and checks it.

**(b) Per shop of the bundle.** Opened with acting-as, with the reason "CP4 staging step for the design review (staging-legal.mjs): legal settings and pages of this imported shop; at the cutover the seller adopts the pages himself".
1. `GET /v1/admin/legal/status` gives the readiness booleans.
2. What is missing is written with `PUT /v1/admin/settings` (an acting-as request, admitted by `admin-settings.ts:29-33`):
   - a missing return address becomes `"Returadress ej angiven (platshållare på staging för designgranskningen)"`;
   - an unanswered VAT question becomes `vatRegistered: false`.
3. If no legal pages are adopted yet:
   - The three pages are rendered with the source's own renderer, `src/utils/legalPageRenderer.js` `renderLegalPage(slug, identity, { pod })`. This is exactly what the source's admin adopts (`src/utils/legalAcceptance.js:61`). The identity is the shop's imported `storeIdentity`, plus the two placeholder values when step 2 set them.
   - Each page must pass the Worker's `checkHtml` (`content/html-refusal.ts`, loaded under Node). A refused page is reported with its key and reason, and nothing is adopted.
   - Then `POST /v1/admin/legal/accept-pages` sends `{ templateVersion: LEGAL_TEMPLATE_VERSION, texts: { kopvillkor, angerratt, integritetspolicy }, pod, custom: false }`, signed by the shop's staging review admin (Deviation 1).
4. The status is read again and the readiness printed.
5. The grant is ended.

**`--publish-for-review`**: for each shop the bundle holds as `published === false`:
1. `GET /v1/platform/tenants/:id`.
2. If the shop is also unpublished on staging, `POST …/publish` (no body) and add the id to `<out>/published-for-review.json`. The file is rewritten after every publish, so an interrupted run loses nothing.
3. A shop already published on staging is left alone and not recorded.

**`--unpublish-after-review`**: `POST …/unpublish` for exactly the listed ids. A failed one stays in the file for the next run; the file is removed when all succeeded.

**Exit codes:** 0 without a problem, 1 with any (listed at the end), 2 when refused. The preflight requires migration `0037` or later.

### The requests of `staging-legal.mjs`, and the Worker code that proves each

| # | Request | Headers | Body → answer | Proven by |
|---|---|---|---|---|
| 1–3 | health, sign-in, acting-as | as for the copy | | as for the copy |
| 4 | `GET /v1/platform/legal/terms-versions` | cookie, **no** `x-shop-id` | → `{ versions: [{ version, publishedAt, sha256, textArchived, current }] }` | `routes/legal-platform.ts:19-24`, `:56-65` (X-Shop-Id refused), `:76-85`; mount `app.ts:2600-2603` |
| 5 | `PUT /v1/platform/legal/terms-versions/:v/text` | cookie, `origin`, no `x-shop-id` | `{ text }` (exactly this key) → 201 archived / 200 already / 409 `terms_text_hash_mismatch` | `legal-platform.ts:34-38`, `:124-180`; `legal/platform-terms.ts:395-408` (body), `:587-640` (hash against the version's row); format and seed hash `migrations/0031_*.sql:22-26`, `:74-79`; `CP3_E_REPORT.md:150-152` |
| 6 | `GET /v1/admin/legal/status` | cookie, `x-shop-id` (acting-as may read) | → `{ accepted, …, readiness: { returnAddress, vatAnswered, legalPagesAccepted, ready } }` | `routes/legal-admin.ts:31-39`, `:98-123`; `legal/legal-pages.ts:463-484` |
| 7 | `PUT /v1/admin/settings` | cookie, `origin`, `x-shop-id` | `{ returnAddress?, vatRegistered? }` → 200 `{ settings }` | `routes/admin-settings.ts:17-33` (acting-as admitted), `:43-58`; `platform/tenant-config.ts:688-750` (`parseStoreSettingsInput`) |
| 8 | `POST /v1/platform/users` | cookie, `origin` | `{ accountType: "tenant_admin", email, password }` → 201 `{ user }` / 409 exists | `app.ts:1839-1883`; the same call as `seed-staging-slice.mjs:834-841` |
| 9 | `POST /api/auth/sign-in/email` as the review admin | as #2 | → 200, cookie, `{ user: { id } }` | as #2; `seed-staging-slice.mjs:842-851` |
| 10 | `POST /v1/platform/tenants/:id/admins` | cookie (platform), `origin` | `{ userId }` → 201 `{ membership }` (also 201 when it already exists); 409 for another account kind | `app.ts:1933-1943`, `:1747-1763`; `platform/provision-tenants.ts:212-219`, `:494-560` |
| 11 | `POST /v1/admin/legal/accept-pages` | the **review admin's** cookie, `origin`, `x-shop-id` | `{ templateVersion, texts: {3 keys}, pod, custom }` → 201 `{ acceptance }`; 404 for acting-as; 429 (20 per shop per hour) | `legal-admin.ts:55-66`, `:77-89`, `:208-244`; `legal-pages.ts:177-219` (strict body, `checkHtml`), `:248-335`; acting-as refused: `platform-terms.ts:187-189`, tested at `cloudflare/test/legal-pages.test.ts:342-373` |
| 12 | `GET /v1/platform/tenants/:id` | cookie | → `{ tenant: { published, … }, settings, … }` | `routes/platform-tenants.ts:150-167`; `platform/tenant-directory.ts:158-186` |
| 13 | `POST /v1/platform/tenants/:id/publish`, `…/unpublish` | cookie, `origin`, no body | → 200 detail, `tenant.published` | `platform-tenants.ts:50-51`, `:172-225`; `tenant-directory.ts:448-492`; mount `app.ts:2371-2378` |
| 14 | `DELETE …/acting-as` | as the copy | | |

## The rehearsal (real bundle, `--dry-run`, no request)

`storage-copy.mjs --dry-run` on `export-2026-09-27T15-02-15.414Z`:

| Shop | Use | Distinct files | References |
|---|---|---|---|
| gif-sundsvall | product_image | 179 | 1 257 |
| gif-sundsvall | collection_cover | 6 | 6 |
| gif-sundsvall | branding | 7 | 7 |
| melodie-mc | product_image | 107 | 996 |
| melodie-mc | branding | 4 | 4 |
| ninetone | product_image | 185 | 1 144 |
| ninetone | collection_cover | 6 | 6 |
| ninetone | branding | 3 | 3 |
| sillmans | product_image | 24 | 48 |
| sillmans | branding | 3 | 3 |

- **524 distinct files**: 495 product images, 12 covers and 17 branding images. These equal the brief's 495 / 12 / 17.
- The **3 445 product-image references** equal the brief's count.
- **0 page images.** Neither page's HTML names the source's storage. There are 0 page attachments.
- **Addresses in these fields that are not files of the source's storage: 1**. It is robowatz's `logoUrl`, a root path; it is counted and never copied.
- Addresses the copy cannot fetch (for example `gs://`): 0.
- No file is named under two uses, and no address appears in two shops.
- Every source address sits on the source storage's host and carries an access token.
- By the extension in the address path (the type itself is decided by the bytes): 444 product images have no extension. 3 SVGs are all branding images, which `shop_branding` admits; no product image, cover or page image looks like an SVG.

`staging-legal.mjs --dry-run --publish-for-review` on the same bundle:
- The terms text is 22 522 bytes, and its sha256 `ca1f708f…` equals the hash 0031 seeded.
- Rendered pages (bytes of kopvillkor / angerratt / integritetspolicy); `checkHtml` passes for all 15 pages:

  | Shop | pod | The source lacks | Pages (bytes) | Published for review |
  |---|---|---|---|---|
  | gif-sundsvall | true | return address + VAT answer | 6 244 / 3 598 / 4 061 | yes |
  | melodie-mc | true | return address (empty) + VAT answer (null) | 6 517 / 3 775 / 4 278 | no (published in the source) |
  | ninetone | true | nothing | 6 635 / 3 762 / 4 416 | yes |
  | robowatz | true | return address + VAT answer | 6 236 / 3 594 / 4 053 | yes |
  | sillmans | false | nothing | 6 594 / 3 704 / 4 384 | yes |

- No shop in the bundle holds a legal-pages adoption.

## The gate

```
node --test "scripts/cf-port/migrate/test/*.test.mjs"  →  tests 402, pass 401, fail 1
node guard/guards.test.mjs                             →  guard: PASS (2062 tracked files; my files are untracked)
```

- The 402 are the 353 of before plus the 49 of S1 (9 + 6 + 7 + 14 + 13).
- **The one failure is S2's**: `no-write-calls.test.mjs` › "export.mjs and lib/*.mjs never call a Firestore/Auth write method". It flags `lib/transform-products.mjs:75`, a comment of S2's that spells a forbidden call shape. It was not fixed here.
- That test also flagged the S1 files at first, because it greps every `.mjs` under `migrate/` (except `test/`) for `.set(`, `.add(` and `.delete(`, comments included. The S1 files now use plain objects instead of Map/Set writes; that is a code change, not a test change.
- The guard scans tracked files only. I read my own new files for the earlier brand's name, the resale feature's name and the source project's name; there is no hit.

## What was NOT done

- **Nothing ran against staging or the source's storage.** No file was copied and no page was adopted; the reviewer runs the run book.
- **Artworks (row 43)** are not copied, as the brief says. Neither are page attachments, of which the bundle holds 0.
- **The platform terms are not accepted for the imported shops.** Acceptance is not part of the legal readiness (`legal-pages.ts:429-484`), so the pages show without it. The checkout gate would still need it (`seed-staging-slice.mjs:888-898` shows how).
- **Old reservations are not cleaned up.** A refused or failed upload leaves its reservation `pending` on staging, and the Worker's own lifecycle owns those rows. A second run retries every entry that is not `copied`: the brief asks for this, but the refused ones will be refused again.
- **Nothing is run in parallel.** The copy works on one file at a time, so 524 files take on the order of 524 × (fetch + reserve + upload).

## Deviations from the brief, with the reason

1. **The legal pages are not adopted "acting as the shop".** The Worker refuses an acting-as principal on `accept-pages` with the opaque 404: `maySignForSeller` (`platform-terms.ts:187-189`, `legal-admin.ts:77-89`, tested at `legal-pages.test.ts:342`). The brief's step cannot be built as written.
   - What was built: a staging review admin per shop, `staging-review+<shop>@example.com`, is created, granted admin of that shop, and signed in. It adopts the pages. This is how `seed-staging-slice.mjs` already does it for its slice shop.
   - The adoption's evidence row then names that address, which says what it is.
   - Everything else in (b) (status, settings) does run under acting-as.
2. **"Says so in every audit row it causes" holds only where the Worker takes a text.** The grant's `acting_as.granted` row carries the reason, and the settings writes carry the grant id (`admin-settings.ts:29-33`). But these rows have fixed metadata and take no free text from the caller:
   - `legal.pages.accept`;
   - `tenant.publish` / `tenant.unpublish`;
   - the user creation;
   - the membership grant.

   There the review admin's address and the grant are what mark them as the review step.
3. **The copy refuses some files locally**, which the brief implies but does not name: `too_large` (the Worker's 15 MB / 512 KB caps, needed so the tool does not stream a larger file), `not_an_image`, and `empty`, all decided by the Worker's sniff. A refusal by the reserve route carries no reason, so it is recorded as `http_400`.
4. **"Three tries" applies to transient failures only**: a timeout, a network error, a 429 or a 5xx. A permanent answer such as a 403 from the source is `failed` after one try.
5. **`copy-pending.json` sits beside the manifest.** Without it, a run that stopped after an upload but before its manifest write would upload the file a second time. That would break "the same file is never uploaded twice for one shop" (the brief's point 2).
6. **`staging-legal.mjs` takes `--bundle`, `--out`, `--shop` and `--dry-run`** besides `--env`. The pages are rendered from the imported identity as the bundle holds it, which CP3 imported verbatim apart from refused keys. The published list needs a directory outside the repository.
7. **The readiness gaps are filled with visible staging values.** The return address says it is a placeholder, and the VAT answer is `false`. The brief says "sets what the legal readiness needs" without saying with what. The rendered ångerrätt page shows the placeholder.
8. **Two source files are loaded under Node in a way the brief does not describe.**
   - `loadWorkerModule` lives in `lib/copy-sources.mjs` rather than in a file of its own. It uses `node:module` `stripTypeScriptTypes`, which is experimental in Node 22.14 and prints one `ExperimentalWarning` to stderr per run.
   - The source's legal renderer imports DOMPurify, which needs a DOM that Node lacks. `staging-legal.mjs` registers a module-resolve hook that hands `legalPageRenderer.js`, and only that module, a pass-through `sanitize`. markdown-it runs there with `html: false`, and the Worker's `checkHtml` decides both locally and at the route.
9. **The copy-manifest format is unchanged.** It is also not wrong: the key S2 needs follows from `objectKeyOf` (see "The object key").

## Open questions

1. **The review admins stay on staging** as admins of the imported shops after the review. Should `--unpublish-after-review` also revoke those memberships, and through which route? None was built.
2. **Renewing the terms acceptance**: should the step also accept the platform terms as the review admin, so a staging checkout works on the imported shops? It is not needed for the pages.
3. **The 4 unpublished shops** are published on staging only through the explicit flag. Should `melodie-mc` (published in the source) be left exactly as CP3 imported it? It is: the flag never touches a shop that the source holds as published.

## Run book for the reviewer (staging)

```
cd "/Users/mikaelohlen/Cursor Apps/chopshop"
export CHOPSHOP_PLATFORM_EMAIL='<the staging platform admin, the account POST /v1/platform/bootstrap minted>'
# Passwords are read from ~/.config/chopshop/secrets.staging.env (PLATFORM_ADMIN_PASSWORD,
# CHOPSHOP_SLICE_ADMIN_PASSWORD) unless CHOPSHOP_PLATFORM_PASSWORD / CHOPSHOP_REVIEW_ADMIN_PASSWORD are set.
BUNDLE=~/chopshop-export/export-2026-09-27T15-02-15.414Z
COPY_OUT=~/chopshop-export/import-2026-09-28/copy
LEGAL_OUT=~/chopshop-export/import-2026-09-28/legal

# 1. The files: rehearse, probe with three files of one shop, then the whole copy.
node scripts/cf-port/migrate/storage-copy.mjs --env staging --bundle "$BUNDLE" --out "$COPY_OUT" --dry-run
node scripts/cf-port/migrate/storage-copy.mjs --env staging --bundle "$BUNDLE" --out "$COPY_OUT" --shop sillmans --limit 3
#    check one copied object's public address in a browser: base of pinned.staging.json r2.publicBaseUrl + the key
node scripts/cf-port/migrate/storage-copy.mjs --env staging --bundle "$BUNDLE" --out "$COPY_OUT"
#    exit 0 = nothing failed; exit 1 = run it again (copied entries are skipped); read the per-shop status table.

# 2. The rows (S2): import-catalogue.mjs ... --copy-manifest "$COPY_OUT/copy-manifest.json" (see CP4_S2_REPORT.md).

# 3. The legal data steps: rehearse, then run, publishing the shops unpublished in the source.
node scripts/cf-port/staging-legal.mjs --env staging --bundle "$BUNDLE" --out "$LEGAL_OUT" --dry-run --publish-for-review
node scripts/cf-port/staging-legal.mjs --env staging --bundle "$BUNDLE" --out "$LEGAL_OUT" --publish-for-review
#    expect: terms text archived (or "already archived"), 5 shops "legal readiness ready", 4 published for review.

# 4. After the design review:
node scripts/cf-port/staging-legal.mjs --env staging --out "$LEGAL_OUT" --unpublish-after-review
```

Both tools refuse `--env production` and an `--out` inside the repository. The copy can be stopped and started again at any point.
