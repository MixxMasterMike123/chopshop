# CP3-A report — tenants: directory, config, features, domains, store settings

Builder: CP3-A. Branch `cf-port`, working tree only (no git writes, no network, no wrangler). Brief: CP3 gap analysis §1a, DECISIONS D22/D50/D56/D57/D59. Updated after review rounds 1 and 2 (section "Review round 1" at the end).

## Files

| File | What |
|---|---|
| `cloudflare/migrations/0032_tenant_config.sql` | new: `tenant_settings`, `tenant_features`, 5 triggers |
| `cloudflare/src/platform/tenant-config.ts` | new: features (allowlist, defaults, the two refused groups, `isFeatureEnabled`), store settings (parse, refuse, sanitize, read, write), shared audit and tenant-state helpers |
| `cloudflare/src/platform/tenant-directory.ts` | new: list, detail, PATCH, publish/unpublish, close (with the refundable-orders guard) |
| `cloudflare/src/platform/tenant-domains.ts` | new: list, lookup, disable/enable, delete, move |
| `cloudflare/src/routes/platform-tenants.ts` | new: the 13 platform route handlers |
| `cloudflare/src/routes/admin-settings.ts` | new: `GET`/`PUT /v1/admin/settings` |
| `cloudflare/src/app.ts` | only inside `CP3-IMPORTS-A` (imports) and `CP3-ROUTES-A` (13 `app.all(…, onMethods([...], …))` mounts) |
| `cloudflare/test/tenant-fixtures.ts` | new: fixtures built on `slice-harness.ts` (real routes only), including `makeLegallyReady` (opens CP3-E's readiness gate through `PUT /v1/admin/settings` + `POST /v1/admin/legal/accept-pages`) |
| `cloudflare/test/platform-tenants.test.ts` | new: 80 tests |
| `cloudflare/test/tenant-domains.test.ts` | new: 29 tests |
| `cloudflare/test/tenant-features.test.ts` | new: 24 tests |
| `cloudflare/test/admin-settings.test.ts` | new: 51 tests |

No other file touched. No new env var, binding or secret.

---

## Routes

The same rules apply to every platform route. The session goes through the live D1 check (`authorizePlatformRequest`). Anyone else, meaning no session, a tenant admin (even with its own `X-Shop-Id`) or an ordinary user, gets the opaque `404 {"error":{"code":"not_found","message":"Route not found"}}` before the path, query or body is read. A GET needs no same-origin check (the `platform-orders.ts` convention). Every state change needs a strict same-origin request, and a missing or foreign `Origin` gets the same opaque 404. Every write is audited in the same `batch()` as the change. The audit INSERT is guarded by the exact pre-state that was read, so when a concurrent change makes the batch write nothing, the route answers 409 and records nothing.

Mounting: each path is exact and wrapped in `onMethods`, and the block sits before the older handlers. `POST /v1/platform/tenants` (create) and `POST …/:id/{activate,suspend,admins,domains}` still reach the older handler. A test proves all five, plus eight method/path combinations that still fall through to 404.

Timestamps in responses are ISO strings. `tenants` and `tenant_domains` store epoch ms; the routes convert.

### Tenant directory (platform)

| Method + path | Request | 200 response | Other answers |
|---|---|---|---|
| `GET /v1/platform/tenants` | query `status?` (`active\|suspended\|provisioning\|closed`), `cursor?` (last tenant id), `limit?` 1–100 (default 50); any other parameter → 400 | `{ tenants: [{ tenantId, shopName, status, published, domains: [{hostname, kind, status}] (≤ 20 by hostname), domainCount }], nextCursor }`, ordered by tenant id (keyset) | 400 bad query |
| `GET /v1/platform/tenants/:tenantId` | — | **TenantDetail** (below) | 404 unknown/malformed id |
| `PATCH /v1/platform/tenants/:tenantId` | non-empty subset of `{ shopName, supportEmail, vatRateBp, commissionBps }`, no other key | TenantDetail | 400 invalid · 404 unknown · 409 closed |
| `POST …/:tenantId/publish` | (body ignored) | TenantDetail (`published: true`, bumped `catalogVersion`) | 404 · 409 closed |
| `POST …/:tenantId/unpublish` | (body ignored) | TenantDetail (`published: false`, bumped `catalogVersion`) | 404 · 409 closed |
| `POST …/:tenantId/close` | none, `{}`, or `{ reason }` (1–500 characters, stored in `audit_events.reason`) | TenantDetail (`status: "closed"`) | 400 · 404 · **409 `tenant_has_refundable_orders`** · 409 `conflict` (race) · 200 no-op when already closed |

**TenantDetail** = `{ tenant: { tenantId, shopName, supportEmail, status, published, defaultLocale, defaultCurrency, vatRateBp, commissionBps (null = platform default), catalogVersion, connect: { accountId, chargesEnabled, payoutsEnabled, detailsSubmitted, syncedAt }, createdAt, updatedAt }, domains: DomainView[] (≤ 100), domainsTruncated, features: FeatureView[], settings: { returnAddressSet, vatAnswered } }`. The settings summary is booleans only. Neither the return address text nor the identity JSON is in any platform response (tested).

PATCH validation matches the columns' own CHECKs:
- `shopName`: string of 1–200 characters and not whitespace only.
- `supportEmail`: the same shape rule as bootstrap, checkout and provision-users, lowercased; `null` clears it.
- `vatRateBp`: integer 0–10000 and **not nullable**. The column is `NOT NULL DEFAULT 2500` and has no "override" to clear.
- `commissionBps`: integer 0–10000, or `null` to clear the override.
- Audit `tenant.update` records `{ changes: { field: { from, to } } }`.

A `shopName` change bumps `catalog_version` through the existing 0025 trigger, because the storefront serves the name.

### Features (platform)

| Method + path | Request | 200 response | Other |
|---|---|---|---|
| `GET …/:tenantId/features` | — | `{ tenantId, features: [{ key, enabled, source: "explicit"\|"default", defaultEnabled }] }`: every allowed key, in allowlist order | 404 |
| `PUT …/:tenantId/features` | `{ features: { <key>: boolean, … } }`, at least one key, all allowed | same shape, after the write | 400 (unknown, deleted or not-ported key; non-boolean; empty) · 404 · 409 closed |

PUT writes an explicit row for each named key (upsert). Keys not named keep their value. Audit `tenant.features_update` records `{ set, previous: { key: { enabled, source } } }`.

Shared predicate: **`isFeatureEnabled(db, tenantId, key): Promise<boolean>`** in `src/platform/tenant-config.ts`. An explicit row wins; with no row the key's default applies. A key outside the allowlist is never enabled. Also exported: `FEATURE_KEYS`, `FEATURE_DEFAULTS`, `DELETED_FEATURE_KEYS`, `NOT_PORTED_FEATURE_KEYS`, `readTenantFeatures`.

### Domains (platform)

| Method + path | Request | Response | Other |
|---|---|---|---|
| `GET …/:tenantId/domains` | `cursor?` (hostname), `limit?` 1–100 (default 100) | `{ tenantId, domains: DomainView[], nextCursor }`, ordered by hostname | 400 · 404 |
| `GET /v1/platform/domains/lookup?hostname=…` | exactly one `hostname` parameter | `{ domain: { domainId, hostname, kind, status, verifiedAt, createdAt, updatedAt, tenantId, tenantStatus, resolves } \| null }` | 400 |
| `POST …/:tenantId/domains/:domainId/disable` | — | `{ tenantId, domain: DomainView }` | 404 (unknown, or not this tenant's) · 409 race |
| `POST …/:tenantId/domains/:domainId/enable` | — | same | 404 · 409 closed tenant |
| `DELETE …/:tenantId/domains/:domainId` | — | `204` | 404 |
| `POST /v1/platform/domains/move` | `{ hostname, toTenantId }` | `{ domain: DomainView, fromTenantId, toTenantId, moved }` | 400 · 404 unknown target · 409 `hostname_unknown` · 409 `tenant_closed` · 409 `conflict` (race) |

`DomainView` = `{ domainId, hostname, kind, status, verifiedAt, createdAt, updatedAt }`.

**The lookup is a GET with a query parameter, by choice.** It changes nothing, so it is a read: it needs no same-origin check (like every platform read), it is safe to retry, and an operator can paste the URL into a browser. A hostname is public (it is in DNS), so putting it in the URL leaks nothing. When no tenant holds the hostname, the answer is `200 { domain: null }`: "nobody" is a real answer for an authorized caller, not a missing route. Hostnames are normalised by the add-domain parser itself (lowercase, no trailing dot, label grammar). `parseAddDomainInput` is reused rather than copied, so the two can never drift.

- **Disable:** `verified` or `pending` → `disabled`.
- **Enable:** `disabled` → `verified` when `verified_at` is set, otherwise `pending`.
- **Repeating either** answers 200 and writes nothing, not even an audit row.
- **Audits:** `tenant.domain_disable` and `tenant.domain_enable` record `{ from, to, hostname }`; `tenant.domain_delete` records `{ hostname, kind, status }`.
- **Delete** is allowed on any tenant, closed ones included, because deleting is how a closed shop frees its hostnames.

**Move.** `tenant_id` is immutable (0001 trigger), so a move is DELETE of the old row plus INSERT of a new row in one batch. The new row gets a new `domain_id`; `kind`, `status` and `verified_at` carry over, so a disabled domain stays disabled. The batch also writes **two audit rows**: `tenant.domain_move_out` under the source tenant and `tenant.domain_move_in` under the target. Both carry the same metadata `{ hostname, fromTenantId, toTenantId, fromDomainId, toDomainId, kind, status }`. Everything hangs on the source audit row. That row is inserted only while the old row is exactly as read and the target is still open. The other three statements are each conditional on that row existing, so a concurrent move, delete or close turns the batch into a no-op (409). D1 runs a batch as one transaction, so an INSERT failure rolls the DELETE back. The test proves this with a test-only trigger that makes the INSERT, and only it, fail after the DELETE has run. The old row, the resolution and the audit count are all unchanged afterwards. If the hostname is already on the target, the answer is `200 moved:false` and nothing is written, so a retried move is safe.

**Resolution check:** `src/tenancy/resolve-tenant.ts` already serves only `domain.status = 'verified' AND tenant.status = 'active'`. A disabled domain stops resolving on the next request. This is proven through `GET /v1/storefront` and through `resolveRequestTenant` directly. No change needed.

### Store settings (tenant admin, acting-as admitted)

| Method + path | Request | Response |
|---|---|---|
| `GET /v1/admin/settings` | `X-Shop-Id` | `200 { settings: { storeIdentity, returnAddress, vatRegistered, vatNumber, sellerType, updatedAt } }`. With no row yet: `{}` and nulls. |
| `PUT /v1/admin/settings` | `X-Shop-Id`, same-origin; non-empty subset of `{ storeIdentity, returnAddress, vatRegistered, vatNumber, sellerType }` | `200 { settings }` · `400 invalid_request` · `400 { error: { code: "refused_store_identity_keys", keys: [...] } }` · opaque 404 |

The tenant comes from `authorizeTenantAdminRequest`, exactly as on the other `/v1/admin/**` routes. It is a live membership, or a platform user's live acting-as grant. Acting-as is admitted on both methods, and the audit row carries the grant id through `auditMetadataJson`. Audit `tenant.settings_update` records `{ fields: [...] }`, the field names and **never the values**: the identity can be large and the gate fields are the seller's business data.

Validation:
- `storeIdentity`: a plain object of ≤ 65,536 **UTF-8 bytes** and nesting depth ≤ 8, with no refused key (below).
- `returnAddress`: trimmed string of ≤ 1000 characters with no control characters; newlines are allowed; `''` or `null` clears it.
- `vatRegistered`: `true`, `false`, or `null` for "not answered".
- `vatNumber`: trimmed string of ≤ 64 characters, single line; `''` or `null` clears it.
- `sellerType`: `individual`, `company`, or `''`/`null` to clear.

**Refused identity keys**, top level (`REFUSED_STORE_IDENTITY_KEYS`). Each has another home:

| Reason | Keys |
|---|---|
| owned by `tenants`, written by the platform PATCH | `shopName`, `supportEmail`, `status`, `published`, `commissionBps`, `vatRate`, `vatRateBp`, `currency`, `defaultCurrency`, `defaultLocale` |
| money and Connect (the `tenants` Connect columns, CP3-F) | `payments`, `stripeAccountId` |
| entitlements (`tenant_features`, platform only) | `features` |
| platform-terms acceptance pointer (0031, CP3-E) | `platformTerms` |
| the four gate columns (top-level body fields instead) | `returnAddress`, `vatRegistered`, `vatNumber`, `sellerType` |
| tenancy identity | `tenantId`, `shopId` |
| nested: legal-pages acceptance pointer (CP3-E `legal_acceptances`) | `legal.acceptance` |

The rest of `legal` (`custom`, `customUpdatedAt`) is the seller's own page content, not evidence, and is accepted. The same list is also stripped **on every read** (`sanitizeStoreIdentity`), so a row written by the importer or a hand fix can never hand a tenant admin a payments block or a commission. This is tested with a raw INSERT.

Nothing in `tenant_settings` reaches a public response. After a settings write with a unique marker in every field, `GET /v1/storefront`, `/v1/products` and `/v1/products/:id` on the shop's host are 200 and contain neither the marker nor any settings key name (tested).

---

## Migration 0032

**`tenant_settings`**, one row per tenant, created by the first write. The contract names and types are kept exactly.
- `tenant_id TEXT PRIMARY KEY` → `tenants(tenant_id)` ON UPDATE/DELETE RESTRICT.
- `store_identity_json TEXT NOT NULL DEFAULT '{}'`, CHECK `json_valid` AND `json_type = 'object'` AND `length ≤ 65536`.
  - Why this cap: the largest realistic identity (full menu, pickup locations with a season of dates, theme overrides, hero and footer copy) is well under 16 KB. Binary or base64 never belongs in a row (PLAN §2.7). CP4 will read this object on every storefront render. 64 KiB gives about 4× headroom and stays far below the 2 MB row limit. `length()` counts characters in SQL; the route counts bytes, which is stricter.
- `return_address TEXT` NULL, or 1–1000 characters.
- `vat_registered INTEGER` NULL, or `IN (0,1)`. NULL means not answered.
- `vat_number TEXT` NULL, or 1–64 characters.
- `seller_type TEXT` NULL, or `IN ('individual','company')`. Firebase `''` maps to NULL.
- `updated_at TEXT NOT NULL`: the ISO round-trip CHECK (`IS strftime('%Y-%m-%dT%H:%M:%fZ', …)`) that 0013 onwards uses for new tables.
- `updated_by TEXT NOT NULL`, 1–128 characters, like `product_screening.decided_by`. A non-user writer names itself; the importer should write `'import'`.
- Trigger `tenant_settings_tenant_immutable`.

**`tenant_features`**:
- Columns: `(tenant_id, feature_key)` primary key; `tenant_id` → `tenants` RESTRICT; `feature_key TEXT` with a shape CHECK (1–64 characters, alphanumeric); `enabled INTEGER NOT NULL IN (0,1)`; `updated_at` ISO with the same CHECK; `updated_by` 1–128 characters.
- Triggers: `tenant_features_tenant_immutable`, `tenant_features_key_allowlist_insert`, `tenant_features_key_allowlist_update`. Both allowlist triggers list the six allowed keys.
- The allowlist is enforced by a trigger rather than `CHECK (feature_key IN …)`. SQLite cannot alter a CHECK, so adding a later add-on would mean rebuilding the table (0009 shows what that costs on D1). A trigger is replaced with one DROP plus CREATE in an additive migration; this is also how a not-ported key comes back when its feature ports. A test pins the triggers' key list to `FEATURE_KEYS` in code.

**`tenants_closed_is_final`** (trigger on the existing `tenants` table; additive): `BEFORE UPDATE OF status … WHEN OLD.status = 'closed' AND NEW.status IS NOT 'closed' → RAISE(ABORT)`. The live-orders refusal is enforced by the close route's batch, not by a trigger (see "Closed status").

No table from 0001–0031 is dropped or recreated. There is no 0020. The file was rewritten in a single write for review round 1; round 2 changed one comment block (the close rule's description).

**No `catalog_version` bump triggers on the new tables.** Nothing public reads them yet. When CP4 serves branding from `store_identity_json`, it must add them (see "Notes for later checkpoints").

---

## Feature allowlist (final, after review round 1)

Allowed (six keys):

| Key | Default when no row | Source |
|---|---|---|
| `abandonedCheckout` | **on** | catalogue, default-on |
| `contentStudio` | off | Firebase `OPT_IN_KEYS` |
| `discountCodes` | **on** | catalogue, default-on |
| `marketingMaterials` | off | Firebase `OPT_IN_KEYS` |
| `pod` | off | Firebase `OPT_IN_KEYS` |
| `productReviews` | **on** | catalogue, default-on |

Refused, in two separately named groups (D22, the manifest's §f Q9 proposal; the raw Firebase map stays in the archive):

| Group | Code constant | Keys | Future |
|---|---|---|---|
| **Deleted from the product** (PLAN §3.3, D2) | `DELETED_FEATURE_KEYS` | `ambassador`, `campaigns`, `dining`, `writers` | never return |
| **Not ported yet** (PLAN §3.2 PORT-LATER) | `NOT_PORTED_FEATURE_KEYS` | `affiliate`, `b2b` | return as allowed keys, through a migration that replaces the two allowlist triggers, in the checkpoint that ports the feature |

For every refused key, the route answers 400, the DB trigger aborts, and `isFeatureEnabled` returns false. That includes `affiliate` and `b2b`, which Firebase treated as default-on.

---

## Closed status: decision

- `provisioning`, `active` and `suspended` may move to `closed`.
- **`closed` is final**, enforced by the 0032 trigger, whatever route or statement tries to leave it.
- **Close refuses while any order's money could still come back into play.** `POST …/close` answers `409 tenant_has_refundable_orders` while the tenant has such an order. After close, no seller session exists and the platform has no refund route of its own, so a buyer's valid claim would be stranded.
  - **The close rule (final, review round 2)** is `TENANT_HAS_REFUNDABLE_ORDER` in `tenant-directory.ts`. An order blocks close while `charged_minor − refund_succeeded_minor > 0 AND dispute_status IS NOT 'lost'`. SQLite's `IS NOT` is the null-safe `IS DISTINCT FROM`; I used it because `IS DISTINCT FROM` needs SQLite 3.39+.
  - **It is deliberately stricter than the refund rule in `refunds.ts`**, which stays untouched. A refund decision can be retried later; a close cannot be undone. So close waits for every order that could become refundable again, not only the orders refundable this minute:
    - `refund_reserved_minor` is **not** subtracted. A reserved refund that has not settled can still fail at Stripe, which releases the reservation and makes the balance refundable again. Only a succeeded refund settles.
    - Every `dispute_status` value was decided explicitly. The column is a shape CHECK with no allowlist (0019), and no later migration changes it.

      | `dispute_status` | Why | Blocks close |
      |---|---|---|
      | NULL | no dispute; the balance is live | yes |
      | `warning_needs_response`, `warning_under_review` | open inquiry; refundable now | yes |
      | `warning_closed` | inquiry ended without a chargeback | yes |
      | `needs_response`, `under_review` | open chargeback; refundable again if the shop wins | yes |
      | `won`, `prevented` | the money is back with the shop | yes |
      | any unknown or future value | fail closed | yes |
      | **`lost`** | the only release: the chargeback returned the money to the buyer through the card network, it is gone from the shop, and it cannot be refunded, so nothing can be stranded | **no** |
  - **The check is inside the close batch.** It sits in the audit row's guard and in the UPDATE's WHERE. The route makes no read of `orders` before the batch, so an order paid between the route's reads and the commit still blocks. A test proves this by buying an order at the moment the batch is sent. With the guard removed, the same test sees the close succeed, so the test is not vacuous.
  - A refusal writes nothing: no audit row, and the status is unchanged.
- **Suspension is the tool for a shop with live orders.** It is reversible; the seller can refund again once the shop is reactivated. A suspended shop with a refundable order cannot be closed either (tested).
- `suspended` stays the reversible off-switch. Firebase `disabled` maps to it (D59).
- Closing stops the storefront, every tenant-admin session and every acting-as grant on the next request, because all of them require `tenants.status = 'active'`. It also bumps `catalog_version` (0025 trigger).
- On a closed tenant these answer 409: PATCH, publish, unpublish, features PUT, domain enable, move into it.
- On a closed tenant these still work: domain disable, delete, and move out of it. That is how hostnames are freed.
- The tenant row stays forever, because every foreign key is RESTRICT.

---

## Deviations from the brief or from Firebase

1. **Store identity PUT replaces each field it names, and `storeIdentity` is replaced whole.** Firebase deep-merges (`setDoc(…, {merge:true})`). Confirmed in review round 1: replace stays, and CP5 revisits with the admin UI. If CP5 wants merge semantics, a `PATCH` using SQLite's `json_patch()` (RFC 7386, atomic in one UPDATE) is a small addition.
2. **`shopName` and `supportEmail` are refused inside the identity.** On Cloudflare `tenants.shop_name` is what the storefront API serves, and only the platform PATCH edits it. Confirmed in review round 1: platform-only in CP3, CP5 decides how the seller edits them.
3. **`vatRateBp` is not nullable in PATCH.** The brief's "null clears the override" fits `commissionBps` only.
4. **Domain move** answers 404 for an unknown target, consistent with every unknown-tenant answer. The brief says "nothing changes" and leaves the code open. A closed target answers 409 `tenant_closed`, and an unknown hostname answers 409 `hostname_unknown` as the brief asks.
5. **Two audit rows per move** (one per tenant, each naming both), so each tenant's audit history shows the event. The brief asks for "an audit row naming both tenants".
6. **`isFeatureEnabled` does not fail open on a read error**, unlike Firebase. A D1 fault propagates like every other read in this Worker. The defaulting rule is identical.
7. **The tenant list shows at most 20 domains per tenant** plus `domainCount`. The detail shows up to 100 with `domainsTruncated`; the domain route pages through all of them.
8. Repeated disable, enable or close, and a no-op move, write **no** audit row. The older `setTenantStatus` does audit repeats. I audit only real transitions.
9. **D57** as decided: unpublish hides the catalogue (products 404, list empty). `GET /v1/storefront` still answers the shop name, because that route never read `published`. Firebase keeps the whole storefront visible with noindex.
10. **`affiliate` and `b2b` are refused** although Firebase treats them as default-on add-ons (review round 1; D22).
11. **The close rule is stricter than the refund rule** (review round 2): an unsettled reserved refund and any dispute except `lost` keep an order live for close. Firebase had no close state at all.

---

## Reviewer wiring (files I do not own)

**Taken by the reviewer at consolidation** (confirmed in review round 1):
1. `cloudflare/test/provision-tenants.test.ts` › "does not expose the collection through another method" asserted `GET /v1/platform/tenants` → 404, which the list route makes 200 by design. It passes in the tree now.
2. `setTenantStatus` answering 409 for a closed shop. In the tree now: `activate` and `suspend` on a closed shop answer `409 tenant_closed`. My "closed is final" test was updated from the old thrown request to that answer, with no audit row and the status unchanged.
   - **D1 fact worth keeping.** `meta.changes` counts rows changed by triggers. I measured it: an UPDATE of `tenants.status` reports 2 (the row plus the 0025 `catalog_version` trigger), while an UPDATE that fires no trigger reports 1. A guard written as `changes !== 1` therefore refuses valid writes. That briefly broke activate and suspend in the tree during round 2; it is fixed now. All my guards test `=== 0`.
3. `REQUIRED_MIGRATION` (app.ts, `health.test.ts`, `public-catalog.test.ts`). 0033–0038 also exist in the tree.

**New in round 2, for the reviewer (not my files):**
- `test/slice-harness.ts` `createTenant` does not make a shop legally ready. With CP3-E's readiness gate live in `checkout.ts`, every checkout in `test/slice/` answers 404; those are the full suite's 37 failures, listed under "Test output". A fix is to call the equivalent of `makeLegallyReady` (`test/tenant-fixtures.ts`) inside `createTenant`.

**Passed on to other builders:**

4. **Importer (CP3-S), manifest row 56 → my tables:**
   - `storeIdentity`: strip the refused keys (`REFUSED_STORE_IDENTITY_KEYS` + `legal.acceptance`, exported from `tenant-config.ts`). Map `storeIdentity.shopName` / `supportEmail` onto `tenants` if they should win over `shops.name`.
   - `returnAddress`: trim; `''` → NULL.
   - `vatRegistered`: boolean → 0/1, anything else → NULL.
   - `sellerType`: `''` → NULL.
   - `updated_at`: ISO `…T…Z` with milliseconds. `updated_by`: `'import'`.
   - `tenant_features`: rows only for the six `FEATURE_KEYS`, with effective values (D22). No row for any deleted or not-ported key: the trigger aborts them.
5. **Readiness gate (CP3-E)**: read `tenant_settings.return_address` and `vat_registered IS NOT NULL`. The route always trims, but the CHECK alone allows a whitespace-only value, so test `trim(return_address) <> ''` to be safe against importer rows.
6. **Flag enforcement is not wired anywhere yet.** No Cloudflare code path calls `isFeatureEnabled`. Firebase enforces:
   - `pod`: artwork processing, the checkout production snapshot, printer notification.
   - `discountCodes`: at checkout.
   - `productReviews`: the review sweep.

   (`affiliate` is not ported.) With `pod` defaulting OFF, wiring it into the existing POD routes requires an explicit `pod=true` row for every POD tenant first. On staging that is `slice-20260927`, and the importer sets melodie-mc. The owners of `pod-admin.ts`, `checkout.ts` and `admin-discount-codes.ts` decide when.
7. `resolve-tenant.ts`: **no change needed**, since it already requires `verified`.

---

## Open questions

None.

### Answered in review round 2

- **Stranding after close through an open dispute or an unsettled reserved refund:** close now uses the stricter rule the coordinator approved (see "Closed status" and "Review round 1"). `refunds.ts` is unchanged.

### Answered in review round 1 (no code change)

- **Seller renaming the shop or changing the support email:** platform-only in CP3; CP5 decides. Both stay refused identity keys.
- **`legal.custom` / `legal.customUpdatedAt`:** stay in the identity. They are the seller's own page content, not evidence.
- **Merge or replace for the identity:** replace stays; CP5 revisits.
- **`affiliate` and `b2b`:** refused as "not ported yet" (required change 1).
- **Closing a shop with open orders:** refused while refundable (required change 2).

## Notes for later checkpoints

- CP4, when it serves any `tenant_settings` or `tenant_features` field publicly: add `catalog_version` bump triggers on both tables (INSERT and UPDATE). The 0025 rule applies: over-bumping costs a cache miss, under-bumping serves a stale 304.
- `effectiveCommissionBps` is deliberately **not** computed in the detail, because CP3-D's `platform_settings.default_commission_bps` will own the default. `commissionBps: null` means "the platform default".
- When `affiliate` or `b2b` ports: add the key to `FEATURE_KEYS` and `FEATURE_DEFAULTS`, remove it from `NOT_PORTED_FEATURE_KEYS`, and ship a migration that DROPs and re-CREATEs both allowlist triggers. The tenant-features test fails until code and triggers agree.

---

## Review round 1 (2026-09-27)

The coordinator accepted CP3-A with two required changes. Both are done.

**Change 1: `affiliate` and `b2b` removed from the feature allowlist.**
- `FEATURE_KEYS` is now six keys. `migrations/0032_tenant_config.sql` was rewritten in one single write, and both allowlist triggers list the same six keys.
- The two refused groups are named separately in code (`DELETED_FEATURE_KEYS`, `NOT_PORTED_FEATURE_KEYS`), in the migration comment and in this report.
- Tests: both groups are refused by the route (400, nothing written), by the DB trigger on INSERT and on UPDATE of the key, and by `isFeatureEnabled` (false). The detail's feature list and the default table were updated.

**Change 2: close refuses while a buyer could still be refunded.**
- `closeTenant` puts `NOT EXISTS (live order)` in the audit row's guard and in the UPDATE's WHERE.
- When the batch writes nothing, the route names the reason: `409 tenant_has_refundable_orders`, or `409 conflict` for a status race.
- The route comment and this report say that suspension is the tool for a shop with live orders.
- Tests:
  - A paid order blocks close, also while the shop is suspended.
  - A partially refunded order blocks close.
  - After the full refund, close succeeds.
  - Every refusal leaves the status unchanged and writes no audit row.
  - An order paid after the route's reads, just before the batch commits, still blocks (instrumented D1; mutation-checked: without the in-batch guard this test fails with a 200).

**Round 2 follow-up (approved by the coordinator): the stricter close rule.** Round 1 first used the refund rule from `refunds.ts` as is. That rule leaves two ways to strand a refund after close: an order under an open dispute that the shop later wins, and a reserved refund that later fails at Stripe. The final close rule is:

```
charged_minor − refund_succeeded_minor > 0 AND dispute_status IS NOT 'lost'
```

- It lives only in the close guard (`TENANT_HAS_REFUNDABLE_ORDER`, `tenant-directory.ts`). The comment explains why close is stricter than refund (a refund decision can be retried, a close cannot be undone) and decides every `dispute_status` value (table under "Closed status"). `lost` is the only release, because the money is gone and cannot be refunded.
- Checked against the columns in `0019_money.sql` (`charged_minor`, `refund_succeeded_minor`, `dispute_status`). No later migration touches them.
- Still inside the batch, in the audit row's guard and the UPDATE's WHERE.
- Tests:
  - A reserved, unsettled refund for the full amount blocks close, even though the refund rule sees nothing refundable (`refundableMinor` 0, `refundPendingMinor` = full). After the `refund.updated → succeeded` webhook, close succeeds (new test).
  - Open chargebacks (`needs_response`, `under_review`) block, as do the inquiries (`warning_needs_response`, `warning_under_review`, `warning_closed`), `won`, `prevented` and an unknown future status. `lost` releases the order. This updates the round-1 dispute expectations; the test now buys its own order.
  - A fully refunded order with the refund succeeded does not block (the existing paid → partial → full test).
  - Mutation-checked: under the round-1 rule, both the reserved-refund test and the dispute test fail with a 200.
- `refunds.ts` untouched.

**Test fixtures after round 2.** CP3-E's readiness gate is now live in `checkout.ts`. My close tests make their shops ready through the real routes before buying (`makeLegallyReady`).

---

## Test output

My four files, run alone (`npx vitest run test/platform-tenants.test.ts test/tenant-domains.test.ts test/tenant-features.test.ts test/admin-settings.test.ts`), after review round 2:

```
 Test Files  4 passed (4)
      Tests  184 passed (184)
```

(80 platform-tenants + 29 tenant-domains + 24 tenant-features + 51 admin-settings.)

Full suite (`npx vitest run`), last run 2026-09-27 17:34, with all six CP3 builders' work in the tree:

```
 Test Files  2 failed | 67 passed (69)
      Tests  37 failed | 2340 passed (2377)
```

All 37 failures are outside my files and have one cause. Checkout answers `404 Checkout not found` because CP3-E's legal-readiness gate is live in `checkout.ts`, and `test/slice-harness.ts` `createTenant` does not make shops legally ready (see "New in round 2, for the reviewer").
- `test/slice/failure-injection.test.ts`: 36 failed.
- `test/slice/vertical-slice.test.ts`: 1 failed.

`provision-tenants.test.ts`, `provision-users.test.ts` and `connect-onboarding.test.ts` now pass.

`npx tsc --noEmit`: clean (no errors in any file) at the last run.

Guard patterns: grepped all my files and this report for the three guard families; no match. The guard itself scans tracked files only, and mine are untracked until the reviewer commits them.

Not done or not tested:
- No staging run (not allowed).
- The importer's use of my tables is untested; that is CP3-S's side.
- No flag is enforced anywhere yet (wiring 6).
