# Cloud Functions inventory: port decisions for the Cloudflare move

**Scope.** Every export of `functions/src/index.ts` on `main` @ `533abf5` (2026-09-26). The platform is moving from Firebase to Cloudflare Workers + D1 + R2 + Queues. The rule is "port what earns its place, delete the rest", and the primary business is POD merch printed by SnapWear.

**Recommendations**
- **PORT**: the capability has to exist in Cloudflare before the first live shop. The Firebase mechanism doesn't have to survive (a trigger can become an inline call, for example). The *CF shape* note says what it turns into.
- **PORT-LATER**: a real feature or add-on that the first live POD shop doesn't need.
- **DELETE**: don't port it. That covers pre-pivot B8shield/reseller leftovers, dead twins, endpoints no client calls, and add-ons that don't earn a port.

**How this was built (so reviewers can re-run it)**
- **Export count.** 82 exports = 81 function definitions + `confirmPasswordReset`, which is exported twice (`index.ts:296` as `confirmPasswordResetV2`, `index.ts:299` under its own name). I diffed the list against the compiled `functions/lib/index.js` (`Object.defineProperty(exports, "…")`): 82 names, zero difference.
- **Client callers.** I searched `src/` and `public/` for each export name (`rg -w`), then checked every hit by hand. A hit that was only a comment doesn't count as a caller. I searched for `httpsCallable(…, 'name')` in all its forms, including the dynamic `call(name)` in `AdminPayments.jsx:126`. I also searched for `fetch(functionUrl('name'))` (`src/config/urls.js:41`).
- **Collections.** Taken from literal `collection('…')` calls in each file and in the helpers it imports. The only non-literal cases are `authGuard.ts:109`, which loops over `users`/`b2cCustomers`/`affiliates`, and `sendLoginCredentialsEmail.ts:80,87`, which picks `affiliates` or `users`. Both are resolved in the tables.

**Paths.** All source paths are relative to `functions/src/`. All caller paths are relative to `src/`.

**Legend for implicit reads.** These are left out of the per-row columns to keep them readable:
- **[A]** The auth guard (`requireAdminOfShop`/`requirePlatform`/`getAdminContext` in `email-orchestrator/functions/authGuard.ts`, or `getPrintShopContext` in `print/printGuard.ts`) reads the caller's live `users/{uid}` doc.
- **[F]** The feature-flag check (`config/shopFeatures.ts` `isShopFeatureEnabled`) reads `shops/{id}.features`.
- **[E]** The function sends mail through `EmailOrchestrator`. That reads `shops/{id}` for sender identity and admin routing, may read `users` (shop admins, or printers where `printShopShops` contains the shop), and reads `users`/`b2cCustomers` by id through `services/UserResolver.ts`. It sends through the **Resend** HTTP API (`services/EmailService.ts:34,110`).
- **[RL]** The durable rate limiter (`protection/rate-limiting/durableRateLimit.ts`) read-modify-writes `rateLimits`.

Every function runs in `us-central1`, and all nine Firestore triggers listen on the named database `b8s-reseller-db`. Every function sets the region explicitly except the three customer-admin callables (`deleteCustomerAccountV2`, `deleteB2CCustomerAccountV2`, `toggleCustomerActiveStatusV2`). Those pass no options object at all, so they run on the defaults (us-central1, 256MiB, 60s).

---

## 1. Summary

### 1.1 Counts: domain × recommendation

| Domain | PORT | PORT-LATER | DELETE | Total |
|---|---:|---:|---:|---:|
| Auth & users | 4 | 3 | 7 | 14 |
| Tenancy / platform | 1 | 1 | 0 | 2 |
| Catalogue / projection | 1 | 0 | 0 | 1 |
| POD studio / artwork / print | 5 | 7 | 0 | 12 |
| Checkout / payment / Stripe Connect | 9 | 0 | 0 | 9 |
| Orders / refunds / withdrawals | 2 | 0 | 1 | 3 |
| Email orchestrator (order mails) | 1 | 0 | 2 | 3 |
| Screening / takedown | 5 | 0 | 0 | 5 |
| Add-on: reviews | 0 | 6 | 0 | 6 |
| Add-on: abandoned checkout | 1 | 2 | 0 | 3 |
| Add-on: discount codes | 0 | 1 | 0 | 1 |
| Add-on: affiliate | 0 | 0 | 5 | 5 |
| Add-on: content studio / social video | 0 | 3 | 0 | 3 |
| Add-on: B2B wholesale | 0 | 2 | 0 | 2 |
| Add-on: marketing materials | 0 | 0 | 0 | 0 (no function exists) |
| Migrators (Shopify / Woo) | 0 | 2 | 0 | 2 |
| DAC7 / reporting | 0 | 8 | 1 | 9 |
| Impersonation / handoff | 0 | 0 | 0 | 0 (no function on `main`, see §2.17) |
| Misc | 0 | 0 | 2 | 2 |
| **Total** | **29** | **35** | **18** | **82** |

**By trigger type.** The index exports 63 `onCall` functions: 62 definitions plus the `confirmPasswordReset` double export. It also exports:
- 7 `onRequest` functions
- 9 Firestore triggers: 7 `onDocumentWritten` and 2 `onDocumentUpdated`
- 3 `onSchedule` functions

**No V1/V2 twins exist besides `confirmPasswordReset`.** Each of the other eight `…V2` names is the *only* export of its implementation. Seven are `as …V2` renames in `index.ts`; `logAffiliateClickV2` is defined under that name:
- `logAffiliateClickV2`
- `processB2COrderCompletionHttpV2`
- `getGeoDataV2`
- `deleteCustomerAccountV2`
- `deleteB2CCustomerAccountV2`
- `toggleCustomerActiveStatusV2`
- `createAdminUserV2`
- `scrapeWebsiteMetaV2`

(`createPaymentIntentV2` and `stripeWebhookV2` are V2 by name only; they have no alias.) The V1/V3 email functions were removed. `index.ts:40-59` keeps a commented-out list of them. `index.ts:303` points to `functions/quarantine/old-email-systems/`, which does not exist.

### 1.2 Exports with no client caller

**Callable/HTTP exports with no caller anywhere in `src/` or `public/` (9).** Each one is a strong signal to delete:

| Export | Evidence |
|---|---|
| `sendOrderConfirmationEmail` | Order confirmations are sent server-side: `order-processing/functions.ts:569-580` (B2C, via the webhook) and `order-processing/createB2BOrder.ts:227-248` (B2B). |
| `sendOrderNotificationAdmin` | Same as above: `order-processing/functions.ts:598-610` and `createB2BOrder.ts:245-248`. |
| `sendAffiliateWelcomeEmail` | `approveAffiliate` sends `AFFILIATE_WELCOME` inline (`approveAffiliate.ts:171-194`). |
| `processB2COrderCompletionHttpV2` | The webhook calls the engine `processOrderCompletion` directly (`payment/stripeWebhook.ts:686-687`), not over HTTP. |
| `getGeoDataV2` | No reference anywhere in `src/`. |
| `createAdminUserV2` | Maintenance-secret bootstrap; no reference. |
| `syncAdminClaims` | Maintenance-secret endpoint. Superseded by `syncUserClaimsOnWrite`, and `scripts/sync-admin-claims-local.cjs` does the same job locally. |
| `aggregateDac7Year` | `exportDac7Report` runs the same `aggregateSellerYear` internally (`dac7/functions.ts:360`). |
| `confirmPasswordReset` (V1 name) | The client calls only the alias `confirmPasswordResetV2` (`pages/shop/ResetPassword.jsx:74`). |

**Event-driven exports with no client caller by design (13).** These are listed only for completeness:
- `stripeWebhookV2` (called by Stripe)
- `syncUserClaimsOnWrite`
- `reverseAffiliateCommissionOnCancel`
- `onOrderProductionReady`
- `sweepPrintNotifyOutbox`
- `syncPrintersPublicOnWrite`
- `sweepAbandonedCheckouts`
- `syncProductsPublicOnWrite`
- `screenProductOnWrite`
- `rescreenProductsOnMappingWrite`
- `rescreenProductsOnArtworkWrite`
- `onOrderReviewQualify`
- `sweepReviewRequests`

The other **60** exports each have at least one real client caller, cited per row in §2.

### 1.3 Needs sharp / ffmpeg (these can't run in a Worker and need a render service)

| Export | Binary | Config | Rec |
|---|---|---|---|
| `processPodArtwork` | **sharp** 0.35: decode, EXIF-rotate, trim, ICC→sRGB, 300-DPI contain gate, print PNG + 800px WebP preview | 2GiB · 300s | **PORT** → render service |
| `renderSocialVideo` | **ffmpeg-static + ffprobe-static** via `child_process.spawn`, `/tmp` workdir | 4GiB · cpu 2 · 540s · maxInstances 3 | PORT-LATER → render service |
| `generateSocialCopy` | **ffmpeg-static + ffprobe-static** for keyframe extraction (`generateSocialCopy.ts:15-21,146`), then an Anthropic call | 1GiB · 300s | PORT-LATER → keyframes on the render service; the Claude call can live in a Worker |
| *(future)* SnapWear A5 canvas PNG | will need sharp or an equivalent (`docs/SnapWearDocs/LAUNCH_TODO.md:20`) | — | not built yet |

