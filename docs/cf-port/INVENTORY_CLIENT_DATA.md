# Client data-access inventory — Firebase SDK touchpoints in `src/`

_Read-only inventory for the Cloudflare Workers + D1 + R2 port. Generated 2026-09-26 on branch `main` (HEAD `533abf5`). Every Firebase SDK touchpoint in the React client is listed here; each becomes an HTTP call to the Worker. Counts are call sites (not imports), comments stripped, import aliases resolved (e.g. `updatePassword as firebaseUpdatePassword`, `ref as storageRef`). Method + caveats in §3._

## 0. Summary

- **144 files** under `src/` import `firebase/firestore|auth|storage|functions` or `firebase/config` (incl. one dynamic `await import(...)` in `src/utils/affiliateCalculations.js:123-124`). Of these: 1 is the SDK init module (`src/firebase/config.js`), 1 is dead (`src/components/PrivateRoute.jsx`, 0 importers), 1 has dead imports only (`src/App.jsx`). **141 files carry live call sites.**
- Import-graph check: every other file is reachable from `src/main.jsx` (wagons via `import.meta.glob('./*/index.js')` in `src/wagons/WagonRegistry.js`).
- No `firebase/app-check`, `firebase/analytics`, `collectionGroup`, `arrayUnion/arrayRemove`, `increment`, or `signInWithCustomToken` on `main` (grep: 0 hits). The impersonation custom-token flow described in project memory is NOT in `src/` on `main`; `ImpersonationIntake.jsx` only does one getDoc on `impersonationAudit`.

### 0.1 Totals per operation kind

| Operation | Call sites | Files | Port note |
|---|---:|---:|---|
| `getDoc` | 58 | 38 | GET /resource/:id |
| `getDocs` | 112 | 66 | list endpoints (paired with query()) |
| `query` | 126 | 72 | query builders (where/orderBy/limit) — each encodes a filter the Worker must replicate |
| `getCountFromServer` | 3 | 3 | aggregate count endpoint (`SELECT COUNT(*)`) |
| `onSnapshot` | 17 | 16 | **realtime** → polling / SSE / Durable Object WebSocket |
| `setDoc` | 16 | 11 | upsert (incl. `{merge:true}` deep-merge semantics) |
| `addDoc` | 33 | 30 | insert with server id |
| `updateDoc` | 58 | 40 | partial update (dotted-path field patches) |
| `deleteDoc` | 27 | 24 | delete |
| `writeBatch` | 2 | 2 | multi-row atomic write → D1 `batch()` |
| `runTransaction` | 1 | 1 | read-modify-write → D1 batch/Durable Object |
| `httpsCallable` | 67 | 46 | already RPC → 1:1 Worker route (mechanical) |
| `uploadBytes` | 20 | 12 | R2 upload (presigned PUT or Worker proxy) |
| `getDownloadURL` | 18 | 12 | R2 public/signed URL |
| `deleteObject` | 11 | 8 | R2 delete |
| `listAll` | 2 | 2 | R2 list (prefix) |
| `auth SDK fns (signIn…/signOut/onAuthStateChanged/createUser…/updatePassword/updateEmail/sendEmailVerification/applyActionCode)` | 15 | 6 | Firebase Auth SDK fns → Worker session auth |
| `auth.currentUser` reads | 9 | 3 | direct SDK singleton reads (EmailVerificationHandler ×6, PlatformPrinters ×2, ArtworkUploadModal ×1) |

Roll-up: **173 Firestore reads** (getDoc+getDocs+count), **134 Firestore writes** (set/add/update/delete) + **3 batch/transaction**, **17 realtime listeners**, **67 callable sites**, **51 Storage ops**, **15 Auth SDK calls** (+9 `auth.currentUser` reads).

### 0.2 Per-surface totals

| Surface | Files | Reads | Writes | Realtime | Batch/Tx | Callables | Storage | Auth | HEAVY / MOD / TRIVIAL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| admin | 34 | 52 | 36 | 5 | 2 | 16 | 11 | 0 | 7 / 12 / 15 |
| platform | 16 | 19 | 18 | 2 | 0 | 14 | 0 | 2 | 3 / 4 / 9 |
| storefront | 37 | 33 | 6 | 1 | 0 | 18 | 0 | 11 | 1 / 4 / 32 |
| print-portal | 3 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 / 0 / 3 |
| pod-wagon | 5 | 3 | 3 | 0 | 0 | 2 | 4 | 1 | 0 / 1 / 4 |
| crm-wagons | 15 | 9 | 34 | 9 | 0 | 0 | 3 | 0 | 9 / 1 / 5 |
| shared-context | 6 | 21 | 10 | 0 | 0 | 8 | 0 | 10 | 3 / 0 / 3 |
| util/config | 23 | 35 | 27 | 0 | 1 | 1 | 33 | 0 | 3 / 8 / 12 |
| public (non-shop) | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 / 0 / 2 |
| app-shell | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 1 |
| sdk-init | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 |
| DEAD | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 1 |

Surface key: **admin** = `src/pages/admin`, `src/components/admin`, `src/components/auth/ImpersonationIntake.jsx`, `src/hooks/useAdminPresence.js`, `src/wagons/WagonRegistry.js`. **crm-wagons** = dining/ambassador/campaign wagons (admin add-ons, per-shop flags `dining`/`ambassador`/`campaigns` via `src/config/addons.js:11-17`; candidates to drop rather than port). **public (non-shop)** = `src/pages/LandingPage.jsx` (platform LP, `submitLead`) + `src/pages/HandoffPage.jsx` (content-studio handoff, `getHandoffPackage`). **storefront** includes the B2B pages behind the `b2b` add-on flag and the affiliate portal components.

### 0.3 Top 15 heaviest files

Weight = reads + writes + storage ops + 2×auth fns + 4×onSnapshot + 4×(batch/tx) + 0.5×callables + 0.5×`auth.currentUser`.

| # | File | Surface | Weight | Why |
|---:|---|---|---:|---|
| 1 | `src/contexts/AuthContext.jsx` | shared-context | 25 | 6 auth fns, 5 reads, 6 writes, 4 callables |
| 2 | `src/utils/marketingMaterials.js` | util/config | 20 | 7 reads, 7 writes, 6 storage ops |
| 3 | `src/contexts/OrderContext.jsx` | shared-context | 17 | 13 reads, 3 writes, 2 callables |
| 4 | `src/pages/admin/AdminContentStudio.jsx` | admin | 17 | 1× onSnapshot, 4 writes, 8 storage ops, 2 callables |
| 5 | `src/pages/admin/AdminAffiliateEdit.jsx` | admin | 11 | 6 reads, 4 writes, 2 callables |
| 6 | `src/utils/pod3dUpload.js` | util/config | 11 | 11 storage ops |
| 7 | `src/contexts/SimpleAuthContext.jsx` | shared-context | 10.5 | 4 auth fns, 1 reads, 1 writes, 1 callables |
| 8 | `src/utils/affiliatePayouts.js` | util/config | 10 | 1× runTransaction, 4 reads, 2 storage ops |
| 9 | `src/pages/platform/PlatformPrinters.jsx` | platform | 9.5 | 4 reads, 4 writes, 1 callables |
| 10 | `src/pages/admin/AdminPages.jsx` | admin | 9 | 2× onSnapshot, 1 writes |
| 11 | `src/wagons/campaign-wagon/hooks/useCampaigns.js` | crm-wagons | 9 | 1× onSnapshot, 2 reads, 3 writes |
| 12 | `src/wagons/dining-wagon/components/DocumentCenter.jsx` | crm-wagons | 9 | 1× onSnapshot, 2 writes, 3 storage ops |
| 13 | `src/pages/platform/PlatformDac7.jsx` | platform | 8 | 1× onSnapshot, 1 reads, 6 callables |
| 14 | `src/utils/adminDocuments.js` | util/config | 8 | 2 reads, 3 writes, 3 storage ops |
| 15 | `src/utils/podArtwork.js` | util/config | 8 | 3 reads, 3 writes, 2 storage ops |

### 0.4 Every `onSnapshot` (realtime) usage

17 listeners in 16 files: 8 listeners in 7 files on core surfaces (admin/platform/storefront), 9 listeners in 9 files in the CRM wagons. None are in the storefront catalogue, cart, print portal or POD wagon.

| File:line | Listens to | Purpose / port suggestion |
|---|---|---|
| `src/components/platform/MigrateWooModal.jsx:48` | doc `migrations/{migrationId}` | Live migration progress bar. Poll, or SSE from the Worker. |
| `src/hooks/useAdminPresence.js:148` | query `adminPresence` (all if platform, else `where shopId==`) | Who-is-online presence + heartbeat writes. Natural Durable Object/WebSocket fit, or drop. |
| `src/pages/admin/AdminContentStudio.jsx:489` | query `socialPosts where shopId== orderBy createdAt desc` | Render status of AI video jobs. Poll while any job is pending. |
| `src/pages/admin/AdminPages.jsx:44` | query `pages where shopId==` | List view; realtime not needed — fetch + refetch after mutations. |
| `src/pages/admin/AdminPages.jsx:61` | query `pages where shopId==` (fallback on index error) | Same query as :44 — collapses into one fetch. |
| `src/pages/admin/AdminPayments.jsx:114` | doc `shops/{shopId}` (`.payments`) | Stripe Connect status while onboarding. Poll or refetch after each action. |
| `src/pages/platform/PlatformDac7.jsx:33` | query `dac7CorrectionRequests where status=='pending'` | Platform queue. Fetch on mount + after resolve. |
| `src/pages/shop/OrderConfirmation.jsx:52` | doc `orders/{orderId}` | Waits for Stripe webhook to create the order (90 s timeout, :47). Poll `GET /orders/:id` every 2-3 s — short-lived. |
| `src/wagons/ambassador-wagon/hooks/useAmbassadorActivities.js:94` | query `ambassadorActivities` (by contactId or shop) | CRM wagon. |
| `src/wagons/ambassador-wagon/hooks/useAmbassadorContacts.js:36` | query `affiliates where shopId== orderBy updatedAt desc` | CRM wagon. |
| `src/wagons/campaign-wagon/hooks/useCampaigns.js:41` | query `campaigns where shopId== orderBy createdAt desc` | CRM wagon. |
| `src/wagons/dining-wagon/components/DiningDashboard.jsx:54` | query `deferredActivities` (UNFILTERED, sorts in memory) | CRM wagon. |
| `src/wagons/dining-wagon/components/DocumentCenter.jsx:54` | query `customerDocuments where contactId==` | CRM wagon. |
| `src/wagons/dining-wagon/components/FollowUpCenter.jsx:98` | query `followUps` (filter-dependent) | CRM wagon. |
| `src/wagons/dining-wagon/hooks/useDiningActivities.js:80` | query `activities` (by contactId or shop) | CRM wagon. |
| `src/wagons/dining-wagon/hooks/useDiningContacts.js:45` | query `users` (all if platform, else `where shopId==`) | CRM wagon. |
| `src/wagons/dining-wagon/hooks/useMentionNotifications.js:39` | query `userMentions where userId==uid orderBy createdAt desc` | CRM wagon. |

### 0.5 Every Storage path the client writes / deletes / lists

