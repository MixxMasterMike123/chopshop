# CP3-E report: D47 grace, publishing terms versions, legal-pages acceptance

Branch `cf-port`, Worker in `cloudflare/`. Nothing was committed, deployed or sent over the network. No wrangler command ran. `REQUIRED_MIGRATION` and the tests that pin it were not touched.

**This report describes the code after review round 1.** The two requested changes and the readiness gate are summarised in §10 and folded into §1–§2. Sections that no longer hold say so where they stand.

## Files

**New**
- `cloudflare/migrations/0037_legal_acceptances.sql`
- `cloudflare/src/legal/legal-pages.ts`: canonical form, bounded body reader, legal-pages accept/read, `hasLegalPagesAcceptance`, and the readiness gate (`readLegalReadiness`, `isLegallyReady`).
- `cloudflare/src/routes/legal-platform.ts`: the platform terms-version routes.
- `cloudflare/test/legal-grace.test.ts` (11 tests), `cloudflare/test/legal-pages.test.ts` (13 tests).

**Changed (owned)**
- `cloudflare/src/legal/platform-terms.ts`: grace rule in `readTermsStatus`, new gate `isTermsGateOpen`, shared `maySignForSeller`, publish / attach / list / read of versions and their archived text.
- `cloudflare/src/routes/legal-admin.ts`: status gains the grace keys and `readiness`; three new handlers; one shared seller-signature guard.
- `cloudflare/src/commerce/checkout.ts`: the imports and the gate call only (`isTermsGateOpen` AND `isLegallyReady`), plus the comment above it.
- `cloudflare/src/app.ts`: only inside `CP3-IMPORTS-E` and `CP3-ROUTES-E`.
- `cloudflare/test/legal-fixtures.ts`: new SQL helpers, the known-answer vector, and the readiness fixtures (§10.3). Existing exports keep their signatures.
- `cloudflare/test/legal.test.ts` (round 1): its two shops are made legally ready in `beforeAll`, and its two exact status assertions gain the new keys. No assertion was removed or loosened.

## 1. Migration `0037_legal_acceptances.sql`

Additive only: two new tables, one index, seven triggers (one of them on the 0031 table `platform_terms_versions`; the `custom_json` summary trigger is new in round 1). No `ALTER` was needed, because `published_at` already exists in 0031.

**`legal_acceptances`** follows the schema contract, names exact:
- `acceptance_id` PK; `tenant_id` FK to tenants; `type` in (`legalPages`, `platformTerms`).
- `user_id` is a nullable FK to `"user"`. `legacy_uid` is nullable.
- `email`, `accepted_at` (NOT NULL, ISO round-trip CHECK), `accepted_at_original`, `template_version`, `version`.
- `is_pod` and `is_custom` are nullable 0/1. `is_custom` means at least one page is custom.
- `custom_json` (round 1) is nullable: the per-page custom map exactly as Firebase stores it. It is a JSON object of at most 1024 bytes. Trigger `legal_acceptances_custom_summary` refuses a row whose `is_custom` differs from "some value in the map is `true`", including an `is_custom` of NULL when the map is present. See §10.2.
- `texts_json` is NOT NULL: a JSON object of at most 262144 **bytes**. The CHECK uses `length(CAST(texts_json AS BLOB))`, which counts bytes, not characters.
- `texts_sha256` is 64 lowercase hex characters.
- `user_agent` is at most 2048 characters. It is wider than 0031's 512 so imported evidence is not refused; Worker rows are cut to 512.
- `ip`; `source` in (`worker`, `import`).

Row CHECKs:
- `user_id IS NOT NULL OR legacy_uid IS NOT NULL`.
- An `import` row always has `legacy_uid`.
- A `worker` row is `type = 'legalPages'`, has a `user_id`, and has no `legacy_uid` and no `accepted_at_original`. New platform-terms acceptances therefore still go to the 0031 tables. Imported history may hold either type.

Triggers make the table append-only: no UPDATE, no DELETE. The index is `(tenant_id, type, accepted_at DESC, acceptance_id DESC)`.

