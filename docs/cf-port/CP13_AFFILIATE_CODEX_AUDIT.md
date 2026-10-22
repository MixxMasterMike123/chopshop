# CP13 — Codex audit of the affiliate spec against the port's money and identity seams

Date: 2026-10-22 · Model: gpt-6-astra (reasoning high) via `codex exec`, read-only sandbox, on `485a6ec9` (branch `cf-port`). Step 1 of `CP13_AFFILIATE_KICKOFF.md` §5. The prompt is at the end. The report is verbatim; the design (`CP13_AFFILIATE_DESIGN.md`) answers every item of A, B and C and says where it deviates.

---

## A. What the rebuild must not inherit

Read-only audit of `cf-port`. No files were edited and no tests were run. D24–D30 are treated as **TAKEN**, as instructed by `docs/cf-port/CP13_AFFILIATE_KICKOFF.md:33`. The “to be confirmed now” heading in `docs/cf-port/DECISIONS.md:135` is stale.

**One correction before design:** the retained defaults are **15% affiliate commission and 10% buyer discount**, not the reverse. The kickoff reverses their labels at `docs/cf-port/CP13_AFFILIATE_KICKOFF.md:27`; the spec establishes their actual meanings at `docs/cf-port/specs/AFFILIATE.md:61` and demonstrates them at `docs/cf-port/specs/AFFILIATE.md:214`.

In the table below, **new** means a mechanism the affiliate rebuild must introduce; an existing pattern is not presented as an already implemented affiliate safeguard.

| Spec reference | Concrete defect not to inherit | Port mechanism to use or add |
|---|---|---|
| **§8.1; §3.2** | Approval resets an existing account’s password, permits takeover of privileged identities, and overwrites another shop’s affiliate record and balance. | `createInvitedUser` refuses an existing email and inserts a passwordless identity atomically; `accessStatements` uses INSERT, never an identity-type upsert (`cloudflare/src/platform/provision-users.ts:410`, `cloudflare/src/platform/provision-users.ts:473`). **New:** tenant-authorized approval, explicit existing-identity policy, immutable tenant ownership, and a separate affiliate record per membership. Never invoke password reset merely because a shop approved an application naming an existing address. |
| **§8.2; §7.4** | Plaintext temporary passwords persist indefinitely; manual creation mails a password that works nowhere. | Reuse passwordless provisioning and the recipient-only password-set link. The operator never receives the token; Better Auth consumes it and revokes sessions on reset (`cloudflare/src/platform/provision-users.ts:448`, `cloudflare/src/platform/invites.ts:24`, `cloudflare/src/platform/invites.ts:45`, `cloudflare/src/auth/create-auth.ts:89`). **New:** affiliate invite wording and guarded issuance. No password field on applications, affiliates, responses or audit metadata. |
| **§8.3; §3.1** | Anonymous direct application creation accepts arbitrary shops, fields and statuses; only the later mail call is rate-limited. | Resolve the tenant through the verified domain, validate a bounded strict body, and rate-limit **before inserting anything**. Existing patterns: `resolveRequestTenant`, `enforceRateLimit`, and `handleStorefrontDiscountPreviewRoute` (`cloudflare/src/tenancy/resolve-tenant.ts:24`, `cloudflare/src/lib/rate-limit.ts:88`, `cloudflare/src/routes/storefront-discount-preview.ts:80`). **New:** application route, server-owned status/timestamps, duplicate policy, decision history, retention, and application-plus-mail-outbox batch. |
| **§8.4; §2.2** | Shop admins can rewrite balances and earnings; payout documents can be edited or deleted; increments are the ledger. | **New:** append-only affiliate ledger, database-enforced immutable entries, compensating adjustments, operation uniqueness, and atomic payout reservations. Existing examples separate writable configuration from financial counters and freeze financial identity (`cloudflare/src/commerce/admin-discount-codes.ts:31`, `cloudflare/migrations/0011_orders.sql:157`). No client-supplied balance or commission amount is authoritative. |
| **§8.5; §4.5** | Client `affiliateInfo` independently supplies attribution, allowing a Rabattkod-discounted order to credit an affiliate; arbitrary `clickId` can mutate another tenant’s click. | Derive discount **and attribution from one server resolution**, then freeze them. The webhook trusts the checkout, not PaymentIntent metadata (`cloudflare/src/commerce/webhook.ts:43`). **New:** affiliate resolution facts and their immutable checkout/order columns. Under D27 there is no click identifier to accept or mutate. |
| **§8.5; §3.3** | An unscoped lookup credits whichever shop’s identical code is found first. | Existing discount resolution uses `(tenant_id, code)` (`cloudflare/src/commerce/discount-codes.ts:370`). **New:** use that same scope for affiliate resolution and aggregate click counting; tenant comes from verified routing, never the code’s first global match. |
| **§8.5; §2.7** | A global 30-day referral key carries one shop’s attribution into another shop. | The port cart is already keyed by shop root and protects root changes (`src/storefront/providers/Cart.jsx:59`, `src/storefront/providers/Cart.jsx:173`). **New:** retain the normalized code and `source: 'link'` in that cart only; no separate referral store or 30-day attribution key. |
| **§8.5; §3.5** | Exact email equality is the entire self-referral defence. | The checkout parser already owns normalized buyer input (`cloudflare/src/commerce/checkout.ts:400`). **New:** compare against the affiliate’s server-owned identity email, freeze the eligibility decision, record a reason without exposing identity data, and enforce program terms against abuse. Anonymous code-only checkout cannot prove that two different email addresses belong to different people; do not claim this is solved by an email check. |
| **§8.6** | `admin_access=true`, an affiliate code, or browser storage is treated as an authentication substitute. | Existing tenant-admin authorization requires a session plus live membership or a valid platform acting-as grant (`cloudflare/src/auth/request-authorization.ts:79`). **New:** distinct affiliate principal and own-affiliate projection. An admin preview uses the admin’s real principal and tenant-scoped read, not impersonated affiliate credentials. Existing acting-as is platform-to-shop administration, not a general affiliate impersonation facility (`cloudflare/src/auth/live-authorization.ts:6`). |
| **§8.7** | Clicks retain IP, UA and referrer indefinitely; order reads disclose affiliate financial data publicly. | **New:** only `(tenant, affiliate, day, count)` for click analytics; no visitor identifier, raw URL, IP, UA or referrer. Keep operational application rate-limit hashes separate. Use explicit server projections, as the port’s admin order views do (`cloudflare/src/commerce/admin-orders.ts:11`, `cloudflare/src/commerce/admin-order-list.ts:8`). |
| **§8.8; §8.9** | Legacy invoice paths permit cross-shop reads; portal access is either broken or would require exposing entire order documents. | `getAuthorizedObject` requires an active object owned by the tenant; private bytes are proxied after that check (`cloudflare/src/storage/object-store.ts:453`, `cloudflare/src/storage/object-store.ts:549`). **New:** an additional affiliate-to-payout-to-invoice ownership check and an order projection limited to order number, date, net base, commission and status. Tenant ownership alone is insufficient for affiliate access. |
| **§3.4; §7.6** | A typed code, failed click log or rate-limited click gives the discount but earns nothing. | **New:** a valid server-resolved affiliate code earns under D24 regardless of click logging or client-reported source. Resolution belongs before the campaign lookup (`cloudflare/src/commerce/discount-codes.ts:352`); award belongs in the order batch (`cloudflare/src/commerce/webhook.ts:513`). |
| **§3.5** | Completion claims success before loose award writes; crashes permanently lose or partially apply commission. | Insert the accrual in the **same D1 batch** as the order, order facts and outbox (`cloudflare/src/commerce/webhook.ts:513`, `cloudflare/src/commerce/webhook.ts:858`). **New:** one accrual per order, with no completion trigger or repair-dependent second pass. |
| **§3.6** | Partial refunds keep all commission; dashboard refunds and lost disputes never reverse it. | Refund settlement already converges through `applyRefundFact` and `orderEffectStatements` (`cloudflare/src/commerce/refunds.ts:135`, `cloudflare/src/commerce/refunds.ts:390`). **New:** cumulative pro-rata ledger adjustment in those batches, plus a separate atomic lost-dispute hook in `applyDisputeFact` (`cloudflare/src/commerce/stripe-events.ts:556`). Reverse regardless of today’s add-on or affiliate status. |
| **§3.6; §9.2** | Cancellation reverses commission even though the buyer’s money was not returned. | Do **not** attach commission reversal to `cancelOrder`: its invariant is “CANCELLING MOVES NO MONEY” (`cloudflare/src/dispatch/cancellation.ts:35`), and its audit records `moneyMoved: false` (`cloudflare/src/dispatch/cancellation.ts:312`). Reverse settled refunds or a final lost dispute; a cancellation may block payout pending resolution. |
| **§3.7** | Every payout is immediately “completed”; there is no reservation, failure, uncertain outcome or compensating correction. | **New:** affiliate payout operation with reserved/submitted/settled/failed handling, currency-specific available balance and compensating corrections. Follow withholding release’s reserve → execute in cron → settle discipline (`cloudflare/src/commerce/withholding-release.ts:39`). A recorded request is not evidence of payment. |
| **§3.7; §8.8** | Upload-before-payout leaves orphaned invoice files; persistent download URLs substitute for scoped access. | Reuse private `document` objects, reserve → upload → activate, and authenticated delivery (`cloudflare/src/storage/object-store.ts:113`, `cloudflare/src/storage/object-store.ts:275`, `cloudflare/src/storage/object-routes.ts:648`). **New:** payout attachment ownership, PDF-specific validation, retention and abandoned-upload cleanup. Existing reservation alone does not supply cleanup. |
| **§4.3; §2.2** | Affiliate and Rabattkoder codes collide; uniqueness checks are incomplete and race-prone. | Existing `UNIQUE(tenant_id, code)` covers **only** `discount_codes` (`cloudflare/migrations/0010_discount_codes.sql:107`). **New:** shared code namespace or symmetric database-enforced cross-table collision guards on creation **and rename**, including inactive codes. Update `createAdminDiscountCode` and `updateAdminDiscountCode`, not just affiliate approval (`cloudflare/src/commerce/admin-discount-codes.ts:695`, `cloudflare/src/commerce/admin-discount-codes.ts:769`). |
| **§7.6** | Lowercase referral links fail click lookup and therefore lose commission. | Use `normalizeDiscountCode` at every public code boundary (`cloudflare/src/commerce/discount-codes.ts:47`); **new:** canonical storage checks and shared normalization for affiliate write, preview, checkout and click aggregate paths. Click success must not affect commission. |
| **§2; §3.4–§3.5** | Float SEK money, whole-krona discount ceiling, global 25% VAT, and client-side commission recomputation produce inconsistent financial facts. | Integer minor units and basis points already govern the port (`cloudflare/migrations/0019_money.sql:14`). Use exact integer arithmetic patterned after `percentDiscountMinor` and `vatMinor`, with frozen tenant VAT (`cloudflare/src/commerce/discount-codes.ts:132`, `cloudflare/src/commerce/shipping.ts:318`, `cloudflare/src/commerce/checkout.ts:792`). **New:** one authoritative commission formula; explicitly document the change from Firebase’s whole-krona discount ceiling to the port’s minor-unit ceiling. |
| **§7.1–§7.5; §7.7; §8.10** | Dead campaign revenue sharing, ambassador CRUD against real affiliates, broken links, fake profile saves, fake payout requests and misleading analytics survive as apparent functionality. | D30 drops campaigns and ambassador CRM. The port already classifies those feature keys as deleted (`cloudflare/src/platform/tenant-config.ts:123`). **New:** real scoped portal routes, functional mutations, actual period filters, and code-derived order metrics. Manual creation may remain as an admin workflow, but must provision/invite correctly. |
| **§2.8; §3.8; §6.2** | Affiliate defaults ON and fails open; deletion destroys the record needed to settle liabilities; terms acceptance is absent. | `isFeatureEnabled` fails closed on errors and unknown keys (`cloudflare/src/platform/tenant-config.ts:179`). **New:** affiliate opt-in, soft retirement, durable financial references and stored D28 terms acceptance. Disabling acquisition must not erase balances or prevent reversal and settlement of existing obligations. |

