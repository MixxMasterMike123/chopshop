# Migration manifest — Firestore + Firebase Storage → D1 + R2

Status: **CP0 draft for review** (PLAN §4 / §10 CP0 exit "manifest reviewed"). 2026-09-26, branch `cf-port`.
Inputs: `PLAN.md` §2.5, §2.8, §3, §3.4, §4 · `INVENTORY_CLIENT_DATA.md` · `INVENTORY_FUNCTIONS.md` · `INVENTORY_CF_BRANCH.md` · `INVENTORY_DOCS.md` · `firestore.rules` (every `match`) · `storage.rules` · `functions/src/config/database.ts` (named DB `b8s-reseller-db`) · every script in `scripts/`.

Nothing in Firestore or Storage was written while producing this document. The census below was taken **read-only** (see §0).

---

## Conventions

- **Fate** (PLAN §4): **carry** = imported into D1/R2 at cutover · **archive** = exported to `chopshop-prod-private/archive/firebase/<collection>/` (§c) and *not* imported · **drop** = neither imported nor archived (mechanism state, projections, credential material).
- **Every** collection is in the export bundle, carried ones included, so the bundle doubles as the restore point (§c). "archive" means archive-*only*.
- **Target** tables marked † already exist in `cloudflare/migrations/0001–0012`; the rest are new and land in the CP named in brackets. The public product mirror is not a table: public reads use the PLAN §2.4 eligibility predicate.
- **Id strategy:** *preserve* = the Firestore doc id becomes the D1 primary key verbatim (PLAN §4 "Firestore ids preserved where the schema allows"); *new + map* = new id, old→new stored in `legacy_id_map` (§a).
- **Storage class** = PLAN §2.5 (`public` / `private` / `production`). A "rewritten" URL field is replaced during import by the new R2 location for its class: a public URL for public objects, a `stored_objects` id or key for private and production objects. Private and production objects never get a public URL.
- **Timestamps** (PLAN §2.8): Firestore `Timestamp` → `ts.toDate().toISOString()` (UTC, millisecond precision; nanoseconds are truncated and reported). Existing ISO strings are normalised through `new Date(s).toISOString()`; an unparseable string is kept as-is and reported. Date-only fields stay `YYYY-MM-DD`. Nulls stay null. Archives keep the typed original (§c), with no conversion.
- `uid→map` = a Firebase uid that is rewritten through the user id map (§a).

---

## 0. Census — prod, 2026-09-26 (read-only)

**Status: the read succeeded.** It used ADC (`gcloud auth application-default`, project `b8shield-reseller-app`) with firebase-admin 11.11.1 from `functions/node_modules`, `getFirestore('b8s-reseller-db')`: the same idiom as `scripts/backfill-pod-mapping-garment.mjs:57-72`. Only these calls were made:
- `listCollections()`
- `.count().get()` aggregates, including per-shop `where('shopId','==',…)`, `where('role'/'status'/…)` and `collectionGroup(…)`
- `select()` with no fields, which returns document paths and create/update times but no field data
- a GCS `getFiles()` metadata listing (name + size only)

No document fields were read and no object bytes were downloaded. The census scripts live in the session scratchpad and are not committed.

**What the census changes versus the inventories:**

| Finding | Consequence |
|---|---|
| `settings/platform` **does not exist**, and there is no `functions/.env` | Firebase runs on the defaults in `platformConfig.ts:43-49`: `refundApplicationFee = true`, `defaultCommissionBps = 500` (`app-urls.ts:85`), `reverseDisputeOnCreated = true`. PLAN's go-live value `refundApplicationFee=false` is therefore a **behaviour change** (§f Q1). |
| `settings/app` does not exist | The `shopConfig.js` legacy fallback is dead. Nothing to import. |
| `settings` has 3 auto-id docs from 2025 (B8shield era) | Rows 73–75: archive. |
| **All 9 orders are `status=='refunded'`, `source=='b2c'`, shop `melodie-mc`**. `orderProduction` has 4. | Archiving orders leaves no open fulfilment or refund obligation (to be re-checked at the freeze). |
| 5 shops: `gif-sundsvall`, `melodie-mc`, `ninetone`, `robowatz`, `sillmans` | `robowatz` has 0 products (§f Q10). |
| `users`: 6 docs with data (3 `role=admin`, of which 2 `platform=true`; 3 `role=print_shop`); `listDocuments` returns **13** refs | 7 phantom parents (purged reseller contacts) still carry `marketingMaterials` subcollections. |
| `printers`: `snapwear` + 2 docs keyed by print_shop **Firebase uids** (`o7diaDJ01tRoBMs8d5OK9bPunMg1`, `viTqJwF66NXZ42gEZOxQvqkMBUh1`) | Printer ids stay opaque and are never remapped (row 46). |
| Collections in prod that **neither code nor rules name**: `diningActivities`, `diningContacts`, `diningDeferredActivities`, `diningFollowUps`, `wagonConfigurations`. `ambassadorContacts` is client-referenced but has no rule (default deny). | Archive. |
| Collections the code and rules name but that are **absent** (0 docs): the affiliate×4, `b2cCustomers`, `campaigns`×3, `checkouts`, `checkoutSuppressions`, `dac7CorrectionRequests`, `deferredActivities`, `discountCodes`, `emailVerifications`, `followUps`, `infringementReports`, `auditLogs`, `adminCustomerDocuments`, top-level `marketingMaterials`, `printNotifications`, `productReviews`, `reviewRequests`, `reviewSuppressions`, `shops/*/legalAcceptances` | Each still gets a fate, because docs may appear before the freeze. |
| **`legalAcceptances` = 0** | melodie-mc's seller legal acceptance has not happened. Its checkout gate stays closed until it does. |
| podArtwork 20 docs vs Storage originals 20 / previews 17 / **print 13** | 7 artworks have no print master (row 43). |
| Storage: **1,162 objects, 1,861 MB, one bucket** `b8shield-reseller-app.firebasestorage.app` (`…appspot.com` → 404 "bucket does not exist") | 370 legacy-flat product images and 318.7 MB of legacy marketing material (§b). |

---

## 1. The manifest (75 rows)