**The size cap.** The three templates in `src/config/legalTemplates.js` are 14.2 KB of markdown. I rendered them with markdown-it: 16.9 KB as JSON strings. 256 KiB gives about 15 times headroom for pages the seller has edited, and is far under D1's 2 MB row limit. Firestore allowed up to 1 MiB per document; the importer should report any row over the cap rather than truncate it (currently 0 docs, manifest row 65).

**`platform_terms_texts`** holds the archived text of each version:
- Columns: `version` (PK, FK), `sha256`, `object_key`, `size_bytes` (1..262144), `archived_by` (FK to user), `archived_at`.
- The CHECK pins `object_key = 'platform/legal/terms/' || version || '/' || sha256 || '.txt'`. The key is content-addressed, so the bytes behind a key never change.
- Trigger `platform_terms_texts_hash_matches` refuses a row whose `sha256` differs from the version's own `sha256`.
- Append-only triggers.

**`platform_terms_versions_publish_order`** (new trigger on the 0031 table): a NEW version must have a `published_at` strictly after every existing row, scheduled ones included. A repeated insert of an existing label falls through to the PK, so `INSERT OR IGNORE` in `legal.test.ts` still behaves as before. The trigger also makes concurrent publishes race-safe.

## 2. Routes

Unchanged: `POST /v1/admin/legal/accept-terms` keeps the same behaviour, and now goes through the shared guard described in §4.

Every refusal below is the opaque `404 {"error":{"code":"not_found","message":"Route not found"}}` unless a status code is given.

### Tenant admin (`X-Shop-Id` + session, as before)

**`GET /v1/admin/legal/status`** always has this shape (round 1). Every earlier field is kept. An acting-as platform user may read it.
```
200 { accepted, acceptedAt, currentVersion,
      acceptedVersion: string | null, inGrace: boolean, graceDeadline: ISO | null,
      readiness: { returnAddress: boolean, vatAnswered: boolean, legalPagesAccepted: boolean, ready: boolean } }
```
- `acceptedVersion` is the latest version the shop accepted, or null if it never accepted one.
- `graceDeadline` is set when the shop accepted the immediately previous version. It stays set after it passes; `inGrace` then turns false.
- `readiness` holds the legal readiness gate's three conditions (§10.1), as booleans only. The address itself is never returned.

**`GET /v1/admin/legal/terms`** returns the CURRENT version only. An acting-as platform user may read it.
```
200 { version, sha256, publishedAt, textArchived: boolean, text: string | null }
    all null / false when no version is published
```
If no text is archived, the response says so with `textArchived: false, text: null`. A query string such as `?version=…` is ignored. If a text row exists but the bytes are missing or no longer hash to `sha256`, the route throws (500): that is an integrity fault, and the page is never served.

**`GET /v1/admin/legal/pages`**: an acting-as platform user may read it.
```
200 { acceptance: null | { acceptanceId, acceptedAt, templateVersion, version, textsSha256,
                           pageSha256: { <pageKey>: sha256 of that page's UTF-8 }, pod, custom,
                           customPages: { <pageKey>: boolean } | null,
                           source: "worker" | "import" } }
```
"Latest" means the highest `accepted_at`, then `acceptance_id`. `pod` and `custom` are `null` on imported rows that lack them. `customPages` is the stored `custom_json`, or null when only the summary flag was kept.

**`POST /v1/admin/legal/accept-pages`**: same-origin; the shop's OWN admin only.
```
body  { templateVersion: /^[0-9A-Za-z._-]{1,32}$/,
        texts: { kopvillkor, angerratt, integritetspolicy }   (exactly these keys, non-empty strings),
        pod: boolean,
        custom: boolean | { kopvillkor, angerratt, integritetspolicy: boolean } }   (no other keys)
201   { acceptance: { acceptanceId, acceptedAt, templateVersion, textsSha256, pod, custom,
                      customPages: map | null } }
400   invalid_request
413   { error: { code: "payload_too_large", message: "The texts exceed the maximum allowed size" } }
      canonical snapshot > 256 KiB, or body > 1 MiB (refused unread)
429   rate_limited + Retry-After   (more than 20 well-formed adoptions per shop in one fixed one-hour window)
404   acting-as platform user, another shop's admin, no session, cross-origin or no Origin
```
The Worker writes one row and its audit row (`legal.pages.accept`) in one batch:
- the time is the server clock;
- the email is read from the user row inside the INSERT;
- the IP comes from `CF-Connecting-IP` and the user agent from `User-Agent`;
- the texts are stored in canonical form with their sha256.

