claude-opus-5-5

# CP13 A1 — the affiliate program, server side (Worker: data, identity, seam, ledger, routes, mail jobs)

Worktree `.claude/worktrees/cp13-affiliate`, branch `cp13-affiliate`. All changes are in the working tree only: no git write, no deploy, no wrangler, no network. I read CP13_BRIEFS §0/§1/A1, CP13_AFFILIATE_DESIGN v2 in full, CODEX_AUDIT part B, REVIEW2, CP4 §0 rules 1–12, CP5 §0 rules 13–19, CP11 §0, and every file I touched.

**Where the design and the brief disagree, I followed the design.** Each case is listed in §6.

## 1. Gate (run at the end of round 1, on the final tree, with the reviewer's wiring applied)

```
cd cloudflare && npx tsc --noEmit            → clean
               npx tsc --noEmit -p web       → clean
               npx tsc --noEmit -p admin     → clean
               npx vitest run                → Test Files 152 passed (152) · Tests 5343 passed (5343)
node guard/guards.test.mjs (worktree root)   → 2676 tracked files scanned … guard: PASS
```

- Baseline before I started: 143 files / 5165 tests.
- The full suite was green after step 5 (148 / 5269), after the wiring (steps 6–11), at the end of the first pass (152 / 5332), and again after the round-1 fixes (above, +11 tests).
- **The guard only scans tracked files** (`git ls-files`), and my new files are untracked. I therefore grepped them by hand for the guard's patterns. One test string in affiliate-schema would have failed the guard once committed (a word one of the guard's pattern families forbids); it is now `"partner"`, and the suite was re-run.

New suites (vitest counts, after round 1):

| Suite | Tests |
|---|---|
| affiliate-schema | 49 |
| affiliate-migration | 3 |
| affiliate-identity | 14 |
| affiliate-seam | 17 |
| affiliate-ledger | 21 |
| affiliate-routes | 34 |
| affiliate-payouts | 17 |
| affiliate-clicks | 8 |
| affiliate-emails | 13 |
| **Total** | **176** |

Round 1 also added one test to the existing `checkout.test.ts`.

## 2. Files

### Created (`cloudflare/`)

**Migrations**
- `migrations/0058_affiliate_identity.sql`
- `migrations/0059_affiliate.sql`

**`src/affiliate/`**
- `terms.ts`
- `ledger.ts`
- `mail.ts` (extra module: the one place that writes outbox rows for affiliate mail)
- `affiliates.ts`
- `applications.ts`
- `approval.ts`
- `payouts.ts`
- `projections.ts`
- `clicks.ts`

**Routes and email**
- `src/routes/affiliate-storefront.ts`
- `src/routes/affiliate-portal.ts`
- `src/routes/affiliate-admin.ts`
- `src/email/affiliate-emails.ts`

**Tests**
- `test/affiliate-fixtures.ts`
- `test/affiliate-{schema,migration,identity,seam,ledger,routes,payouts,clicks,emails}.test.ts`

**Report**
- `docs/cf-port/CP13_A1_REPORT.md` (this file)

### Modified (`cloudflare/`)

**API, by area**
- Root: `src/app.ts`, inside the anchors `CP13-IMPORTS-A1` and `CP13-ROUTES-A1` only.
- Auth: `src/auth/{live-authorization,request-authorization,session-self}.ts`.
- Commerce:
  - `src/commerce/{discount-codes,checkout,discount-preview,webhook,refunds,stripe-events}.ts`
  - `src/commerce/{receipts,admin-orders,admin-order-list,admin-discount-codes}.ts`
- Email: `src/email/{auth-email-job,email-delivery-store,email-queue-consumer}.ts`.
- Outbox: `src/outbox/{email-effect,scheduled}.ts`.
- Platform: `src/platform/{invites,provision-users,tenant-config,tenant-members,user-directory,user-lifecycle}.ts`.
- SEO route: `src/routes/public-seo.ts`.
- Storage: `src/storage/{object-routes,object-store}.ts`.
- Storefront: `src/storefront/{public-storefront,public-routes}.ts`.

**Web and admin Workers**
- `web/src/{api-allowlist,index,seo}.ts`
- `admin/src/allowlist.ts`

**Existing tests and fixtures**
- `test/{tenant-features,platform-tenants,checkout-reminders-off-golden,checkout-reminders-storefront,onboarding-identity,checkout,discount-codes,admin-order-list,admin-session,refunds,webhook}.test.ts`
- `test/{discount-fixtures,dispatch-fixtures}.ts`

**Not touched:** `outbox/outbox.ts`, `effects.ts` and `nudge.ts`. The affiliate mails reuse the existing `email` effect type (see §8).

## 3. Migrations: what they do to existing rows

Neither migration changes the value of any existing row. The only rows written are copies, the one terms row, and the backfill.

### 0058_affiliate_identity.sql

