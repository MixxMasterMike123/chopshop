# CP2-E report: checkout legal gate, buyer consent, and the slice gaps

Branch `cf-port`, worker in `cloudflare/`. Nothing was committed or deployed. No wrangler command reached Cloudflare, no state-changing git command ran, and nothing under `~/.config/chopshop/` was read. `REQUIRED_MIGRATION` is unchanged (still `0030`): **the reviewer moves it to `0031_legal_consent.sql`**. `withholding-release.ts` and `money-followups.test.ts` (CP2-D2) were not touched.

This closes CP2-D1's findings 1–5 (the legal gate and consent, the webhook nudge, refund client idempotency, the list routes, and resolved-failed re-alerting) plus the two Codex P2s on `reconcile-staging.mjs`.

## Counts

| | Tests | Files |
|---|---|---|
| Brief baseline | 1741 | 50 |
| HEAD `0f3a4cff` (CP2-D2 Codex round 3 landed while this ran), without this work | 1745 | 50 |
| **With CP2-E** | **1772** | **51** |
| CP2-E's share | **+27** | **+1** |

The +27 split: `test/legal.test.ts` is new with 13 tests, `test/checkout.test.ts` gains 4, and `test/slice/failure-injection.test.ts` gains 10. `vertical-slice.test.ts` is still one test, extended. `receipts.test.ts` and `refunds.test.ts` keep their counts, with their pinned schemas updated.

`npm run check` after the last edit:

```
✨ Types at worker-configuration.d.ts are up to date.
> tsc --noEmit
 Test Files  51 passed (51)
      Tests  1772 passed (1772)
   Duration  53.18s
```

Three more full runs after that were also green (see *Flakiness*). `node --test guard/guards.test.mjs` passes (`guard: PASS`). A scan for the brief's forbidden strings (the legacy brand patterns, the retired B2B term, firebase imports) is clean. "Firebase" appears only in comments that cite the original files.

## Files

**New**
- `cloudflare/migrations/0031_legal_consent.sql`
- `cloudflare/src/legal/platform-terms.ts`: the seller gate and the acceptance evidence.
- `cloudflare/src/legal/consent.ts`: the buyer consent rules, the disclosure, the personalisation predicate, and the freeze/copy/read helpers.
- `cloudflare/src/routes/legal-admin.ts`: `GET /v1/admin/legal/status` and `POST /v1/admin/legal/accept-terms`.
- `cloudflare/src/routes/platform-orders.ts`: `GET /v1/platform/orders`, `GET /v1/platform/alerts`, and `POST /v1/platform/alerts/:id/resolve`.
- `cloudflare/test/legal.test.ts`
- `cloudflare/test/legal-fixtures.ts`: a shared test helper holding the acceptance row and `BUYER_CONSENT`.

**Owned, edited**
- `src/commerce/checkout.ts`: the gate, consent, and the replay fingerprint.
- `src/commerce/webhook.ts`: copies the consent and nudges the outbox.
- `src/commerce/crons.ts`: the stranded-dispatch query.
- `src/commerce/money-alerts.ts`: the alert list and resolve logic.
- `src/routes/money-orders.ts`: Idempotency-Key, and the consent facts on the admin read.
- `src/app.ts`: imports plus the CP2-ROUTES-A anchor.
- `test/checkout.test.ts`, `test/slice-harness.ts`, `test/slice/vertical-slice.test.ts`, `test/slice/failure-injection.test.ts`.
- `scripts/cf-port/reconcile-staging.mjs`.

**Outside the owned list: minimal edits the brief's items forced (please review)**

