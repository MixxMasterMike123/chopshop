# CP4-C report — pages and legal pages

Builder: CP4-C. Branch `cf-port`, working tree only (no git writes, no network, no wrangler, no installs). Brief: `CP4_BRIEFS.md` §0, the address grammar, §C; DECISIONS D79, D84, D88, D94. Builders A, D and G worked in the same tree at the same time; none of their files was touched (their blocks in `app.ts` sit around mine unchanged).

## Files

| File | |
|---|---|
| `cloudflare/migrations/0042_pages.sql` | new: `pages`, its triggers, two bump triggers on other tables |
| `cloudflare/src/content/html-refusal.ts` | new, pure: `checkHtml(html)` — the refusing scan |
| `cloudflare/src/content/pages.ts` | new: parsing, admin reads and writes, public reads, the language rule |
| `cloudflare/src/routes/admin-pages.ts` | new: `/v1/admin/pages`, `/v1/admin/pages/:pageId` |
| `cloudflare/src/routes/public-pages.ts` | new: `/v1/pages`, `/v1/pages/:slug` |
| `cloudflare/src/routes/public-legal.ts` | new: `/v1/legal`, `/v1/legal/:key` (and the legal page table D can read) |
| `cloudflare/test/pages.test.ts` | new: 254 tests (refusal, schema, admin routes) |
| `cloudflare/test/public-pages.test.ts` | new: 23 tests |
| `cloudflare/test/public-legal.test.ts` | new: 19 tests |
| `cloudflare/src/app.ts` | only inside `CP4-IMPORTS-C` and `CP4-ROUTES-C` |

Read only: `src/legal/legal-pages.ts` (`LEGAL_PAGE_KEYS`, `readJsonBodyWithin`), `src/legal/platform-terms.ts` (`readTermsStatus`, `readTermsText`), `src/storage/public-objects.ts`, `src/storefront/public-routes.ts` (`versionedJsonResponse`), `src/tenancy/resolve-tenant.ts`.

---

## Schema (0042)

`pages` with the brief's names, unchanged: `page_id, tenant_id, slug, kind 'page'|'post', status 'draft'|'published', title_json, content_json, summary_json NULL, meta_title_json NULL, meta_description_json NULL, author NULL, image_object_id NULL, published_at NULL, created_at, updated_at`, `UNIQUE (tenant_id, slug)`. **Added:** `created_by`, `updated_by` (nullable user ids, 1–128 chars; manifest row 40 carries `createdBy`/`updatedBy` uid→map; NULL for an imported row whose user is not carried).

| Column | Rule |
|---|---|
| `page_id` | 1–128 of `[A-Za-z0-9_-]` (a new page gets a UUID; an imported one keeps its Firestore id) |
| `slug` | 1–100 of `[a-z0-9-]`, no leading or trailing hyphen: ONE path segment |
| `*_json` | JSON object; every value a string and every key `[a-z]{2,3}` optionally `-[A-Z]{2}` (triggers `pages_language_maps_insert/update`); title and content name at least one language. Byte caps (`length(CAST(… AS BLOB))`): title 16 384, content **262 144**, summary 65 536, meta title 16 384, meta description 32 768 |
| `author` | NULL or 1–200 chars |
| `image_object_id` | FK `stored_objects`; triggers refuse an object that is not `bucket = 'public' AND kind = 'product_media'` of the SAME tenant (insert, and update of `image_object_id`/`tenant_id`) |
| times | ISO-8601 with the strftime round-trip CHECK (as 0032); `updated_at >= created_at` |
| row | `CHECK (status <> 'published' OR published_at IS NOT NULL)` |

Triggers: `pages_tenant_immutable`, `pages_id_immutable`; `pages_reserved_slug_insert/update` (the reserved list below; a test pins it equal to `RESERVED_PAGE_SLUGS`); `catalog_version_pages_insert/update/delete`. Indexes: `(tenant_id, status, published_at DESC, page_id DESC)`, `(tenant_id, created_at DESC, page_id DESC)`, partial `(tenant_id, image_object_id) WHERE image_object_id IS NOT NULL`.