Every adoption is new evidence (Firebase used `addDoc`), so the shop's "acceptance" is its latest row.

### Platform session only

These routes refuse any request that carries `X-Shop-Id` (see Deviation 3). Writes are same-origin and audited, with `tenant_id NULL` and `resource_type 'platform_terms_version'`.

**`GET /v1/platform/legal/terms-versions`** lists versions newest first:
```
200 { versions: [{ version, publishedAt, sha256, textArchived, current }] }
```

**`POST /v1/platform/legal/terms-versions`**
```
body  { version, text, publishedAt? }   (publishedAt is ISO with milliseconds, UTC; default now; later = scheduled)
201   { version: { version, publishedAt, sha256, textArchived: true, current } }
409   { error: { code: "terms_version_exists", … } }
409   { error: { code: "terms_version_not_latest", … }, latestPublishedAt }
400   malformed body; a publishedAt in the past; an empty text; a text with a lone surrogate
413   text > 256 KiB
```
- The sha256 is taken over the text's UTF-8 bytes.
- The bytes are put to `PRIVATE_BUCKET` first, with R2 verifying the sha256. Then the version row, the text row and the audit row (`legal.platform_terms.publish`) go in one batch.
- If that batch fails, the object is left behind under its content-addressed key, and a retry rewrites the same bytes.

**`GET /v1/platform/legal/terms-versions/:version/text`**
```
200 { version, publishedAt, sha256, textArchived, text | null }
404 unknown version
```

**`PUT /v1/platform/legal/terms-versions/:version/text`**: attaches the text of an existing version, such as the 0031 seed.
```
body  { text }
201   archived
200   already archived
409   { error: { code: "terms_text_hash_mismatch", … }, expectedSha256, suppliedSha256 }
```
The version row is never touched, and the trigger re-checks the hash. It is audited as `legal.platform_terms.archive_text`.

When `PRIVATE_BUCKET` is unbound, the POST and both text routes answer 404 (fail closed). Methods these routes do not claim fall through to the ordinary 404 (`onMethods`).

**Attaching the real seed text (verified offline).** `JSON.stringify({ version, terms: PLATFORM_TERMS_TEMPLATE, dpa: PLATFORM_DPA_TEMPLATE })` of `src/config/platformTerms.js` hashes to the seeded `ca1f708f…0b91` (22,522 bytes). From the repo root:
```
node --input-type=module -e "import {PLATFORM_TERMS_VERSION as version, PLATFORM_TERMS_TEMPLATE as terms, PLATFORM_DPA_TEMPLATE as dpa} from './src/config/platformTerms.js'; process.stdout.write(JSON.stringify({ text: JSON.stringify({ version, terms, dpa }) }))" > seed-terms-body.json
```
Then send `PUT /v1/platform/legal/terms-versions/2026-09-07/text` with that body under a platform session.

## 3. The D47 grace rule (with D54)

Let C be the current version: the latest `published_at <= now`, ties broken by label.
```
open      ⇔  accepted C  OR  in grace
in grace  ⇔  NOT accepted C  AND  accepted P  AND  now < C.published_at + 14 days
```
- P is the version immediately before C in `(published_at, version)` order. The 0037 trigger makes that order strict for every new version.
- **The boundary is half-open, `[C.published_at, C.published_at + 14 d)`.** The instant `published_at + 14 days` is **outside**, so checkout is closed at that exact millisecond.
- 14 days is exactly 1,209,600,000 ms on the UTC timeline. No calendar or DST rule applies.
- Grace starts at C's publish instant, so there is no gap between P's acceptance and C's grace.
- A shop that never accepted gets no grace. So does a shop whose latest acceptance is two or more versions behind, even while the version it did accept is still inside its own 14 days (D54).
- `hasAcceptedCurrentTerms` keeps its strict meaning. The checkout calls `isTermsGateOpen`.
- D48 stands: the payment route does not re-check the gate.
- It is one D1 read (a CTE with correlated subqueries).

