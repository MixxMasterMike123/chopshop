Model: claude-opus-5-5 (Opus 5.5)

# CP5-WJ report: the Worker additions the admin's page units asked for

Built on `cf-port` (HEAD `b26a0bb7`), in the working tree, only under `cloudflare/src/**` and `cloudflare/test/**`. No git command that writes, no network, no wrangler, no deploy. **No migration** (the next free number stays 0049; `REQUIRED_MIGRATION` is unchanged). FK worked in `src/**` at the same time; none of its files were touched, and none of mine had changes I did not make.

Item "a platform user without a password" was already done (`CP5_WJ4_REPORT.md`) and is skipped.

## Summary

| # | Item | Status |
|---|---|---|
| 1 | The legal status and the adoption name their signer and time | built |
| 2 | A refused legal text names its page | built |
| 3 | The platform shop detail carries the legal readiness (ONE predicate with the checkout) | built |
| 4 | `variantCount` and `tags` on the product list, and `GET /v1/admin/tags` | built |
| 5 | The pages list carries its SEO texts and the languages with content | built |
| 6 | The order list's `q` also matches the recipient's name | built |
| 7 | A coarse payment method | **skipped: not stored** |

The signer shape (items 1 and 3) is one type everywhere, `src/legal/signer.ts`:

```ts
SignerView = { kind: "admin" | "platform", name: string | null, email: string | null }
```

- **`kind: "admin"`** is a person of the shop. The shop sees the name and the address, as its own admins already see each other on `GET /v1/admin/members`.
- **`kind: "platform"`** is a platform account. To the SHOP, `name` and `email` are always `null`, so the shop only learns "the platform". This follows how the order history names an operator (`fulfilment.ts`: `by: "platform"`, never an id). The platform console (`GET /v1/platform/tenants/:id`) sees the person.
- **`email`** is the address stored WITH the evidence when the table keeps one (`legal_acceptances.email`, read at signing), else the account's current address (`platform_terms_acceptances` keeps no address).
- **The Worker never lets a platform user sign for a seller** (`maySignForSeller`). So `kind: "platform"` can only come from an IMPORTED Firebase row whose uid was carried to a platform account.
- **An imported row whose uid was not carried** (`user_id NULL`) is named by its stored address, `{ kind: "admin", name: null, email: <stored> }` (see the open questions).

---

## Item 1: the legal status and the adoption name WHO and WHEN

The FE report (open question 1) asked for the signer's address on `GET /v1/admin/legal/pages`. The brief also asks for the platform-terms acceptance. Both are built. The time is the server's: the `accepted_at` written by the Worker, or the imported one.

**`GET /v1/admin/legal/status`** (unchanged guard: tenant admin or acting-as; opaque 404 otherwise). One new key, always present:

```json
{ "accepted": true, "acceptedAt": "…", "acceptedVersion": "2026-09-07", "currentVersion": "2026-09-07",
  "graceDeadline": null, "inGrace": false, "readiness": { … },
  "latestAcceptance": { "version": "2026-09-07", "acceptedAt": "2026-10-04T00:10:11.123Z",
                        "acceptedBy": { "kind": "admin", "name": "anna", "email": "anna@shop.se" } } }
```

- **What `latestAcceptance` is.** The shop's latest platform-terms acceptance: the version the status calls `acceptedVersion` (latest in publication order among the versions published by now), with its time and signer. It is `null` when the shop never accepted.
- **When it may be older than the current version.** It can name an OLDER version than `currentVersion`. This fills the hole `adapters/platformTerms.js` notes: "The date of an OLDER version's acceptance is not in the answer".

**`GET /v1/admin/legal/pages`**: `acceptance` gains `acceptedBy: SignerView`. `acceptedAt` was already there.

**Errors:** none new.

**Files:**
- `src/legal/signer.ts` (new): `SignerView`, `signerColumnsSql`, `signerView`.
- `src/legal/platform-terms.ts`: `readLatestTermsAcceptance(db, tenantId, now, viewer)` and `TermsAcceptanceView`.
- `src/legal/legal-pages.ts`: `readLatestLegalPagesAcceptance` joins the signer.
- `src/routes/legal-admin.ts`: the status answer and the doc comment.