**Two bump triggers on tables that are not mine** (rule 6, whatever a visitor sees bumps `catalog_version`):
- `catalog_version_legal_acceptances_insert` — a new legal-pages adoption (Worker or import) changes `/v1/legal*`. 0037's table is append-only, so INSERT is the only event.
- `catalog_version_page_image_update` — `AFTER UPDATE OF status, bucket, kind, object_key, content_type, width_px, height_px ON stored_objects` when a page names the object. **Overlaps** A's `catalog_version_public_objects_status` (0040) and D's `catalog_version_public_objects_insert/update` (0043), which appeared in the tree while I worked: a removal now bumps up to three times (harmless). Mine alone covers `content_type`, `kind`, `width_px`, `height_px`. See Reviewer wiring 4.

**Reserved slugs** (`RESERVED_PAGE_SLUGS` = the trigger list): the brief's `product, produkter, kategori, samling, tagg, cart, checkout, order-return, order-confirmation, angra, rapportera-intrang, _api, assets`, the legal keys `kopvillkor, angerratt, integritetspolicy, plattformsvillkor`, **plus `legal`** (Deviation 1).

---

## Content is HTML: `html-refusal.ts`

`checkHtml(html: string): { ok: true } | { ok: false; reason: HtmlRefusal }`. Pure (a string in, a verdict out; no env, no I/O), so the importer can run it under Node as it runs `image-sniff.ts`. Modelled on P's `checkSvg`: refuse, never repair; not a parser, not a sanitiser.

Order: over 262 144 characters → `too_large`; a C0 control but tab/LF/CR, DEL, form feed or a lone surrogate → `invalid_character`; the text is ASCII-lower-cased; `javascript:` or `vbscript:` anywhere with all white space removed → `javascript_url`; a Firebase Storage host anywhere (`firebasestorage.googleapis.com`, `storage.googleapis.com`, `firebasestorage.app`, `appspot.com`, also with `%2e` for a dot) → `storage_address`; then EVERY `<`, in order:

- `<!--` → the comment must be closed somewhere after it (else `malformed`), and its content is **scanned like everything else**: a tag inside a comment is refused like any other, and `--!>` / `<!-->` cannot end one early behind the scan's back;
- any other `<!` (DOCTYPE, CDATA, bogus comments, Word conditional comments) → `declaration`; `<?` → `processing_instruction`;
- `</name>` (white space before `>` only) — anything else `malformed`, a `:` `foreign_content`, and the element rules below apply;
- `<` + letter → a start tag read as the HTML tokenizer reads one in its data state: name `[a-z0-9-]*`; attributes `name`, `name=value`, `name="value"`, `name='value'`; names `[a-z][a-z0-9_.-]*`. It refuses (`malformed`) wherever it and the tokenizer could part ways: a `/` that is not the tag's end, a quoted value not followed by white space, `/>` or `>`, an unquoted value holding `"`, `'`, `<`, `=` or a backtick, an empty value, a duplicate attribute, **a `<` inside any value**, a name ending in anything but white space, `/`, `>` (or `=`), a non-ASCII letter or a no-break space in a tag, a tag cut off at the end. A `:` in a name → `foreign_content`;
- anything else after `<` (a raw `<` in text) → `malformed`.

Because no tag read ever spans a `<` (names stop at it, values that hold it refuse), every `<` a browser could start a tag at is visited as a tag start.

Element refusals (start and end tags): `script` → `script`; `iframe, object, embed, applet, frame, frameset, portal, fencedframe` → `embedded_content`; `svg, math, foreignobject, annotation-xml, mglyph, malignmark` → `foreign_content`; `style, title, textarea, xmp, noscript, noembed, noframes, plaintext, template` (every element that switches the tokenizer out of its data state) → `raw_text_element`; `form, input, button, select, keygen, isindex` → `form`; `base, link, meta, html, head, body` → `document_element`.

Attribute refusals: a name starting with `on` → `event_attribute`; `srcdoc` → `embedded_content`; `action`, `formaction` → `form`. Values are decoded once as the tokenizer decodes them, but only numeric references and `&amp; &lt; &gt; &quot; &apos; &nbsp;` with their semicolon are read; any other `&` + letter/digit/`#` → `entity_reference` (HTML knows `&colon;`, `&Tab;`, `&NewLine;`, and some decode without a semicolon); a reference to NUL, a control, DEL, a C1 control (HTML re-maps them), a surrogate or past U+10FFFF → `entity_reference`. On the decoded value: `javascript:`/`vbscript:` → `javascript_url`; a storage host → `storage_address`; `style`: a backslash → `escape`, `@` → `unsafe_style`, any `(` not preceded by `rgb, rgba, hsl, hsla, calc, var, min, max, clamp` → `unsafe_style` (so `url(`, `url (`, `url/**/(`, `image-set(`, `expression(`); address attributes (`href, src, srcset, imagesrcset, poster, background, cite, longdesc, lowsrc, dynsrc, data, codebase, classid, archive, usemap, manifest, icon, profile, ping, itemtype, itemid`): split on white space and commas, `srcset` descriptors skipped, each token's scheme must be `http`, `https`, `mailto` or `tel` (so `data:`, `javascript:`, `blob:`, `ftp:`… refuse), and a `:` before the first `/?#` without such a scheme refuses too.

