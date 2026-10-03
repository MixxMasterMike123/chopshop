# CP5 gap analysis (+ CP6 frontend): the admin, the platform console, the auth shell and the POD wagon on Cloudflare

Read-only analysis on `cf-port` at HEAD `2c154012`. Every claim below cites `path:line` and was checked by grep or read. Where something is unsure, the text says so and names the file to read.

## 0. Facts to know before the briefs

| # | Fact | Evidence |
|---|---|---|
| 0.1 | **Another builder is working in the tree right now.** This is the CP4-D2 preview of an unpublished shop (D57). Its changes are uncommitted: it edits `src/app.ts`, `catalog/{collections,public-catalog}.ts`, `content/pages.ts`, `routes/{pod-storefront,public-collections,public-legal,public-pages,public-products,public-seo}.ts` and `storefront/{identity-projection,public-routes,public-shop,public-storefront,seo}.ts`, and adds `routes/admin-preview.ts` and `storefront/preview.ts`. **No CP5 Worker unit may start until D2 is committed, and none may own those files.** Line numbers in `app.ts` move while it works (`handleAdminPodRoute` was at :1522 and later at :1525), so this document cites `app.ts` routes by their constant names. | `git status --short`; `cloudflare/src/storefront/preview.ts:7-23` |
| 0.2 | The highest migration is `0045_order_recipients.sql`, so **the next free number is 0046**. D2 states it adds no migration. `0020` is never used. | `ls cloudflare/migrations`; `preview.ts:20-21`; `CP4_BRIEFS.md:15` |
| 0.3 | There is no admin or platform design baseline (BP-1). Mikael must hand off a logged-in session before the admin set can be diffed. The Firebase admin is frozen and the new admin is a separate build, so the baseline can still be shot from production Firebase. | `DESIGN_CONTRACT.md:415,465-476` |
| 0.4 | The client inventory misses the pages that reach Firebase only through a context. `AdminOrders.jsx` (through `OrderContext`, :2,46) and `AdminUsers.jsx` (through `AuthContext`, :3,20) are absent from INVENTORY §1.1. Their real operations are `OrderContext.jsx:350` (`getAllOrders`), `:413` (`updateOrderStatus`), `:566/:858` (the status email callable), `:702` (`deleteOrder`) and `AuthContext.jsx:382` (`getAllUsers`). | grep |
| 0.5 | The inventory also flags two files as Firebase that are not. `config/printerAreas.js` and `wagons/pod-wagon/studio/TemplateBackground.jsx` only mention Firebase in comments (`printerAreas.js:2-3`, `TemplateBackground.jsx:40`). | grep |
| 0.6 | The admin answers 404 for everything it refuses: an expired session, a foreign shop and an unknown id all look the same. The client therefore needs a separate "who am I" read to tell "signed out" from "not found". | `request-authorization.ts:89-91` |

---

## 1. Launch-scope files and the files that leave the build

### 1a. Launch scope

| Area | Files | CP | Reference |
|---|---|---|---|
| Auth shell | `pages/LoginPage.jsx`, `pages/ForgotPasswordPage.jsx`, a NEW reset-password page, `components/auth/{AdminRoute,PlatformRoute,AdminShopIdIntake,ImpersonationBanner}.jsx`, `components/platform/ImpersonateShopModal.jsx` (becomes the acting-as dialog), `components/layout/AppLayout.jsx`, `components/platform/PlatformLayout.jsx`, `components/admin/ShopPicker.jsx`, `components/admin/PlatformTermsGate.jsx`, `pages/admin/AdminPlatformTerms.jsx`, `components/DarkModeToggle.jsx`, `LanguageSwitcher.jsx`, `components/admin/ui/*` | CP5 | PLAN §2.1; DESIGN_CONTRACT:498-512 |
| Contexts and config, each replaced by a provider in the new build | `contexts/AuthContext.jsx`, `ShopContext.jsx`, `ShopFeaturesContext.jsx`, `StoreSettingsContext.jsx`, `TranslationContext.jsx`, `OrderContext.jsx`; `config/{shopConfig,activeShop,impersonation,urls,tenancy,withShopId}.js`; `utils/credentialTranslations.js`, `utils/legalAcceptance.js` | CP5 | INVENTORY §1.7, §1.8 |
| Admin pages | `AdminDashboard`, `AdminProducts`, `components/admin/{ProductForm,ProductImages}.jsx`, `AdminOrders`, `AdminOrderDetail`, `components/admin/OrderPaymentCard.jsx`, `components/OrderStatusMenu.jsx`, `AdminCollections`, `AdminCollectionEdit`, `AdminMenu`, `AdminPages`, `AdminPageEdit`, `AdminStorefront`, `AdminSettings` + `components/admin/PickupLocationsEditor.jsx`, `AdminPayments`, `AdminUsers` | CP5 | PLAN §10 CP5; DESIGN_CONTRACT:500-511 |
| Platform pages | `PlatformShops`, `shopCells`, `PlatformShopDetail`, `components/platform/{ProvisionShopModal,AddShopUserModal,PrinterRow,printerTierForm}`, `PlatformAddons`, `PlatformUsers`, `PlatformPrinters`, `PlatformReports` | CP3b, now CP5 | D50; DESIGN_CONTRACT:526-532 |
| New platform pages (no old page exists) | platform settings, screening terms, terms versions, forwards (`/v1/admin/redirects`) | CP5, nice-to-have | `PlatformLayout.jsx:39-40` ("Inställningar" is `live:false`); CP4_D_REPORT:169 |
| POD wagon | `wagons/pod-wagon/components/{PodAdminPage,ArtworkLibrary,ArtworkUploadModal,ProductMapping,PodProductPicker,usePodLibrary,podTier}`, `podPricing.js`, `printRouting.js`; `utils/{podArtwork,podMappings,podUpload,podValidation}.js`; `config/{podProfiles,printRouting,podCostQuote,podSlots,podGarments,printerAreas}.js` | CP5 (mappings, D83) | D83; DESIGN_CONTRACT:513 |
| Studio, 3D read-only | `studio/{DesignStudio,PublishPanel,MockupPanel,Studio3DSection,CompositorCanvas,ColorwayStrip,ColorSelectionPanel,TemplateBackground,mockupRender,mockupUpload,mockupVariantImages,placementMath,contrastGuard,HelpPopover}`, `studio/pixi/*`, `studio/garments/*`; `config/{podMockupTemplates,pod3dModels}.js` | CP6 | PLAN §10 CP6 |

### 1b. Files that leave the admin build

The new admin build does not import these files, the same way D81 removed storefront pages. The old `src/App.jsx` build is left untouched as the rollback artifact.