| # | Collection / doc | Fate | Target | Id strategy | Fields carried (reader) | Storage URL/path fields → class | Timestamps → ISO (§2.8) | Verify after import | Docs in prod (2026-09-26) | Notes / risks |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `activities` | archive | `archive/firebase/activities/` | preserve (in archive) | — (Dining CRM wagon, DELETE §3.3; `useDiningActivities.js:113`) | — | kept typed | archive count = 2 | 2 | Platform-only rule `firestore.rules:774`. |
| 2 | `adminCustomerDocuments` | archive | `archive/firebase/adminCustomerDocuments/` | preserve | — (`adminDocuments.js:121`, `AdminUserCreate.jsx:155`; deleted feature) | `storagePath`/download URL → `admin-documents/…` (private, archived) | kept typed | count at freeze | 0 (absent) | 8 legacy-flat objects exist in Storage without docs (§b row 15). |
| 3 | `adminPresence` | **drop** | — | — | — (heartbeat, `useAdminPresence.js:53,77`) | — | — | — | 6 | PLAN §4 drop list (presence). |
| 4 | `adminUIDs` | archive | `archive/firebase/adminUIDs/` | preserve | — (parallel registry, `adminUIDManager.js:47-69`; no function reads it) | — | kept typed | count = 5 | 5 | Superseded by `identity_access`. Archived as who-was-admin evidence; not carried. |
| 5 | `affiliateApplications` | archive | `archive/firebase/affiliateApplications/` | preserve | — (affiliate is PORT-LATER, spec `specs/AFFILIATE.md`) | — | kept typed | count at freeze | 0 (absent) | Anonymous-create rule `:613`; PII (email). |
| 6 | `affiliateClicks` | archive | `archive/firebase/affiliateClicks/` | preserve | — | — | kept typed | count at freeze | 0 (absent) | Server-written (`logAffiliateClickV2`). |
| 7 | `affiliatePayouts` | archive | `archive/firebase/affiliatePayouts/` | preserve | — (`affiliatePayouts.js:90`) | invoice URL → `affiliates/{shop}/{id}/invoices/…` (private, archived) | kept typed | count at freeze | 0 (absent) | 6 legacy-flat invoice objects exist (§b row 19). |
| 8 | `affiliates` | archive | `archive/firebase/affiliates/` | preserve | — | — | kept typed | count at freeze | 0 (absent) | Doc id = Firebase uid. The archive keeps the legacy uid (map in §a). |
| 9 | `ambassadorActivities` | archive | `archive/firebase/ambassadorActivities/` | preserve | — (CRM wagon, DELETE) | — | kept typed | count = 4 | 4 | — |
| 10 | `ambassadorContacts` | archive | `archive/firebase/ambassadorContacts/` | preserve | — | — | kept typed | count = 1 | 1 | Client reads it (`useAmbassadorActivities.js`) but there is **no rule**, so it falls to default deny. |
| 11 | `appSettings` | archive | `archive/firebase/appSettings/` | preserve | — (`translationSettings`, rule `:797`) | — | kept typed | count = 1 | 1 | Global operator tooling. |
| 12 | `auditLogs` | **carry** | `audit_events`† (0001) | preserve (`event_id` = Firestore id) | shopId→`tenant_id`, action, actor uid (uid→map, legacy uid kept in `metadata_json`), target/resource ids, reason, metadata (`takedownProduct.ts:71-110`; `customer-admin` entries share the shape) | — | `createdAt`/`at` | count = source; append-only trigger accepts INSERT | 0 (absent) | Written only by `takedownProduct`/B2C delete. Insert-only import; never UPDATE. |
| 13 | `b2bCustomers` | archive | `archive/firebase/b2bCustomers/` | preserve | — (B2B is PORT-LATER) | — | kept typed | count = 2 | 2 | PII; `firebaseAuthUid` refs stay legacy (map exported with the archive). |
| 14 | `b2cCustomers` | archive | `archive/firebase/b2cCustomers/` | preserve | — (B2C accounts PORT-LATER; guest checkout stays) | — | kept typed | count at freeze | 0 (absent) | GDPR erasure tool must exist before B2C accounts return (`INVENTORY_FUNCTIONS` §2.1). |
| 15 | `campaignParticipants` | archive | `archive/firebase/campaignParticipants/` | preserve | — | — | kept typed | count at freeze | 0 (absent) | Server-only, no rule. |
| 16 | `campaignRevenueTracking` | archive | `archive/firebase/campaignRevenueTracking/` | preserve | — | — | kept typed | count at freeze | 0 (absent) | Dead path (`processUniversalCampaignRevenue`). |
| 17 | `campaigns` | archive | `archive/firebase/campaigns/` | preserve | — (campaign wagon, DELETE) | — | kept typed | count at freeze | 0 (absent) | — |
| 18 | `checkouts` | archive | `archive/firebase/checkouts/` | preserve (= PI id) | — | — | kept typed | count at freeze; **every PI terminal** | 0 (absent) | Precondition P4 (§d): all PaymentIntents cancelled or terminal before the freeze export. Holds the P1-16 production snapshot and customer email. |
| 19 | `checkoutSuppressions` | archive | `archive/firebase/checkoutSuppressions/` | preserve | — (reminder add-on PORT-LATER) | — | kept typed | count at freeze | 0 (absent) | Consent/suppression record. It **must be restored** before reminders are re-enabled. |
| 20 | `collections` | **carry** | `collections` + `collection_products` (new, CP4) | preserve | shopId, title, handle, description, imageUrl, type (`manual`/`smart`), productIds[], rule.tag, published, featured, sortOrder (writer `AdminCollectionEdit.jsx:165-179`; readers `PublicStorefront.jsx:124`, `ProductCollectionPage.jsx:44`, `CollectionPage.jsx:40`, `AdminMenu.jsx:129`) | `imageUrl` → **public** (`collections/{shop}/cover_*`), rewritten | createdAt, updatedAt | count per shop: gif 6 / melodie 7 / ninetone 6. `handle` unique per tenant. Every `productIds[]` resolves in the same tenant (dangling → dropped + reported). 0 Firebase URLs left. | 19 | Handle uniqueness is enforced client-side only today, so a collision aborts the import. |
| 21 | `customerDocuments` | archive | `archive/firebase/customerDocuments/` | preserve | — (Dining `DocumentCenter.jsx:119`) | `storagePath` → `marketing-materials/{shop}/customers/{id}/crm-documents/…` (private, archived) | kept typed | count = 1 | 1 | — |
| 22 | `dac7CorrectionRequests` | archive | `archive/firebase/dac7CorrectionRequests/` | preserve | — (DAC7 PORT-LATER) | — | kept typed | count at freeze | 0 (absent) | — |
| 23 | `dac7Sellers` | archive | `archive/firebase/dac7Sellers/` | preserve (= shopId) | — | — | kept typed | count = 1 | 1 | **Sensitive PII** (tax id, DOB). DAC7 due diligence is due by 31 Dec 2026, so DAC7 must port, or this must be restored, before then (§f Q8). |
| 24 | `deferredActivities` | archive | `archive/firebase/deferredActivities/` | preserve | — | — | kept typed | count at freeze | 0 (absent) | — |
| 25 | `diningActivities` | archive | `archive/firebase/diningActivities/` | preserve | — (**no reader or rule on `main`**) | — | kept typed | count = 17 | 17 | Pre-rename Dining CRM, B8shield era. Candidate for outright deletion (§f Q5). |
| 26 | `diningContacts` | archive | `archive/firebase/diningContacts/` | preserve | — (no reader or rule) | — | kept typed | count = 10 | 10 | Reseller contact PII. Same as row 25. |
| 27 | `diningDeferredActivities` | archive | `archive/firebase/diningDeferredActivities/` | preserve | — (no reader or rule) | — | kept typed | count = 1 | 1 | Same as row 25. |
| 28 | `diningFollowUps` | archive | `archive/firebase/diningFollowUps/` | preserve | — (no reader or rule) | — | kept typed | count = 2 | 2 | Same as row 25. |
| 29 | `discountCodes` | archive | `archive/firebase/discountCodes/` (→ `discount_codes`† when the add-on ports) | preserve | — (PORT-LATER) | — | kept typed | count at freeze | 0 (absent) | If a code is created before the freeze, it is restored when the add-on ports. |
| 30 | `emailVerifications` | **drop** | — | — | — | — | — | — | 0 (absent) | Hash-keyed codes. Replaced by the Better Auth `verification` table. |
| 31 | `followUps` | archive | `archive/firebase/followUps/` | preserve | — | — | kept typed | count at freeze | 0 (absent) | — |
| 32 | `impersonationAudit` | archive | `archive/firebase/impersonationAudit/` | preserve | — (actorUid, actorEmail, shopId, shopName, reason, startedAt, expiresAt, endedAt, endReason, userAgent: `impersonationAudit.js:28-39`) | — | kept typed | count = 269 (melodie 214, sillmans 33, ninetone 11, gif 10, robowatz 1) | 269 | Replaced by server-minted acting-as sessions audited in `audit_events` (PLAN §2.1). Carrying it into `audit_events` is §f Q3. |
| 33 | `infringementReports` | **carry** | `infringement_reports` (new, CP3) | preserve | shopId, productId, productName, productUrl, reporterName, reporterOrg, reporterEmail, rightType, description, attestation, status, source, note, handledBy (uid→map) (`submitInfringementReport.ts:152-164`; `PlatformReports.jsx:540-545`) | — (`productUrl` is a storefront URL, not Storage) | createdAt, handledAt | count = source; each `productId` resolves (taken-down products included) | 0 (absent) | Reporter PII, platform-only read (`:820`). |
| 34 | `leads` | archive | `archive/firebase/leads/` | preserve | — (`submitLead` PORT-LATER) | — | kept typed | count = 1 | 1 | Prospect PII. |
| 35 | `marketingMaterials` (top-level) | archive | `archive/firebase/marketingMaterials/` | preserve | — (add-on PORT-LATER; `marketingMaterials.js:113,363`) | `downloadURL`/`storagePath` → `marketing-materials/{shop}/generic/…` (private, archived) | kept typed | count at freeze | 0 (absent) | 42 legacy-flat generic objects (107.9 MB) exist without docs (§b row 16). |
| 36 | `migrations` | archive | `archive/firebase/migrations/` | preserve | — (migrators PORT-LATER; progress doc `migrationShared.ts:219`) | — | kept typed | count = 1 | 1 | gif-sundsvall import. |
| 37 | `orderProduction` | archive | `archive/firebase/orderProduction/` | preserve (= order id) | — (A13 money half: per-line printerUid, frozen costs, `printStoragePath`, `artworkVersion`, Connect fee split) | `printStoragePath` → **production** class (the referenced print masters are copied into the production archive, §b row 9) | kept typed | count = 4 | 4 | PLAN §4 archive. Server-only, no client rule (`:847`). |
| 38 | `orderStatuses` | archive | `archive/firebase/orderStatuses/` | preserve | — (dead global config, rule `:527`) | — | kept typed | count = 9 | 9 | — |
| 39 | `orders` | archive | `archive/firebase/orders/` | preserve (= PI id) | — | `items[].image` (product image URLs) **not rewritten** in the archive; snapshot `printStoragePath` → production archive | kept typed | count = 9; status breakdown = 9 `refunded`; Σ totals recorded in the manifest | 9 | Accounting records: retention ≥ 7 years (Bokföringslagen), so there is no R2 lifecycle delete. D1 `orders` must be **empty** at go-live (§d P2). DAC7 2026 reads orders (§f Q8). |
| 40 | `pages` | **carry** | `pages` (new, CP4) | preserve | shopId, title, slug, content (HTML), status, metaTitle, metaDescription, attachments[] {id, name, displayName, url, size, type, uploadedAt, uploadedBy, isPublic, storagePath}, createdBy/updatedBy (uid→map) (`AdminPageEdit.jsx:67-79,175-184`; `fileUpload.js:75-88`; readers `DynamicPage.jsx`, `DynamicRouteHandler.jsx:70`, `ShopFooter.jsx:48`, `AdminSettings.jsx:200`, `AdminMenu.jsx:130`) | `attachments[].url`/`storagePath` → **public** (`pages/{shop}/{page}/attachments/…`), rewritten. **Also any Storage URL embedded inside `content` HTML** (string scan). | createdAt, updatedAt (Timestamp); `attachments[].uploadedAt` (already ISO) | count = 2 (ninetone); `(tenant, slug)` unique; 0 Firebase URLs in `content` or attachments | 2 | `content` is rendered as HTML (`DynamicPage`). The rewrite must not alter anything but URLs. |
| 41 | `passwordResets` | **drop** | — | — | — | — | — | — | 1 | Credential material: never archived. Better Auth reset replaces it. |
| 42 | `pod3dModels` | **carry** | `pod_3d_models` (new, CP6; `views_json`) | preserve | label, scope, active, views{view:{w, h, printArea, originalDims, colorways{cw:{label, photoUrl, displacementUrl, maskUrl, originalPaths}}}}, printAreaMm, displacementScale/Blur/Contrast, blend, alpha, perColorway, output (`config/pod3dModels.js:13-37`; writers `ModelEditor.jsx:57`, `PlatformModels.jsx:58-88`) | `photoUrl`, `displacementUrl`, `maskUrl` → **public** (`pod-3d-models/…/{photo,map,mask}-1600`), rewritten. `originalPaths.*` → **private** (`…/originals/…`), key only. | createdAt, updatedAt | count = 6; 12 derivatives + 12 originals copied with checksums; every colorway URL rewritten | 6 | Platform-owned library, no shopId. Keys go under a platform prefix, not `shops/{tenant}/` (§b). |
| 43 | `podArtwork` | **carry** | `pod_artwork`† (0012, remodel CP2) + `stored_objects`† per file | preserve | shopId, label, purpose (=profileId), fileName, fileSizeBytes, mimeType, ext, sha256, rightsConfirmed, createdBy (uid→map), status, sourceWidthPx, sourceHeightPx, validation{gate, tier, effectiveDpi, maxPrintMm, notices, reasons, checkedAt, profileId, pipelineVersion} (`processArtwork.ts:285-305`; `ArtworkUploadModal.jsx:167-197`; `podUpload.js:84-91`; snapshot reader `printProjection.ts:591-624`) | `originalUrl`/`originalStoragePath` → **private**. `printUrl`/`printStoragePath` → **private** (server-owned master; copied to **production** when an order freezes it). `previewUrl`/`previewStoragePath` → **private**. Token URLs are **not carried**; they become `stored_objects` ids / R2 keys. | createdAt, updatedAt (Timestamp); `validation.checkedAt` (ISO) | count = 20 (melodie 15, sillmans 4, gif 1). Objects found: originals 20, previews 17, **print 13**. **7 rows have no print master** → import as a non-`ready` state and report. Original sha256 = stored `sha256` where present. `artworkVersion` = print-file uuid preserved. | 20 | 0012 CHECK "ready ⇒ all output fields" rejects the 7 rows if they are mapped to `ready`. Screening depends on `fileName`+`label` (rename → rescreen). |
| 44 | `podMappings` | **carry** | `pod_mappings` (new, CP2) | preserve | shopId, sku, artworkId, profileId, placement, placementSlot, position, slotLabel, garment (`podMappings.js:58-80`; `printProjection.ts:583-624`; screening `screenProductOnWrite.ts`) | — | createdAt, updatedAt | count = 18 (melodie 15, sillmans 3); every `artworkId` resolves in the same tenant; **`garment` present on every row** (a missing field routes to no printer → 409); unique `(tenant, sku, placementSlot)` | 18 | `where(garment==null)` = 0, but rows *missing* the field are not counted by that query. The garment backfill dry-run is still pending (memory). |
| 45 | `printerCatalog` | **carry** | `printer_catalog` (new, CP3; platform-only, never tenant-readable) | preserve (`snapwear`) | models, skus, source, pricingBasis{eurSek, buffer, extraPrintEur, baseEur, source}, importedAt (`seed-snapwear-printer.cjs:274-285`) | — | importedAt / source.generatedAt | canonical-JSON sha256 equal before and after | 1 | "Never show our hand": no route may expose it. |
| 46 | `printers` | **carry** | `printers` (new, CP3) | **preserve verbatim** (opaque printer key; 2 of 3 ids are Firebase uids and are **not** remapped, because routing, `products.podPrinterUid` and archived snapshots reference them) | name, type, active, garments[], pricing{blankCostSek, printCostSek}, shippingSek, printAreasMm, provisionalAreas, catalog, updatedBy (uid→map) (`printRouting.ts:34-59`; `PlatformPrinters.jsx:214-222`; `seed-snapwear-printer.cjs:256-268`; projection `projectPrinterPublic.ts`) | — | updatedAt | `snapwear`: type=`api`, active=true, pricing byte-equal, `shippingSek` 0 (placeholder until C8). The 2 uid-keyed tiers are checked against §f Q2. | 3 | Seller reads go through the price-free projection (A13) computed at read time. |
| 47 | `printersPublic` | **drop** | — (read-time allowlisted SELECT) | — | — | — | — | Used as the verify oracle for the projection before dropping | 3 | Projection. |
| 48 | `printNotifications` | **drop** | — (replaced by `outbox_events`†) | — | — | — | — | **0 pending at the freeze** | 0 (absent) | Precondition P4: nothing pending. Orders are archived, so no dispatch state is carried. |
| 49 | `productGroups` | archive | `archive/firebase/productGroups/` | preserve | — (legacy, "no client reader", rule `:216-223`) | — | kept typed | count = 1 | 1 | — |
| 50 | `productReviews` | archive | `archive/firebase/productReviews/` | preserve | — (reviews PORT-LATER) | — | kept typed | count at freeze | 0 (absent) | `products.reviewCount/ratingSum` are carried on products (row 51). |
| 51 | `products` | **carry** | `products`† + `product_variants`† (0005, extended CP4/5) | preserve product id. Variants get a deterministic id `v_` + sha256(productId + variant sku)[:20]. | **Public allowlist** (`projectProduct.ts:31-50,77-117`): name, sku, category, group, tags, featured, sortOrder, hasVariants, b2cPrice, basePrice, compareAtPrice, b2cImageUrl, b2cImageGallery, imageUrl, size, color, description, descriptions.{b2c, b2cMoreInfo}, delivery.{shipping, pickup}, reviewCount, ratingSum, launchDate, sizeGuide, isPersonalized, weight, shipping, stock, brand, eanCode, isActive, availability.b2c, variants[{sku, label, price, image, images, group, size, optionValues}], variantGroups[{label, sku, price, image, images, sizes}], options[{name, values}]. **Internal** (`ProductForm.jsx:920-963`; `DesignStudio.jsx:960-983`; `createPaymentIntent.ts` product reads): shopId, isPodProduct, podCostSek, podPrinterUid, b2bPrice, availability.b2b, dimensions. **Moderation** (`screenProductOnWrite.ts:15,133`; `takedownProduct.ts:100`; `PlatformReports.jsx:546-550`): screening{status, hits, earlierHits, at, source, clearedAt, clearedBy (uid→map)}, takedown{reportId, at, by (uid→map), note} → `takedown_at` + columns (§2.4). | imageUrl, b2cImageUrl, b2cImageGallery[], variants[].image/images[], variantGroups[].image/images[] → **public** (`products/{shop}/…`, possibly legacy `products/{id}/…`), rewritten. Non-Storage URLs (Shopify CDN, `/images/…`) are left alone and reported. | createdAt, updatedAt, screening.at, screening.clearedAt, takedown.at. `launchDate` is date-only (ProductForm stores `new Date('YYYY-MM-DD')`) → `YYYY-MM-DD`. | total 217 (gif 123, ninetone 58, sillmans 24, melodie 12, robowatz 0). **The §2.4 public predicate returns exactly the 205 ids in `productsPublic`** (gif 113, ninetone 58, sillmans 22, melodie 12). isPodProduct = 6. `(tenant, sku)` unique for products and variants (collision → abort). Takedown/screening stamps preserved. podCostSek/podPrinterUid unchanged. **0 Firebase URLs left.** | 217 | Prices are kr floats on the doc; D1 wants integer öre, so convert with an exact-rounding check and report any non-integer öre. Variants are embedded arrays keyed by sku, and orders reference `variantSku`. |
| 52 | `productsPublic` | **drop** | — (PLAN §2.4 predicate) | — | — | — | — | Exported to a transient verify file (not archived) as the oracle for row 51 | 205 | Projection. |
| 53 | `rateLimits` | **drop** | — (`rate_limit_windows`† starts empty) | — | — | — | — | — | 1 | PLAN §4 drop list. |
| 54 | `reviewRequests` | archive | `archive/firebase/reviewRequests/` | preserve | — | — | kept typed | count at freeze | 0 (absent) | Email + items. |
| 55 | `reviewSuppressions` | archive | `archive/firebase/reviewSuppressions/` | preserve | — | — | kept typed | count at freeze | 0 (absent) | Consent record. Restore before review mails return. |
| 56 | `shops` | **carry** | `tenants`† (0001, extended) + `tenant_domains`† + `tenant_settings` (`store_identity_json` + extracted gate columns) + `tenant_features` + `tenant_payments` + `tenant_legal` (new, CP2/CP3) | **preserve** (shopId = `tenant_id`) | name, status, published, shopType, ownerUid (uid→map; null today), provisionedVia (`ProvisionShopModal.jsx:115-133`; `ShopGate.jsx:87,114`; `ShopPicker.jsx`) · **features**{key: bool} (`shopConfig.js:61`; opt-in keys `pod`/`contentStudio`/`marketingMaterials`, `shopFeatures.ts:22-40`) · **storeIdentity** whole object (keys `config/store.js:13-133`; `menu[]{type, target, label}` `AdminMenu.jsx:202-203`; `legal{acceptance{uid, email, acceptedAt, templateVersion, acceptanceId}, custom, customUpdatedAt}` `legalAcceptance.js:98-110`, `AdminPageEdit.jsx:196`; `pickupLocations[]{id, name, address, hours, dates[]}`; returnAddress, vatRegistered, vatNumber, sellerType (`dac7/functions.ts:95`); shopName, supportEmail, contactEmail, notificationEmail, logoUrl, emailLogoUrl, faviconUrl, heroImageUrl, templateId, theme, accent; gate readers `createPaymentIntent.ts:45-71,83,554`; mail `EmailOrchestrator.ts:428-436`) · **payments**{connectEnabled, stripeAccountId, connectStatus, chargesEnabled, payoutsEnabled, detailsSubmitted, requirementsDue[], commissionBps, payoutDelayDays, onboarding stamps} (`connectOnboarding.ts:74-82,151-160,247,316`; `connectParams.ts:66-89`; `createPaymentIntent.ts:752`; `PlatformShopDetail.jsx:156`) · **platformTerms**{uid, email, acceptedAt, version, acceptanceId} (`legalAcceptance.js:156`; `PlatformTermsGate.jsx:121`) · cartRecovery, productReviews (`shopConfig.js:106,144`; PORT-LATER add-ons, carried inert inside JSON) | storeIdentity.logoUrl, heroImageUrl, faviconUrl, emailLogoUrl → **public** (`branding/{shop}/…`, plus 5 legacy-flat `branding/*`), rewritten. Emails need absolute public URLs. | `createdAt` (Timestamp); **`updatedAt` is an ISO string** (client `setDoc`, `shopConfig.js:91,132,169`: mixed shape); payments.onboardingStartedAt/onboardingCompletedAt/lastSyncedAt/payoutDelayUpdatedAt (Timestamp); legal.acceptance.acceptedAt, legal.customUpdatedAt, platformTerms.acceptedAt (ISO strings). **Date-only:** pickupLocations[].dates[] kept `YYYY-MM-DD`. | 5 tenants. Per shop: `stripeAccountId` is a connected account of the **live** platform account (preflight). `commissionBps` exact (null → platform default). `chargesEnabled`/`payoutsEnabled` **re-pulled from Stripe**, not trusted from the mirror. status/published unchanged. `features.pod` explicit. Legal gate fields + `platformTerms.version` equal to the export. | 5 | storeIdentity is free-form and merge-written. Keep the full JSON and extract only what the server gates on. Features semantics are default-ON except the opt-in keys, so materialise effective values for ported keys and archive the raw map (§f Q9). |
| 57 | `socialPosts` | archive | `archive/firebase/socialPosts/` | preserve | — (Content Studio PORT-LATER; `AdminContentStudio.jsx:741-765`) | `assets[].path` → `content-studio/{shop}/uploads/…`; `video.path`/`video.url` → `…/renders/…` (private, archived) | kept typed | count = 3 | 3 | createdBy = uid (legacy kept). |
| 58 | `translations_en_GB` | **carry** | `translations` (new, CP4; PK `(locale, key)`) | natural key (doc id = translation key) | doc id + `value` (fallback `translation`) (`TranslationContext.jsx:79-111`; `credentialTranslations.js:62-64`; `translationDetection.js:32-37`) | — | none read | count = 1365 | 1365 | Public read. Likely holds B8shield-era strings (§f Q7). |
| 59 | `translations_en_US` | **carry** | `translations` | natural key | same | — | none read | count = 1364 | 1364 | **One key fewer** than sv_SE/en_GB. Identify it at export. |
| 60 | `translations_sv_SE` | **carry** | `translations` | natural key | same | — | none read | count = 1365 | 1365 | Same as row 58. |
| 61 | `userMentions` | archive | `archive/firebase/userMentions/` | preserve | — (Dining wagon) | — | kept typed | count = 6 | 6 | — |
| 62 | `users` | **carry** (admins) | Better Auth `user`† / `account`† + `identity_access`† + `tenant_memberships`† (+ `print_memberships`† deferred) + `legacy_id_map` (new) | **new + map** (§a) | email, contactPerson (→ name), role, platform, shopId, active, isActive, printShopShops[], preferredLang, createdByPlatform (`AuthContext.jsx:119-129,183-184`; `authGuard.ts:55-65`; `printGuard.ts:36-41`; `createShopUser.ts:98-110`; `platformUsers.ts:102-109`; `print/functions.ts:230-240`; `PlatformUsers.jsx`). Firebase Auth record: email, emailVerified, disabled, displayName (read-only `listUsers`). | — (`users/{uid}/profile.jpg`: 0 objects, no field) | createdAt, updatedAt; Auth metadata creationTime/lastSignInTime | 2 `platform_admin` + 1 `tenant_admin` (melodie-mc) + membership. No password carried. Lockout guard: ≥ 1 active platform admin. Every mapped uid reference resolves. | 6 (13 refs incl. 7 phantom parents) | 3 `print_shop` users (§f Q2). **Forced reset** for everyone (§a). |
| 63 | `userWagonSettings` | archive | `archive/firebase/userWagonSettings/` | preserve (= uid) | — (`WagonRegistry.js:280`) | — | kept typed | count = 13 | 13 | Wagon UI prefs. Wagons are retired or deferred. |
| 64 | `wagonConfigurations` | archive | `archive/firebase/wagonConfigurations/` | preserve | — (**no reader or rule on `main`**) | — | kept typed | count = 1 | 1 | B8shield-era orphan. |
| 65 | `shops/{id}/legalAcceptances` | **carry** | `legal_acceptances` (new, CP2; append-only triggers) | preserve (the shop pointer `acceptanceId` references it) | type (`legalPages` / `platformTerms`), shopId, uid (**kept verbatim** + mapped `user_id` column), email, acceptedAt, acceptedAtIso, templateVersion, version, pod, custom, texts{…} (HTML snapshot), userAgent (`legalAcceptance.js:39-44,88-96,138-145`) | none. **No URL rewrite inside `texts`**: evidence is immutable. | acceptedAt (Timestamp → `accepted_at`); `acceptedAtIso` kept verbatim as evidence | count per shop = source. sha256(canonical `texts`) equal before and after. Each tenant pointer `acceptanceId` resolves. | 0 | melodie-mc's checkout gate needs a `legalPages` row. If Kent accepts before the freeze, it carries with the original uid. |
| 66 | `users/{id}/marketingMaterials` | archive | `archive/firebase/users__marketingMaterials/` | preserve (path kept) | — | `downloadURL`/`storagePath` → legacy `marketing-materials/customers/…` (private, archived) | kept typed | count = 24 | 24 | 21 docs sit under 7 **phantom** (purged) users, 3 under `9AudFilG8VeYHcFnKgUtQkByAmn1`. Reseller era. |
| 67 | `settings/platform` | **carry** (created by the go-live script) | `platform_settings` (new, CP2) | natural key | defaultCommissionBps, refundApplicationFee, reverseDisputeOnCreated (`platformConfig.ts:51-67`; readers `createPaymentIntent.ts:759-761`, `connectRefund.ts`, `stripeWebhook.ts`) | — | updatedAt | **refundApplicationFee = false**, defaultCommissionBps = 500, reverseDisputeOnCreated = true (§e) | **absent** | Today Firebase runs on defaults (`refundApplicationFee=true`). There is no doc to import; values are **set explicitly** by script (§f Q1). |
| 68 | `settings/app` | **carry** (n/a) | — | — | (storeIdentity fallback, `shopConfig.js:22`) | — | — | Absent at the freeze too | **absent** | Nothing to import. The fallback seam is deleted with the SDK. |
| 69 | `settings/printRouting` | **carry** | `print_routing` (garment → printer_id) + `platform_settings.default_printer_id` (new, CP3) | natural key (garment) | byGarment{garment: printerId}, defaultPrinterUid, updatedBy (uid→map) (`printProjection.ts:147-160`; `PlatformPrinters.jsx:270-275`; `seed-snapwear-printer.cjs:286-289`) | — | updatedAt | **defaultPrinterUid = `snapwear`**; every byGarment target ∈ `printers` and active; no route to a uid printer | 1 (created 2026-09-26 07:53) | Kim was removed 2026-09-25, so the seed routes everything to snapwear. |
| 70 | `settings/podProfiles` | **carry** | `pod_profiles`† (0012; remodel to per-printer areas, CP2) | natural key (profile id) | profiles[] {id, label, min_dpi, print_area_mm, max_file_mb, accepted_formats, …}, version, provisional (`processArtwork.ts:109-114`; `config/podProfiles.js:28-40`) | — | — (updated 2026-07-27) | Every profile id referenced by `podArtwork.purpose`/`validation.profileId` and `podMappings.profileId` exists | 1 | Front area 300 mm (`500a664`) vs the branch seed 250. Re-derive from the doc, not the branch. |
| 71 | `settings/podMockupTemplates` | **carry** | `pod_mockup_templates` (new, CP6; JSON) | natural key (template id) | templates[] (garment, colorways, `urls`/`backUrls`, print areas px+mm), version, provisional (`config/podMockupTemplates.js:95-103`; `seed-pod-mockup-templates.cjs:98-156`) | none. URLs are **static web assets** `/pod-garments/*` (94 tracked files), served by `chopshop-web`, not Storage. | — (updated 2026-09-26 08:08) | Template count = source; every `url` 200 on the web Worker | 1 | — |
| 72 | `settings/contentScreening` | **carry** | `screening_terms` + `platform_settings` (new, CP2) | natural key (term) | blocklist[{term, kind, note, hardBlock?}], reviewFirstProducts, hardBlock (`screenProductOnWrite.ts:94-98`; `contentScreening.ts:17,70`; `loadContentScreening.js:13-14`; `seed-content-screening.cjs:14-18`) | — | updatedAt | **blocklist count = source doc** (the seed defines 63 terms). reviewFirstProducts = 2, hardBlock = false. | 1 (created 2026-09-26 07:49) | — |
| 73 | `settings/SdYOaQ7bqCrKT38V969d` | archive | `archive/firebase/settings/` | preserve | — (no reader on `main`) | — | kept typed | present in archive | 1 (created 2025-06-17) | Auto-id B8shield-era doc. Content not inspected. |
| 74 | `settings/riPDNohPyWiyfnfMAKMK` | archive | `archive/firebase/settings/` | preserve | — (no reader) | — | kept typed | present in archive | 1 (created 2025-04-23) | Same as row 73. |
| 75 | `settings/zSVmicFaCtWPf7OEwfxC` | archive | `archive/firebase/settings/` | preserve | — (no reader) | — | kept typed | present in archive | 1 (created 2025-06-24) | Same as row 73. |

