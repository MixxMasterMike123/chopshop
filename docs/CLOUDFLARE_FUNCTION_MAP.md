# Cloudflare migration function map

This is the bounded inventory for migrating the live Firebase Functions surface to
Cloudflare. The source of truth is `functions/src/index.ts`; the compiled export
surface was cross-checked with `Object.keys(require('./functions/lib/index.js'))`.

## Inventory count

There are **75 live exports**. Every live export appears exactly once below:

| Target class | Count | Cloudflare shape |
|---|---:|---|
| API route | 64 | Worker `fetch` route, normally JSON/HTTP or callable-compatible JSON |
| Stripe webhook | 1 | Public Worker route with raw-body signature verification |
| Queue event/consumer | 4 | Firestore-trigger replacement: Queue producer + idempotent consumer |
| Scheduled job | 3 | Cron-triggered Worker or Queue producer |
| Media Container task | 2 | Authenticated Worker route dispatching a Cloudflare Container task |
| Auth callback | 1 | Firestore user-write event consumer that mutates Auth claims |
| Intentional retirement | 0 live exports | Commented/quarantined legacy names are not exports and are excluded |
| **Total** | **75** | Matches the live compiled export count |

“API route” includes the existing callable functions. “Auth callback” is reserved
for the user-document trigger; auth-related callables remain API routes because
they are request/response entry points.

## Port order and invariants

Port in this order. A later phase must not become the source of truth before the
earlier phase is live and tested.

1. **P0 — platform substrate:** Workers routing, secrets, logging, rate limits,
   tenant resolver, Auth/JWT verification, D1 data adapter, R2 private
   object adapter, and Queue/cron plumbing.
2. **P1 — identity and authorization:** `syncUserClaimsOnWrite`, auth callbacks,
   admin/customer provisioning, and tenant-scoped policy helpers. Preserve
   `role`, `shopId`, and `platform` claims; privilege reduction must revoke or
   invalidate tokens.
3. **P2 — commerce and payment:** checkout pricing, B2B order creation, Stripe
   webhook, order completion, refunds, affiliate validation, and Connect. Verify
   tenant ownership and availability server-side; never trust client SKU, price,
   totals, or shop identity. Stripe webhooks require raw-body signature checks and
   PaymentIntent/order idempotency.
4. **P3 — production/media:** POD processing in Containers, immutable artifact
   paths in R2, mapping/artwork snapshotting before payment, print projection,
   and print-shop authorization. Preserve the rule that clients cannot write or
   delete server-owned print artifacts.
5. **P4 — asynchronous consumers:** order/product/review triggers and print
   outbox. Use at-least-once delivery, deduplication, leases/retries, and snapshot
   data rather than re-resolving mutable mappings for paid orders.
6. **P5 — scheduled work:** outbox, abandoned checkout, and review sweeps. Cron
   handlers should enqueue bounded work and be restart-safe.
7. **P6 — integrations and add-ons:** DAC7, scraping, content studio, lead and
   migration routes. Keep SSRF/DNS-rebinding defenses, private media paths, and
   feature/role gates.
8. **P7 — cutover/retirement:** dual-run by route, compare idempotent outputs,
   switch traffic, then remove Firebase exports only after logs show no callers.

## Live export map

### Email, identity, and administration

