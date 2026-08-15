# Full Security, Product and UX Audit

**System:** Chopshop / Meteor  
**Audit date:** 2026-08-15  
**Revision audited:** `a4d0177` (`fix(pod): live-gate hardening — close the four P1 bypass paths`)  
**Surfaces:** Admin, Shop, Platform, Print, Design Studio, Firebase, Storage, Cloud Functions, payments and fulfilment  
**Mode:** Read-only audit. No application code, data, configuration, commits, pushes or deployments were changed.

## Executive verdict

The repository builds and its isolation suite is broad, but it is **not ready to be treated as fully tenant-safe or payment/fulfilment-safe**. Three critical trust-boundary defects require immediate remediation:

1. A shop admin can re-home many of their own Firestore documents into another shop by changing `shopId` during an update.
2. The custom email-verification flow returns the verification secret to the caller and does not bind the requested recipient to the caller's Firebase Auth email.
3. B2C checkout does not bind product ownership, public availability or fulfilment SKU to server-authoritative data. A crafted request can cross shop, pricing and print-routing boundaries.

These are systemic issues, not Design Studio polish regressions. They affect tenant integrity, identity assurance, money allocation and physical fulfilment. The recommended response is an emergency invariant-hardening release followed by payment/order, print reliability, privacy and UX waves.

### Risk by touchpoint

| Touchpoint | Highest severity | Main exposure |
|---|---:|---|
| Admin | P0 | Tenant re-homing; stored print-view XSS; unrestricted order mutation |
| Shop | P0 | Cross-tenant checkout; verification bypass; consent/pickup gates bypassable |
| Platform | P0 | Re-homed tenant data; mutable impersonation trail; mailer and credential weaknesses |
| Print | P0 | Client-controlled SKU can select wrong artwork; incomplete/unpaid work can enter production |
| Design Studio | P1 | Non-atomic publish/mapping lifecycle; stale artwork and order snapshots |
| Firebase/Storage | P0 | Missing tenant immutability; overly broad document/file access and deletion |

### Severity model

- **P0 — Critical:** credible cross-tenant, identity, money or physical-fulfilment compromise. Fix before normal feature work.
- **P1 — High:** material security, privacy, payment or production failure requiring near-term remediation.
- **P2 — Medium:** defence-in-depth, reliability, accessibility or scaling defect with meaningful user/business impact.
- **P3 — Low:** product-quality or consistency issue unlikely to cause immediate loss by itself.

No evidence of exploitation was sought or found; this was source and configuration analysis, not a production penetration test.

## P0 — Critical findings

### P0-01 — Systemic cross-tenant document re-homing

**Affected:** Admin, Platform, Shop, POD/Print, Firestore  
**Evidence:** `firestore.rules:161-188`, `353-377`, `445-552`.

Most shop-scoped update rules authorize against the document's **old** `resource.data.shopId`, but do not require the incoming `request.resource.data.shopId` to remain equal. A Shop A admin can therefore update an A-owned product, order, affiliate, payout, discount code, campaign, social post, POD artwork or POD mapping and set its `shopId` to Shop B. The write passes based on the old tenant and the resulting document is then trusted by Shop B.

This enables storefront pollution, PII/order injection, reporting corruption, foreign affiliate/campaign data, and POD mapping or artwork corruption. `b2cCustomers`, the admin branch of `b2bCustomers`, `adminPresence`, `adminUIDs` and `userWagonSettings` have related tenant/identity immutability or blind-write concerns.

**Required fix:** create a reusable immutable-tenant rule condition and apply it to every tenant-scoped update; keep any re-homing operation server-only, explicit and audited. Restrict mutable fields on orders rather than merely freezing `shopId`. Add emulator tests that update an owned Shop A document to `shopId: ShopB` for every collection family.

### P0-02 — Email verification does not prove mailbox ownership

**Affected:** Shop identity, customer accounts, Admin  
**Evidence:** `functions/src/email-orchestrator/functions/sendCustomEmailVerification.ts:37-41,61-95,120-127`; `functions/src/email-orchestrator/functions/verifyEmailCode.ts:28,35-73`.

