# CP13 — Codex review of the whole branch (A1–A4)

Date: 2026-10-23 07:32 · Model: gpt-6-astra (reasoning medium) via `codex exec`, read-only, on `cp13-affiliate` HEAD `63ab39d2` (code `3c821986`), reviewing `git diff cf-port...HEAD`. Verdict: **PASS WITH FIXES** — findings 1 and 2 blocking; the fix round is recorded in the unit reports (A1 round 4, A3 round 2). The prompt is at the end.

---

**Verdict: PASS WITH FIXES. Findings 1 and 2 block merge.** No blocker-level defect found.

Reviewed read-only against `git diff cf-port...HEAD`. No network, tests, builds, file edits, or git writes. I independently computed the terms hash; it matches migration 0059: `bff6a1379f0ee0ddfb10d8d14879ae8ca5c0b801c8a10fe475a4b435550fc2b3`.

| # | Severity | Finding | Primary location |
|---|---|---|---|
| 1 | **High — blocking** | The cart discards typed commission-only affiliate codes, losing attribution and commission | `src/storefront/providers/Cart.jsx:363` |
| 2 | **High — blocking** | Approval/re-invitation can reactivate a suspended affiliate membership | `cloudflare/src/affiliate/approval.ts:485` |
| 3 | Medium | Admin earnings and reversal totals combine different currencies | `cloudflare/src/affiliate/projections.ts:512` |
| 4 | Medium | Reserving the top-level `affiliate` segment breaks an existing shop with that ID | `cloudflare/web/src/shop-segment.ts:27` |
| 5 | Medium | An upload completing after the sweep can leave permanently orphaned invoice bytes | `cloudflare/src/storage/object-routes.ts:1037` |
| 6 | Medium | Portal links specify `shopId`, but the portal ignores it | `src/admin-app/AffiliateApp.jsx:315` |

**Finding details**

**1. Typed 0% buyer-discount codes never reach checkout.**

At `src/storefront/providers/Cart.jsx:363`, `applyDiscountCode()` saves the typed code only when the preview outcome is `applies`. However, `cloudflare/src/commerce/discount-preview.ts:152` deliberately returns the ordinary non-applying answer when the discount is zero.

Concrete failure:

1. An affiliate has `discount_bp = 0`, `commission_bp = 1500`.
2. A buyer arrives without a referral link and types that affiliate’s code.
3. Preview returns `applies: false`.
4. The cart returns failure without storing the code.
5. Checkout receives neither code nor attribution. The affiliate earns nothing.

The server supports this case correctly; the storefront prevents it from occurring. This violates both “typed affiliate earns” and “attribution is independent of discount amount.”

**Fix:** Preserve a syntactically valid typed code after a successful preview response even when its monetary discount is zero, and send it to checkout. Keep the preview’s no-oracle contract: do not introduce an affiliate-existence flag to distinguish valid zero-discount codes from unknown codes. The UI can truthfully say that no discount is currently applied.

**2. The suspension fix missed the admission path.**

`cloudflare/src/affiliate/approval.ts:483` updates existing affiliate memberships using:

```sql
status <> 'active'
```

That includes `suspended`. The identity guard checks the global identity’s status, not the membership’s status.

Concrete failure: an affiliate has an active identity but a suspended membership in shop A. A fresh application for the same address is approved. The admission batch changes the membership to `active`, restoring portal access. The manual invitation path can do the same when the program row is inactive.

The earlier review explicitly fixed this in the edit path, and `cloudflare/test/affiliate-routes.test.ts:463` tests that PATCH preserves suspension. Approval still bypasses that protection.

**Fix:** Restrict membership restoration to `status = 'revoked'`, consistently with the edit path. Preserve suspended memberships through approval and invitation, and test both paths with an existing session.

**3. Admin financial projections mix currencies.**

Two sums lack a currency predicate:

- `cloudflare/src/affiliate/projections.ts:512`: `adminAffiliateList()` sums all accruals and reversals into `earnedMinor`.
- `cloudflare/src/affiliate/projections.ts:662`: `adminAffiliateDetail()` sums all reversals into `reversedMinor`.

The UI then formats these as one currency:

- `src/pages/admin/AdminAffiliates.jsx:180`
- `src/pages/admin/AdminAffiliateEdit.jsx:433`

Concrete failure: an affiliate whose frozen currency is SEK earns 10,000 minor units in SEK and 10,000 in EUR. The list reports 200.00 SEK earned. Reversals suffer the same error. Checkout derives currency from the purchased lines, so the ledger can contain multiple currencies.

The payout guard itself remains currency-scoped; this is misleading financial reporting, not a demonstrated cross-currency payout.