Admitted as they are (tested): Quill's output (headings, lists with `data-list`, `ql-align-*` classes, `style="color: rgb(…)"`), links (absolute, relative, `#`, `?`, `//host`, `mailto:`, `tel:`), images and `srcset`, `picture`, `video`, tables with unquoted values, comments, custom elements, named references in text (`&hellip;`), a lone `&` in text.

**Proven by tests:** 22 admitted samples; 127 refusals, one per construct above, including every walk-around the reviewer named (case, white space inside tags, entities, comments, CDATA, namespaced names, `data:`/`javascript:`, `srcdoc`, `formaction`, `style` with `url(`/`expression(`/`@import`, SVG and MathML); and a property test: `<script>…</script>`, `<img src=x onerror=…>`, `<iframe srcdoc=x>` and `<svg onload=…>` inserted at **every position of every admitted sample** (1 000+ texts each) are all refused. Mutations run and reverted: scanning past comments fails 8 tests; admitting `<` in a quoted value fails 6.

---

## Routes

Every refusal is `404 {"error":{"code":"not_found","message":…}}` unless a status is given. Registered in `CP4-ROUTES-C`, exact paths, `onMethods`, the public ones in `storefront(...)`; HEAD and unclaimed methods fall through to the 404 (tested). Segments from the raw pathname, decoded once (`decodeSegment`).

### Admin (`X-Shop-Id` + session; acting-as admitted, audited with the grant)

Authorization first (opaque 404 for anyone else), then same-origin for every state change before the body is read, then the id.

```
GET    /v1/admin/pages?kind=page|post&status=draft|published&cursor&limit=1..100 (default 50)
       200 { pages: [{ pageId, slug, path, kind, status, title: { <lang>: string },
                       publishedAt, createdAt, updatedAt }], nextCursor: string | null }
       newest first by creation, keyset (created_at, page_id); cursor "<createdAt>~<pageId>"
       400 invalid_request   unknown or repeated parameter, bad kind/status/limit/cursor
POST   /v1/admin/pages
       { slug, title, content, kind?, status?, summary?, metaTitle?, metaDescription?,
         author?, imageObjectId?, publishedAt? }          no other key
       201 { page }
GET    /v1/admin/pages/:pageId      200 { page }
PATCH  /v1/admin/pages/:pageId      any non-empty subset of the POST fields → 200 { page }
DELETE /v1/admin/pages/:pageId      204 (empty)

page = { pageId, slug, path, kind, status, title, content, summary, metaTitle, metaDescription,
         author, imageObjectId, image: PublicImage | null, publishedAt, createdAt, updatedAt,
         createdBy, updatedBy }
```

Field rules: `slug` as the column; `title` a map of 1–10 languages, each 1–300 chars, no control character, not blank; `content` a map of 1–10 languages, each admitted by `checkHtml`, the stored JSON ≤ 262 144 bytes; `summary` (≤ 2 000, line breaks allowed), `metaTitle` (≤ 300), `metaDescription` (≤ 1 000, line breaks allowed) maps or `null`, blank values dropped, an empty map stored as NULL; `author` 1–200 or `null`; `imageObjectId` or `null`; `publishedAt` ISO with milliseconds (round-trip) or `null`; `kind` default `page`, `status` default `draft`.