All uploads are direct browser→Firebase Storage `uploadBytes`, almost always followed by `getDownloadURL` (exception: the 3D-model originals in pod3dUpload.js, which store paths only); the resulting **Firebase download URL is persisted into Firestore docs** (product images, branding, docs). Server-written POD files (`pod-artwork/{shopId}/print/…`, `…/previews/…`, per `src/utils/podUpload.js:9-12`) are not client ops.

| Path template | Written at (uploadBytes) | Via / callers | Delete / list |
|---|---|---|---|
| `products/{shopId}/{productId}/{imageType}_{ts}_{name}` (client-compressed) | `src/utils/imageUpload.js:83` | `uploadImageToStorage` ← ProductForm.jsx:817/822/890 | ProductForm.jsx:742 (parses download URL) |
| `collections/{shopId}/cover_{ts}_{ts}_{name}` | `src/utils/imageUpload.js:83` | AdminCollectionEdit.jsx:134 | — |
| `branding/{shopId}/{kind}_{ts}_{name}` (logo/hero, compressed) | `src/utils/imageUpload.js:83` | `uploadStoreImage` (imageUpload.js:109) ← AdminStorefront.jsx:151/212 | — |
| `branding/{shopId}/favicon_{ts}_{name}` (raw bytes) | `src/utils/imageUpload.js:107` | `uploadStoreImage` ← AdminStorefront.jsx:151 | — |
| `products/{shopId}/{productId}/{b2c_main \| mockup_{colorway}_{slot} \| studio_{colorway}_{slot}}` (raw WebP/PNG blob) | `src/wagons/pod-wagon/studio/DesignStudio.jsx:730` | `uploadBlobToPublicPath` ← DesignStudio.jsx:823/829/1096 (publicPath :819/:1091) | — |
| `pod-artwork/{shopId}/mockups/{templateId}/{slot}-{colorwayId}` (deterministic, overwrite) | `src/wagons/pod-wagon/studio/mockupUpload.js:19` | `uploadMockup` ← DesignStudio.jsx:669 | — |
| `pod-artwork/{shopId}/originals/{ts}_{safeName}` (byte-for-byte) | `src/utils/podUpload.js:81` | `uploadPodOriginal` ← ArtworkUploadModal.jsx:151 | podArtwork.js:92 (replace), :127 (delete) by stored path |
| `pod-3d-models/{modelId}/{viewId}/{colorwayId}/originals/{photo_\|map_\|mask_}{name}` + `…/{photo\|map\|mask}-1600` derivatives | `src/utils/pod3dUpload.js:218/219/224/246/247/263` | `uploadModelColorwayAssets` ← ModelEditor.jsx:85 | pod3dUpload.js:296 listAll + :298 deleteObject (recursive prefix delete) |
| `pages/{shopId}/{pageId}/attachments/{fileName}` | `src/utils/fileUpload.js:70` | `uploadFile` ← AdminPageEdit.jsx:247 | fileUpload.js:99 ← AdminPageEdit.jsx:271 |
| `admin-documents/{shopId}/customers/{customerId}/{ts}_{name}` | `src/utils/adminDocuments.js:97` **and inline** `src/pages/admin/AdminUserCreate.jsx:134` | adminDocuments ← AdminUserEdit, dining ContactDetail | adminDocuments.js:188 |
| `marketing-materials/{shopId}/generic/{ts}_{name}` | `src/utils/marketingMaterials.js:95` | admin marketing-material pages | marketingMaterials.js:195 |
| `marketing-materials/{shopId}/customers/{customerId}/{ts}_{name}` | `src/utils/marketingMaterials.js:218` | AdminCustomerMarketingMaterial* | marketingMaterials.js:320 |
| `marketing-materials/{shopId}/customers/{contactId}/crm-documents/{filename}` | `src/wagons/dining-wagon/components/DocumentCenter.jsx:102` | dining wagon | DocumentCenter.jsx:173 |
| `affiliates/{shopId}/{affiliateId}/invoices/invoice_{no}_{ts}.pdf` | `src/utils/affiliatePayouts.js:53` | AdminAffiliatePayout / AdminAffiliateEdit | — |
| `content-studio/{shopId}/uploads/{ts}_{safeName}` | `src/pages/admin/AdminContentStudio.jsx:529` | inline | listAll :448; deleteObject :610/:617 |
| `content-studio-quick/{shopId}/{ts}_{safeName}` | `src/pages/admin/AdminContentStudio.jsx:578` | inline | — |

Totals: 20 `uploadBytes` sites, 18 `getDownloadURL`, 11 `deleteObject`, 2 `listAll`, across 14 files. Firebase-URL coupling outside the SDK: `src/components/admin/ProductForm.jsx:737-742` (derives the object path from a download URL), `src/utils/imageOptimization.js:100-108` (`createLazyImageUrl` hard-codes a `firebasestorage.googleapis.com/…/b8shield-reseller-app.appspot.com` base; 0 callers, no SDK import), `src/firebase/config.js:92-96` (`getDirectStorageUrl`, unused). Existing stored URLs in docs need an R2 URL rewrite/migration.

### 0.6 Distinct Firestore collections touched by the client (union)

**41 top-level collections** (+ subcollections / fixed doc ids listed in the Paths column). "RT" = has at least one onSnapshot listener. Seeds the D1 schema and the Worker resource routes.

| Collection | Paths seen | Files | Surfaces | RT |
|---|---|---:|---|:--:|
| `activities` | `activities` | 4 | crm-wagons | RT |
| `adminCustomerDocuments` | `adminCustomerDocuments` | 2 | admin, util/config |  |
| `adminPresence` | `adminPresence` | 1 | admin | RT |
| `adminUIDs` | `adminUIDs` | 1 | util/config |  |
| `affiliateApplications` | `affiliateApplications` | 3 | admin, storefront |  |
| `affiliateClicks` | `affiliateClicks` | 3 | admin, storefront |  |
| `affiliatePayouts` | `affiliatePayouts` | 2 | admin, util/config |  |
| `affiliates` | `affiliates` | 14 | admin, crm-wagons, storefront, util/config | RT |
| `ambassadorActivities` | `ambassadorActivities` | 1 | crm-wagons | RT |
| `ambassadorContacts` | `ambassadorContacts` | 1 | crm-wagons |  |
| `b2bCustomers` | `b2bCustomers` | 4 | admin, shared-context, storefront |  |
| `b2cCustomers` | `b2cCustomers` | 10 | admin, platform, shared-context, storefront |  |
| `campaigns` | `campaigns` | 1 | crm-wagons | RT |
| `collections` | `collections` | 5 | admin, storefront |  |
| `customerDocuments` | `customerDocuments` | 1 | crm-wagons | RT |
| `dac7CorrectionRequests` | `dac7CorrectionRequests` | 1 | platform | RT |
| `deferredActivities` | `deferredActivities` | 1 | crm-wagons | RT |
| `discountCodes` | `discountCodes` | 1 | admin |  |
| `followUps` | `followUps` | 1 | crm-wagons | RT |
| `impersonationAudit` | `impersonationAudit` | 2 | admin, util/config |  |
| `infringementReports` | `infringementReports` | 2 | platform |  |
| `leads` | `leads` | 1 | platform |  |
| `marketingMaterials` | `marketingMaterials` | 2 | storefront, util/config |  |
| `migrations` | `migrations` | 1 | platform | RT |
| `orders` | `orders` | 16 | admin, crm-wagons, platform, shared-context, storefront, util/config | RT |
| `pages` | `pages` | 7 | admin, storefront | RT |
| `pod3dModels` | `pod3dModels` | 3 | platform, util/config |  |
| `podArtwork` | `podArtwork` | 1 | util/config |  |
| `podMappings` | `podMappings` | 2 | util/config |  |
| `printers` | `printers` | 1 | platform |  |
| `printersPublic` | `printersPublic` | 1 | util/config |  |
| `productReviews` | `productReviews` | 2 | admin, storefront |  |
| `products` | `products` | 17 | admin, crm-wagons, platform, pod-wagon, storefront, util/config |  |
| `productsPublic` | `productsPublic` | 10 | storefront, util/config |  |
| `settings` | `settings/app`, `settings/contentScreening`, `settings/podMockupTemplates`, `settings/podProfiles`, `settings/printRouting` | 6 | platform, util/config |  |
| `shops` | `shops`, `shops/{id}/legalAcceptances` | 14 | admin, platform, storefront, util/config | RT |
| `socialPosts` | `socialPosts` | 1 | admin | RT |
| `translations_{lang}` | `translations_{lang}` | 3 | shared-context, util/config |  |
| `userMentions` | `userMentions` | 3 | crm-wagons | RT |
| `userWagonSettings` | `userWagonSettings` | 1 | admin |  |
| `users` | `users`, `users/{id}/marketingMaterials` | 12 | DEAD, admin, crm-wagons, platform, shared-context, util/config | RT |

Collections touched ONLY by the CRM wagons (8): `activities`, `ambassadorActivities`, `ambassadorContacts`, `campaigns`, `customerDocuments`, `deferredActivities`, `followUps`, `userMentions`. Dropping those wagons removes them from the port.

`translations_{lang}` = dynamic collection name `translations_${lang.replace('-','_')}` (e.g. `translations_sv_SE`, `translations_en_GB`, `translations_en_US`) read whole by TranslationContext.jsx:79-82, credentialTranslations.js:62-64, translationDetection.js:32-35.

### 0.7 Distinct callables invoked by the client (Worker RPC surface)

**59 distinct callable names** over 67 `httpsCallable` sites. These already are RPC — each becomes one Worker route with the same request/response JSON (`{data}` envelope), so consumers change mechanically.