**Totals:** 75 rows = 64 top-level collections + 2 subcollections + 9 `settings/*` docs.
- **carry:** 22 rows (incl. `settings/app` n/a and `settings/platform` created by script)
- **archive:** 46 rows
- **drop:** 7 rows (`adminPresence`, `emailVerifications`, `passwordResets`, `printersPublic`, `printNotifications`, `productsPublic`, `rateLimits`)

---

## (a) Users: id map, what carries, forced reset

**Source of identity.** The source is the Firebase Auth user record (read-only `auth.listUsers()`: email, emailVerified, disabled, displayName, metadata) **joined** to `users/{uid}`. The Auth email wins, because it is globally unique per project. A mismatch with `users.email` is reported, not silently resolved.

**Id map.** New D1 table `legacy_id_map(kind TEXT, legacy_id TEXT, new_id TEXT, env TEXT, created_at TEXT, PRIMARY KEY(kind, legacy_id))`, with `kind='user'`.
- New ids are generated **once** per environment and persisted. A re-run looks up the map first, which makes the import idempotent. Staging and production maps are separate.
- The production map is also written to `archive/firebase/_maps/user-id-map.json`, so archived documents (orders, `b2bCustomers.firebaseAuthUid`, `socialPosts.createdBy`, …) can be joined later.
- Printer ids are **not** users and are never remapped (row 46).