| Answer | When |
|---|---|
| 400 `invalid_request` | shape, grammar, lengths, a published page with `publishedAt: null` |
| 400 `{ error: { code: "slug_reserved", message } }` | a reserved slug |
| 400 `{ error: { code: "content_refused", message, reason, language } }` | `reason` is the `HtmlRefusal`, `language` the key whose HTML failed |
| 400 `{ error: { code: "image_not_referencable", message } }` | not `getReferencablePublicImage(…, ["product_media"])` of this shop (another shop's, pending, removed, private, branding, unknown — each tested) |
| 409 `{ error: { code: "slug_taken", message } }` | another page of this shop has it (create and rename); the same slug in another shop is admitted |
| 413 `payload_too_large` | body over 1 MiB (declared or streamed), content over 262 144 bytes of stored JSON (bytes, not characters: tested with `å`), a text over its cap or the scan's length |

Writes: one batch each, the audit row (`pages.create` / `pages.update` / `pages.delete`, `resource_type 'page'`, metadata `{ kind, slug, status }` or `{ fields, slug }`, plus `actingAsGrantId` under a grant) written only while the page exists; `meta.changes` compared with `=== 0`. Publishing dates a page (`COALESCE(published_at, now)`: a draft keeps its date, a re-publish keeps the first date); `publishedAt` may be set explicitly (a back-dated post). A PATCH checks the image only when it changes, so a form sent back unchanged after its image was removed (D93) is not refused; the view then shows `image: null` with `imageObjectId` kept. `updated_at = max(created_at, now)`.

### Public (tenant by hostname; ETag = `catalog_version` through `versionedJsonResponse`)

Only a **published** page of an **active and published** shop answers (`tenants.status = 'active' AND published = 1`, read in the same batch as the page). A draft, an unknown or malformed slug, another shop's slug, an unpublished or suspended shop, an unknown host → `404 {"error":{"code":"not_found","message":"Page not found"}}`, no ETag.

```
GET /v1/pages?kind=page|post&lang&cursor&limit=1..100 (default 20)
    200 { pages: [{ slug, path, kind, title, summary, author, publishedAt,
                    image: PublicImage | null }], nextCursor: string | null }
    newest first by publication, keyset (published_at, page_id); kind absent = both
GET /v1/pages/:slug?lang
    200 { page: { slug, path, kind, lang, title, content, summary, metaTitle,
                  metaDescription, author, publishedAt, updatedAt, image: PublicImage | null } }
    400 invalid_request   an unknown or repeated parameter (both routes), a bad kind/limit/cursor
```

`path` = `"/<slug>"`, relative to the shop's root. **Language:** each text in the requested language when it is a well-formed tag and the page has a non-blank text in it, else the shop's `default_locale`, else the page's first language in sorted order (Firebase `getContentValue`'s rule, per text); an absent, malformed or unknown `lang` reads as the default. `lang` in the answer is the language of `content`. Only the row's own maps are read, and the row is read by `(tenant_id, slug)`: no fallback can reach another page or shop. A change of `default_locale` bumps the version (0025) and changes the answer (tested). No `pageId`, `status`, actor or `imageObjectId` in a public body (tested).

### Legal (tenant by hostname; D79)

```
GET /v1/legal
    200 { pages: [{ key, path, title }] }
        the pages of the LATEST legal-pages adoption that hold text, in the footer's order,
        then the platform's terms while their current version has an archived text
GET /v1/legal/:key            key = kopvillkor | angerratt | integritetspolicy
    200 { page: { key, path, title, html, adoptedAt } }
GET /v1/legal/plattformsvillkor
    200 { page: { key, path, title, version, publishedAt, text } }
404 { error: { code: "not_found", message: "Legal page not found" } }
```

| key | path | title |
|---|---|---|
| `kopvillkor` | `/legal/kopvillkor` | Köpvillkor |
| `angerratt` | `/legal/angerratt-och-returer` | Ångerrätt & returer |
| `integritetspolicy` | `/legal/integritetspolicy` | Integritetspolicy |
| `plattformsvillkor` | `/legal/plattformsvillkor` | Plattformsvillkor |

- **A shop page**: `html` is the key's value in `legal_acceptances.texts_json` of the shop's latest `type = 'legalPages'` row (`ORDER BY accepted_at DESC, acceptance_id DESC`, as `readLatestLegalPagesAcceptance`), verbatim (only that value is read out of the snapshot, with `json_extract`); `adoptedAt` is that row's `accepted_at`. No adoption, or a latest adoption whose value for the key is missing, empty or not a string → 404 (an older adoption is never used). Imported `platformTerms` rows are ignored.
- **The platform terms**: the current version by `readTermsStatus` (THE definition of current: latest `published_at <= now`), its archived text by `readTermsText` (re-hashed on the way out; a mismatch throws, never served — tested). No current version, no archived text, or no `PRIVATE_BUCKET` → 404. A version published for later is not answered before its time (tested).
- **Nothing editable**: GET only on all three paths (every other method 404, tested); no page can take a legal key, `legal` or a legal address (reserved slugs); the text answered is byte-equal to the adopted/archived one (a BOM, CRLF, quotes, a backslash and an emoji are tested).
- **Caching**: a shop page's ETag is `"<catalog_version>"` (a new adoption bumps it by 0042's trigger). The platform terms change without a write (a scheduled version becomes current when its time comes), so the terms answer `"<catalog_version>.<version>"` and the list `"<catalog_version>.<version|none>"`. The If-None-Match comparison is made before the archived text is read: a 304 costs no bucket read (tested with a counting bucket).
- A shop that is not active and published answers 404 on all three (tested).