| Export | Current source | Class | Dependencies / invariant | Port |
|---|---|---|---|---:|
| `sendOrderConfirmationEmail` | `email-orchestrator/functions/sendOrderConfirmationEmail.ts` | API route | EmailOrchestrator; resolve recipient from trusted order/customer context; no client-chosen sender | P1 |
| `sendOrderStatusUpdateEmail` | `email-orchestrator/functions/sendOrderStatusUpdateEmail.ts` | API route | EmailOrchestrator; shop-scoped order and status transition | P1 |
| `sendOrderNotificationAdmin` | `email-orchestrator/functions/sendOrderNotificationAdmin.ts` | API route | Admin authorization; shop identity must come from trusted order/config | P1 |
| `sendPasswordResetEmail` | `email-orchestrator/functions/sendPasswordResetEmail.ts` | API route | Auth/email provider; never return reset material or log tokens | P1 |
| `sendLoginCredentialsEmail` | `email-orchestrator/functions/sendLoginCredentialsEmail.ts` | API route | Privileged provisioning flow; never expose credentials in response/logs | P1 |
| `sendAffiliateWelcomeEmail` | `email-orchestrator/functions/sendAffiliateWelcomeEmail.ts` | API route | Affiliate/shop tenant; EmailOrchestrator | P1 |
| `approveAffiliate` | `email-orchestrator/functions/approveAffiliate.ts` | API route | Same-shop/platform admin; approval state transition and email are idempotent | P1 |
| `createShopUser` | `email-orchestrator/functions/createShopUser.ts` | API route | Platform/shop-admin authorization; creates Auth + tenant claims atomically enough to fail closed | P1 |
| `createPlatformSuperAdmin` | `email-orchestrator/functions/platformUsers.ts` | API route | Platform-only; never infer platform privilege from request body | P1 |
| `deletePlatformUser` | `email-orchestrator/functions/platformUsers.ts` | API route | Platform-only; revoke Auth identity and claims | P1 |
| `migrateFromShopify` | `email-orchestrator/functions/migrateFromShopify.ts` | API route | Platform/admin; SSRF-safe fetch, progress state, tenant-bound writes and R2 uploads | P6 |
| `migrateFromWoo` | `email-orchestrator/functions/migrateFromWoo.ts` | API route | Platform/admin; SSRF-safe fetch, progress state, tenant-bound writes and R2 uploads | P6 |
| `sendCustomEmailVerification` | `email-orchestrator/functions/sendCustomEmailVerification.ts` | API route | Caller UID must match target; mailbox proof; never return verification code | P1 |
| `verifyEmailCode` | `email-orchestrator/functions/verifyEmailCode.ts` | API route | Server-side code/token verification; single-use and expiry checks | P1 |
| `sendAffiliateApplicationEmails` | `email-orchestrator/functions/sendAffiliateApplicationEmails.ts` | API route | Shop/admin recipient resolution; no arbitrary recipient or sender | P1 |
| `confirmPasswordReset` | `email-orchestrator/functions/confirmPasswordReset.ts` | API route | One-time password-reset token; expiry and Auth update; no token logging | P1 |
| `confirmPasswordResetV2` | `index.ts:274` alias of `confirmPasswordReset` | API route (compatibility alias) | Must remain byte-compatible until client migration; same one-time token invariant | P7 |
| `deleteCustomerAccountV2` | `customer-admin/functions.ts` | API route | Caller/tenant ownership; delete only permitted customer records and Auth identity | P1 |
| `deleteB2CCustomerAccountV2` | `customer-admin/functions.ts` | API route | B2C identity ownership and tenant scope; preserve accounting/order retention | P1 |
| `toggleCustomerActiveStatusV2` | `customer-admin/functions.ts` | API route | Same-shop/platform admin; status update cannot re-home identity | P1 |
| `createAdminUserV2` | `customer-admin/functions.ts` | API route | Platform/admin authorization; claims and user document tenant consistency | P1 |
| `syncAdminClaims` | `customer-admin/functions.ts` | API route | Platform/admin maintenance; claims derived from trusted user doc, not payload | P1 |
| `syncUserClaimsOnWrite` | `auth/syncUserClaimsOnWrite.ts` | Auth callback | Queue/event on `users/{uid}`; sync `role/shopId/platform`; revoke tokens on demotion or shop move | P1 |

### Commerce, affiliate, and public utility routes

| Export | Current source | Class | Dependencies / invariant | Port |
|---|---|---|---|---:|
| `logAffiliateClickV2` | `affiliate/callable/logAffiliateClick.ts` | API route | Public abuse/rate limit; shop/affiliate lookup; cannot accept arbitrary click attribution | P2 |
| `validateDiscountCode` | `affiliate/callable/validateDiscountCode.ts` | API route | Server-side code validity, tenant, dates, caps; response is advisory, checkout recomputes | P2 |
| `getGeoDataV2` | `geo/functions.ts` | API route | IP/geo provider; rate limit; no trust boundary for pricing or tenant identity | P2 |
| `scrapeWebsiteMetaV2` | `website-scraper/functions.ts` | API route | SSRF/DNS-rebinding defenses, response-size/time limits, no private-network access | P6 |
| `processB2COrderCompletionHttpV2` | `order-processing/functions.ts` | API route | Internal/order-completion endpoint; idempotent completion marker, email/stats/affiliate side effects exactly once | P2 |
| `createB2BOrder` | `order-processing/createB2BOrder.ts` | API route | Authenticated customer/admin; shop from trusted B2B customer; server prices/products; immutable production snapshot marker | P2/P3 |
| `cancelB2BOrder` | `order-processing/cancelB2BOrder.ts` | API route | Customer/admin scope; only cancellable unpaid state; append-only status history | P2 |
| `reverseAffiliateCommissionOnCancel` | `order-processing/commissionReversal.ts` | Queue event/consumer | Order cancellation/refund event; idempotent reversal; never reverse without terminal money state | P4 |
| `submitLead` | `leads/submitLead.ts` | API route | Public rate limit/validation; platform-level write only through server; no tenant spoofing | P6 |
| `submitWithdrawal` | `withdrawal/functions.ts` | API route | Auth/order ownership; eligibility and personalized-product regime; durable acknowledgement | P2 |