## B. Which port seams the rebuild touches

**1. Discount resolution, preview, checkout and code ownership**

The intended lookup position is correct: add the affiliate branch at `resolveDiscount`, ahead of the campaign query (`cloudflare/src/commerce/discount-codes.ts:314`, `cloudflare/src/commerce/discount-codes.ts:352`).

The invariants stated there are:

> “returning early on a hit so a campaign code of the same name is never consulted”

and:

> “IT IS NEVER AN ERROR to present a code that does not resolve or is not eligible.”

— `cloudflare/src/commerce/discount-codes.ts:318`, `cloudflare/src/commerce/discount-codes.ts:324`.

The branch must resolve normalized code, tenant, active affiliate and entitlement server-side. It must return both the discount and the affiliate authority/rates needed to freeze attribution. A typed code follows precisely this path.

**The seam comment and kickoff overstate readiness.** “A new branch rather than a new signature” is insufficient for this rebuild:

- `ResolvedDiscount` currently carries only `code`, `discountCodeId` and `discountMinor`; it carries no affiliate discriminator, identity or commission rate (`cloudflare/src/commerce/discount-codes.ts:120`).
- Checkout skips resolution whenever **`discountCodes`** is off; preview does the same. An affiliate-enabled, Rabattkoder-disabled shop would therefore receive no affiliate discount unless both callers change (`cloudflare/src/commerce/checkout.ts:1357`, `cloudflare/src/commerce/discount-preview.ts:98`).
- A non-null `discountCodeId` causes checkout to create a Rabattkoder hold, even for an uncapped code (`cloudflare/src/commerce/checkout.ts:1522`). That hold has an FK to `discount_codes` (`cloudflare/migrations/0055_discount_code_holds.sql:17`).
- Conversely, a nonzero discount with a null `discount_code_id` is forbidden on both checkout and order (`cloudflare/migrations/0010_discount_codes.sql:156`, `cloudflare/migrations/0011_orders.sql:132`).
- The webhook burns campaign usage for every non-null frozen `discount_code_id` (`cloudflare/src/commerce/webhook.ts:780`).

Therefore, the design must explicitly choose a representation:

1. A genuine shared/backing code row, with an affiliate discriminator and campaign-only holds/burns; or
2. Separate affiliate authority, with the existing discount-authority CHECKs and consumers migrated/generalized accordingly.

Simply returning an affiliate ID in the current field without changing its consumers is unsafe. Simply returning null fails the money CHECK. Any retained generic ID must have an explicit kind so campaign queries cannot interpret it as a Rabattkod.

The feature gates should be branch-specific: affiliate lookup under `affiliate`, campaign lookup under `discountCodes`. D30’s collision refusal should prevent ambiguous stored strings, while affiliate-first resolution remains the defensive precedence rule. Collision enforcement must cover both domains’ creation and rename mutations, whose existing campaign functions use their own mutation batches (`cloudflare/src/commerce/admin-discount-codes.ts:18`, `cloudflare/src/commerce/admin-discount-codes.ts:695`, `cloudflare/src/commerce/admin-discount-codes.ts:769`).

Preview must retain its documented boundary:

> “DISPLAY-ONLY … it never writes, never holds a use, and is never a source of money.”

— `cloudflare/src/commerce/discount-preview.ts:13`.

Keep the same unsuccessful response for unknown, inactive, wrong-shop, disabled or ineligible codes; do not expose affiliate identity, rates or rejection reasons through preview. That uniform contract is documented at `cloudflare/src/commerce/discount-preview.ts:24` and in the route at `cloudflare/src/routes/storefront-discount-preview.ts:16`.

Checkout must retain its viability checks for minimum charge and fee coverage; an affiliate branch must not bypass them (`cloudflare/src/commerce/checkout.ts:1401`). If a discount is refused there, its affiliate treatment must be explicit—do not accidentally leave behind attribution from a discarded resolution.

Extend `matchesExisting` to compare freshly resolved affiliate ID, authority kind, commission/discount rates and any independently frozen eligibility facts, not just the resulting amount. Its invariant is:

> “The comparison is against the freshly-resolved server prices, not against the client's payload”

— `cloudflare/src/commerce/checkout.ts:839`.

Two affiliates with identical buyer discounts must not become interchangeable under one idempotency key. The existing comparison already explicitly distinguishes equal-value codes by authorization ID (`cloudflare/src/commerce/checkout.ts:880`).

**2. Frozen checkout facts and atomic order accrual**

The authoritative boundary is unequivocal:

> “The `checkouts` row is. Nothing else.”

— `cloudflare/src/commerce/webhook.ts:43`.

Freeze at least:

| Fact | Purpose |
|---|---|
| Affiliate ID and tenant association | Stable beneficiary, independent of later code changes. |
| Discount authority kind and ID | Separate affiliate resolution from campaign holds/burns. |
| Canonical affiliate code, if historical display is required | Avoid relabeling old orders after a rename. |
| Affiliate discount basis points and actual discount minor units | Record what the buyer received. |
| Commission basis points and formula/version | Prevent later rate edits changing historical earnings. |
| Commission base and amount, or sufficient immutable inputs to derive both exactly | Permit deterministic award and reversal. |
| Self-referral eligibility/result | Prevent mutable profile changes changing a pending checkout’s award. |
| Reported source, if retained | UI/audit information only; not proof of a click or authority to earn. |

These are **new** fields. Existing totals, shipping and VAT rate already provide the monetary inputs copied into orders (`cloudflare/src/commerce/webhook.ts:528`).

Use coherent insert checks and immutable update triggers. The precedent is `checkouts_connect_facts_frozen`/`checkouts_connect_facts_coherent`, with immutable order copies (`cloudflare/migrations/0019_money.sql:120`, `cloudflare/migrations/0019_money.sql:133`, `cloudflare/migrations/0019_money.sql:269`). Affiliate facts frozen at quote creation need protection from that point, rather than merely copying the Connect trigger’s “freeze after first non-null value” semantics.

The no-FK reasoning in migration 0010 is relevant:

> “the checkout's frozen numbers must survive that unchanged”

— `cloudflare/migrations/0010_discount_codes.sql:129`.

Do not use `ON DELETE SET NULL` or cascading deletion to rewrite historical attribution. A snapshot ID without an FK is one option; an affiliate tombstone retained under a restrictive FK is another. In either case, historical commission must not depend on the affiliate remaining active or retaining its current code.

**Accrual location:** append the affiliate accrual statement after the order INSERT in the existing `statements` array, before `db.batch(statements)`. Put conversion-notification outbox rows in that same batch. The relevant statements begin at `cloudflare/src/commerce/webhook.ts:525`; the commit is at `cloudflare/src/commerce/webhook.ts:858`.

The invariant is:

> “Order, receipt hand-off, lines, status history, the checkout transition, the discount burn, the audit row and the event ledger row all commit together.”

— `cloudflare/src/commerce/webhook.ts:513`.

The accrual joins that list. It must not run after commit, in a queue consumer, or in a completion trigger.

The external-effect rule is likewise explicit:

> “Every external effect this order causes is a row in the SAME batch”

— `cloudflare/src/commerce/webhook.ts:656`.

Keep accrual uniqueness at one per order. Keep `isDuplicateDelivery` narrow: it recognizes payment-event and order uniqueness, not every UNIQUE violation (`cloudflare/src/commerce/payment-events.ts:96`). An unrelated affiliate/code collision must not be swallowed as a successful webhook replay.

**Settlement must honor accepted frozen attribution.** Rechecking today’s feature flag, code spelling or commission rate after payment would contradict the checkout-authority model. The webhook deliberately avoids repricing even a lapsed quote (`cloudflare/src/commerce/webhook.ts:464`). Turning the feature off should stop new affiliate quotes and acquisition, while already paid/committed obligations continue to settle. This is a deliberate correction to Firebase’s award-time feature/status gate in spec §3.5.

**3. Refunds, lost disputes and cancellation**

The refund invariant is:

> “The money moves only if THIS batch performed the transition”

— `cloudflare/src/commerce/refunds.ts:47`.

`orderEffectStatements` calculates deltas from `prev_state` and `state`, guarded by the operation’s fresh `transition_id`. Its first statement moves `refund_succeeded_minor` and `refunded_total_minor` (`cloudflare/src/commerce/refunds.ts:142`, `cloudflare/src/commerce/refunds.ts:155`).

**The affiliate refund hook belongs in that statement builder, immediately after the money update.** That covers both:

- Existing-operation transitions through `transitionOperation` (`cloudflare/src/commerce/refunds.ts:271`).
- Newly discovered dashboard refunds, whose operation INSERT invokes the same builder in the same batch (`cloudflare/src/commerce/refunds.ts:478`).

Compute the new required cumulative affiliate reversal from the **updated** settled refund facts, then append only the difference from the affiliate ledger’s already recorded reversal. Guard every effect with this transition. This prevents duplicate facts and concurrent deliveries from reversing twice, and avoids rounding independently on each partial refund.

For a simple unallocated proportional policy, define:

- Original accrual `A`.
- Original charge `T`.
- Current settled refunds `R`.
- Required reversal `roundHalfUp(A × min(R,T) / T)`, capped at `A`.

Append the difference from the previous required reversal. Use exact integer arithmetic; multiplication may require BigInt or a bounded quotient/remainder implementation.

This formula is a **recommended default for refunds with no product/shipping allocation**, not something already implemented. Shipping-only treatment is an explicit decision in C.

Do not key reversal on `orders.status`. `STATUS_AFTER_REFUND_SQL` deliberately preserves fulfilment statuses on partial refunds (`cloudflare/src/commerce/refunds.ts:112`). A shipped order can have reduced earnings without becoming `partially_refunded`.

Also handle **refund succeeded → failed**: the port permits this and subtracts the formerly succeeded amount (`cloudflare/src/commerce/refunds.ts:69`, `cloudflare/src/commerce/refunds.ts:426`). The affiliate ledger then needs an append-only restoration adjustment. A monotonic “commissionReversed” flag cannot represent the port’s state machine.

**Dashboard refunds:** `charge.refunded` applies embedded refund objects immediately; otherwise it records a cumulative Stripe amount and relies on reconciliation to fetch the individual refunds (`cloudflare/src/commerce/stripe-events.ts:347`, `cloudflare/src/commerce/stripe-events.ts:403`). Reconciliation feeds those facts into `applyRefundFact` (`cloudflare/src/commerce/crons.ts:1013`, `cloudflare/src/commerce/crons.ts:1038`).

Thus “no second pass” means **no separate affiliate repair pass after a refund settles**. It cannot mean that every `charge.refunded` payload already contains enough information to settle all refund operations synchronously.

**Lost disputes are a separate seam.** They do not call `applyRefundFact` or increment `refund_succeeded_minor`. `applyDisputeFact` currently performs a guarded order UPDATE, and `handleDisputeEvent` subsequently records the event (`cloudflare/src/commerce/stripe-events.ts:613`, `cloudflare/src/commerce/stripe-events.ts:683`).

Its documented invariant is:

> “Idempotent … and guarded on the recovery state it read”

— `cloudflare/src/commerce/stripe-events.ts:548`.

**New:** turn the dispute mutation into a batch that records the accepted dispute fact and the affiliate lost-dispute reversal together. Use a dispute/transition guard and uniqueness that remains safe when the same fact is applied repeatedly. A lost dispute should reverse the remaining accrued commission under D26, capped so prior refund reversals cannot make total reversal exceed the original accrual.

Open disputes should block payout; they should not permanently reverse commission merely because money recovery from the shop is pending. Favourable outcomes must not be treated as losses. The existing classification distinguishes `won`, `warning_closed` and `prevented` (`cloudflare/src/commerce/stripe-events.ts:475`).

**Spec §9.1’s `UNIQUE(order_id, kind)` is wrong for the taken D26 policy.** It can express one accrual, but cannot express multiple partial-refund reversals and later restoration. Use a partial uniqueness rule for the accrual and operation/transition-specific keys for adjustments (`docs/cf-port/specs/AFFILIATE.md:499`).

**Cancellation:** do not reverse at `cancelOrder`.

> “CANCELLING MOVES NO MONEY … It does not move `orders.status` either”

— `cloudflare/src/dispatch/cancellation.ts:35`.

Reversing there would remove earned commission while the shop still holds the buyer’s payment, and would make later refund reversal require special repair logic. A cancellation can put the accrual on hold while the refund is resolved; the financial reversal belongs to settled refund/lost-dispute facts. Spec §9.2’s instruction to reverse in the cancel endpoint is incompatible with this port invariant (`docs/cf-port/specs/AFFILIATE.md:514`).

**4. Affiliate payout operations and the Stripe funding problem**

`payouts.ts` is a **shop payout projection**, not a money-moving implementation:

> “`payout` here is not a payment instruction”

— `cloudflare/src/commerce/payouts.ts:4`.