**Answer keys:** `{ page }` for `GET /v1/pages/:slug` and `GET /v1/legal/:key`, `{ pages, nextCursor }` / `{ pages }` for the lists — the keys builder E's client already reads (`src/api/pages.js`, `src/api/legal.js`); no change there.

**Exported for D** (SEO, sitemap, menu): `readPublicPage`, `listPublicPages`, `publicTenantStatement` (`src/content/pages.ts`); `PUBLIC_LEGAL_PAGES`, `readPublicShopLegalPage`, `listPublicLegalPages` (`src/routes/public-legal.ts`).

---

## What the platform-terms page shows today, and what has a source in D1

`DynamicPage.jsx` (slug `legal/plattformsvillkor`) renders from build-time constants: the title "Plattformsvillkor", "Version: <PLATFORM_TERMS_VERSION>", an intro sentence naming `PLATFORM.legalName`, the terms rendered from `PLATFORM_TERMS_TEMPLATE` (markdown-it + DOMPurify, merge fields `{{platform_legal_name}}`, `{{platform_org_suffix}}`, `{{last_updated}}` = the version), and a **second card**: "Personuppgiftsbiträdesavtal" rendered from `PLATFORM_DPA_TEMPLATE`.

| Shown today | Source on Cloudflare |
|---|---|
| version | D1 `platform_terms_versions.version` (`version`, `publishedAt` in the answer) |
| terms text and DPA text | the archived text of the version (private R2, `platform_terms_texts`), when attached. For the 0031 seed it is `JSON.stringify({ version, terms, dpa })` of the **templates** (CP3-E §2): markdown with the merge fields unfilled. Answered as `text`, verbatim; the client parses the wrapper and renders the markdown as today |
| page title, DPA title, intro sentence | UI copy (constants in the client); the API gives `title` |
| platform legal name, org number (the merge values and the intro) | **no source in D1**: build-time `VITE_PLATFORM_LEGAL_NAME` / `VITE_PLATFORM_ORG_NUMBER` (`src/config/platform.js`) |
| the text itself for the seed version | **not in D1 until a platform user attaches it** (CP3-E: `PUT /v1/platform/legal/terms-versions/2026-09-07/text`); until then this route answers 404 |

**The three shop pages**, what today's page shows and its source: the H1 title (constant → `title`); "Senast uppdaterad: <today's date>" (Firebase prints the render date → `adoptedAt`, the adoption date, per the brief); the body — **Firebase renders the CURRENT template with the CURRENT identity on every view; Cloudflare shows the ADOPTED snapshot (D79)**, so a changed return address shows only after the seller adopts again; a copy-on-write page's own text is in the snapshot (Firebase `renderAcceptedLegalTexts` puts `customHtml` there); the **seller's extra CMS page appended below the legal block** (non-custom case) has **no source**: pages cannot take a legal address; the `noindex` while the shop is not legally ready is computable in D1 (`readLegalReadiness`) but **not carried** by these routes (open question 5).

## Are pages screened content in the source system?

**No.** The screening trigger `screenProductOnWrite` (`functions/src/catalog/screenProductOnWrite.ts`) is `onDocumentWritten('products/{productId}')`, with two re-screen triggers on `podMappings` and `podArtwork`; `contentScreening.ts` reads product texts only. Nothing reads or triggers on `pages`. No screening was added.

---

## What was NOT done