## 4. The canonical form for `texts_sha256`

```js
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeysDeep(v[k]);
    return o;
  }
  return v;
}
canonical = JSON.stringify(sortKeysDeep(value));      // ECMAScript JSON.stringify, no whitespace
texts_sha256 = sha256(UTF-8 bytes of canonical), lowercase hex
```
This is byte-for-byte `scripts/cf-port/migrate/lib/typed-json.mjs` `canonicalStringify`, so the importer can call it directly. Details another implementation must match:
- `.sort()` uses UTF-16 code-unit order.
- ECMAScript then emits integer-like keys (`"9"`, `"10"`) first, in ascending numeric order.
- Non-ASCII characters are written raw. `"`, `\` and control characters are escaped. Lone surrogates become `\udXXX`.

The Worker stores `texts_json` in this canonical form. The importer should do the same, so that `sha256(texts_json) = texts_sha256` holds on every row.

Known-answer vectors, computed with the importer's function under Node and pinned in `legal-pages.test.ts`:
- `LEGAL_TEXTS` in `test/legal-fixtures.ts` → `fa412aae365174b550bf7530c9625f7797cb2e9ff8bdc9c09b1ff1d26f412d11`.
- `{b:{d:1,c:[{z:1,y:2}]},a:"x","10":"t","9":"n"}` → `{"9":"n","10":"t","a":"x","b":{"c":[{"y":2,"z":1}],"d":1}}` → `a9d477f63076cf671582c858e0091d310cf70aeca57cd30ec028d6d99484e966`.

**Only the shop's own admin can accept.** `maySignForSeller(principal)` in `platform-terms.ts` is the one check. It is used by:
- `acceptPlatformTerms` and `acceptLegalPages`;
- the shared route guard `authorizeSellerSignature` (tenant admin + same-origin + `maySignForSeller`), which both accept routes use.

## 5. Deviations

1. ~~The status route's new keys are conditional.~~ **Superseded in round 1:** the keys are always present (§10.1).
2. **The archived terms text is not a `stored_objects` row.** That table requires a tenant (FK) and a key under `shops/{tenant}/` (CHECK). Every row in it is also reachable by its tenant through `/v1/admin/objects` (read, and soft-delete while mutable). Platform terms belong to no tenant, and the brief requires them to be reachable by no tenant route except `GET /v1/admin/legal/terms`. I followed the 0012 `pod/` precedent: the object sits in the private bucket under `platform/legal/terms/`, and its own append-only table pins the key by CHECK.
3. **"A platform user acting as a shop" on a platform route = a request that carries `X-Shop-Id`.** The brief requires the opaque 404 there. A platform user with an acting-as grant still holds a platform session, so the only thing that marks such a request is the shop header. Platform routes refuse any request that names a shop, before the session is read. No other platform route does this yet.
4. **The publish time must be strictly after the latest version.** The brief only refuses "earlier". An equal time would make "the immediately previous version" depend on the label's sort order. A `publishedAt` in the past is also refused (400), because it would retroactively change which version was current, and the grace deadlines with it.
5. **The texts body is strict.** It takes exactly the three Firebase page keys, as non-empty strings. Firebase could store `''` when rendering failed; an empty adopted page is refused here.
6. **Rate limit (not in the brief).** At most 20 well-formed adoptions per shop per hour. The evidence is permanent and up to 256 KiB per row, so a compromised admin session could otherwise grow D1 without bound. Malformed and oversized requests write nothing and are not counted.
7. ~~`custom` is a boolean.~~ **Superseded in round 1:** the per-page map is kept in `custom_json` (§10.2).

## 6. Reviewer wiring

- **`REQUIRED_MIGRATION`**: bump it to the CP3 head at consolidation. 0037 is additive and needs no data step.
- **No new binding or variable.** `PRIVATE_BUCKET` is already bound on staging and production (`wrangler.jsonc`) and in the test pool.
- **After deploy (optional):** attach the seed's text on staging with the command in §2, so that `GET /v1/admin/legal/terms` shows the seller the text it is asked to accept.
- The round-0 note about `provision-tenants.test.ts` and `provision-users.test.ts` no longer applies: both pass in the round-1 full run. For the current failures outside my files, see §10.6.

## 7. Open questions (answered in review round 1)

1. **Imported `platformTerms` rows do not open the gate.** Confirmed; sellers accept on the new system.
2. **Text format of a terms version.** The JSON wrapper `{ version, terms, dpa }` around the markdown, as the seed has it, until the admin UI checkpoint decides how it is displayed.
3. **The per-page custom map** is now kept (§10.2).
4. **`pod` from the request body** stays for now.
5. **The Worker trusts the client's rendering**, as Firebase did. Accepted.
6. **IP retention** for both acceptance tables (`platform_terms_acceptances.ip`, `legal_acceptances.ip`) is **still open, for the data-protection review.**
7. **The readiness gate** is built (§10.1).

## 8. What was not done or not tested

- **The size cap was only run locally.** D1 in production caps SQL statement text at 100 KB, and I believe bound values are not counted against it, but the ~256 KiB bind has only run in miniflare. Staging should post one near-cap acceptance.
- **The R2 put with `sha256` verification runs only against the miniflare bucket.**
- **Not tested: a racing publish reaching the batch-level catch.** That path, which maps a PK or trigger failure after the pre-checks, is covered by the trigger test only, not by a real race.
- **Not tested: the 500 on an archived text whose bytes are missing or no longer hash correctly.** No test deletes or corrupts the R2 object.

## 9. Test output (round 0; the current numbers are in §10.6)

Mutation checks were run and reverted, each confirmed failing then passing:
- an inclusive boundary (`<=`) fails the two boundary tests;
- grace for any older acceptance (dropping D54) fails four grace tests;
- dropping the `X-Shop-Id` refusal fails the platform-route test;
- dropping `maySignForSeller` from the pages path fails the acting-as test.

The suites the brief names (`legal`, `legal-pages`, `legal-grace`, `checkout`, `payment`, `test/slice/`):
```
 Test Files  7 passed (7)
      Tests  317 passed (317)