| File(s) | Reason |
|---|---|
| `AdminAffiliates`, `AdminAffiliateCreate`, `AdminAffiliateEdit`, `AdminAffiliateAnalytics`, `AdminAffiliatePayout`; `components/{AffiliateTracker,AffiliateMarketingMaterials,AffiliatePortalCampaigns}.jsx`; `utils/{affiliatePayouts,affiliateCalculations}.js` | PORT-LATER (PLAN §3.2, `specs/AFFILIATE.md`) |
| `AdminB2BCustomers`, `AdminB2CCustomers`, `AdminB2CCustomerEdit`, `contexts/B2BCustomerContext.jsx`, `SimpleAuthContext.jsx`, `CartContext.jsx` | PORT-LATER (D11, D81) |
| `AdminContentStudio`, `pages/HandoffPage.jsx` (the content-studio QR hand-off, not impersonation) | PORT-LATER (content studio; DESIGN_CONTRACT:517) |
| `AdminMarketingMaterials` (+Edit), `AdminCustomerMarketingMaterials` (+Edit), `utils/marketingMaterials.js` | PORT-LATER |
| `AdminDiscountCodes` | PORT-LATER; storefront reads it as off (D81) |
| `AdminReviews` | PORT-LATER |
| `AdminMyTaxData`, `PlatformDac7` | PORT-LATER (D23: DAC7 is CP9) |
| `PlatformModels`, `components/platform/{ModelEditor,ModelCardGrid}.jsx`, `utils/pod3dUpload.js` | PORT-LATER ("3D model tooling", PLAN §3.2). The read-only 3D in the studio stays (CP6). |
| `components/platform/{MigrateShopifyModal,MigrateWooModal}.jsx` | PORT-LATER (migrators) |
| `pages/print/*`, `components/auth/PrintShopRoute.jsx` | PORT-LATER (print portal, D12) |
| `wagons/{dining,ambassador,campaign,writers}-wagon/**`, `wagons/WagonRegistry.js`, `wagons/INTEGRATION_EXAMPLE.jsx`, and the `MentionNotifications` import at `AppLayout.jsx:4` | DELETE (D2). POD gets a static route in place of wagon discovery (`App.jsx:681-708`, `AppLayout.jsx:20`). |
| `hooks/useAdminPresence.js`, `components/{AdminPresence,AdminPresenceIndicator}.jsx` | Presence is dropped (PLAN §2.9) |
| `components/auth/ImpersonationIntake.jsx`, `config/impersonationAudit.js`, `utils/adminUIDManager.js` | Replaced by the server-minted, audited acting-as grant (`routes/acting-as.ts:16-34`) |
| `components/PrivateRoute.jsx` | Dead file (INVENTORY §1.12) |
| `pages/shop/EmailVerificationHandler.jsx` (`/__/auth/action`, `App.jsx:280,440`) | A Firebase Auth action with no Cloudflare equivalent |
| `AdminUserCreate`, `AdminUserEdit` | **Decision needed (D100 below).** They are B2B-reseller customer editors: document upload `AdminUserCreate.jsx:133-155`, the `marginal` field `AdminUserEdit.jsx:38`, the customer email callable `:488`. They are not a tool for shop admins. Recommended: they leave, and `AdminUsers` becomes a slim member list. |
| `pages/LandingPage.jsx`, `PlatformLeads` | **Decision needed (D103).** Leads are in neither §3.1 nor §3.2 (DESIGN_CONTRACT:537). Recommended: they leave; the admin root `/` redirects to `/login`. |
| `components/admin/{FileUpload,FileManager}.jsx` (page attachments in `AdminPageEdit`) | D94: attachments are not built |

---

## 2. Each page's reads and writes, mapped to a Worker route

Legend: ✓ the route exists and carries what the page needs; ◐ it exists but a field is missing or the semantics differ; **GAP** nothing serves it. Every `/v1/admin/*` call sends `X-Shop-Id` (`request-authorization.ts:21,93-129`). No `/v1/platform/*` call may send it: D70 refuses those (`request-authorization.ts:65-77`).

### 2a. Auth shell and contexts

| Page / component | Today | Worker | Status |
|---|---|---|---|
| LoginPage (via `AuthContext.jsx:182`) | `signInWithEmailAndPassword` | `POST /api/auth/sign-in/email` (`auth-routes.ts:16-20`) | ✓. The admin origin must be added to `AUTH_TRUSTED_ORIGINS` (`create-auth.ts:20-45`; `wrangler.jsonc:65,153`). |
| Sign out (`AuthContext.jsx:187,223`) | `signOut` | `POST /api/auth/sign-out` | ✓. Also `DELETE /v1/platform/tenants/:id/acting-as` when a grant is open (`routes/acting-as.ts:16`). |
| `onAuthStateChanged` + `users/{uid}` role and platform flag (`AuthContext.jsx:112,119`) | live listener + profile doc | `GET /api/auth/get-session` gives the user only | **GAP** `GET /v1/me` (see 3, WA). No route returns account type, memberships or open acting-as grants. The tables exist: `identity_access` and `tenant_memberships` (`0002_auth_identity.sql:62-89`), read in `live-authorization.ts:55-95`. |
| ForgotPasswordPage (`sendPasswordResetEmail` callable) | callable | `POST /api/auth/request-password-reset` (`auth-routes.ts:24`) | ◐. The link always lands on `origins.web/reset-password` (`password-reset.ts:280`). The shared web host refuses `reset-password` as a shop segment (`web/src/shop-segment.ts:24`), so it serves the storefront's 404 shell. **GAP:** an `admin` canonical origin (`origins.ts:27` allows only `api`/`web`, `:81-85` refuses unknown keys) and the reset landing on the admin host. |
| Reset-password page (new) | `pages/shop/ResetPassword.jsx` uses `confirmPasswordResetV2` | `GET /api/auth/reset-password/:token` → callback; `POST /api/auth/reset-password` (`auth-routes.ts:25-29`, `password-reset.ts:301-315`) | ✓ on the API. The page itself is a frontend gap. |
| Change own email or password (`AuthContext.jsx:275,301`) | `updateEmail`, `updatePassword` | not mounted (`auth-routes.ts:12-20`) | **GAP, nice-to-have.** A reset covers it. |
| `ShopContext` resolution (impersonation → own shop → last picked → path; `ShopContext.jsx`) | client state | `X-Shop-Id` validated per request | ✓ server-side. The list of shops needs `GET /v1/me` (GAP) for an admin and `GET /v1/platform/tenants` (✓, `platform-tenants.ts:72`) for a platform user. |
| ShopPicker (`getDocs shops`) | Firestore | as above | ◐ |
| ImpersonateShopModal / Intake / Banner (`impersonationAudit` Firestore) | client-written audit | `POST`/`DELETE /v1/platform/tenants/:id/acting-as` `{reason?}` → `{tenantId, expiresAt}`, TTL 60 min (`acting-as.ts:17`; `routes/acting-as.ts:16-34`) | ✓. Restoring the banner after a reload needs the open grants: covered by `/v1/me` (GAP). |
| `ShopFeaturesContext` (features for the menu and the POD gate) | `shopConfig` | The platform route only (`platform-tenants.ts:77`). The storefront response is public and bound to the hostname, and answers 404 for an unpublished shop. | **GAP** `GET /v1/admin/shop` returning `features`. No admin route calls `readTenantFeatures` (callers: `tenant-directory.ts:234`, `tenant-config.ts:286,338`, `platform-tenants.ts:240`). |
| `StoreSettingsContext` (shop name, logo in the header) | `shopConfig` | `GET /v1/admin/settings` (`admin-settings.ts:41`). It has no `shopName`: that is a refused identity key (`tenant-config.ts:371-392`). | ◐. The name comes from `/v1/admin/shop` (GAP). |
| `TranslationContext`, `credentialTranslations` (Firestore `translations_*`) | Firestore | static `src/locales/*.json` (D16) | ✓. Reuse `src/storefront/providers/Translation.jsx`. |
| PlatformTermsGate (`shops.platformTerms`) and AdminPlatformTerms | getDoc | `GET /v1/admin/legal/status`, `GET /v1/admin/legal/terms`, `POST /v1/admin/legal/accept-terms` (`legal-admin.ts:71-73`) | ✓. Accepting is refused while acting-as (`legal-admin.ts` header). |
| PlatformLayout badge (count of `infringementReports`) | count | `GET /v1/platform/reports` → `newCount` (`platform-reports.ts` header, :39) | ✓ |