| File | Edit | Why |
|---|---|---|
| `src/app.ts` **outside the anchor** | `handleCheckoutRoute` maps two new results: `not_found` → 404 and `consent_refused` → 400 with the code. The webhook route passes `env` (4th argument). | Both handlers are registered before the anchor. Hono serves the first match, so no anchor-block registration can change them. Items 1, 2 and 4 cannot be met without this. It is 18 lines plus 1. |
| `src/commerce/refunds.ts` | `requestRefund(…, options: { clientKey? })` binds `client_key` into the **reservation batch's** INSERT. | Stamping the key after the batch would leave a crash window, and a crash there would allow a second refund. |
| `src/commerce/receipts.ts` | The buyer schema gains `withdrawal: { waived }`, from a named column. | The allowlisted buyer schema lives here (item 2). |
| `test/money-fixtures.ts` | `adminRequest` adds a fresh `Idempotency-Key` to `POST …/refunds` unless the caller passes one (`null` = none). | The header is now required. `money-followups.test.ts:244` (a forbidden file) and three other suites go through this helper. |
| `test/pod-fixtures.ts` | `seedTenant` also inserts the terms acceptance. | `money-followups.test.ts:971` (forbidden) and `pod-publish` call `createCheckout` on those tenants. |
| `test/{admin-catalog,admin-discount-codes,discount-codes,pod-publish}.test.ts` | The seed adds the acceptance, and each successful checkout body gets `consent`. | These are consequences of the hard gate and the required terms box. |
| `test/{receipts,refunds}.test.ts` | The pinned response shapes gain `withdrawal` / `consent`. | The schemas changed per item 2. |
| `scripts/cf-port/seed-staging-slice.mjs` | Adds the terms step (see §8), `consent` on checkout, and a deterministic `Idempotency-Key` on `--refund`. | Without these, `--purchase` gets 404 and `--refund` gets 400 on staging after deploy. |

## 1. Schema: `0031_legal_consent.sql`

All times are ISO-8601 UTC TEXT with the round-trip CHECK. Every table is tenant-first indexed, and every tenant column is immutable.

**`platform_terms_versions`** has the columns `version PK` (`[0-9A-Za-z._-]{1,32}`), `published_at`, `sha256` (64 lowercase hex) and `created_at`. It is append-only: UPDATE and DELETE triggers abort. It is seeded with `('2026-09-07', '2026-09-07T00:00:00.000Z', 'ca1f708f70d0ab3b9d26d9d0647efafca77018d8a4e5dcc6bfec7c0a464c0b91')`.
- The version is Firebase's `PLATFORM_TERMS_VERSION` (`src/config/platformTerms.js:34`).
- The hash is SHA-256 of `JSON.stringify({ version, terms: PLATFORM_TERMS_TEMPLATE, dpa: PLATFORM_DPA_TEMPLATE })` over that file's template source, before merge fields are filled. The recipe is in the migration header.
- **CURRENT** = the latest version whose `published_at <= now`. A future version therefore takes effect at its date.

**`platform_terms_acceptances`** has the columns `id`, `tenant_id FK`, `user_id`, `terms_version FK`, `accepted_at`, `ip`, `user_agent` (≤ 512) and `evidence_json` (`{ origin, termsSha256 }`, ≤ 4 KB).
- `UNIQUE(tenant_id, terms_version)`.
- Append-only (no update, no delete) and tenant-immutable.
- An INSERT trigger refuses `accepted_at < published_at`.
- Indexed on `(tenant_id, accepted_at DESC)`.

**Consent columns**
- `checkouts.consent_json` holds a JSON object ≤ 4 KB. Trigger `checkouts_consent_frozen` makes it write-once.
- `orders.consent_json` has the same shape, and `orders.is_personalized` is `0|1`, with `CHECK (is_personalized = 0 OR consent_json IS NOT NULL)`. Trigger `orders_consent_immutable` covers both columns.

**`products.is_personalized`** is `0|1`, default 0. It is the only input to "this line is personalised" (§4).

**`refund_operations.client_key`** is a lowercase UUID. Its CHECK allows it only on `origin = 'admin'`. It has a partial `UNIQUE INDEX (tenant_id, client_key) WHERE client_key IS NOT NULL` and an immutability trigger.

## 2. Routes (exact JSON)

