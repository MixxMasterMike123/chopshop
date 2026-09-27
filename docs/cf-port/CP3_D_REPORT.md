# CP3-D report: platform settings and trust & safety

Builder: CP3-D. Branch `cf-port`, working tree only (nothing committed). Scope: `CP3_GAP_ANALYSIS.md` §1d (settings) and §1f (reports queue), DECISIONS D8, D9, D36, D45, D58.

**Status: done and tested locally.** Nothing was deployed, no `wrangler`, no network. Two things are not wired and need the reviewer: the cron call for the re-screen sweep, and the `REQUIRED_MIGRATION` bump (see "Reviewer wiring").

---

## 1. Files

| File | |
|---|---|
| `cloudflare/migrations/0034_platform_settings.sql` | new |
| `cloudflare/migrations/0036_infringement_reports.sql` | new |
| `cloudflare/src/platform/platform-settings.ts` | new: settings read/patch, the payment path's reader |
| `cloudflare/src/catalog/infringement-reports.ts` | new: intake, queue, handling, takedown-with-report |
| `cloudflare/src/routes/platform-settings.ts` | new: settings + screening-term routes, the shared platform guard |
| `cloudflare/src/routes/platform-reports.ts` | new: platform report routes |
| `cloudflare/src/routes/storefront-reports.ts` | new: `POST /v1/reports` |
| `cloudflare/src/catalog/screening-core.ts` | extended: one term/text normalisation, `isHardBlock`, the SQL match list, N as a parameter |
| `cloudflare/src/catalog/screening.ts` | extended: settings-driven verdicts, stored screened text, terms fence, term CRUD, same-batch safety check, sweep, `decideByPlatform` report link |
| `cloudflare/src/commerce/payment.ts` | the one call site (+ its import) and the `DEFAULT_COMMISSION_BPS` comment |
| `cloudflare/src/app.ts` | only inside `CP3-IMPORTS-D` and `CP3-ROUTES-D` |
| `cloudflare/test/platform-settings.test.ts`, `screening-settings.test.ts`, `infringement-reports.test.ts` | new |
| `cloudflare/test/screening.test.ts` | 2 tests appended; no existing assertion changed |

Nothing in `wrangler.jsonc`, `env.d.ts`, `worker-configuration.d.ts`, `vitest.config.ts`, `test/env.d.ts`, `package.json` or `REQUIRED_MIGRATION` was touched. No new binding or variable is needed.

---

## 2. Migrations

### 0034_platform_settings.sql

- **`platform_settings`**: one row (`id INTEGER PRIMARY KEY CHECK (id = 1)`, the `platform_state` pattern), seeded by the migration.

  | column | default | CHECK |
  |---|---|---|
  | `default_commission_bps` | 500 | 0..10000 (like `tenants.commission_bps`; the route allows 0..800, see §7) |
  | `refund_application_fee` | 0 | `= 0` (pinned, D9/D36) |
  | `reverse_dispute_on_created` | 1 | 0/1 |
  | `review_first_products` | 2 | 0..100 |
  | `screening_hard_block` | 0 | 0/1 |
  | `screening_terms_version` | 1 | ≥ 1, forward-only trigger (`platform_settings_terms_version_forward`, message `screening terms changed`) |
  | `updated_at` | seed time | ISO round-trip |
  | `updated_by` | NULL | FK `"user"(id)` |

  No delete-protection trigger, on purpose: the brief asks for a fallback when the row is absent, and the readers handle that (defaults; commission falls back to 500).