### 2b. Admin pages

| Page | Operation today | Worker route | Status / what is missing |
|---|---|---|---|
| **AdminProducts** | list `products where shopId` (:121) | `GET /v1/admin/products` (`admin-products.ts:60`) | ✓ |
| | toggle featured (:189) | `PATCH /v1/admin/products/:id {featured}` (`admin-catalog.ts:127-164`) | ✓ |
| | reorder through `writeBatch` (:220) | `PUT /v1/admin/products/order` (`admin-products.ts:61`) | ✓ |
| | `deleteDoc` (:165) | no DELETE. `status:'archived'` instead (`admin-catalog.ts:165`); `order_items` keeps the product with `ON DELETE RESTRICT` (`0011_orders.sql:219-230`) | ◐. The UI maps delete to archive. |
| **ProductForm** | read the product (:986) | `GET /v1/admin/products/:id` with variants, images, tags (`admin-product-reads.ts:23-64`) | ✓ |
| | create / update (:977, :998-1000) | `POST /v1/admin/products`, `PATCH /v1/admin/products/:id`, `…/publish`, `…/unpublish` (`admin-catalog.ts:141-164`) | ✓ for allowPickup, allowShipping, shippingRates (shipping and pickup per product), size, sizeGuide, tags, category, compareAt, featured, stock, sortOrder. `isPersonalized` is refused by design (CP4_A_REPORT:272). `is_pod` is set by mapping creation (`pod-mappings.ts:874`). |
| | variants rail (`deriveVariantsFromGroups`, :75) | `POST /v1/admin/products/:id/variants`, `PATCH`/`DELETE …/variants/:vid` (`admin-products.ts:63-64`) | ✓. Group, size and position exist; a variant on a paid order is deactivated, not deleted (CP4_BRIEFS:206). |
| | images, first = main (`uploadImageToStorage` :817/822/890; `deleteObject` parses the Firebase URL :737-742) | `POST /v1/admin/objects` (reserve, kind `product_media`) → `PUT /v1/admin/objects/:id/content` → `PUT /v1/admin/products/:id/images` `[{objectId, alt, variantId?}]`, at most 30; remove = `DELETE /v1/admin/objects/:id` (`object-routes.ts:90-97,116-118`) | ✓. 15 MB per public image. The client must send the sha256. |
| | POD gate: Inköp from `product.podCostSek` (:416, :1291) and a client floor `priceFloor()` (:413-417, :761-770) | `GET /v1/admin/pod/quote?productId=[&variantId=]` → `{inkopMinor, priceFloorMinor, currency}` (`pod-admin.ts:131-150`) | ✓ for a mapped product. The page must show the SERVER's floor: the client formula (`podPricing.js:1-40`, `FEE_RATE` 0.08) lacks D41's parcel cost. |
| | screening notice from a client blocklist (`loadContentScreening` → `settings/contentScreening`, :82-83) | screening is server-side; terms are platform-only (`platform-settings.ts` header) | ◐. Drop the client blocklist and show the server's `screeningStatus` (`admin-product-reads.ts:51`). |
| **AdminOrders** | `getAllOrders` (`OrderContext.jsx:350,381`) | none. Only `/v1/admin/orders/:orderId`, `/refunds` and `/cancel` exist (`money-orders.ts:38-39`; `dispatch-admin.ts:12`) | **GAP** `GET /v1/admin/orders?status&since&q&cursor&limit`. The page reads orderNumber, createdAt, status, deliveryMethod, total, customer email and name, pickupLocation (`AdminOrders.jsx`, field counts). The tenant index exists (`platform-orders.ts:63` names `orders_tenant_created_idx`). |
| | `updateOrderStatus` + `sendOrderStatusUpdateEmail` (`OrderContext.jsx:413,566,589` trackingNumber; statuses `OrderStatusMenu.jsx:49-64`) | none | **GAP** `POST /v1/admin/orders/:id/status {status, trackingNumber?, note?}`, plus a history row (`order_status_history`, `0011_orders.sql:317`) and a status email. The statuses already exist in the CHECK (`0011_orders.sql:68`). Refunds rewrite `status` (`refunds.ts:119-127`) but leave fulfilment statuses alone, and cancellation treats shipped, ready_for_pickup, delivered and completed as a return case (`cancellation.ts:45-50`). |
| | labels, CSV, pickup export (`utils/labelPrinter`, `orderExport`, `pickupExport`) | client-side from the list | ◐. Needs the list and the recipient (D98). |
| **AdminOrderDetail** | `getOrderById` + `getDoc users` (:135) | `GET /v1/admin/orders/:id` → `{order: AdminOrderView + consent, recipient, withdrawal, withdrawalRequest}` (`money-orders.ts:49-88`; `admin-orders.ts:23-53`) | ◐ **GAP fields:** `items[]` (sku, name, size/variant, qty, unit price, line total; in `order_items`, `0011_orders.sql:219-235`), `customerEmail` (`orders.customer_email`), `deliveryMethod`, `shippingCountry`, `createdAt`, `statusHistory[]`, and a seller-safe production state per line (`order_items.dispatch_state`/`production_state`, `0022_dispatch_state.sql:28,47`) with no printer id, job ref or cost. Recipient (D98) ✓ (`money-orders.ts:81`). |
| | refund (`refundOrder` :317) | `POST /v1/admin/orders/:id/refunds {amountMinor, reason}` + `Idempotency-Key` (`money-orders.ts:28-39`) | ✓ |
| | cancel | `POST /v1/admin/orders/:id/cancel {reason}` (`dispatch-admin.ts:12-18`) | ✓ |
| | `deleteOrder` (`OrderContext.jsx:702`) | none | Leaves the UI. An order is permanent evidence (D68). |
| OrderPaymentCard (`utils/shopPayout`) | client computation | `order.money` + `order.payout` from the server: one `feeMinor` (`admin-orders.ts:7-21,118-146`) | ✓. The adapter must not recompute the payout. The negative-payout wording is still open (CP2_A:347). |
| **AdminDashboard** | 4 queries: `b2cCustomers`, `orders` ×2, `affiliates` (:122-171) | needs the order list | ◐ after WB. The customer and affiliate tiles leave (PORT-LATER). |
| **AdminSettings** | load/save identity (`shopConfig` :70,159,223) | `GET`/`PUT /v1/admin/settings` (`admin-settings.ts:18-30`) | ◐. PUT REPLACES `storeIdentity` whole; Firebase deep-merged (CP3_A_REPORT:209). Until WD lands: read-modify-write with no lock. |
| | shopName and supportEmail fields (:452,455), vatRate (:479) | refused identity keys (`tenant-config.ts:371-392`); platform PATCH only (`tenant-directory.ts:263-268`) | **Decision D99** (D61 open). Show them read-only, or add `PATCH /v1/admin/shop`. |
| | pickup places (:500) | `storeIdentity.pickupLocations`; the checkout validates against them (CP4 R rule 2) | ✓ |
| | return address, VAT answer, seller type (:518, :671-711) | top-level fields of the same PUT (`admin-settings.ts:18-21`) | ✓ |
| | legal pages: render from templates (`renderLegalPage` :24) + `recordLegalAcceptance` (:377) | `POST /v1/admin/legal/accept-pages {templateVersion, texts{kopvillkor, angerratt, integritetspolicy}, pod, custom}`, `GET /v1/admin/legal/pages`, readiness in `/legal/status` (`legal-admin.ts:38-58,71-75`) | ✓. Acting-as is refused, so the seller must sign in himself. |
| | "take over" a legal text as a CMS page (`findLegalPage`/`takeOverLegalPage` :194-263 write `pages`) | legal pages are not content pages (D79); slugs reserved (`admin-pages.ts` header: `slug_reserved`) | ◐ UI redesign. Keep the draft in `storeIdentity.legal.custom` (allowed: `tenant-config.ts:356-358`) and send it in `accept-pages.texts` with `custom` (no Worker gap). |
| | cart-recovery and review settings (:11, :56, :873) | not ported | Leave the page (D81). |
| **AdminStorefront** | `uploadStoreImage` logo/hero/favicon (:151,:212) | objects kind `shop_branding` (JPEG/PNG/WebP/GIF/AVIF + ICO/SVG ≤512 KB) → identity `logoObjectId`/`heroObjectId`/`faviconObjectId`/`emailLogoObjectId` (`tenant-config.ts:503-513`; `admin-settings.ts:67-83`) | ✓ |
| | template, theme, accent, featured block (:106,124) | `PUT /v1/admin/settings` storeIdentity | ◐ (the replace semantics above) |
| | products for the featured picker (:85) | `GET /v1/admin/products` | ✓ |
| **AdminMenu** | products, collections, pages (:128-130); save `menu` (:203) | admin lists ✓; `storeIdentity.menu`, resolved by the storefront response (CP4_BRIEFS:320) | ◐ (replace semantics) |
| **AdminCollections** | list (:88), update (:123), delete (:109), reorder `writeBatch` (:150) | `GET/POST /v1/admin/collections`, `GET/PATCH/DELETE …/:id` (`admin-collections.ts:21-35,78-80`) | ✓. Reorder = N PATCH `{sortOrder}` (19 collections on staging). A bulk route is nice-to-have. |
| **AdminCollectionEdit** | products (:62,158), add/set (:182,187), delete (:203), cover (`imageUpload`) | the routes above + `PUT …/:id/products` (≤500) + objects `product_media` | ✓ |
| **AdminPages** | `onSnapshot pages` ×2 (:44,61), delete (:100) | `GET /v1/admin/pages?kind&status&cursor`, `DELETE …/:id` (`admin-pages.ts:60-61`) | ✓. Fetch on mount and after each change (PLAN §2.9). |
| **AdminPageEdit** | get (:111), add/set (:204,215), attachments (`fileUpload` :247,271) | `GET/POST/PATCH /v1/admin/pages[/:id]`; HTML refusal at write (`content_refused`) | ✓. Attachments leave (D94). |
| **AdminPayments** | `onSnapshot shops/{id}.payments` (:114) | `GET /v1/admin/payments/connect` (`connect-admin.ts:57`); 404 when the platform has not enabled Connect (`connect-onboarding.ts:19`) | ✓. Refetch on mount, on focus and on `?return=1`. |
| | `createConnectAccount`, `createConnectAccountLink`, `refreshConnectStatus`, `createConnectLoginLink` (:126,147,256,278,315) | `POST …/connect/account`, `/onboarding-link`, `/refresh`, `/login-link` (`connect-admin.ts:58-61`) | ✓. The login link is refused while acting-as. |
| | `getConnectBalance` (:355) | none (CP3_F_REPORT:231 "No balance read") | **GAP, nice-to-have** `GET /v1/admin/payments/connect/balance` |
| | `setConnectPayoutDelay` (:414; platform only, :343-345, :398) | `PUT /v1/platform/tenants/:id/connect/payout-delay` (`connect-platform.ts:48`) | ✓. Sent WITHOUT `X-Shop-Id` (D70). |
| **AdminUsers** | `getAllUsers` (`AuthContext.jsx:382`), role and `marginal` updates (:402-486) | platform only: `GET /v1/platform/users?tenantId=`, deactivate, revoke admin, invite (`platform-users.ts:55-63`) | **GAP + decision D100.** No seller-side `GET /v1/admin/members`, invite or revoke. The `marginal` field is B2B-era and is dropped. |
| `/admin/redirects` (no page yet) | — | `GET/PUT/DELETE /v1/admin/redirects` (`admin-redirects.ts:48`) | ✓ API. The page is new (CP4_D_REPORT:169), nice-to-have. |
| Storefront preview link | — | `POST /v1/admin/preview` is being built by D2 (`preview.ts:11`) | in progress, not CP5's |