- No attachments (D94); no admin UI (CP5); no preview of an unpublished shop (D57, D's second pass).
- No count cap or rate limit on page writes (each write is bounded at 1 MiB / 256 KiB; pages can be deleted).
- No lost-update fence on PATCH: last write wins per field, as Firebase's full overwrite did.
- No DOM-clobbering check (`id`/`name` values that shadow `document` properties): left to DOMPurify's `SANITIZE_DOM` in the storefront, which stays.
- No re-scan of stored HTML at read time: rows the importer writes must go through `checkHtml` (it is pure for that).
- The platform terms' merge fields are not filled on the server, and the JSON wrapper is not parsed.
- The legal routes carry no readiness / `robots` field.
- The 256 KiB bound parameter has run in miniflare only, not on real D1 (as CP3-E noted for its snapshot).
- No check that the three adopted legal HTML texts pass `checkHtml` (the accept route is not mine: open question 3).

## Deviations from the brief, with the reason

1. **Legal pages keep today's addresses**, `/legal/kopvillkor`, `/legal/angerratt-och-returer`, `/legal/integritetspolicy`, `/legal/plattformsvillkor` (two segments; the baseline was shot there, `baseline/storefront/manifest.json`). The brief's grammar writes `<root>/<slug>` for them and reserves the legal keys as page slugs; I reserve the keys **and `legal`**, the first segment of those addresses. Builder E's router has only `/:slug` (one segment): see Reviewer wiring 3.
2. **A page slug is one segment**, `[a-z0-9-]`, no edge hyphen, ≤ 100 (the brief fixes no grammar). A Firebase slug with a `/` or upper case cannot be imported as is: S reports it.
3. **`GET /v1/pages` without `kind` lists pages and posts**; `kind=page` is what the footer needs (`ShopFooter` auto-lists every published page today). The brief shows only `?kind=post`. List items carry `kind`; the page answer carries `kind`, `lang`, `content`, `metaTitle`, `metaDescription`, `updatedAt` (today's page prints `updatedAt`).
4. **The refusal refuses more than the brief's list**, each on "a doubt refuses", as P's SVG check did: the elements, attributes, schemes and constructs listed above, and **`javascript:` anywhere in the text**, not only in an address (so prose reading "JavaScript: …" is refused: open question 1).
5. **Two extra columns** (`created_by`, `updated_by`) and **two triggers on other tables** (above).
6. **The legal ETags of the platform terms and the list are composite** (`"<cv>.<version>"`), because the current version changes by time.
7. **The platform terms answer 404 when the current version has no archived text**, rather than 200 with `text: null`: a visitor page with nothing to show. The list leaves the entry out in that case.
8. **The public routes refuse unknown or repeated query parameters** with 400, as the admin lists of CP3 do.
9. **Acting-as platform users may write pages** (as for the store settings; the audit row carries the grant). The brief does not say.

## Open questions

1. `javascript:` refused in page **text** (not only in addresses): keep the stricter rule, or limit it to attribute values, where it is the only place it can act?
2. **Image addresses inside page HTML.** The brief names an image of a page by its address from `resolvePublicImages`, so `content_json` holds addresses of the public base; the move to a domain of our own (CP7) then needs a rewrite of page content (or a read-time rewrite), unlike every other row, which holds object ids. Accept and plan the CP7 rewrite, or store an object reference in the HTML and resolve it at read time?
3. **The adopted legal HTML is not scanned.** `POST /v1/admin/legal/accept-pages` stores whatever the client rendered, and `GET /v1/legal/:key` serves it verbatim (the storefront's DOMPurify is then the only fence, as in Firebase). Should `parseAcceptPagesInput` run `checkHtml` on the three texts (a change in `src/legal/`, reviewer-only)? Not verified: whether the real rendered templates pass it (markdown-it's output looks admissible).
4. The platform terms' `text`: keep it raw (the client parses `{ version, terms, dpa }`), or parse it on the server into `terms` and `dpa`?
5. `robots` for a legal page of a shop that is not legally ready (Firebase: `noindex`): D's `GET /v1/seo`, or a field here?
6. Legal pages of an **unpublished** shop answer 404 (as every public read); Firebase showed them (with `noindex`). Follow D57's preview when D builds it?

## Reviewer wiring

1. **`REQUIRED_MIGRATION`** → the last CP4 migration at consolidation (`app.ts`, `test/health.test.ts`, `test/public-catalog.test.ts`). 0042 is additive; no data step.
2. **The seed's platform-terms text** must be attached on staging (and production) for `GET /v1/legal/plattformsvillkor` to answer: CP3-E §2's command, `PUT /v1/platform/legal/terms-versions/2026-09-07/text` under a platform session.
3. **Builder E / F: the storefront router needs the legal addresses** `/legal/:key` (today's four, table above): E's router has `/:slug` only. The web Worker's allowlist already passes `/v1/pages`, `/v1/pages/:id`, `/v1/legal`, `/v1/legal/:id`: no change. E's client keys (`{ page }`, `pages`, `nextCursor`) match.
4. **Consolidate the `stored_objects` bump triggers** of 0040 (A), 0042 (C) and 0043 (D): one general trigger on public objects covering `status, bucket, kind, object_key, content_type, width_px, height_px` would make mine redundant.
5. **For S (the importer):** run `checkHtml` on every imported content map (refusals by page and reason); map a plain-string `title`/`content` to `{ "sv-SE": … }`; write `published_at` for published pages (Firebase has none: `updatedAt` or `createdAt`); slugs must fit the grammar and not be reserved; `created_by`/`updated_by` through the user map or NULL; `image_object_id` only for a verified `product_media` object of the same shop.
6. No new binding, variable or secret.

## Test numbers

- `test/pages.test.ts` **254**, `test/public-pages.test.ts` **23**, `test/public-legal.test.ts` **19**: together **296 passed** (05:47).
- Mutations, each reverted and re-run green: dropping `published = 1` from the public tenant gate fails 2 tests (one per suite); dropping `status = 'published'` from the public reads fails 3; disabling the adoption bump trigger fails 2; the two refusal mutations above fail 8 and 6.
- `npx tsc --noEmit`: exit 0 at the full run (05:44). A later run shows two errors in `test/withdrawals.test.ts` (builder G's file, in progress); none in mine.
- **Whole suite** (`npx vitest run`, started 05:44:20, every builder's work in the tree): **83 files; 3 534 tests: 3 531 passed, 2 failed, 1 skipped.** Both failures are outside my files and follow from builder D's work in progress:
  - `test/admin-settings.test.ts` › "nothing in tenant_settings reaches a public response": `GET /v1/storefront` now carries D's `identity` (`heroHeadline`) and `pickupLocations`, which this CP3-A test pins as never public.
  - `test/web-worker.test.ts` › "serves the application through the real API, which has no head route yet": D's `GET /v1/seo` now exists, so the head is injected.
- `node guard/guards.test.mjs` scans tracked files only, so my untracked files are not in its list; a grep of my nine files for the guard's three pattern families finds nothing.

---

## Review round 1 (reviewer, 2026-09-28)

Read line by line: the migration, `html-refusal.ts`, `pages.ts`, the three route files. Run by the reviewer: C's three suites and the legal suites.

**Changed by the reviewer:**

1. **Open question 3 answered, and it was a hole: the adopted legal texts pass the HTML refusal at adoption** (`src/legal/legal-pages.ts`, `parseAcceptPagesInput`). The text comes from the seller's browser and is shown to every visitor as it is. On the shared host every shop is served from ONE origin, so a script in one shop's legal page would run beside every other shop's cart and receipts. Four refusal cases added to `test/legal-pages.test.ts`. **The three templates were rendered as the storefront renders them (markdown-it, both branches of every conditional) and pass the refusal**: their markup is `a, em, h1–h3, li, ol, p, strong, ul`. Builder F also cleans a legal page when it renders it, as it cleans a content page.
2. **`GET /v1/legal/:key` also answers the last segment of the page's address** (`angerratt-och-returer`): the storefront's router holds the address, not the key. Test changed accordingly.
3. **The storefront's router gains `<root>/legal/:slug`** (`src/storefront/StorefrontApp.jsx`), and the address grammar of `CP4_BRIEFS.md` says so (deviation 1 is right: the brief was wrong).

**Answers to the open questions:**

1. `javascript:` anywhere in the text stays refused. The refusal names its reason and the language, so the seller sees what to change.
2. Images inside a page's HTML keep their address. At CP7 the content of the pages is rewritten once with the move of the base, as the stored addresses of D78 are. Recorded for CP7.
4. The platform's terms are answered as the archived text. The storefront renders them as it does today; the legal name and number of the platform stay values of the build.
5. `robots` for a page of a shop that is not legally ready: D's answer for search engines carries it.
6. A legal page of an unpublished shop is a 404, as everything of that shop is; it is seen through the preview (D57, D's second pass).

**Accepted deviations:** 1–9. **Left for the consolidation:** the bump triggers on `stored_objects` of three builders become one (in 0039, which no database has applied yet); `REQUIRED_MIGRATION`. **For the staging proof:** attach the text of the platform terms' first version (wiring 2).