**Seller (tenant admin; `X-Shop-Id` membership; the POST is same-origin)**
```
GET  /v1/admin/legal/status
  200 { "currentVersion": "2026-09-07" | null, "accepted": boolean, "acceptedAt": ISO | null }
POST /v1/admin/legal/accept-terms          { "termsVersion": "2026-09-07" }
  201 { "acceptance": { "termsVersion": "2026-09-07", "acceptedAt": ISO } }   recorded now (+ audit legal.platform_terms.accept)
  200 { "acceptance": { … the FIRST acceptance … } }                           already accepted (nothing written)
  409 { "currentVersion": "…", "error": { "code": "terms_version_not_current", "message": "The terms version is not the current one" } }
  400 invalid_request   body not exactly { termsVersion }
  404                   no session / membership, cross-origin, wrong method, and an ACTING-AS platform user
```
The storefront learns nothing about the gate. Checkout simply answers `404 { error: { code: "not_found", message: "Checkout not found" } }`, byte-identical to an unknown shop, and writes nothing.

**Buyer, `POST /v1/checkout`.** The body gains a required `consent`:
```
"consent": { "terms": true, "marketing"?: boolean, "withdrawalWaiver"?: boolean, "disclosureVersion"?: string }
  400 invalid_request                      consent missing, terms not literally true, stray key, a disclosureVersion
                                           without a ticked waiver, or a ticked waiver without one
  400 { "error": { "code": "withdrawal_waiver_required",   "message": "The basket needs a consent the request did not give" } }
  400 { "error": { "code": "withdrawal_disclosure_outdated", … } }   waiver ticked for a disclosure version ≠ current ("v1-2026-06")
  404 (the gate)   ·   409 the same idempotency key replayed with a different consent
```
The checkout response itself is unchanged: consent is server-side evidence and is not echoed.

**Buyer receipt.** `GET /v1/orders/:id` adds `"withdrawal": { "waived": boolean }`.

**Admin order read.** `GET /v1/admin/orders/:id` adds:
```
"consent": { "terms": true, "marketing": boolean, "recordedAt": ISO,
             "withdrawal": { "waived": boolean, "disclosureVersion": string|null, "personalizedItems": [itemIndex…] } } | null,
"withdrawal": { "waived": boolean }
```

**Refunds.** `POST /v1/admin/orders/:id/refunds` now **requires** `Idempotency-Key: <uuid>`:
```
  400 { "error": { "code": "idempotency_key_required", "message": "An Idempotency-Key header (a UUID) is required" } }
  replay (same key, same order+amount+reason): the SAME operation as it stands now —
      202 while reserved, else 201 { "refund": { "amountMinor", "refundId", "state" } } + header Idempotent-Replayed: true
  409 { "error": { "code": "conflict", "message": "Idempotency key was already used for a different request" } }
```
The key is scoped per tenant, so the same UUID in another shop is another key.

**Platform (platform principal; GETs need no same-origin; the POST does)**
```
GET /v1/platform/orders?tenantId=<required>&since=<ISO>&cursor=<createdAtMs~orderId>&limit=1..100 (50)
  200 { "orders": [{
          "orderId", "orderNumber", "tenantId", "status", "createdAt", "paidAt", "cancelledAt",
          "paymentIntentId", "stripeChargeId", "stripeTransferId", "connectAccountId", "currency", "deliveryMethod",
          "isPersonalized",
          "money": { "totalMinor", "chargedMinor", "applicationFeeMinor" (GROSS), "withheldMinor", "withholdingReleasedMinor",
                     "refundedMinor", "refundPendingMinor", "transferReversedMinor", "disputeRetransferredMinor",
                     "dispute": { "status", "amountMinor" } | null },
          "payout": { "amountMinor", "eligibleAt", "state" },
          "production": { "printer", "productionCostMinor", "withholdMinor" } | null,
          "dispatch": [{ "outboxId", "lineNo", "state", "attempts", "lastError", "printerJobRef" }] }],
        "nextCursor": string | null }
GET /v1/platform/alerts?state=open|resolved(open)&kind=&tenantId=&cursor=<createdAt~id>&limit=1..100 (50)
  200 { "alerts": [{ "alertId", "tenantId", "kind", "severity", "message", "resourceType", "resourceId",
                     "createdAt", "resolution": { "at", "byUserId", "note" } | null }], "nextCursor": string | null }
POST /v1/platform/alerts/:alertId/resolve        { "note": "1–1000 chars" }
  200 { "alert": AlertView }   ·   409 conflict (already resolved)   ·   404 unknown / not platform / cross-origin   ·   400 body
```