```
`npx tsc --noEmit`: exit 0 (whole tree, other builders' work included, at the time of the run).

Full `npx vitest run` with every builder's work in the tree (migrations 0032–0038 present):
```
 Test Files  2 failed | 59 passed (61)
      Tests  2 failed | 2049 passed (2051)
```
The 2 failures are the CP3-A/B items in §6, not this work. CP3-E's share is **+18 tests in +2 files**: `legal-grace.test.ts` has 11 and `legal-pages.test.ts` has 7. `legal.test.ts` is unchanged at 13, all passing.

`node guard/guards.test.mjs`: `guard: PASS`. The guard scans tracked files only, so my new files are not in its list until they are committed. A manual grep of all my files for the guard's patterns is clean.

## 10. Review round 1

The rulings accepted deviations 2–6. Changes 1 and 2 and the readiness gate follow. Same hard rules as before: no git writes, no network, only my own files.

### 10.1 The legal readiness gate and the status shape (Change 1 + follow-up)

**The gate.** `src/legal/legal-pages.ts` exports:
- `readLegalReadiness(db, tenantId)` → `{ returnAddress, vatAnswered, legalPagesAccepted, ready }`. It is one D1 read: `tenant_settings` from builder A's migration 0032 (read only), plus EXISTS over `legal_acceptances`.
- `isLegallyReady(db, tenantId)` → `ready`.

This ports Firebase `createPaymentIntent.ts` `legalCheckoutBlockReason`, the server-side mirror of `legalPageReadiness.js` `getLegalReadiness`'s HARD blockers. A shop takes a checkout only when all three hold:

| condition | Worker | Firebase |
|---|---|---|
| `returnAddress` | `tenant_settings.return_address`, JavaScript `.trim()` non-empty | `String(returnAddress \|\| '').trim()` |
| `vatAnswered` | `vat_registered` is 0 or 1 | `typeof vatRegistered === 'boolean'` |
| `legalPagesAccepted` | any `legalPages` row (Worker or imported) | `legal.acceptance.acceptedAt` non-empty. Every row here has `accepted_at NOT NULL`. |

No `tenant_settings` row means nothing is answered, so the gate is closed.

**One deviation from the SQL in the ruling.** The ruling suggested `trim(return_address) <> ''`. SQLite's `trim()` strips only the space character. Firebase used JavaScript's `trim()`, which strips every Unicode space and line break (tab, newline, no-break space, em space…). The address is therefore read and trimmed in JavaScript, so an imported `" \n\t  "` counts as missing, exactly as in Firebase. A test pins this, and a mutation to a space-only trim fails it.

**What Firebase also computes but does not block on, so it is not ported as a gate:**
- `needsReacceptance`: template-version drift, and seller-edited text after the acceptance. Firebase's comment: "a template bump must never close checkout".
- The softer identity gaps (`missing`): legal name, address, support email (including `@example.*` placeholders), seller type, org number for companies, VAT number for VAT-registered sellers.

These are admin and platform badges, not checkout blockers. Most have homes in `tenant_settings` or its identity JSON, but they are not part of this gate.

`shopCheckoutBlockReason` (shop disabled, `published === false`) is Firebase's other server gate. It is not a legal condition, and it already has Worker equivalents: tenant status in tenant resolution, and the live gate in catalogue eligibility (D57). Nothing was added for it here.

**Checkout.** In `createCheckout`, the second condition sits next to the terms gate, in the same place, with the same opaque `not_found`, before any line is resolved:
```ts
if (!(await isTermsGateOpen(db, tenant.tenantId, now)) || !(await isLegallyReady(db, tenant.tenantId))) {
  return { status: "not_found" };
}
```
Nothing else in `checkout.ts` changed. D48 stands: the payment route does not re-check.

**`GET /v1/admin/legal/status`** now always has this shape:
```
{ accepted, acceptedAt, acceptedVersion, currentVersion, graceDeadline, inGrace,
  readiness: { legalPagesAccepted, ready, returnAddress, vatAnswered } }