| Object | What happens | Effect on existing rows |
|---|---|---|
| `identity_access` | Rebuilt: copy → drop → create (CHECK now admits `'affiliate'`, `status_change_id` kept) → copy back → `identity_access_type_status_idx` | Every row copied unchanged; the count is the same. Nothing else hangs on this table (no trigger, no FK into it); this is checked in affiliate-schema. |
| `tenant_features_key_allowlist_insert` / `_update` | Replaced so they admit `affiliate` | No row change. |
| `email_deliveries` | Rebuilt from the 0056 shape plus eight kinds (the brief's seven plus `affiliate_welcome`, which design §9 names). Its tenant-immutable trigger and indexes are re-created. | Every row copied unchanged. |

### 0059_affiliate.sql

**New, empty tables:** `affiliates`, `affiliate_applications`, `affiliate_click_days`, `affiliate_ledger`, `affiliate_payouts`, `affiliate_invoice_objects`. Every one has tenant scope with the immutable-`tenant_id` trigger.

**Seeded table:** `affiliate_terms_versions` gets one row: version `2026-10-22`, published at `2026-10-22T00:00:00.000Z`, sha256 `f075d79e…faec6 (A4 finalised the text; the version stays 2026-10-22, nothing deployed)`. That hash is `affiliateTermsSha256()` of `src/affiliate/terms.ts`; a schema test pins that they are equal.

**`checkouts` and `orders`:**
1. Add `discount_authority`, with a value CHECK only.
2. **Backfill:** `UPDATE … SET discount_authority = 'campaign' WHERE discount_code_id IS NOT NULL`. This is the only change to existing values: every checkout and order that already carries a Rabattkod id becomes `'campaign'`; every other row stays NULL.
3. Add the six `affiliate_*` columns. Their CHECKs tie them to the authority, and they are NULL on every existing row.
4. Add the coherence triggers (insert, and update of the id/authority/affiliate; message `discount authority is incoherent`). **Round 1:** they refuse an authority without an id, and an affiliate authority whose id is not the affiliate's. They ADMIT an id with a NULL authority, which is a legacy campaign id written by the pre-0059 Worker during the deploy window (see §10, item 1).
5. Add the freeze triggers (`checkout affiliate facts are frozen` / `order affiliate facts are immutable`).
6. Add the index `orders_tenant_affiliate_idx`.

affiliate-migration.test.ts replays 0058 and 0059 on a database that already holds a campaign-discounted checkout and order. It checks the backfill, and that the webhook still burns a checkout that was quoted before the migration. Since round 1 it also runs the OLD Worker's checkout INSERT and order INSERT (no authority column) after 0059. Both succeed, and the new webhook burns the legacy checkout.

**I could not count staging's rows** (no network). The affected sets are "every `identity_access` row", "every `email_deliveries` row" (copied), and "every checkout/order with `discount_code_id`" (backfilled).

### 0060_reserved_slug_affiliate.sql (round 3)

**Change:** 0042's `pages_reserved_slug_insert` and `pages_reserved_slug_update` are dropped and re-created under the same names and message, with `'affiliate'` added to the list. The list equals `RESERVED_PAGE_SLUGS` in `src/content/pages.ts`.

**The update trigger now fires only when the slug changes** (`NEW.slug IS NOT OLD.slug AND NEW.slug IN (…)`). For every row 0042 admitted this is the same rule, since none could already hold a reserved slug. It keeps a legacy `affiliate` row writable without letting any row move into the list.

**Existing rows are not touched.** A trigger never re-checks rows already in the table, so the migration cannot fail on them. A page a shop already named `affiliate` behaves like this:
- **It survives as it is** and stays listed in the admin.
- **Editing it works** as long as the body sends no slug, or sends the same one.
- **The API refuses only a body that names `affiliate` as the slug** (400 `slug_reserved`). Renaming it to any free slug works, and it can never be renamed back.
- **On the storefront:** while the shop's affiliate add-on is ON, the storefront's own `/affiliate` page answers that address, so the merchant's page is shadowed until renamed. With the add-on OFF it is served as before.

**Test:** `affiliate-migration` "0060 on a database holding a page a shop already named 'affiliate'" replays 0042's triggers, inserts such a page, and applies 0060. It then checks that the row is unchanged, title and same-slug updates pass, renaming away passes, and renaming back, a new `affiliate` page and `checkout` are all refused.

## 4. Route table

All money is integer öre and all rates are basis points in answers. The opaque 404 is `{ error: { code: "not_found", message: "Route not found" } }`. Every list is bounded (`limit` 1–100, default 50) and paged with an opaque `cursor`; a malformed query is a 400. Every answer is `Cache-Control: no-store`.

### 4.1 Storefront (public; web Worker allowlist rows added)

The principal is anonymous, on the shop's storefront host. Both routes answer the opaque 404 when the shop is not public or its `affiliate` add-on is OFF.

| Method | Path | Request | Answers |
|---|---|---|---|
| POST | `/v1/affiliate-applications` | `{ name, email, phone?, socials?: {website?, instagram?, youtube?, facebook?, tiktok?}, promotionMethod, message? (≤2000), preferredLang: "sv"\|"en", termsVersion, termsAccepted: true }`, body ≤ 16 KB | **202** `{ applicationId }`, always after validation, including for an address that already has a pending application here (nothing stored or sent; the id names no row) · **400** `invalid_request` (malformed body, or not the current terms version) · **404** opaque (any method but POST, no public shop, add-on OFF) · **429** `rate_limited` + `Retry-After` (5/h per visitor, checked before the body is read; 20/day per shop) |
| GET | `/v1/affiliate-terms` | — | **200** `{ terms: { version, publishedAt, sha256, text } }`, rendered for the shop at 15 % / 10 % · **404** opaque |

The API also accepts `GET /v1/seo?path=…&ref=CODE` (an internal route, called by the web Worker only). The answer is exactly the answer without `ref`. Two `ref` parameters is a 400, like any other malformed query.

### 4.2 Portal (admin host; the admin Worker forwards `/_api/v1/affiliate/*`)

**Principal:** `authorizeAffiliateRequest`. The session must hold an ACTIVE `affiliate` identity and an active `affiliate` membership of the shop named by X-Shop-Id, and that shop must be active. There is no acting-as. Every non-GET must be same-origin, checked before the body is read. Anyone else, including a shop admin's session, gets the opaque 404.

The portal is gated on the **membership, not the add-on**: with the program OFF, an affiliate still logs in, reads the ledger and requests a payout (A12).

| Method | Path | Request | Answers |
|---|---|---|---|
| GET | `/v1/affiliate/me` | — | 200 `{ affiliate: PortalMe }`. Fields: `affiliateId, code, name, email, phone, address{line1,line2,postalCode,city,country}, socials, preferredLang, status, commissionBp, discountBp, currency, balance: AffiliateBalance, clicksByDay[{day,count}], links{refLink}, payoutBlockers[], programActive, shop{name,supportEmail}, terms: TermsState`. `PayoutBlocker` is `"nothing_payable" \| "payout_open" \| "profile_incomplete" \| "terms_required"`. |
| GET | `/v1/affiliate/orders?cursor&limit` | — | 200 `{ orders: [{ orderNumber, paidAt, baseMinor, commissionMinor, currency, state: "held"\|"payable"\|"reversed"\|"none" }], nextCursor }`. No buyer field and no order id; self-referrals are excluded in SQL. |
| GET | `/v1/affiliate/ledger?cursor&limit` | — | 200 `{ entries: [LedgerEntryView], nextCursor }`, where `LedgerEntryView` is `{ entryId, kind, amountMinor, currency, availableAt, orderNumber, reason, createdAt }`. |
| GET | `/v1/affiliate/payouts?cursor&limit` | — | 200 `{ payouts: [{ payoutId, status: "requested"\|"paid"\|"void", amountMinor, currency, requestedAt, paidAt, reference, invoiceNumber, hasInvoice, voidedAt, voidReason }], nextCursor }` |
| POST | `/v1/affiliate/payouts` | `{ amountMinor? (defaults to the whole payable), invoiceObjectId?, invoiceNumber? }` | 201 `{ payout }` · 409 `payout_open \| insufficient_balance \| profile_incomplete \| terms_required \| invalid_invoice` · 400 |
| GET | `/v1/affiliate/payouts/:payoutId/invoice` | — | 200, the PDF as a download (attachment) · 404 when the payout is not this affiliate's or has no invoice. Since round 1, the payout → affiliate check is the ownership, so a document the shop attached when recording the payout is served too. |
| — | (no `marketingMaterials` flag) | — | `PortalMe` carries no `marketingMaterials` flag. That add-on is not ported on the Cloudflare side, so the portal's Material page stays out until it is (round 2). |
| PATCH | `/v1/affiliate/profile` | `{ name?, phone?, addressLine1?, addressLine2?, postalCode?, city?, country?, socials?, preferredLang? }` | 200 `{ affiliate: PortalMe }` · 400 (any other key, e.g. code, rates, status) |
| GET | `/v1/affiliate/terms` | — | 200 `{ terms: { version, publishedAt, sha256, text, accepted } }`, rendered at the affiliate's own rates |
| POST | `/v1/affiliate/terms/accept` | `{ version }` | 200 `{ terms: {…, accepted: true} }` · 409 `terms_changed`. Writes audit `affiliate.terms_accept` with the text's hash. |
| POST | `/v1/affiliate/objects` | `{ contentType: "application/pdf", sha256, sizeBytes ≤ 10 MB, fileName? }` | 201 `{ object: { objectId } }` · 400 · 409 `too_many_pending_invoices` (the affiliate already has 5 loose invoices, meaning pending or attached to no payout; decided inside the reservation batch) · 429 `rate_limited` (20 reservations a day per affiliate, refused ones included, counted before the body is read) |
| PUT | `/v1/affiliate/objects/:objectId/content` | the PDF bytes (`content-length` required) | 200 `{ object: { objectId, status, sizeBytes, sha256 } }` · 400 `invalid_request` + `reason` (`type_not_as_stated` when the bytes are not `%PDF-`, or `bytes_not_as_declared`) · 404 (not this affiliate's object) · 409 conflict (already active) · 413 |

### 4.3 Shop admin (admin host)

**Principal:** the tenant admin of X-Shop-Id, or a platform user acting as that admin (audited with the grant). Anyone else, including an affiliate's session, gets the opaque 404. Every state change must be same-origin.

**[gated]** marks routes that answer the opaque 404 while the add-on is OFF. The ungated routes stay open so that liabilities can still be settled.

Rates go IN as whole percent (`commissionPercent`, `discountPercent`, 0–100) and come OUT as bp.

| Method | Path | Request | Answers |
|---|---|---|---|
| GET | `/v1/admin/affiliates?status&cursor&limit` [gated] | — | 200 `{ affiliates: [{ affiliateId, code, name, status, commissionBp, discountBp, currency, clicks30d, conversions30d, earnedMinor, payableMinor, createdAt }], nextCursor }` |
| POST | `/v1/admin/affiliates` ("Bjud in") [gated] | `{ name, email, code?, commissionPercent?, discountPercent?, preferredLang? }` | 201 `{ affiliate: AdminAffiliateDetail, invited, inviteError?, mailConfigured }`. `inviteError` is `"email_unavailable" \| "not_invitable"`: the admission committed but its invite could not be queued, so re-send it. · 409 `code_taken \| not_addable \| already_affiliate` · 400 (`reason` `code_invalid \| code_reserved`) · 429 (20/h per shop, 3/h per address) · 503 `email_unavailable` |
| GET | `/v1/admin/affiliates/applications?status&cursor&limit` [gated] | — | 200 `{ applications: [ApplicationView], nextCursor }`, pending first, then newest. `ApplicationView` is `{ applicationId, status, name, email, phone, socials, promotionMethod, message, preferredLang, termsVersion, termsAcceptedAt, decidedAt, decisionReason, affiliateId, createdAt }`. |
| GET | `/v1/admin/affiliates/applications/:applicationId` [gated] | — | 200 `{ application }` |
| POST | `/v1/admin/affiliates/applications/:applicationId/approve` [gated] | `{ code?, commissionPercent?, discountPercent? }` (defaults 15 / 10) | 201 `{ affiliate, application, invited, inviteError?, mailConfigured }` · 409 `already_decided \| code_taken \| not_addable` · 400 · 503 (only before anything is written) |
| POST | `/v1/admin/affiliates/applications/:applicationId/deny` [gated] | `{ reason }` (1–500) | 200 `{ application }` · 409 `already_decided` · 400 |
| GET | `/v1/admin/affiliates/analytics?since` [gated] | — | 200 `{ analytics: { since, currency, activeAffiliates, clicks, conversions, commissionMinor, unpaidMinor, ranking[{affiliateId, code, name, clicks, conversions, commissionMinor}] } }` |
| GET | `/v1/admin/affiliates/:affiliateId` | — | 200 `{ affiliate: AdminAffiliateDetail }`. Fields: `account{invited, membership}, address, affiliateId, applicationId, balances[AffiliateBalance], clicksByDay, code, commissionBp, conversions, createdAt, currency, discountBp, email, links{portalUrl, refLink}, name, phone, preferredLang, programOn, promotionMethod, reversedMinor, socials, status, terms`. |
| PATCH | `/v1/admin/affiliates/:affiliateId` | `{ status?: active\|inactive\|suspended, code?, commissionPercent?, discountPercent?, name?, phone?, addressLine1?, addressLine2?, postalCode?, city?, country?, socials?, promotionMethod?, preferredLang? }` | 200 `{ affiliate }` · 409 `code_taken \| not_addable` · 400. Setting `active` re-activates a membership that "Ta bort" REVOKED; one the platform suspended stays suspended. A refused edit writes no audit row. |
| POST | `/v1/admin/affiliates/:affiliateId/invite` (re-send) [gated] | — | 202 `{ mailConfigured }` · 409 `not_invited` (the person already has a password) · 429 · 503 |
| POST | `/v1/admin/affiliates/:affiliateId/revoke` ("Ta bort") | — | 200 `{ affiliate }`: status `inactive` and membership revoked; nothing is deleted |
| POST | `/v1/admin/affiliates/:affiliateId/adjustments` | `{ amountMinor (≠ 0), reason }` | 201 `{ entry: LedgerEntryView }` |
| GET | `/v1/admin/affiliates/:affiliateId/ledger?cursor&limit` | — | 200 `{ entries, nextCursor }` |
| GET | `/v1/admin/affiliates/:affiliateId/orders?cursor&limit` | — | 200 `{ orders: [{ orderId, orderNumber, paidAt, totalMinor, currency, attribution: "link"\|"code", affiliateCommissionMinor, selfReferral, state }], nextCursor }` |
| GET | `/v1/admin/affiliates/:affiliateId/payouts?cursor&limit` | — | 200 `{ balances[AffiliateBalance], payouts[PayoutView], nextCursor }`. `PayoutView` is the portal shape plus `invoiceObjectId` and `notes`. |
| POST | `/v1/admin/affiliates/:affiliateId/payouts` (record a payment) | `{ amountMinor, invoiceNumber?, invoiceObjectId?, reference?, notes? }` | 201 `{ payout }`, recorded as requested and paid at once · 409 `payout_open \| insufficient_balance \| invalid_invoice` |
| POST | `/v1/admin/affiliates/payouts/:payoutId/paid` | `{ reference?, notes? }` | 200 `{ payout }` · 409 `payout_not_open` |
| POST | `/v1/admin/affiliates/payouts/:payoutId/void` | `{ reason }` | 200 `{ payout }` · 409 `payout_not_open` |

`AffiliateBalance` is `{ currency, balanceMinor, earnedMinor, heldMinor, paidMinor, requestedMinor, payableMinor }`, one per currency.

### 4.4 Changed existing answers

- **Checkout (`POST /v1/checkouts`) and discount preview** accept `refCode?`, with the same grammar as `discountCode`. The answer gains `overriddenBy: "link"` only when a typed code lost to the link. `discountCode` echoes the link's code when the link authorized the discount.
- **The preview's `code` is now optional.** A body with only `refCode` resolves.
- **Admin order detail and list** each gain an `affiliate` member, `null` or `{ attribution, code, affiliateCommissionMinor, ledgerState, selfReferral }`.
- **The order's discount label** is `CASE WHEN o.discount_minor > 0 THEN COALESCE(campaign code, o.affiliate_code) END`, in the admin order, receipts and order mails. Since round 1, a 0-öre affiliate attribution shows no label.
- **`GET /v1/me`** serves `accountType: "affiliate"`, with memberships of role `affiliate` only.
- **The storefront body** gains `features.affiliate`; `STOREFRONT_BODY_REVISION` goes 3 → 4.

**Round 2 additions:**
- **`affiliateId`** on the admin order `affiliate` member (detail and list). It is `o.affiliate_id`, so the order pill can link to `/admin/affiliates/:id` (design §4.5). It is the shop's own affiliate's id, not a buyer field, and the portal's order row still has no id.
- **`adminOrigin`** on `GET /v1/storefront`. It is the canonical ADMIN origin from `readCanonicalOrigins(env)` (the source the invite links use), or `null` when the allowlist names none, for the footer's "Logga in som affiliate". Only that one origin string is answered; no other member of `CanonicalOrigins` leaves. A test proves the api and web origins are absent. `STOREFRONT_BODY_REVISION` goes 4 → 5.
- **The Rabattkoder create/rename** answers 409 `conflict` when the code collides with an affiliate's code.

## 5. Invariants touched in webhook.ts / refunds.ts / stripe-events.ts / checkout.ts, and why each still holds

### checkout.ts

- **Idempotent replay (`matchesExisting`):** it now also compares the authority, the affiliate id, code, attribution, both rates and the self-referral verdict. A re-rated affiliate, or a different affiliate with the same discount, is a different quote. A replay with identical facts still matches. `loadExisting` selects the seven columns, so the comparison reads what was frozen.
- **Legacy rows (round 1):** a stored NULL authority beside an id is compared as `'campaign'`. A key first used against the old Worker in the deploy window therefore still replays.
- **Totals and VAT parity:** the discount amount still comes from one resolver, against the same line snapshots and subtotal. An affiliate's discount is a percent of the same base a campaign percent uses, so the existing total-parity tests pass unchanged.
- **Holds (0055):** a use is held only when `authority === 'campaign'`. An affiliate code is uncapped and its id is not a `discount_codes` row, so it never touches `discount_code_holds`.
- **"Worthless code stores no id" (checkpoint 22):** unchanged for campaigns. For an affiliate that no longer applies, the id, authority and facts stay frozen with a discount of 0 (R2-8; 0010's CHECK admits an id beside a zero discount). That is how the affiliate keeps attribution on an undiscounted base.
- **Feature gates:** each family is gated by its own add-on. The old early return on `discountCodes` alone is gone, so an affiliate-only shop resolves (design §2.2). With `discountCodes` OFF, a typed campaign code is still worthless.
- **Freeze:** the facts are written in the INSERT and frozen by the 0059 trigger from then on; no UPDATE path writes them.
- **Self-referral:** decided at quote time from the address the checkout freezes, and never re-decided later.

### webhook.ts

- **One batch or nothing:** the accrual (`INSERT … SELECT FROM orders … WHERE NOT EXISTS`) and its outbox row are appended to the same batch as the order. A replayed event is still a no-op: there is no new order row, and NOT EXISTS holds the ledger row too.
- **Facts copied verbatim:** the seven facts go from the checkout onto the order and are never re-resolved. The order's own coherence and freeze triggers check them again.
- **Burn gate:** `discount_code_id !== null && discount_authority !== 'affiliate'`. This is `IS NOT 'affiliate'`, never `= 'campaign'`, so a pre-0059 id without an authority burns exactly as before. affiliate-migration replays a pre-deploy checkout through the webhook to prove it.
- **No accrual when:** the order is a self-referral, the authority is not `affiliate`, or the commission comes to 0 öre.
- **The formula cannot abort the order (round 1):** `guardedAccrual` catches `commissionMinor`'s `RangeError`. It writes no accrual and puts a critical `affiliate_accrual_failed` money alert into the same order batch instead.
- **The order's money columns** (charged, fee, withheld, payout state) are untouched. **The seller still sees one platform-fee number**: the commission is a liability between the shop and its affiliate. It is not a platform deduction and it is not in the fee.

### refunds.ts (`orderEffectStatements`)

- **Placement and guard:** the reversal is inserted right after the money UPDATE and guarded on the same transition stamp (`refund_operations.id + transition_id`). It fires exactly when this batch performed the transition.
- **Key:** it is keyed on the transition id. Each state change gets its own row, so `succeeded → failed` writes a positive restoration.
- **Inputs:** it reads the updated `refund_succeeded_minor`, never `orders.status`.
- **Unchanged parts:** the full-refund dispatch stop and the status statements keep their order relative to the money. An order without an accrual writes nothing.
- **A displaced or ledger-less order cannot fail the refund batch.** The INSERT selects zero rows when there is nothing to reverse, and the displacement trigger only fires on a real row.
- **Test:** a refund on an order with a lost-dispute reversal still commits (affiliate-ledger).

### stripe-events.ts (`applyDisputeFact`)

- **Batch:** the orders UPDATE is now statement 1 of a batch, with the lost reversal and its mail after it. The function still reads `changes` from statement 1, so `applied` / re-read behaves as before.
- **Reversal guard:** the stored post-state, meaning this order's `dispute_id` is this dispute and its `dispute_status` is `'lost'`. It is never guarded on the recovery value the UPDATE just changed.
- **Idempotent:** the ref is the dispute id, so a redelivery or a lost fact applied twice writes one row.
- **Lost dispute dominates:** the cumulative formula's `lost` branch reverses the whole remaining accrual whatever the refunds did. A later refund failure does not undo it (tested).

## 6. Decisions beyond, or against, the brief

1. **Design over brief:**
   - The storefront form is at `/v1/affiliate-applications` (design §7.1), not §5.1's `/v1/affiliate/apply`: R2-20 reserves `/v1/affiliate/*` for the portal.
   - The terms module is `src/affiliate/terms.ts` (§8), not `src/config/affiliateTerms.js` (§3.3).
   - The brief's "admin.ts routing.ts" is in fact `admin/src/allowlist.ts`.
2. **`affiliate_welcome`** is an email kind. Design §9 names it; the brief's list of seven omits it.
3. **The terms columns on `affiliates` are nullable as a pair.** An invited affiliate has accepted nothing. The portal asks first, and a payout requires the current version (`terms_required`).
4. **Decision-stamp columns:** `affiliates.change_id` and `affiliate_applications.decision_id`. Every audit and mail row of a decision is guarded on this batch's own stamp, so a lost race writes no audit or mail.
5. **Extra routes** `adjustments` and `revoke` ("Ta bort"). The design has both actions; I gave them their own routes.
6. **Re-approval of a removed affiliate** re-activates its existing row with the new code and rates (UNIQUE tenant+user; R2-26).
7. **Converting an unaccepted affiliate identity** (tenant-members invite or platform provisioning) also makes that person's affiliate rows `inactive` and revokes their memberships. Audit: `identity.convert_unaccepted_affiliate`.
8. **Clicks:**
   - The SEO handler does not count a forward. The web Worker keeps `ref` on the Location, and the landing it leads to counts once.
   - `CP13-ROUTES-A1` re-registers `GET /v1/seo` ahead of CP4-ROUTES-D, to hand it `waitUntil`. The older registration is now unreachable.
9. **Rate-limit decisions:**
   - The application form's limits run BEFORE validation, and every admitted request counts.
   - The invite limits reuse the members' bucket sizes (20/h per shop, 3/h per address).
10. **Payout amount defaults to the whole payable;** `MAX_PAYOUT_MINOR` is 1 000 000 kr (a typo guard). The `affiliate_payout` mail covers both `paid` and `void` (`outcome`).
11. **The commission formula** rounds by quotient and remainder (half-up) so that it never overflows. It throws a `RangeError` beyond the exact range rather than answer.
12. **The analytics `since`** is bounded, and the ranking is computed in the shop's currency.

## 7. What was NOT done

- **No pages:** admin, portal and storefront are A2/A3.
- **Reviewer wiring, now applied by the reviewer:** `REQUIRED_MIGRATION` (0059), the `refCode` attempt limiter in `handleCheckoutRoute`, the shadowed CP4-ROUTES-D SEO registration, the two stale comments, and the 0059 pins in `health` / `public-catalog`.
- **The storefront client** does not yet send `refCode` or show the form (A2/A3).
- **Final email copy** is A4. The templates are minimal sv/en and pass the parse/render/fingerprint tests.
- **The A4 sweep** of reserved invoices that never land (they stay `pending` and are never served) is not built.
- **No Stripe Connect payout rail:** `rail` is always `manual` (A5).
- **I could not run against staging** (no network), so the row counts in §3 are reasoned from the SQL, not measured.

## 8. Open questions

1. **Outbox event type:** affiliate mails reuse `eventType: 'email'`. Conversion and reversal rows sit on aggregate `order`, so `pendingOrderMailIds` picks them up with the order's other mails. A separate effect type would need `outbox.ts` and `effects.ts`; I judged the reuse cleaner, but the reviewer may prefer a type of its own.
2. **Terms hash:** `affiliate_terms_versions` seeds the sha of the current template. If A4 edits the template text, it must either bump the version or update 0059's seeded sha in the same change; a schema test fails otherwise.
3. **Self-referral is excluded from the portal entirely.** It is shown to the shop with 0 commission. Confirm that this is the intended product behaviour.

## 9. Reviewer wiring

**Round 3:** `REQUIRED_MIGRATION` is now **`0060_reserved_slug_affiliate.sql`** in `src/app.ts`, with `test/health.test.ts` and `test/public-catalog.test.ts` pinned to it. I made this change myself because the round-3 brief named these files.

**Applied by the reviewer in round 1:**
- `REQUIRED_MIGRATION` = `0059_affiliate.sql`, with `health` and `public-catalog` pinned to it.
- `handleCheckoutRoute` counts a `refCode` against `DISCOUNT_ATTEMPT_*`. My test for it is in `checkout.test.ts`, "counts a link-code-only checkout…".
- The shadowed CP4-ROUTES-D `/v1/seo` registration is removed.
- The two stale doc comments are fixed.

**Still true:**
- **`wrangler.jsonc`, `env.d.ts`, `vitest.config.ts`:** no changes needed. There is no new binding.
- **Allowlist rows:** web `POST /v1/affiliate-applications` and `GET /v1/affiliate-terms`; admin prefix family `["v1", "affiliate"]`.
- **Scheduled:** `affiliate_application_retention`.
- **New in round 1:**
  - money-alert kind `affiliate_accrual_failed`. The `alerts.kind` column has no enum, so this needs no migration.
  - rate-limit scope `affiliate-invoice`.
- **Guard:** run it again after committing. It only sees tracked files; my grep of the untracked files finds nothing.

## 10. Round 1 fixes

Each fix lists the change and the test that covers it.

### MUST

1. **Deploy window (0059 coherence triggers).**
   - **Change:** all four triggers (checkouts and orders, insert and update) now fire on `authority NOT NULL AND id IS NULL` or on `authority = 'affiliate' AND id IS NOT affiliate_id`. An id with a NULL authority is admitted as a legacy campaign id, and the migration's header comments say why.
   - **Also:** `matchesExisting` reads NULL-with-id as `'campaign'`, so a replay across the window does not conflict.
   - **Tests:**
     - `affiliate-migration` "the deploy window: the OLD Worker's checkout and order INSERTs (no authority column) succeed, and the burn fires". Both old-shape INSERTs succeed, the new webhook pays the legacy checkout, its order keeps NULL authority, `used_count` becomes 1, and there is no ledger row.
     - `affiliate-schema` now accepts an id without an authority, and still refuses an authority without an id and a mismatched affiliate id.
2. **Bounded invoice storage.**
   - **Loose-invoice cap:**
     - `reservePendingObject` takes an optional in-batch `guard`. With it, the object INSERT is `INSERT … SELECT … WHERE guard`, the reserve audit row follows only when the INSERT wrote (`changes() > 0`), and the result is `refused`.
     - `reserveAffiliateInvoice` passes "fewer than 5 loose invoices" (listed for the affiliate, not deleted, and pending or referenced by no payout). It also guards its own `affiliate_invoice_objects` INSERT on the object row existing.
     - The route answers 409 `too_many_pending_invoices`.
   - **Daily limit:** the durable limiter `affiliate-invoice` (key = affiliate id) allows 20 a day, before the body is read.
   - **Tests:** `affiliate-payouts`
     - "at most 5 loose invoices …": an attached invoice does not count, and the 6th writes no object, audit or listing row.
     - "20 reservations a day per affiliate …": the 21st is a 429 with `Retry-After`.
3. **An invite that fails after the admission committed.**
   - **Change:** `admit` returns `ok` with `invited: false` and `inviteError: "email_unavailable" | "not_invitable"`; the route answers 201 with it. A post-commit failure is never a 503 or `not_addable`. A 503 can now come only from pre-commit checks.
   - **Test:** `affiliate-routes` "an invite that fails AFTER the admission committed …" covers approve (queue send throws, 201, membership active, then a working re-send answers 202 and queues one job) and "Bjud in".

### SHOULD

4. **No relay of applicant text.**
   - **Change:** `affiliate_application_received` carries only `shopName` and `supportEmail` and greets with "Hej!" / "Hi!". The shop-facing notice keeps the name.
   - **Beyond the finding:** I also removed `applicantName` from `affiliate_application_denied`. A shop will deny exactly the spam applications, and that mail goes to the address the applicant typed, so it has the same relay shape.
   - **Test:** `affiliate-emails` "an application: …" checks that the received job and its render contain none of the applicant's name, message or method, and that the notice still has the name.
5. **Discount label only when money was taken off.**
   - **Change:** `CASE WHEN o.discount_minor > 0 THEN COALESCE(…) END` in `receipts.ts`, `admin-orders.ts` and `email-effect.ts`.
   - **Test:** `affiliate-payouts` "a 0-öre affiliate attribution shows no discount label …" checks that the receipt and admin order totals have `discountCode: null`, that a discounted order still shows `PROJ10`, and that the attribution itself is still shown.
6. **The `affiliate.update` audit is stamped.**
   - **Change:** the UPDATE sets `change_id`, and the audit row (and the membership re-activation) select on that stamp.
   - **Test:** `affiliate-routes` "an edit the identity guard refuses writes no audit row" (suspended identity, PATCH `active` gives 409 `not_addable` and 0 audit rows). The pre-fix code wrote one.
7. **Re-activation only of a revoked membership.**
   - **Change:** `status = 'revoked'` replaces `status <> 'active'`.
   - **Test:** `affiliate-routes` "'Aktiv' re-activates a membership 'Ta bort' revoked, never one the platform suspended". The existing "Ta bort … 'Aktiv' restores both" still passes.
8. **The portal serves the shop's own document on the affiliate's payout.**
   - **Change:** `deliverAffiliateInvoice` requires the payout to be this affiliate's and to name an object; the listing join is gone from READ only. The request path keeps the listing check.
   - **Test:** `affiliate-payouts` "a payout the shop recorded with ITS OWN document …". The affiliate downloads it, another affiliate gets a 404, and another affiliate cannot attach a shop document to a request (`invalid_invoice`).
9. **The accrual cannot abort the order.**
   - **Change:** `guardedAccrual` in `webhook.ts`, plus `affiliate_accrual_failed` in `MoneyAlertKind`.
   - **Test:** `affiliate-ledger` "out of range: no accrual statement, a critical affiliate_accrual_failed alert instead". It does not throw, the alert row is written, and the in-range case returns 5 400 with no alert.
10. **The grant on the invoice freeze.**
    - **Change:** `reserveStatements`' actor carries `actingAsGrantId`: `principal.actingAs?.grantId` for `recordPayout` (TenantAdminPrincipal), null for the affiliate's own request. The freeze's audit row records it through the object store's existing metadata rule.
    - **Unchanged:** `affiliateTenantOf` (object-routes) stays null, because an AffiliatePrincipal has no grant.
    - **Test:** `affiliate-payouts` "a platform user acting as the shop records a payout: the invoice freeze's audit row names the grant", which also checks that the affiliate's own freeze has no grant.

### Missing tests the reviewer named

- **(a) `/v1/affiliate/me` against the denylist:** `affiliate-payouts` "/v1/affiliate/me: exactly its keys …". `me` necessarily carries the affiliate's OWN name, e-mail, phone and address and the shop's contact; those are the denylist's words, so a raw walk cannot pass. The test therefore pins the exact key set (no unwalked key can appear), checks that the e-mail is the affiliate's own, walks every other member against the denylist, and checks that no buyer address appears anywhere.
- **(b) refCode-only checkout against `DISCOUNT_ATTEMPT_*`:** `checkout.test.ts` "counts a link-code-only checkout (refCode, no typed code) against the discount-attempt limit (CP13)". A plain checkout adds no attempt; a `refCode`-only one adds exactly one.

### Disagreements

None with the findings as stated. Item 4 goes slightly further than asked (the denied mail too), and the (a) test is adapted as described.

### Noted, no change

- **Review #10:** payouts exist only in `affiliates.currency`, the known R2-11 limit. Balances are per currency, but a request reserves in the affiliate's currency only. An accrual in another currency stays in the balance and is visible, but cannot be requested until a per-currency payout exists.
- **Review #12:** converting an unaccepted affiliate (tenant-members invite, platform provisioning) commits before the invite flow. Accepted: if the invite then fails, the person is a tenant admin without a link, and the existing members re-send path applies, exactly as for any admin invite.
- **Review #14:** a counted landing costs two writes (limiter window and click day). Accepted.

### Round 2 (contract fixes for A2/A3)

1. **`affiliateId` on the admin order member.**
   - **Change:** `src/affiliate/projections.ts`. `ORDER_COMMISSION_COLUMNS` selects `o.affiliate_id`, and `OrderAffiliateView` / `orderAffiliateView` answer it as `affiliateId`. It flows through `admin-orders.ts` and `admin-order-list.ts` unchanged.
   - **Test:** `affiliate-payouts` (admin order detail) pins `affiliateId`, and the denylist walk of that member stays green. No admin-order suite pinned the member with `toEqual`, so none needed editing.
2. **`adminOrigin` on the storefront body.**
   - **Change:** `src/storefront/public-storefront.ts` answers `adminOrigin: readCanonicalOrigins(env)?.admin ?? null`. `src/storefront/public-routes.ts` bumps `STOREFRONT_BODY_REVISION` from 4 to 5.
   - **Test:** `test/public-storefront.test.ts` pins the member in the allowlisted-body test. A new test proves the admin origin is answered, the api and web origins are not, and the value is `null` with an allowlist that names no admin.
   - **Three other pins also had to follow the bump** for the gate to pass. They are files I had already touched in A1, and only the pinned values changed:
     - `test/checkout-reminders-storefront.test.ts` (revision 5)
     - `test/onboarding-identity.test.ts` (revision 5)
     - `test/checkout-reminders-off-golden.test.ts` (the golden body gains `adminOrigin`)
3. **Report only:** §4.2 notes that `PortalMe` has no `marketingMaterials` flag.

**Gate after round 2:**
- `cd cloudflare && npx tsc --noEmit` → clean.
- `npx vitest run` → Test Files 153 passed (153) · Tests 5367 passed (5367). The file count includes suites other units added to the tree.

### Round 3 (reserved slug `affiliate`, design §7.1)

**Change:**
- `src/content/pages.ts`: `RESERVED_PAGE_SLUGS` gains `"affiliate"`.
- New migration `migrations/0060_reserved_slug_affiliate.sql` replaces the triggers **`pages_reserved_slug_insert`** and **`pages_reserved_slug_update`** with `'affiliate'` added (behaviour on existing rows: §3).
- `REQUIRED_MIGRATION` and the `health` / `public-catalog` pins move to 0060.

**Tests:**
- `test/pages.test.ts` needed no edit. It enumerates `RESERVED_PAGE_SLUGS`, so the schema test (insert and update refused, trigger list read back from `sqlite_master` equal to the code's) and the route test (400 `slug_reserved`) now cover `affiliate` automatically.
- `test/affiliate-schema` lists no migrations.
- One new replay test is in `affiliate-migration` (§3).

**Gate after round 3:**
- `cd cloudflare && npx tsc --noEmit` → clean.
- `npx vitest run` → Test Files 154 passed (154) · Tests 5378 passed (5378). The counts include suites other units added to the tree.
- **Transient failures:** one earlier run caught three failures in `affiliate-emails` (A4's "final copy" tests) and in `affiliate-schema`'s terms-hash test, while A4 was editing `terms.ts` and `affiliate-emails.ts` mid-run. The immediate re-run on the settled tree was fully green. Nothing in round 3 touches those files.