The orders list is ordered by `(created_at, order_id)` ascending (keyset). It stays on `orders_tenant_created_idx`, which is why `tenantId` is required. Dispatch rows come from one `IN (…)` query per ≤ 90 orders.
- **Cost fields:** only this platform-only surface carries the gross fee split, the production cost and the printer.
- **Excluded:** card data (none is stored) and the buyer's email.

Resolving an alert is one batch: audit `alert.resolve`, with the note in `reason`, then `resolved_at = MAX(created_at, now)`. Both steps are conditional on the alert still being open. `resolution.by`/`note` are read back from that audit row, so alerts resolved by the system show `byUserId: null`. A condition that is still true raises a fresh alert on the next run, which is the existing one-open-per-resource semantics.

## 3. The legal rules ported (with Firebase refs)

| Rule | Firebase | CF |
|---|---|---|
| Acceptance is evidence: who, when, which version, plus the text accepted. Append-only; a pointer is written only after the evidence. | `src/utils/legalAcceptance.js` `recordPlatformTermsAcceptance` (evidence `shops/{id}/legalAcceptances` type `platformTerms` with the rendered HTML, then the `shops/{id}.platformTerms` pointer). Rules make evidence append-only. | One append-only row: user, time, version, ip, user agent, and `{ termsSha256, origin }`. The pointer is the row itself, UNIQUE per (tenant, version). An audit row is written in the same batch. |
| "Accepted" means the CURRENT version. | `hasAcceptedCurrentPlatformTerms`: `platformTerms.version === PLATFORM_TERMS_VERSION` | `readTermsStatus`: the latest `published_at <= now`, then its acceptance. |
| Only the seller's own admin accepts. | `PlatformTermsGate` (AppLayout) gates shop admins and is never shown to platform or impersonation users. Plattformsvillkor § 1: the accepter vouches they may bind the Säljare. | An acting-as principal gets 404 on accept (it may read the status). |
| No checkout without it (HARD gate). | `createPaymentIntent.ts` `legalCheckoutBlockReason` → 403 "Shop is not accepting orders". **Note:** Firebase's server gate checks the legal PAGES acceptance plus `returnAddress` plus `vatRegistered`. Platform terms gated the admin UI. | `createCheckout` → `not_found` (opaque 404), first thing after the item count, before any line is resolved. |
| Personalised order: no right of withdrawal only if disclosed AND the box is ticked; the server decides personalisation. | `withdrawalConsentBlockReason` (accepted + noticeVersion + noticeFingerprint) and `validateCartLine` `isPersonalized: product.isPersonalized === true` (never the client's flag). | `freezeConsent`: waiver + current `disclosureVersion`; the SHA-256 of the disclosure text is stored. Lines come from `products.is_personalized`. |
| Disclosure text and version. | `src/utils/withdrawal.js` `DEFAULT_NO_WITHDRAWAL_NOTICE`, `WITHDRAWAL_NOTICE_VERSION = 'v1-2026-06'` | `WITHDRAWAL_DISCLOSURE_TEXT` (verbatim) and `WITHDRAWAL_DISCLOSURE_VERSION`. |
| POD never implies personalised (LEGAL FIREWALL, C-529/19). | `pod-wagon/WagonManifest.js`, and `DesignStudio.jsx:953` hard-codes `isPersonalized: false`. | `isPersonalizedLine` reads only the product flag. The slice's POD tee keeps the full right (asserted). |
| Marketing is a separate, optional, pre-unticked box (MFL 19 §, dual checkbox). | createPaymentIntent `marketing` / `remindMe`, memory abandoned-cart. | `consent.marketing` is stored as its own fact and never implied by terms. `remindMe` is PORT-LATER with abandoned-cart. |
| Frozen at checkout, copied at order creation. | withdrawalMeta goes onto the PI metadata, and then onto the order. | `checkouts.consent_json` (write-once) goes into the webhook's order batch as `orders.consent_json` + `is_personalized` (immutable). |
| Consumer-safe default. | — | Unreadable consent never refuses a paid order. The order gets `consent_json NULL, is_personalized 0`, so the full right applies. |

## 4. The personalisation rule: CP2 vs CP6 (a deliberate deviation from the brief)

The brief said: "for CP2 treat every POD line as personalised". **I did not do that.** Doing so would ask every buyer of a catalogue POD product (the seller's own design) to waive their statutory 14-day right, and would record `waived: true`. That is exactly the "firewall breach" the Firebase code and the repo memory forbid:
- `WagonManifest.js`: "it must NEVER set product.isPersonalized true … reserved for customer-supplied input".
- `angerratt_pod`: Regime A catalogue POD keeps the full right. Wrongly flagging it "illegally strip[s] a consumer right".

The brief also asks me to honour that rule ("isPersonalized is decided by the buyer flow").

- **CP2 rule (built):** a line is personalised iff `products.is_personalized = 1`. This is Firebase parity: the seller's explicit "Specialtillverkad / personlig produkt" toggle. It defaults to 0, and no CF route writes it yet (CP5's ProductForm will). The waiver gate, disclosure, freeze, copy, receipt and admin facts are all built and tested with a product flagged by SQL.
- **CP6 refinement:** a buyer-supplied-artwork flow (the buyer uploads their own image or text at the storefront) marks its line personalised at checkout from the flow itself. `isPersonalizedLine` in `src/legal/consent.ts` is the single seam to change; the waiver machinery is unchanged.
- **If Mikael wants the brief's rule anyway:** change that one function to `line.isPod || line.isPersonalized`. It is a one-line change, and it is his legal call.

## 5. Refund client idempotency

The key is stored inside the reservation batch. For a key already on file, the route replays the operation: 202 while reserved, else 201, with `Idempotent-Replayed: true`. It answers 409 when the order, amount or reason differ.

When two requests race, one reservation commits. The other's batch aborts whole on the unique index (nothing reserved), and it replays the winner. The failure-injection suite (§4b) proves:
- a lost response followed by a retry gives one operation and one Stripe refund;
- when Stripe refunded and the worker died before settling, a retry answers 202 with the held reservation (never a second refund), then 201 `succeeded` after reconciliation;
- a double click (`Promise.all`, one key) gives one op, one Stripe call, and both answers name it;
- another amount under the same key gives 409; a missing or malformed key gives 400; the same UUID in another shop is independent.

## 6. The webhook nudges the outbox

`handleStripeWebhookEvent(db, event, now, env?)` collects the ids of the dispatch and email rows it inserts. After the order batch commits (and after the deferred-fact replay, so a superseded dispatch is simply acked), it calls `nudgeOutbox(env, ids)`, which never throws.

Duplicate and replayed deliveries nudge nothing. Tests:
- the slice (step 14): both rows are nudged, and the one-batch atomicity assertions are unchanged;
- a dying order batch nudges nothing, Stripe's retry commits and nudges exactly the two rows, and an event replay adds none;
- a failing queue still gives 200 with the order committed, and the sweeper delivers.

## 7. Resolved-failed dispatch no longer re-alerts

The query `detectStrandedDispatch` now excludes:
- rows with `last_error = 'resolved_failed'`, which CP2-B's operator resolution marks;
- rows whose order (same tenant) is `cancelled` or `refunded`. An in-flight `unknown` there still gets the sweeper's `dispatch_stranded_30m`.

It is done in SQL, so those rows no longer fill the `LIMIT 100` and starve newer stranded rows. The test covers a resolved failure, an unknown line of a fully refunded order, and a control; only the control alerts, once, across two runs.

## 8. The slice and staging

**Vertical slice.** The tenant is created **without** acceptance.
- **Step 12a (new):** status reads `accepted: false`, checkout answers 404 (the unknown-shop body) with no row written, then the admin accepts through the route and the evidence row is asserted.
- **Checkout:** carries `{ terms, marketing }`, and the catalogue POD tee freezes `waived: false`.
- **Webhook:** the order carries the same consent, with `is_personalized 0` and both outbox rows nudged.
- **Reads:** the receipt shows `withdrawal: { waived: false }`, and the admin read shows the consent facts.
- **Refund:** the partial refund is retried with its key, giving one Stripe call.

The harness's `createTenant` accepts through the route by default (`acceptTerms: false` opts out). `openCheckout` sends consent, and `refundCall` sends a key.

**`seed-staging-slice.mjs`**
- The platform user (acting-as) reads the terms status.
- If terms are not accepted, the script creates `slice-admin+<tenant>@example.com` with `CHOPSHOP_SLICE_ADMIN_PASSWORD` (env only, ≥ 12 characters), grants it admin of the tenant, signs in, and accepts. Without the variable it refuses with that instruction.
- The `--refund` key is derived from (tenant, order, amount), so re-running the command replays instead of refunding twice.

## Codex fixes (reconcile-staging)

1. **[P2] Net fee after a D36 release.** Previously the admin read's `feeMinor` (NET = gross − released) was compared with the intent's `application_fee_amount` and the fee object's `amount` (both GROSS), so a correctly reconciled release printed `UNBALANCED`. Now:
   - **Gross vs gross:** the platform row's `applicationFeeMinor` = the intent's `application_fee_amount`, and that = the fee object's `amount`.
   - **Net vs net:** the seller's figure = D1 `applicationFeeMinor − withholdingReleasedMinor`, and that = Stripe's `fee.amount − fee.amount_refunded` (or the intent's fee when there is no fee object).
2. **[P2] Pagination.** Every platform list (`/v1/platform/orders`, `/v1/platform/dispatch?state=…`, `/v1/platform/alerts`) goes through `listAll()`. It follows `nextCursor` to exhaustion, with `limit=100`, before filtering or counting.

The data source is now `GET /v1/platform/orders?tenantId=` (no D1 export, and `--orders-json`/`--alerts-json` are gone). `--order <id>` narrows the run, and open alerts come from `GET /v1/platform/alerts`.

Verified offline with a mocked `fetch`:
- a released order (gross 5000, released 2000, fee refunded 2000) is `BALANCED`;
- the tenant's dispatch row on page 2 of the cross-tenant list is found, and two order pages are both read;
- a wrong seller fee is `UNBALANCED`, naming both net checks.

## Flakiness

With the nudge in place, suites that post success webhooks through the pool's real `env` now send nudges to the test outbox queue, whose real consumer runs in the pool. Four consecutive full runs after the last code edit (two `npm run check`, two `vitest run`) were all green (1772/1772). The slice suites use recording queues as before.

## Open questions

1. **The personalisation rule (§4).** Product flag (built, Firebase parity, keeps the consumer's right) or the brief's "every POD line"? This is a legal call for Mikael, and possibly the lawyer pass.
2. **A terms version bump closes every shop's checkout** until its admin re-accepts; the brief asks for the "CURRENT version". Firebase deliberately never closed checkout on template drift (for the legal pages), and gated platform terms in the admin UI instead. Is a grace period wanted, for example gating on "some accepted version" plus an admin banner for the newest? Publishing a new version is a migration row today (CP3: a platform route).
3. **Firebase's actual server gate was legal-PAGES readiness:** `returnAddress`, a boolean `vatRegistered`, and the seller's acceptance of the three consumer pages (`legalCheckoutBlockReason`). CF has no `storeIdentity` or legal pages yet (CP3/CP4). That gate should be ported alongside them, as a second condition in the same place.
4. **The payment route does not re-check the gate.** A checkout opened before a version bump can still be paid within its 24 h life. Acceptable?
5. **`CreateCheckoutInput.consent` is optional** only because `money-followups.test.ts:971` (forbidden) calls `createCheckout` without it. Make it required once that file can be touched. The HTTP parser always requires it.
6. **Evidence holds a hash, not the text.** Firebase stored the rendered HTML in each acceptance. CF stores the SHA-256 of the template source for the version, so the exact text per version must stay reproducible (git history of `platformTerms.js`, or an archived copy per version in R2 when CP3 adds publishing).
7. **The acceptance stores the IP** (the brief asked for it). That is personal data: which retention rule applies?
8. **Shop-specific withdrawal notices** (Firebase `legal.noWithdrawalNotice` + `withdrawalNoticeVersion`) are not ported. CF accepts only the platform default version, and a storefront needs no new route to show it (the Vite build has the same text).
9. **Mixed carts.** `withdrawal.waived` on the receipt is order-level (Firebase parity). The personalised item indexes are in `consent_json`, but the buyer receipt does not name the lines that keep the right. This is for the CP6 UI.
10. **`GET /v1/platform/orders` requires `tenantId`** to stay on the tenant-first index. A cross-tenant list would need an index on `orders(created_at, order_id)`.
11. **For the reviewer:** move `REQUIRED_MIGRATION` to `0031_legal_consent.sql`, and consider DECISIONS entries for §4 (the personalisation predicate) and question 2 (the version-bump policy).

## Codex fix on fee54bd: a same-key refund refused by its own twin (P2)

**The bug.** `POST /v1/admin/orders/:id/refunds` looked the key up once, before `requestRefund`. When two requests with the same `Idempotency-Key` both passed that lookup and the first reserved the whole remaining balance, the second never reached its insert. It was refused by the balance, either at once or after losing the version race and re-reading the order. So the unique-index replay path never ran, and the caller got `409 refund_not_allowed` for a refund that had in fact been accepted.

**The fix** is in `src/routes/money-orders.ts` only. On every outcome that is neither `created` nor `pending` (`not_allowed`, `not_found`), the route re-reads the key. If the key now names an operation, the caller's refund was accepted, so the route replays it through the same `replayResponse`:
- the same `refundId`;
- the operation as it stands (202 `reserved` while the winner still waits for Stripe, else 201);
- the `Idempotent-Replayed: true` header;
- the different-body 409 `conflict` still applies.

A key that names nothing keeps the original refusal. `src/commerce/refunds.ts` is unchanged.

**Tests** (`test/slice/failure-injection.test.ts` §4b, +4, all through the real route with the fake Stripe):
1. **Deterministic: the second request reads the order after the first reserved everything.** An instrumented D1 holds the second request at its order read until the first request has completed. Both callers get `201 { refund: { amountMinor: full, refundId: <the one op>, state: "succeeded" } }`; the second also gets `Idempotent-Replayed: true`. Stripe sees exactly one refund, the order is `refunded`, and the ledger balances.
2. **Deterministic: the second request loses the version race.** The second request is held at its reservation batch. It loses the compare-and-set, re-reads, is refused, and replays the first. The outcome is the same as test 1.
3. **The real race (`Promise.all`, two full refunds, one key).** Both answers name the one operation, as 201 `succeeded` or 202 `reserved` depending on timing. There is exactly one Stripe refund, and the ledger balances.
4. **Control: a different refund (its own key) took the whole balance.** The refusal stands (`409 refund_not_allowed`), the key stays unused, and Stripe sees one refund.

With the fix temporarily removed, tests 1–3 fail: the second caller gets 409 `refund_not_allowed`, and test 1 also lacks the replay header. Test 4 passes either way. With the fix, all pass.

**Counts.** 1772 → **1776 tests** (+4), still **51 files**. `npm run check`:

```
✨ Types at worker-configuration.d.ts are up to date.
 Test Files  51 passed (51)
      Tests  1776 passed (1776)
   Duration  55.91s
```

`failure-injection.test.ts` alone ran green three times in a row (39/39), and a further full `vitest run` was green (1776/1776).