`WITHDRAWAL_WINDOW_MS` is 14 days from `paid_at`; `derivePayoutState` blocks open disputes, recovery in flight and disabled shop payouts (`cloudflare/src/commerce/payouts.ts:35`, `cloudflare/src/commerce/payouts.ts:150`). This does not reserve affiliate money or guarantee it remains in the shop’s Stripe balance.

**New affiliate operation discipline:**

1. **Reserve:** atomically establish that mature, unreserved affiliate earnings in the same tenant and currency cover the request; reserve the amount and freeze destination, rail and amount.
2. **Execute in cron:** recheck executable eligibility, claim the operation, mark submitted before the call, and call Stripe with **idempotency key = operation row ID**.
3. **Settle:** verify the Stripe fact against the frozen operation, then commit operation success, payout ledger debit and notification outbox together.
4. **Unknown outcome:** retain the reservation; reconcile by Stripe ID, operation metadata and transfer group. Do not release money or mint a replacement operation merely because a response was lost.
5. **Definite refusal:** release the reservation through a recorded state transition. Manual payment requires separately recorded evidence of completion; uploading an invoice is not payment.

This follows the existing release header:

> “execute reconciliation only … write-ahead `submitted`; create with idempotency key = the row id”

— `cloudflare/src/commerce/withholding-release.ts:46`.

The release implementation lists prior effects before retrying, refuses to treat an incomplete listing as proof of absence, and preserves unknown outcomes (`cloudflare/src/commerce/withholding-release.ts:689`, `cloudflare/src/commerce/withholding-release.ts:712`). Dispute recovery also explicitly protects against replay after Stripe’s idempotency-key retention window (`cloudflare/src/commerce/crons.ts:659`).

`connect-gateway.ts` is the **onboarding/account-status** seam, not the transfer seam. Its interface has account creation, links, status, balance and schedule methods (`cloudflare/src/commerce/connect-gateway.ts:10`, `cloudflare/src/commerce/connect-gateway.ts:103`). Affiliate onboarding needs its own ownership mapping and recovery metadata; it must not reuse a tenant’s shop-account mapping.

Actual transfers are in `StripeMoneyGateway.createTransfer`, implemented as a platform-context `stripe.transfers.create` call. It currently exposes neither a source account nor `source_transaction` (`cloudflare/src/commerce/stripe-client.ts:217`, `cloudflare/src/commerce/stripe-client.ts:1080`).