**Role → identity** (branch model `0002_auth_identity.sql`; `live-authorization.ts`):

| Firestore `users` doc | `identity_access.account_type` | Membership | Prod count |
|---|---|---|---:|
| `role=='admin' && platform===true && shopId==null` | `platform_admin` | — | 2 |
| `role=='admin' && platform!==true && shopId==S` | `tenant_admin` | `tenant_memberships(S, 'admin', 'active')` | 1 (`melodie-mc`) |
| `role=='print_shop'` | `print_operator` | `print_memberships` per `printShopShops[]` ∩ pod-enabled | 3 (**deferred**: the print portal is PORT-LATER; these are not recreated at launch, see §f Q2) |
| anything else | not carried | — | 0 |

**Suspension.** `identity_access.status='suspended'` when `active !== true` **or** `isActive !== true` **or** Auth `disabled`. Today all 6 are active.
- A user that would need two account kinds breaks the branch's one-kind boundary, so the run aborts.
- The last-platform-admin guard (`deletePlatformUser`) becomes an import assertion: ≥ 1 active `platform_admin`.

**Fields carried:** email, name (`contactPerson` ‖ Auth displayName ‖ email local part), emailVerified, preferredLang, createdByPlatform, createdAt.
**Not carried:** password hashes (forced reset), custom claims (`syncUserClaimsOnWrite` is deleted), `adminUIDs`, presence, sessions.