The send function checks that the caller UID matches the payload UID, but does not verify that `customerInfo.email` equals the Auth user's email. It then returns the generated verification code to the caller. The public verifier accepts that code and marks the stored UID `emailVerified: true`. A newly created account can therefore self-verify without opening the mailbox.

Raw verification codes are also written to logs. The Admin “send verification” action cannot work with the current self-only guard, while the Admin UI separately allows a visually equivalent `E-post verifierad` checkbox, further weakening the meaning of the state.

**Required fix:** use Firebase's native verification action-code flow or generate a one-time, hashed, single-use token that is never returned or logged; derive UID and email from Auth/server records; atomically consume the token. Distinguish an administrative override from verified mailbox ownership in both data and UI.

### P0-03 — Checkout crosses tenant, catalogue and print-routing boundaries

**Affected:** Shop, payments, orders, accounting, POD/Print  
**Evidence:** `functions/src/payment/createPaymentIntent.ts:41-86,266-272,317-341,471-484`; `functions/src/print/printProjection.ts:108-146,218-221`.

The public payment endpoint accepts a client-selected shop, loads products by ID, and checks price/variant and a narrow active condition. It does not require `product.shopId === resolvedShopId`, `availability.b2c === true`, or a published/active shop. It then persists client-supplied `sku`, `name`, `label` and image fields. Print resolves `order.items[].sku` to artwork mappings.

A crafted cart can therefore price one legitimate/cheap/foreign product while stamping another shop or POD SKU into the paid order, causing revenue/reporting misallocation and wrong physical artwork fulfilment. Active B2B-only or otherwise hidden products can also be purchased by direct request.

**Required fix:** resolve shop from the trusted storefront context, require a live/published shop, load every product and variant server-side, verify tenant and B2C availability, and derive the complete immutable line-item snapshot—including SKU, display data and fulfilment identifiers—from that server snapshot. Add adversarial integration tests for foreign product IDs, hidden products, foreign SKU, mismatched variant and disabled shops.

## P1 — High findings

### Security, identity and tenant controls

#### P1-01 — Email functions can act as mail relays

`sendEmailVerification` and `sendAffiliateApplicationEmails` are unauthenticated and accept caller-supplied recipients/content. `sendOrderStatusUpdateEmail` and `sendAffiliateWelcomeEmail` require admin status but do not bind the recipient or resource to that admin's tenant. This permits spam or phishing through the platform's sender identity. Evidence: `sendEmailVerification.ts:22`; `sendAffiliateApplicationEmails.ts:31`; `sendOrderStatusUpdateEmail.ts:33-44`; `sendAffiliateWelcomeEmail.ts:27`.

**Fix:** accept resource IDs, not recipient payloads; load recipient/template/tenant server-side; authenticate and authorize against that resource; add durable rate limits and abuse telemetry.

#### P1-02 — Public endpoints lack effective distributed abuse controls

Payment-intent creation, leads, affiliate clicks, reset/review/recovery paths and some mail flows have no shared durable rate limit or App Check enforcement. The only shared limiter is in-memory, scraper-specific and trusts a caller-influenced forwarding header. CORS does not stop non-browser callers. Evidence: `createPaymentIntent.ts:266`; `submitLead.ts:8`; `logAffiliateClick.ts:12-53`; `rate-limiter.ts:3-46`.

**Fix:** use a trusted edge/IP source, distributed counters, per-account/resource budgets, idempotency and bot protection. App Check is useful defence-in-depth, not a replacement for authorization.

#### P1-03 — Migration import SSRF guard is DNS-rebinding vulnerable

WooCommerce and Shopify migration URLs are checked as literal hostnames/IPs but DNS is not resolved and revalidated before fetch. A public-looking hostname can resolve to a private or link-local destination. Evidence: `migrationShared.ts:89`; `migrateFromShopify.ts:113`; `migrateFromWoo.ts:94`. The website scraper already has a safer resolution pattern.

**Fix:** resolve all A/AAAA records, reject private/reserved/link-local ranges, pin the validated address through redirects, restrict schemes/ports, cap response size/time, and revalidate each redirect.

#### P1-04 — Impersonation audit records are mutable and optional