Prior art: the `cloudflare-migration` branch already defines the Worker↔render-farm seam, in `docs/RENDER_FARM_CONTRACT.md` and `cloudflare/src/pod/render-farm-client.ts`. That client presigns R2 URLs for a Firebase-hosted farm.

**Node-only APIs besides sharp and ffmpeg**, all fixable in a Worker:
- **`node:dns` `lookup`** for the SSRF guards (`website-scraper/functions.ts:49`, `email-orchestrator/functions/migrationShared.ts:137`). Workers have no resolver API; use DNS-over-HTTPS or rely on Worker egress (Workers can't reach private networks or the GCP metadata service).
- **Node `crypto`** (`randomBytes`, `createHash`, `randomUUID`) → Web Crypto.
- **Stripe `webhooks.constructEvent`** (`stripeWebhook.ts:252`) → `constructEventAsync` with the SubtleCrypto provider on Workers.
- **Storage** (`getSignedUrl`, `bucket().file().save`) → R2 binding plus aws4fetch SigV4 presign.

### 1.4 Firestore collections touched by PORT functions (seed for the D1 schema)

This is the function-side view only. Collections that the client writes directly under `firestore.rules` need their own inventory, for example `collections`, CMS pages, `podMappings` writes and legal acceptance docs.

**Core: becomes D1 tables**

| Collection | Touched by (PORT) | Notes |
|---|---|---|
| `shops` | **R:** nearly all (`[E]`, `[F]`, identity, legal gate, pickup config)<br>**W:** `createConnectAccount`, `refreshConnectStatus`, `setShopCommission`, `setConnectPayoutDelay`, `stripeWebhookV2` (`account.updated` → `payments.*`) | Wide doc: `storeIdentity`, `features`, `payments`, `productReviews`, legal readiness, pickup locations |
| `users` | **R:** every `[A]` guard, `[E]` admin and printer routing<br>**W:** `createShopUser`, `createPlatformSuperAdmin`, `deletePlatformUser` | Roles `admin` / `platform` / `print_shop` share one collection. Historically it also held about 372 reseller/demo contact docs (memory `b2b_removal.md`); memory `tenant_isolation_hardening.md` records them as purged. Migrate only rows with a current role (`admin`, `print_shop`) and verify before cutover. |
| `products` | **R:** `createPaymentIntentV2`, `submitInfringementReport`, screening, snapshot builder<br>**W:** `screenProductOnWrite` + rescreen×2 (`screening`, `isActive`), `takedownProduct` (`isActive`, `takedown`) | |
| `podArtwork` | **RW:** `processPodArtwork`<br>**R:** snapshot builder (`createPaymentIntentV2`, `onOrderProductionReady`), screening | Storage paths `pod-artwork/{shopId}/originals\|print\|previews/` → R2 |
| `podMappings` | **R:** snapshot builder, screening, rescreen | |
| `printers` | **R:** `quotePodCost`, snapshot builder / routing, `syncPrintersPublicOnWrite` | Platform-only tiers. `printerCatalog/snapwear` is written only by `scripts/seed-snapwear-printer.cjs`, never by a function. |
| `settings` (docs) | `platform` (`createPaymentIntentV2`, `stripeWebhookV2`, `refundOrder`) · `printRouting` (`createPaymentIntentV2`, `onOrderProductionReady`, `quotePodCost`) · `podProfiles` (`processPodArtwork`) · `contentScreening` (`screenProductOnWrite`) | Four singleton config docs |
| `orders` | **W:** `stripeWebhookV2` (create, id = PaymentIntent id)<br>**RW:** `refundOrder`, `submitWithdrawal`, `onOrderProductionReady` (B2B snapshot freeze)<br>**R:** `sendOrderStatusUpdateEmail`, `sweepAbandonedCheckouts` | |
| `orderProduction` | **W:** `stripeWebhookV2`, `onOrderProductionReady` | Server-only full snapshot plus Connect money (A13) |
| `checkouts` | **W:** `createPaymentIntentV2` (`checkout-recovery/writeCheckoutDoc.ts:63,134`)<br>**RW:** `stripeWebhookV2`, `sweepAbandonedCheckouts` | Holds the immutable pre-payment production snapshot (P1-16) plus recovery fields |
| `infringementReports` | **W:** `submitInfringementReport`, `takedownProduct` | |
| `auditLogs` | **W:** `takedownProduct` | Append-only |

**Mechanism collections: don't port as tables**

| Collection | Why not |
|---|---|
| `productsPublic` | The mirror written by `syncProductsPublicOnWrite`, read by `screenProductOnWrite` (`screenProductOnWrite.ts:79`). In D1 it becomes a column-allowlisted SELECT or view over `products`. |
| `printersPublic` | The mirror written by `syncPrintersPublicOnWrite`. It becomes an allowlisted SELECT or view. |
| `printNotifications` | Outbox for `onOrderProductionReady` / `sweepPrintNotifyOutbox`. Becomes a Cloudflare Queue plus a small dispatch-state table (useful for SnapWear A6 `job_id` bookkeeping). |
| `rateLimits` | `[RL]` for `sendPasswordResetEmail`, `createPaymentIntentV2` and `submitInfringementReport`. Becomes the Workers Rate Limiting binding or a D1 counter table. |
| `passwordResets` | For `sendPasswordResetEmail` / `confirmPasswordResetV2`. Replaced by better-auth's own `verification` table (prior art: `cloudflare-migration:cloudflare/src/auth/create-auth.ts`). |

**Touched by PORT code, but only on branches recommended for later or for deletion**

| Collection | Where it's touched | Fate |
|---|---|---|
| `b2cCustomers` | Stats write in `processOrderCompletion` (`order-processing/functions.ts:542`, inside the webhook), plus lookups in `resolveShopIdByEmail` and `UserResolver` | PORT-LATER with B2C customer accounts |
| `discountCodes` | Read in `createPaymentIntentV2` (`createPaymentIntent.ts:274`); `usedCount` write in the webhook (`stripeWebhook.ts:666`) | PORT-LATER with the discount add-on |
| `affiliates`, `affiliateClicks`, `campaigns`, `campaignParticipants`, `campaignRevenueTracking` | The affiliate/campaign branch of `processOrderCompletion`, plus the affiliate-discount read in `createPaymentIntentV2` | DELETE with affiliate |
| `checkoutSuppressions` | The reminder half of `sweepAbandonedCheckouts` | PORT-LATER |

### 1.5 The 29 PORT exports at a glance

| Area | Exports |
|---|---|
| Auth | `sendPasswordResetEmail`, `confirmPasswordResetV2`, `createPlatformSuperAdmin`, `deletePlatformUser` |
| Tenancy | `createShopUser` |
| Catalogue | `syncProductsPublicOnWrite` (as a projection) |
| POD | `processPodArtwork` (render service), `quotePodCost`, `syncPrintersPublicOnWrite` (as a projection), `onOrderProductionReady`, `sweepPrintNotifyOutbox` |
| Money | `createPaymentIntentV2`, `stripeWebhookV2`, `createConnectAccount`, `createConnectAccountLink`, `refreshConnectStatus`, `createConnectLoginLink`, `setShopCommission`, `getConnectBalance`, `setConnectPayoutDelay` |
| Orders | `refundOrder`, `submitWithdrawal`, `sendOrderStatusUpdateEmail` (folded into the status endpoint) |
| Trust & safety | `submitInfringementReport`, `takedownProduct`, `screenProductOnWrite`, `rescreenProductsOnMappingWrite`, `rescreenProductsOnArtworkWrite` |
| Retention | `sweepAbandonedCheckouts` (retention half only) |

### 1.6 Calls that need Mikael's yes

These opinionated calls change the counts above:

1. **Affiliate program → DELETE** (5 exports, plus the affiliate branches inside the checkout and order completion).
   - It comes from the B8shield ambassador program:
     - The campaign revenue-share path is dead code. `processUniversalCampaignRevenue` hard-codes `specialEditionItems = []` (`order-processing/functions.ts:196`) and still names KAJJAN/EMMA (`:308-318`).
     - The default commission of 15 comes from that era.
   - There's no payout rail. `stats.balance` is a ledger that the shop settles by hand (`pages/admin/AdminAffiliatePayout.jsx`).
   - Campaign discount codes (`discountCodes`) already cover the "creator code" use case.
2. **Dining Wagon → DELETE** (`scrapeWebsiteMetaV2`). It's a CRM for B2B resellers built on `users` contacts. The wagon is still `enabled: true` (`wagons/dining-wagon/DiningWagonManifest.js:8`); per memory `b2b_removal.md`, Mikael deliberately kept it enabled on 2026-06-15.
3. **Print portal → PORT-LATER** (7 exports). Kim was removed on 2026-09-25 and SnapWear is now the only printer (`docs/SnapWearDocs/LAUNCH_TODO.md:77`). SnapWear gets orders by API (A6, `LAUNCH_TODO.md:21`), and v1 marks orders shipped with a manual click in AdminOrderDetail (`LAUNCH_TODO.md:23`). Nobody logs into the portal at launch. Port it only if a login-based printer (such as Adapt Media) is signed.
4. **B2C customer accounts → PORT-LATER** (`sendCustomEmailVerification`, `verifyEmailCode`, `deleteB2CCustomerAccountV2`). Account creation at checkout is optional (`pages/shop/Checkout.jsx:417-419`), and guests can already exercise withdrawal (`withdrawal/functions.ts:18-22`).
5. **Content Studio, B2B wholesale and the migrators → PORT-LATER.** None is needed for the first POD shop. Content Studio is the only add-on that needs ffmpeg.
6. **Admin-user edit page actions → DELETE** (`deleteCustomerAccountV2`, `toggleCustomerActiveStatusV2`). They are live from `/admin/users/:userId/edit` (`App.jsx:465`, `pages/admin/AdminUserEdit.jsx:420,481`), but they're the reseller-era implementation: the delete **cascade-deletes all orders where `userId == target`** (`customer-admin/functions.ts:159-162`). Replace them with a proper "deactivate/remove shop user" action in the new users API. Session revocation must stay; the order cascade must go.

---

## 2. Per-domain detail

Column key: **Trigger · config** = type · memory · timeout · secrets. **Firestore** = R read / W write / RW both, plus the implicit tags from the legend.

### 2.1 Auth & users (14)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `sendPasswordResetEmail` | `email-orchestrator/functions/sendPasswordResetEmail.ts:22` | onCall · 256MiB · 60s · RESEND | Anonymous. Rate-limits 10/h per IP and 3/h per email, mints a 256-bit reset code server-side, stores it with a 1h expiry stamped with the email's shop, and mails the link under the shop's identity. | W `passwordResets`; R `users`, `b2cCustomers`, `affiliates` (resolveShopIdByEmail); [RL] [E] | Resend | `contexts/SimpleAuthContext.jsx:125` (storefront ForgotPasswordPage), `contexts/AuthContext.jsx:244` (admin) | **PORT** |
| `confirmPasswordResetV2` | alias `index.ts:296` → `email-orchestrator/functions/confirmPasswordReset.ts:15` | onCall · 256MiB · 60s | Redeems an unused, unexpired code, asserts the reset doc's shopId matches the email's current shop, sets the password through Admin Auth (minimum 6 characters), and marks the code used. | RW `passwordResets`; R `users`, `b2cCustomers`, `affiliates` | Firebase Auth Admin | `pages/shop/ResetPassword.jsx:74` | **PORT** |
| `confirmPasswordReset` | `index.ts:299` (same function) | same | Duplicate export of the function above. | — | — | none | **DELETE** |
| `sendCustomEmailVerification` | `email-orchestrator/functions/sendCustomEmailVerification.ts:38` | onCall · 256MiB · 60s · RESEND | The caller must be the account itself. Sends to the Auth email only (a mismatched payload email is rejected), rate-limits 5/h, and stores only the SHA-256 hash of the code as the doc id (P0-02). | W `emailVerifications`; R `users`, `b2cCustomers`, `affiliates`; [RL] [E] | Firebase Auth Admin, Resend | `pages/admin/AdminB2CCustomerEdit.jsx:322`, `pages/shop/Checkout.jsx:440`, `pages/shop/CustomerRegister.jsx:117`, `pages/shop/CustomerAccount.jsx:222` | PORT-LATER |
| `verifyEmailCode` | `email-orchestrator/functions/verifyEmailCode.ts:25` | onCall · 256MiB · 60s | Hashes the code, consumes it in a single-use transaction, sets Auth `emailVerified` (and reverts the consume if that fails), then mirrors the flag to `b2cCustomers`. | RW `emailVerifications`; W `b2cCustomers` | Firebase Auth Admin | `pages/shop/EmailVerificationHandler.jsx:40`, `pages/shop/VerifyEmailPage.jsx:32` | PORT-LATER |
| `createPlatformSuperAdmin` | `email-orchestrator/functions/platformUsers.ts:45` | onCall · 256MiB · 120s · RESEND | Platform-only. Creates or reuses an Auth account, but reuse is allowed only for an account that is already a super-admin. Writes `users/{uid}` with `platform:true`, `shopId:null`, sets claims, and mails a temporary password. | RW `users`; [A] [E] | Firebase Auth Admin, Resend | `pages/platform/PlatformUsers.jsx:214` | **PORT** |
| `deletePlatformUser` | `email-orchestrator/functions/platformUsers.ts:158` | onCall · 256MiB · 120s | Platform-only. Deletes an admin's doc and Auth account. It refuses to delete the caller, and refuses to delete the last usable platform admin (the survivor is re-read inside a transaction). | RW `users`; [A] | Firebase Auth Admin | `pages/platform/PlatformUsers.jsx:64` | **PORT** |
| `syncUserClaimsOnWrite` | `auth/syncUserClaimsOnWrite.ts:52` | onDocumentWritten `users/{userId}` · 256MiB | Mirrors `{role, shopId, platform}` into Auth custom claims for anyone who is or was an admin, and revokes refresh tokens on any privilege reduction. | R `users` (event) | Firebase Auth Admin | — (trigger) | **DELETE** |
| `syncAdminClaims` | `customer-admin/functions.ts:559` | onRequest · 256MiB · 120s · `ADMIN_MAINTENANCE_SECRET` env | Maintenance endpoint that bulk-syncs claims for every `role=='admin'` user. | R `users` | Firebase Auth Admin | none | **DELETE** |
| `createAdminUserV2` | `customer-admin/functions.ts:481` | onRequest · 256MiB · 60s · maintenance secret | B8shield bootstrap. Upserts a `users` doc from `adminSeedConfig` (`contactPerson: 'Micke Ohlén'`) with `.add()`, so the doc id is **not** an Auth uid. | RW `users` | — | none | **DELETE** |
| `sendLoginCredentialsEmail` | `email-orchestrator/functions/sendLoginCredentialsEmail.ts:28` | onCall · 256MiB · 60s · RESEND | Mails a caller-supplied temporary password to an affiliate or B2B user after a shop-parity check against the target record. | R `affiliates` or `users`; [A] [E] | Resend | `pages/admin/AdminAffiliateEdit.jsx:505`; `contexts/AuthContext.jsx:678` (`sendCustomerWelcomeEmail` for reseller `users`, from `AdminUserEdit.jsx:390`) | **DELETE** |
| `deleteCustomerAccountV2` | `customer-admin/functions.ts:76` | onCall · defaults | Admin deletes a `users` doc. It **deletes all `orders` where `userId == id`**, the `users/{id}/marketingMaterials` subdocs, `adminCustomerDocuments`, and the Auth account. | RW `users`; W `orders`, `marketingMaterials` (subcollection), `adminCustomerDocuments` | Firebase Auth Admin | `contexts/AuthContext.jsx:745` (from `pages/admin/AdminUserEdit.jsx:420`) | **DELETE** |
| `toggleCustomerActiveStatusV2` | `customer-admin/functions.ts:375` | onCall · defaults | Admin toggles a `users` doc's `active`/`isActive` flags and Auth `disabled`, with a shop-parity check. | RW `users` | Firebase Auth Admin | `contexts/AuthContext.jsx:791` (from `pages/admin/AdminUserEdit.jsx:481`) | **DELETE** |
| `deleteB2CCustomerAccountV2` | `customer-admin/functions.ts:212` | onCall · defaults | Admin deletes a B2C customer: deletes the Auth account, marks their orders `customerDeleted` (shop-scoped, by id and by email), writes an audit log, and deletes the doc. | RW `b2cCustomers`, `orders`; W `auditLogs`; R `users` | Firebase Auth Admin | `pages/admin/AdminB2CCustomerEdit.jsx:280` | PORT-LATER |

**Why, and the CF shape**
- **Password reset → PORT.** Admins need it on day one. In CF it becomes better-auth's own reset flow (`requestPasswordReset` / `resetPassword`) with a shop-branded `sendResetPassword` hook sent through Resend. The per-shop sender identity must survive. Prior art: `cloudflare-migration:cloudflare/src/auth/*`, `src/email/auth-email-job.ts`.
- **Super-admin create/delete → PORT.** Both become better-auth admin user operations plus a D1 `users` row. Send an **invite or reset link, not a plaintext temporary password**. Today `Math.random()` temporary passwords are mailed by `createShopUser`, `createPlatformSuperAdmin` and `approveAffiliate`, and `createPrintShopUser` returns one in its response. Keep both lockout guards on delete.
- **`syncUserClaimsOnWrite` → DELETE.** It's a Firebase-Auth mechanism. On D1, authorization reads the live user row per request (prior art: `cloudflare-migration:cloudflare/src/auth/live-authorization.ts`). **Carry the invariant:** a demotion or shop move must revoke sessions inside the user-update endpoint.
- **`syncAdminClaims` / `createAdminUserV2` → DELETE.** Pre-tenancy maintenance tools with no callers.
- **`sendLoginCredentialsEmail` → DELETE.** The "mail a temporary password" pattern is replaced by invite and reset links. Its B2B caller is reseller-era.
- **`deleteCustomerAccountV2` / `toggleCustomerActiveStatusV2` → DELETE.** See §1.6 item 6.
- **Email verification and B2C delete → PORT-LATER.** They belong with B2C customer accounts (§1.6 item 4). In CF they become better-auth's `sendVerificationEmail`. The B2C delete is also the GDPR erasure tool, so it has to exist before B2C accounts go live.

### 2.2 Tenancy / platform (2)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `createShopUser` | `email-orchestrator/functions/createShopUser.ts:30` | onCall · 256MiB · 120s · RESEND | Platform-only. Provisions a shop admin: Auth account (reuse allowed only for the same shop's admin), `users/{uid}` with `role:'admin'`, `shopId`, `platform:false`, claims, and a credentials mail. | R `shops`; W `users`; [A] [E] | Firebase Auth Admin, Resend | `components/platform/AddShopUserModal.jsx:26` | **PORT** |
| `submitLead` | `leads/submitLead.ts:35` | onCall · 256MiB · 60s · RESEND | Public landing-page form. Honeypot, 5/h per IP, writes a platform-level `leads` doc, then a best-effort admin mail. | W `leads`; [RL] [E] | Resend | `pages/LandingPage.jsx:206` | PORT-LATER |

- **`createShopUser` → PORT.** It's the only way a shop gets an admin; prior art is `cloudflare-migration:cloudflare/src/platform/provision-users.ts`. Use an invite link, as in §2.1.
- **`submitLead` → PORT-LATER.** It's platform marketing, not the shop.
- **Shop creation isn't a function.** Shops are written client-side by the platform console under rules, so it lands in the client inventory.

### 2.3 Catalogue / projection (1)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `syncProductsPublicOnWrite` | `catalog/syncProductsPublic.ts:32` | onDocumentWritten `products/{productId}` · 256MiB | Re-reads the product in a transaction and writes `projectPublicProduct(...)` (a field allowlist; only live products) to `productsPublic/{id}`, or deletes it. | R `products`; W `productsPublic` | — | — (trigger; the storefront reads `productsPublic`) | **PORT** |

- **CF shape: PORT the logic, not the trigger.** In D1 the public catalogue endpoint SELECTs only the allowlisted columns (`catalog/projectProduct.ts`) `WHERE isActive AND availability.b2c`. No mirror table and no trigger. Prior art: `cloudflare-migration:cloudflare/src/catalog/public-catalog.ts`.
- **Invariant to keep:** raw `products` fields (`b2bPrice`, `podCostSek`, drafts) never reach the storefront. The allowlist logic is P1-11.

### 2.4 POD studio / artwork / print (12)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `processPodArtwork` | `pod/processArtwork.ts:345` | onCall · **2GiB · 300s** | The server-authoritative artwork gate (`docs/POD_PRINT_SPEC.md`). **NEW**: processes an upload under `pod-artwork/{shop}/originals/` and deletes it on reject. **REPROCESS**: revalidates an existing doc. Writes the print PNG + preview WebP. | R `settings/podProfiles`; RW `podArtwork` (reprocess); [A] [F pod] | **sharp**, Cloud Storage | `wagons/pod-wagon/components/ArtworkLibrary.jsx:48`, `wagons/pod-wagon/components/ArtworkUploadModal.jsx:154` | **PORT** (render svc) |
| `quotePodCost` | `pod/quotePodCost.ts:37` | onCall · 256MiB | A13 "one number": routed tier cost plus the platform cut, excluding VAT, for a garment and slots. Never returns tiers. | R `settings/printRouting`, `printers`; [A] | — | `config/podCostQuote.js:38` (from `wagons/pod-wagon/studio/DesignStudio.jsx:538,547`) | **PORT** |
| `syncPrintersPublicOnWrite` | `print/syncPrintersPublic.ts:21` | onDocumentWritten `printers/{uid}` · 256MiB | Mirrors a price-free `projectPrinterPublic(...)` into `printersPublic/{uid}`, or deletes it. | R `printers`; W `printersPublic` | — | — (trigger; the studio reads `printersPublic`) | **PORT** (as projection) |
| `onOrderProductionReady` | `print/notifyOutbox.ts:232` | onDocumentWritten `orders/{orderId}` · 256MiB · RESEND | For a POD order entering the paid lifecycle: (1) **freezes the production snapshot** for orders that lack one (B2B), splitting it into `orders.productionSnapshot` without money and `orderProduction` with money, in one transaction; (2) enqueues one `printNotifications/{orderId}` and tries delivery inline (printer email). | RW `orders`, `printNotifications`; W `orderProduction`; R `podMappings`, `podArtwork`, `printers`, `settings/printRouting`, `products`; [F pod] [E] | Resend | — (trigger) | **PORT** |
| `sweepPrintNotifyOutbox` | `print/notifyOutbox.ts:369` | onSchedule **every 10 min** · 256MiB · 120s · RESEND | Redelivers pending outbox docs with capped backoff, marks them `failed` after MAX_ATTEMPTS, and purges terminal docs after 60 days. | RW `printNotifications`; [F pod] [E] | Resend | — (schedule) | **PORT** |
| `getPrintQueue` | `print/functions.ts:55` | onCall · 256MiB · 120s | Printer's queue across assigned, POD-enabled shops. Per-line routing filter; hides unpaid and finished orders. | R `orders`, `shops`, `podMappings` (via loadShopMappings); [A print] | — | `pages/print/PrintShopQueue.jsx:49` | PORT-LATER |
| `getPrintJob` | `print/functions.ts:87` | onCall · 256MiB · 120s | One order's production view: ship-to, the caller's lines, signed artwork URLs. | R `orders`, `shops`, `podMappings`, `podArtwork`; [A print] | Cloud Storage signed URLs | `pages/print/PrintShopOrderDetail.jsx:63` | PORT-LATER |
| `getPrintQueueExport` | `print/functions.ts:125` | onCall · 256MiB · 120s | Production rows for a CSV (the client builds the CSV). | same as `getPrintJob` | Cloud Storage | `pages/print/PrintShopQueue.jsx:64` | PORT-LATER |
| `getPrintArtworkLibrary` | `print/functions.ts:259` | onCall · 256MiB · 120s | Printer's artwork library for its assigned shops, minus artworks that appear only on other printers' lines. | R `orders`, `podArtwork`, `shops`; [A print] | — | `pages/print/PrintShopArtwork.jsx:35` | PORT-LATER |
| `getPrintArtworkDownload` | `print/functions.ts:303` | onCall · 256MiB · 120s | Mints one short-lived signed URL (print PNG or original) after shop, routing and path-prefix guards. | R `podArtwork`, `orders`; [A print] | Cloud Storage signed URLs | `pages/print/PrintShopArtwork.jsx:66` | PORT-LATER |
| `createPrintShopUser` | `print/functions.ts:186` | onCall · 256MiB · 120s | Platform-only. Creates a `print_shop` user with assigned shops, sets no claims, and **returns `tempPassword` in the response**. | R `shops`; RW `users`; [A] | Firebase Auth Admin | `pages/platform/PlatformPrinters.jsx:127` | PORT-LATER |
| `setPrintJobStatus` | `print/setPrintJobStatus.ts:111` | onCall · 256MiB · 120s · RESEND | Printer marks an order `printed` or `shipped` (allow-listed from-statuses; refuses unresolved lines; refuses pickup→shipped). `shipped` mails the customer. | RW `orders`; R `users`, `podMappings`; [A print] [E] | Resend | `pages/print/PrintShopOrderDetail.jsx:78` | PORT-LATER |

**Why, and the CF shape**
- **`processPodArtwork` → PORT (render service).** It's the only path to a print-ready artwork, and the blocking 300-DPI gate is a launch requirement. Shape: a Worker route checks auth, the POD flag and the path prefix, presigns an R2 GET for the original and PUTs for the PNG and WebP, dispatches the render job, and writes the `podArtwork` row. Prior art: `cloudflare-migration:cloudflare/src/pod/artwork-routes.ts` + `render-farm-client.ts` (branch tip `2b13d05`, 2026-08-27; predates the A1–A14 SnapWear work on `main`).
- **`quotePodCost` → PORT.** Studio publish is refused without it (`LAUNCH_TODO.md:45`, B9c). Pure compute over `printers` plus `printRouting`, through `print/printProjection.ts` `loadPrintRoutingInputs` and `print/printRouting.ts` `quoteRoutedCost`.
- **`syncPrintersPublicOnWrite` → PORT (logic only).** It becomes an allowlisted SELECT (`print/projectPrinterPublic.ts`). **Invariant:** seller-readable printer data carries no prices (A13).
- **`onOrderProductionReady` + `sweepPrintNotifyOutbox` → PORT.** They're the durable "an order is ready for production" dispatch (P1-15), and SnapWear A6 plans to hang its `POST /api/order/add` off this outbox (`LAUNCH_TODO.md:21`). In CF:
  - The webhook's order insert (B2C) and the B2B `paid` transition enqueue a Queue message in the same request. With no Firestore trigger, the snapshot freeze moves into that same request.
  - Queue retries and a DLQ replace the lease/backoff code.
  - A daily Cron purges terminal rows.
  - The printer email is the payload today; A6 replaces it with the SnapWear API call.
  - The B2B freeze branch is only live if B2B is ported.
- **Portal callables → PORT-LATER** (§1.6 item 3). The shared projection library `print/printProjection.ts` (1,051 lines) is **PORT**, because checkout snapshots, withholding and A6 all use it. Only the portal entry points wait.

### 2.5 Checkout / payment / Stripe Connect (9)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `createPaymentIntentV2` | `payment/createPaymentIntent.ts:416` | onRequest · 256MiB · 60s · STRIPE_SECRET_KEY | Server-priced B2C checkout, in order:<br>- 40 per 5 min per-IP limit<br>- shop exists, published and not killed; legal-readiness gate<br>- pickup validated against shop config; right-of-withdrawal proof gate<br>- freezes the POD production snapshot → `checkouts/{piId}` (P1-16)<br>- SnapWear A1 production withholding plus blocks 0–3<br>- Connect destination charge with `application_fee_amount`; `statement_descriptor_suffix`<br>- metadata chunking (500-char cap per value, 50 keys max); creates the PI and cancels it on a post-create failure | R `shops`, `products`, `affiliates`, `discountCodes`, `settings/platform`, `settings/printRouting`, `printers`, `podMappings`, `podArtwork`; W `checkouts`; [RL] [F pod, affiliate, discountCodes] | Stripe (`paymentIntents.create/cancel`) | `components/shop/StripePaymentForm.jsx:402` (`fetch(functionUrl(...))`) | **PORT** |
| `stripeWebhookV2` | `payment/stripeWebhook.ts:197` | onRequest · 256MiB · 60s · STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND · invoker public | Signature-verified. Handles five event types (listed below this table). | W `orders`, `orderProduction`, `discountCodes`; RW `checkouts`, `shops`; R `settings/platform`; via processOrderCompletion: `b2cCustomers`, `affiliates`, `affiliateClicks`, `campaigns`, `campaignParticipants`; [E] | Stripe (`webhooks.constructEvent`, `paymentIntents.retrieve`, `transfers.createReversal`, `transfers.create`), Resend | — (Stripe) | **PORT** |
| `createConnectAccount` | `payment/connectOnboarding.ts:116` | onCall · 256MiB · 60s · STRIPE | Shop admin (after the platform opts the shop in) creates an Express account (SE/SEK, monthly payouts on the 1st), stores `payments.stripeAccountId`, and returns the onboarding link. | RW `shops`; [A] | Stripe (`accounts.create`, `accountLinks.create`) | `pages/admin/AdminPayments.jsx:256` via `call()` at `:126` | **PORT** |
| `createConnectAccountLink` | `payment/connectOnboarding.ts:176` | onCall · 256MiB · 60s · STRIPE | Fresh hosted-onboarding link. | R `shops`; [A] | Stripe (`accountLinks.create`) | `pages/admin/AdminPayments.jsx:278,300` | **PORT** |
| `refreshConnectStatus` | `payment/connectOnboarding.ts:195` | onCall · 256MiB · 60s · STRIPE | Pulls the account and mirrors its status into `shops.payments`. | RW `shops`; [A] | Stripe (`accounts.retrieve`) | `pages/admin/AdminPayments.jsx:147` | **PORT** |
| `createConnectLoginLink` | `payment/connectOnboarding.ts:218` | onCall · 256MiB · 60s · STRIPE | Express dashboard login link. | R `shops`; [A] | Stripe (`accounts.createLoginLink`) | `pages/admin/AdminPayments.jsx:315` | **PORT** |
| `setShopCommission` | `payment/connectOnboarding.ts:235` | onCall · 256MiB · 30s | Platform-only. Sets `payments.commissionBps` (0..10000). | RW `shops`; [A] | — | `pages/platform/shopCells.jsx:106` | **PORT** |
| `getConnectBalance` | `payment/connectOnboarding.ts:257` | onCall · 256MiB · 60s · STRIPE | Connected-account balance (available, pending, reserved) plus the negative-balance risk flag and the stored payout delay. | R `shops`; [A] | Stripe (`balance.retrieve`) | `pages/admin/AdminPayments.jsx:355` | **PORT** |
| `setConnectPayoutDelay` | `payment/connectOnboarding.ts:292` | onCall · 256MiB · 60s · STRIPE | Platform-only. Per-account payout `delay_days` (0..365 or `'minimum'`), mirrored into `shops.payments`. | RW `shops`; [A] | Stripe (`accounts.update`) | `pages/admin/AdminPayments.jsx:414` | **PORT** |

**Events handled by `stripeWebhookV2`**

| Event | What the handler does |
|---|---|
| `payment_intent.succeeded` | Creates the order. The order id is the PI id and the create is idempotent. It's batched with `orderProduction`, marks the checkout `completed`, bumps the campaign code's `usedCount`, then calls `processOrderCompletion`. |
| `payment_intent.payment_failed` | Marks the checkout `failed`. |
| `account.updated` | Mirrors the Connect status into `shops.payments` (the shop is found through `metadata.shopId`). Sends the status-change mail only on meaningful transitions: payouts turned off, the account became restricted, or new requirements appeared. |
| `charge.dispute.created` | Stamps the dispute on the order. If `settings/platform.reverseDisputeOnCreated` is on (the default), it also reverses the transfer (idempotency key per dispute). Then it alerts the platform. |
| `charge.dispute.closed` | If the dispute was won, re-transfers the reversed amount (idempotency key). If it was lost, it finalizes, and recovers the funds now if nothing was reversed at creation. |

**Why, and the CF shape.** This is the money loop; all nine are PORT.
- **`createPaymentIntentV2` and `stripeWebhookV2`** become Worker routes. The pure, unit-tested modules move with them unchanged:
  - `payment/connectParams.ts`
  - `payment/productionWithholding.ts`
  - `payment/orderMoney.ts`
  - `payment/connectFee.ts`
  - `print/printRouting.ts`
- **The webhook needs `constructEventAsync`** on the raw body (§1.3).
- **The order insert and the `orderProduction` insert must be one D1 batch.** The order's primary key is the idempotency guard.
- **Emails and production dispatch** should be enqueued after commit, not awaited inline.
- **Every client of the Stripe SDK pins `apiVersion: '2023-10-16'`.** Keep the pin (see memory `payments_stripe_connect.md`).
- **The balance and payout-delay pair stays PORT** because it's the only per-seller risk control. `takedownProduct` explicitly has no payout hold (`infringement/takedownProduct.ts:24-27`).
- **Prior art on `cloudflare-migration`:** `cloudflare/src/commerce/{checkout,payment,webhook,stripe-client,shipping}.ts`. It was live-verified against the Stripe sandbox on 2026-08-22 (memory `cloudflare_migration_run.md`), but it predates SnapWear A1 withholding and A13.

### 2.6 Orders / refunds / withdrawals (3)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `refundOrder` | `payment/connectRefund.ts:33` | onCall · 256MiB · 60s · STRIPE, RESEND | Cumulative partial or full refund (P1-08). Connect orders get `reverse_transfer` and `refund_application_fee` per platform policy; an idempotency key is used; status becomes `partially_refunded` or `refunded`; sends the refund mail. | RW `orders`; R `settings/platform`; [A] [E] | Stripe (`refunds.create`), Resend | `pages/admin/AdminOrderDetail.jsx:317` | **PORT** |
| `submitWithdrawal` | `withdrawal/functions.ts:142` | onCall · 256MiB · 60s · RESEND | Right-of-withdrawal function (DAL 2 kap. 10 a §). Works for account holders (uid or verified email) and guests (order number + purchase email). Server-stamped time, eligibility by the order's regime, a durable `orders.withdrawalRequest` acknowledgement, and a receipt mail. | RW `orders`; [E] | Resend | `pages/shop/WithdrawalPage.jsx:53`, `components/shop/OrderWithdrawal.jsx:48` | **PORT** |
| `processB2COrderCompletionHttpV2` | `order-processing/functions.ts:410` | onRequest · 256MiB · 60s · RESEND · **CORS `*`, unauthenticated** | HTTP wrapper around `processOrderCompletion`, rate-limited in memory per IP. | (engine) RW `orders`, `b2cCustomers`, `affiliates`, `affiliateClicks`, `campaigns`, `campaignParticipants`, `campaignRevenueTracking`; [E] | Resend | none | **DELETE** |

**Why, and the CF shape**
- **Refund and withdrawal → PORT.** Refunds are the money loop. Withdrawal is a statutory duty in force since 19 June 2026, per the module header.
- **Withdrawal's guest rate limit is a per-instance `Map`** (`withdrawal/functions.ts:76-80`). Replace it with the Workers Rate Limiting binding.
- **The HTTP endpoint → DELETE.** It has no caller, and it's an unauthenticated, CORS-`*` surface. Its engine `processOrderCompletion` (`:484`) splits three ways:
  - **Keep (PORT, inside the webhook's post-commit work):** the idempotent claim, the customer confirmation mail, the admin order-notification mail, and the `emailFailures` stamps.
  - **PORT-LATER:** the `b2cCustomers.stats` bump, with B2C accounts.
  - **DELETE:** the affiliate commission, the campaign matching, and `processUniversalCampaignRevenue`, which is dead code (§1.6 item 1).

### 2.7 Email orchestrator: order mail callables (3)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `sendOrderStatusUpdateEmail` | `email-orchestrator/functions/sendOrderStatusUpdateEmail.ts:34` | onCall · 256MiB · 60s · RESEND | Admin-of-order's-shop only. Rejects the call unless `newStatus` equals the stored status. Recipient and content come from the persisted order. | R `orders`; [A] [E] | Resend | `contexts/OrderContext.jsx:566` (status change), `:858` (cancellation) | **PORT** |
| `sendOrderConfirmationEmail` | `email-orchestrator/functions/sendOrderConfirmationEmail.ts:42` | onCall · 256MiB · 60s · RESEND | Admin-triggered confirmation mail. The template content comes from the client-supplied `orderData`. | R `orders`; [A] [E] | Resend | none | **DELETE** |
| `sendOrderNotificationAdmin` | `email-orchestrator/functions/sendOrderNotificationAdmin.ts:58` | onCall · 256MiB · 60s · RESEND | Admin-triggered "new order" mail to shop admins. | R `orders`; [A] [E] | Resend | none | **DELETE** |

**Why, and the CF shape**
- **`sendOrderStatusUpdateEmail` → PORT.** Today the client writes the status straight to Firestore and then calls this function (`OrderContext.jsx`). The CF port should fold it into one server-side "change order status" endpoint that writes and mails. That's also where SnapWear v1's manual "shipped + tracking" click lands (`LAUNCH_TODO.md:23`, A8).
- **The other two → DELETE.** Server paths already send these mails (§1.2).
- **The orchestrator library itself** (`email-orchestrator/core/EmailOrchestrator.ts`, 933 lines, plus `templates/*`) must be ported as a library. It's fetch-to-Resend, so it's Worker-compatible, and it has 18 email types.
  - **Needed by the PORT set (11):** ORDER_CONFIRMATION, ORDER_NOTIFICATION_ADMIN, ORDER_STATUS_UPDATE, PASSWORD_RESET, LOGIN_CREDENTIALS (or its invite replacement), INFRINGEMENT_REPORT_ADMIN, WITHDRAWAL_ACKNOWLEDGMENT, REFUND_CONFIRMATION, DISPUTE_ALERT_ADMIN, CONNECT_STATUS_CHANGE, PRINT_ORDER_NOTIFICATION.
  - **Later-only (4):** EMAIL_VERIFICATION, ABANDONED_CHECKOUT_REMINDER, REVIEW_REQUEST, LEAD_NOTIFICATION_ADMIN.
  - **Delete-only (3):** AFFILIATE_WELCOME, AFFILIATE_APPLICATION_RECEIVED, AFFILIATE_APPLICATION_NOTIFICATION_ADMIN.
  - 11 + 4 + 3 = the 18 members of `EmailType` (`EmailOrchestrator.ts:41-59`).

### 2.8 Screening / takedown (5)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `submitInfringementReport` | `infringement/submitInfringementReport.ts:86` | onCall · 256MiB · 60s · RESEND | Public "Rapportera intrång" form (SnapWear A10). Honeypot, 5/h per IP, resolves the product within the shop, writes a platform-level report first (no reporter IP stored), then mails the platform. | W `infringementReports`; R `products`, `shops`; [RL] [E] | Resend | `pages/shop/InfringementReportPage.jsx:101` | **PORT** |
| `takedownProduct` | `infringement/takedownProduct.ts:47` | onCall · 256MiB · 60s | Platform-only "Avpublicera". One transaction: product `isActive=false` plus the `takedown` stamp (plus `screening.status='taken_down'`), the report marked `taken_down`, and an `auditLogs` entry. | RW `products`, `infringementReports`; W `auditLogs`; [A] | — | `pages/platform/PlatformReports.jsx:534` | **PORT** |
| `screenProductOnWrite` | `catalog/screenProductOnWrite.ts:144` | onDocumentWritten `products/{productId}` · 256MiB | Brand screening (A11) for live products. Checks the blocklist against product text plus the artwork names, and puts a new shop's first N live products up for review. Stamps `products.screening`, and a hard block sets `isActive=false`. It's the **sole writer** of `screening`. | RW `products`; R `productsPublic`, `podMappings`, `podArtwork`, `settings/contentScreening` | — | — (trigger) | **PORT** |
| `rescreenProductsOnMappingWrite` | `catalog/screenProductOnWrite.ts:194` | onDocumentWritten `podMappings/{mappingId}` · 256MiB | Re-screens live POD products when a mapping's `shopId`, `sku` or `artworkId` changes (F4). | R `podMappings`, `products`, …; W `products` | — | — (trigger) | **PORT** |
| `rescreenProductsOnArtworkWrite` | `catalog/screenProductOnWrite.ts:222` | onDocumentWritten `podArtwork/{artworkId}` · 256MiB | Re-screens when an artwork's `fileName` or `label` changes (F4). | R `podArtwork`, `podMappings`, `products`; W `products` | — | — (trigger) | **PORT** |

**Why, and the CF shape.** Two of SnapWear's eight pre-launch items are the "Rapportera intrång" link with takedown (#7) and pre-publish screening (#8). Screening is the item that *prevents* the one expensive scenario, IP infringement (memory `snapwear_integration.md`). Both are built (A10/A11, `LAUNCH_TODO.md:25`), so all five are PORT.
- **Without triggers,** `decideScreening` (`catalog/contentScreening.ts`, pure) runs **synchronously inside the product publish/update endpoint**. The two rescreens become calls from the mapping write endpoint and the artwork rename endpoint.
- **Keep the invariants:** the seller can't write `screening` or `takedown`, and can't set `isActive` while a takedown exists (today in `firestore.rules`; in CF, in endpoint code).

### 2.9 Add-on: product reviews (6)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `onOrderReviewQualify` | `product-reviews/writeReviewRequest.ts:45` | onDocumentUpdated `orders/{orderId}` · 256MiB | On a B2C order's first move to shipped, delivered or ready_for_pickup, writes one `reviewRequests/{orderId}` due in 3–21 days (per-shop delay). | W `reviewRequests`; R `shops` | — | — (trigger) | PORT-LATER |
| `sweepReviewRequests` | `product-reviews/sweep.ts:52` | onSchedule **every 60 min** · 256MiB · 120s · RESEND | Sends due review-request mails (guards: flag, suppression, cancelled order), reverting to `scheduled` on transport failure, and purges after 200 days. | RW `reviewRequests`; R `reviewSuppressions`, `orders`; [F productReviews] [E] | Resend | — (schedule) | PORT-LATER |
| `resolveReviewRequest` | `product-reviews/callables.ts:78` | onCall · 256MiB · 30s | Public, by token. Returns reviewable line refs and already-reviewed product ids; no personal data. | R `reviewRequests`, `productReviews` | — | `pages/shop/ReviewSubmitPage.jsx:65` | PORT-LATER |
| `submitReview` | `product-reviews/callables.ts:122` | onCall · 256MiB · 30s | Public, by token. One review per order per product (doc id `{orderId}_{productId}`). A clean review auto-approves and bumps `products.reviewCount`/`ratingSum` in a transaction; a flagged one goes to `pending`. | R `reviewRequests`; RW `productReviews`; W `products` | — | `pages/shop/ReviewSubmitPage.jsx:107` | PORT-LATER |
| `unsubscribeReviews` | `product-reviews/callables.ts:209` | onCall · 256MiB · 30s | Public, by token. Writes a suppression keyed `{shopId}_{sha256(email)}`. | R `reviewRequests`; W `reviewSuppressions` | — | `pages/shop/ReviewUnsubscribePage.jsx:34` | PORT-LATER |
| `moderateReview` | `product-reviews/callables.ts:251` | onCall · 256MiB · 30s | Shop admin approves or rejects a review. The aggregate delta is applied only on a real status change, inside a transaction. | RW `productReviews`; W `products`; [A] | — | `pages/admin/AdminReviews.jsx:117` | PORT-LATER |

- **All PORT-LATER.** It's a real add-on (verified-buyer reviews, Omnibus) but not needed for the first shop.
- **CF shape:** the trigger moves into the order status endpoint (§2.7), the sweep becomes a Cron, and the callables become routes. Also move the aggregate into D1 (`reviewCount`/`ratingSum` columns, or computed with `COUNT`/`AVG`).

### 2.10 Add-on: abandoned checkout (3)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `sweepAbandonedCheckouts` | `checkout-recovery/sweep.ts:45` | onSchedule **every 15 min** · 256MiB · 120s · RESEND, STRIPE | Three steps (listed below this table). | RW `checkouts`, `checkoutSuppressions`; R `orders`; [F abandonedCheckout] [E] | Stripe (`paymentIntents.retrieve/cancel`), Resend | — (schedule) | **PORT** (split) |
| `resolveCheckoutRecovery` | `checkout-recovery/callables.ts:57` | onCall · 256MiB · 30s | Public, by `(shopId, token)`. Returns cart line refs only (no prices or personal data), or `completed`/`invalid`. | R `checkouts` | — | `pages/shop/CheckoutRecoveryPage.jsx:43` | PORT-LATER |
| `unsubscribeCheckout` | `checkout-recovery/callables.ts:92` | onCall · 256MiB · 30s | Public, by token. Writes the reminder suppression. | R `checkouts`; W `checkoutSuppressions` | — | `pages/shop/CheckoutUnsubscribePage.jsx:34` | PORT-LATER |

**What `sweepAbandonedCheckouts` does in each run**

| Step | Action | Half |
|---|---|---|
| 1a | Purges legacy `checkouts` older than 30 days that have no production snapshot. | Core |
| 1b | For checkouts whose snapshot retention is due: **cancels the abandoned PaymentIntent before deleting the checkout's production snapshot**, and retains the snapshot if the PI succeeded without an order. | Core |
| 2 | Sends one reminder mail for checkouts that are open and past `remindAt`, re-checking consent, suppression, supersession, the frequency cap and expiry. | Add-on |

**Why, and the CF shape.** `sweepAbandonedCheckouts` is **PORT, split in two:**
- **Steps 1a/1b are core.** Every POD checkout writes a `checkouts/{piId}` snapshot (`createPaymentIntent.ts`, P1-16). Without the retention job, abandoned PaymentIntents stay payable against a snapshot that eventually vanishes. This half becomes a Cron Trigger at launch.
- **Step 2 and the two public callables are the "Övergiven kassa" add-on → PORT-LATER.**

### 2.11 Add-on: discount codes (1)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `validateDiscountCode` | `affiliate/callable/validateDiscountCode.ts:17` | onCall · 256MiB · 30s | Anonymous cart validation, scoped to the shop. Checks affiliate codes first, then campaign `discountCodes` (validity window, max uses). Validation only: the checkout recomputes the math. | R `affiliates`, `discountCodes`; [F affiliate, discountCodes] | — | `contexts/CartContext.jsx:452` | PORT-LATER |

- **PORT-LATER.** The checkout port has to keep the no-discount path working; add codes when the first shop asks.
- **Port it as campaign-codes only**, without the affiliate branch (§1.6 item 1).
- **Prior art exists:** `cloudflare-migration:cloudflare/src/commerce/discount-codes.ts`, `admin-discount-codes.ts`, and D1 migration `0010_discount_codes.sql`.

### 2.12 Add-on: affiliate (5)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `logAffiliateClickV2` | `affiliate/callable/logAffiliateClick.ts:13` | onCall · 256MiB · 60s (no `cors` option set) | Logs a click (240/h per IP), bumps `affiliates.stats.clicks`, and bumps the campaign's `totalClicks`. | W `affiliateClicks`; RW `affiliates`, `campaigns`; [RL] [F affiliate] | — | `components/AffiliateTracker.jsx:91` | **DELETE** |
| `approveAffiliate` | `email-orchestrator/functions/approveAffiliate.ts:33` | onCall · 256MiB · 120s · RESEND | Creates the Auth user (temporary password), the `affiliates/{uid}` doc (commission 15; code = first 3 letters of the name + 6 random chars) and the welcome mail, then deletes the application. | R+D `affiliateApplications`; W `affiliates`; [A] [F affiliate] [E] | Firebase Auth Admin, Resend | `pages/admin/AdminAffiliates.jsx:89`, `pages/admin/AdminAffiliateEdit.jsx:333` | **DELETE** |
| `sendAffiliateApplicationEmails` | `email-orchestrator/functions/sendAffiliateApplicationEmails.ts:25` | onCall · 256MiB · 60s · RESEND | Takes an applicationId only. Single-shot in a transaction; sends the applicant confirmation and the admin notice. | RW `affiliateApplications`; [RL] [E] | Resend | `pages/shop/AffiliateRegistration.jsx:76` | **DELETE** |
| `sendAffiliateWelcomeEmail` | `email-orchestrator/functions/sendAffiliateWelcomeEmail.ts:28` | onCall · 256MiB · 60s · RESEND | Welcome mail containing a caller-supplied temporary password. | R `affiliates`; [A] [E] | Resend | none | **DELETE** |
| `reverseAffiliateCommissionOnCancel` | `order-processing/commissionReversal.ts:22` | onDocumentUpdated `orders/{orderId}` · 256MiB | When an order moves to `cancelled`/`refunded`, reverses the awarded commission in a transaction. | RW `orders`, `affiliates` | — | — (trigger) | **DELETE** |

- **DELETE, pending Mikael's yes** (§1.6 item 1). If he wants affiliates back later, rebuild them on `discountCodes` plus an attribution column on orders, not by porting this ledger.
- **Deleting it also removes code outside these five exports:**
  - the affiliate branch in `createPaymentIntentV2` (`createPaymentIntent.ts:252`)
  - the affiliate half of `validateDiscountCode`
  - the commission block in `processOrderCompletion`

### 2.13 Add-on: Content Studio / social video (3)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `generateSocialCopy` | `content-studio/generateSocialCopy.ts:255` | onCall · 1GiB · 300s · ANTHROPIC_API_KEY | Pure compute. Writes Swedish TikTok/Reels/Shorts copy from a description, reference images and video keyframes. Model `claude-opus-4-8` with JSON-schema output. The client saves the result on `socialPosts`. | R `shops` (opt-in gate); [A] | **ffmpeg/ffprobe**, Anthropic, Cloud Storage | `pages/admin/AdminContentStudio.jsx:684` | PORT-LATER |
| `renderSocialVideo` | `content-studio/renderSocialVideo.ts:143` | onCall · **4GiB · cpu 2 · 540s · maxInstances 3** | Assembles a vertical beat-cut MP4 from the shop's uploaded clips and audio, one segment at a time, uploads it, and returns the URL. | R `shops` (gate); [A] | **ffmpeg/ffprobe**, Cloud Storage | `pages/admin/AdminContentStudio.jsx:720` | PORT-LATER |
| `getHandoffPackage` | `content-studio/getHandoffPackage.ts:31` | onCall · 256MiB · 30s | Public, token-guarded (the "Skicka till mobilen" QR). Returns only the copy and the video URL from a `socialPosts` draft. | R `socialPosts`, `shops` | — | `pages/HandoffPage.jsx:100` | PORT-LATER |

- **PORT-LATER.** It's an opt-in key (`config/shopFeatures.ts:22`, `contentStudio`). Both compute functions need the render service; `getHandoffPackage` is a trivial Worker route.
- **This is the add-on most likely to be dropped.** If there's no active user after the first POD launch, DELETE it (§1.6 item 5).

### 2.14 Add-on: B2B wholesale (2)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `createB2BOrder` | `order-processing/createB2BOrder.ts:51` | onCall · 256MiB · 60s · RESEND | "Faktura" invoice order. Caller must be the active `b2bCustomers` owner or a shop admin. Line prices are recomputed server-side from `b2bPrice` (ex moms), then VAT is added. `productionSnapshotRequired: true` (the snapshot is frozen on `paid` by `onOrderProductionReady`). Sends the confirmation and admin mails. | R `b2bCustomers`, `products`; W `orders`; [A] [E] | Resend | `pages/shop/B2BCatalog.jsx:85` | PORT-LATER |
| `cancelB2BOrder` | `order-processing/cancelB2BOrder.ts:24` | onCall · 256MiB · 60s | The owner or a shop admin cancels a `pending` B2B order and appends `statusHistory`. | R `b2bCustomers`; RW `orders`; [A] | — | `pages/shop/B2BOrderDetail.jsx:80` | PORT-LATER |

- **PORT-LATER.** This isn't the pre-pivot reseller portal. It's the re-shipped add-on gated on `features.b2b` (routes at `App.jsx:387-400`, memory `b2b_removal.md`). It isn't needed for a POD merch launch, and it drags in the B2B snapshot-freeze branch of §2.4.
- **`sendB2BApplicationEmails` is commented out** of the index as "TEMPORARILY DISABLED" (`index.ts:25`) and isn't counted.

### 2.15 Migrators (2)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `migrateFromShopify` | `email-orchestrator/functions/migrateFromShopify.ts:99` | onCall · **1GiB · 540s** | Admin of the shop or platform. Ingests a public `/products.json`, derives variants, SKUs and prices (a byte-for-byte port of the client derivation), re-uploads images to Storage, and creates `products`. | R `shops`, `products`; W `products`; [A] | Shopify public storefront (fetch, SSRF guard with `node:dns`), Cloud Storage | `components/platform/MigrateShopifyModal.jsx:27` | PORT-LATER |
| `migrateFromWoo` | `email-orchestrator/functions/migrateFromWoo.ts:78` | onCall · **1GiB · 540s** | Same idea over the WooCommerce Store API (`/wp-json/wc/store/products`), with live progress in `migrations/{id}`. | R `shops`, `products`; W `products`, `migrations`; [A] | WooCommerce Store API, Cloud Storage | `components/platform/MigrateWooModal.jsx:55` | PORT-LATER |

- **PORT-LATER.** These are sales tools for "things" shops (Ninetone, Giffarna), not POD. They don't use sharp.
- **In CF they must become Queue-driven jobs** (one message per product or image page, progress in D1), because a Worker request can't run for 540s. The shared money-path helpers (`migrationShared.ts`) port as-is.

### 2.16 DAC7 / reporting (9)

All nine: `dac7/functions.ts`, onCall · 256MiB · 60s · STRIPE_SECRET_KEY (a shared `COMMON`, even for the functions that never call Stripe).

| Export | Line | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|
| `saveDac7SellerProfile` | 80 | Platform-only. Writes the seller's DAC7 profile. | W `dac7Sellers`, `shops`; [A] | — | `pages/platform/PlatformDac7.jsx:202` | PORT-LATER |
| `getDac7SellerProfile` | 107 | Platform-only. Reads the profile and shop. | R `dac7Sellers`, `shops`; [A] | — | `pages/platform/PlatformDac7.jsx:91,168` | PORT-LATER |
| `getOwnDac7` | 130 | Seller views their own record (GDPR access). | R `dac7Sellers`; [A] | — | `pages/admin/AdminMyTaxData.jsx:68` | PORT-LATER |
| `correctOwnDac7Contact` | 144 | Seller corrects contact fields only. | W `dac7Sellers`; [A] | — | `pages/admin/AdminMyTaxData.jsx:87` | PORT-LATER |
| `requestDac7Correction` | 172 | Seller asks for an identity-field change. | W `dac7CorrectionRequests`; [A] | — | `pages/admin/AdminMyTaxData.jsx:101` | PORT-LATER |
| `resolveDac7Correction` | 193 | Platform approves or rejects a correction request. | RW `dac7CorrectionRequests`, `dac7Sellers`; [A] | — | `pages/platform/PlatformDac7.jsx:40` | PORT-LATER |
| `pullDac7FromStripe` | 224 | Platform mirrors Stripe-verified identity data. | R `shops`; W `dac7Sellers`, `shops`; [A] | Stripe (`accounts.retrieve`) | `pages/platform/PlatformDac7.jsx:177` | PORT-LATER |
| `exportDac7Report` | 343 | Platform export for a year: per-shop aggregate, de-minimis verdict (fewer than 30 transactions *and* €2,000 or less; `dac7/aggregate.ts:18-19`); `markReported` appends a transparency record. | R `shops`, `orders`, `dac7Sellers`; W `dac7Sellers`; [A] | — | `pages/platform/PlatformDac7.jsx:280` | PORT-LATER |
| `aggregateDac7Year` | 292 | One shop's yearly aggregate. | R `orders`; [A] | — | none | **DELETE** |

- **PORT-LATER.** DAC7 is the platform operator's legal duty, but it's deadline-driven. Per memory `dac7_thresholds.md`, seller due diligence is due by 31 Dec and filing by 31 Jan after the first year with reportable sellers. None of it is needed at checkout time.
- **Collapse the nine into a small set of routes** when porting.
- **`aggregateDac7Year` → DELETE.** No caller, and `exportDac7Report` covers it.

### 2.17 Impersonation / handoff (0)

- **No impersonation function exists on `main`.**
  - `mintImpersonationToken`, the cross-origin custom-token handoff from commit `ad2ea4e`, only lives on the `feat/custom-domains-cf-saas` and `feat/storefront-molten-template` branches.
  - On `main`, impersonation is client-side: the active-shop override plus client-written `impersonationAudit` docs (`src/config/impersonationAudit.js`).
  - The CF port has to design this fresh, as a platform-only route that mints a scoped, short-lived session with a server-written audit row.
- **The only "handoff" function is `getHandoffPackage`,** and it belongs to Content Studio (§2.13).

### 2.18 Misc (2)

| Export | Source | Trigger · config | What it does | Firestore | External | Client caller(s) | Rec |
|---|---|---|---|---|---|---|---|
| `getGeoDataV2` | `geo/functions.ts:14` | onRequest · 128MiB · 30s · `cors:true` | Returns the `cf-ipcountry` and related headers, plus the caller's IP, for currency detection. Origin-gated. | — | — | none | **DELETE** |
| `scrapeWebsiteMetaV2` | `website-scraper/functions.ts:199` | onRequest · 256MiB · 30s · `cors:true` | Fetches a caller-supplied URL (SSRF guard with `node:dns`, manual redirects) and extracts title, description and language for the Dining Wagon CRM. In-memory rate limit. | — | Arbitrary outbound HTTP | `wagons/dining-wagon/components/ContactDetail.jsx:1060`, `ContactForm.jsx:140` | **DELETE** |

- **`getGeoDataV2` → DELETE.** No caller. On Workers, `request.cf.country` gives the same answer for free.
- **`scrapeWebsiteMetaV2` → DELETE.** It exists only for the pre-pivot B2B-reseller CRM (`index.ts:125`: "Import website scraper functions for DiningWagon"). See §1.6 item 2.

---

## 3. Cross-cutting notes for the port

1. **There are nine Firestore triggers and D1 has no equivalent.** Each one becomes either work inline in the writing endpoint (same D1 batch) or a Queue message sent from it:

   | Trigger | Becomes |
   |---|---|
   | `syncProductsPublicOnWrite`, `syncPrintersPublicOnWrite` | Read-time projections |
   | `screenProductOnWrite` and the two rescreens | Inline in the product, mapping and artwork endpoints |
   | `onOrderProductionReady` | Queue, sent from the order-create and paid transitions |
   | `onOrderReviewQualify`, `reverseAffiliateCommissionOnCancel` | Order status endpoint (later / deleted) |
   | `syncUserClaimsOnWrite` | Deleted (§2.1) |

2. **Three schedules become Cron Triggers:** every 10 min (print outbox), every 15 min (checkout retention and reminders) and every 60 min (reviews).
3. **Firebase Storage token URLs are persisted in documents:**
   - `podArtwork.printUrl` and `previewUrl` (`processArtwork.ts:117-118`)
   - migrated product images (`migrationShared.ts:213`)
   - rendered videos (`renderSocialVideo.ts:428`)

   The data migration must rewrite them to R2 URLs or keys. `printProjection.ts:61,77` allowlists `firebasestorage.googleapis.com` and `storage.googleapis.com` as image and fallback hosts; that list has to change in the same step.
4. **Auth guards read the *live* user doc,** not token claims (`authGuard.ts:51-91`, `printGuard.ts`). Keep this in CF: authorize every request against the D1 `users` row.
5. **In-memory rate limits don't survive on Workers:**
   - `order-processing/functions.ts` (`global.orderRateLimit`), which is being deleted anyway
   - `withdrawal/functions.ts:76-80` guest limiter
   - `website-scraper` via `protection/rate-limiting/rate-limiter.ts`, which is being deleted

   Use the Workers Rate Limiting binding.
6. **Pure, unit-tested libraries to carry over verbatim:**
   - `payment/connectParams.ts`, `productionWithholding.ts`, `orderMoney.ts`, `connectFee.ts`, `platformConfig.ts`
   - `print/printRouting.ts`, `printProjection.ts`, `outboxCore.ts`, `projectPrinterPublic.ts`
   - `catalog/projectProduct.ts`, `contentScreening.ts`
   - `email-orchestrator/templates/*`
   - `dac7/aggregate.ts` (later)

---

## 4. Housekeeping findings (don't port; clean up)

- **Client calls to functions that don't exist on `main`:**
  - `updateCustomerEmailV2` (`pages/admin/AdminUserEdit.jsx:488`)
  - `generateContentWithClaude` (`wagons/writers-wagon/api/WritersWagonAPI.js:8`)
  - `setupWritersWagon` (`wagons/writers-wagon/components/WritersWagonPanel.jsx:84,133,153`). The writers-wagon manifest is `enabled: false` (`wagons/writers-wagon/WagonManifest.js:11`).
- **Stale compiled artifacts are tracked in git with no source:**
  - `functions/lib/google-merchant/*`
  - `functions/lib/debug-order-data.*`, `functions/lib/debug-product-fields.*`
  - `functions/lib/affiliate/http/logAffiliateClickHttp.*`
  - `functions/lib/affiliate/triggers/processAffiliateConversion.*`

  None of them are exported by `lib/index.js`. `index.ts:34-38,83` documents their removal.
- **Unused npm dependencies in `functions/package.json`:** `google-auth-library` (no import in `src/`) and `cors` (never imported; `protection/cors/cors-handler.ts` imports only express types).
- **Every DELETE candidate that is an open HTTP endpoint** is also a surface to shut:
  - `processB2COrderCompletionHttpV2` (CORS `*`, unauthenticated)
  - `getGeoDataV2` (echoes the caller's IP and headers)
  - `scrapeWebsiteMetaV2` (outbound fetch of arbitrary URLs)
  - `createAdminUserV2` and `syncAdminClaims` (behind a shared secret)
- **Earlier map.** `cloudflare-migration:docs/CLOUDFLARE_FUNCTION_MAP.md` (2026-08-16) mapped **75** exports and ported all of them, with no DELETE class. The seven exports added to `main` since then are `quotePodCost`, `syncPrintersPublicOnWrite`, `submitInfringementReport`, `takedownProduct`, `screenProductOnWrite`, `rescreenProductsOnMappingWrite` and `rescreenProductsOnArtworkWrite` (SnapWear A10/A11/A13). 75 + 7 = 82. This document supersedes that map's port list; its P0–P7 ordering can still be reused.