```
It carries booleans only; a test asserts the address text never appears in the body. An acting-as platform user can read it, and a test asserts it gets the same body as the seller. In `legal.test.ts` the two exact-match assertions gained `acceptedVersion`, `graceDeadline`, `inGrace` and `readiness`. Its shops are made legally ready in `beforeAll`, so every 404 there is still the terms gate's.

### 10.2 The per-page custom map (Change 2)

- **0037, rewritten in one write, still additive.** It adds `custom_json TEXT NULL` with `CHECK (json_valid AND json_type = 'object' AND ≤ 1024 bytes)`. It also adds trigger `legal_acceptances_custom_summary`: when `custom_json` is present, `is_custom` must equal "some value in the map is `true`". A CHECK cannot hold this, because SQLite forbids subqueries in CHECKs.
- **The Firebase shape.** `storeIdentity.legal.custom` is `{ <pageKey>: boolean }`, written one key at a time as the seller takes over or gives back a page (`AdminSettings.jsx` `persistLegal`). The map may therefore hold any subset of `kopvillkor`, `angerratt` and `integritetspolicy`, and `{}` is possible. The column accepts any object, so the importer can store the Firestore map verbatim; storing it canonically is recommended. Set `is_custom` to 1 if any value is `true`, else 0.
- **Worker rows.** `custom` in `POST /v1/admin/legal/accept-pages` is either a boolean, as before, or a map with exactly the three page keys and boolean values. A map is stored canonically in `custom_json`, and `custom` / `is_custom` is derived from it. A boolean leaves `custom_json` NULL.
- **Where it shows.** Both the POST response and `GET /v1/admin/legal/pages` carry `customPages` (the map or null).

### 10.3 How the other suites got past the gate: one helper, extended

In CP2-E, `test/legal-fixtures.ts` `acceptTermsStatement(db, tenantId)` got suites past the terms gate. It is one prepared statement, and every caller puts it inside its own `db.batch([...])`:

| caller | line |
|---|---|
| `test/checkout.test.ts` | 73 (seed) and 1916 (`.run()` in the gated-shop test) |
| `test/discount-codes.test.ts` | 77 |
| `test/admin-discount-codes.test.ts` | 117 |
| `test/admin-catalog.test.ts` | 122 |
| `test/pod-fixtures.ts` `seedTenant` | 101, used by `money-followups`, `pod-publish`, `pod-mappings`, `screening`, `print-defaults` and `printers-platform` |

One D1 statement writes one table, so the helper cannot grow three more inserts without editing every caller.

**How it was extended without touching any caller.** Importing `legal-fixtures.ts` registers a file-level `beforeAll`. It runs after the setup file's migrations and before the suite's own hooks. It installs a **test-only** trigger, `test_fixture_legal_readiness`, in that file's database only; no migration carries it. The trigger is AFTER INSERT on `platform_terms_acceptances` and fires only when the row is the helper's own (`id = 'seed-terms-' || tenant_id`). It adds:
- an invented seller user (`seed-seller-<tenant>`, "Test Seller", `seed-seller+<tenant>@example.com`);
- a `tenant_settings` row with a return address and `vat_registered = 1`;
- a `source = 'worker'` legal-pages acceptance by that user.

The suites that go through the helper pass unedited: `checkout`, `discount-codes`, `admin-discount-codes`, `admin-catalog`, `pod-publish` and `money-followups`, 452 tests in one run. That includes `checkout.test.ts:1916`, whose gated shop becomes ready at the moment it accepts. As proof, disabling the trigger's condition fails 98 of `checkout.test.ts`'s 199 tests.

For my own route-built shops, `legal-fixtures.ts` also exports explicit statements: `readySettingsStatement`, `pagesAcceptanceStatement`, `legalReadinessStatements`.

**Not considered.** Suites that count users or touch `tenant_settings` (`provision-users`, `bootstrap`, `admin-settings`) do not import these fixtures, so the extra rows never reach them.

### 10.4 Suites that do NOT go through the helper (for you at consolidation; not edited)

Only the slice suites, which build shops through the real routes via `test/slice-harness.ts` `createTenant`:

- **`test/slice-harness.ts` lines 349–351**, inside `createTenant`, after `await acceptPlatformTerms(world, tenant);`: the shop must also be made legally ready through the routes. `failure-injection.test.ts`'s 36 failures all come from this one place: its shops are created at lines 84–85, and every failure is `checkout: {"error":{"code":"not_found",…}}: expected 404 to be 201`. Suggested change, with the same two routes the seed script needs (§10.5):
  ```ts
  // after acceptPlatformTerms (or behind a `legallyReady?: boolean` spec flag, default true):
  await expectJson(await adminCall(world, tenant, "PUT", "/v1/admin/settings",
    { returnAddress: "Testgatan 1, 123 45 Teststad", vatRegistered: true }), 200, "settings");
  await expectJson(await adminCall(world, tenant, "POST", "/v1/admin/legal/accept-pages", {
    custom: false, pod: false, templateVersion: "2026-09-07",
    texts: { angerratt: "<p>Ångerrätt</p>", integritetspolicy: "<p>Integritet</p>", kopvillkor: "<p>Köpvillkor</p>" },
  }), 201, "legal pages");
  ```
  Builder A already has exactly this as `makeLegallyReady(world, tenant)` in `test/tenant-fixtures.ts:182`. The harness cannot import it, because `tenant-fixtures` imports the harness, so the two calls must be inlined.
- **`test/slice/vertical-slice.test.ts`.** Its tenant is created with `acceptTerms: false` at line 102.
  - Lines 190 and 213 are the two exact-match status assertions. Each needs `acceptedVersion` (null / `"2026-09-07"`), `graceDeadline: null`, `inGrace: false` and `readiness: {…}`.
  - Step 12a should make the shop legally ready (the two calls above) before the checkout at line 239. If the harness does it inside `createTenant`, it happens automatically, and `readiness` at line 190 is then all true.

In the clean full run, no other suite fails because of the gate. `platform-tenants.test.ts` (A) already calls its own `makeLegallyReady`.

### 10.5 What the staging seed script must do (`scripts/cf-port/seed-staging-slice.mjs`, not mine)

After `ensureTermsAccepted()` and before `--purchase`, with the same slice tenant admin session (`slice-admin+<tenant>@example.com`, cookie + `X-Shop-Id` + same-origin `Origin`), as the script already does for `accept-terms`:

1. **`PUT /v1/admin/settings`** (A's route) with body `{ "returnAddress": "<a return address, 1–1000 chars>", "vatRegistered": true | false }`.
   - Answer 200 `{ settings: { …, returnAddress, vatRegistered } }`.
   - A's route also admits an acting-as platform user, so this step could run under the platform session. Using the seller's own session is simpler.
   - `""` or whitespace clears the address, and `null` means "not answered". Neither opens the gate.
2. **`POST /v1/admin/legal/accept-pages`** as the SELLER's own admin. An acting-as platform user gets 404 here by design. Body:
   ```json
   { "templateVersion": "2026-09-07",
     "texts": { "kopvillkor": "<html>", "angerratt": "<html>", "integritetspolicy": "<html>" },
     "pod": true, "custom": false }
   ```
   - Answer 201 `{ acceptance: { acceptanceId, … } }`.
   - `texts`: exactly the three keys, non-empty strings, at most 256 KiB canonical in total. These are what the seller adopts. Until CP4 renders the templates in the Worker, the script supplies them. For the staging slice tenant, the markdown of the three templates in `src/config/legalTemplates.js` or short placeholder HTML is enough.
   - `pod: true` because the slice shop sells a POD tee.
   - Each call appends new evidence, and there is a limit of 20 per shop per hour. The script should skip this step when step 3 already reports `legalPagesAccepted: true`.
3. **`GET /v1/admin/legal/status`** must show `readiness.ready === true` (and `accepted` or `inGrace`) before the checkout. Otherwise the checkout answers the opaque 404, and `die()` should name the false `readiness` fields.

The acting-as platform session can read step 3 as well, so the script can check readiness first and only sign in the seller when something is missing, as it already does for the terms.

### 10.6 Tests and output

- `test/legal-pages.test.ts` has **13** tests (+6):
  - custom map;
  - five readiness tests: routes-only path to ready; each condition missing alone gives the opaque 404, byte-equal to an unknown shop's; whitespace address via the route and as an imported row; the status carries booleans only and acting-as can read it; no settings row.
- `test/legal-grace.test.ts`: **11** tests, all shops legally ready, status assertions in the fixed shape.
- `test/legal.test.ts`: **13** tests.
- Together: **37 passed**.

**Mutation checks this round**, each reverted and re-run green:
- removing `isLegallyReady` from checkout fails 4 readiness tests;
- a space-only trim fails the whitespace test;
- disabling the fixture trigger fails 98 tests in `checkout.test.ts`.

`npx tsc --noEmit`: **exit 0**. It was run over the whole tree twice. The first run briefly showed `test/connect-onboarding.test.ts(732,59): error TS2304: Cannot find name 'startedAt'`, which is CP3-F's file while they were editing it; the later run was clean.

**Full `npx vitest run`**, the last clean run, alone, started 17:42:08:
```
 Test Files  2 failed | 67 passed (69)
      Tests  37 failed | 2348 passed (2385)
```
The 37 failures are all outside my files, and both were expected by the ruling:
- `test/slice/failure-injection.test.ts`: 36 × `AssertionError: checkout: {"error":{"code":"not_found","message":"Checkout not found"}}: expected 404 to be 201`. The harness shop is not legally ready (§10.4).
- `test/slice/vertical-slice.test.ts`: 1 × `AssertionError: expected { accepted: false, …(6) } to deeply equal { accepted: false, …(2) }` at line 190, the status shape (§10.4).

**Discarded run.** An earlier full run's output file held two interleaved runs (another process was running vitest at the same time). The extra failures in it, in `invites`, `receipts`, `refunds`, `render-jobs`, `user-lifecycle` and one `legal.test.ts` test, were all `Test timed out in 5000ms` or `Hook timed out in 10000ms` under load. None of them appears in the clean run above, and `legal.test.ts` passes alone and in the clean run.

**Guard.** `node guard/guards.test.mjs` passed in round 0. This round's files were grepped for the guard's patterns and are clean.