Platform users can update audit records they created without an immutable-field allowlist, and platform access already bypasses normal shop scoping without requiring an impersonation session. Evidence: `firestore.rules:269`; `src/config/impersonation.js:3`.

**Fix:** make audit records append-only/server-written, bind actor/target/reason/timestamps immutably, and require sensitive tenant actions to carry an active audited support context.

#### P1-05 — Live secrets and customer data are logged

Verification and reset codes, customer emails, full order/customer objects and PaymentIntent data are logged in server or browser paths. Evidence includes `sendCustomEmailVerification.ts:95`, `verifyEmailCode.ts:28`, `confirmPasswordReset.ts:34`, `stripeWebhook.ts:526`, and `src/contexts/OrderContext.jsx:486-602`.

**Fix:** remove secrets entirely; use structured allowlisted fields, redaction and environment-aware log levels; define log retention/access policy. A log reader must never be able to redeem an account token.

### Payments, orders and customer protection

#### P1-06 — Pickup and free shipping are enforced only partially on the server

Any request with `deliveryInfo.method === 'pickup'` receives zero shipping unless a product explicitly disables pickup. The server does not verify that the shop has an active pickup location, nor derive the location/address/date from trusted shop configuration. Evidence: `createPaymentIntent.ts:62-64,175-189,329-330`.

**Fix:** accept a pickup-location ID, resolve it server-side, validate it is live for the order's shop and products, validate any date window, and persist only resolved values.

#### P1-07 — Personalized-goods withdrawal consent is not required server-side

The server detects a personalized cart but only logs when withdrawal consent/version/fingerprint is missing and continues creating the PaymentIntent. The UI checkbox is bypassable. Evidence: `createPaymentIntent.ts:403-425`; `StripePaymentForm.jsx:28-32`.

**Fix:** reject before creating payment; store the policy version, localized text fingerprint, timestamp and cart fingerprint with the immutable order record.

#### P1-08 — Partial refunds are recorded as full refunds

`refundOrder` accepts a partial amount but unconditionally marks the order `refunded`, blocks subsequent refunds, and triggers a full affiliate reversal. Evidence: `functions/src/payment/connectRefund.ts:51-104`.

**Fix:** transactionally track cumulative refunded amount and Stripe refund IDs; use `partially_refunded` until the total is reached; reverse fees/commission proportionally or according to an explicit policy; make retries idempotent.

#### P1-09 — Shop admins can rewrite or delete whole order documents

Same-shop admins receive unrestricted update/delete permission over orders. They can alter totals, customer PII, delivery, status and refund/transfer markers outside server workflows; callables then trust some of those fields. Evidence: `firestore.rules:353-377`.

**Fix:** make financial/order records server-owned. Expose narrow callables for allowed transitions and, if client edits remain, enforce an explicit affected-key allowlist and state machine. Do not allow client deletion of accounting records.

#### P1-10 — Stored DOM XSS in admin print/export helpers

Admin order print, label printing and order verification interpolate customer/order fields into HTML passed to `document.write` or `innerHTML` without context-safe escaping. Customer-supplied names, company, address, notes or item data can execute markup/event handlers when an admin opens a print view. Evidence: `src/pages/admin/AdminOrderDetail.jsx:360-455`; `src/utils/labelPrinter.js`; `src/utils/orderVerification.js:461`.

**Fix:** construct DOM with `textContent`, use a hardened templating/escaping layer, sanitize only as an additional control, and isolate printable output with `noopener`/sandboxed origin where practical. Add malicious-address regression fixtures.

#### P1-11 — Full public product documents expose non-public commerce data

Anonymous reads expose all product documents, including inactive/draft products and embedded `b2bPrice`/configuration. Firestore rules cannot redact fields. Public CMS pages and collections have the same draft-disclosure pattern. Evidence: `firestore.rules:161-188`; `ProductForm.jsx:204-259`.

**Fix:** publish a field-minimized public catalogue projection. Keep wholesale price, cost, internal availability/configuration and drafts in private documents. Public rules should query only explicitly published records.

### POD and Print production integrity

#### P1-12 — Print queue includes unpaid B2B orders