**Fix:** Filter these scalar sums to the currency they claim to represent, or return totals grouped by currency. Add mixed-currency projection tests. This is separate from the already acknowledged limitation that payouts support only the affiliate’s frozen currency.

**4. The new top-level reservation can remove an existing shop from the shared host.**

`cloudflare/web/src/shop-segment.ts:27` newly rejects `affiliate` as a shop segment. Consequently:

- `/affiliate/...` becomes `no_shop`.
- `/_api/affiliate/v1/...` becomes `api_refused`.

Both decisions occur in `cloudflare/web/src/routing.ts` before tenant resolution.

Concrete failure: a populated database contains tenant ID `affiliate`, previously valid and still accepted by `cloudflare/src/platform/provision-tenants.ts:104`. After deployment, its shared-host storefront and API stop working. Migration 0060 preserves existing **content pages** named `affiliate`; it does not address this separate tenant-ID collision.

**Fix:** Keep the admin-host portal reservation separate from the storefront’s shop-name rules. If the storefront reservation is required, supply a compatibility route and a migration/preflight strategy for existing tenants, and align provisioning validation.

**5. Sweep/upload interleaving can recreate bytes after cleanup is marked complete.**

`uploadAffiliateInvoice()` checks `pending` before streaming, writes to R2 at `cloudflare/src/storage/object-routes.ts:1023`, then attempts activation at line 1037. A refused activation returns without removing the uploaded bytes.

Concrete failure:

1. Upload starts against a reservation older than seven days and reads `pending`.
2. The sweep tombstones the reservation and deletes its key.
3. The sweep records `object.bytes_deleted`.
4. The in-flight upload finishes its R2 write.
5. Activation refuses the tombstoned row.
6. Future sweeps exclude that tombstone because its bytes-deleted marker already exists.

The bytes are orphaned indefinitely. The retained invoice listing does not repair this.

**Fix:** On failed activation, handle the final object state explicitly. If it is deleted or absent, remove the late bytes and ensure a failed cleanup remains retryable. Do not delete bytes when another uploader successfully activated the object. Add a controlled upload-versus-sweep interleaving test.

I did **not** establish that the sweep itself deletes an already attached, live invoice: its in-batch reference/status guards protect that case. The confirmed defect is late byte recreation.

**6. Shop-specific portal links open the previously selected shop.**

`cloudflare/src/affiliate/affiliates.ts:167` generates:

```text
/affiliate?shopId=<tenant>
```

But `src/admin-app/AffiliateApp.jsx:315` initializes selection only from session storage, and line 324 resolves only that stored choice. Nothing consumes the URL’s `shopId`.

Concrete failure: an affiliate works with shops A and B and last selected A. Clicking B’s welcome-mail portal link opens A. With no stored choice, it displays the picker instead of selecting B. Signing in also loses the query because the return-path handling preserves only a pathname.

**Fix:** Read and validate the requested shop against `/v1/me` memberships, give an authorized explicit selection precedence over stored selection, and preserve that selection through login. Never trust the query parameter without membership validation.

**§11 coverage gaps and test quality**

Most named §11 scenarios have substantive server tests, including refund restoration, lost-dispute dominance, two-request payout races, legacy campaign backfill/burn, and cross-role route refusal. The remaining gaps are chiefly combinations and incomplete scenario execution:

| §11 requirement | Missing coverage |
|---|---|
| “A 0% affiliate earns” plus “typed affiliate code earns” | No storefront test types a zero-discount code and follows it into checkout. The zero-discount tests use `refCode`: `affiliate-seam.test.ts:302`, `affiliate-ledger.test.ts:208`. This misses finding 1. |
| Discount discarded by viability retains attribution | `affiliate-seam.test.ts:322` covers minimum charge. No corresponding affiliate case exercises fee-coverage rejection through payment and accrual. |
| Accrual lands atomically with the order | `affiliate-ledger.test.ts:167` verifies successful coexistence; it does not inject a later batch failure and assert rollback of order, ledger, and outbox together. |
| Negative balance after payment blocks a request | `affiliate-payouts.test.ts:189` substitutes a negative adjustment. It does not execute accrual → payout paid → settled refund → negative balance → refused request. |
| Preview/checkout parity | `affiliate-seam.test.ts:384` covers ordinary positive discounts and misses the zero-discount frontend handling. Its cases also do not establish parity at viability boundaries. |

Additional gaps relevant to this review:

- Suspended membership tests cover PATCH, not approval/re-invitation.
- No mixed-currency earnings/reversal projection test.
- No upload-versus-sweep interleaving test.
- No portal-link test combining `shopId`, stored selection, and login.
- The populated 0058 replay tests identity rows, but not populated `email_deliveries` with its fingerprint, lease, and terminal-state fields.