| Callable | Call sites |
|---|---|
| `approveAffiliate` | pages/admin/AdminAffiliateEdit.jsx:333, pages/admin/AdminAffiliates.jsx:89 |
| `cancelB2BOrder` | pages/shop/B2BOrderDetail.jsx:80 |
| `confirmPasswordResetV2` | pages/shop/ResetPassword.jsx:74 |
| `correctOwnDac7Contact` | pages/admin/AdminMyTaxData.jsx:87 |
| `createB2BOrder` | pages/shop/B2BCatalog.jsx:85 |
| `createConnectAccount` | pages/admin/AdminPayments.jsx:126 |
| `createConnectAccountLink` | pages/admin/AdminPayments.jsx:126 |
| `createConnectLoginLink` | pages/admin/AdminPayments.jsx:126 |
| `createPlatformSuperAdmin` | pages/platform/PlatformUsers.jsx:214 |
| `createPrintShopUser` | pages/platform/PlatformPrinters.jsx:127 |
| `createShopUser` | components/platform/AddShopUserModal.jsx:26 |
| `deleteB2CCustomerAccountV2` | pages/admin/AdminB2CCustomerEdit.jsx:280 |
| `deleteCustomerAccountV2` | contexts/AuthContext.jsx:745 |
| `deletePlatformUser` | pages/platform/PlatformUsers.jsx:64 |
| `exportDac7Report` | pages/platform/PlatformDac7.jsx:280 |
| `generateSocialCopy` | pages/admin/AdminContentStudio.jsx:684 |
| `getConnectBalance` | pages/admin/AdminPayments.jsx:355 |
| `getDac7SellerProfile` | pages/platform/PlatformDac7.jsx:91, pages/platform/PlatformDac7.jsx:168 |
| `getHandoffPackage` | pages/HandoffPage.jsx:100 |
| `getOwnDac7` | pages/admin/AdminMyTaxData.jsx:68 |
| `getPrintArtworkDownload` | pages/print/PrintShopArtwork.jsx:66 |
| `getPrintArtworkLibrary` | pages/print/PrintShopArtwork.jsx:35 |
| `getPrintJob` | pages/print/PrintShopOrderDetail.jsx:63 |
| `getPrintQueue` | pages/print/PrintShopQueue.jsx:49 |
| `getPrintQueueExport` | pages/print/PrintShopQueue.jsx:64 |
| `logAffiliateClickV2` | components/AffiliateTracker.jsx:91 |
| `migrateFromShopify` | components/platform/MigrateShopifyModal.jsx:27 |
| `migrateFromWoo` | components/platform/MigrateWooModal.jsx:55 |
| `moderateReview` | pages/admin/AdminReviews.jsx:117 |
| `processPodArtwork` | wagons/pod-wagon/components/ArtworkLibrary.jsx:48, wagons/pod-wagon/components/ArtworkUploadModal.jsx:154 |
| `pullDac7FromStripe` | pages/platform/PlatformDac7.jsx:177 |
| `quotePodCost` | config/podCostQuote.js:38 |
| `refreshConnectStatus` | pages/admin/AdminPayments.jsx:126 |
| `refundOrder` | pages/admin/AdminOrderDetail.jsx:317 |
| `renderSocialVideo` | pages/admin/AdminContentStudio.jsx:720 |
| `requestDac7Correction` | pages/admin/AdminMyTaxData.jsx:101 |
| `resolveCheckoutRecovery` | pages/shop/CheckoutRecoveryPage.jsx:43 |
| `resolveDac7Correction` | pages/platform/PlatformDac7.jsx:40 |
| `resolveReviewRequest` | pages/shop/ReviewSubmitPage.jsx:65 |
| `saveDac7SellerProfile` | pages/platform/PlatformDac7.jsx:202 |
| `sendAffiliateApplicationEmails` | pages/shop/AffiliateRegistration.jsx:76 |
| `sendCustomEmailVerification` | pages/admin/AdminB2CCustomerEdit.jsx:322, pages/shop/Checkout.jsx:440, pages/shop/CustomerAccount.jsx:222, pages/shop/CustomerRegister.jsx:117 |
| `sendLoginCredentialsEmail` | contexts/AuthContext.jsx:678, pages/admin/AdminAffiliateEdit.jsx:505 |
| `sendOrderStatusUpdateEmail` | contexts/OrderContext.jsx:566, contexts/OrderContext.jsx:858 |
| `sendPasswordResetEmail` | contexts/AuthContext.jsx:244, contexts/SimpleAuthContext.jsx:125 |
| `setConnectPayoutDelay` | pages/admin/AdminPayments.jsx:414 |
| `setPrintJobStatus` | pages/print/PrintShopOrderDetail.jsx:78 |
| `setShopCommission` | pages/platform/shopCells.jsx:106 |
| `submitInfringementReport` | pages/shop/InfringementReportPage.jsx:101 |
| `submitLead` | pages/LandingPage.jsx:206 |
| `submitReview` | pages/shop/ReviewSubmitPage.jsx:107 |
| `submitWithdrawal` | components/shop/OrderWithdrawal.jsx:48, pages/shop/WithdrawalPage.jsx:53 |
| `takedownProduct` | pages/platform/PlatformReports.jsx:534 |
| `toggleCustomerActiveStatusV2` | contexts/AuthContext.jsx:791 |
| `unsubscribeCheckout` | pages/shop/CheckoutUnsubscribePage.jsx:34 |
| `unsubscribeReviews` | pages/shop/ReviewUnsubscribePage.jsx:34 |
| `updateCustomerEmailV2` | pages/admin/AdminUserEdit.jsx:488 |
| `validateDiscountCode` | contexts/CartContext.jsx:452 |
| `verifyEmailCode` | pages/shop/EmailVerificationHandler.jsx:40, pages/shop/VerifyEmailPage.jsx:32 |

Plus **raw HTTP (`onRequest`) Firebase Functions** called with `fetch(functionUrl(...))` (`src/config/urls.js:32,41` derives `https://us-central1-b8shield-reseller-app.cloudfunctions.net/<name>`): `createPaymentIntentV2` (`src/components/shop/StripePaymentForm.jsx:402`), `scrapeWebsiteMetaV2` (`src/wagons/dining-wagon/components/ContactForm.jsx:140`, `ContactDetail.jsx:1060`), `setupWritersWagon` (`src/wagons/writers-wagon/components/WritersWagonPanel.jsx:84/133/153`) and `generateContentWithClaude` (`src/wagons/writers-wagon/api/WritersWagonAPI.js:8`) — writers-wagon is `enabled: false` (`src/wagons/writers-wagon/WagonManifest.js:11`). These files do not import the SDK so they are not in the 144, but they must be re-pointed.

### 0.8 Hidden coupling outside the SDK call sites

- **Firestore Timestamp shape leaks into UI code**: `.toDate()` at 40 sites in 32 files (11 sites in 9 files that never import Firebase, e.g. `src/pages/admin/AdminOrders.jsx`, `src/utils/orderExport.js`, `src/utils/pickupExport.js`, `src/utils/orderVerification.js`, `src/components/admin/FileManager.jsx`); `.seconds` at 43 sites in 15 files (4 non-Firebase files). The Worker must either return a Timestamp-compatible object (client reviver giving `{seconds, nanoseconds, toDate()}`) or all these sites change.
- **Write sentinels**: `serverTimestamp()` 86 sites / 37 files; `Timestamp.now|fromDate|fromMillis` 7 sites / 2 files; `deleteField()` 2 sites / 2 files. `where()` 189 sites / 68 files, `orderBy()` 43 / 28, `limit()` 13 / 10, `startAfter()` 1 — every distinct filter combination is an endpoint parameter the Worker must support (and today is enforced by `firestore.rules`, not code).
- **Auth user object**: `currentUser.uid` 65 sites, `.email` 23, `.displayName` 9, `.emailVerified` 2, `.reload()` 2 repo-wide — mostly via `useAuth()`/`useSimpleAuth()`, so the two contexts can keep the shape.
- **Two independent auth contexts** share one Firebase Auth project: `AuthContext` (admin/platform/print; profile in `users`) and `SimpleAuthContext` (storefront customers; profile in `b2cCustomers`). Firebase-native email flows in use: `sendEmailVerification` (Checkout.jsx:456, CustomerRegister.jsx:134), `applyActionCode` (EmailVerificationHandler.jsx:65); password reset / verification codes already go through callables (`sendPasswordResetEmail`, `confirmPasswordResetV2`, `verifyEmailCode`, `sendCustomEmailVerification`).

### 0.9 Abstraction coverage

Modules that already wrap the SDK (swap the body, callers untouched). "Shielded" = importers that do NOT themselves import Firebase (they become zero-change files).

| Module | Own SDK ops | Importers | Shielded importers |
|---|---:|---:|---:|
| `src/utils/podMappings.js` | 6 | 4 | 1 |
| `src/utils/podArtwork.js` | 8 | 3 | 1 |
| `src/utils/podUpload.js` | 2 | 2 | 0 |
| `src/utils/pod3dUpload.js` | 11 | 2 | 0 |
| `src/utils/imageUpload.js` | 4 | 3 | 0 |
| `src/utils/fileUpload.js` | 3 | 4 | 2 |
| `src/utils/adminDocuments.js` | 8 | 2 | 0 |
| `src/utils/marketingMaterials.js` | 20 | 5 | 2 |
| `src/utils/affiliatePayouts.js` | 7 | 2 | 0 |
| `src/utils/affiliateCalculations.js` | 1 | 6 | 0 |
| `src/utils/adminUIDManager.js` | 4 | 1 | 0 |
| `src/utils/legalAcceptance.js` | 4 | 2 | 0 |
| `src/utils/loadContentScreening.js` | 1 | 2 | 0 |
| `src/utils/productFeed.js` | 1 | 1 | 0 |
| `src/utils/translationDetection.js` | 1 | 2 | 2 |
| `src/utils/credentialTranslations.js` | 1 | 2 | 2 |
| `src/config/shopConfig.js` | 7 | 8 | 2 |
| `src/config/printRouting.js` | 2 | 2 | 1 |
| `src/config/podCostQuote.js` | 1 | 2 | 1 |
| `src/config/podProfiles.js` | 1 | 6 | 2 |
| `src/config/podMockupTemplates.js` | 1 | 2 | 1 |
| `src/config/pod3dModels.js` | 1 | 3 | 0 |
| `src/config/impersonationAudit.js` | 2 | 2 | 2 |
| `src/wagons/pod-wagon/studio/mockupUpload.js` | 2 | 1 | 0 |
| `src/hooks/useAdminPresence.js` | 3 | 2 | 2 |
| `src/contexts/AuthContext.jsx` | 21 | 46 | 16 |
| `src/contexts/SimpleAuthContext.jsx` | 7 | 15 | 5 |
| `src/contexts/OrderContext.jsx` | 18 | 3 | 1 |
| `src/contexts/CartContext.jsx` | 1 | 11 | 4 |
| `src/contexts/B2BCustomerContext.jsx` | 1 | 7 | 2 |
| `src/contexts/TranslationContext.jsx` | 1 | 68 | 28 |

Importer counts come from a resolved relative-import graph (so `config/printRouting.js` is not confused with `wagons/pod-wagon/printRouting.js`), include `src/dev/*` harnesses and exclude the module itself. Note importers are counted by any import of the module (e.g. `TranslationContext` importers mostly use only `useTranslation`). **Most importers of the utils ALSO call the SDK inline elsewhere**, so the utils shield specific operations, not whole files — e.g. `DesignStudio.jsx` uses 8 wrappers yet still does inline product addDoc/updateDoc + a Storage upload.

Pattern totals: ABSTRACTION modules 25, CONTEXT 6, INLINE (components/pages calling the SDK directly) 112.

## 1. Per-file inventory

Columns: **SDK** families imported (FS=firestore, Auth, Stor=storage, Fn=functions; `Auth(cfg)` = only the `auth` singleton from config). **gD**=getDoc, **gDs/q**=getDocs / query(), **cnt**=getCountFromServer, **RT**=onSnapshot, **W** = setDoc/addDoc/updateDoc/deleteDoc, **B/T**=writeBatch/runTransaction, **Fn**=httpsCallable sites, **Stor**=uploadBytes/getDownloadURL/deleteObject/listAll, **Auth**=auth SDK fns (+`auth.currentUser` reads). **Effort**: TRIVIAL = ≤2 inline data/storage/auth ops (callables are treated as a mechanical 1:1 RPC shim); MODERATE = 3-9 inline ops; HEAVY = ≥10 inline ops OR any onSnapshot OR batch/transaction OR owns auth state. Pattern ABSTRACTION = the swap point (rewrite body, callers untouched).