### 2c. Platform pages

| Page | Operation today | Worker route | Status |
|---|---|---|---|
| **PlatformShops** | `getDocs shops` (:36) + 3 counts per shop (:41-45); status update (:76) | `GET /v1/platform/tenants[?status&cursor&limit]` (`platform-tenants.ts:72`); `POST …/:id/activate`, `…/suspend` (`platform-users.ts:62-63`) | ◐. **GAP, nice-to-have:** the counts (`TenantListItem` has domainCount, domains, published, shopName, status: `tenant-directory.ts:74-81`). Drop the counts or add them. |
| **PlatformShopDetail** | getDoc (:65), counts (:76-77), published (:122), status (:139), `payments.connectEnabled` (:156) | `GET /v1/platform/tenants/:id` (features, domains, settings readiness, Connect facts, commission: `tenant-directory.ts:158-186`); publish/unpublish/close (`platform-tenants.ts:74-76`); Connect enable/disable (`connect-platform.ts:46-47`) | ◐. **GAP, nice-to-have:** the legal readiness in detail shows only `returnAddressSet`/`vatAnswered` (`tenant-directory.ts:163`); terms acceptance and page adoption are missing (they exist in `legal/legal-pages.ts` `readLegalReadiness` and `platform-terms.ts` `readTermsStatus`). |
| shopCells `setShopCommission` (:106) | callable | `PATCH /v1/platform/tenants/:id {commissionBps}` 0–800 (D71, D91) | ✓ |
| ProvisionShopModal (getDoc + setDoc shops :109,115) | Firestore | `POST /v1/platform/tenants` (create), `…/domains`, `…/admins` (handled in `app.ts` `handlePlatformTenantRoute`, `platform-tenants.ts:57-60` header) | ✓ |
| AddShopUserModal `createShopUser` (:26) | callable | `POST /v1/platform/users` (create, `app.ts` `PLATFORM_USERS_PATH`) + grant admin + `POST /v1/platform/users/:id/invite` | ✓ (an invite, never a password) |
| **PlatformAddons** | `getDocs shops` + `updateDoc features` (:25,50) | `GET/PUT /v1/platform/tenants/:id/features` (`platform-tenants.ts:77`) | ✓. One read per shop (5 shops). Allowed keys per D62. |
| **PlatformUsers** | `getDocs users` (:33); `deletePlatformUser` (:64); `createPlatformSuperAdmin` (:214) | `GET /v1/platform/users`, `…/:id`, `…/deactivate`, `…/reactivate`, `…/invite` (`platform-users.ts:55-59`) | ✓. Creating a platform admin over HTTP is refused (D51); the button leaves. Reactivating a platform admin is refused (D63). |
| **PlatformPrinters / PrinterRow / printerTierForm** | printers (:89-92), setDoc ×3 (:183,227,270), `settings/printRouting`, `createPrintShopUser` (:127) | `GET /v1/platform/printers`, `GET/PATCH …/:id` (tiers and areas), `GET/PUT …/default` (routing, D52), `GET/PUT …/:id/catalog`, `POST …/catalog/apply` (`pod-platform.ts:156-183`) | ✓. `createPrintShopUser` leaves (print portal is PORT-LATER). |
| **PlatformReports** | reports (:478), screening queue `products where screening.status in` (:480), shops (:481), handle (:541,545), product screening (:547), `takedownProduct` (:534) | `GET /v1/platform/reports[?status&tenantId]`, `GET …/:id`, `POST …/handle`, `POST …/takedown` (`platform-reports.ts:39-42`); `GET /v1/platform/screening[?status]`, `POST /v1/platform/screening/:productId {decision}` (`pod-platform.ts:52-53`) | ✓ |
| Platform settings / screening terms (new pages) | — | `GET/PATCH /v1/platform/settings`, screening terms CRUD + rescreen (`platform-settings.ts:58-61`) | ✓ API, new UI |
| Terms versions (new page) | — | `GET/POST /v1/platform/legal/terms-versions`, `GET/PUT …/:version/text` (`legal-platform.ts:52-53`) | ✓ API, new UI |
| POD profiles (platform) | `settings/podProfiles` | `PUT /v1/platform/pod/profiles` only (`app.ts` `handlePlatformPodProfilesRoute`: "if (request.method !== 'PUT')") | **GAP, nice-to-have:** a platform GET. `GET /v1/admin/pod/profiles` exists for a shop (`app.ts` `handleAdminPodRoute`). |