One test is effectively vacuous: `cloudflare/test/affiliate-routes.test.ts:609` claims to test the portal’s host but only asserts that `ADMIN_HOST` starts with `https://`. Replace it with actual host-routing requests and assertions.

**Other critical-path conclusions**

I found no additional defect in the inspected accrual formula, cumulative reversal calculation, lost-dispute dominance, restoration path, per-order held-net calculation, legacy `NULL` campaign authority handling, or in-batch payout balance reservation. The migration copy lists and recreated email indexes/triggers appear consistent with their preceding definitions.

The inspected portal projections remain explicit allowlists, and the affiliate additions do not expose a platform-fee split. The reviewed mail branches retain shop context and exclude applicant-authored text from applicant acknowledgements. These are static-review conclusions, not fresh test or build results.

**PASS WITH FIXES — block merge on findings 1 and 2.** Findings 3–6 should also be corrected; each has a concrete reporting, compatibility, cleanup, or tenant-selection failure scenario.

---

## The prompt

```
You are a READ-ONLY adversarial reviewer of branch cp13-affiliate (CP13: the affiliate program on the Cloudflare port, units A1–A4). Do not edit files, no git writes, no network, no full test suite (a single `cd cloudflare && npx vitest run test/<file>` is allowed to settle a doubt). The change under review is `git diff cf-port...HEAD` (use `git diff cf-port...HEAD --stat` first, then read per area; new files are in the diff). What each unit does: docs/cf-port/CP13_A1_REPORT.md (server side; §4 route table, §5 invariants, §10 the two review rounds), CP13_A2_REPORT.md (shop-admin pages), CP13_A3_REPORT.md (storefront form, ?ref= landing, cart/checkout, the affiliate portal), CP13_A4_REPORT.md (terms, mails, privacy paragraph, console lists, object sweep, seed, smoke). The rules: docs/cf-port/CP13_AFFILIATE_DESIGN.md §2–§6, §10, §11 and your own earlier audit docs/cf-port/CP13_AFFILIATE_CODEX_AUDIT.md part B (the seam invariants quoted). Each unit already had one Opus adversarial review round whose fixes are in; look for what THEY missed.

Hunt, ranked (blocker/high/medium/low), each with file:line, the concrete failure scenario and the fix, in this priority:
1. MONEY: cloudflare/src/commerce/webhook.ts (the accrual in the order batch, guardedAccrual, the burn gate `IS NOT 'affiliate'`), cloudflare/src/affiliate/ledger.ts (REVERSAL_DELTA_SQL basis-point formula, lost-dispute dominance, restoration on succeeded→failed, HELD_SQL per order net, payableAtLeastSql) with refunds.ts orderEffectStatements and stripe-events.ts applyDisputeFact; cloudflare/src/affiliate/payouts.ts (request/record/paid/void batches, guards inside the batch, one open request, currency).
2. The seam: discount-codes.ts resolveDiscount (link wins, typed affiliate earns, campaign on typed only, gates per family, no oracle), checkout.ts (hold only for campaign, matchesExisting incl. legacy NULL authority, viability discard keeps attribution, self-referral at quote), discount-preview.ts.
3. Migrations 0058, 0059, 0060 on a POPULATED database and the deploy window (old Worker writing between `migrations apply` and the deploy): rebuilds keep every row/column/index; backfill; legacy-tolerant coherence triggers; reserved-slug triggers; the seeded terms sha equals affiliateTermsSha256() (cloudflare/src/affiliate/terms.ts).
4. Tenancy/auth: every affiliate/admin/portal route names the tenant; authorizeAffiliateRequest; same-origin on mutations; opaque 404 both ways; invites; the unaccepted-affiliate conversion; the portal invoice upload/download ownership; nothing leaks a token/link/password.
5. Projections: the portal's answers carry no buyer field; the admin's add no platform-fee split (the seller sees ONE fee number).
6. Mails (kinds, outbox branches, fingerprints, no applicant text in applicant mails, shop sender), clicks (ref on /v1/seo, limiter, HEAD excluded), the object sweep (cloudflare/src/storage/object-sweep.ts: can it ever delete a live object's bytes?).
7. The frontend's use of the contract (src/api/admin/affiliates.js, src/api/affiliate*.js, src/storefront/providers/Cart.jsx, src/admin-app/AffiliateApp.jsx, LoginPage/AdminRoute): any request the server would refuse, any field read that is not sent, any auth loop, any Firebase import reachable from the admin or storefront entry.
8. Test quality: scenarios of design §11 with no test; tautological tests.

Output: a ranked table, details with file:line, the untested §11 scenarios, then a verdict: PASS (mergeable as is) / PASS WITH FIXES (list: which are blocking) / FAIL. Write the full report as your last message.
```