### 1.1 admin (34 files)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `components/admin/PlatformTermsGate.jsx` | 190 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/admin/ProductForm.jsx` | 1674 | FS+Stor | 1 | 1/1 | 0 | 0 | 1/1/1/0 | 0/0 | 0 | 0/0/1/0 | 0 | INLINE | MODERATE |
| `components/admin/ShopPicker.jsx` | 132 | FS | 0 | 1/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/auth/ImpersonationIntake.jsx` | 113 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `hooks/useAdminPresence.js` | 222 | FS | 0 | 0/2 | 0 | 1 | 1/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | HEAVY |
| `pages/admin/AdminAffiliateAnalytics.jsx` | 568 | FS | 1 | 3/3 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminAffiliateCreate.jsx` | 391 | FS | 0 | 0/0 | 0 | 0 | 1/1/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminAffiliateEdit.jsx` | 1224 | FS+Fn | 2 | 4/4 | 0 | 0 | 0/0/2/2 | 0/0 | 2 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `pages/admin/AdminAffiliatePayout.jsx` | 386 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminAffiliates.jsx` | 375 | FS+Fn | 0 | 2/2 | 0 | 0 | 0/0/0/1 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminB2BCustomers.jsx` | 240 | FS | 0 | 1/1 | 0 | 0 | 0/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminB2CCustomerEdit.jsx` | 773 | FS+Fn | 2 | 2/2 | 0 | 0 | 0/0/1/0 | 0/0 | 2 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminB2CCustomers.jsx` | 412 | FS | 0 | 3/3 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminCollectionEdit.jsx` | 417 | FS | 1 | 2/2 | 0 | 0 | 1/1/0/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminCollections.jsx` | 324 | FS | 0 | 1/1 | 0 | 0 | 0/0/1/1 | 1/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `pages/admin/AdminContentStudio.jsx` | 1512 | FS+Fn+Stor | 0 | 0/1 | 0 | 1 | 0/1/2/1 | 0/0 | 2 | 2/3/2/1 | 0 | INLINE | HEAVY |
| `pages/admin/AdminCustomerMarketingMaterialEdit.jsx` | 406 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminCustomerMarketingMaterials.jsx` | 414 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminDashboard.jsx` | 351 | FS | 0 | 4/4 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminDiscountCodes.jsx` | 548 | FS | 0 | 3/3 | 0 | 0 | 0/1/2/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminMenu.jsx` | 269 | FS | 0 | 3/3 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminMyTaxData.jsx` | 214 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 3 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminOrderDetail.jsx` | 871 | FS+Fn | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminPageEdit.jsx` | 666 | FS | 1 | 0/0 | 0 | 0 | 1/1/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminPages.jsx` | 330 | FS | 0 | 0/2 | 0 | 2 | 0/0/0/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `pages/admin/AdminPayments.jsx` | 459 | FS+Fn | 0 | 0/0 | 0 | 1 | 0/0/0/0 | 0/0 | 3 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `pages/admin/AdminPlatformTerms.jsx` | 122 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminProducts.jsx` | 537 | FS | 0 | 1/1 | 0 | 0 | 0/0/1/1 | 1/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `pages/admin/AdminReviews.jsx` | 251 | FS+Fn | 0 | 2/2 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminSettings.jsx` | 932 | FS | 0 | 1/1 | 0 | 0 | 0/1/2/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminStorefront.jsx` | 827 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/admin/AdminUserCreate.jsx` | 595 | FS+Stor | 0 | 0/0 | 0 | 0 | 0/1/0/0 | 0/0 | 0 | 1/1/0/0 | 0 | INLINE | MODERATE |
| `pages/admin/AdminUserEdit.jsx` | 1274 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `wagons/WagonRegistry.js` | 396 | FS | 2 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/components/admin/PlatformTermsGate.jsx` — getDoc :99 — **collections:** `shops`
- `src/components/admin/ProductForm.jsx` — getDoc :986; getDocs :800; query :800; setDoc :1000; addDoc :977; updateDoc :998; deleteObject :742 — **collections:** `products` — **storage refs:** `storagePath`:742 — _Uploads go through utils/imageUpload.js (ProductForm.jsx:817/822/890) but deleteObject :742 parses the Firebase download-URL format (`/o/` at :739) — hard coupling to Firebase Storage URLs stored in product docs._
- `src/components/admin/ShopPicker.jsx` — getDocs :30 — **collections:** `shops`
- `src/components/auth/ImpersonationIntake.jsx` — getDoc :75 — **collections:** `impersonationAudit`
- `src/hooks/useAdminPresence.js` — query :145,146; onSnapshot :148; setDoc :53; updateDoc :77 — **collections:** `adminPresence` — _Realtime adminPresence (all for platform, shopId-filtered otherwise) :144-148 + heartbeat set/update._
- `src/pages/admin/AdminAffiliateAnalytics.jsx` — getDoc :201; getDocs :29,42,198; query :28,36,193 — **collections:** `affiliates`, `affiliateClicks`, `orders`
- `src/pages/admin/AdminAffiliateCreate.jsx` — setDoc :107; addDoc :78 — **collections:** `affiliates`
- `src/pages/admin/AdminAffiliateEdit.jsx` — getDoc :254,262; getDocs :150,158,173,221; query :149,157,172,220; updateDoc :423,478; deleteDoc :360,443; httpsCallable :333,505 — **collections:** `orders`, `affiliateClicks`, `affiliatePayouts`, `affiliateApplications`, `affiliates` — **callables:** `approveAffiliate`:333, `sendLoginCredentialsEmail`:505
- `src/pages/admin/AdminAffiliatePayout.jsx` — getDoc :48 — **collections:** `affiliates`
- `src/pages/admin/AdminAffiliates.jsx` — getDocs :68,74; query :67,73; deleteDoc :110; httpsCallable :89 — **collections:** `affiliateApplications`, `affiliates` — **callables:** `approveAffiliate`:89
- `src/pages/admin/AdminB2BCustomers.jsx` — getDocs :42; query :37; updateDoc :64 — **collections:** `b2bCustomers`
- `src/pages/admin/AdminB2CCustomerEdit.jsx` — getDoc :70,122; getDocs :137,154; query :131,147; updateDoc :248; httpsCallable :280,322 — **collections:** `orders`, `b2cCustomers` — **callables:** `deleteB2CCustomerAccountV2`:280, `sendCustomEmailVerification`:322
- `src/pages/admin/AdminB2CCustomers.jsx` — getDocs :48,111,128; query :42,105,121 — **collections:** `b2cCustomers`, `orders`
- `src/pages/admin/AdminCollectionEdit.jsx` — getDoc :83; getDocs :62,158; query :62,158; setDoc :187; addDoc :182; deleteDoc :203 — **collections:** `products`, `collections`
- `src/pages/admin/AdminCollections.jsx` — getDocs :88; query :88; updateDoc :123; deleteDoc :109; writeBatch :150 — **collections:** `collections` — _writeBatch :150 (collection re-order)._
- `src/pages/admin/AdminContentStudio.jsx` — query :484; onSnapshot :489; addDoc :741; updateDoc :796,854; deleteDoc :844; httpsCallable :684,720; uploadBytes :529,578; getDownloadURL :462,534,583; deleteObject :610,617; listAll :448 — **collections:** `socialPosts` — **callables:** `generateSocialCopy`:684, `renderSocialVideo`:720 — **storage refs:** ``content-studio/${shopId}/uploads``:448; `a.path`:462; `path`:529; `path`:578; `asset.path`:610; `asset.path`:617 — _Realtime `socialPosts` list; direct Storage: listAll :448, uploadBytes :529/:578, deleteObject :610/:617; callables generateSocialCopy :684, renderSocialVideo :720._
- `src/pages/admin/AdminCustomerMarketingMaterialEdit.jsx` — getDoc :77 — **collections:** `users`
- `src/pages/admin/AdminCustomerMarketingMaterials.jsx` — getDoc :81 — **collections:** `users`
- `src/pages/admin/AdminDashboard.jsx` — getDocs :122,130,133,171; query :123,131,134,172 — **collections:** `b2cCustomers`, `orders`, `affiliates`
- `src/pages/admin/AdminDiscountCodes.jsx` — getDocs :71,81,187; query :66,76,182; addDoc :212; updateDoc :209,237; deleteDoc :251 — **collections:** `discountCodes`, `products`
- `src/pages/admin/AdminMenu.jsx` — getDocs :128,129,130; query :128,129,130 — **collections:** `products`, `collections`, `pages`
- `src/pages/admin/AdminMyTaxData.jsx` — httpsCallable :68,87,101 — **callables:** `getOwnDac7`:68, `correctOwnDac7Contact`:87, `requestDac7Correction`:101
- `src/pages/admin/AdminOrderDetail.jsx` — getDoc :135; httpsCallable :317 — **collections:** `users` — **callables:** `refundOrder`:317
- `src/pages/admin/AdminPageEdit.jsx` — getDoc :111; setDoc :215; addDoc :204 — **collections:** `pages`
- `src/pages/admin/AdminPages.jsx` — query :41,59; onSnapshot :44,61; deleteDoc :100 — **collections:** `pages` — _Two onSnapshot on `pages` (primary :44 + index-error fallback :61, same query)._
- `src/pages/admin/AdminPayments.jsx` — onSnapshot :114; httpsCallable :126,355,414 — **collections:** `shops` — **callables:** `refreshConnectStatus|createConnectAccount|createConnectAccountLink|createConnectLoginLink (dynamic, see note)`:126, `getConnectBalance`:355, `setConnectPayoutDelay`:414 — _Realtime shops/{shopId} (payments map) :114; `call(name)` helper :125-129 is dynamic — names: refreshConnectStatus, createConnectAccount, createConnectAccountLink, createConnectLoginLink (AdminPayments.jsx:147/256/278/315) + getConnectBalance :355, setConnectPayoutDelay :414._
- `src/pages/admin/AdminPlatformTerms.jsx` — getDoc :56 — **collections:** `shops`
- `src/pages/admin/AdminProducts.jsx` — getDocs :121; query :121; updateDoc :189; deleteDoc :165; writeBatch :220 — **collections:** `products` — _writeBatch :220 (bulk product update)._
- `src/pages/admin/AdminReviews.jsx` — getDocs :73,78; query :68,77; httpsCallable :117 — **collections:** `productReviews`, `products` — **callables:** `moderateReview`:117
- `src/pages/admin/AdminSettings.jsx` — getDocs :200; query :200; addDoc :263; updateDoc :256,323 — **collections:** `pages`
- `src/pages/admin/AdminStorefront.jsx` — getDocs :85; query :85 — **collections:** `products`
- `src/pages/admin/AdminUserCreate.jsx` — addDoc :155; uploadBytes :134; getDownloadURL :135 — **collections:** `adminCustomerDocuments` — **storage refs:** ``admin-documents/${shopId}/customers/${userId}/${Date.now()}_${doc.file.name}``:133 — _INLINE duplicate of utils/adminDocuments.js upload (AdminUserCreate.jsx:133-135) + addDoc adminCustomerDocuments._
- `src/pages/admin/AdminUserEdit.jsx` — httpsCallable :488 — **callables:** `updateCustomerEmailV2`:488
- `src/wagons/WagonRegistry.js` — getDoc :273,280 — **collections:** `users`, `userWagonSettings` — _Imports `db` from `../firebase/config.js` (with extension). getDoc users/{uid} :273 + userWagonSettings/{uid} :280. Discovers wagons via import.meta.glob._