### 2d. POD wagon and studio

| Component | Operation today | Worker route | Status |
|---|---|---|---|
| ArtworkUploadModal | `uploadPodOriginal` (`podUpload.js:81`) + `createArtwork` + `processPodArtwork` (:154); `label` (:44,182,191), `rightsConfirmed` (:49,147,175), `createdBy` = `auth.currentUser.uid` (:194) | objects kind `artwork_original` (private, ≤100 MB: `object-routes.ts:90-97,116`) → `POST /v1/admin/pod/artwork {objectId, profileId}` → 202 processing → poll `GET /v1/admin/pod/artwork/:id` (verdict + presigned `previewUrl`) (`app.ts` `handleAdminPodRoute`; `artwork-routes.ts` parse) | ◐ **GAP:** `pod_artwork` has no `label`, `rights_confirmed` or `created_by` (D53; `0012_pod_artwork.sql:130-150`); the body accepts only `{objectId, profileId}` (`artwork-routes.ts:14`). A failed render deletes the row, so the poll gets 404 (CP1_C_REPORT:301). Artwork creation is limited to 5 per minute per IP (RENDER_BENCHMARK:216). |
| ArtworkLibrary | `processPodArtwork` (:48), `deleteArtwork` (`podArtwork.js:127,133`) | `GET /v1/admin/pod/artwork`, `DELETE /v1/admin/pod/artwork/:id` (409 while mapped) | ✓. `replaceArtworkFile` (`podArtwork.js:76,92`) has no route: delete and upload again. |
| Profiles (`config/podProfiles.js:31`) | `settings/podProfiles` | `GET /v1/admin/pod/profiles` | ✓ |
| ProductMapping (`updateDoc products` :120; `setMapping`/`deleteMapping` `podMappings.js:83-92`) | Firestore | `GET /v1/admin/pod/printers` (capabilities: models, skus, garments, no price; `printers.ts:536-578`), `GET/POST /v1/admin/pod/mappings`, `DELETE …/:id` (`pod-admin.ts:16-21`) | ✓. **This is the D83 page.** melodie-mc's artworks were NOT imported (HANDOVER:136), so a mapping needs the artwork re-uploaded or a data step. |
| Printer routing (`config/printRouting.js:50`, `printersPublic`) | Firestore | the mapping names the printer; the default printer is platform-only (D52; CP3_C_REPORT:174) | ◐. The UI must preselect without seeing the default (`/v1/admin/pod/printers` lists the usable printers). |
| Studio quote `quotePodCost({garment, slots})` (`podCostQuote.js:27-35`) before any product exists | callable | `GET /v1/admin/pod/quote` REQUIRES `productId` (`pod-admin.ts:135-138`) | **GAP** a design-time quote by printer, SKU and slots, one number. |
| Studio publish (DesignStudio `addDoc products` :986, `updateDoc` :1220, mockup uploads :730 to the products path, `setMapping`) | Firestore + Storage | `POST /v1/admin/products` (draft) → objects `product_media` → `PUT …/images` → variants → `POST /v1/admin/pod/mappings` per variant (floor check) → `POST …/publish` | ✓ as a sequence. The client orchestrates; a failure part-way leaves a draft. |
| Mockup templates (`config/podMockupTemplates.js:98`, `settings/podMockupTemplates`, global) | Firestore | none. MIGRATION_MANIFEST:125 plans `pod_mockup_templates` (CP6) | **GAP (CP6)** |
| 3D models, read-only (`config/pod3dModels.js:60`, `pod3dModels` + Storage) | Firestore + Storage | none. MIGRATION_MANIFEST:96 plans `pod_3d_models` (CP6). `stored_objects.tenant_id` is NOT NULL and keys must sit under `shops/<tenant>/` (`0006_object_store.sql:8,35-38`), so platform-owned images have no home. | **GAP (CP6) + decision D101** |
| Mockup uploads (`mockupUpload.js:19`, deterministic overwrite) | Storage | objects `product_media` (immutable keys; no overwrite) | ◐. A new object per render; old ones are swept (D93). |
| Rescreen on all mutations (CP6) | — | screening is wired into products, variants, images and mappings (`grep screen`: `product-variants.ts` 13, `product-images.ts` 9, `pod-mappings.ts` 14 hits) | ◐. Verify that an artwork label change and a replacement rescreen once WG adds them. |

---

## 3. Worker gaps as a build list

Shared rules: CP4_BRIEFS §0 (own files, an `app.ts` anchor block `CP5-IMPORTS-x`/`CP5-ROUTES-x`, exact paths with `onMethods`, authorize first, same-origin on every change, writes audited in the batch). **All units start after D2 is committed** (0.1). Reviewer-only files as in CP4_BRIEFS:10.