The queue excludes terminal statuses but can include pending/invoiced B2B orders. The status mutation function correctly refuses those states, yet artwork and job details can still become visible/downloadable. Evidence: `functions/src/print/functions.ts:40-66`; `setPrintJobStatus.ts:27-36`; `createB2BOrder.ts:138-184`.

**Fix:** query only producible statuses or show held jobs with all production/download actions disabled.

#### P1-13 — A partially unresolved POD order can be marked complete/shipped

Status transitions require only one resolvable POD line, not every production line. One valid item can allow an order with another missing mapping/artifact to be marked printed or shipped, triggering customer communications. Evidence: `setPrintJobStatus.ts:121-125`; `printProjection.ts:143-147,204-207`.

**Fix:** require every POD line to resolve a valid immutable production artifact; otherwise place the order in an explicit production-hold state.

#### P1-14 — Print status transitions have a TOCTOU race

The function reads and validates status, then performs an unconditional update. Concurrent operators can both pass the old-state check, duplicate history and trigger duplicate shipment/review email. Evidence: `setPrintJobStatus.ts:114-137,158-185`.

**Fix:** transactionally compare expected prior status and write the transition once; send notifications from an idempotent durable outbox after commit.

#### P1-15 — Printer notification delivery is not durable

The Stripe webhook invokes print notification without awaiting it or persisting a retryable event. B2B creation/status paths have no equivalent notification when an order becomes paid. Evidence: `stripeWebhook.ts:597-635`; `createB2BOrder.ts:193-245`; `OrderContext.jsx:413-482`.

**Fix:** emit a deduplicated durable task/outbox event when an order first becomes production-ready, regardless of B2C/B2B source.

#### P1-16 — Rejected or replaced artwork can affect paid orders

Reprocessing can mark artwork rejected while retaining an old print file; projection checks path availability rather than requiring the current artwork to be ready. Replacing an artwork also changes the shared document used by unshipped, already-paid orders. Evidence: `processArtwork.ts:365-385`; `printProjection.ts:284-302`; `podArtwork.js:57-63`; `ArtworkUploadModal.jsx:350-354`.

**Fix:** version production artifacts and snapshot the exact artwork version/path onto the paid order. New orders may use only `ready` versions; existing orders retain their immutable approved snapshot.

#### P1-17 — Clients can delete server-owned POD print files

Storage rules protect client create/update under `print/`, but allow deletion across the wider artwork partition. A client can remove a live print PNG and strand production. Evidence: `storage.rules:113-132`.

**Fix:** deny client deletion for `print/`; perform reference-aware cleanup only through trusted server code.

#### P1-18 — Legacy print-path signing can cross intended boundaries

The primary print path receives a shop-prefix check, but legacy original-path fallback lacks equivalent order-shop validation. Download validation checks only a broad shop prefix rather than approved `print/`/`originals/` subpaths. Evidence: `printProjection.ts:284-302`; `functions/src/print/functions.ts:253-276`.

**Fix:** fail closed; validate canonical bucket/path, shop, artifact type and order/mapping reference before signing. Never fall back to arbitrary stored URLs.

### Dependency exposure requiring a planned security update

Root production audit reported **19** vulnerabilities (15 moderate, 3 high, 1 critical); Functions production audit reported **15** (1 low, 4 moderate, 8 high, 2 critical). Directly relevant packages include vulnerable `dompurify` on storefront HTML and `sharp` processing untrusted artwork/images. Other findings include Firebase/Admin dependency trees, `undici`, gRPC, `protobufjs`, `websocket-driver`, `react-router`, Quill and transitive parsers.

Not every advisory is necessarily reachable in this application, and several fixes require major upgrades. Still, `dompurify` and `sharp` are directly exposed enough to treat as high-priority upgrades with regression tests. Do not use `npm audit fix --force` blindly.

## P2 — Medium findings

### Privacy, authorization and storage