</details>

### 1.2 platform (16 files)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `components/platform/AddShopUserModal.jsx` | 112 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/platform/MigrateShopifyModal.jsx` | 149 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/platform/MigrateWooModal.jsx` | 200 | FS+Fn | 0 | 0/0 | 0 | 1 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `components/platform/ModelEditor.jsx` | 750 | FS | 0 | 0/0 | 0 | 0 | 0/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/platform/PlatformLayout.jsx` | 158 | FS | 0 | 0/1 | 1 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/platform/ProvisionShopModal.jsx` | 253 | FS | 1 | 0/0 | 0 | 0 | 1/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/platform/PlatformAddons.jsx` | 149 | FS | 0 | 1/0 | 0 | 0 | 0/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/platform/PlatformDac7.jsx` | 446 | FS+Fn | 0 | 1/1 | 0 | 1 | 0/0/0/0 | 0/0 | 6 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `pages/platform/PlatformLeads.jsx` | 139 | FS | 0 | 1/1 | 0 | 0 | 0/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/platform/PlatformModels.jsx` | 239 | FS | 0 | 1/0 | 0 | 0 | 0/1/1/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/platform/PlatformPrinters.jsx` | 437 | FS+Fn+Auth(cfg) | 1 | 3/1 | 0 | 0 | 3/0/1/0 | 0/0 | 1 | 0/0/0/0 | 0+2cu | INLINE | HEAVY |
| `pages/platform/PlatformReports.jsx` | 578 | FS+Fn | 1 | 3/2 | 0 | 0 | 0/0/3/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/platform/PlatformShopDetail.jsx` | 501 | FS | 1 | 0/1 | 1 | 0 | 0/0/3/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/platform/PlatformShops.jsx` | 224 | FS | 0 | 1/1 | 1 | 0 | 0/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/platform/PlatformUsers.jsx` | 295 | FS+Fn | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 2 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/platform/shopCells.jsx` | 146 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/components/platform/AddShopUserModal.jsx` — httpsCallable :26 — **callables:** `createShopUser`:26
- `src/components/platform/MigrateShopifyModal.jsx` — httpsCallable :27 — **callables:** `migrateFromShopify`:27
- `src/components/platform/MigrateWooModal.jsx` — onSnapshot :48; httpsCallable :55 — **collections:** `migrations` — **callables:** `migrateFromWoo`:55 — _Realtime migrations/{id} progress doc :48 (live progress bar)._
- `src/components/platform/ModelEditor.jsx` — updateDoc :57 — **collections:** `pod3dModels`
- `src/components/platform/PlatformLayout.jsx` — query :59; getCountFromServer :59 — **collections:** `infringementReports` — _getCountFromServer on infringementReports (nav badge)._
- `src/components/platform/ProvisionShopModal.jsx` — getDoc :109; setDoc :115 — **collections:** `shops`
- `src/pages/platform/PlatformAddons.jsx` — getDocs :25; updateDoc :50 — **collections:** `shops`
- `src/pages/platform/PlatformDac7.jsx` — getDocs :86; query :32; onSnapshot :33; httpsCallable :40,91,168,177,202,280 — **collections:** `dac7CorrectionRequests`, `shops` — **callables:** `resolveDac7Correction`:40, `getDac7SellerProfile`:91, `getDac7SellerProfile`:168, `pullDac7FromStripe`:177, `saveDac7SellerProfile`:202, `exportDac7Report`:280 — _Realtime dac7CorrectionRequests where status==pending :32-33; 6 callables._
- `src/pages/platform/PlatformLeads.jsx` — getDocs :31; query :31; updateDoc :49 — **collections:** `leads`
- `src/pages/platform/PlatformModels.jsx` — getDocs :38; addDoc :88; updateDoc :58; deleteDoc :75 — **collections:** `pod3dModels`
- `src/pages/platform/PlatformPrinters.jsx` — getDoc :92; getDocs :89,90,91; query :90; setDoc :183,227,270; updateDoc :177; httpsCallable :127; auth.currentUser :220,274 — **collections:** `shops`, `users`, `printers`, `settings/printRouting` — **callables:** `createPrintShopUser`:127 — _Reads `auth.currentUser?.uid` for audit stamps :220/:274; three setDoc(merge/mergeFields) writes._
- `src/pages/platform/PlatformReports.jsx` — getDoc :495; getDocs :478,480,481; query :478,480; updateDoc :541,545,547; httpsCallable :534 — **collections:** `infringementReports`, `products`, `shops` — **callables:** `takedownProduct`:534
- `src/pages/platform/PlatformShopDetail.jsx` — getDoc :65; query :77; getCountFromServer :76; updateDoc :122,139,156 — **collections:** `products`, `orders`, `b2cCustomers`, `shops` — _3× getCountFromServer over products/orders/b2cCustomers (PlatformShopDetail.jsx:74-77)._
- `src/pages/platform/PlatformShops.jsx` — getDocs :36; query :45; getCountFromServer :44; updateDoc :76 — **collections:** `shops`, `products`, `orders`, `b2cCustomers` — _N+1 aggregate: for EVERY shop, 3× getCountFromServer over products/orders/b2cCustomers (PlatformShops.jsx:41-45)._
- `src/pages/platform/PlatformUsers.jsx` — getDocs :33; query :33; httpsCallable :64,214 — **collections:** `users` — **callables:** `deletePlatformUser`:64, `createPlatformSuperAdmin`:214
- `src/pages/platform/shopCells.jsx` — httpsCallable :106 — **callables:** `setShopCommission`:106

</details>

### 1.3 storefront (37 files)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `components/AffiliateMarketingMaterials.jsx` | 285 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/AffiliatePortalCampaigns.jsx` | 475 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/AffiliateTracker.jsx` | 124 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/shop/DynamicRouteHandler.jsx` | 113 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/shop/OrderWithdrawal.jsx` | 199 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/shop/ProductReviews.jsx` | 190 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/shop/ShopFooter.jsx` | 347 | FS | 0 | 2/2 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/shop/ShopGate.jsx` | 127 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `components/shop/ShopNavigation.jsx` | 377 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/AffiliateAnalyticsTab.jsx` | 433 | FS | 0 | 4/4 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `pages/shop/AffiliatePortal.jsx` | 869 | FS | 0 | 1/2 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/AffiliateRegistration.jsx` | 415 | FS+Fn | 0 | 0/0 | 0 | 0 | 0/1/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/AllProductsPage.jsx` | 116 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/B2BCatalog.jsx` | 197 | FS+Fn | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/B2BOrderDetail.jsx` | 192 | FS+Fn | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/B2BOrders.jsx` | 120 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/B2BProfile.jsx` | 127 | FS | 0 | 0/0 | 0 | 0 | 0/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/B2BRegister.jsx` | 255 | FS | 0 | 0/0 | 0 | 0 | 0/1/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/Checkout.jsx` | 1408 | Auth+FS+Fn | 1 | 1/1 | 0 | 0 | 0/1/0/0 | 0/0 | 1 | 0/0/0/0 | 2 | INLINE | MODERATE |
| `pages/shop/CheckoutRecoveryPage.jsx` | 166 | FS+Fn | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/CheckoutUnsubscribePage.jsx` | 88 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/CollectionPage.jsx` | 127 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/CustomerAccount.jsx` | 759 | Auth+FS+Fn | 0 | 4/4 | 0 | 0 | 0/0/1/0 | 0/0 | 1 | 0/0/0/0 | 1 | INLINE | MODERATE |
| `pages/shop/CustomerRegister.jsx` | 432 | Auth+FS+Fn | 0 | 0/0 | 0 | 0 | 0/1/0/0 | 0/0 | 1 | 0/0/0/0 | 1 | INLINE | TRIVIAL |
| `pages/shop/DynamicPage.jsx` | 611 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/EmailVerificationHandler.jsx` | 175 | Auth+Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 1+6cu | INLINE | MODERATE |
| `pages/shop/InfringementReportPage.jsx` | 341 | FS+Fn | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/OrderConfirmation.jsx` | 448 | FS | 0 | 0/0 | 0 | 1 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `pages/shop/ProductCollectionPage.jsx` | 139 | FS | 0 | 2/2 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/PublicProductPage.jsx` | 926 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/PublicStorefront.jsx` | 841 | FS | 0 | 2/2 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/ResetPassword.jsx` | 309 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/ReviewSubmitPage.jsx` | 319 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 2 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/ReviewUnsubscribePage.jsx` | 85 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/TagPage.jsx` | 127 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/VerifyEmailPage.jsx` | 128 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/shop/WithdrawalPage.jsx` | 239 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/components/AffiliateMarketingMaterials.jsx` — getDocs :34; query :33 — **collections:** `marketingMaterials`
- `src/components/AffiliatePortalCampaigns.jsx` — getDocs :78; query :71 — **collections:** `orders`
- `src/components/AffiliateTracker.jsx` — httpsCallable :91 — **callables:** `logAffiliateClickV2`:91
- `src/components/shop/DynamicRouteHandler.jsx` — getDocs :77; query :70 — **collections:** `pages`
- `src/components/shop/OrderWithdrawal.jsx` — httpsCallable :48 — **callables:** `submitWithdrawal`:48
- `src/components/shop/ProductReviews.jsx` — getDocs :69; query :68 — **collections:** `productReviews`
- `src/components/shop/ShopFooter.jsx` — getDocs :48,87; query :48,81 — **collections:** `pages`, `affiliates`
- `src/components/shop/ShopGate.jsx` — getDoc :42 — **collections:** `shops`
- `src/components/shop/ShopNavigation.jsx` — getDocs :73; query :72 — **collections:** `affiliates`
- `src/pages/shop/AffiliateAnalyticsTab.jsx` — getDocs :62,88,100,111; query :57,80,93,104 — **collections:** `affiliateClicks`, `orders`
- `src/pages/shop/AffiliatePortal.jsx` — getDocs :189; query :183,186 — **collections:** `affiliates`
- `src/pages/shop/AffiliateRegistration.jsx` — addDoc :65; httpsCallable :76 — **collections:** `affiliateApplications` — **callables:** `sendAffiliateApplicationEmails`:76
- `src/pages/shop/AllProductsPage.jsx` — getDocs :36; query :36 — **collections:** `productsPublic`
- `src/pages/shop/B2BCatalog.jsx` — getDocs :46; query :46; httpsCallable :85 — **collections:** `products` — **callables:** `createB2BOrder`:85 — _Behind `b2b` add-on flag (App.jsx:397); reads raw `products`._
- `src/pages/shop/B2BOrderDetail.jsx` — getDoc :52; httpsCallable :80 — **collections:** `orders` — **callables:** `cancelB2BOrder`:80
- `src/pages/shop/B2BOrders.jsx` — getDocs :51; query :51 — **collections:** `orders`
- `src/pages/shop/B2BProfile.jsx` — updateDoc :62 — **collections:** `b2bCustomers`
- `src/pages/shop/B2BRegister.jsx` — addDoc :102 — **collections:** `b2bCustomers`
- `src/pages/shop/Checkout.jsx` — getDoc :223; getDocs :283; query :282; addDoc :499; httpsCallable :440; auth :430,456 — **collections:** `b2cCustomers`, `productsPublic` — **callables:** `sendCustomEmailVerification`:440 — _Account creation during checkout: createUserWithEmailAndPassword :430 + sendEmailVerification :456; addDoc b2cCustomers._
- `src/pages/shop/CheckoutRecoveryPage.jsx` — getDoc :65; httpsCallable :43 — **collections:** `productsPublic` — **callables:** `resolveCheckoutRecovery`:43
- `src/pages/shop/CheckoutUnsubscribePage.jsx` — httpsCallable :34 — **callables:** `unsubscribeCheckout`:34
- `src/pages/shop/CollectionPage.jsx` — getDocs :40; query :40 — **collections:** `productsPublic`
- `src/pages/shop/CustomerAccount.jsx` — getDocs :63,86,111,128; query :62,85,104,121; updateDoc :161; httpsCallable :222; auth :204 — **collections:** `b2cCustomers`, `orders` — **callables:** `sendCustomEmailVerification`:222 — _updatePassword(currentUser, …) :204 (needs re-auth semantics server-side)._
- `src/pages/shop/CustomerRegister.jsx` — addDoc :181; httpsCallable :117; auth :134 — **collections:** `b2cCustomers` — **callables:** `sendCustomEmailVerification`:117 — _sendEmailVerification :134 (Firebase-native email verification)._
- `src/pages/shop/DynamicPage.jsx` — getDocs :146; query :139 — **collections:** `pages`
- `src/pages/shop/EmailVerificationHandler.jsx` — httpsCallable :40; auth :65; auth.currentUser :47,48,49,68,69,70 — **callables:** `verifyEmailCode`:40 — _applyActionCode :65 + `auth.currentUser.reload()` :48/:69 (Firebase action-code flow)._
- `src/pages/shop/InfringementReportPage.jsx` — getDoc :68; httpsCallable :101 — **collections:** `productsPublic` — **callables:** `submitInfringementReport`:101
- `src/pages/shop/OrderConfirmation.jsx` — onSnapshot :52 — **collections:** `orders` — _Realtime orders/{orderId} :52 — waits (≤90 s, :47-50) for the Stripe webhook to create the order._
- `src/pages/shop/ProductCollectionPage.jsx` — getDocs :44,45; query :44,45 — **collections:** `collections`, `productsPublic`
- `src/pages/shop/PublicProductPage.jsx` — getDocs :191; query :190 — **collections:** `productsPublic`
- `src/pages/shop/PublicStorefront.jsx` — getDocs :88,124; query :80,124 — **collections:** `productsPublic`, `collections`
- `src/pages/shop/ResetPassword.jsx` — httpsCallable :74 — **callables:** `confirmPasswordResetV2`:74
- `src/pages/shop/ReviewSubmitPage.jsx` — httpsCallable :65,107 — **callables:** `resolveReviewRequest`:65, `submitReview`:107
- `src/pages/shop/ReviewUnsubscribePage.jsx` — httpsCallable :34 — **callables:** `unsubscribeReviews`:34
- `src/pages/shop/TagPage.jsx` — getDocs :38; query :38 — **collections:** `productsPublic`
- `src/pages/shop/VerifyEmailPage.jsx` — httpsCallable :32 — **callables:** `verifyEmailCode`:32
- `src/pages/shop/WithdrawalPage.jsx` — httpsCallable :53 — **callables:** `submitWithdrawal`:53

</details>

### 1.4 print-portal (3 files)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `pages/print/PrintShopArtwork.jsx` | 191 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 2 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/print/PrintShopOrderDetail.jsx` | 308 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 2 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/print/PrintShopQueue.jsx` | 165 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 2 | 0/0/0/0 | 0 | INLINE | TRIVIAL |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/pages/print/PrintShopArtwork.jsx` — httpsCallable :35,66 — **callables:** `getPrintArtworkLibrary`:35, `getPrintArtworkDownload`:66
- `src/pages/print/PrintShopOrderDetail.jsx` — httpsCallable :63,78 — **callables:** `getPrintJob`:63, `setPrintJobStatus`:78
- `src/pages/print/PrintShopQueue.jsx` — httpsCallable :49,64 — **callables:** `getPrintQueue`:49, `getPrintQueueExport`:64