| Unit | Delivers | Owns (disjoint) | Migration | Model / class | Blocks? |
|---|---|---|---|---|---|
| **WX: admin Worker** | `chopshop-admin` Worker (§4): serves the admin build, proxies `/_api/{v1/admin,v1/platform,api/auth}/…` over the service binding with cookies, security headers | `cloudflare/admin/**` (wrangler.jsonc, `src/{index,routing,forward,allowlist,headers,env}.ts`, `check-admin-build.mjs`, tsconfig), `cloudflare/test/admin-worker-*.test.ts` | — | **Opus**: auth boundary, tenancy | **Blocks everything on staging** |
| **WA: session and shop context** | `GET /v1/me` → `{user{id,email,name}, accountType, platform, memberships[{tenantId, shopName, status, published, role}], actingAs[{tenantId, expiresAt}]}`; `GET /v1/admin/shop` → `{tenantId, shopName, supportEmail, status, published, defaultLocale, currency, vatRateBp, features{key: bool, not-ported = false (D81)}}`; `origins.ts` gains `admin` (+ `platform` = the same origin); the ordinary reset lands on the surface of the account type (`password-reset.ts:280`) | new `src/routes/admin-session.ts`, `src/auth/session-self.ts`; edits `src/lib/origins.ts`, `src/auth/password-reset.ts`; tests `admin-session`, `origins`, `password-reset` | — | **Opus**: tenancy, auth | **Blocks the shell** |
| **WB: seller orders** | `GET /v1/admin/orders` (list, cursor, filters); the detail gains items, customerEmail, deliveryMethod, shippingCountry, createdAt, statusHistory and a seller-safe line production state; `POST /v1/admin/orders/:id/status {status, trackingNumber?, note?}` with a transition table that respects refund and cancellation states; writes `order_status_history` + an outbox row `event_type='email.order_status'` (event types are free, `0021_outbox_claims.sql:64-69`; the consumer comes in WE) | new `src/commerce/admin-order-list.ts`, `src/commerce/fulfilment.ts`, `src/routes/admin-orders.ts`; edits `src/commerce/admin-orders.ts`, `src/routes/money-orders.ts` (detail assembly only); tests | **0046_order_fulfilment.sql** (`order_shipments(tenant_id, order_id, tracking_number, carrier, created_at, created_by)` + triggers; list index if missing) | **Opus**: money-adjacent, schema | **Blocks the orders pages and the dashboard** |
| **WC: shop members** | `GET /v1/admin/members`, `POST /v1/admin/members {email, name}` (identity + membership + invite through `platform/invites.ts`), `POST /v1/admin/members/:userId/revoke` (refuses self and the last admin) | new `src/platform/tenant-members.ts`, `src/routes/admin-members.ts`, test; read-only imports of `invites.ts`, `user-lifecycle.ts:301` | — | **Opus**: tenancy, identity | Blocks AdminUsers only. **Needs D100.** |
| **WD: settings merge + seller identity** | `PATCH /v1/admin/settings` (top-level identity keys merged, `expectedUpdatedAt` → 409 when stale); `PATCH /v1/admin/shop {shopName?, supportEmail?}` if D99 says yes (catalog_version bump) | `src/routes/admin-settings.ts`, `src/platform/tenant-config.ts`, `src/routes/admin-shop-write.ts` (new) | — | Opus, small (tenancy) | Nice-to-have. Pages work with read-modify-write PUT meanwhile. |
| **WE: e-mail templates** | the effects and templates `order_status_update` (buyer), `order_notice_shop` (seller, new order: INVENTORY_FUNCTIONS:323), `refund_notice` (buyer: `refundOrder` RESEND, :315); consumer for `email.order_status` | `src/email/order-emails.ts` (new), `src/outbox/email-effect.ts`, `src/email/email-queue-consumer.ts`, `src/email/email-delivery-store.ts`; one statement in `src/commerce/webhook.ts` (shop notice in the order batch) and in `src/commerce/refunds.ts` | **0047_email_kinds.sql**: a rebuild of `email_deliveries` (its kind is a CHECK: `0044_withdrawals.sql:153-156`) | **Opus**: schema + webhook batch | CP6 by PLAN; the status mail is needed once WB is live |
| **WF: Connect balance** | `GET /v1/admin/payments/connect/balance` (available/pending per currency, payoutDelayDays; refused while acting-as like the login link?) | `src/routes/connect-admin.ts`, `src/commerce/connect-gateway.ts`, new `src/commerce/connect-balance.ts` | — | Opus, small (money) | Nice-to-have |
| **WG: POD server for the studio** | (a) design-time quote `GET /v1/admin/pod/quote?printerId&sku&slots` (or a new `/v1/admin/pod/design-quote`) with the masked refusal codes (`pod-admin.ts:56-63`); (b) artwork `label`, `rights_confirmed_at`, `created_by` + `PATCH /v1/admin/pod/artwork/:id {label}` with rescreen; (c) optional: a `failed` artwork state | `src/pod/pod-quote.ts`, `src/pod/pod-mappings.ts` (quote only), `src/routes/pod-admin.ts`, `src/pod/artwork-store.ts`, `src/pod/artwork-routes.ts`, a new `src/routes/pod-artwork.ts` (moves the artwork PATCH out of `app.ts`) | **0048_pod_artwork_meta.sql** (ALTER ADD COLUMN ×3; (c) needs a table rebuild because `status` is a CHECK, `0012_pod_artwork.sql:138`) | **Opus**: schema, one-number rule, legal (rights) | (b) is needed by ArtworkUploadModal's rights box (legal); (a) blocks the studio (CP6) |
| **WH: studio assets** | `pod_mockup_templates`, `pod_3d_models` + reads `GET /v1/admin/pod/mockup-templates`, `GET /v1/admin/pod/3d-models` + a platform write path + an import script; where the images live per D101 | all new: `src/pod/studio-assets.ts`, `src/routes/pod-studio-assets.ts`, `scripts/cf-port/migrate/import-studio-assets.mjs`, tests | **0049_pod_studio_assets.sql** | Opus (schema) | Blocks the studio and 3D only (CP6) |
| **WI: platform read extras** | detail + legal readiness (terms status, pages adoption) + counts (products, orders); directory counts (bounded); `GET /v1/platform/pod/profiles` | `src/platform/tenant-directory.ts`, `src/routes/platform-tenants.ts` (its CP3-A block), new `src/routes/platform-pod-profiles.ts` | — | Sonnet (platform-only reads, no money) | Nice-to-have |

**Reviewer wiring, for all units:** `REQUIRED_MIGRATION` → the latest of 0046–0049 (`app.ts` + two tests); `wrangler.jsonc` `AUTH_TRUSTED_ORIGINS` += the admin origin and `CANONICAL_ORIGINS.admin`; `pinned.<env>.json` gains `adminWorkerName` and `origins.admin`; preflight `--admin`; deploy target `admin` (§4).

---

## 4. Architecture: one recommended design

**Recommendation:** a third build and a third Worker, `chopshop-admin` (`cloudflare/admin/`). It serves the admin AND the platform console on ONE hostname, and is a same-origin proxy to the API's `Internal` entrypoint over a service binding.