- **P2-01 — Public order confirmation is a long-lived PII capability.** Anyone with a PaymentIntent/order ID can read the order; confirmation renders email and shipping address. High-entropy IDs reduce guessing risk but URL/history/log/support leakage remains. Use a separate expiring confirmation token or verified email proof. Evidence: `firestore.rules:353-357`; `OrderConfirmation.jsx:164-190`.
- **P2-02 — Public shop documents expose internal fields.** A known shop ID returns the whole document, potentially including owner UID, feature state, Connect ID, commission and payout state. Use public shop projections. Evidence: `firestore.rules:239`.
- **P2-03 — Cross-tenant marketing-file reads.** Generic marketing assets allow any authenticated user rather than same-shop users. Evidence: `storage.rules:188-191`.
- **P2-04 — Several uploads lack size/type limits.** Profile, product, branding, collection, page-attachment and order-attachment paths are overly broad; order attachments permit any admin regardless of tenant. Evidence: `storage.rules:49,63,74,90,104,263`.
- **P2-05 — Missing Content Security Policy.** Hosting sets HSTS, frame denial, nosniff, referrer and permissions headers, but no CSP. Add a report-only policy first, then enforce a nonce/hash-based policy after removing unsafe inline patterns.
- **P2-06 — Dormant Writers Wagon contains unsafe secret architecture.** Disabled code prompts for an `sk-ant-` key, references `VITE_CLAUDE_API_KEY`, claims secure storage, and calls backend functions that do not exist. Keep disabled and delete it or redesign around server-held secrets before enabling.

### Commerce and order reliability

- **P2-07 — Checkout account linkage is broken for post-payment account creation.** The PI is created before the account and the later linkage result is discarded, so the first order lacks a durable customer/auth link and stats can be skipped. Evidence: `StripePaymentForm.jsx:361-366`; `Checkout.jsx:493-514`.
- **P2-08 — Payment-intent creation lacks idempotency.** Retries/effects/automation can create orphan PaymentIntents. Use a server checkout-session key and Stripe idempotency key, in addition to rate limits. Evidence: `createPaymentIntent.ts:591-608`.
- **P2-09 — No inventory/reservation model.** The server permits large quantities while product schema has no stock reservation. This is safe only under an explicit make-to-order-only policy. Otherwise add atomic variant reservation.
- **P2-10 — Ambiguous payment error copy can encourage double payment.** UI states that a failed attempt was never charged even when a network/processing outcome may be unknown. Distinguish a definitive decline from an unknown state and provide a status lookup. Evidence: `StripePaymentForm.jsx:193-224`.
- **P2-11 — Return page can poll forever.** `processing` triggers an unbounded three-second loop without a terminal recovery/support state. Evidence: `OrderReturn.jsx:60-67`.

### Design Studio and Print reliability

- **P2-12 — Mapping upsert is non-atomic.** Two sessions can create duplicate `(shopId, sku, placementSlot)` rows; resolution may become nondeterministic. Use deterministic IDs or a transaction. Evidence: `podMappings.js:47-79`.
- **P2-13 — Studio publish is not an atomic workflow.** Mappings/files can be written before the product update, leaving orphan mappings or uploads after partial failure. Use a server-orchestrated idempotent publish transaction/saga with cleanup. Evidence: `DesignStudio.jsx:642-764,856-991`.
- **P2-14 — Mockup failures silently reduce selected colourways.** Failed renders are skipped and PublishPanel proceeds with successful mockups only. Block publish or require explicit acknowledgement listing missing selected colours. Evidence: `DesignStudio.jsx:430-471`; `PublishPanel.jsx:87-100`.
- **P2-15 — Legacy POD products can remain below the price floor.** Products without `podCostSek` show no floor until Studio republish. Backfill/migrate legacy POD cost data or prevent live POD products with unknown cost. Evidence: `ProductForm.jsx:381-386,1234-1237`.
- **P2-16 — Queue/export/library use unbounded reads.** Entire shop collections are loaded and partly filtered in memory; signed artwork work is performed unnecessarily for CSV. Add indexed pagination/cursors and purpose-built projections. Evidence: `functions/src/print/functions.ts:48-137,220-250`.
- **P2-17 — Signed-URL fallback trusts stored URLs.** Signing failure can return long-lived/external stored URLs; mockup image also derives from client-influenced order data. Fail closed and derive same-shop asset paths server-side. Evidence: `printProjection.ts:64-78,227-243,300-313`.
- **P2-18 — Printer account bootstrap exposes temporary passwords.** Credentials are returned to Platform UI and shown in a toast, with no visible forced reset or MFA path. Use one-time invite/reset links, forced setup and MFA. Evidence: `functions/src/print/functions.ts:168-210`; `PlatformPrinters.jsx:52-57`.