</details>

### 1.5 pod-wagon (5 files)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `wagons/pod-wagon/components/ArtworkLibrary.jsx` | 272 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `wagons/pod-wagon/components/ArtworkUploadModal.jsx` | 440 | Fn+Auth(cfg) | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0+1cu | INLINE | TRIVIAL |
| `wagons/pod-wagon/components/ProductMapping.jsx` | 273 | FS | 0 | 0/0 | 0 | 0 | 0/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `wagons/pod-wagon/studio/DesignStudio.jsx` | 1962 | FS+Stor | 1 | 2/2 | 0 | 0 | 0/1/1/0 | 0/0 | 0 | 1/1/0/0 | 0 | INLINE | MODERATE |
| `wagons/pod-wagon/studio/mockupUpload.js` | 23 | Stor | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 1/1/0/0 | 0 | ABSTRACTION | TRIVIAL |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/wagons/pod-wagon/components/ArtworkLibrary.jsx` — httpsCallable :48 — **callables:** `processPodArtwork`:48
- `src/wagons/pod-wagon/components/ArtworkUploadModal.jsx` — httpsCallable :154; auth.currentUser :194 — **callables:** `processPodArtwork`:154 — _`auth.currentUser?.uid` :194 as createdBy; upload goes through utils/podUpload.js + utils/podArtwork.js._
- `src/wagons/pod-wagon/components/ProductMapping.jsx` — updateDoc :120 — **collections:** `products`
- `src/wagons/pod-wagon/studio/DesignStudio.jsx` — getDoc :1046; getDocs :802,1056; query :802,1056; addDoc :986; updateDoc :1220; uploadBytes :730; getDownloadURL :731 — **collections:** `products` — **storage refs:** ``${path}/${name}``:730 — _Inline uploadBytes :730 to products/{shopId}/{productId}/… (publicPath :819/:1091); inline product addDoc/updateDoc; the rest goes through podMappings/podProfiles/podMockupTemplates/printRouting/podCostQuote/pod3dModels/loadContentScreening/mockupUpload._
- `src/wagons/pod-wagon/studio/mockupUpload.js` — uploadBytes :19; getDownloadURL :20 — **storage refs:** `storagePath`:19

</details>

### 1.6 crm-wagons (15 files)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `wagons/ambassador-wagon/hooks/useAmbassadorActivities.js` | 296 | FS | 0 | 0/2 | 0 | 1 | 0/1/2/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `wagons/ambassador-wagon/hooks/useAmbassadorContacts.js` | 345 | FS | 0 | 0/1 | 0 | 1 | 0/1/2/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `wagons/campaign-wagon/components/CampaignCreate.jsx` | 682 | FS | 0 | 2/2 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `wagons/campaign-wagon/components/CampaignEdit.jsx` | 942 | FS | 0 | 2/2 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `wagons/campaign-wagon/hooks/useCampaigns.js` | 361 | FS | 1 | 1/2 | 0 | 1 | 0/1/1/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `wagons/dining-wagon/components/ActivityCenter.jsx` | 596 | FS | 0 | 0/0 | 0 | 0 | 0/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `wagons/dining-wagon/components/ContactDetail.jsx` | 2598 | FS | 0 | 0/0 | 0 | 0 | 0/1/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `wagons/dining-wagon/components/DiningDashboard.jsx` | 899 | FS | 0 | 0/1 | 0 | 1 | 0/1/0/2 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `wagons/dining-wagon/components/DocumentCenter.jsx` | 410 | FS+Stor | 0 | 0/1 | 0 | 1 | 0/1/0/1 | 0/0 | 0 | 1/1/1/0 | 0 | INLINE | HEAVY |
| `wagons/dining-wagon/components/FollowUpCenter.jsx` | 706 | FS | 0 | 0/4 | 0 | 1 | 0/1/1/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `wagons/dining-wagon/hooks/useDiningActivities.js` | 287 | FS | 0 | 0/2 | 0 | 1 | 0/1/1/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `wagons/dining-wagon/hooks/useDiningContacts.js` | 363 | FS | 0 | 0/2 | 0 | 1 | 0/1/2/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `wagons/dining-wagon/hooks/useMentionNotifications.js` | 105 | FS | 0 | 0/1 | 0 | 1 | 0/0/2/1 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | HEAVY |
| `wagons/dining-wagon/utils/customerStatusAutomation.js` | 286 | FS | 0 | 3/3 | 0 | 0 | 0/0/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | MODERATE |
| `wagons/dining-wagon/utils/mentionUtils.js` | 42 | FS | 0 | 0/0 | 0 | 0 | 0/1/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/wagons/ambassador-wagon/hooks/useAmbassadorActivities.js` — query :80,87; onSnapshot :94; addDoc :173; updateDoc :177,211; deleteDoc :225 — **collections:** `ambassadorActivities`, `ambassadorContacts`
- `src/wagons/ambassador-wagon/hooks/useAmbassadorContacts.js` — query :34; onSnapshot :36; addDoc :188; updateDoc :233,279; deleteDoc :252 — **collections:** `affiliates`
- `src/wagons/campaign-wagon/components/CampaignCreate.jsx` — getDocs :54,71; query :53,70 — **collections:** `affiliates`, `products`
- `src/wagons/campaign-wagon/components/CampaignEdit.jsx` — getDocs :86,103; query :85,102 — **collections:** `affiliates`, `products`
- `src/wagons/campaign-wagon/hooks/useCampaigns.js` — getDoc :212; getDocs :113; query :39,108; onSnapshot :41; addDoc :129; updateDoc :153; deleteDoc :180 — **collections:** `campaigns`
- `src/wagons/dining-wagon/components/ActivityCenter.jsx` — updateDoc :246 — **collections:** `activities`
- `src/wagons/dining-wagon/components/ContactDetail.jsx` — addDoc :778; updateDoc :541 — **collections:** `userMentions`, `activities`
- `src/wagons/dining-wagon/components/DiningDashboard.jsx` — query :52; onSnapshot :54; addDoc :345; deleteDoc :377,455 — **collections:** `deferredActivities`
- `src/wagons/dining-wagon/components/DocumentCenter.jsx` — query :49; onSnapshot :54; addDoc :119; deleteDoc :176; uploadBytes :102; getDownloadURL :103; deleteObject :173 — **collections:** `customerDocuments` — **storage refs:** `filePath`:101; `document.storagePath`:172 — _Realtime customerDocuments + upload to marketing-materials/{shopId}/customers/{contactId}/crm-documents/ :98-102._
- `src/wagons/dining-wagon/components/FollowUpCenter.jsx` — query :63,74,85,92; onSnapshot :98; addDoc :152; updateDoc :180; deleteDoc :200 — **collections:** `followUps`
- `src/wagons/dining-wagon/hooks/useDiningActivities.js` — query :66,73; onSnapshot :80; addDoc :113; updateDoc :133; deleteDoc :155 — **collections:** `activities`
- `src/wagons/dining-wagon/hooks/useDiningContacts.js` — query :42,43; onSnapshot :45; addDoc :150; updateDoc :181,210; deleteDoc :228 — **collections:** `users`
- `src/wagons/dining-wagon/hooks/useMentionNotifications.js` — query :33; onSnapshot :39; updateDoc :63,86; deleteDoc :75 — **collections:** `userMentions`
- `src/wagons/dining-wagon/utils/customerStatusAutomation.js` — getDocs :99,128,231; query :93,120,226; updateDoc :170 — **collections:** `orders`, `activities`, `users`
- `src/wagons/dining-wagon/utils/mentionUtils.js` — addDoc :23 — **collections:** `userMentions`