**Can the existing platform transfer pay the affiliate?** Technically yes, if the platform has sufficient balance—but it spends **platform funds**. It does not debit the shop merely because the commission arose from that shop’s order. Stripe documents that transfers debit the creating account’s balance; `source_transaction` identifies a funding charge, not another connected account to debit. [Stripe transfer API](https://docs.stripe.com/api/transfers/create).

The port sends the gross charge to the shop and collects the application fee back; the fee currently comprises platform commission plus production withholding (`cloudflare/src/commerce/payouts.ts:4`, `cloudflare/src/commerce/payment.ts:34`, `cloudflare/src/commerce/payment.ts:149`). There is no affiliate reserve in that calculation.

**A shop account ID is not a valid substitute for `source_transaction`.** Nor does attaching the original platform charge to an extra transfer retrieve the money already sent to the shop. Destination charges are platform charges with a transfer to the destination. [Stripe destination charges](https://docs.stripe.com/connect/destination-charges?platform=web&ui=elements).

The design must name a real funding flow:

| Flow | Assessment |
|---|---|
| **Platform-funded transfer** | Smallest transfer implementation, but the platform finances the shop’s affiliate obligation. Use only with an explicit funding/subsidy decision; D29 does not itself authorize a subsidy. |
| **Connected-account debit → platform balance → affiliate transfer** | A possible shop-funded flow, subject to Stripe eligibility, consent, regional/currency restrictions, balance availability and extra cost. Stripe calls this **Account Debits**, using a charge request whose `source` is the connected account—not a transfer’s `source_transaction`. Treat the debit and onward transfer as separately reconciled operation legs. [Stripe account debits](https://docs.stripe.com/connect/account-debits). |
| **Separate charges and transfers** | The Stripe model intended to divide a platform charge among multiple recipients. It would replace the current destination-charge funding design and require a broader review of refunds, fee collection and shop payout accounting. It is not a small affiliate branch. [Stripe separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers). |
| **Reverse part of the original destination transfer, then transfer onward** | Requires new recovery accounting. The current refund/dispute machinery already uses the destination transfer as its recovery source; casually consuming part of it for affiliate funding would change those assumptions (`cloudflare/src/commerce/refunds.ts:52`, `cloudflare/src/commerce/crons.ts:648`). |
| **Separate payment from the shop, or manual payment** | Can fund the liability explicitly; it needs its own payment/settlement evidence. Manual is already the D29 fallback when a supported automatic flow is unavailable. |

**Recommendation:** preserve the current charge architecture for this rebuild; make Connect payout conditional on a proven, explicit shop-funding flow, with manual fallback. Do not enable automatic payouts based only on the affiliate possessing a connected account.

“No platform cut” means no additional platform share of the affiliate commission. It does not mean zero Stripe costs, platform subsidy, or removal of the existing platform/production fee. Keep that existing deduction as one seller-visible figure; affiliate commission is a separately understandable cost owed by the shop to its affiliate (`cloudflare/src/commerce/payouts.ts:28`, `cloudflare/src/commerce/payouts.ts:115`).

**5. Identity migration, authorization and every account-type branch**

The schema has three decisive properties:

- Better Auth email is globally UNIQUE (`cloudflare/migrations/0002_auth_identity.sql:4`).
- `identity_access.user_id` is its primary key: one account type per user (`cloudflare/migrations/0002_auth_identity.sql:62`).
- `tenant_memberships` already permits `role = 'affiliate'`, with uniqueness on `(tenant_id, user_id, role)` (`cloudflare/migrations/0002_auth_identity.sql:72`).

**Cheapest safe account-type migration:** rebuild **only `identity_access`**, preserving every current column—including `status_change_id` added by migration 0033—and recreate its index. Copy all rows unchanged into the replacement schema with `'affiliate'` added to the CHECK (`cloudflare/migrations/0002_auth_identity.sql:62`, `cloudflare/migrations/0002_auth_identity.sql:109`, `cloudflare/migrations/0033_identity_import_support.sql:284`).

The troublesome child-table rebuild described in migration 0009 is not required here: memberships and invites reference `"user"`, not `identity_access` (`cloudflare/migrations/0002_auth_identity.sql:75`, `cloudflare/migrations/0002_auth_identity.sql:94`, `cloudflare/migrations/0033_identity_import_support.sql:291`). Preserve `"user"` and its credentials/sessions.

Adding an allowlist trigger **cannot override the old CHECK**. A trigger-based allowlist would still require this initial rebuild to remove or widen the CHECK. Unlike feature keys, identity kinds are few and security-sensitive; the small table rebuild with an explicit CHECK is the simpler choice. Migration 0032 explains why its feature list was designed as replaceable triggers from the outset (`cloudflare/migrations/0032_tenant_config.sql:98`).

The following is the account-type audit. Some files need a new affiliate branch; others must deliberately retain a refusal or already handle the new type generically.

| File and function/statement | Required treatment | If forgotten |
|---|---|---|
| `cloudflare/src/auth/live-authorization.ts:76` — `authorizeTenantAdmin`; analogous print/platform guards | **New:** `AffiliatePrincipal` and `authorizeAffiliate`, requiring active identity, active affiliate membership, the chosen tenant and the appropriate affiliate record. Preserve existing admin/print/platform equality predicates. | Existing guards refuse affiliates; reusing an admin guard breaks the portal. Widening the admin predicate would instead grant excessive rights. |
| `cloudflare/src/auth/request-authorization.ts:93` — `authorizeTenantAdminRequest` | **New:** affiliate request guard using Better Auth session plus validated `X-Shop-Id` and live affiliate membership. Preserve opaque refusal and same-origin checks on mutations. | Existing admin guard refuses affiliates. Do not make its acting-as fallback a generic affiliate bypass. |
| `cloudflare/src/auth/session-self.ts:19`, `:62`, `:102` — `ServedAccountType`, `readSessionSelf`, `readMemberships` | Admit `'affiliate'` in the served type and SQL; return affiliate-role memberships and an explicitly affiliate-shaped session projection. | Current SQL silently returns null. Widening only that SQL would still list **admin** memberships and return the wrong role. |
| `cloudflare/src/platform/invites.ts:74`, `:116` — `inviteSurfaceFor`, `INVITABLE_TARGET_SQL` | Map affiliate to existing `"admin"` surface; extend both eligibility checks. Affiliate approval/resend must add tenant-membership/application guards. | Both current checks refuse affiliate invitations. Fixing only the first can still yield no committed invite. |
| `cloudflare/src/platform/provision-users.ts:71`, `:101`, `:473` — types, parser allowlist, `createInvitedUser` | Extend the passwordless creation contract for affiliate identities. Decide separately whether general platform provisioning should expose the new type; affiliate approval need not open a password-setting route. Preserve duplicate-email refusal. | Current type/parser exclude it. Existing-email conflict remains intentional, not a reason to overwrite credentials. |
| `cloudflare/src/platform/tenant-members.ts:254` — `refusalFor`, plus commit-time guards | **Keep** affiliate addresses `not_addable` as tenant admins under Q1’s one-kind model. New affiliate approval must enforce the symmetric refusal for tenant-admin addresses. | Current code correctly refuses affiliates; “fixing” it by admitting any active identity would break the one-kind boundary. |
| `cloudflare/src/platform/user-directory.ts:26`, `:148`, `:214` — `AccountType`, filter parser, projection | Extend type and filter allowlist. Existing generic membership projection can represent affiliate roles. | An unfiltered query can already return an affiliate row at runtime despite the stale TypeScript union; an explicit affiliate filter is rejected. |
| `cloudflare/src/platform/user-lifecycle.ts:114`, `:239`, `:311` — deactivate/reactivate/revoke | Explicitly include affiliate in lifecycle policy; global platform suspension should revoke its sessions. Add a separate tenant-scoped affiliate membership revoke; do not reuse `revokeTenantAdmin`. | Deactivate/reactivate **silently admit** a new non-platform type because their predicates are generic. Admin-membership revocation does not revoke an affiliate role. |
| `cloudflare/src/auth/password-reset.ts:90`, `:105`, `:317` — surfaces/origin/callback allowlist | Affiliate uses the existing admin reset page. Update assumptions/copy as appropriate; **no new origin or surface enum is required** merely because the account type is new. | Ordinary reset already goes to admin without classifying account type. Inventing `/affiliate/reset-password` without extending the exact callback allowlist would be redirected to the canonical reset page. |
| `cloudflare/src/email/auth-email-job.ts:58`, `:437` — invite variant and copy | Add validated affiliate/shop context to the invite wording and fingerprint; retain the safe password-reset mechanism. | Existing invite is accepted but silently uses platform-branded generic copy. An invented unsupported variant must also be added to validation. |

The authorization invariant to preserve is:

> “The claim is worth nothing on its own”

— the `X-Shop-Id` request-authorization header, `cloudflare/src/auth/request-authorization.ts:82`.

The identity-creation invariant is:

> “Plain INSERT, never an upsert”

— `cloudflare/src/platform/provision-users.ts:410`.

Also retain the platform grant’s refusal to convert another account kind (`cloudflare/src/platform/provision-tenants.ts:524`). Existing exact platform/print predicates are not lists to widen indiscriminately.

Two additional integration points:

- The admin Worker already forwards the host-only session cookie and `X-Shop-Id`, and preserves `Set-Cookie`; add affiliate API routes to its narrow allowlist rather than using the storefront proxy (`cloudflare/admin/src/forward.ts:26`, `cloudflare/admin/src/forward.ts:75`, `cloudflare/admin/src/routing.ts:35`).
- The platform console’s frontend user list explicitly requests only platform and tenant admins. Decide whether affiliates belong there and update the list if so; they will otherwise remain absent (`src/admin-app/adapters/platformConsole.js:52`, `src/admin-app/replacements/platformUsersData.js:66`).

**Q1 does not resolve the hardest identity question.** One affiliate membership per shop creates separate **authorization**, not separate passwords or user identities. A person cannot use the same email for a tenant-admin identity and a distinct affiliate identity under the current schema. Nor can two `"user"` rows with that email supply separate affiliate logins for two shops.

My recommendation is to retain Q1’s one-kind security boundary for launch: mixed admin/affiliate use requires a different real login address. For affiliate-to-affiliate multi-shop use, explicitly state whether D30 means tenant-scoped access under one affiliate credential or genuinely separate credentials. The kickoff’s membership interpretation supports the former; literal per-shop credentials require different addresses or a larger authentication redesign. Do not quietly rewrite Better Auth email uniqueness, fabricate synthetic email identities, or turn an existing admin into an affiliate. The conflict is between `docs/cf-port/CP13_AFFILIATE_KICKOFF.md:49`, `docs/cf-port/DECISIONS.md:145`, and the schema cited above.

**6. Feature configuration and public application intake**

Move `affiliate` into `FEATURE_KEYS` and `OPT_IN_KEYS`, and remove it from `NOT_PORTED_FEATURE_KEYS` (`cloudflare/src/platform/tenant-config.ts:112`, `cloudflare/src/platform/tenant-config.ts:140`, `cloudflare/src/platform/tenant-config.ts:152`).

Replace **both** database triggers in a new migration:

- `tenant_features_key_allowlist_insert` — `cloudflare/migrations/0032_tenant_config.sql:125`.
- `tenant_features_key_allowlist_update` — `cloudflare/migrations/0032_tenant_config.sql:136`.

The invariant is:

> “MUST equal the allowlist in the 0032 triggers”

— `cloudflare/src/platform/tenant-config.ts:107`.

The tests that pin this are `cloudflare/test/tenant-features.test.ts:81`: default/key expectations, extraction of both trigger lists from `sqlite_master`, and INSERT/UPDATE refusals. The currently hard-coded affiliate UPDATE refusal at `cloudflare/test/tenant-features.test.ts:126` must change. These tests were read, not run.

Also add affiliate to `PORTED_FEATURE_KEYS`; otherwise the public response still reports it off. Its header requires a storefront body revision bump when that response changes (`cloudflare/src/storefront/public-storefront.ts:46`). Public feature expectations are covered at `cloudflare/test/public-storefront.test.ts:168`.

For applications, use the existing limiter’s single atomic counter update. Its privacy invariant is:

> “the raw key … never reaches D1 or a log line”

— `cloudflare/src/lib/rate-limit.ts:40`.

Use a dedicated application scope, `visitorRateKey(clientIp(request))`, bounded input and a server-resolved tenant. The stored value is SHA-256 of scope plus key; it is **not** a salted/HMAC anonymity guarantee (`cloudflare/src/lib/rate-limit.ts:47`, `cloudflare/src/lib/rate-limit.ts:165`, `cloudflare/migrations/0008_rate_limits.sql:22`). Keep it operationally separate from affiliate analytics. The existing limiter opportunistically sweeps old windows (`cloudflare/src/lib/rate-limit.ts:124`).

Application creation, initial status and applicant/admin notification outbox rows should commit together. Approval/denial should preserve decision history rather than delete the application immediately; add a defined PII retention policy. These application mechanisms are **new**.

**7. Invoice storage**

Use the private `document` kind (`cloudflare/src/storage/object-store.ts:113`).

The storage invariant is:

> “The key encodes ownership for operability only; the row is the authority.”

— `cloudflare/src/storage/object-store.ts:275`.

The reusable lifecycle is `reservePendingObject` → `uploadAdminObject` → `activateObject`. The upload streams to R2 with the declared hash enforced by R2, then activates the row (`cloudflare/src/storage/object-routes.ts:641`). A payout must reference an active, same-tenant document and freeze that attachment once it becomes financial evidence.

Two additions are necessary:

- **Affiliate-specific access:** existing object helpers prove tenant ownership, not ownership by one affiliate. Add an invoice association checked against the authenticated affiliate and payout.
- **Invoice-specific validation:** the generic private upload accepts a well-formed content type and has a 100,000,000-byte cap; it is not the Firebase invoice rule of PDF ≤10 MB (`cloudflare/src/storage/object-routes.ts:117`, `cloudflare/src/storage/object-routes.ts:162`). Add the chosen PDF/size rules server-side. PDFs should remain downloads, consistent with `privateDeliveryHeaders` (`cloudflare/src/storage/object-routes.ts:484`).

**Does an orphaned reservation get swept? No wired general reservation sweep was found.** The scheduler runs outbox, commerce reconciliation/checkout retention, screening, Connect alerts and reminders; checkout retention concerns production snapshots, not abandoned `stored_objects` (`cloudflare/src/outbox/scheduled.ts:79`, `cloudflare/src/outbox/scheduled.ts:132`, `cloudflare/src/commerce/crons.ts:93`).

The comment about leaving “garbage for the sweep” at `cloudflare/src/storage/object-routes.ts:783` should not be mistaken for an implemented cleanup guarantee.

**New:** bounded cleanup for expired pending uploads and unattached invoice drafts, including R2-success/D1-activation-failure cases; protect attached financial documents. Existing private delivery is an authenticated proxy, so spec §9.1’s signed-URL proposal is not an existing port facility (`cloudflare/src/storage/object-store.ts:554`, `docs/cf-port/specs/AFFILIATE.md:503`).

**8. Email queue, ledger kinds and branding**

Reuse the existing outbox → deterministic email job → delivery ledger → queue-consumer path. The invariant is:

> “every retry builds the identical job”

— `cloudflare/src/email/order-emails.ts:26`.

And the ledger’s privacy rule is:

> “stores no recipient address, action URL, or raw token”

— `cloudflare/migrations/0003_email_delivery_ledger.sql:3`.

**New mail kinds**, if modeled separately as recommended:

- `affiliate_application_received`
- `affiliate_application_notice_shop`
- `affiliate_application_denied`
- `affiliate_conversion`
- `affiliate_reversal`
- `affiliate_payout`

Add `affiliate_welcome` only if welcome is a separate business notification. A password-set welcome implemented as an affiliate-specific **variant of `password_reset`** does not require a new ledger kind; that is already how invites work (`cloudflare/src/platform/invites.ts:48`).

All genuinely new kinds require a ledger CHECK migration plus parser, renderer, job union and fingerprint support (`cloudflare/src/email/auth-email-job.ts:25`, `cloudflare/src/email/auth-email-job.ts:280`, `cloudflare/src/email/email-delivery-store.ts:48`).

**Use the latest schema, not just 0050.** Migration 0056 subsequently added `checkout_reminder`; rebuilding from 0050 alone would remove a currently valid kind (`cloudflare/migrations/0056_checkout_reminders.sql:195`). Preserve rows, fingerprints, both triggers and indexes as the existing rebuild recipe does (`cloudflare/migrations/0050_email_kinds.sql:19`).

Application/decision/conversion/reversal/payout mail intents belong in their business mutation batches. Freeze mutable display data when first building the job and derive delivery identity from the underlying event/operation. The current outbox email effect documents both deterministic identity and first-build freezing (`cloudflare/src/outbox/email-effect.ts:55`, `cloudflare/src/outbox/email-effect.ts:65`).

**Affiliate-facing business mail should use the shop’s name.** The affiliate works for that shop. Extend the F05 sender-name mechanism to application receipts, denial, welcome, conversion, reversal and payout mail; retain the platform’s configured sending address and use the shop support address where appropriate.

That behavior is **not automatic today**. F05 currently covers buyer mails; auth invites and internal shop notices retain the configured sender (`cloudflare/src/email/email-queue-consumer.ts:32`, `cloudflare/src/email/email-queue-consumer.ts:151`). The invite template hard-codes `PLATFORM_DISPLAY_NAME` (`cloudflare/src/email/auth-email-job.ts:451`). Passing `tenantId` alone does not change that.

A generic password reset for a shared multi-shop identity has no unambiguous shop sender. Keep such authentication mail platform-branded unless the design introduces validated shop context; do not infer branding from an arbitrary request parameter.

Staging behavior remains queue/ledger inspection only. With no mail transport configuration, the consumer retries without sending (`cloudflare/src/email/email-queue-consumer.ts:339`).

**9. `?ref=CODE`, cart storage and anonymous click statistics**

The storefront forwarding invariant is:

> “`Cookie` is dropped: the storefront holds no session”

and:

> “`Set-Cookie` removed”

— `cloudflare/web/src/forward.ts:7`, `cloudflare/web/src/forward.ts:93`.

The browser API boundary is an allowlist:

> “not a route that is added to the API later until a row is added here”

— `cloudflare/web/src/api-allowlist.ts:5`.

The least-privilege implementation is:

1. On a shop page, the SPA reads and normalizes `?ref=CODE`.
2. It puts that code into the existing shop cart, with `source: 'link'`.
3. A valid link-sourced code wins over a typed code under D24; precedence is explicit and immediate, rather than Firebase’s “next cart change” accident.
4. Preview and checkout independently validate the code. The source marker never authorizes an affiliate or proves a real click.
5. Clearing/completing the cart clears this cart attribution. No separate 30-day referral key is created.
6. A server-side landing handler increments only the resolved affiliate’s daily counter. Counting failure does not prevent the discount or commission.

The existing cart persists a normalized discount code but does not yet retain a source, and currently enables codes only under `discountCodes` (`src/storefront/providers/Cart.jsx:59`, `src/storefront/providers/Cart.jsx:63`, `src/storefront/providers/Cart.jsx:120`). Those are explicit SPA seams.

**The kickoff’s Q3 wording is inaccurate:** the Worker cannot directly set browser localStorage or a session code. That work belongs to the SPA; the Worker handles the landing request/count (`docs/cf-port/CP13_AFFILIATE_KICKOFF.md:52`).

A suitable server hook is the web Worker’s page handling, with a narrow internal API operation carrying only normalized code and trusted shop routing. `servePage` and the API service binding already exist, but there is no referral counter there today (`cloudflare/web/src/index.ts:75`, `cloudflare/web/src/index.ts:158`). Do not expose an internal counting route through the browser allowlist unnecessarily. Public application submission does need an explicit allowlist entry.

Count page landings, not asset requests, HEAD probes and API requests. Store only tenant, affiliate, day and count. Do not copy `CF-Connecting-IP`, UA or referrer into this analytics operation; the normal API forwarding path does carry the visitor IP for operational rate limiting (`cloudflare/web/src/forward.ts:57`).

**Is this an acceptable “clicks” statistic?** Yes, if labeled accurately as referral-link landings/requests. It includes repeat visits, reloads, bots and prefetches. Without identifiers it cannot provide:

- Unique visitors.
- Person/session deduplication.
- Conversion attributed to an individual click.
- A cohort-accurate click-to-purchase conversion rate.

Paid orders can still be attributed to a code. Dividing code-attributed orders by landing requests is at most an approximate aggregate ratio—typed codes and later purchases prevent it from being a true click-conversion measure.

For a future consented cookie, set it in a deliberate **shop-origin web Worker response**, or through browser code if HttpOnly is unnecessary. An API response’s `Set-Cookie` will currently be stripped. Server-side consumption would also need a narrow consented referral-cookie mechanism at the web edge, since blanket API forwarding strips `Cookie`. Do not relax the session boundary for this feature (`cloudflare/web/src/forward.ts:48`, `cloudflare/web/src/forward.ts:104`).

Finally, `<shop>.flippinstuff.se` is the target shape, not a referral-specific routing facility already implemented here: current routing supports shared-host shop paths and own-domain roots; API tenant resolution requires a verified domain mapping (`cloudflare/web/src/routing.ts:8`, `cloudflare/src/tenancy/resolve-tenant.ts:33`). Coordinate generated links with CP14 rather than hard-coding an assumed hostname transformation.

**10. Commission base, VAT and exact rounding**

The quote invariant is:

> “Prices are VAT-INCLUSIVE … VAT is then derived from the DISCOUNTED total”

— `cloudflare/src/commerce/checkout.ts:738`.

**There are no mixed per-item VAT lines in this quote model.** Checkout reads one `tenants.vat_rate_bp`, derives aggregate VAT and freezes that rate with the order (`cloudflare/src/commerce/checkout.ts:792`, `cloudflare/src/commerce/checkout.ts:778`, `cloudflare/src/commerce/webhook.ts:552`). The kickoff’s “actual VAT lines” wording must therefore mean the order’s actual frozen VAT facts in this port, not an existing per-product tax-line subsystem.

Recommended integer contract:

```text
T = orders.total_minor
S = orders.shipping_minor
v = orders.vat_rate_bp
c = frozen affiliate_commission_bp

G = max(0, T - S)                  # discounted goods, VAT-inclusive
d = 10000 + v

q = floor(G × 10000 / d)
r = G × 10000 - q × d

B = q + (2r >= d ? 1 : 0)         # commission base, ex VAT, in öre

commission_minor = roundHalfUp(B × c / 10000)
```

Equivalently, the base is `G - vatMinor(G, v)` using the existing half-up-on-net rule (`cloudflare/src/commerce/shipping.ts:344`, `cloudflare/src/commerce/shipping.ts:357`).

Remove **VAT-inclusive shipping before extracting goods VAT**. Do not subtract the order’s entire VAT from `T-S`: that VAT also includes shipping.

Commission uses half-up rounding to one minor unit. Buyer percentage discount retains the existing **ceiling** rule, not commission rounding (`cloudflare/src/commerce/discount-codes.ts:132`). Use the helper’s quotient/remainder discipline or BigInt to avoid unsafe intermediate multiplication (`cloudflare/src/commerce/discount-codes.ts:141`).

This recommendation explicitly rounds the base to öre before calculating commission. Firebase rounded only the final commission after a fractional-öre base; the design should name that possible one-öre difference rather than claim exact parity. Likewise, independently rounding net shipping and net total and subtracting them can differ by one öre from rounding net goods directly. Choose and freeze one allocation rule.

Worked example from spec §3.5:

| Calculation | Öre |
|---|---:|
| Cart | 50,000 |
| Buyer discount: 1,000 bp, 10% | 5,000 |
| Discounted goods | 45,000 |
| Shipping | 2,900 |
| Paid total | 47,900 |
| Frozen VAT rate | 2,500 bp |
| Goods ex VAT: `45,000 × 10,000 / 12,500` | 36,000 |
| Commission: `36,000 × 1,500 / 10,000` | **5,400** |

The whole order’s VAT is 9,580 öre; shipping’s VAT is 580 öre; goods VAT is 9,000 öre. The affiliate earns **54.00 kr**, matching `docs/cf-port/specs/AFFILIATE.md:214`.

**11. Seller and affiliate projections**

Preserve the actual one-number rule:

> “The platform's deduction is ONE figure, `feeMinor`”

— `cloudflare/src/commerce/admin-orders.ts:11`.

It prohibits disclosure of the platform fee’s commission/production split, printer costs, production snapshots and internal transfer details. It does **not** prohibit showing the shop what it owes its own affiliate.

Recommended projection boundaries:

| Reader | Allowed affiliate information | Excluded |
|---|---|---|
| Tenant admin | Own-shop affiliate identities and configured rates; code attribution; commission per order; reversals; held/available/reserved/paid balances; payout status and authorized invoices. | Platform commission/production split, printer costs, internal funding/recovery details, other shops’ affiliates. |
| Affiliate | Own profile/code/rates/terms; own balances and payouts; order **number, date, net base, commission, status**, plus currency where needed. | Buyer email/name/address/phone, order-recipient rows, receipt capabilities, payment identifiers, other affiliates’ data, platform/production costs. |
| Buyer | Buyer-facing discount and ordinary receipt facts. | Affiliate commission, balances, payout information or internal identity details. |

Build new projections field by field from named columns, following `readAdminOrder` and `admin-order-list.ts` (`cloudflare/src/commerce/admin-orders.ts:141`, `cloudflare/src/commerce/admin-order-list.ts:8`). Do not return the tenant-admin order projection to affiliates: it intentionally includes buyer contact and fulfilment information (`cloudflare/src/commerce/admin-orders.ts:69`).

Use explicit names such as `affiliateCommissionMinor` so the new shop-owned cost cannot be confused with the platform commission the current output deliberately conceals. Do not change the existing Stripe-balance contribution into “net after affiliate” without separately accounting for whether affiliate money actually moved; the current payout calculation has a specific recorded-facts meaning (`cloudflare/src/commerce/payouts.ts:130`).

## C. Open risks the design must decide, ranked

| Rank | Risk | Recommendation |
|---|---|---|
| **1 — Blocking** | **Connect funding source:** the existing transfer spends platform balance, while order proceeds went to the shop (`cloudflare/src/commerce/stripe-client.ts:1080`, `cloudflare/src/commerce/payouts.ts:4`). | Preserve destination charges; permit Connect affiliate payouts only after proving an explicit shop-funded flow, otherwise use D29’s manual fallback—never silently subsidize from platform funds. |
| **2 — Blocking** | **Identity collision and “per-shop logins”:** globally unique email plus one account type cannot represent separate same-email admin/affiliate identities or independent per-shop credentials (`cloudflare/migrations/0002_auth_identity.sql:7`, `:62`). | Keep cross-kind refusal; require a different real address for mixed roles, and explicitly resolve whether D30 means one affiliate credential with scoped memberships or distinct credentials requiring a broader auth design. |
| **3 — High** | **Discount authority representation:** affiliate IDs/nulls cannot simply pass through today’s campaign holds and discount CHECKs (`cloudflare/src/commerce/checkout.ts:1527`, `cloudflare/migrations/0010_discount_codes.sql:156`). | Choose and document a discriminated shared-code or separate-authority model before writing the affiliate branch, covering both checkout and order constraints and all campaign consumers. |
| **4 — High** | **Fourteen-day hold versus payout requests:** shop `payout_state` is informational and no affiliate reservation exists (`cloudflare/src/commerce/payouts.ts:4`, `:168`). | Show held and available separately; reserve only mature earnings, block unresolved refund/dispute exposure, and recheck execution eligibility without releasing an operation whose Stripe outcome is unknown. |
| **5 — High** | **Shipping-only refunds:** current refund input/facts contain amounts, not validated product/shipping allocation (`cloudflare/src/commerce/refunds.ts:297`, `:534`). | Reverse zero for a proven shipping-only refund only after adding structured allocation; otherwise use a documented proportional-to-charge fallback—never infer allocation from free-text reason. |
| **6 — High** | **Repeated partial refunds, late refund failure and lost-dispute overlap:** one reversal flag or `UNIQUE(order_id, kind)` cannot model them (`cloudflare/src/commerce/refunds.ts:69`, `docs/cf-port/specs/AFFILIATE.md:501`). | Use cumulative target adjustments, transition-specific idempotency and a total reversal cap; append restoration when a succeeded refund later fails. |
| **7 — High** | **Refund after affiliate payment:** the 14-day delay does not eliminate later liabilities, and completed transfers cannot be undone by deleting ledger rows. | Permit an explicit negative affiliate balance and future-earnings offset; separately define authorized transfer recovery and who bears unrecoverable debt, scoped by tenant and currency. |
| **8 — High** | **Feature-off, suspension or rename during payment:** Firebase re-resolves eligibility after payment, while the port honors frozen checkout facts (`cloudflare/src/commerce/webhook.ts:43`, `:464`). | Stop new acquisition/quotes when disabled, but honor accepted frozen attribution and continue reversals, liability reads and payouts; retain historical affiliates/codes as tombstones. |
| **9 — Medium** | **Rounding and VAT allocation:** the port has one frozen VAT rate, and rounding the base versus only the final commission can differ by one öre (`cloudflare/src/commerce/shipping.ts:344`, `cloudflare/src/commerce/checkout.ts:792`). | Adopt and version B10’s half-up goods-net base and half-up commission, retain minor-unit discount ceiling, and record the departure from Firebase explicitly. |
| **10 — Medium** | **Invoice orphans and attachment lifetime:** reserve/upload/activate has no wired abandoned-reservation cleanup (`cloudflare/src/storage/object-store.ts:275`, `cloudflare/src/outbox/scheduled.ts:132`). | Add bounded cleanup for pending/unattached invoice drafts and protect attached financial evidence from mutable-object deletion. |
| **11 — Medium** | **Analytics overclaim and storage lifetime:** identifier-free counts cannot establish unique visitors or click-level conversion; the cart currently persists in localStorage (`src/storefront/providers/Cart.jsx:59`). | Label counts as referral landings, keep attribution within the cart lifecycle, and make no 30-day or unique-visitor promise. |
| **12 — Medium** | **Welcome/reset context and incomplete approval:** existing provisioning, membership creation and invite issuance are separate operations, and generic invites are platform-branded (`cloudflare/src/platform/tenant-members.ts:442`, `:473`, `:480`, `cloudflare/src/email/auth-email-job.ts:451`). | Make approval resumable/idempotent with durable invite intent, shop-branded affiliate welcome and a safe resend path; preserve existing credentials when adding an allowed membership. |

---

## The prompt

```
You are the reviewer in step 1 of docs/cf-port/CP13_AFFILIATE_KICKOFF.md §5: a READ-ONLY audit before the design of the affiliate rebuild on the Cloudflare port (branch cf-port). Do not edit files. Do not run tests. Read and reason.

GOAL. Read docs/cf-port/specs/AFFILIATE.md (the exact Firebase behaviour, with its bugs; §7 dead/half-built, §8 security, §9 rebuild notes) and docs/cf-port/DECISIONS.md D24–D30 (every default is TAKEN, see the kickoff §3). Then read the Cloudflare code the rebuild must plug into, and produce a written audit with two lists:

A. WHAT THE REBUILD MUST NOT INHERIT from the Firebase implementation — each item: spec reference (§x.y), the concrete defect, and the port-side mechanism that prevents it (name the file/function/trigger that already exists, or say "new: …" if nothing exists yet). Cover at least: §8.1 approveAffiliate account takeover, §8.2 plaintext credentials, §8.3 open application create, §8.4 mutable ledger counters, §8.5 forgeable attribution (client metadata, clickId, unscoped lookup, global ref key, weak self-referral), §8.6 admin view by URL param, §8.7 personal data in clicks, §8.9 rules too tight → projections, §3.4 typed code earns nothing, §3.5 non-transactional award (claim then loose writes), §3.6 reversal gaps (dashboard refunds, lost disputes, partial), §3.7 payout only 'completed' + orphaned invoice, §4.3 collisions with Rabattkoder, §7.6 case bug, float SEK money.

B. WHICH PORT SEAMS THE REBUILD TOUCHES, with for each: file + function/statement, what the affiliate branch must do there, and the invariant that must survive (quote the header comment that states it). Read these:
- cloudflare/src/commerce/discount-codes.ts resolveDiscount (the "AFFILIATE SEAM" comment ~L300–360) and the callers: checkout.ts (the quote, the frozen discount facts, the "freshly resolved discount" parity check ~L860–900), discount-preview.ts, routes/storefront-discount-preview.ts (the no-oracle rule).
- cloudflare/src/commerce/webhook.ts: the order-creation batch (~L500–870: the INSERT INTO orders, the discount used_count burn against the FROZEN checkout.discount_code_id, the outbox rows in the same batch, isDuplicateDelivery). Where does the affiliate accrual row belong so it is atomic with the order? What frozen facts does it need on `checkouts` (compare migrations/0010_discount_codes.sql's reasoning for `checkouts.discount_code_id` with no FK, and 0019_money.sql's frozen-facts triggers)?
- cloudflare/src/commerce/refunds.ts applyRefundFact (the state machine, STATUS_AFTER_REFUND_SQL, the batch that moves refund_succeeded_minor) and stripe-events.ts (charge.refunded, charge.dispute.closed lost): where does a pro-rata reversal (D26) hook so a dashboard-originated refund and a lost dispute both reverse, idempotently, with no second pass?
- cloudflare/src/dispatch/cancellation.ts cancelOrder: cancellation moves no money ("moneyMoved: false") — should a cancel reverse an accrual (Firebase did) or should the port reverse only when money actually moved back (refund)? Argue from the port's invariants.
- cloudflare/src/commerce/payouts.ts (WITHDRAWAL_WINDOW_MS, payout_state), withholding-release.ts (the reserve→execute-in-cron→settle pattern, D38 "money moves in the cron"), connect-gateway.ts: how should an affiliate Connect transfer (D29) be shaped so it follows the same reserve/execute/settle discipline and idempotency key = row id? Can a transfer be made from the PLATFORM balance to an affiliate's connected account when the order's money sits on the SHOP's connected account (destination charge, transfer = gross)? Name the Stripe flow that fits (e.g. the shop's account as the source via a transfer with `source_transaction`? platform-funded transfer? a separate charge?) and what it means for "no platform cut" (D29) and for the seller-sees-ONE-number rule (memory: the fee is one figure; costs never client-readable).
- cloudflare/migrations/0002_auth_identity.sql: identity_access.account_type is a CHECK enum (ordinary, tenant_admin, platform_admin, print_operator) and tenant_memberships.role already admits 'affiliate'. Q1 decided: a new account_type 'affiliate' on the ADMIN host with Better Auth sessions. SQLite cannot alter a CHECK: what is the cheapest safe migration (table rebuild like 0009? a trigger-based allowlist like 0032's feature keys? — note the FK from tenant_memberships/print_memberships/identity_invites etc. to "user", not to identity_access)? List every file that pattern-matches on the account_type union and must gain the new type: src/auth/live-authorization.ts, request-authorization.ts, session-self.ts (ServedAccountType), platform/invites.ts (inviteSurfaceFor, INVITABLE_TARGET_SQL), platform/provision-users.ts createInvitedUser, platform/tenant-members.ts (the `not_addable` rule for an address held by another kind of account — an affiliate's address must stay refusable as a tenant admin and vice versa, or decide otherwise and say why), platform/user-directory.ts, user-lifecycle.ts, auth/password-reset.ts (RESET_PAGE_SURFACES, resetPageOrigin), email/auth-email-job.ts (invite wording). Which of these would silently admit or silently refuse an 'affiliate' identity if forgotten?
- cloudflare/src/platform/tenant-config.ts FEATURE_KEYS / NOT_PORTED_FEATURE_KEYS / OPT_IN_KEYS and migrations/0032_tenant_config.sql's two allowlist triggers: `affiliate` moves to the allowlist as OPT-IN (off by default). Which tests pin the two lists together?
- cloudflare/src/lib/rate-limit.ts and migrations/0008_rate_limits.sql: the pattern for the public application form (per-IP hashed key).
- cloudflare/src/storage/object-store.ts / object-routes.ts: the private `document` kind for the payout invoice PDF (reserve → upload → activate). Does an orphaned reservation get swept?
- cloudflare/src/email/*: the queue, the ledger (0003/0029/0050 kinds), auth-email-job.ts (invite variant), order-emails.ts (shop sender name rule F05). Which new mail kinds need a ledger CHECK migration, and must mails to an affiliate be sent under the SHOP's name (the affiliate works for the shop) or the platform's?
- cloudflare/web/src/forward.ts + routing.ts + api-allowlist.ts: the storefront Worker strips Cookie and Set-Cookie and holds no session. D27: code-only attribution, a cookie only with consent, no raw IPs. What is the least-privilege shape for `?ref=CODE` on <shop>.flippinstuff.se — the SPA puts the code into the per-shop cart (localStorage, already strictly necessary) as the cart's discount code with source 'link', no separate 30-day key, and the Worker counts the click server-side with NO personal data (no IP, no UA; a per-affiliate-per-day counter)? Is a server-side click counter without any identifier an acceptable "clicks" statistic, and what does it NOT allow (unique visitors, conversion by click)? If a cookie is wanted later behind consent, where would it be set given forward.ts's rules?
- cloudflare/src/commerce/checkout.ts: the quote uses tenants.vat_rate_bp (one rate per tenant, prices VAT-inclusive, vat derived from the discounted total). D25 "ex VAT from the order's actual VAT lines": state the exact integer formula for the commission base given orders.{total_minor, shipping_minor, vat_rate_bp} (shipping also carries VAT inside the total), and the rounding rule to match the port's integer-only money (basis points, no floats; compare percentDiscountMinor in discount-codes.ts). Give the worked example from spec §3.5 (cart 500 kr, 10 % discount, shipping 29 kr, 25 % VAT) in öre.
- The "seller sees ONE number" rule and "costs never client-readable": which affiliate figures may a tenant admin see (commission per order, yes — it is the shop's own cost to its affiliate) and which an affiliate may see (never buyer PII: allowlist order number, date, net base, commission, status). Check how admin-orders.ts / admin-order-list.ts project orders for the pattern.

C. OPEN RISKS the design must decide, ranked, each with your recommendation in one line. Include at least: the Connect transfer source question; whether 'affiliate' as account_type collides with a person who is BOTH a shop admin and an affiliate (one user row, one identity_access row ⇒ one account_type: is that acceptable per D30 "per-shop logins", or must the affiliate identity be a separate user row keyed by email+tenant, which Better Auth's UNIQUE email forbids?) — this is the hardest identity question, treat it carefully; the hold-through-14-days interaction with payout requests; what "pro-rata" means when the refund is of shipping only.

FORMAT. Markdown. Headings A, B, C. Every claim about the port cites file:line (read the file to get the line). Where the kickoff or the spec is wrong about the port's code, say so explicitly. No code changes, no patches. Length: as long as needed, no padding. Write the final report as your last message in full (it will be saved verbatim).
```