**Uid references rewritten through the map:**
- `pages.createdBy`/`updatedBy`
- `podArtwork.createdBy`
- `products.screening.clearedBy`, `products.takedown.by`
- `infringementReports.handledBy`
- `printers.updatedBy`, `settings/printRouting.updatedBy`
- `shops.ownerUid`
- the pointers `storeIdentity.legal.acceptance.uid` and `platformTerms.uid`
- the `auditLogs` actor

**Evidence rows** (`legalAcceptances.uid`) keep the legacy uid verbatim and gain a mapped `user_id` column. An unmappable uid (a user who is not carried) keeps its value in a `*_legacy_uid` column with the mapped column NULL, and is reported.

**Forced reset flow.**
1. The import creates `user` plus `account(providerId='credential', password=NULL)`. Sign-in with a password fails with the generic error, and the UI offers "set a new password".
2. The import enqueues one migration invite per carried user into `email_deliveries`† (kind `password_reset`). The link is a Better Auth reset token with a **migration-only 72 h expiry**; ordinary resets keep the short default. It is sent under the **ChopShop platform** identity (all carried users are admins, not customers) and scoped to the admin/platform origin it will be used on (PLAN §2.1).
3. **Staging first** (PLAN §4): run the import with every email rewritten through an allowlisted `--email-map` to addresses Mikael controls. Exercise delivery via Resend, the link origin, single use, expiry, and resend-on-demand. No real user address can be mailed from staging (§d S3).
4. **Production:** invites go out only after the admin hostname points at CF (CP7 runbook). Go-live requires ≥ 1 platform admin to have completed the reset and signed in (§e). Firebase sessions are not carried; everyone signs in again.