</details>

### 1.7 shared-context (6 files)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `contexts/AuthContext.jsx` | 847 | Auth+FS+Fn | 4 | 1/1 | 0 | 0 | 1/0/5/0 | 0/0 | 4 | 0/0/0/0 | 6 | CONTEXT | HEAVY |
| `contexts/B2BCustomerContext.jsx` | 69 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | CONTEXT | TRIVIAL |
| `contexts/CartContext.jsx` | 762 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | CONTEXT | TRIVIAL |
| `contexts/OrderContext.jsx` | 961 | FS+Fn | 9 | 4/5 | 0 | 0 | 0/0/2/1 | 0/0 | 2 | 0/0/0/0 | 0 | CONTEXT | HEAVY |
| `contexts/SimpleAuthContext.jsx` | 163 | Auth+FS+Fn | 0 | 1/1 | 0 | 0 | 0/0/1/0 | 0/0 | 1 | 0/0/0/0 | 4 | CONTEXT | HEAVY |
| `contexts/TranslationContext.jsx` | 250 | FS | 0 | 1/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | CONTEXT | TRIVIAL |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/contexts/AuthContext.jsx` — getDoc :119,185,441,670; getDocs :383; query :382; setDoc :616; updateDoc :276,337,456,516,549; httpsCallable :244,678,745,791; auth :112,182,187,223,275,301 — **collections:** `users` — **callables:** `sendPasswordResetEmail`:244, `sendLoginCredentialsEmail`:678, `deleteCustomerAccountV2`:745, `toggleCustomerActiveStatusV2`:791 — _Owns admin/platform/print auth state: onAuthStateChanged :112, signInWithEmailAndPassword :182, signOut :187/:223, updateEmail :275, updatePassword (aliased `firebaseUpdatePassword`) :301. Creates a users doc with a CLIENT-minted auto-id `doc(collection(db,'users')).id` :592 then setDoc :616. 46 files import it; consumers read `currentUser.uid` (65 sites repo-wide), `.email` (23), `.displayName` (9) — the session object must keep that shape._
- `src/contexts/B2BCustomerContext.jsx` — getDocs :38; query :38 — **collections:** `b2bCustomers`
- `src/contexts/CartContext.jsx` — httpsCallable :452 — **callables:** `validateDiscountCode`:452
- `src/contexts/OrderContext.jsx` — getDoc :163,458,534,541,719,791,832,836,843; getDocs :263,329,385,666; query :256,312,320,379,666; updateDoc :477,818; deleteDoc :726; httpsCallable :566,858 — **collections:** `orders`, `users`, `b2cCustomers` — **callables:** `sendOrderStatusUpdateEmail`:566, `sendOrderStatusUpdateEmail`:858 — _Order read/write hub; also imports `functionUrl` (OrderContext.jsx:19) but never calls it._
- `src/contexts/SimpleAuthContext.jsx` — getDocs :43; query :37; updateDoc :47; httpsCallable :125; auth :61,78,92,106 — **collections:** `b2cCustomers` — **callables:** `sendPasswordResetEmail`:125 — _Second auth context (storefront customers, `b2cCustomers`): onAuthStateChanged :61, signIn :78, signOut :92, createUserWithEmailAndPassword :106. NOTE :125 declares a local `sendPasswordResetEmail` = httpsCallable that shadows the auth import — :127 is the callable (counted as callable, not auth)._
- `src/contexts/TranslationContext.jsx` — getDocs :82 — **collections:** `translations_{lang}` — _Reads whole collection `translations_{lang}` (dynamic name, TranslationContext.jsx:79-82)._

</details>

### 1.8 util/config (23 files)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `config/impersonationAudit.js` | 55 | FS | 0 | 0/0 | 0 | 0 | 0/1/1/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `config/pod3dModels.js` | 81 | FS | 0 | 1/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `config/podCostQuote.js` | 63 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `config/podMockupTemplates.js` | 201 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `config/podProfiles.js` | 65 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `config/printRouting.js` | 85 | FS | 1 | 1/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `config/shopConfig.js` | 174 | FS | 4 | 0/0 | 0 | 0 | 3/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | MODERATE |
| `utils/adminDocuments.js` | 227 | FS+Stor | 1 | 1/1 | 0 | 0 | 0/1/1/1 | 0/0 | 0 | 1/1/1/0 | 0 | ABSTRACTION | MODERATE |
| `utils/adminUIDManager.js` | 222 | FS | 1 | 1/1 | 0 | 0 | 1/0/0/1 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | MODERATE |
| `utils/affiliateCalculations.js` | 216 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `utils/affiliatePayouts.js` | 277 | FS+Stor | 1 | 3/3 | 0 | 0 | 0/0/0/0 | 0/1 | 0 | 1/1/0/0 | 0 | ABSTRACTION | HEAVY |
| `utils/credentialTranslations.js` | 125 | FS | 0 | 1/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `utils/fileUpload.js` | 121 | Stor | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 1/1/1/0 | 0 | ABSTRACTION | MODERATE |
| `utils/imageUpload.js` | 111 | Stor | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 2/2/0/0 | 0 | ABSTRACTION | MODERATE |
| `utils/legalAcceptance.js` | 159 | FS | 0 | 0/0 | 0 | 0 | 2/2/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | MODERATE |
| `utils/loadContentScreening.js` | 20 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `utils/marketingMaterials.js` | 392 | FS+Stor | 4 | 3/3 | 0 | 0 | 0/3/2/2 | 0/0 | 0 | 2/2/2/0 | 0 | ABSTRACTION | HEAVY |
| `utils/pod3dUpload.js` | 308 | Stor | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 6/3/1/1 | 0 | ABSTRACTION | HEAVY |
| `utils/podArtwork.js` | 135 | FS+Stor | 1 | 2/2 | 0 | 0 | 0/1/1/1 | 0/0 | 0 | 0/0/2/0 | 0 | ABSTRACTION | MODERATE |
| `utils/podMappings.js` | 164 | FS | 0 | 3/3 | 0 | 0 | 0/1/1/1 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | MODERATE |
| `utils/podUpload.js` | 93 | Stor | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 1/1/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `utils/productFeed.js` | 105 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |
| `utils/translationDetection.js` | 242 | FS | 0 | 1/1 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | ABSTRACTION | TRIVIAL |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/config/impersonationAudit.js` — addDoc :29; updateDoc :50 — **collections:** `impersonationAudit`
- `src/config/pod3dModels.js` — getDocs :60 — **collections:** `pod3dModels`
- `src/config/podCostQuote.js` — httpsCallable :38 — **callables:** `quotePodCost`:38
- `src/config/podMockupTemplates.js` — getDoc :98 — **collections:** `settings/podMockupTemplates`
- `src/config/podProfiles.js` — getDoc :31 — **collections:** `settings/podProfiles`
- `src/config/printRouting.js` — getDoc :50; getDocs :50 — **collections:** `printersPublic`, `settings/printRouting`
- `src/config/shopConfig.js` — getDoc :32,50,112,150; setDoc :89,130,167 — **collections:** `shops`, `settings/app` — _Tenant config seam: shops/{shopId} with legacy fallback to settings/app (shopConfig.js:21-22). 8 importers incl. StoreSettingsContext + ShopFeaturesContext (which are therefore already shielded)._
- `src/utils/adminDocuments.js` — getDoc :180; getDocs :144; query :137; addDoc :121; updateDoc :165; deleteDoc :192; uploadBytes :97; getDownloadURL :98; deleteObject :188 — **collections:** `adminCustomerDocuments` — **storage refs:** ``admin-documents/${resolvedShopId}/customers/${customerId}/${Date.now()}_${file.name}``:96; `docData.storagePath`:187
- `src/utils/adminUIDManager.js` — getDoc :103; getDocs :127; query :122; setDoc :69; deleteDoc :87 — **collections:** `adminUIDs`
- `src/utils/affiliateCalculations.js` — getDocs :158; query :157 — **collections:** `affiliates` — _Firebase only via DYNAMIC import inside validateCustomAffiliateCode (:123-124); rest of module is pure._
- `src/utils/affiliatePayouts.js` — getDoc :81; getDocs :74,171,202; query :73,165,196; runTransaction :90; uploadBytes :53; getDownloadURL :54 — **collections:** `orders`, `affiliatePayouts`, `affiliates` — **storage refs:** ``affiliates/${resolvedShopId}/${affiliateId}/invoices/${fileName}``:50 — _runTransaction :90 over affiliates/{id} + new affiliatePayouts doc; invoice PDF upload :53._
- `src/utils/credentialTranslations.js` — getDocs :64 — **collections:** `translations_{lang}` — _Reads whole collection `translations_{lang}` (dynamic name, :62-64)._
- `src/utils/fileUpload.js` — uploadBytes :70; getDownloadURL :73; deleteObject :99 — **storage refs:** `storagePath`:67; `storagePath`:98
- `src/utils/imageUpload.js` — uploadBytes :83,107; getDownloadURL :84,107 — **storage refs:** ``${pathPrefix}/${fileName}``:81; ``branding/${shopId}/favicon_${timestamp}_${file.name}``:106
- `src/utils/legalAcceptance.js` — setDoc :108,156; addDoc :88,138 — **collections:** `shops/{id}/legalAcceptances`, `shops`
- `src/utils/loadContentScreening.js` — getDoc :13 — **collections:** `settings/contentScreening`
- `src/utils/marketingMaterials.js` — getDoc :154,187,279,312; getDocs :134,259,335; query :129,255,335; addDoc :113,236,363; updateDoc :173,298; deleteDoc :199,324; uploadBytes :95,218; getDownloadURL :96,219; deleteObject :195,320 — **collections:** `marketingMaterials`, `users/{id}/marketingMaterials`, `products` — **storage refs:** ``marketing-materials/${resolvedShopId}/generic/${Date.now()}_${file.name}``:94; `materialData.storagePath`:194; ``marketing-materials/${resolvedShopId}/customers/${customerId}/${Date.now()}_${file.name}``:217; `materialData.storagePath`:319
- `src/utils/pod3dUpload.js` — uploadBytes :218,219,224,246,247,263; getDownloadURL :248,249,264; deleteObject :298; listAll :296 — **storage refs:** `photoOrigPath`:218; `mapOrigPath`:219; `maskOrigPath`:224; `photoDerivPath`:246; `mapDerivPath`:247; `maskDerivPath`:263; `prefix`:296 — _Client-side derivative pipeline: 6 uploadBytes (originals + 1600px derivatives) :218-263; recursive listAll+deleteObject prefix delete :290-298._
- `src/utils/podArtwork.js` — getDoc :39; getDocs :33,53; query :28,48; addDoc :19; updateDoc :76; deleteDoc :133; deleteObject :92,127 — **collections:** `podArtwork`, `podMappings` — **storage refs:** `oldPath`:92; `path`:127
- `src/utils/podMappings.js` — getDocs :21,39,113; query :20,34,113; addDoc :86; updateDoc :83; deleteDoc :92 — **collections:** `podMappings`, `products`
- `src/utils/podUpload.js` — uploadBytes :81; getDownloadURL :82 — **storage refs:** `originalStoragePath`:81
- `src/utils/productFeed.js` — getDocs :7; query :7 — **collections:** `productsPublic`
- `src/utils/translationDetection.js` — getDocs :37; query :36 — **collections:** `translations_{lang}` — _Probe `translations_{lang}` limit(1) (dynamic name, :32-35)._