| Question | Decision | Why, in the code |
|---|---|---|
| Where it is built | `vite.admin.config.js` → `cloudflare/admin/dist`, entry `index.admin.html` → `src/admin-app/main.jsx`, with an alias list like `vite.storefront.config.js:37-74` (AuthContext, ShopContext, ShopFeaturesContext, StoreSettingsContext, TranslationContext, OrderContext, `config/shopConfig`, `config/urls`, `utils/credentialTranslations` → admin providers and replacements). A page table `src/admin-app/pages.jsx` swaps one line per page, as `src/storefront/pages.jsx` does. | The proven CP4 pattern: markup untouched, data layer only (CP4_BRIEFS:427-438). `App.jsx` and `vite.config.js` stay as the rollback build. |
| Not served by the web Worker | — | The web Worker drops `Cookie` and `Set-Cookie` on purpose (`web/src/forward.ts:7-8,35,78-80`). Its allowlist refuses every `/v1/admin` and `/v1/platform` path (`api-allowlist.ts:1-26,35-52`). It reserves `admin`, `platform`, `login` and `reset-password` as non-shops (`shop-segment.ts:17-30`). Putting a session on the host that serves seller-controlled HTML (pages, descriptions) would also give a storefront XSS the admin cookie. PLAN §2.1: "cookies … scoped per hostname". |
| How requests reach the API with the cookie | The browser calls `/_api/v1/admin/…`, `/_api/v1/platform/…` and `/_api/api/auth/…` on the admin host. The Worker strips `/_api` and forwards **keeping the admin host in the URL**, with `Cookie` kept, `X-Tenant-*` dropped, `CF-Connecting-IP` set, to `env.API` (entrypoint `Internal`; `index.ts:94-99`). `Set-Cookie` is passed back. Allowlist: prefixes `/v1/admin/`, `/v1/platform/`, plus the exact auth routes of `auth-routes.ts:16-29`. Everything else is 404 (render, webhooks, staging, storefront routes). | `isSameOriginRequest` compares `Origin` with `new URL(request.url).origin` (`same-origin.ts:6-20`). Keeping the browser's host in the forwarded URL makes the check mean exactly what it should. The proxy never vouches. Admin routes do not resolve a tenant from the host (`authorizeTenantAdminRequest`, `request-authorization.ts:93-129`), and the `internal` surface only widens storefront routes (`app.ts` `storefront(...)`), so an admin request on the internal surface behaves as on the public one. The Better Auth cookie becomes host-only for the admin host. **Verify by test:** that Better Auth accepts a request whose host differs from `AUTH_BASE_URL` (`create-auth.ts:66`) and sets a `Secure` cookie. Read better-auth's `getOrigin`/cookie code in `node_modules/better-auth` if the test fails. |
| Cross-origin + allowlist instead? | Rejected | It would need CORS with credentials on every admin route, and `isSameOriginRequest` would fail by construction (Origin = admin, URL = api). |
| Admin and platform: one host or two? | **One host.** Two router trees chosen at boot: `/platform/*` mounts the platform tree with `basename="/platform"`, so the pages' absolute links (`/shops/:id`, `PlatformLayout.jsx:30-40`) need no edit; everything else is the admin tree. Moving between them is a full page load. | Acting-as needs the platform user's session ON the admin surface (`request-authorization.ts:112-128`). Two hosts would need two sign-ins and buy nothing: D70 already separates the contexts per request (`request-authorization.ts:65-77`), and every platform-price route refuses `X-Shop-Id` (`pod-platform.ts:166-174`). PLAN §2.1 says "one hostname each", so this is decision **D102**. In production, a second custom hostname can be pointed at the same Worker later. |
| Active shop | A `Session` provider reads `GET /v1/me` (WA). A tenant admin with one membership gets that shop; several → ShopPicker from `memberships`. A platform user → ShopPicker from `GET /v1/platform/tenants`, then `POST …/acting-as {reason}` (60 min, `acting-as.ts:17`), then the admin tree. The active shop id is kept per tab in `sessionStorage`; `?shopId=` deep links (Connect return URLs carry it, CP3_F_REPORT:161) are honoured by `AdminShopIdIntake`. Requests: `adminRequest()` always adds `X-Shop-Id`; `platformRequest()` never does. | `ShopContext.jsx` resolution order, kept, with the source swapped |
| Auth state replacing `onAuthStateChanged` and custom claims | `useAuth()` keeps its shape (`AuthContext.jsx:817-840`): `currentUser{uid,email,displayName}`, `userProfile{role}`, `isAdmin`, `isPlatform`, `loading`, `login` (sign-in → `/v1/me`), `logout`, `resetPassword`, all fed from `/v1/me`. A 404 from an admin route re-reads `/v1/me`: null → `/login`, otherwise a real 404. `AdminRoute`/`PlatformRoute` stay unedited (`AdminRoute.jsx` reads `userProfile.role`). | INVENTORY 0.8: 65 `currentUser.uid` sites keep their shape |
| `onSnapshot` replacements (PLAN §2.9) | `AdminPages.jsx:44,61` → fetch on mount and after each change. `AdminPayments.jsx:114` → GET on mount, on window focus, and on `?return=1|refresh=1` (POST `/refresh` first). `useAdminPresence.js:148` → dropped. Artwork processing → poll `GET /v1/admin/pod/artwork/:id` with 2→10 s backoff until ready, rejected or 404. Platform badge → `newCount` on navigation. Orders list → refetch on focus. ContentStudio, Dac7 and MigrateWoo leave. | |
| Time | One `src/lib/time.js` (PLAN §2.8). Adapters hand pages `{toDate(), seconds}` where a page calls `.toDate()`/`.seconds` (INVENTORY 0.8), so the markup stays unchanged. | |
| Images and CSP | `img-src 'self' <PUBLIC_OBJECT_BASE_URL> https://<account>.r2.cloudflarestorage.com` (presigned artwork previews, `app.ts` `handleAdminPodRoute` `presignGet`). `frame-ancestors 'none'`. `style-src 'unsafe-inline'` (Quill). Enforced, not report-only. Uploads stream through two Workers: the 100 MB cap (`object-routes.ts:116`) equals the Workers request-body limit, so keep artwork under it. | |
| Deploy path | `scripts/cf-deploy.sh <env> [api|web|admin|all]` gains step d: build `vite.admin.config.js` from the committed tree with `~/.config/chopshop/admin.<env>.env` (public `VITE_` values only; same refusal rules as `cf-deploy.sh:146-178`) → `node cloudflare/admin/check-admin-build.mjs` (no Firebase, no source map, no secret) → `scripts/cf-preflight.sh <env> --admin -- deploy`. The preflight checks: `env.<env>.name` == pinned `adminWorkerName` ≠ `workerName`/`webWorkerName`; assets `{./dist, ASSETS, run_worker_first}`; service `{API → pinned workerName, entrypoint Internal}`; vars `ADMIN_ORIGIN` == `origins.admin`, `PUBLIC_OBJECT_BASE_URL` == `r2.publicBaseUrl`; the API's `AUTH_TRUSTED_ORIGINS` contains `origins.admin`; `CANONICAL_ORIGINS.admin` == `origins.admin`. Production refuses until a real domain exists (D7/D89). Mirror `--web` (`cf-preflight.sh:9,36-40,113-129,448-470`). Guard tests: `guard/preflight.test.sh` and `guard/deploy.test.sh` cases for `--admin`. | |

---

## 5. Frontend build list, in dependency order