### UX, accessibility and performance

- **P2-19 — Storefront gallery and quantity controls have keyboard/name/target defects.** Pagination dots are roughly 8×8px with no accessible names; desktop thumbnails react to mouse hover only; quantity icon buttons are unnamed and allow the UI to exceed the server limit. Evidence: `PublicProductPage.jsx:581-628,673-687`.
- **P2-20 — Modal accessibility is inconsistent.** Multiple admin/platform/POD modal backdrops are clickable generic containers without consistent `role="dialog"`, accessible title/description, focus trapping/restoration or Escape behavior. Affected families include provisioning, shop users, migrations, DAC7, model editors, artwork upload and delete confirmation.
- **P2-21 — Destructive confirmations are inconsistent and weakly contextual.** Permanent deletion, refunds and role changes often use `window.confirm`, sometimes in English inside Swedish flows. Standardize a destructive-action dialog that states object, consequence and recovery, requiring stronger confirmation for irreversible operations.
- **P2-22 — Print portal mobile/accessibility gaps.** Queue tables can clip on narrow screens, several controls are ~32px high, mockup alt text is generic and mapping deletion relies on `title` without an accessible name. Evidence: `PrintShopQueue.jsx:93-157`; `PrintShopOrderDetail.jsx:168-247`; `ProductMapping.jsx:233-238`.
- **P2-23 — Print queue freshness is operationally weak.** It uses a hard-coded 90-day window and manual reload; notifications link to the portal root instead of the order. Use explicit filters, refresh status and deep links. Evidence: `PrintShopQueue.jsx:46-59`; `EmailOrchestrator.ts:214-220`.
- **P2-24 — Shared bundle is too large and crosses product surfaces.** `App.jsx` eagerly imports Shop, Admin, Platform and Print routes. The production entry is ~2.78 MB minified / ~735 kB gzip, so storefront users likely download unrelated operator code. Split by host/route and lazy-load heavy editors, charts and wagons.
- **P2-25 — Browser logging exposes operational/customer detail.** Production build does not drop console output, and order/payment/customer flows log large objects and PII. This also increases support-noise and extension/screenshot exposure.

## P3 — Product-quality findings

- **P3-01 — “Favorit ♡” is a dead control.** The product-page button has no handler. Remove it until implemented or complete the feature with clear saved state. Evidence: `PublicProductPage.jsx:647-649` and the duplicate desktop control near `817`.
- **P3-02 — Storefront load errors look like an empty shop.** Fetch errors are logged and then shown as an empty result. Add a distinct retry/error state. Evidence: `PublicStorefront.jsx:77-113`.
- **P3-03 — Visual language drifts from the NORD system.** Verified gray-on-coloured contrast/token issues appear in Affiliate Portal, country/language selectors and Platform model UI; affiliate analytics retains purple/cyan legacy styling. The automated detector also flagged repeated heavy left/bottom borders. Review warnings manually—many spinner/underline hits are false positives—but consolidate the verified drift into system components.
- **P3-04 — One UI claims an action that the backend rejects.** Admin “send verification” calls the self-only verification function using the customer's UID, so it cannot succeed. The error should not be discoverable only after click; redesign it alongside P0-02.

## Positive controls verified

- Stripe webhook signature verification is present, and deterministic order creation provides webhook idempotency.
- Prices and variant prices are recomputed server-side rather than trusting client totals.
- B2B order creation verifies product tenant and B2B availability more rigorously than B2C checkout.
- Print users have no direct Firestore/Storage grants; live role, active state and assigned-shop checks guard projection callables.
- Print projections intentionally minimize some customer PII and use boundary-safe longest-prefix mapping resolution.
- Artwork processing validates MIME, size and pixel dimensions, normalizes output and applies DPI checks.
- Design Studio auto-connects mappings, stamps POD state/cost for new Studio products, and ProductForm fails closed while mapping data loads.
- Firestore has a default-deny fallback and protects several server-only PII collections.
- User tenant/privilege updates and DAC7 paths contain stronger immutable-field checks that can serve as patterns.
- Node.js 22 is configured consistently for Firebase Functions.
- Hosting already sends HSTS, frame denial, MIME-sniff prevention, referrer and permissions headers.