### Stripe and payment

| Export | Current source | Class | Dependencies / invariant | Port |
|---|---|---|---|---:|
| `createPaymentIntentV2` | `payment/createPaymentIntent.ts` | API route | Server product/variant/price/shop resolution; rate limits; consent; pre-payment production snapshot; Stripe idempotency | P2 |
| `stripeWebhookV2` | `payment/stripeWebhook.ts` | Stripe webhook | Raw-body signature; PaymentIntent/order idempotency; consumes pre-payment snapshot; server totals; no duplicate commission/refund effects | P2 |
| `createConnectAccount` | `payment/connectOnboarding.ts` | API route | Platform/shop admin; Stripe Connect account belongs to shop; secrets server-only | P2 |
| `createConnectAccountLink` | `payment/connectOnboarding.ts` | API route | Same-shop/platform authorization; short-lived Stripe link | P2 |
| `refreshConnectStatus` | `payment/connectOnboarding.ts` | API route | Same-shop/platform; Stripe is source of truth; tenant-bound status write | P2 |
| `createConnectLoginLink` | `payment/connectOnboarding.ts` | API route | Same-shop/platform; short-lived Stripe login link | P2 |
| `setShopCommission` | `payment/connectOnboarding.ts` | API route | Platform policy and bounded basis points; immutable accounting history where required | P2 |
| `getConnectBalance` | `payment/connectOnboarding.ts` | API route | Same-shop/platform; return only authorized shop balance | P2 |
| `setConnectPayoutDelay` | `payment/connectOnboarding.ts` | API route | Platform/shop admin; bounded payout delay and Stripe update | P2 |
| `refundOrder` | `payment/connectRefund.ts` | API route | Admin/platform and shop scope; cumulative refund ceiling; idempotency; commission/Connect reversal consistency | P2 |

### DAC7

| Export | Current source | Class | Dependencies / invariant | Port |
|---|---|---|---|---:|
| `saveDac7SellerProfile` | `dac7/functions.ts` | API route | Platform or seller-own shop; immutable identity/tenant fields; validation | P6 |
| `getDac7SellerProfile` | `dac7/functions.ts` | API route | Platform/admin scope; minimize tax PII | P6 |
| `pullDac7FromStripe` | `dac7/functions.ts` | API route | Platform-only; Stripe Connect source; no client-supplied financial data | P6 |
| `aggregateDac7Year` | `dac7/functions.ts` | API route | Platform-only; deterministic year/threshold aggregation from authoritative orders | P6 |
| `exportDac7Report` | `dac7/functions.ts` | API route | Platform-only; PII minimization and controlled download | P6 |
| `getOwnDac7` | `dac7/functions.ts` | API route | Seller-own shop only; return own profile/aggregate data | P6 |
| `correctOwnDac7Contact` | `dac7/functions.ts` | API route | Seller-own shop; append correction metadata, never re-home seller | P6 |
| `requestDac7Correction` | `dac7/functions.ts` | API route | Seller-own shop; durable request and rate limit | P6 |
| `resolveDac7Correction` | `dac7/functions.ts` | API route | Platform-only; one-way resolution/audit trail | P6 |

### POD, print, and production media

| Export | Current source | Class | Dependencies / invariant | Port |
|---|---|---|---|---:|
| `getPrintQueue` | `print/functions.ts` | API route | Live print-shop role and assigned-shop scope; snapshot-backed paid orders only; no PII | P3 |
| `getPrintJob` | `print/functions.ts` | API route | Same print-shop scope; signed R2 URL; blocks unpaid/snapshot-pending orders | P3 |
| `getPrintQueueExport` | `print/functions.ts` | API route | Same scope and field-minimized production projection; bounded export | P3 |
| `getPrintArtworkLibrary` | `print/functions.ts` | API route | Same scope; private artwork metadata only | P3 |
| `getPrintArtworkDownload` | `print/functions.ts` | API route | Same scope; exact shop `print/` or `originals/` prefix; short-lived signed URL | P3 |
| `createPrintShopUser` | `print/functions.ts` | API route | Platform-only provisioning; live role/assignment claims | P3 |
| `setPrintJobStatus` | `print/setPrintJobStatus.ts` | API route | Print-shop scope; allowed status transitions; every production line must have accessible artifact; transactional status write | P3 |
| `onOrderProductionReady` | `print/notifyOutbox.ts` | Queue event/consumer | Orders write event; snapshot freeze + deduplicated outbox; at-least-once/retry semantics | P4 |
| `sweepPrintNotifyOutbox` | `print/notifyOutbox.ts` | Scheduled job | Cron retry/lease/backoff/purge; never silently drop notification | P5 |
| `processPodArtwork` | `pod/processArtwork.ts` | Media Container task | Authenticated shop admin; private original read; sharp gate; server-only immutable `print/` artifact; R2 path validation | P3 |