**Tests:**
- `test/legal-signer.test.ts` (new):
  - the shop's own admin is named by name and address;
  - a platform signer is `{kind:"platform", name:null, email:null}` to the shop, and to an acting-as reader too, with no platform address, name or id anywhere in the bytes;
  - an unmapped imported row is named by its stored address;
  - another shop's session gets the 404;
  - a shop that never accepted reads `null`.
- Exact shapes were updated in `legal.test.ts`, `legal-grace.test.ts` (an OLDER version R0 as the latest acceptance; a dangling signer id reads `{admin, null, null}`), `legal-pages.test.ts`, `slice/vertical-slice.test.ts` and the harness type `slice-harness.ts TermsStatusBody`.

**Mutations, each caught:**
- the shop sees the platform signer's address (M1: 1 failed);
- the status without `latestAcceptance` (M1b: 5 failed).

## Item 2: a refused legal text names its page

**`POST /v1/admin/legal/accept-pages`**, for a well-formed body whose HTML `html-refusal.ts` refuses:

```json
400 { "error": { "code": "invalid_request", "message": "A text holds markup that cannot be published",
                 "page": "angerratt", "pages": ["angerratt", "kopvillkor"], "reason": "event_attribute" } }
```

- **`pages`** lists every refused key in `LEGAL_PAGE_KEYS` order (`angerratt`, `integritetspolicy`, `kopvillkor`).
- **`page` and `reason`** are the first refused key and why (`HtmlRefusal`: `script`, `event_attribute`, `javascript_url`, …).
- **The shape is judged first.** A malformed body that also holds refused HTML answers the plain `400 { code: "invalid_request", message: "Request is not valid" }` and names no page.
- **Nothing is written** on either refusal.

**Deviation from FE's wish.** FE suggested `{ code: 'html_refused', page, reason }`. I kept the code `invalid_request` and added the fields instead:
- the deployed page (`legalAcceptance.js errorOfAnswer`) already turns a 400 `invalid_request` into the right Swedish refusal, so a new code would have regressed it until the wiring lands;
- the product route uses the same convention (`code: "invalid_request"` + `reason`).

The client already carries the fields: `AdminApiError.reason` is `error.reason`, and `AdminApiError.details` is the whole error object (`details.page`, `details.pages`).

**Files:**
- `src/legal/legal-pages.ts`: `parseAcceptPagesInput` now returns `ParsedAcceptPages` (`ok` | `invalid` | `content_refused`). The shape check moved into `parseAcceptPagesShape`.
- `src/routes/legal-admin.ts`.