## Verification performed

| Check | Result |
|---|---|
| Repository state | Clean at start; `a4d0177` matched the audited revision |
| Root production build | Passed |
| Functions TypeScript build | Passed |
| Firebase isolation/emulator suite | Passed: 42 Connect params, 18 dispute, 18 withdrawal, 30 DAC7, 28 base Firestore, 125 isolation, 18 function guards, 16 Storage |
| Root dependency audit | 21 total; 19 production vulnerabilities |
| Functions dependency audit | 20 total; 15 production vulnerabilities |
| Tracked secret scan | No private key, service-account JSON or tracked environment secret confirmed; public Firebase client config is expected |
| Impeccable static UI detector | Run once, then manually triaged; verified findings are included above |

Passing tests do **not** invalidate the P0 findings. Existing isolation tests cover direct writes to another shop but do not cover re-homing an already-owned document; checkout tenant/SKU invariants, email ownership, mailer authorization and audit immutability also lack regression coverage.

## Recommended remediation sequence

### Wave 0 — Emergency invariants

1. Freeze `shopId` and identity fields on all tenant-scoped client updates; make orders server-owned.
2. Replace/fix custom email verification and invalidate outstanding custom codes; remove secret logging.
3. Rebuild B2C line-item creation from authoritative server product/variant/shop data.
4. Enforce published/live shop, B2C availability, pickup configuration and personalized-goods consent server-side.
5. Add adversarial emulator/integration tests for each invariant before deployment.

### Wave 1 — Money and production correctness

1. Fix cumulative partial refunds and commission reversal semantics.
2. Make print transitions transactional and require every POD line to be ready.
3. Snapshot/version artwork for paid orders; close print-file delete/signing gaps.
4. Introduce a durable production-ready outbox for B2C and B2B notifications.
5. Remove stored-XSS sinks in admin print/label/verification tools.
6. Upgrade directly exposed vulnerable packages, starting with DOMPurify and Sharp.

### Wave 2 — Privacy and platform hardening

1. Create public catalogue/shop/order-confirmation projections with minimal fields and explicit publication state.
2. Add distributed abuse controls, idempotency and bot defence to public endpoints.
3. Bind all mail actions to server-loaded tenant resources.
4. Harden migration SSRF, Storage type/size/tenant rules and append-only platform audit.
5. Remove PII/secret logs and roll out CSP in report-only mode before enforcement.

### Wave 3 — Reliability and experience

1. Server-orchestrate/idempotently publish Studio products and mappings; handle mockup failures explicitly.
2. Backfill legacy POD costs and paginate queue/export/library reads.
3. Fix checkout recovery/account linkage and bounded processing polling.
4. Apply a modal/destructive-action accessibility standard across Admin and Platform.
5. Fix storefront and print keyboard/target/mobile issues; remove dead controls.
6. Split Shop/Admin/Platform/Print bundles and align remaining UI with DESIGN.md tokens.

## Exit criteria for the critical release

- A Shop A admin cannot create, update, re-home, read or delete Shop B tenant records through direct SDK calls.
- A verified-email state can be achieved only by consuming a server-issued, single-use proof delivered to the Auth email address.
- B2C checkout rejects foreign, hidden, non-B2C and inactive products and ignores all client line metadata other than product/variant/quantity identifiers.
- Paid order lines contain server-derived immutable SKU/artwork/tenant data and Print cannot transition until all required artifacts resolve.
- Pickup, withdrawal consent, refund state and order transitions are enforced by server invariants.
- Malicious customer strings render as text in every admin/print/export view.
- New regression tests fail against the current vulnerable behavior and pass only after remediation.

## Audit limits

This review covered repository source, configuration, rules, functions, builds, dependency metadata and existing tests. It did not inspect production Firestore/Storage contents, Cloud Logging, IAM assignments, Stripe/Firebase console configuration, deployed-version drift, DNS/custom domains, third-party dashboards, real email delivery, or live traffic. No exploit was executed against production. Those should be covered by a separate authorized operational review after the code-level P0 remediation.