- **`content_screening_terms.note`**: `ADD COLUMN`, nullable, `length(note) <= 500` (so '' is allowed and an importer can carry Firebase's empty notes verbatim).
- **`product_screening`**: `ADD COLUMN screened_tokens`, `screened_raw` (≤ 65 536 chars each) and `terms_version`. These store the text a verdict was computed from and the term-set version it was computed under (§4).
- Two triggers, `product_screening_terms_current_insert` and `product_screening_terms_current_update` (the latter `BEFORE UPDATE OF terms_version`), abort with `screening terms changed` when a verdict is stamped with a version other than the current one. If the settings row is absent they are inert.
- Index `product_screening_terms_version_idx (terms_version, updated_at)` for the sweep.

### 0036_infringement_reports.sql

Columns follow the schema contract exactly: `report_id`, `tenant_id`, `product_id`, `product_name`, `product_url`, `reporter_name`, `reporter_org`, `reporter_email`, `right_type`, `description`, `attestation`, `status`, `source`, `note`, `handled_by`, `handled_by_legacy_uid`, `created_at`, `handled_at`. There is one additive column, `version` (DEFAULT 1), used for optimistic concurrency.

- Values are taken from the Firebase writer: `right_type IN ('trademark','copyright','other')` and `source IN ('storefront')` (the only value Firebase writes). `status IN ('new','reviewing','rejected','taken_down')`. `attestation = 1`. The description is 20..5000 characters (Firebase's minimum). Every text column has a length cap. `report_id` is `[A-Za-z0-9_-]{1,128}`, which covers both UUIDs and Firestore ids.
- `product_id NOT NULL` with FK RESTRICT to `products`. `handled_by` has FK RESTRICT to `"user"`. `tenant_id` has FK to tenants.
- CHECKs:
  - `new` ⇒ no handler and no `handled_at`.
  - `rejected`/`taken_down` ⇒ `handled_at` is set.
  - `handled_by` and `handled_by_legacy_uid` are never both set.
  - `handled_at >= created_at`.
- Triggers:
  - `…_tenant_matches_product`: the report's shop must equal the product's shop.
  - `…_facts_immutable`: reporter data, product, shop, source and `created_at` cannot change.
  - `…_status_transition`: enforces the transition table in §6.
  - `…_version_monotonic`.
  - `…_no_delete`: reports are evidence.
- Indexes: `(created_at DESC, report_id DESC)`, `(status, …)`, `(tenant_id, …)`, `(product_id)`.

---

## 3. Routes

**Guard for every platform route (`authorizePlatformSurface`):** anyone else gets the opaque 404 `{"error":{"code":"not_found","message":"Route not found"}}`. That covers no session, a tenant admin, a print operator, and **any request carrying `X-Shop-Id`**, which includes a platform user acting as a shop (see deviation 1). GETs need no Origin. Every state change must be same-origin; a cross-origin or Origin-less one gets the same 404, the way the existing routes refuse it. All routes are mounted in `CP3-ROUTES-D` as exact paths wrapped in `onMethods`.

| Method + path | Request | Response |
|---|---|---|
| `GET /v1/platform/settings` | none | `200 {settings:{defaultCommissionBps, refundApplicationFee, reverseDisputeOnCreated, reviewFirstProducts, screeningHardBlock, screeningTermsVersion, updatedAt, updatedBy}}` |
| `PATCH /v1/platform/settings` | `{defaultCommissionBps?: 0..800, reviewFirstProducts?: 0..100, screeningHardBlock?: bool}`, at least one | `200 {settings, rescreen: null \| {blockedNow, pending, unverified}}`. `400 {error:{code:"setting_not_editable", field, message}}` when the body names `refundApplicationFee` or `reverseDisputeOnCreated`. `400 {error:{code:"invalid_request", field, message}}` for a range, type or unknown key. `409 conflict` after two lost version races. Audited `platform_settings.update` (tenant NULL, `{field:{before,after}}`). |
| `GET /v1/platform/screening-terms?cursor=<termKey>&limit=1..500` | none | `200 {terms:[{term, termKey, kind, hardBlock, note, createdAt}], nextCursor, termsVersion}`, in term order |
| `POST /v1/platform/screening-terms` | `{term, kind?: band\|brand\|club\|other (default other), hardBlock?: false, note?: string\|null}` | `201 {term, rescreen:{blockedNow, pending, unverified}}`. `409 duplicate_term` (the same term by the matcher's key, including an imported raw spelling). `409 term_limit` at 2000 terms. `400` for a malformed body or a term that can never match. |
| `PATCH /v1/platform/screening-terms/:termKey` | `{kind?, hardBlock?, note?}`, no rename | `200 {term, rescreen}`, `404`, `400` |
| `DELETE /v1/platform/screening-terms/:termKey` | none | `200 {deleted:true, rescreen}`, `404` |
| `POST /v1/platform/screening-terms/rescreen` | none | `200 {rescreened, pending, unverified}` (at most 25 products per call) |
| `GET /v1/platform/reports?status&tenantId&cursor&limit=1..100` | none | `200 {reports:[PlatformReportView], nextCursor, newCount}`, newest first. `newCount` counts every shop's `new` reports whatever the filter (the nav badge). |
| `GET /v1/platform/reports/:reportId` | none | `200 {report}`, `404` |
| `POST /v1/platform/reports/:reportId/handle` | `{status:"reviewing"\|"rejected", note?: string\|null}` | `200 {report}`, `409 transition_refused \| conflict`, `404`, `400` |
| `POST /v1/platform/reports/:reportId/takedown` | `{note?: string\|null, productId?: string}` | `200 {report, screening}`, `409 report_closed \| product_mismatch \| tenant_mismatch \| conflict`, `404`, `400` |
| `POST /v1/reports` (storefront, inside `storefront(...)`) | see §5 | `201 {report:{reportId}}` / `400` / `404` / `429` |

`PlatformReportView` fields: `reportId, tenantId, productId, productName, productUrl, productTakenDown` (the product's current state), `reporterName, reporterOrg, reporterEmail, rightType, description, attestation, status, source, note, handledBy, handledByLegacyUid, handledAt, createdAt, version`. These platform views are the **only** responses that carry reporter data.

**How a term is addressed in a URL.** `:termKey` is the base64url (unpadded) of the stored term's UTF-8 bytes. Every term view carries it as `termKey`. The table has no surrogate id: `term` is its primary key and the natural key the importer uses (manifest row 72). A term can legally contain `/`, `%`, `?`, spaces and non-ASCII (the Firebase list has one with `/`). The shared `decodeSegment` deliberately refuses a decoded `/`, and anything else would need a second percent-decoding rule. base64url is one `[A-Za-z0-9_-]` segment and reversible. `termFromKey` accepts only the canonical encoding, so each term has exactly one URL. No schema change was needed.

---

## 4. Screening: settings, normalisation, re-screening on a term change

**Settings wired into the screening path.**
- `review_first_products` replaces the constant N; `REVIEW_FIRST_PRODUCTS = 2` remains only as the fallback when the row is absent. `overlayDecision` takes N as a parameter, defaulting to 2 so the existing callers are unchanged.
- The global `screening_hard_block` is applied as in Firebase: `hardBlock = hits.length > 0 && (settings.hardBlock || some hit is hard)` (`isHardBlock`).

**Normalisation.** There is one implementation, in `screening-core.ts`:
- `termMatch(term)` is what `findScreeningHits` now uses internally, with no change in behaviour: all 21 cases of the Firebase parity table still pass.
- `screeningHaystacks(texts)` produces exactly the strings product text is matched in.
- `normalizeScreeningTerm` stores a word term as its tokenized form (`"  Glimmer-KRAFT "` → `"glimmer kraft"`) and a symbol term as trimmed NFC.
- It refuses a term that can never match: letters that all fold away, such as a term written only in a non-Latin script, which the matcher silently ignores today. It also refuses control characters, and anything longer than 200 characters after NFKD.
- Duplicates are refused by the matcher's key, so an imported raw `"Dräkkenhölm"` blocks a later `"drakkenholm"`.

**Re-screening design (PLAN §2.4).** Every term add, change of `hardBlock`, or delete, and every switch of the global hard block, commits **one batch**:

1. `screening_terms_version` moves to `<read> + 1`. A concurrent change trips the forward-only trigger; the change is re-planned once from fresh reads, and a second trip answers 409.
2. **Safety.** One `UPDATE … RETURNING` blocks every **live** product (published and active, shop status ignored so a suspended shop cannot come back with it public) that has stored text, is public now (`advisory`/`flagged`/`approved`), and that the new term set hard-blocks. Hits and earlier hits are written exactly as the machine would write them. An `approved` row is blocked only if a matching term is new to it (not in hits ∪ earlier hits), which is Firebase's "cleared sticks" rule. Matching runs in SQL (`instr` on the stored haystacks), against a JSON list built in JS by the same `termMatch`, deduplicated by key in blocklist order exactly as `findScreeningHits` does. There is no loop in the Worker.
3. **Fast-forward.** A verdict computed under the old version is stamped with the new one when its stored text yields the same hit set and the machine's unchanged-input branch would write nothing. This keeps the sweep's work to the products the change actually moved.
4. An audit row.

Everything else stays **stale** (`terms_version` below the current version, or NULL). `rescreenStaleScreenings` re-runs the full machine (`screeningStatementsFor`, fenced and retried like a seller edit) on at most 25 live stale products per call: NULL first, then the oldest. It runs from `POST /v1/platform/screening-terms/rescreen` and, once wired, from the 15-minute cron.

**The terms fence.** Every machine verdict records `screened_tokens`, `screened_raw` and `terms_version`, including the "nothing changes" verdict, which now refreshes the stored text instead of only bumping the version. It reads the settings version **before** the term list. If a term change commits between a product mutation's reads and its batch, the verdict carries a stale version, the 0034 triggers abort the whole batch, and `withScreeningRetry` re-runs it: `isScreeningConflict` now also matches `screening terms changed`. Without this, an edit computed without the new term could commit after the safety step had checked the old text. This race is tested.

**Why a product the new set hard-blocks cannot stay public:**
- Rows with stored text are blocked in the change's own batch.
- A concurrent mutation cannot land a stale verdict.
- A later mutation or publish screens with the new set.

**Limits (measured, not hidden):**
- **A row without stored text** cannot be checked in SQL. This covers rows written before 0034 (the staging slice products) and a platform decision on a never-screened product. Such a row stays public until the sweep screens it, and the sweep takes NULL rows first. Every term-change answer counts these in `unverified`.
- **A live product with no screening row at all** (fixtures, a future import) is outside this path. The eligibility predicate admits it as advisory, and the sweep does not screen it, because a first screening would apply D8 and could hide an imported product. It is counted in `unverified`, and a test pins this gap. The CP4 product import must write screening rows (see wiring).
- Effects that do not block (a new advisory flag, an un-block after a term is removed) wait for the sweep. Until it runs, the platform queue lags. Public visibility is only ever too strict, never too loose: a removed term leaves a block in place until the sweep turns it into `flagged`.
- Non-live products are not checked; their next publish screens them (the Firebase `isLive` rule).
- The safety statement costs about (live products × terms) `instr` calls inside one D1 statement. That is trivial at 63 terms and a few hundred products; a very large blocklist times a very large catalogue could approach D1's statement time limit.
- Switching the global hard block **off** does not lift the blocks it caused. The machine keeps `blocked` while the hit set is unchanged (Firebase does the same, but Firebase had also deactivated the product). Reinstating one is a platform approval. See open question 2.
- Lowering `review_first_products` does not release products already pending: `requires_approval` is decided once, at first screening (tested).

---

## 5. Intake `POST /v1/reports`: exact behaviour

Order of checks:
1. Method POST only; others fall through to the 404.
2. Tenant from the verified hostname. An unknown or inactive host gets 404 `Route not found`.
3. Per-IP limiter, **before the body is read**: scope `report-ip`, 5 per hour (Firebase's value). Every attempt counts, refused ones included. The 6th gets `429 {"error":{"code":"rate_limited","message":"Too many requests"}}` plus `Retry-After`.
4. Body parse.
5. Product lookup `WHERE tenant_id = <host's shop> AND product_id = ?`: one indexed read, the same for an unknown product and another shop's.
6. One batch: the report row and the alert row.

There are no session or same-origin checks, as for checkout: this is an anonymous surface.

| Case | Answer | Writes |
|---|---|---|
| valid | `201 {"report":{"reportId":"<uuid>"}}`, the case reference only (Firebase returns it too) | report + alert |
| honeypot `website` non-empty | `400 {"error":{"code":"invalid_request","message":"Request is not valid"}}` | nothing |
| product of another shop | identical 400 (same body, same headers) | nothing |
| unknown product id | identical 400 | nothing |
| attestation missing, false or non-boolean | identical 400 | nothing |
| malformed field, over-long field, unknown key, non-object body | identical 400 | nothing |

In Firebase, a filled honeypot throws `invalid-argument`, and an unresolvable product (unknown or another shop's, indistinguishable from each other) is **stored** with `productId: null`. Cloudflare requires the product (`product_id NOT NULL`, the brief's intake contract), so it refuses instead of storing an unresolved report, and it folds all three cases into the generic 400. A caller therefore cannot tell honeypot, unknown and foreign apart, nor any of them from a typo. Any product of the shop is accepted, whatever its state (Firebase parity). Product ids are random, so this is no useful existence oracle.

- **IP handling:** the IP is used only as the limiter key, which `rate-limit.ts` stores hashed with the scope. It is never on the report; the tests assert that neither the report nor `rate_limit_windows` contains the raw IP.
- **Alert:** kind `infringement_report_received`, severity `warning`, resource `infringement_report/<id>`, the shop's `tenant_id`. The message is `infringement report <id> for shop <tenant> (product <id>) awaits review`: ids only. The existing digest renders it generically (verified with `readDigestContent`). Handling or taking down the report resolves its alert in the same batch.

---

## 6. Handling and takedown

**Transitions** (enforced in code and by the 0036 trigger). Moving a report to its own status is refused (409).

| From | Allowed to |
|---|---|
| `new` | `reviewing`, `rejected`, `taken_down` |
| `reviewing` | `rejected`, `taken_down` |
| `rejected` | `reviewing` (Firebase "Öppna igen": rejected is **not** final) |
| `taken_down` | nothing; **final** |

- **Handle.** Status, note (replaced when given, kept when absent), handler and time, an audit row `report.<status>` (tenant = the report's shop, `reason` = note, metadata `{from,to}`) and the alert's resolution go into one batch. The write targets `<read version> + 1`, so a concurrent handler gets a 409 instead of overwriting (tested with an interleaved write).
- **Takedown with report.** This calls `decideByPlatform(db, principal, report.product_id, "blocked", now, {reportId, note, statements})`. The existing takedown (screening row `blocked`/`takedown`, `products.takedown_at`, its audit row, which now carries `reportId`, `source` and `reason = note`) and the report's statements (report → `taken_down` with handler and time, the `report.taken_down` audit row, the alert's resolution) are **one `db.batch`**.
- **Refusals.** A closed report gets 409 `report_closed`. A body `productId` other than the report's gets 409 `product_mismatch`, and the realistic attack of naming another shop's product lands here. A product whose shop is not the report's gets 409 `tenant_mismatch`. That last case cannot be stored while 0036's trigger stands; it is tested by dropping the trigger. In the batch itself, the report UPDATE sets `version` to 0 unless the report still names this product of this product's shop, and otherwise to `<read>+1`. Either a mismatch or a concurrent change therefore aborts the whole batch, and the product is not taken down.
- **Tests:**
  - An injected failing last statement leaves the product, its screening row, the report, the alert and the audit trail byte-identical, with exactly one `batch()` call.
  - A report rejected between the takedown's read and its batch gets 409, and the product stays up.
  - After a successful takedown, the next `GET /v1/products/:id` on the storefront is 404 and `catalog_version` has moved.
  - Reinstating via `decideByPlatform(…, "approved")` makes the product public again, and its reports stay `taken_down`.

**Reporter data** appears only in the platform report views. The tests walk the reported shop's admin PATCH response, `/v1/products`, `/v1/products/:id`, `/v1/storefront`, the shop's screening rows, the tenant admin's 404s on every report route, and the alerts. They check both keys and values; none of these carries reporter data. The platform alert list also carries none. `screening.ts` exposes nothing new to tenants: `loadScreeningStatus` and the admin catalog select only `status`, and the new columns are never selected into a tenant response.

---

## 7. Platform settings and the payment path

- **Commission.** `payment.ts` now computes `resolveCommissionBps(account.commission_bps, (await readDefaultCommissionBps(db)) ?? DEFAULT_COMMISSION_BPS)`. A shop's own value wins, including an explicit 0. With the row absent the fallback is 500. All three cases are tested.
- **What freezes the commission (a finding).** CP2 freezes the fee when the **PaymentIntent** is created (`attachPaymentIntent` writes `checkouts.application_fee_minor`, and a CP2 trigger refuses rewrites), not when the checkout is created. Tests assert both halves. An intent created at 3 % keeps its 600 after the default moves to 7 %; re-serving it creates nothing new. A checkout **opened** at 3 % but whose intent is created after the change is charged 7 %. See open question 3.
- **Range.** The route caps the default at 800 bps (`FEE_RATE_BP`): D45's PRISGOLV floor assumes at most the 8 % BAS fee, so a higher default would make at-floor products un-payable. The DB CHECK is the wider 0..10000.
- **Pinned fields.** `refundApplicationFee` and `reverseDisputeOnCreated` are returned by GET from the table. A PATCH naming either one, even alongside an editable field, is refused as a whole with `setting_not_editable` plus `field`. The code constants still run, and a test pins the table defaults equal to `REFUND_APPLICATION_FEE` and `REVERSE_DISPUTE_ON_CREATED`.

---

## 8. Deviations (from the brief or from Firebase)

1. **`X-Shop-Id` ⇒ opaque 404 on every CP3-D platform route.** The brief requires "a platform user acting as a shop" to get the 404. That user *is* a platform admin, so the only request-level marker is the shop header that every shop-context client sends. Platform data therefore never flows into a shop-context UI. **CP3-A's routes ignore the header instead** (their fixtures say "a platform route must ignore"). The reviewer should pick one rule.
2. Terms are **stored normalised** (`"hakan hellstrom"`, not `"Håkan Hellström"`), so display loses case and diacritics while matching is unchanged. Imported raw spellings still work.
3. Terms are addressed by **base64url key**, not a percent-encoded term (§3).
4. The intake **refuses** an unresolvable product (Firebase stored it with `productId: null`), **refuses** over-long fields (Firebase clipped them silently), and gives one generic 400 for every refusal. It accepts the optional Firebase `productUrl`, which is not in the brief's body list.
5. Rejected reports can be **reopened** (Firebase parity); `taken_down` is final.
6. A takedown with a report writes **two** audit rows in its one batch (`screening.takedown` on the product, `report.taken_down` on the report), so each resource has its own trail.
7. **Added `POST /v1/platform/screening-terms/rescreen`** (not in the brief). Without the cron it is the only way to converge stale verdicts without a script.
8. The API constrains `kind` to Firebase's `band|brand|club|other`; the 0024 column itself is unconstrained. Terms are capped at 2000 at add time, where the old reader silently truncated at `LIMIT 2000`.
9. `decideByPlatform` throws if a report accompanies an `approved` decision (a programming error, never reachable from a route).
10. Firebase does **not** re-screen on a blocklist change at all (only on product, mapping and artwork writes); this design goes beyond it, as PLAN §2.4 asks.
11. `SETTINGS_DEFAULTS` in `platform-settings.ts` repeats the migration defaults for the absent-row read. A test pins it against `DEFAULT_COMMISSION_BPS` and the two code constants.

---

## 9. Reviewer wiring

1. **`REQUIRED_MIGRATION`** (`app.ts`, `test/health.test.ts`, `test/public-catalog.test.ts`): bump to the CP3 head once every CP3 migration is in.
2. **Cron.** In the 15-minute `scheduled()` (not my file), call `await rescreenStaleScreenings(env.DB, now)` from `src/catalog/screening.ts`. It is bounded (25 products) and safe to run every tick; a throw is a D1 fault.
3. **After deploying 0034 to staging:** call `POST /v1/platform/screening-terms/rescreen` until `pending` is 0. The pre-0034 slice rows have no stored text and are `unverified` until then.
4. **Importer (CP3-S):**
   - Settings: set values with `UPDATE platform_settings SET default_commission_bps=…, reverse_dispute_on_created=…, review_first_products=…, screening_hard_block=…`. Never name `screening_terms_version` with a non-increasing value (the forward-only trigger), and never set `refund_application_fee` ≠ 0.
   - Terms: insert them verbatim (raw spellings match fine; Firebase `note: ''` is allowed), then `UPDATE platform_settings SET screening_terms_version = screening_terms_version + 1` in the same batch so any screened rows are re-evaluated.
   - Reports: `infringement_reports` needs its product to exist (FK). Row 33 therefore depends on the CP4 products import, and a Firebase report with `productId: null` cannot be carried. Production holds 0 such reports today. `source` must be `'storefront'`, and an unmapped handler goes in `handled_by_legacy_uid`.
5. **CP4 product import:** write a `product_screening` row per product. Use `terms_version` NULL (and no stored text) so the sweep screens it with `requires_approval` as imported; otherwise the product is outside the term-change guarantee (§4 limits).
6. No new environment variable, secret or binding. The digest already needs `PLATFORM_ALERT_EMAIL` (unchanged).

---

## 10. Open questions

1. Consolidate the `X-Shop-Id` rule for platform routes across CP3-A…F (deviation 1).
2. Should switching the global hard block **off** lift the blocks it caused (a targeted re-evaluation), or stay machine-exact with approval as the only way back (current)?
3. Commission freeze point: PaymentIntent creation (current, CP2) or checkout creation? This interacts with D48 (a 24 h window).
4. GDPR / retention of reporter data: reports are append-only with immutable facts, and there is no erasure or redaction path. It needs a policy and a later migration.
5. Should the intake accept only products that are currently public? Today it accepts any product of the shop (Firebase parity; a product can be unpublished between seeing and reporting it).
6. Is the normalised display of terms acceptable for the CP3b platform page, or should the typed spelling be kept in `note` or a new column?

---

## 11. Test output (exact)

Run from `cloudflare/`, 2026-09-27. Re-run after the other builders' later changes (resume round). Every number below was reproduced exactly, and `tsc --noEmit` exits 0.

**My suites plus the suites the brief names (and the other screening callers):**
```
npx vitest run test/platform-settings.test.ts test/screening-settings.test.ts test/infringement-reports.test.ts test/screening.test.ts test/pod-publish.test.ts test/payment.test.ts test/payment-connect.test.ts test/checkout.test.ts test/pod-mappings.test.ts test/admin-catalog.test.ts test/public-catalog.test.ts
 Test Files  11 passed (11)
      Tests  625 passed (625)
```

| File | Tests |
|---|---|
| `platform-settings.test.ts` | 38, new |
| `screening-settings.test.ts` | 64, new |
| `infringement-reports.test.ts` | 51, new |
| `screening.test.ts` | 55 (53 existing + 2 new) |
| `pod-publish`, `pod-mappings`, `payment`, `payment-connect`, `checkout`, `admin-catalog`, `public-catalog` | 417, unchanged, green |

In total CP3-D adds **155 tests**.

**Full suite** (other builders mid-work in the same tree):
```
npx vitest run
 Test Files  2 failed | 67 passed (69)
      Tests  37 failed | 2348 passed (2385)
```

All 37 failures are in `test/slice/vertical-slice.test.ts` (1) and `test/slice/failure-injection.test.ts` (36). The cause is CP3-E's checkout change: `createCheckout` now also requires `isLegallyReady` (`src/commerce/checkout.ts`), so the slice harness's shop gets `404 {"error":{"code":"not_found","message":"Checkout not found"}}` at checkout. The vertical slice additionally fails on the new `/v1/admin/legal/status` shape (`acceptedVersion`, `graceDeadline`, `inGrace`, `readiness`). Neither involves CP3-D code.

An earlier full run under heavy concurrent load also showed single timeouts in `refunds`, `receipts`, `discount-codes`, `legal`, `provision-tenants` and `connect-onboarding`. Re-run alone, the first five pass (`5 passed (5)`, `222 passed (222)`); `connect-onboarding` is CP3-F's suite and I did not re-run it.

**Type check:** `npx tsc --noEmit` is clean on the final run. Earlier runs showed transient errors only in other builders' in-progress files (`test/printers-platform.test.ts`, `src/platform/user-directory.ts`, and a parse error in `src/platform/invites.ts`).

**Guard:** no match of the guard's patterns in any file I created or changed (checked with the patterns from `guard/guards.test.mjs`). Every term, person and address in my tests is invented (`example.com`).

**Not tested / not done:**
- The cron wiring (not my file).
- Deployment or staging behaviour.
- D1's real statement-time limit for the safety statement at large scale.
- The in-batch mismatch guard (`version = 0`) on its own: the pre-check catches that case first, and the concurrent-change half of the same guard is tested.