</details>

### 1.9 public (non-shop) (2 files)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `pages/HandoffPage.jsx` | 212 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |
| `pages/LandingPage.jsx` | 551 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 1 | 0/0/0/0 | 0 | INLINE | TRIVIAL |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/pages/HandoffPage.jsx` — httpsCallable :100 — **callables:** `getHandoffPackage`:100
- `src/pages/LandingPage.jsx` — httpsCallable :206 — **callables:** `submitLead`:206

</details>

### 1.10 app-shell (1 file)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `App.jsx` | 744 | Fn | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL (delete) |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/App.jsx` — no call sites — _Imports `functions` (App.jsx:14) + `httpsCallable` (App.jsx:15) but never calls them — dead imports, delete._

</details>

### 1.11 sdk-init (1 file)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `firebase/config.js` | 100 | Auth+FS+Fn+Stor | 0 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | SDK-INIT | n/a (replace) |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/firebase/config.js` — no call sites — _SDK init: named Firestore DB `b8s-reseller-db` (config.js:31), functions region us-central1 (:33), emulator wiring (:58-89), `getDirectStorageUrl` export (:92) has 0 callers. Becomes the API-client module._

</details>

### 1.12 DEAD (1 file)

| File | LOC | SDK | gD | gDs/q | cnt | RT | W (s/a/u/d) | B/T | Fn | Stor (up/url/del/ls) | Auth | Pattern | Effort |
|---|---:|---|---:|---|---:|---:|---|---|---:|---|---|---|---|
| `components/PrivateRoute.jsx` | 54 | FS | 1 | 0/0 | 0 | 0 | 0/0/0/0 | 0/0 | 0 | 0/0/0/0 | 0 | INLINE | TRIVIAL (delete) |

<details><summary>Evidence (line numbers, collections, callables, storage refs)</summary>

- `src/components/PrivateRoute.jsx` — getDoc :22 — **collections:** `users` — _DEAD FILE — 0 importers; App.jsx:27 imports `components/auth/PrivateRoute` (no Firebase). Delete, do not port._

</details>

## 2. Test surface that goes away or needs porting

### 2.1 `src/dev/*` harnesses (tracked; loaded by root `*-harness.html` via the Vite dev server, not part of the app build)

- `src/dev/studioHarness.jsx` — Design Studio canvas/colourway/mockup harness with fixtures (1075 LOC); imports `DesignStudio` + `config/podMockupTemplates|podProfiles|printRouting|podCostQuote` → keep, but re-point those wrappers at a mock API client.
- `src/dev/podMappingHarness.jsx` — Renders real `ProductMapping` (imports firebase/config transitively, updateDoc on `products`) with fixture data → needs the API-client mock.
- `src/dev/platformModelsHarness.jsx` — Real `ModelCardGrid` + `ModelEditor` (ModelEditor updateDoc `pod3dModels`, pod3dUpload) with injected handlers → needs API-client mock.
- `src/dev/platformReportsHarness.jsx` — Real `PlatformLayout` (getCountFromServer) + `PlatformReports` → needs API-client mock.
- `src/dev/platformPrintersHarness.jsx` — Presentational `PrinterRow` + `config/podGarments` only — no Firebase path; survives as-is.
- `src/dev/orderPaymentHarness.jsx` — Presentational `OrderPaymentCard` with fixture orders — no Firebase path; survives as-is.
- `src/dev/shopPickerHarness.jsx` — Self-contained visual copy of ShopPicker (only heroicons) — survives; real ShopPicker reads `shops` directly.
- `src/dev/colorwayStripHarness.jsx` — Real `ColorwayStrip` only — no Firebase; survives.
- `src/dev/flatsHarness.jsx` — Garment flats + seed print areas (`studio/garments`) — no Firebase; survives.
- `src/dev/parallaxHarness.jsx + src/dev/parallax/parallaxScene.js` — Pixi displacement/parallax experiment — no Firebase; survives.
- `src/dev/sport-template-directions/*.html (6 files)` — Static design-direction HTML previews — no Firebase; unaffected.

### 2.2 `rules-tests/*` (CI gate `rules-tests/run-all.sh`)

Kinds: **EMU** = Firestore/Storage emulator security-rules test (`initializeTestEnvironment`) — the rules layer disappears in the port, so these must be rewritten as Worker authorization tests. **FNLIB** = pure unit tests over compiled `functions/lib/**` — port with the logic they cover. **SRC** = pure tests over client `src/` modules — survive.

- `rules-tests/README.md` — Docs for the Firestore rules tests. **[—]**
- `rules-tests/run-all.sh` — Runs every suite; fails on first red. Needs rewiring to the Worker test runner. **[—]**
- `rules-tests/firestore-rules.test.cjs` — Phase-3 tenant isolation both ways (legit access works, cross-shop denied). **[EMU → Worker authz tests]**
- `rules-tests/firestore-isolation.test.cjs` — Phase-A isolation hardening (cross-shop leaks from the 2026-06-17 audit), 662 LOC. **[EMU → Worker authz tests]**
- `rules-tests/storage-isolation.test.cjs` — shopId-partitioned `storage.rules` both ways. **[EMU → R2 access-policy tests]**
- `rules-tests/infringement-screening.test.cjs` — Rules for `infringementReports` PII (platform-only) + brand screening. **[EMU → Worker authz tests]**
- `rules-tests/one-number.test.cjs` — Rules: `printers/{uid}` price tiers platform-only read (A13). **[EMU → Worker projection tests]**
- `rules-tests/functions-isolation.test.cjs` — Functions-layer tenant isolation (Admin SDK bypasses rules) over functions/lib. **[FNLIB (+firebase-admin)]**
- `rules-tests/checkout-invariants.test.cjs` — P0-03 checkout invariants over compiled functions bundle. **[FNLIB]**
- `rules-tests/connect-params.test.cjs` — Exact Stripe Connect charge/refund params (`functions/lib/payment/connectParams`). **[FNLIB]**
- `rules-tests/dispute-recovery.test.cjs` — Dispute reversal / re-transfer Stripe params. **[FNLIB]**
- `rules-tests/dac7-aggregation.test.cjs` — DAC7 per-seller-year aggregation math (`functions/lib/dac7/aggregate`). **[FNLIB]**
- `rules-tests/production-withholding.test.cjs` — POD production-cost withholding in the Connect fee. **[FNLIB (+firebase-admin)]**
- `rules-tests/production-snapshot.test.cjs` — P1-16 immutable production snapshot with fake Firestore. **[FNLIB (+firebase-admin)]**
- `rules-tests/print-outbox.test.cjs` — Print-notify outbox decision core. **[FNLIB]**
- `rules-tests/print-line-visibility.test.cjs` — Who prints each line / cost / visibility. **[FNLIB (+firebase-admin)]**
- `rules-tests/pod-shop-gating.test.cjs` — Per-shop POD gating predicate in functions, both polarities. **[FNLIB (+firebase-admin)]**
- `rules-tests/pod-shop-gating-pure.test.cjs` — Pure pod-gating decision shapes. **[FNLIB]**
- `rules-tests/one-number-pure.test.cjs` — A13 "seller sees ONE number" pure half. **[FNLIB (+firebase-admin)]**
- `rules-tests/projection.test.cjs` — Public catalogue projection (`productsPublic`) contract. **[FNLIB]**
- `rules-tests/wave2-invariants.test.cjs` — SSRF guards etc. (wave-2 audit). **[FNLIB (+firebase-admin)]**
- `rules-tests/content-screening-parity.test.cjs` — Brand-screening matcher: client `src/utils/contentScreening.js` vs server lib parity. **[FNLIB + SRC]**
- `rules-tests/print-routing-parity.test.cjs` — Print-routing resolver client (`src/wagons/pod-wagon/printRouting.js`) vs server parity. **[FNLIB + SRC]**
- `rules-tests/audit-2026-09-26.test.mjs` — CODEX 2026-09-26 client-side fixes (printerTierForm, printerAreas, shopPayout, printRouting). **[SRC + FNLIB]**
- `rules-tests/printer-areas.test.mjs` — `applyPrinterAreas` (`src/config/printerAreas.js`). **[SRC — survives]**
- `rules-tests/withdrawal-gate.test.mjs` — Right-of-withdrawal gate helpers (`src/utils/withdrawal.js`). **[SRC — survives]**

## 3. Method and caveats

- File set: `grep -rlE` over `src/` for `from 'firebase/(firestore|auth|storage|functions)'`, `firebase/config['"]` (any relative depth, with or without `.js`) and `import('…firebase…')` → 144 files.
- Counting: per file, named imports from the four SDK packages and from `firebase/config` were parsed (aliases resolved), block and line comments stripped, import statements blanked (line numbers preserved), then each local name was matched as a call `name(` not preceded by `.`/identifier chars. Cross-checked against a naive grep: the only differences were names mentioned inside comments (AuthContext.jsx:370, AdminSettings.jsx:217, AdminStorefront.jsx:32, podUpload.js:5), which are correctly excluded.
- Manual correction: `src/contexts/SimpleAuthContext.jsx:127` calls a local `sendPasswordResetEmail` that is an httpsCallable (declared :125), not the auth SDK function — excluded from auth counts.
- `query()` counts query-builder calls; `getDocs` counts executions. They need not match: `getDocs(collection(...))` reads a whole collection with no `query()` (e.g. PlatformPrinters.jsx:89/91, PlatformAddons.jsx:25), a `query()` may feed `onSnapshot`/`getCountFromServer`, or be built on alternative branches (e.g. AffiliatePortal.jsx:183/186 → one `getDocs` :189).
- `httpsCallable` counts creation sites (each is one invocation in practice). Callable names were extracted from the second argument; AdminPayments.jsx uses a dynamic `call(name)` helper resolved by hand.
- Collections were extracted from `collection(db, …)` / `doc(db, …)` string-literal segments; identifier segments are shown as `{id}`; dynamic names resolved by hand (`translations_{lang}`, PlatformShops/PlatformShopDetail `{col}` ∈ products|orders|b2cCustomers).
- Reachability: import graph walked from `src/main.jsx` including `import.meta.glob` in WagonRegistry.js; only `src/components/PrivateRoute.jsx` is unreachable.
- Not counted as SDK touchpoints (but listed in §0.7/§0.8): `fetch(functionUrl(...))` HTTP functions, Timestamp shape usage, stored Firebase download URLs.