**Tests:** `legal-pages.test.ts` "a refused text names its page":
- four single-page refusals with exact `reason`s;
- one two-page refusal (both listed, the first one's reason);
- nothing written.

The strict-body test now also proves "shape first".

**Mutations, each caught:**
- the keys iterated in reverse (M2);
- `page` dropped from the answer (M2b).

## Item 3: the platform shop detail's legal readiness, ONE predicate

**THE predicate.** It lives in `src/legal/legal-pages.ts`:
- `readLegalCheckoutGate(db, tenantId, now)` returns `{ checkoutOpen, readiness, terms, termsGateOpen }`, with `checkoutOpen = termsGateOpenOf(terms) && readiness.ready`;
- `isCheckoutLegallyOpen` is its `checkoutOpen`;
- `termsGateOpenOf(status)` is new in `platform-terms.ts`, and `isTermsGateOpen` now uses it.

**`createCheckout` now calls `isCheckoutLegallyOpen`** instead of `isTermsGateOpen || isLegallyReady`. Same answer and same opaque 404, but the two reads now run in parallel rather than short-circuiting. The platform detail reads the same function, so the two cannot drift.

**`GET /v1/platform/tenants/:tenantId`** (platform session only; unchanged guard) gains `legal`. The write answers that return the detail (PATCH, publish, unpublish, close) carry it too:

```json
"legal": {
  "checkoutOpen": true,
  "readiness": { "returnAddress": true, "vatAnswered": true, "legalPagesAccepted": true, "ready": true },
  "pagesAdoption": { "acceptedAt": "…", "templateVersion": "2026-09-07",
                     "pages": ["angerratt", "integritetspolicy", "kopvillkor"],
                     "acceptedBy": { "kind": "admin", "name": "anna", "email": "anna@shop.se" } } | null,
  "terms": { "currentVersion": "2026-09-07", "acceptedCurrent": true, "gateOpen": true,
             "inGrace": false, "graceDeadline": null,
             "latestAcceptance": { "version": "…", "acceptedAt": "…", "acceptedBy": { … } } | null }
}
```

| Field | Meaning |
|---|---|
| `checkoutOpen` | Exactly what `createCheckout` decides on the legal side |
| `readiness` | The checkout's readiness gate (`readLegalReadiness`) |
| `pagesAdoption` | The latest legal-pages adoption: its time, its template version (an imported row's `version` when it has no template version), the page keys its snapshot holds, and its signer as the PLATFORM sees it. `null` when none |
| `terms.acceptedCurrent` | The current version is accepted (grace does not count) |
| `terms.gateOpen` | The terms gate: accepted, or inside the D47 grace |

The texts themselves are not read. The existing `settings.returnAddressSet` / `vatAnswered` summary is left as it was (see the test below for why it is not the gate).

**Files:**
- `src/legal/legal-pages.ts`: `readLegalCheckoutGate`, `isCheckoutLegallyOpen`, `readTenantLegalView`, `TenantLegalView`.
- `src/legal/platform-terms.ts`: `termsGateOpenOf`.
- `src/commerce/checkout.ts`: the gate call.
- `src/platform/tenant-directory.ts`: `TenantDetail.legal`; `readTenantDetail(db, id, now = Date.now())`, with the write paths passing their `now`.

**Tests** (`test/legal-signer.test.ts`):
- **A ready shop:** the exact `legal` object, and a real checkout answers 201.
- **A fresh shop:** all closed, `pagesAdoption: null` although other shops hold later adoptions.
- **An imported shop:** the platform sees the platform signer by address and name, and a real checkout answers 201.
- **ONE predicate:**
  - setup: a return address of white space only (U+00A0 and a line break);
  - the old `settings.returnAddressSet` says `true`;
  - `legal.readiness.returnAddress` and `legal.checkoutOpen` say `false`;
  - the real checkout answers 404.
- **Authorization:** a tenant admin gets the opaque 404 on the detail, and no other shop's signer reaches a shop's detail.
- **Grace** (`legal-grace.test.ts`): the shop in grace reads `checkoutOpen: true, gateOpen: true, acceptedCurrent: false, inGrace: true`, right after its checkout opened; the two gated shops read `false`.

**Mutations, each caught:**
- `checkoutOpen` without the readiness (M3);
- the adoption read without its tenant condition (M3c: 3 failed);
- the latest-terms read without its tenant condition (M3d: 5 failed).

## Item 4: the product list's `variantCount` and `tags`; `GET /v1/admin/tags`

**`GET /v1/admin/products`**: each item gains two fields.
- **`variantCount`** (integer): the product's ACTIVE variants (`product_variants.active = 1`), as the brief says. FC asked only for "a variant count". The old page counted `p.variants.length` of the Firebase document; say so if inactive ones should count too.
  - It is a correlated `COUNT` subquery inside the list's one SELECT (index `product_variants_tenant_product_idx`).
- **`tags`** (string[]): as typed, in the seller's order.
  - Read with the existing `loadTagsFor`: one batched statement per 90 products, so two at the maximum page of 100.
  - It runs in parallel with the image batch.

The list's queries are bounded:
- the test lists 100 products through an instrumented D1 and counts at most 8 statements in all, exactly 2 of them on `product_tags`;
- no compound SELECT is used.

**`GET /v1/admin/tags`** (new route, mounted in `CP5-ROUTES-I`; tenant admin or acting-as; anyone else gets the opaque 404; GET only, any other method gets the 404):

```json
200 { "tags": [ { "tag": "Sommar", "tagKey": "sommar", "productCount": 2 }, … ], "truncated": false }
400 invalid_request      any query string at all
```

- **One entry per `tag_key`** (two spellings with one key are one tag, as `/tagg/<key>` and a collection's tag rule match).
- **`tag`** is the least spelling in byte order (SQLite `MIN`).
- **`productCount`** is the number of the shop's products that are NOT archived carrying it.
- **What counts:** tags of archived products are left out, since the admin list hides archived ones.
- **Order and cap:** sorted by `tagKey`, at most `ADMIN_TAG_LIST_LIMIT = 500`, `truncated: true` when more exist.
- **Cost:** one aggregate over `product_tags_tenant_tag_idx`.

**Files:**
- `src/catalog/admin-product-reads.ts`: `AdminProductListItem.tags` and `.variantCount`, `listAdminTags`, `ADMIN_TAG_LIST_LIMIT`, `AdminTag`.
- `src/routes/admin-products.ts`: `handleAdminTagListRoute`, `ADMIN_TAG_LIST_PATH`.
- `src/app.ts`: the `CP5-IMPORTS-I` and `CP5-ROUTES-I` blocks only.

**Tests** (`admin-products.test.ts`, "CP5-WJ: …"):
- the count is active-only (3 variants, one inactive, read as 2), with tags in order;
- another shop's tags and variants never appear;
- the bounded-statements test;
- `/v1/admin/tags`:
  - the exact answer: case-merged, archived left out, drafts counted, cross-tenant clean;
  - refusals: no session, another shop's admin, a platform session without a grant, POST/PUT/DELETE, a query string;
  - the cap: 520 tags give 500 and `truncated: true`.

**Mutations, each caught:**
- inactive variants counted (M4a);
- archived tags listed (M4b);
- the tag query without its tenant (M4c: 2 failed);
- tags read per product, N+1 (M4d).

## Item 5: the pages list's SEO texts and languages

**`GET /v1/admin/pages`**: each item gains three fields (the single-page read is unchanged):

```json
{ …the summary as before…,
  "metaTitle": { "sv-SE": "SEO-titel", "en-GB": "SEO title" } | null,
  "metaDescription": { "sv-SE": "Beskrivning" } | null,
  "contentLanguages": ["en-GB", "sv-SE"] }
```

- **`metaTitle` / `metaDescription`**: as stored, read like the single-page read (`readMap`). `null` when none.
- **`contentLanguages`**: the language tags whose `content` is a non-empty string, sorted. It is computed in SQL (`json_each`), so the list never carries a page's content.
- **Computing "Översättningar n/3".** With `title` (already in the item), the page's completeness rule (`AdminPages.jsx getTranslationStatus`: title, content, metaTitle and metaDescription all non-empty for a language) can be computed from the list alone.

**Files:**
- `src/content/pages.ts`: `AdminPageListItem`, `listAdminPages`.
- `src/routes/admin-pages.ts`: the doc comment.

**Tests** (`pages.test.ts`):
- the list-shape test is updated;
- a new test checks:
  - the stored SEO maps come back;
  - an EMPTY content language does not count;
  - the item has no `content` and the response bytes hold none of the content's text;
  - another shop's same-slug page does not appear.

**Mutation:** an empty content counted (M5): caught.

## Item 6: the order search also matches the recipient's name

**`GET /v1/admin/orders?q=…`**. Every other parameter is as before.

- **A `q` holding `@`** is unchanged: the customer's address, exact, lower-cased.
- **Any other `q`, after trimming**, must be 1–100 characters of letters, combining marks, digits, the space, `'`, `’`, `.` or `-`. Anything else is a 400 `invalid_request`, as before: `%`, `_`, `\`, `<`, an empty string, white space only, or over 100 characters. Such a `q` matches an order when EITHER:
  - **the order number starts with `q`**: only when `q` is also an order-number prefix (`[0-9A-Za-z-]{1,40}`), ASCII case-insensitive, as before; OR
  - **its recipient's name CONTAINS `q`** (`order_recipients.name`, D68/D98).
- **How the name matches.**
  - It is a substring match.
  - It is case-insensitive for ASCII letters (SQLite `LIKE`) and for `Å Ä Ö Æ Ø É È Ü Ñ`: those capitals are folded to lower case on both sides (`FOLDED_LETTERS`). No other letter is folded.
  - No LIKE wildcard can reach the pattern.
  - The recipient row must be the order's own AND this shop's (`r.order_id = o.order_id AND r.tenant_id = o.tenant_id`).
  - An order made before 0045 (no recipient row) is found by its number only.
- **`count` and `totalMinor`** follow the same window.
- **The answer is unchanged:** no recipient field beyond the `recipientName` the list already carried. Nothing of the query or the recipient is logged or audited.

**What used to be a 400 and now searches:** a `q` with a space or a non-ASCII letter, such as "Kim Köp".

**Files:** `src/commerce/admin-order-list.ts`.

**Tests** (`admin-order-list.test.ts`):
- a part of the name (`kim`, `öpa`), any case (`KÖPARE`, `ÅSA ÖBERG-LUND`), with spaces, trimmed;
- the other shop's namesake order is never matched;
- a no-match returns empty;
- a number prefix still matches;
- the window's `count`/`totalMinor`;
- the answer's keys are exactly the list's former ones;
- new 400s: white space only, `_`, `\`, `<script>`, 101 characters.

**Mutations, each caught:**
- no fold (M6a);
- no name branch (M6b: 2 failed).

## Item 7: a coarse payment method — skipped

**Not stored.**
- No column holds a payment method, a card brand or a wallet (searched in `migrations/` and `src/`).
- The webhook keeps only `latest_charge`'s id; the PaymentIntent is created with `automatic_payment_methods`.

As instructed, no Stripe call and no migration were added. FD's "Betalsätt" (the CSV, the PDF and the detail) stays without a source. Storing it would mean a column on the order written by the webhook from the charge's `payment_method_details.type` (a migration plus a webhook change): a decision for Mikael.

## Gates

- **Typecheck:** `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`: clean (the root project also checks the tests).
- **Worker tests:** `npx vitest run` gives **Test Files 100 passed (100), Tests 4254 passed (4254)**, nothing skipped. The baseline at HEAD was 99 / 4237; the new file is `legal-signer.test.ts`, and 17 tests were added.
- **Types:** `npm run types:check` exits 0 ("Types … are up to date"); `wrangler.jsonc` is untouched.
- **Guard:** `node guard/guards.test.mjs` from the root exits 0, **PASS** (296).
  - One earlier run failed on `src/pages/platform/platformPrintersData.js`, an allowlist line of FK's for a file it had not yet tracked. That is FK's in-progress state, not mine; the rerun passes.
  - My two new files are untracked, so the guard does not scan them yet; I grepped them and my diff for the guard's two patterns: no match.
- **Mutations:** the 14 mutations M1–M6b were run one at a time against the relevant test file, each restored from a copy (no git); every one made its test fail.

## Frontend wiring (for the later step)

| Item | Module | What to read |
|---|---|---|
| 1 | `src/admin-app/adapters/settings.js` `acceptanceFromView` (and through it `replacements/adminSettingsData.js`) | Add `email` from `view.acceptedBy.email`. For `kind: "platform"`, show a fixed word (for example "plattformen") instead of `email \|\| uid`. AdminSettings line ~895 reads `legalAcceptance.email \|\| legalAcceptance.uid`. |
| 1 | `src/admin-app/adapters/platformTerms.js` `acceptanceOf` → `components/admin/platformTermsData.js` → `AdminPlatformTerms.jsx` (~line 94: `terms.email \|\| terms.uid`) | Read `status.latestAcceptance` (`{version, acceptedAt, acceptedBy}`). It fills both the email and the older version's date the adapter says is missing. |
| 2 | `src/admin-app/replacements/legalAcceptance.js` `errorOfAnswer`; `adapters/settings.js` `refusedTextKeys` | On 400 `invalid_request` with `error.details.pages`, lay the refusal on exactly those pages (`details.page` first, `error.reason` the `HtmlRefusal`), not on every custom page. No `pages` means a malformed body: keep "förfrågan avvisades". |
| 3 | `src/admin-app/adapters/platformShops.js` `toDetailShop` / `legalReadinessFromSummary`; `src/admin-app/replacements/shopCellsData.js` (`LEGAL_FACTS`, `PLATFORM_TERMS_VERSION`, `legalReadinessOf`) | Build the readiness from `detail.legal.readiness` (drop `ACCEPTANCE_UNKNOWN`). Set `shop.storeIdentity.legal.acceptance` from `legal.pagesAdoption` (`email`, `acceptedAt`, `templateVersion`) and `shop.platformTerms` from `legal.terms.latestAcceptance` (`email`, `acceptedAt`, `version`). Then `LEGAL_FACTS = true`. The pill compares `t.version` with the module constant `PLATFORM_TERMS_VERSION`; the server's `legal.terms.currentVersion` is the truth, so the wiring has to bridge that (for example a `t.current` the badge reads, or a module value set from the first detail read). `legal.checkoutOpen` is the checkout's own answer: "Juridik OK" should mean it. |
| 4 | `src/admin-app/replacements/adminProductsData.js` (`LIST_SHOWS_VARIANT_COUNT = true`) and `adapters/product.js` (list mapping) | `variantCount` → the "Varianter" column (the page reads `p.variants.length`, so the adapter must give it that). `tags` → `p.tags` (AdminProducts builds `availableTags` from it). |
| 4 | `src/admin-app/replacements/contentSources.js` (the up-to-300 `getProduct` reads, `TAG_READ_CAP`), `adminCollectionEditData.js`, `adminMenuData.js` | Read `tags` from the list items and the counts from `GET /v1/admin/tags` (`productCount`, `truncated`). The per-product reads and the 300 cap go away. A new client function belongs in `src/api/admin/products.js`. |
| 5 | `src/admin-app/replacements/adminPagesData.js` (today `getPage` per summary) | Map `metaTitle`, `metaDescription` and a content stand-in from `contentLanguages`: `getTranslationStatus` tests `fieldValue[lang].length > 0`, so for example `{ [lang]: ' ' }` per listed language. Drop the per-page reads. |
| 6 | `src/admin-app/replacements/adminOrdersData.js` | Nothing new to read. `q` already goes to the server. The page's search box now finds names; a `q` with characters outside the name grammar (e.g. `%`) is a 400, which the page should treat as "no match". |

## Open questions for Mikael

1. **An imported signer whose Firebase uid was not carried** is shown to the shop by the address stored with the evidence, as a person of the shop (`kind: "admin"`). If such a row was in fact signed by a platform person whose account was not migrated, the shop would see that address. Should those rows read "unknown signer" instead? There is no way to tell from the row.
2. **A former admin who signed** (since revoked) is still named by name and address to the shop's current admins. It is the shop's own evidence, and the older page showed it. Confirm this is wanted.
3. **`variantCount` counts ACTIVE variants** (the brief). The old column counted every variant of the Firebase document. Which should it be?
4. **The tag list's `productCount`** counts drafts and active products, not archived ones. A smart collection publicly shows only eligible (published and active) products. Should the count match that instead?
5. **The name search folds only ASCII and `Å Ä Ö Æ Ø É È Ü Ñ`.** A name typed in decomposed Unicode (NFD) would not match a query typed composed. Neither checkout nor the search normalises today; normalising at checkout would be the root fix.
6. **Payment method (item 7) is not stored.** Storing it is a webhook change plus a migration. Wanted for launch?
7. **FC's open question 3** (the product route's HTML refusal of `moreInfo` gives a bare 400, no field) was not in this unit's list and is not done; the same pattern as item 2 would fix it.

## Files

**Created**
- `cloudflare/src/legal/signer.ts`
- `cloudflare/test/legal-signer.test.ts`
- `docs/cf-port/CP5_WJ_REPORT.md`

**Modified**
- `cloudflare/src/app.ts` (only the `CP5-IMPORTS-I` / `CP5-ROUTES-I` blocks)
- `cloudflare/src/legal/legal-pages.ts`, `cloudflare/src/legal/platform-terms.ts`
- `cloudflare/src/routes/legal-admin.ts`
- `cloudflare/src/commerce/checkout.ts` (the legal gate call only)
- `cloudflare/src/platform/tenant-directory.ts`
- `cloudflare/src/catalog/admin-product-reads.ts`, `cloudflare/src/routes/admin-products.ts`
- `cloudflare/src/content/pages.ts`, `cloudflare/src/routes/admin-pages.ts` (comment)
- `cloudflare/src/commerce/admin-order-list.ts`
- Tests: `cloudflare/test/legal.test.ts`, `legal-grace.test.ts`, `legal-pages.test.ts`, `admin-products.test.ts`, `pages.test.ts`, `admin-order-list.test.ts`, `slice/vertical-slice.test.ts`, `slice-harness.ts` (the `TermsStatusBody` type only)