### Checkout recovery, catalogue, reviews, and content studio

| Export | Current source | Class | Dependencies / invariant | Port |
|---|---|---|---|---:|
| `sweepAbandonedCheckouts` | `checkout-recovery/sweep.ts` | Scheduled job | Cron + Stripe state; retain pre-payment snapshot until PI is canceled/order exists; consent/suppression/frequency caps | P5 |
| `resolveCheckoutRecovery` | `checkout-recovery/callables.ts` | API route | One-time recovery token, expiry, shop binding; never expose checkout collection directly | P2 |
| `unsubscribeCheckout` | `checkout-recovery/callables.ts` | API route | One-time token and shop/email suppression key; idempotent | P2 |
| `syncProductsPublicOnWrite` | `catalog/syncProductsPublic.ts` | Queue event/consumer | Product write event; published/field-allowlisted projection; never expose wholesale cost or drafts | P4 |
| `onOrderReviewQualify` | `product-reviews/writeReviewRequest.ts` | Queue event/consumer | Fulfilment transition; one request per order/item; no review request before shipped/fulfilled | P4 |
| `sweepReviewRequests` | `product-reviews/sweep.ts` | Scheduled job | Cron; expiry/suppression/frequency caps; idempotent email send | P5 |
| `resolveReviewRequest` | `product-reviews/callables.ts` | API route | One-time review token; expiry and product/order binding | P2 |
| `submitReview` | `product-reviews/callables.ts` | API route | Verified request token; one review per eligible item; moderation state server-owned | P2 |
| `unsubscribeReviews` | `product-reviews/callables.ts` | API route | One-time token; scoped suppression; idempotent | P2 |
| `moderateReview` | `product-reviews/callables.ts` | API route | Admin/shop scope; approved projection only; audit/moderation state | P2 |
| `generateSocialCopy` | `content-studio/generateSocialCopy.ts` | API route | Auth + feature opt-in; bounded input/output; client may persist only scoped social post fields | P6 |
| `renderSocialVideo` | `content-studio/renderSocialVideo.ts` | Media Container task | Auth + feature opt-in; shop-owned asset paths; 12-file/size caps; ephemeral output in private R2 | P6 |
| `getHandoffPackage` | `content-studio/getHandoffPackage.ts` | API route | Token-guarded unauthenticated projection; return only copy/video URL, no shop/customer data | P6 |

## Intentional retirement inventory

There are no intentional-retirement exports in the live 75-name surface. The
following are comments/quarantine references only and must not be recreated as
Cloudflare routes: the old email-system functions in `functions/quarantine`,
`logAffiliateClickHttpV2`, `processAffiliateConversionV2`, and the commented
`sendB2BApplicationEmails`. The `confirmPasswordResetV2` name remains live as a
compatibility alias and is therefore mapped above, not retired yet.

## Ambiguities and migration cautions

- Firebase callable names are currently the public API contract. Keep the exact
  names or provide a compatibility Worker route until all SPA clients migrate.
- `processB2COrderCompletionHttpV2` is an exported HTTP compatibility endpoint,
  while the Stripe webhook calls the shared `processOrderCompletion` core directly.
  Do not make the public route the webhook's source of truth during porting.
- `onOrderProductionReady`, `onOrderReviewQualify`,
  `reverseAffiliateCommissionOnCancel`, and `syncProductsPublicOnWrite` are
  Firestore triggers today. Their Cloudflare equivalents need explicit Queue
  producers at every write boundary; polling alone changes delivery guarantees.
- `processPodArtwork` and `renderSocialVideo` are Firebase callables today, not
  deployed Containers. “Media Container task” is the target class because both
  require native image/video binaries and private object storage.
- `sweepAbandonedCheckouts` is both a recovery job and part of payment snapshot
  retention. Port its Stripe-aware cancellation/retention branch before enabling
  checkout cleanup in production.
- Existing paid orders without `productionSnapshot` remain legacy/live-mapping
  records. The migration must backfill or explicitly hold them before allowing
  mapping/artwork changes to be treated as fully immutable.