---

## (b) Storage: path families, class, URL rewrite

Census: 1,162 objects, 1,861.3 MB, single bucket `b8shield-reseller-app.firebasestorage.app`.

**Copy mechanics:**
- A server-side script streams GCS → R2 through the S3 API with multipart upload. It does **not** go through the Worker upload route, which caps at 100,000,000 bytes, and print PNGs average 51 MB.
- For each object it computes sha256 and md5, checks the md5 against GCS `md5Hash`, and uploads with the sha256 checksum so that R2 verifies it.
- It writes one line per object to `storage-copy-manifest.jsonl`: src path, size, md5, sha256, class, dst bucket, dst key, `object_id`.
- Verify = HEAD every destination object: size and checksum equal.

**Key scheme:**
- Tenant objects: the branch's `shops/{tenant}/{kind}/{objectId}/v1/{safeName}`.
- Platform assets (3D models): `platform/{kind}/{objectId}/v1/{safeName}`.
- Archives: `archive/firebase-storage/<original path>`.

Only objects referenced by a **carried** field are copied into live keys. Everything else under an archived family is copied to the archive prefix.

| # | Path family (source) | Class | Objects / MB | Stored URL field(s) | Rewritten? |
|---|---|---|---:|---|---|
| 1 | `products/{shopId}/{productId}/{imageType}_{ts}_{name}` (ProductForm, `imageUpload.js:83`) + DesignStudio `b2c_main`/`mockup_*`/`studio_*` (`DesignStudio.jsx:730,819-829`) + migrator `img_{idx}` (`migrateFromShopify.ts:244`, `migrateFromWoo.ts:206`) | public | 500 / 320.0 (gif 179, ninetone 185, melodie 133, sillmans 3) | products.imageUrl, b2cImageUrl, b2cImageGallery[], variants[].image(s), variantGroups[].image(s) | **yes** |
| 2 | `products/{productId}/…` legacy flat (pre-partition; B8shield names seen, e.g. `b2c_main_…_b8b_sq_blister_SE_emma.webp`) | public if referenced, else archive | 370 / 103.5 | same fields, where still referenced | yes if referenced; unreferenced → archive (§f Q6) |
| 3 | `collections/{shopId}/cover_{ts}_…` | public | 12 / 0.4 | collections.imageUrl | **yes** |
| 4 | `branding/{shopId}/{logo,hero}_…` (compressed) + `favicon_…` (raw) (`imageUpload.js:83,107`) | public | 19 / 1.6 | storeIdentity.logoUrl, heroImageUrl, faviconUrl, emailLogoUrl | **yes** |
| 5 | `branding/{file}` legacy flat (names include "MELODIE MC (LIVE 2).jpeg", "Melodie MC logo svart.png") | public if referenced, else archive | 5 / 2.3 | storeIdentity.* if still referenced | yes if referenced |
| 6 | `pod-artwork/{shopId}/mockups/{templateId}/{slot}-{colorwayId}` (`mockupUpload.js:18`) | public (mockup preview) | 83 / 109.4 (melodie 79, gif 4) | **none**: held only in studio state (`DesignStudio.jsx:668-675`); published mockups are copied to row 1 | no (§f Q11: copy or regenerate) |
| 7 | `pod-artwork/{shopId}/originals/{ts}_{name}` (`podUpload.js:81`) | **private** | 20 / 242.8 | podArtwork.originalUrl (dropped), originalStoragePath | → `stored_objects` id (kind `artwork_original`) |
| 8 | `pod-artwork/{shopId}/previews/{uuid}.webp` (server, `processArtwork.ts:266`) | **private** | 17 / 0.6 | podArtwork.previewUrl (dropped), previewStoragePath | → key |
| 9 | `pod-artwork/{shopId}/print/{uuid}.png` (server, `processArtwork.ts:265`) | **private** (library master) + **production** (copy per order line that froze it; archived orders → `archive/firebase-storage/…` in the production bucket, retained ≥ 24 months) | 13 / 666.4 (all melodie) | podArtwork.printUrl (dropped), printStoragePath. Snapshot lines in `orders`/`orderProduction`/`checkouts` (`printProjection.ts:613-624`) | → key; archived snapshot paths are not rewritten |
| 10 | `pod-3d-models/{model}/{view}/{cw}/{photo,map,mask}-1600` (`pod3dUpload.js:246-264`) | public | 12 / 2.1 | pod3dModels…colorways.*.photoUrl/displacementUrl/maskUrl | **yes** |
| 11 | `pod-3d-models/{model}/{view}/{cw}/originals/{photo_,map_,mask_}{name}` (`pod3dUpload.js:218-224`) | private | 12 / 70.8 | pod3dModels…originalPaths.* | → key |
| 12 | `pages/{shopId}/{pageId}/attachments/{file}` (`fileUpload.js:64`) | public | 0 / 0 | pages.attachments[].url/storagePath + URLs inside `pages.content` | yes (none today) |
| 13 | `pages/{pageId}/attachments/{file}` legacy flat (`pages/begar-utbetalning/…`, affiliate payout page) | archive | 1 / 0.06 | none carried | no |
| 14 | `admin-documents/{shopId}/customers/{id}/{ts}_{name}` (`adminDocuments.js:97`, `AdminUserCreate.jsx:134`) | private → archive | 0 / 0 | adminCustomerDocuments (archived) | no |
| 15 | `admin-documents/customers/{id}/…` legacy flat | archive | 8 / 0.75 | none | no |
| 16 | `marketing-materials/{shopId}/generic/…` (0) · legacy flat `marketing-materials/generic/…` | archive | 42 / 107.9 | marketingMaterials (archived) | no |
| 17 | `marketing-materials/{shopId}/customers/{id}/…` (0) · legacy flat `marketing-materials/customers/{id}/…` | archive | 26 / 210.9 | users/*/marketingMaterials (archived) | no |
| 18 | `marketing-materials/{shopId}/customers/{contactId}/crm-documents/…` (`DocumentCenter.jsx:102`) | archive | 0 / 0 | customerDocuments (archived) | no |
| 19 | `affiliates/{shopId}/{affiliateId}/invoices/…` (0) · legacy flat `affiliates/{uid}/invoices/…` | archive | 6 / 0.36 | affiliatePayouts (archived) | no |
| 20 | `content-studio/{shopId}/uploads/{ts}_{name}` (`AdminContentStudio.jsx:529`) | private → archive | 10 / 1.5 | socialPosts.assets[].path (archived) | no |
| 21 | `content-studio/{shopId}/renders/…` (server `renderSocialVideo.ts:428`) | private → archive | 6 / 19.9 | socialPosts.video.url/path (archived) | no |
| 22 | `content-studio-quick/{shopId}/…` (`AdminContentStudio.jsx:578`; 1-day lifecycle) | drop | 0 / 0 | none | — |
| 23 | `users/{uid}/profile.jpg` (`storage.rules:51`) | — | 0 | none | — |
| 24 | `orders/{orderId}/{file}` (`storage.rules:67`) | — | 0 | none | — |

**The rewrite:**
- Parse `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<urlencoded path>?alt=media&token=…` and `https://storage.googleapis.com/<bucket>/<path>`.
- Decode the path and look it up in the copy manifest.
- Public → `https://<public R2 domain>/<key>` (immutable, versioned). Private/production → `object_id`/key, and the URL field is removed.

**Reported, not rewritten:** unknown hosts (Shopify CDN, `/images/*`, `/pod-garments/*`). A referenced object missing from Storage aborts the run.

**Code that dies with the rewrite:**
- `ProductForm.jsx:737-742`, which parses Firebase URLs back into paths
- the `printProjection.ts:61,77` host allowlist (`firebasestorage.googleapis.com`, `storage.googleapis.com`)
- `imageOptimization.js:100-108` and `firebase/config.js:92-96`

**Token URLs bypass `storage.rules`.** Any persisted download URL is effectively public today, including gated paths such as `pod-artwork/…/originals`. The port closes this: private classes never get a URL.

---

## (c) Archive format and restore

**Location:** `chopshop-prod-private/archive/firebase/<collection>/export-<exportedAtISO>/`.
- Subcollections are flattened with `__`, e.g. `users__marketingMaterials`, `shops__legalAcceptances`.
- The same bundle, uncompressed and read-only, is the importer's input.
- The staging importer reads a **copy** in `chopshop-stg-private`.

| File | Content |
|---|---|
| `part-00001.jsonl …` | One document per line: `{ "path", "id", "createTime", "updateTime", "data" }`, max 64 MB per part. `data` uses a typed encoding so nothing is lost: Timestamp → `{"__t":"ts","s":…,"ns":…,"iso":"…Z"}`; DocumentReference → `{"__t":"ref","path":…}`; GeoPoint → `{"__t":"geo",…}`; Bytes → `{"__t":"bytes","b64":…}`; `NaN`/`±Infinity` → `{"__t":"num","v":"NaN"}`. Keys are sorted, so output is byte-deterministic. |
| `manifest.json` | collection, source project + database (`b8shield-reseller-app` / `b8s-reseller-db`), `exportedAt`, exporter git SHA, doc count, per-part `{file, docs, bytes, sha256}`, fate (carry / archive), `retainUntil` |
| `SHA256SUMS` | `sha256sum`-format lines for every part + `manifest.json` |
| `_maps/user-id-map.json` | (bundle root) the production `legacy_id_map` for users |
| `_storage/storage-manifest.jsonl` | (bundle root) every Storage object: path, size, contentType, GCS md5, computed sha256, custom metadata, class, archive key |

**Rules:**
- **drop** collections are never written; `passwordResets` is credential material.
- Projections (`productsPublic`, `printersPublic`) go to a transient verify file that is deleted after the verify step.
- A second belt: a native `gcloud firestore export` of `b8s-reseller-db`, copied to `archive/firebase/_native/`, because GCS dies with the project.
- **Retention:** orders, orderProduction and checkouts ≥ 7 years after the fiscal year (Bokföringslagen). No R2 lifecycle rule on `archive/`.
- **PII** (orders, b2bCustomers, dac7Sellers, leads, dining*, users): the private bucket only, platform access only, and each archive is listed in `RETIRED.md` with its restore line.
- A GDPR erasure request against archived PII is served by rewriting that archive part and recording the new sha256 in `manifest.json` (logged in `audit_events`).

**Restore** (`scripts/cf-migrate/restore-archive.mjs`, to be written in CP3):
1. `sha256sum -c SHA256SUMS`. Any mismatch → stop.
2. Decode the typed JSON.
3. The target is one of:
   - **D1**, through the same importer path as a carry, when a deferred feature ports (e.g. `discountCodes` → `discount_codes`†, `dac7Sellers` → DAC7 tables), using `_maps/user-id-map.json` for uid fields;
   - **Firestore**, as batch `set()` with the original ids, only for rollback before Firebase deletion.
4. Verify: count + sha256 over the canonical re-export of the restored rows equals the manifest.
5. Add a `RETIRED.md` "restored" line.

---

## (d) Phase rules as script preconditions

Scripts (to be written in CP3, Sonnet per PLAN §9, dry-run by default with verify tables):
- `scripts/cf-migrate/export.mjs`: read-only; Firestore + Storage → bundle + archive
- `scripts/cf-migrate/import.mjs --env {staging|production} [--apply --plan <sha>]`
- `scripts/cf-migrate/verify.mjs --env …`
- `scripts/cf-migrate/restore-archive.mjs`

Every rule below is a check the script performs and **refuses** on.

**All environments**

| Id | Precondition |
|---|---|
| C1 | `scripts/cf-preflight.sh <env>` exits 0: Cloudflare account id, D1 id, R2 bucket ids, and the Stripe account (sandbox for staging, live platform for production) all equal the pinned values. |
| C2 | The bundle's `SHA256SUMS` verifies, and `manifest.json` schema version = the importer's expected version. |
| C3 | D1 `d1_migrations` contains every migration the importer requires. |
| C4 | Without `--apply` nothing is written; the dry run prints the full plan and its sha. `--apply` requires `--plan <sha>` equal to the dry run of the **same bundle**, so the applied plan is the reviewed plan. |
| C5 | Deterministic ids only. A row with the same id and the same content hash is skipped (idempotent). Same id with a different hash → **abort the whole run**. Each tenant is written in D1 batches, and every run is recorded in `import_runs(run_id, env, bundle_sha, plan_sha, started_at, finished_at, status, counts_json)`. |
| C6 | Every Storage object referenced by a carried field is copied **and** checksum-verified before any row containing its rewritten URL/key is written. A missing object aborts. |
| C7 | Uniqueness collisions abort with a report: `(tenant, sku)` for products and variants, collection `handle`, page `slug`, user email, `(tenant, sku, placementSlot)` for mappings. |
| C8 | Every carried-field uid is either mapped or explicitly stored as `*_legacy_uid` with a report line. Nothing is silently dropped. |

**Staging (re-runnable freely)**

| Id | Precondition |
|---|---|
| S1 | `APP_ENV=staging`, and the resources equal the staging pins. |
| S2 | `--reset` (staging only) truncates carried tables in reverse dependency order before re-seeding. It is refused when `APP_ENV != staging`. |
| S3 | **Scrub on import.** `payments.stripeAccountId` is replaced from a pinned live→sandbox map or nulled with `chargesEnabled=false`, because live `acct_…` ids do not exist in the sandbox. User emails go through `--email-map` to allowlisted test addresses. Any unmapped real address → refuse, so staging can never mail a real user. |
| S4 | The R2 targets are the staging buckets; the public base URL is the staging domain. |

**Production (import once)**

| Id | Precondition |
|---|---|
| P1 | `APP_ENV=production` + `--confirm production --expect-tenants 5`. |
| P2 | **Refuse if D1 `orders`, `payment_events` or `checkouts` has any row** (PLAN §4: "after the first CF order is accepted, no destructive re-import"). Also refuse if an `import_runs` row has `env='production' AND status='completed'` (import once). A failed run may be resumed only while P2 still holds, and only through C5's idempotent path. |
| P3 | The Firebase write freeze is proven. Freeze evidence file present: functions writers + schedules disabled, and the Firebase Stripe webhook endpoint disabled, per the CP7 runbook. Bundle `exportedAt` > freeze time. A read-only re-scan right before import shows **no document `updateTime` > `exportedAt`** in any carried collection. |
| P4 | No open money state: Firestore `checkouts` has 0 non-terminal docs; `printNotifications` has 0 pending; the Stripe list of platform PaymentIntents in `requires_*` states = 0 (cancelled at the freeze). |
| P5 | Every `payments.stripeAccountId` is fetched from the live Stripe API and belongs to the pinned platform account. `chargesEnabled`/`payoutsEnabled` are taken from that response. |
| P6 | `verify.mjs --env production` passes (§e) **before** the DNS switch. A failure means keep Firebase serving: the rollback stays valid until the first CF order (PLAN CP7). |
| P7 | After the first CF order the importer permanently refuses every mode except audited additive merges through a separate script. |

---

## (e) Go-live settings verification checklist

`verify.mjs` prints each item with its value and a PASS/FAIL, and the output is pasted into the CP7 runbook. Any FAIL blocks opening checkout.

1. `platform_settings.refund_application_fee = false` (today's effective Firebase value is **true**, §f Q1).
2. `platform_settings.default_commission_bps = 500` (the Firebase default, `app-urls.ts:85`).
3. `platform_settings.reverse_dispute_on_created = true`.
4. Per tenant (5):
   - `stripe_account_id` equals the export, **and** Stripe `GET /v1/accounts/{id}` succeeds under the live platform account
   - `charges_enabled`/`payouts_enabled` equal Stripe's response
   - `commission_bps` equals the export (null → default)
   - `payout_delay_days` equals the export
   - `connect_enabled` equals the export
5. The production Stripe webhook endpoint id + URL are pinned (preflight); API version pin `2023-10-16`.
6. **Routing:**
   - `default_printer_id = 'snapwear'`, and every `print_routing` garment → `snapwear`
   - `printers.snapwear` has `type='api'`, `active=1`
   - the production dispatch target is SnapWear, not the fake printer (preflight, PLAN §0)
7. **Screening:** `screening_terms` count = the source doc's blocklist length (the seed defines 63); `review_first_products = 2`; `hard_block = 0`.
8. **POD mappings:** 0 rows with a null or missing `garment`; every `artwork_id` resolves in the same tenant; every melodie-mc POD product quotes (the `quotePodCost` equivalent) with no 409 block reason (`no-printer-for-garment`, `routed-line-unpriced`, `pod-requires-connect`, `production-exceeds-gross`).
9. **POD artwork:** every mapped artwork is `ready` with print + preview objects present (the 7 without a print master are either unmapped or reprocessed).
10. `pod_profiles` ids resolve for every artwork and mapping.
11. **Legal (melodie-mc):** `returnAddress` non-empty, `vatRegistered` boolean, `legal.acceptance.acceptedAt` set **with** a matching `legal_acceptances` row (`legalPages`), and `platformTerms.version` = current. If not, checkout stays closed. That is expected, not a failure of the import.
12. **Catalogue:** the §2.4 predicate count per tenant = the export `productsPublic` counts (gif 113, ninetone 58, sillmans 22, melodie 12, robowatz 0 → 205), with identical id sets.
13. **Storage:**
    - zero occurrences of `firebasestorage.googleapis.com` or `storage.googleapis.com` in any D1 text column
    - every `stored_objects` row `active` with sha256
    - a sample of public URLs returns 200
    - private and production keys are not publicly reachable (404)
14. **Users:** 2 `platform_admin` + 1 `tenant_admin` (melodie-mc) active; migration invites `sent` in `email_deliveries`; ≥ 1 platform admin has signed in on CF.
15. **Tenants:** `status`/`published` equal the export; `features.pod` explicit for melodie-mc; deferred and deleted feature keys are absent or false.
16. **Translations:** 1365 / 1365 / 1364.
17. **Archive:** every archive collection's manifest verified (count + sha256) and listed in `RETIRED.md`.
18. D1 `orders` = `payment_events` = `checkouts` = 0 immediately before checkout opens; `outbox_events` empty.
19. `docs/SnapWearDocs/LAUNCH_TODO.md`: every A and B item ☑ (PLAN §0).

---

## (f) Open questions (for Mikael, before CP3 scripts)

1. **`refundApplicationFee`.** Prod has no `settings/platform`, so Firebase refunds the platform fee today (default `true`). PLAN sets `false` at go-live, a policy change: the fee becomes non-refundable. Confirm. Should it also be set on Firebase before cutover, so the last Firebase refunds follow the same policy?
2. **The 3 `print_shop` users + 2 uid-keyed printer tiers** (`o7diaDJ01tRoBMs8d5OK9bPunMg1`, `viTqJwF66NXZ42gEZOxQvqkMBUh1`). Kim was removed 2026-09-25, yet all 6 users are `active==true`. Proposal: carry both tiers as `active=0` printers, archive the 3 users (not recreated until the print portal ports), and deactivate Kim's Firebase user now. Yes/no?
3. **`impersonationAudit` (269 docs).** Archive only (proposed), or also carry into `audit_events` as `action='impersonation.legacy'`?
4. **Orders archive.** All 9 are refunded test orders. Confirm none needs to appear in the CF admin order list, and that no DAC7 or bookkeeping flow needs them in D1.
5. **B8shield-era orphans.** Archive (proposed) or delete outright under the zero-B8shield rule: `dining*` (30 docs), `wagonConfigurations`, the 3 auto-id `settings` docs, `users/*/marketingMaterials` (24 docs under 7 phantom users), and legacy Storage (marketing-materials 318.7 MB, affiliates 6, admin-documents 8, `pages/begar-utbetalning`)?
6. **370 legacy-flat product images (103.5 MB).** Copy only the referenced ones and archive the rest (proposed), or delete the unreferenced ones?
7. **Translations** (4,094 docs): carry verbatim into D1 (proposed), scrub B8shield/reseller strings first (the guard regex will match data if it is ever bundled), or rebuild as a static JSON asset? Also: which key is missing from `en_US`?
8. **DAC7.** `dac7Sellers` (1 doc) is archived while DAC7 is PORT-LATER, but seller due diligence is due 31 Dec 2026 and filing 31 Jan 2027, and the report reads orders. DAC7 must be scheduled to port, or the archive restored, before December.
9. **Feature flags.** Materialise effective values at import (default-ON legacy keys → explicit rows only for ported keys; deleted keys affiliate / dining / ambassador / campaigns / writers / b2b dropped from D1 and kept in the archived raw map)? That is the proposal.
10. **`robowatz`** (0 products, 1 impersonation): carry as a tenant (proposed; it costs nothing) or archive as a test shop?
11. **Studio mockups** `pod-artwork/*/mockups` (83 objects, 109 MB): no document references them. Copy to public (proposed, so the studio shows existing mockups without re-render) or drop and regenerate on demand?
12. **podArtwork without a print master** (7 of 20): import as `rejected`/`needs_reprocess` and reprocess through the new render service (proposed), or drop if they are unused test uploads?
13. **The 3D model derivatives** are platform garment photos. Public class (proposed) or private with signed GETs?
14. **Staging data scope.** Import all 5 shops with scrubbed PII and Connect (proposed), or melodie-mc only for the CP2 slice?
15. **Email source of truth** when the Firebase Auth email ≠ `users.email`: the Auth email (proposed)?

---

*Row count: 75. Prod census: succeeded (read-only, 2026-09-26). Next: review → CP3 scripts per §d.*