| Unit | Files (disjoint) | Depends on | Model | Notes |
|---|---|---|---|---|
| **FA: build, client, providers, auth pages** (first of a kind) | `vite.admin.config.js`, `index.admin.html`, `src/admin-app/{main,AdminApp,PlatformApp,Providers,pages}.jsx`, `src/admin-app/providers/{Session,ActiveShop,ShopFeatures,StoreSettings}.jsx` (Translation reuses `src/storefront/providers/Translation.jsx`), `src/admin-app/replacements/{urls,credentialTranslations,shopConfig}.js`, `src/api/admin/{client,session,uploads,time}.js` + `*.test.mjs`, `src/admin-app/dev/*` (fixtures, invented data), the data layer of `LoginPage.jsx`/`ForgotPasswordPage.jsx`, new `src/admin-app/ResetPasswordPage.jsx` | WA (WX for staging; the dev API otherwise) | **Opus** | `uploads.js`: sha256 → reserve → PUT content → metadata. Freeze the dark-mode key (BP-2, DESIGN_CONTRACT:416). |
| **FB: shells and acting-as** (first of a kind) | `AppLayout.jsx` (menu trimmed to launch scope, `:4` and `:20` imports removed, a static POD entry), `PlatformLayout.jsx`, `ShopPicker.jsx`, `ImpersonateShopModal.jsx`, `ImpersonationBanner.jsx`, `AdminShopIdIntake.jsx`, `PlatformTermsGate.jsx`, `AdminPlatformTerms.jsx` | FA | **Opus** | Terms acceptance is legal |
| **FC: products** | `AdminProducts.jsx`, `ProductForm.jsx`, `ProductImages.jsx`, `src/admin-app/adapters/product.js` (+test) | FB | **Opus** | ProductForm (1 673 lines) is the heaviest admin file. Its data layer is concentrated in `:61-83` imports, `:413-417` and `:761-770` floor, `:737-890` images, `:977-1000` save, `:1285-1313` Inköp. **One unit.** Split the variants rail into FC2 only if the builder runs out of room. |
| **FD: orders and dashboard** | `AdminOrders.jsx`, `AdminOrderDetail.jsx`, `OrderPaymentCard.jsx`, `OrderStatusMenu.jsx`, `AdminDashboard.jsx`, the `OrderContext` replacement, order adapters | WB, FB | **Opus** | Refund, cancel, payout |
| **FE: settings and legal adoption** | `AdminSettings.jsx`, `PickupLocationsEditor.jsx`; `utils/legalAcceptance.js` replacement | FB (WD optional) | **Opus** | Legal; the take-over flow redesigned per D79 |
| **FF: payments** | `AdminPayments.jsx` | FB (WF optional) | **Opus** (small) | Money |
| **FG: catalogue content** | `AdminCollections`, `AdminCollectionEdit`, `AdminMenu`, `AdminPages`, `AdminPageEdit`, `AdminStorefront` | FC (uploads pattern) | **Sonnet** | Repeats an established pattern |
| **FH: users** | `AdminUsers.jsx` (slim) | WC, FB, D100 | **Sonnet** | |
| **FI: platform shops** | `PlatformShops`, `shopCells`, `PlatformShopDetail`, `ProvisionShopModal`, `AddShopUserModal` | FB | **Opus** (commission, Connect enable, tenancy) | `PlatformShops` is the platform's reference page (DESIGN_CONTRACT:526) |
| **FJ: platform rest** | `PlatformAddons`, `PlatformUsers`, `PlatformReports` | FI | **Sonnet** | |
| **FK: printers** | `PlatformPrinters`, `PrinterRow`, `printerTierForm` | FI | **Opus** (prices and tiers) | |
| **FL: new platform pages** | settings, screening terms, terms versions, forwards (`src/admin-app/pages/new/*`) | FJ; a design decision | **Sonnet** | No baseline exists for these pages |
| **FM: POD library and mapping** (D83) | `PodAdminPage` (studio tab → Pending until FN), `ArtworkLibrary`, `ArtworkUploadModal`, `ProductMapping`, `PodProductPicker`, `usePodLibrary`; replacements for `utils/{podArtwork,podMappings,podUpload}.js`, `config/{podProfiles,printRouting}.js` | FC; WG(b) for the rights box | **Opus** | |
| **FN: studio** (CP6) | `DesignStudio.jsx` data layer (`:36-66`, `:730`, `:802`, `:986`, `:1046-1056`, `:1220`), `PublishPanel.jsx` (server floor), `MockupPanel`, `mockupUpload.js`, `Studio3DSection.jsx` (read-only); replacements for `config/{podMockupTemplates,pod3dModels,podCostQuote}.js` | WG(a), WH, FM | **Opus** | DesignStudio (1 961 lines) is the heaviest file overall. **Split it:** FN1 = loaders, quote and the publish sequence; FN2 = mockup upload + 3D read-only. |

---

## 6. What code alone cannot finish

| Dependency | Where the code waits |
|---|---|
| E-mail account: `RESEND_API_KEY`, `EMAIL_FROM` for staging (D34) | Resets, invites, order mails and withdrawal mails are queued and held until the key exists (`password-reset.ts` comment "RESEND_API_KEY is deliberately NOT part of this gate"; `env.d.ts:28-33`). A seller cannot sign in by reset or invite without it. |
| The admin hostname | workers.dev for staging (D7), e.g. `chopshop-admin-stg.kent-ee2.workers.dev`. Production needs the platform domain (D89; PLAN §11.3); `cf-preflight` must refuse until it is pinned. |
| BP-1: the admin/platform baseline | Mikael hands off two logged-in sessions (DESIGN_CONTRACT:415,467-471). Without it the "admin diff-clean" exit (PLAN §10 CP5) cannot be judged. |
| SnapWear real submit (A5/A6) | Staging pins `dispatchTarget: fake-printer` (`pinned.staging.json`); production refuses anything else (PLAN §0). CP6 is a LAUNCH_TODO blocker until Natalia answers. The address wire shape is provisional (CP4_BRIEFS:504). |
| The seller adopts the legal pages | `accept-pages` refuses acting-as (`legal-admin.ts` header), so Kent must sign in to the admin himself. Checkout stays closed until he does (HANDOVER:134). The staging adoption by `staging-legal.mjs` is a review stand-in. |
| melodie-mc's POD artworks | Not imported (HANDOVER:136). Re-uploading through FM, or a data step, is needed before the 6 POD products can be mapped (D83) and sold. |
| Stripe live mode | Accounts v2 for onboarding (D49); two live webhook endpoints (D39, at CP7); live keys and pinned ids. |
| A melodie-mc admin identity on staging | Verify with `GET /v1/platform/users?tenantId=melodie-mc` that Kent's user exists and is active (D59 adoption, D74). Otherwise create it and invite through `/v1/platform/users`. |
| Decisions | D61/D99 (seller renames the shop, VAT rate), D100 (seller-side members, and whether AdminUserCreate/Edit leave), D101 (where platform studio assets live), D102 (one admin host vs PLAN §2.1), D103 (landing page and leads), D97d, D68 (recipient data erasure applies to the order list). |

---

## 7. Proposed order of work: melodie-mc on staging end to end, soonest

| Step | Units | Result for the seller |
|---|---|---|
| 0 | D2 lands. Mikael answers D99–D103. BP-1 baseline shot. Resend key set. | |
| 1 | **WX ∥ WA** (Worker), then the reviewer wiring and a staging deploy of the API and the admin Worker | |
| 2 | **FA → FB** | **Sign in**, reset the password, see the shop and the terms gate; a platform user acts as the shop |
| 3 | **WB → FD** (FC may run beside FD from step 2) | **See orders**, refund, cancel, mark shipped |
| 4 | **FC** | **Edit a product**: images, variants, shipping and pickup, Inköp and floor |
| 5 | **FE** | **Adopt the legal pages** (Kent signs in himself), return address, VAT answer, so checkout opens |
| 6 | **FF** (WF optional) | **Connect status**, onboarding, dashboard link |
| 7 | **FM** (+ WG(b)) + the artwork re-upload | The 6 POD products mapped and sellable |
| 8 | FG, WC → FH, FI → FJ, FK, WE, WD, WI, FL | The rest of CP5 |
| 9 | WG(a), WH → FN1, FN2 | CP6 studio and 3D read-only |

### Critical files for implementation
- /Users/mikaelohlen/Cursor Apps/chopshop/cloudflare/src/auth/request-authorization.ts
- /Users/mikaelohlen/Cursor Apps/chopshop/cloudflare/src/lib/origins.ts (and `cloudflare/src/auth/password-reset.ts`)
- /Users/mikaelohlen/Cursor Apps/chopshop/cloudflare/src/commerce/admin-orders.ts (and `cloudflare/src/routes/money-orders.ts`)
- /Users/mikaelohlen/Cursor Apps/chopshop/cloudflare/web/src/forward.ts (the template for `cloudflare/admin/`; plus `vite.storefront.config.js` as the template for `vite.admin.config.js`)
- /Users/mikaelohlen/Cursor Apps/chopshop/src/components/admin/ProductForm.jsx (and `src/wagons/pod-wagon/studio/DesignStudio.jsx`)
