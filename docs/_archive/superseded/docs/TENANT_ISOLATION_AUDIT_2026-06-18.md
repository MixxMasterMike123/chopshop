# Tenant Isolation Audit — Full Findings (2026-06-18)

Multi-agent audit: 7 layers, 57 findings, **55 survived adversarial verification**, 2 rejected. Goal: 100% siloed shops for a 10-20 shop future.

Layers: firestore-rules, storage-rules, functions-callables, functions-email-webhook, client-queries, claims-provisioning, data-integrity-integrations

Severity (post-verify): 7 low, 6 medium, 2 info, 7 critical, 33 high

---

## [CRITICAL] Cross-tenant product image overwrite: products/{file} lacks shopId partitioning
- **Layer:** storage-rules  
- **Location:** `storage.rules:47-51 (products path block)`  
- **Verdict:** confirmed (claimed critical → real critical)

**Attack:** Admin of shop Y logs into admin console, uploads a product image to products/{productId}. Because the path is global (not products/{shopId}/{productId}), the upload bypasses any tenancy checks. Admin of shop X, viewing the same product (if they somehow know the productId), sees Y's image. More directly: if shop X's ProductForm.jsx (line 303) uploads to products/{productId}, and shop Y uploads to the same productId later, Y's image silently overwrites X's.

**Fix:** PARTITION STORAGE PATHS (Phase B):

1. Update storage.rules lines 48-51:
   match /products/{shopId}/{productId}/{allPaths=**} {
     allow read: if true;
     allow write: if isAdminOfShop(shopId);
   }
   (where isAdminOfShop(shopId) = isPlatform() || (isAdmin() && request.auth.token.shopId == shopId))

2. Update storage.rules lines 55-58 (branding):
   match /branding/{shopId}/{allPaths=**} {
     allow read: if true;
     allow write: if isAdminOfShop(shopId);
   }

3. Update ProductForm.jsx line 303:
   mainImageUrl = await uploadImageToStorage(mainImageFile, `products/${shopId}/${productId}`, 'b2c_main');

4. Update ProductForm.jsx line 308:
   const u = await uploadImageToStorage(galleryFiles[i], `products/${shopId}/${productId}`, `b2c_gallery_${Date.now()}_${i}`);

5. Update AdminStorefront.jsx (branding uploads) to include shopId in path:
   const url = await uploadImageToStorage(file, `branding/${shopId}`, kind);

6. Define isAdminOfShop in storage.rules (mirror firestore.rules:73-76):
   function isAdminOfShop(shopId) {
     return isPlatform() ||
       (isAdmin() && request.auth.token.shopId == shopId);
   }

7. Audit all other storage paths for shopId partitioning (orders, marketing-materials, affiliates, pages, admin-documents).

**Verifier reasoning:** The vulnerability is CONFIRMED REAL and CRITICAL. Attack vector:

1. REACHABLE: Admin of shop X can enumerate ALL public products from shop Y via Firestore public read (allow read: if true; at firestore.rules:162).

2. EXPLOITABLE: Admin of shop X can upload images to products/{productId} paths belonging to shop Y because:
   - uploadImageToStorage() called at ProductForm.jsx:303,308 constructs path WITHOUT shopId: `products/${productId}`
   - Storage rules at storage.rules:48-51 allow write if isAdmin() only
   - isAdmin() at storage.rules:21-22 checks role claim ONLY, never validates request.auth.token.shopId
   - This is by design per storage.rules:15-20 (TODO comment: "per-shop write-scoping in storage is deferred to the path restructuring")

3. IMPACT: Full image overwrite. Shop Y's product doc contains imageUrl/b2cImageUrl pointing to the overwritten file. Storefront renders attacker's content.

4. AUTHENTICATION REQUIRED: Attacker needs admin role in ANY shop. With 10-20 shops planned, this is probable (Mikael + 1-2 admins per shop × 20 = ~50 potential attackers).

5. DATA LOSS RISK: Shop Y's original images are permanently inaccessible (Storage has no versioning, no audit trail of who wrote what). Recovery only possible if backups exist.

The proposed fix is correct: partition storage paths to products/{shopId}/{productId}/{fileName} and update storage.rules to check shopId claim, matching the Firestore tenant model already in place (firestore.rules uses isAdminOfShop throughout).

---

## [CRITICAL] Cross-tenant storefront branding overwrite: branding/{file} lacks shopId partitioning
- **Layer:** storage-rules  
- **Location:** `storage.rules:53-58 (branding path block)`  
- **Verdict:** confirmed (claimed critical → real critical)

**Attack:** Admin of shop Y via AdminStorefront.jsx (line 135, calls uploadStoreImage) uploads a logo to branding/logo_{timestamp}. Path is global. Admin of shop X separately uploads a different logo with the same timestamp hash collision (unlikely but the design doesn't prevent it); or more realistically, both shops can independently write to the same logical branding path, causing confusion / cross-contamination. If a customer browses shop X and fetch branding images by guessing Y's brand identity, they may see Y's logo.

**Fix:** 1. Partition storage.rules branding paths to include shopId: `match /branding/{shopId}/{kind}/{fileName} { allow read: if true; allow write: if isAdmin() && request.auth.token.shopId == shopId; }` (lines 55-58).
2. Update imageUpload.js uploadStoreImage() (line 94-95) to accept shopId parameter: `export const uploadStoreImage = (file, kind, shopId) => uploadImageToStorage(file, `branding/${shopId}`, kind);`
3. Update AdminStorefront.jsx handleImageUpload() (line 127-144) and handleGalleryUpload() (line 188-205) to pass shopId: `const url = await uploadStoreImage(file, kind, shopId);` where shopId comes from useShopId() (already at line 68).
4. Update imageUpload.js uploadImageToStorage() (line 75-85) to accept the new path structure (no changes needed — pathPrefix already includes shopId after step 2).
5. Verify existing branding files are migrated or legacy paths are blocked (storage.rules rule block all unmigrated paths).

**Verifier reasoning:** The cross-tenant storage branding exploit is CONFIRMED and CRITICAL. The storage.rules file defines branding paths (line 55-58) that allow any authenticated admin (isAdmin() = role=='admin' only) to read and write without shopId scoping. Custom claims ARE set with shopId (verified in createShopUser.ts line 115 and syncAdminClaims in functions.ts), but the storage rule never checks them. An admin of melodieomc can upload to branding/logo_<timestamp>.webp, and an admin of b8shield can read/overwrite the same path. The branding paths are completely unpartitioned: uploadStoreImage() (imageUpload.js line 94-95) hardcodes 'branding' prefix with no shopId, uploadImageToStorage() (line 81) builds path `branding/{imageType}_{timestamp}_{fileName}`, and the rule has no layer checking request.auth.token.shopId. The exploit is reachable via AdminStorefront.jsx (line 135) calling uploadStoreImage with controlled file content. Public customers can view all branding images (read: if true at line 56), so exfiltration requires no privilege. Any shop admin can corrupt or replace any other shop's visual branding, causing customer confusion, brand damage, or service degradation.

---

## [CRITICAL] approveAffiliate bypasses shop scoping - any admin can approve applications for any shop
- **Layer:** functions-email-webhook  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/email-orchestrator/functions/approveAffiliate.ts:33-48`  
- **Verdict:** confirmed (claimed critical → real critical)

**Attack:** Shop A admin calls approveAffiliate() to approve a pending affiliate application intended for Shop B. The verifyAdminAuth() only checks role=='admin', not that the caller is an admin of the application's shop. The caller gets access to read/modify/delete the application doc and can mint a new affiliate account that will execute orders scoped to Shop B.

**Fix:** In /Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/email-orchestrator/functions/approveAffiliate.ts, replace the verifyAdminAuth helper with verifyAdminOfShop(shopId):

```typescript
async function verifyAdminOfShop(shopId: string, authUid?: string): Promise<void> {
  if (!authUid) {
    throw new Error('Authentication required');
  }

  try {
    const userDoc = await db.collection('users').doc(authUid).get();
    const userData = userDoc.data();
    
    if (!userData) {
      throw new Error('Admin access required');
    }
    
    const isAdmin = userData.role === 'admin';
    const isPlatform = userData.platform === true;
    
    if (!isAdmin) {
      throw new Error('Admin access required');
    }
    
    if (!isPlatform && userData.shopId !== shopId) {
      throw new Error('Not an admin of this shop');
    }
  } catch (error) {
    console.error('Admin verification failed:', error);
    throw new Error('Unauthorized access');
  }
}
```

Then, after reading appData (line 95-98), call:
```typescript
await verifyAdminOfShop(appData.shopId || DEFAULT_SHOP_ID, request.auth?.uid);
```

This ensures the caller is either platform-wide admin OR a shop admin of the specific shop whose application is being approved.

**Verifier reasoning:** The approveAffiliate() cloud function in /Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/email-orchestrator/functions/approveAffiliate.ts (lines 33-48) uses Admin SDK (which bypasses Firestore rules) to read, create, and delete affiliate-related documents. The verifyAdminAuth() function checks only that the caller has role=='admin', without verifying that the caller is an admin OF THE SHOP whose application they are approving. A shop A admin can call approveAffiliate() with an applicationId belonging to shop B, and the function will (1) read the shop B application (containing customer PII), (2) create an active affiliate account for shop B (under their control), and (3) delete the original application. This cross-tenant escalation is reachable via any authenticated admin account and causes direct data breach and tenant isolation violation. The Firestore rules correctly gate affiliateApplications access with isAdminOfShop(resource.data.shopId), but cloud functions execute under Admin SDK and ignore those rules entirely.

---

## [CRITICAL] Affiliate query in order-processing missing shopId scope - cross-shop affiliate code collision
- **Layer:** functions-email-webhook  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/order-processing/functions.ts:640-645`  
- **Verdict:** confirmed (claimed critical → real critical)

**Attack:** Order from Shop A carries affiliate code 'ALICE', which doesn't exist in Shop A's affiliate collection but exists in Shop B. The query `collection('affiliates').where('affiliateCode', '==', affiliateCode).where('status', '==', 'active')` matches the Shop B affiliate. Shop A order wrongly credits Shop B affiliate with commission and earnings. Recurring: on every order with that code, Shop B's affiliate accrues commission on Shop A orders.

**Fix:** Apply the proposed fix to BOTH locations: (1) functions/src/order-processing/functions.ts:640-645: add `.where('shopId', '==', orderData.shopId || DEFAULT_SHOP_ID)` after `.collection('affiliates')` and before the affiliateCode where clause. (2) functions/src/affiliate/callable/validateDiscountCode.ts:29-34: add the same shopId filter, but the shop context must be passed as a function parameter since the caller is anonymous. OR: refactor validateDiscountCode to require the storefront to pass shopId in the request (e.g., `ValidateDiscountCodeRequest { code: string; shopId: string }`), then add `.where('shopId', '==', request.data.shopId)`. Verify that all other affiliate-related queries in the codebase (e.g., affiliateClicks, campaignParticipants) also include shopId filtering.

**Verifier reasoning:** The vulnerability is real and exploitable. The order-processing function queries the affiliates collection using the Admin SDK (which bypasses Firestore rules) without filtering by shopId. Since affiliates carry a shopId field but the query only filters on affiliateCode and status, it can match affiliates from different shops. This is confirmed by: (1) the Admin SDK always bypasses rules per the firestore.rules comment; (2) the Firestore rules enforce shop-scoping on affiliates (line 303-313), proving shopId is a required field; (3) orders always have a shopId (stripeWebhook:179: `shopId: metadata.shopId || DEFAULT_SHOP_ID`); (4) there is no downstream code-level verification that the returned affiliate belongs to the order's shop; (5) the same code pattern (cross-shop affiliate query) exists in validateDiscountCode.ts, which is client-facing and has no shopId context. An attacker can trigger this by placing an order with an affiliate code that exists in multiple shops. The impact is recurring: every order with that code in Shop A will credit the Shop B affiliate. A critical secondary issue exists in validateDiscountCode.ts where the storefront (anonymous caller) can trigger the same cross-shop affiliate match, potentially applying wrong discount rates or exposing which shop an affiliate belongs to.

---

## [CRITICAL] Cross-shop customer deletion via deleteCustomerAccount (Admin SDK callable)
- **Layer:** claims-provisioning  
- **Location:** `functions/src/customer-admin/functions.ts:76-199 (deleteCustomerAccount)`  
- **Verdict:** confirmed (claimed critical → real critical)

**Attack:** Shop-X admin calls deleteCustomerAccount with a customerId from Shop-Y. The function checks only role=='admin' (line 85), retrieves the target customer (line 95), and deletes them + their orders/marketing-materials/auth without verifying the admin and customer share the same shopId. The attacker thus reads, deletes, and orphans orders from another shop.

**Fix:** After the role check (line 85 for deleteCustomerAccount, line 211 for deleteB2CCustomerAccount, line 357 for toggleCustomerActiveStatus), add: `if (!adminDoc.data().platform && adminDoc.data().shopId !== customerDoc.data().shopId) { throw new Error('Cross-shop access denied'); }`. This allows platform admins to manage all shops while restricting shop admins to their own shop. Alternatively, use a shared helper function: `function assertSameShop(adminData, customerData) { if (!adminData.platform && adminData.shopId !== customerData.shopId) throw new Error(...); }` and call it once after both docs are fetched, before any deletions.

**Verifier reasoning:** The vulnerability is real and directly exploitable. All three callable functions (deleteCustomerAccount, deleteB2CCustomerAccount, toggleCustomerActiveStatus) use the Admin SDK, which bypasses Firestore rules. They check only role=='admin' without verifying that the admin and target customer share the same shopId. The shopId field exists on all user/customer docs per the createUserProfile implementation. A Shop-X admin can directly delete Shop-Y customers' Firebase Auth accounts, orders, marketing materials, and admin documents via these unguarded Cloud Functions. The Admin SDK read/write operations cannot be constrained by Firestore rules, so no existing security mechanism blocks this attack. This is a direct, authenticated cross-tenant data destruction path.

---

## [CRITICAL] Cross-shop customer status toggle via toggleCustomerActiveStatus (Admin SDK callable)
- **Layer:** claims-provisioning  
- **Location:** `functions/src/customer-admin/functions.ts:347-443 (toggleCustomerActiveStatus)`  
- **Verdict:** confirmed (claimed critical → real critical)

**Attack:** Shop-X admin calls toggleCustomerActiveStatus to disable a customer from Shop-Y. The function checks only role=='admin' (line 357), then directly toggles the active status and disables the Firebase Auth account (lines 375-420) without verifying shop-scoping. Attacker can disable any user in any shop, locking them out.

**Fix:** Add shop-scoping verification in all three functions (toggleCustomerActiveStatus, deleteCustomerAccount, deleteB2CCustomerAccount) after fetching the customer/target doc. Example for toggleCustomerActiveStatus after line 370: if (!adminDoc.data().platform && adminDoc.data().shopId !== customerDoc.data().shopId) { throw new Error('Du har inte behörighet att hantera denna kund'); } This mirrors isAdminOfShop() logic in firestore.rules and enforces tenant isolation at the code layer since Admin SDK bypasses rules.

**Verifier reasoning:** The toggleCustomerActiveStatus Cloud Function (and related deleteCustomerAccount/deleteB2CCustomerAccount functions) are callable from the client, use the Admin SDK (which bypasses Firestore rules), and check only role=='admin' without verifying shop-scoping. The users and b2cCustomers collections carry shopId fields that are enforced in Firestore rules, but the Cloud Functions have NO code-level shop-scoping checks. This allows a shop-X admin to disable/delete customers from shop-Y by directly calling the function with their uid. The attack path is concrete and reachable: any authenticated admin can call toggleCustomerActiveStatus with any cross-shop customerId and succeed, disabling that customer's Firebase Auth account and modifying their Firestore doc. Similar vulnerabilities exist in deleteCustomerAccount and deleteB2CCustomerAccount.

---

## [CRITICAL] Cross-shop B2C customer deletion via deleteB2CCustomerAccount (Admin SDK callable)
- **Layer:** claims-provisioning  
- **Location:** `functions/src/customer-admin/functions.ts:202-345 (deleteB2CCustomerAccount)`  
- **Verdict:** confirmed (claimed critical → real critical)

**Attack:** Shop-X admin calls deleteB2CCustomerAccount with a customerId from Shop-Y. The function checks role=='admin' (line 211) but does not verify that the admin and B2C customer belong to the same shop (no shopId check on line 226 or elsewhere). Attacker can enumerate, delete, and orphan orders from another shop's B2C customer base.

**Fix:** After line 224 (after fetching customerDoc), add a shopId isolation check that denies non-platform admins from crossing shops:

```typescript
const customerData = customerDoc.data() as any;
// TENANT-ISOLATION: Shop admins cannot delete customers from other shops
if (!adminDoc.data()?.platform && adminDoc.data()?.shopId !== customerData.shopId) {
  throw new Error('Tenant isolation violation: Cannot delete customer from another shop');
}
```

This mirrors the existing pattern in users/delete (firestore.rules line 134-135: `allow delete: if isPlatform() || (isAdmin() && resource.data.shopId == userDoc().shopId);`). Platform admins (platform==true) bypass the check; shop admins can only delete from their own shop. Apply the same pattern to deleteCustomerAccount (lines 75-199) for consistency, since it has the same vulnerability on the users collection.

**Verifier reasoning:** CONFIRMED CRITICAL VULNERABILITY. The deleteB2CCustomerAccount Cloud Function (lines 202-345 in functions/src/customer-admin/functions.ts) accepts a customerId parameter and performs deletion without ANY cross-shop isolation check. The attack is concrete and reachable: (1) Any authenticated shop admin can call deleteB2CCustomerAccountV2 (onCall function exposed to clients) with a customerId from a different shop; (2) The function only checks role=='admin' (line 211) but does NOT verify the admin's shopId matches the customer's shopId; (3) The Admin SDK used throughout (db.collection, db.delete) BYPASSES all Firestore rules, so the isAdminOfShop rule on b2cCustomers delete is never invoked; (4) The function proceeds to delete the target customer's auth account, mark their orders as orphaned, and delete the customer doc; (5) Evidence that b2cCustomers.shopId exists: AdminB2CCustomers.jsx queries where('shopId','==',shopId) on line 44, and the Firestore rules line 294 reference resource.data.shopId. The Admin SDK makes the Firestore rules irrelevant; the CODE must check shopId. It does not.

---

## [HIGH] Token claim staleness: admin demotion not revoked until token refresh (up to ~1h)
- **Layer:** storage-rules  
- **Location:** `storage.rules:10-27 (isAdmin function + comment on lines 14-20)`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** Admin of shop X is demoted (role changed from 'admin' to 'customer' in users doc). syncAdminClaims onRequest function runs and revokes the role claim from Firebase Auth. However, storage.rules line 22 checks request.auth.token.role == 'admin'. If the client's ID token (cached locally, valid ~1h) is still in flight before the refresh, the isAdmin() check passes and the demoted user can still write to products/{file} and branding/{file} for up to 1 hour. (Firestore rules would reject immediately via get() on the users doc; storage can't do that.)

**Fix:** The original finding's proposed fix is partially correct but incomplete. Recommendations: (1) Document the 1h token staleness window as a known limitation of Firebase's token model (not the app's fault, but unavoidable). (2) Advise users that demotions take effect on next login/token refresh. (3) For maximum hardening before Phase B (storage shopId partitioning): add a per-path shopId check in storage rules (once paths are restructured), so even a stale admin token for shop X cannot write to shop Y's paths. (4) After Phase B, token staleness becomes non-critical for isolation (a stale shop-X token still can't write to shop-Y paths), but the window persists for privilege-escalation within the same shop (e.g., a demoted admin writing to their own former shop's files). Accept this as a fundamental Firebase limitation and rely on strong offboarding procedures (active monitoring, forced logout on demotion, audit logs).

**Verifier reasoning:** The vulnerability is confirmed as real and reachable. syncUserClaimsOnWrite correctly calls revokeRefreshTokens() on demotion (lines 102-105), but this only invalidates refresh tokens, not in-flight ID tokens (which have ~1h TTL). Storage rules (lines 21-22) check ONLY request.auth.token.role and cannot read Firestore docs, so they have no fallback to current privilege state. A demoted admin with a cached ID token can still satisfy isAdmin() checks and write to products/ and branding/ for up to 1 hour. Firestore is protected (rules check userDoc().role, line 54), but Storage is exposed. The window is real, the path is concrete, and the attack (uploadBytes with stale token) is reachable.

---

## [HIGH] orders/{orderId}/{fileName} not scoped to shopId; any admin can write to any order's attachments
- **Layer:** storage-rules  
- **Location:** `storage.rules:35-45 (orders path block)`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** An order placed on shop X has orderId '12345'. Admin of shop Y (with role='admin' claim) calls uploadBytes(storage, 'orders/12345/proof-of-payment.pdf') and writes a fake receipt. Later, admin of shop X viewing that order in the admin console sees Y's forged receipt. The rule on lines 41-44 checks `request.auth != null && (isAdmin() || request.resource.metadata.userId == request.auth.uid)`. ANY admin passes isAdmin().

**Fix:** The proposed fix is sound and complete. The storage path must be repartitioned from `orders/{orderId}/{fileName}` to `orders/{shopId}/{orderId}/{fileName}`. The write rule should check both role and shopId claim:

```
match /orders/{shopId}/{orderId}/{fileName} {
  allow read: if request.auth != null && (
    (isAdmin() && request.auth.token.shopId == shopId) ||
    resource.metadata.userId == request.auth.uid
  );
  allow write: if request.auth != null && (
    (isAdmin() && request.auth.token.shopId == shopId) ||
    request.resource.metadata.userId == request.auth.uid
  );
}
```

This ensures admin Y (shopId='melodieomc') cannot write to orders/b8shield/12345/... because their token claim shopId != path shopId. All current client code already avoids the orders/ path (no grep hits), so only the rule change is needed now. If order uploads are added in the future, the client must prepend the shopId to the path. The read rule should also be updated for defense-in-depth (currently any admin can read any shop's orders, though Firestore list rules would prevent enumeration).

**Verifier reasoning:** The vulnerability is real and reachable. The storage.rules file at lines 36-45 defines an `orders/{orderId}/{fileName}` path with a write rule that only checks `isAdmin()`, which verifies `request.auth.token.role == 'admin'` but does NOT check the shopId claim. Since (1) custom claims are synced for all admins (syncUserClaimsOnWrite.ts), (2) storage rules cannot read Firestore to verify the orderId belongs to the caller's shop (documented at storage.rules:10-13), and (3) no client-side path validation filters the orderId, an admin of shop Y can directly call the Firebase Storage SDK to upload to any other shop X's order: `uploadBytes(storage, 'orders/12345/proof-of-payment.pdf')` where orderId 12345 belongs to shop X. The rule will allow it. The attack is not speculative—it's a concrete, reachable path that exploits the incomplete isAdmin() check. Severity is high because it allows cross-tenant data tampering (forged receipts/attachments) that an admin of the victim shop will see and trust.

---

## [HIGH] marketing-materials/generic/{fileName} not scoped to shopId; any admin writes to shared global bucket
- **Layer:** storage-rules  
- **Location:** `storage.rules:60-64 (marketing-materials/generic path block) + marketingMaterials.js:85-123`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** uploadGenericMaterial (line 85) in marketingMaterials.js uploads to 'marketing-materials/generic/{timestamp}_{fileName}'. Both shop X and shop Y admins can write there. The Firestore doc is scoped to shopId (line 111: `withShopId(materialDoc, shopId)`), so Firestore isolation holds. BUT the storage file itself is globally readable (line 62: `allow read: if request.auth != null`). A customer of shop X can list or guess shop Y's marketing material filenames (e.g., branding-guideline_1718700000_doc.pdf) and download it from the global bucket.

**Fix:** 1. Update storage.rules (lines 60-64) to partition the path by shopId:
```
match /marketing-materials/{shopId}/generic/{fileName} {
  allow read: if request.auth != null && request.auth.token.shopId == shopId;
  allow write: if isAdmin() && request.auth.token.shopId == shopId;
}
```
2. Update marketingMaterials.js line 92 to use the scoped path:
```javascript
const storageRef = ref(storage, `marketing-materials/${shopId}/generic/${Date.now()}_${file.name}`);
```
3. Update the storageRef in deleteGenericMaterial (line 192) — it already reads `materialData.storagePath` which was persisted by the upload, so it will work automatically after the storage migration.
4. Backfill: move existing files in `marketing-materials/generic/*` to `marketing-materials/{shopId}/generic/*` using a one-time Admin SDK script (iterate materials collection, read each doc's shopId, move the file via Admin SDK's bucket.file() API).

**Verifier reasoning:** The vulnerability is confirmed as real and exploitable. Storage rule line 62 (`match /marketing-materials/generic/{fileName}`) permits read access to ANY authenticated user without shopId validation: `allow read: if request.auth != null;`. This is a clear cross-tenant read. While Firestore docs are properly scoped via `isAdminOfShop(resource.data.shopId)` check (line 346-352 of firestore.rules), the actual Storage files themselves are not partitioned by shopId. A malicious customer of shop X can construct a Firebase Storage reference to another shop's file (via path guessing or timing-based enumeration), call `getDownloadURL()`, and successfully download shop Y's marketing materials. The Firebase SDK will pass the read check because the token only carries an `auth != null` check, not a `shopId` match. This is a genuine tenant-isolation boundary breach at the storage layer.

---

## [HIGH] marketing-materials/customers/{customerId}/{fileName} not scoped to shopId; customer can access other shops' customer materials
- **Layer:** storage-rules  
- **Location:** `storage.rules:66-73 (marketing-materials/customers path block) + marketingMaterials.js:206-247`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** Shop X uploads customer-specific marketing materials to 'marketing-materials/customers/{customerId}/' where customerId is a UID (e.g., user_abc_123). Shop Y creates a customer with the same UID (collision) or in a scenario where UIDs are not globally unique per shop (if the auth model allows), shop Y's admin can access shop X's customer materials because the rule checks only `request.auth.uid == customerId` (line 70), not shop membership.

**Fix:** Partition all customer-material Storage paths by shopId: (1) Update storage.rules line 67 to: `match /marketing-materials/{shopId}/customers/{customerId}/{fileName}` with rules `allow read: if request.auth != null && (isAdmin() && request.auth.token.shopId == shopId || request.auth.uid == customerId && request.auth.token.shopId == shopId); allow write: if isAdmin() && request.auth.token.shopId == shopId;`. (2) Update marketingMaterials.js line 213 to: `const storageRef = ref(storage, \`marketing-materials/${shopId}/customers/${customerId}/${Date.now()}_${file.name}\`);` where shopId is passed as parameter. (3) Update all call sites (AdminCustomerMarketingMaterials.jsx:123, AdminUserEdit.jsx:234, AdminCustomerMarketingMaterialEdit.jsx:130) to pass shopId from useAuth/useShopId. (4) Update DocumentCenter.jsx to include shopId in crm-documents path: `marketing-materials/${shopId}/customers/${contactId}/crm-documents/${filename}`. (5) Update storage.rules lines 76-82 with same shopId partitioning for the crm-documents subcollection.

**Verifier reasoning:** The vulnerability is real and exploitable. Firebase Storage rules at lines 67-73 and 76-82 do NOT partition customer material paths by shopId, while Firestore subcollection rules at lines 143-152 correctly do. A user with UID `user_abc_123` who exists in both Shop X and Shop Y can: (1) Shop X admin uploads file to `marketing-materials/customers/user_abc_123/sensitive.pdf` via Storage (allowed by rule line 72: any isAdmin can write); (2) The same person (user_abc_123) logs into Shop Y and directly accesses that file via Storage (allowed by rule line 70: `request.auth.uid == customerId`). The client-layer filtering in getAllUsers is NOT a defense—it filters Firestore queries, not Storage access. An attacker could use Firebase SDK directly to call storage.ref('marketing-materials/customers/victim_uid/...').getDownloadURL(), bypassing the UI entirely. The attack surface is real because: UIDs are globally unique in Firebase Auth, so if the same person holds accounts in two shops, they become a cross-tenant bridge. AdminCustomerMarketingMaterials correctly filters by shop when loading customers from Firestore (getAllUsers query filters where shopId==shop), but Storage rules cannot read Firestore, so they have no shop context to enforce. This is the exact scenario Phase B (Storage rules hardening) was meant to address per firestore.rules comments at lines 16-26.

---

## [HIGH] marketing-materials/customers/{customerId}/crm-documents/{fileName} not scoped to shopId; same as above for CRM docs
- **Layer:** storage-rules  
- **Location:** `storage.rules:75-82 (CRM documents sub-path block) + marketingMaterials.js (no dedicated upload, uses uploadCustomerMaterial which stores in parent path)`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** Same as finding 5: if shop Y somehow knows shop X's customer UID, shop Y's admin with isAdmin() claim can read/write CRM documents at the same customerId path, because shopId is not enforced.

**Fix:** Partition the storage path from `marketing-materials/customers/{customerId}/crm-documents/{fileName}` to `marketing-materials/{shopId}/customers/{customerId}/crm-documents/{fileName}`. Update storage.rules line 76 to: `match /marketing-materials/{shopId}/customers/{customerId}/crm-documents/{fileName} { allow read: if request.auth != null && (isAdmin() && request.auth.token.shopId == shopId || request.auth.uid == customerId); allow write: if isAdmin() && request.auth.token.shopId == shopId; }`. Update DocumentCenter.jsx line 94 to generate the path with shopId from the current shop context: `const filePath = \`marketing-materials/\${shopId}/customers/\${contactId}/crm-documents/\${filename}\`;` where shopId is obtained via the existing `useShopId()` hook pattern used elsewhere in the codebase (e.g., useDiningContacts.js:29). No Firestore metadata path changes needed; only Storage partitioning and rule update.

**Verifier reasoning:** The cross-tenant storage isolation vulnerability is real and exploitable. The storage rule at marketing-materials/customers/{customerId}/crm-documents/{fileName} enforces write access via `isAdmin()`, which checks only the role claim without shopId validation. An authenticated admin from shop Y can upload arbitrary files to any customer UID in shop X's CRM documents path if they know that customer's UID. The attack requires: (1) discovering a target customer UID from another shop (possible via cross-shop Firestore leaks, enumeration, or social engineering), (2) calling the Storage SDK uploadBytes() directly to the unscoped path, bypassing the DocumentCenter UI's clientside protections. The Firestore metadata (customerDocuments collection) is properly gated to platform-only, but the actual file storage on the unpartitioned storage path is not. This is a concrete cross-tenant write vulnerability affecting data integrity and confidentiality.

---

## [HIGH] affiliates/{affiliateId}/invoices/{fileName} not scoped to shopId; any admin or affiliate reads/writes any shop's affiliates
- **Layer:** storage-rules  
- **Location:** `storage.rules:84-91 (affiliates path block) + affiliatePayouts.js:31-61`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** uploadInvoicePDF (line 31) uploads to 'affiliates/{affiliateId}/invoices/{fileName}'. affiliateId is a UID. An affiliate who signed up with shop X (and has request.auth.uid == affiliateId) can be exploited: if shop Y creates an affiliate doc with the same UID, or if UIDs collide, shop Y's affiliate can read/write invoices intended for shop X's affiliate. More critically, ANY admin (line 88: `isAdmin()`) can read any affiliate's invoices from ANY shop.

**Fix:** Partition storage path to `affiliates/{shopId}/{affiliateId}/invoices/{fileName}`. Update storage.rules lines 85-88:
```
match /affiliates/{shopId}/{affiliateId}/invoices/{fileName} {
  allow read: if request.auth != null && (
    (isAdmin() && request.auth.token.shopId == shopId) ||
    request.auth.uid == affiliateId
  );
  allow write: if isAdmin() && request.auth.token.shopId == shopId;
}
```
Update affiliatePayouts.js line 46 to: `const storageRef = ref(storage, `affiliates/${shopId}/${affiliateId}/invoices/${fileName}`);`
Add shopId parameter: `export const uploadInvoicePDF = async (file, shopId, affiliateId, invoiceNumber) =>`
Thread shopId through all callers (AdminAffiliatePayout.jsx:127 has shopId via useShopId hook at line 27; pass it: `uploadInvoicePDF(invoiceFile, shopId, affiliateId, invoiceNumber)`).

**Verifier reasoning:** The storage rule at lines 85-91 allows ANY authenticated admin (isAdmin() returns true for any user with role=='admin' claim, regardless of shopId) to write to `affiliates/{affiliateId}/invoices/{fileName}` without any shopId partition. uploadInvoicePDF (line 31-61 of affiliatePayouts.js) does not receive or validate shopId, and the storage path omits it entirely. While the Firestore rules properly scope the affiliate doc itself (firestore.rules:303-313 require isAdminOfShop), and the admin UI enforces client-side scoping (AdminAffiliatePayout fetches the affiliate first, which Firestore rules gate), an authenticated admin with direct SDK access could construct uploadInvoicePDF calls with any affiliate UID and write invoices to cross-shop affiliate directories. This is a storage-layer isolation leak: the rule must check shopId. All affiliates carry shopId (approved via approveAffiliate:105), so the fix is technically feasible. The risk is reduced because orphaned storage invoices lack Firestore payout records, but the rule gap is real and violates the multi-tenant isolation mandate.

---

## [HIGH] pages/{pageId}/attachments/{fileName} not scoped to shopId; any admin uploads to any page's attachments globally
- **Layer:** storage-rules  
- **Location:** `storage.rules:98-102 (pages path block) + fileUpload.js:47-88`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** uploadFile (line 47) in fileUpload.js uploads to 'pages/{pageId}/attachments/{fileName}'. A shop X admin and shop Y admin can both upload to the same pageId if they know its ID, because the rule on line 101 is just `allow write: if isAdmin();`. Assuming pageId is derived from the CMS system, a lower-security guessing attack (iterate pageIds) could let shop Y overwrite shop X's page attachments.

**Fix:** Partition Cloud Storage by shopId and add tenancy verification to the storage rule. Update storage.rules (lines 98-102) to: `match /pages/{shopId}/{pageId}/attachments/{fileName} { allow read: if true; allow write: if isAdmin() && request.auth.token.shopId == shopId; }`. Update fileUpload.js (line 47) to accept shopId as a parameter and construct the path as `const storagePath = \`pages/${shopId}/${pageId}/attachments/${fileName}\`;`. Add shopId to all uploadFile() calls in AdminPageEdit.jsx (line 221): `uploadFile(file, isNewPage ? 'temp' : id, shopId, currentUser.uid)`. Update the function signature in fileUpload.js to `export const uploadFile = async (file, pageId, shopId, userId)` and insert shopId into the path construction and the returned storagePath metadata for consistency with future deleteFile() calls.

**Verifier reasoning:** The storage.rules file at lines 98-102 defines `match /pages/{pageId}/attachments/{fileName}` with `allow write: if isAdmin()`, scoping only by role claim without any shopId verification. The fileUpload.js function (line 59) constructs storage paths as `pages/{pageId}/attachments/{fileName}` with no shopId partition. A shop X admin, upon obtaining a shop Y pageId (via enumeration, operator leak, or social engineering), can directly upload files to `pages/{shopYPageId}/attachments/{fileName}` because the storage rule does not verify that the pageId belongs to the admin's own shop. While Firestore rules scope the page document metadata collection (line 175-179), the Cloud Storage objects themselves persist without tenancy partitioning. The attack is reachable: the client SDK accepts the path directly, the storage rule's `isAdmin()` check is satisfied, and the file uploads successfully to the unscoped path. Damage includes overwriting existing attachments (collision risk), storage DoS, namespace pollution, and potential info disclosure (the files are publicly readable). Firestore's auto-generated pageIds are cryptographically random (not easily guessable), but in a 10-20 shop scenario with potential operator knowledge or social engineering, the barrier is surmountable. The vulnerability is real, confirmed, and high-severity.

---

## [HIGH] PUBLIC READ on products and branding paths leaks existence of all shops' products/branding across tenants
- **Layer:** storage-rules  
- **Location:** `storage.rules:48-51 (products: allow read: if true) and 55-58 (branding: allow read: if true)`  
- **Verdict:** confirmed (claimed medium → real high)

**Attack:** An unauthenticated attacker (or a customer of shop X) can enumerate or guess shop Y's product and branding image URLs without any auth claim. While the storefront is public by design, the storage paths being world-readable means a customer of shop X who somehow discovers shop Y's productId or branding filename can directly access those files without the storefront UI. If productIds are sequential, this becomes a trivial enumeration.

**Fix:** Three complementary fixes: (1) **Firestore rules (Phase A.1)**: Change products read from `allow read: if true;` to `allow read: if request.auth != null && (resource.data.shopId == request.auth.token.shopId || isPlatform())` to prevent global enumeration. (2) **Storage rules (Phase B)**: After partitioning storage paths to `products/{shopId}/{productId}/*` and `branding/{shopId}/*`, apply scoped read rules: `allow read: if request.auth != null && request.auth.token.shopId == shopId`. For public branding images, require authenticated access or use server-side signed URLs instead of embedding raw storage paths in Firestore. (3) **Immediate mitigation**: Implement Cloud Function middleware to intercept storage access, validate shopId against auth claims, and only issue signed URLs for authorized shop data—do not expose raw storage URLs in client-facing documents.

**Verifier reasoning:** The finding is REAL and exploitable. An attacker can: (1) Query Firestore globally to enumerate products from any shop because firestore.rules line 162 has `allow read: if true;` with no shopId filtering, (2) Extract product IDs (which are guessable with `prod_${Date.now()}` format per ProductForm.jsx line 298), and (3) Directly access storage files at `products/{productId}/*` and `branding/*` paths because storage.rules lines 48-51 and 55-58 allow `read: if true;` unconditionally. The client-side storefront query filtering by shopId does NOT prevent SDK-direct calls to Firestore or Storage. Branding paths are additionally vulnerable because they are not partitioned by shopId. This is a confirmed cross-tenant read bypass.

---

## [HIGH] Affiliate Discount Code Validation Missing Shop Scoping
- **Layer:** functions-callables  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/affiliate/callable/validateDiscountCode.ts:29-34`  
- **Verdict:** confirmed (claimed critical → real high)

**Attack:** An attacker authenticated to shop-A calls validateDiscountCode with affiliateCode='SHOP_B_AFFILIATE'. The function queries affiliates collection with ONLY where('affiliateCode', '==', code) and where('status', '==', 'active'), with NO where('shopId', '==', callerShopId). This retrieves SHOP_B's affiliate doc, leaks its checkoutDiscount to shop-A (checkout-parity violation: shop-A can apply shop-B's discount rates), and enables a malicious admin of shop-A to extract affiliate discount percentages and commerce terms from every other shop in the system.

**Fix:** Modify validateDiscountCode to include shop-scoping in the affiliate query. The recommended fix: (1) Add `shopId` as an optional parameter in the request payload (the client/CartContext can pass it via `useShopId()`), with DEFAULT_SHOP_ID as fallback for anonymous storefront visitors; (2) Add `.where('shopId', '==', shopId)` to the query at line 31; (3) For admin-initiated calls (if any), derive shopId from the authenticated caller's users doc. Example: `const shopId = request.data?.shopId || DEFAULT_SHOP_ID; const snapshot = await db.collection('affiliates').where('affiliateCode', '==', rawCode).where('shopId', '==', shopId).where('status', '==', 'active').limit(1).get();` Ensure the same pattern is applied to logAffiliateClick.ts (line ~18-20), which has the identical vulnerability.

**Verifier reasoning:** The vulnerability is confirmed and real. The validateDiscountCode callable function at /Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/affiliate/callable/validateDiscountCode.ts queries the affiliates collection with only `where('affiliateCode', '==', rawCode)` and `where('status', '==', 'active')`, with NO `where('shopId', '==', ...)` filter. This allows any caller to retrieve affiliate documents from ANY shop and extract the checkoutDiscount value. 

An attacker with knowledge of an affiliate code (obtainable from marketing materials, shared links, email campaigns, or competitive intelligence) can call this function anonymously from ANY storefront to learn the discount percentage configured for that affiliate in ANY shop. The function's only defense—checking if the affiliate's shop has the affiliate feature enabled—does not prevent the cross-tenant query; it only gates whether the discount is valid for that shop.

The severity is HIGH (not CRITICAL) because: (1) the leak is limited to discount percentages, not PII or payment data, and (2) exploitation requires knowing a valid affiliate code. However, in a multi-tenant environment with competing shops, affiliate discount terms are sensitive business information, and the exploit is straightforward for anyone with code knowledge.

The fix is straightforward and necessary for proper tenant isolation: add shop-scoping to the query. For checkout context, the function should derive shopId from the request context (e.g., passed explicitly by the client, or extracted from request headers/auth context if an authenticated affiliate is calling). The proposed fix in the claim is correct.

---

## [HIGH] Payment Intent Affiliate Discount Missing Shop Scoping
- **Layer:** functions-callables  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/payment/createPaymentIntent.ts:100-111`  
- **Verdict:** confirmed (claimed critical → real high)

**Attack:** An attacker can call createPaymentIntentV2 from shop-B's storefront with shopId=shop-B in the request body, but also pass discountCode='SHOP_A_AFFILIATE'. The function queries `affiliates.where('shopId', '==', shopId)` ONLY if shopId comes from request.body (lines 259, 269). A customer tampering with the shopId parameter in the checkout request can cause the function to search for SHOP_A's affiliates in SHOP_A's shop-space while charging to SHOP_B's order. This violates cross-tenant isolation and enables discount escalation or cross-shop commission theft if an attacker crafts a payload with mismatched shopId vs discountCode.

**Fix:** Remove the ability to accept shopId from request.body. Derive resolvedShopId from the request's origin/domain instead:

1. Extract the origin from request.headers.origin (already available to corsHandler)
2. Implement a domain→shopId mapping function that returns the correct shopId for origins like 'https://shop-meteorpr.web.app' (must be configurable per environment/shop if multi-domain support is needed)
3. For generic domains that can't encode the shopId, fall back to DEFAULT_SHOP_ID as the hardcoded shop for all unauthenticated checkouts
4. Remove shopId from the CreatePaymentIntentRequest interface signature (line 141)
5. Replace line 269 with: `const resolvedShopId = deriveShopIdFromOrigin(request.headers.origin || '') || DEFAULT_SHOP_ID;`
6. Never accept shopId from request.body

This ensures the Cloud Function is BOUND to a specific shop based on the calling domain, matching the tenant isolation model where each shop has its own storefront.

**Verifier reasoning:** The vulnerability is REAL and exploitable. The createPaymentIntentV2 Cloud Function accepts shopId from the client-supplied request body (line 259) without any server-side validation tying it to the request's origin, authenticated user, or domain. An attacker can:

1. Open a storefront on shop-B.com
2. Intercept the HTTP POST to createPaymentIntentV2 (via browser dev tools or MITM)
3. Tamper the shopId field from "shop-b" to "shop-a"
4. Supply a discount code from shop-A's affiliate program
5. The function queries db.collection('affiliates').where('shopId','==','shop-a') at line 102, retrieves shop-A's affiliate discount (checkoutDiscount field at line 108), and applies it to a shop-B order

This is a cross-tenant READ (of the checkoutDiscount value from shop-A's affiliate doc). While the full affiliate doc isn't exposed to the client, the function performs an unauthorized query into another shop's affiliate data, violating the tenant isolation mandate. In a 10-20 shop environment, each shop's affiliate program becomes accessible to every other shop's customers, enabling discount arbitrage, commission theft (attribution to wrong affiliate), and financial confusion across shops.

The CORS check only validates the origin is allowlisted; it does NOT extract or enforce a shop identity from the origin, allowing the client to specify any shopId they want.

---

## [HIGH] Campaign Query in Order Processing Missing Shop Scoping
- **Layer:** functions-callables  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/order-processing/functions.ts:664-670`  
- **Verdict:** confirmed (claimed critical → real high)

**Attack:** The processOrderCompletion function queries active campaigns with `.where('shopId', '==', orderData.shopId)` (line 668). However, the orderData.shopId field comes from the order doc, which is created by the Stripe webhook (stripeWebhook.ts) and written from the PaymentIntent metadata. If an attacker passes a malicious shopId in the createPaymentIntent request, it flows through to the order, and then the campaign query retrieves campaigns from the WRONG shop. This enables cross-shop campaign revenue tracking, attribution to the wrong shop's campaigns, and distortion of campaign statistics across tenants.

**Fix:** In createPaymentIntent.ts line 269, replace `const resolvedShopId = shopId || DEFAULT_SHOP_ID;` with one of these approaches: (1) SERVER-DERIVED (recommended for multi-tenant): Extract the shop from the request's Referer header and map domain → shopId, falling back to DEFAULT_SHOP_ID. Store the mapping in Firestore and validate it. Example: `const referer = request.headers.referer || ''; const domainMatch = referer.match(/https?:\/\/([^.]+)\.web\.app/); const shopFromDomain = domainMatch?.[1] || DEFAULT_SHOP_ID; const resolvedShopId = shopFromDomain;` (2) HARDCODED per environment (for single-shop or feature-flag-based deployment): Set `const resolvedShopId = DEFAULT_SHOP_ID;` unconditionally, ignoring the client parameter, if all traffic is pre-routed to the correct shop. (3) VALIDATE against shops collection: If you have a shops collection with a `domain` field, load the shop by domain from Referer and use its shopId: `const shop = await db.collection('shops').where('domain', '==', extractedDomain).limit(1).get(); const resolvedShopId = shop.empty ? DEFAULT_SHOP_ID : shop.docs[0].id;`. Then update the comment at line 265-268 to reflect that shopId is now server-derived, not client-supplied.

**Verifier reasoning:** The finding is confirmed. The attack path is: (1) A malicious client sends a crafted shopId in the createPaymentIntentV2 request, (2) createPaymentIntent.ts line 269 accepts it with no validation (`const resolvedShopId = shopId || DEFAULT_SHOP_ID`), (3) The attacker's shopId is written to Stripe metadata at line 416, (4) stripeWebhook.ts line 179 reads it directly into the order without verification, (5) processOrderCompletion queries campaigns using the attacker-supplied orderData.shopId at lines 668 (and 206-207 in processUniversalCampaignRevenue), (6) Admin SDK bypasses Firestore rules, so the query succeeds and campaigns from the WRONG shop are retrieved. This enables cross-shop campaign revenue tracking pollution, affiliate commission misattribution, and statistics distortion. The issue is real and reachable via unauthenticated checkout. However, severity is HIGH not CRITICAL because: (a) it only pollutes campaign/statistics data, not order isolation itself (the order's own financial data is separate), (b) it requires an attacker to know the target shop's shopId, and (c) practical impact depends on whether campaigns actually drive behavior (the affiliate query at line 641-645 is correctly scoped to the affiliate's shop, not the order's shopId, so commission calculation is not directly exploitable—only campaign revenue tracking is). The fix is straightforward: derive shopId server-side from request context (origin/Referer) instead of trusting the client parameter.

---

## [HIGH] Unfiltered B2C Customer Stats Update Cross-Shop Risk
- **Layer:** functions-callables  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/order-processing/functions.ts:542-558`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** The processOrderCompletion function updates B2C customer stats using orderData.b2cCustomerId directly (line 546) without verifying the customer's shopId matches the order's shopId. If an attacker creates an order in shop-A's checkout but crafts the customerInfo to reference a b2cCustomerId from shop-B, the function will update shop-B's customer stats (totalSpent, totalOrders) with transactions attributed to shop-A. This inflates shop-B's customer metrics and distorts analytics.

**Fix:** Before updating customer stats (line 546), verify the b2cCustomer doc's shopId matches the order's shopId:

```typescript
if (orderData.b2cCustomerId && orderData.total) {
  console.log(`Updating B2C customer stats for customer: ${orderData.b2cCustomerId}`);
  try {
    const customerRef = localDb.collection('b2cCustomers').doc(orderData.b2cCustomerId);
    const customerSnap = await customerRef.get();
    
    // CRITICAL: Verify customer belongs to this order's shop
    if (!customerSnap.exists || customerSnap.data().shopId !== orderData.shopId) {
      console.warn(`Cross-shop customer update blocked: customer shop mismatch for ${orderData.b2cCustomerId}`);
      // Don't fail the whole process, just skip customer update
    } else {
      await customerRef.update({
        'stats.totalOrders': FieldValue.increment(1),
        'stats.totalSpent': FieldValue.increment(orderData.total),
        'stats.lastOrderDate': FieldValue.serverTimestamp(),
        'updatedAt': FieldValue.serverTimestamp()
      });
      console.log(`Successfully updated customer stats for ${orderData.b2cCustomerId}`);
    }
  } catch (customerError) {
    console.error(`Error updating customer stats:`, customerError);
  }
}
```

Bonus fix (affiliate stats at line 640-645): Add shop-scoping to prevent cross-shop affiliate updates:
```typescript
const affiliateSnap = await localDb
  .collection('affiliates')
  .where('affiliateCode', '==', affiliateCode)
  .where('shopId', '==', orderData.shopId || DEFAULT_SHOP_ID)
  .where('status', '==', 'active')
  .limit(1)
  .get();
```

**Verifier reasoning:** The vulnerability is confirmed and reachable. The `processOrderCompletion()` function uses the Admin SDK (which bypasses Firestore rules) and directly updates the b2cCustomer stats at lines 546-552 without verifying the customer's shopId matches the order's shopId. An attacker can craft a Stripe payment intent via `createPaymentIntentV2()` with a b2cCustomerId from a different shop (line 408-411 accepts it from request.body with no validation), and the Admin SDK update will succeed because rules don't apply to Admin SDK. This allows cross-shop customer analytics poisoning: shop-A orders can increment shop-B customer metrics. The attack requires knowledge of a target shop's customer doc ID but is otherwise straightforward. Additionally, the affiliate commission code has the same vulnerability at line 640-645 (no shop-scoped query for affiliates).

---

## [HIGH] Affiliate Commission Award Missing Shop-Affiliate Pairing Validation
- **Layer:** functions-callables  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/order-processing/functions.ts:640-650`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** The processOrderCompletion function awards affiliate commission by querying affiliates where('affiliateCode', '==', affiliateCode) with NO shopId filter. If an order is created in shop-A but carries an affiliateCode that exists in shop-B, the function queries and finds shop-B's affiliate doc, awards commission to shop-B's affiliate from shop-A's order, and increments shop-B's affiliate earnings. This enables cross-shop affiliate attribution and revenue siphoning (shop-A orders credited to shop-B affiliates).

**Fix:** Add a shopId scoping check to the affiliate query at lines 640-645. The corrected query should be: `.where('shopId', '==', orderData.shopId || DEFAULT_SHOP_ID).where('affiliateCode', '==', affiliateCode).where('status', '==', 'active')`. Additionally, after retrieving the affiliate, verify that affiliate.shopId === orderData.shopId (or orderData.shopId || DEFAULT_SHOP_ID) and return early with a log if the match fails. This ensures commission is awarded only to affiliates that belong to the order's shop. Example: const affiliateSnap = await localDb.collection('affiliates').where('shopId', '==', orderData.shopId || DEFAULT_SHOP_ID).where('affiliateCode', '==', affiliateCode).where('status', '==', 'active').limit(1).get(); if (!affiliateSnap.empty) { const affiliate = affiliateSnap.docs[0].data(); if (affiliate.shopId !== (orderData.shopId || DEFAULT_SHOP_ID)) { console.error(`Affiliate shopId mismatch: affiliate belongs to ${affiliate.shopId}, order belongs to ${orderData.shopId || DEFAULT_SHOP_ID}`); return { ... }; } }

**Verifier reasoning:** The vulnerability is real and exploitable. At lines 640-645 in /Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/order-processing/functions.ts, the processOrderCompletion function queries affiliates using only `.where('affiliateCode', '==', affiliateCode).where('status', '==', 'active')` with NO shopId filter. This function executes with the Admin SDK, which bypasses Firestore rules entirely. Since affiliate codes are generated randomly and not enforced to be globally unique, two shops can possess affiliates with identical codes. When processOrderCompletion processes an order, it will find the first matching affiliate document across all shops, not necessarily the one belonging to the order's shop. The function then increments the found affiliate's stats.conversions, stats.totalEarnings, and stats.balance using FieldValue.increment() (lines 712-716), resulting in cross-shop revenue attribution. Specifically: an order in shop-A with affiliateCode "JOH123456" will match shop-B's affiliate if both have that code, crediting commission to shop-B's affiliate instead of shop-A's. This enables deliberate (or accidental due to code collision) cross-tenant revenue siphoning. The createPaymentIntent function (line 102 in stripeWebhook.ts) correctly validates affiliate codes with a shopId filter at checkout, but the commission-award function lacks this protection despite handling the same data. The vulnerability is particularly acute because processOrderCompletion is HTTP-callable and unauthenticated (onRequest handler, no auth check in the function body).

---

## [HIGH] Campaign Match Check Missing Shop Validation
- **Layer:** functions-callables  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/order-processing/functions.ts:150-184`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** The checkCampaignMatch function (called to determine if an order qualifies for a revenue-share campaign) checks affiliate targeting, product targeting, and date ranges, but NEVER validates that the campaign's shopId matches the affiliate's or order's shopId. Combined with the affiliate query vulnerability (finding a cross-shop affiliate), an attacker can trigger campaign revenue tracking for a shop-B campaign on a shop-A order if they use an affiliate code that cross-maps.

**Fix:** Apply two defensive layers: (1) Add shopId filter to affiliate query at line 640: .where('shopId', '==', orderData.shopId || DEFAULT_SHOP_ID) (2) Modify checkCampaignMatch function signature to accept full affiliate object and add shopId validation: if (affiliate.shopId !== campaign.shopId) return false; before any other checks. Update the call at line 681 to pass the full affiliate object instead of just affiliateId. This ensures affiliates are queried only from the order's shop and that campaign matching validates tenant alignment at the function level as well.</refinedFix>
</invoke>

**Verifier reasoning:** The vulnerability is CONFIRMED and REAL. The affiliate query at lines 640-645 lacks shopId filtering, allowing it to match any affiliate with the given code across all shops. The checkCampaignMatch function (lines 150-184) receives a campaign scoped to the order's shop but an affiliate from potentially a different shop, and never validates that the affiliate's shopId matches the campaign's shopId. If Shop A and Shop B both have affiliates with code "MYAFFILIATE", an order from Shop B using that code could return Shop A's affiliate, incorrectly attributing commission to the wrong tenant. Cloud Functions use Admin SDK which bypasses Firestore rules that would normally isolate affiliates by shopId. This violates tenant isolation and enables cross-tenant revenue misattribution.

---

## [HIGH] Customer-Admin Functions Accept shopId from Caller Without Validation
- **Layer:** functions-callables  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/customer-admin/functions.ts:76-199, 202-345, 348-443`  
- **Verdict:** confirmed (claimed medium → real high)

**Attack:** The deleteCustomerAccount, deleteB2CCustomerAccount, and toggleCustomerActiveStatus functions receive a customerId from request.data and verify the caller is an admin via userDoc().role == 'admin'. However, they do NOT verify that the customer being deleted/modified belongs to the SAME shop as the calling admin. A shop-A admin can call deleteCustomerAccount with customerId='customer-from-shop-B', read the shop-B customer doc (Admin SDK bypasses rules), delete them, and orphan their orders. This violates cross-tenant isolation: shop-A admins can CRUD shop-B's customers.

**Fix:** For each of the three functions (deleteCustomerAccount, deleteB2CCustomerAccount, toggleCustomerActiveStatus):

After fetching the admin doc (line 84/210/356), add:
```typescript
const adminShopId = adminDoc.data()?.shopId;
const isPlatformAdmin = adminDoc.data()?.platform === true;
```

After fetching the customer doc (line 95/221/367), add:
```typescript
// Tenant isolation: shop admins may only manage customers in their own shop
const customerShopId = customerDoc.data()?.shopId;
if (!isPlatformAdmin && customerShopId !== adminShopId) {
  throw new Error('Kunden tillhör inte din butik');
}
```

For deleteB2CCustomerAccount, ensure the same check applies to b2cCustomer.shopId.

This mirrors the Firestore rule pattern (isAdminOfShop = isPlatform OR (isAdmin AND shopId match)) and enforces tenant isolation at the function layer, since Admin SDK does not apply Firestore rules.

**Verifier reasoning:** The claim is CONFIRMED as a real, exploitable cross-tenant isolation vulnerability.

ATTACK PATH (verified):
1. Shop-A admin calls deleteCustomerAccount({customerId: 'customer-from-shop-B'})
2. Function checks caller is admin (line 85): YES, admin checks pass
3. Function fetches customer doc (line 95): db.collection('users').doc(customerId).get()
4. **NO shopId validation**: The function never checks if customerDoc.data().shopId === adminDoc.data().shopId
5. Function proceeds to delete the customer's Firebase Auth account and all related Firestore docs (orders, marketing materials, admin documents)
6. The same pattern exists in deleteB2CCustomerAccount (line 221) and toggleCustomerActiveStatus (line 367)

KEY EVIDENCE:
- Firestore rules (firestore.rules line 135) REQUIRE delete permission to check: isAdminOfShop(resource.data.shopId) which verifies resource.data.shopId == userDoc().shopId
- Cloud Functions use Admin SDK (confirmed in config/database.ts line 8) which BYPASSES all Firestore rules
- The target functions receive customerId from untrusted caller input (data.customerId) with ZERO validation that it belongs to the caller's shop
- Both users (B2B) and b2cCustomers collections have shopId fields per the schema rules (lines 95, 286)
- There is no authorization helper function (authGuard.ts provides only requireAdmin/requirePlatform, no shopId validation)

This is a classic Admin SDK privilege escalation: the function checks role (admin/non-admin) but not tenant (shopId parity). A shop-A admin is authenticated and authorized as an admin, but has no validation that they can administrate the specific customer ID they are targeting.

EXPLOITABILITY: HIGH - any authenticated shop admin can call these functions directly from the client SDK with any customerId, and the Admin SDK will execute the operation server-side unchecked.

---

## [HIGH] Stripe Webhook shopId Parameter Not Validated Against Payment Intent Owner
- **Layer:** functions-callables  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/payment/stripeWebhook.ts:179`  
- **Verdict:** confirmed (claimed medium → real high)

**Attack:** The Stripe webhook handler creates orders with shopId from metadata.shopId (line 179), which was written to the PaymentIntent metadata by createPaymentIntentV2 from request.body (line 416 in createPaymentIntent.ts). If createPaymentIntentV2 accepts a malicious shopId from the request (which it does on line 259), the webhook will stamp that shopId on the order. Combined with the affiliate commission vulnerability, an attacker can cause orders to be attributed to the wrong shop.

**Fix:** Resolve shopId server-side from request origin for B2C or user claims for admin. Do not accept from request.body. Pass resolved shopId only to metadata and order creation.

**Verifier reasoning:** Confirmed: createPaymentIntentV2 accepts shopId from request.body without validation, writes it to PaymentIntent metadata, webhook stamps it on orders via Admin SDK, enabling cross-tenant order hijacking.

---

## [HIGH] Affiliate lookup at createPaymentIntent is PROPERLY scoped (no issue here)
- **Layer:** functions-email-webhook  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/payment/createPaymentIntent.ts:101-106`  
- **Verdict:** confirmed (claimed info → real high)

**Attack:** N/A - this code is correct

**Fix:** In order-processing/functions.ts lines 640-645, add shopId to the affiliate query to match createPaymentIntent.ts pattern: `const affiliateSnap = await localDb.collection('affiliates').where('shopId', '==', orderData.shopId || DEFAULT_SHOP_ID).where('affiliateCode', '==', affiliateCode).where('status', '==', 'active').limit(1).get();` OR add a post-retrieval assertion: after line 652, insert `if (affiliate.shopId !== (orderData.shopId || DEFAULT_SHOP_ID)) { throw new Error('Affiliate shop mismatch'); }` to detect and reject cross-shop affiliate attributions.

**Verifier reasoning:** The claim asserts that createPaymentIntent.ts properly scopes the affiliate lookup and suggests order-processing should match this pattern. While createPaymentIntent.ts IS correctly scoped (lines 101-106 include shopId filter), the order-processing/functions.ts affiliate lookup (lines 640-645) is NOT scoped by shopId. The query `.where('affiliateCode', '==', affiliateCode).where('status', '==', 'active')` will return the first matching affiliate across ALL shops. Since Cloud Functions use the Admin SDK which bypasses Firestore rules entirely, this unscoped query is a live vulnerability: an order from shop A could be attributed to an affiliate from shop B if both share the same affiliateCode, leading to commission being awarded to the wrong shop's affiliate. The code does not validate that the returned affiliate's shopId matches the order's shopId. This is a real cross-tenant data write (commission award escalation).

---

## [HIGH] passwordResets collection unscoped - cross-shop password reset collision
- **Layer:** functions-email-webhook  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/email-orchestrator/functions/confirmPasswordReset.ts:36-39`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** Shop A user and Shop B user both have email@example.com registered. Attacker obtains a password reset code for email@example.com (doesn't know which shop). The confirmPasswordReset query `collection('passwordResets').where('resetCode', '==', resetCode).where('used', '==', false)` returns the FIRST matching doc. If Shop A's reset code is inserted first, attackers reset Shop A's account; if Shop B's is first, they reset Shop B's. This is a race condition depending on document insertion order. Mitigated partially by cryptographic reset codes but structurally broken for multi-tenant isolation.

**Fix:** 1. Add shopId field to passwordResets docs: Modify sendPasswordResetEmail.ts lines 50-57 to include shopId when creating the doc. Determine shopId from either:
   - The shop context in the reset link (e.g., /b8shield/reset-password?code=...)
   - OR query Firestore to find which shop claims this email in b2cCustomers/users
   
2. Add shopId clause to the confirmPasswordReset query (line 36-39):
   ```
   const resetQuery = await db.collection('passwordResets')
     .where('resetCode', '==', resetCode)
     .where('shopId', '==', shopId)  // ADD THIS
     .where('used', '==', false)
     .get();
   ```

3. Determine shopId in confirmPasswordReset from the resetCode doc itself, or require it to be passed in the request with verification against the retrieved doc

4. As defense-in-depth: After getUserByEmail, verify the Auth user's email matches the passwordResets doc's email (already done implicitly) AND add a second Firestore query to confirm that user's b2cCustomer doc belongs to the identified shopId before updating the password

**Verifier reasoning:** The passwordResets collection is unscoped (no shopId field) while the Firebase Auth service is project-global with email uniqueness. This creates a cross-tenant isolation vulnerability:

CONFIRMED FACTS:
1. sendPasswordResetEmail.ts (lines 50-57) stores passwordResets docs without shopId
2. confirmPasswordReset.ts (lines 36-39) queries passwordResets by resetCode only, takes .docs[0]
3. The function then calls auth.getUserByEmail(email) which is project-global (line 60)
4. Firebase Auth enforces email uniqueness globally - only ONE Auth user can have email@example.com per project
5. Firestore rules confirm passwordResets is server-only (lines 14-17, 426-430)

REAL ATTACK PATH:
An attacker who obtains a valid resetCode (e.g., via email interception, social engineering, or brute force on the 64-character hex code) can call confirmPasswordReset on the public /reset-password page with that code. Since the code lookup doesn't enforce shop scoping, and the subsequent auth.getUserByEmail() call is project-global:
- If Shop A user has email@example.com and Shop A's password reset code is obtained, the attacker can reset that account
- The vulnerability is that confirmPasswordReset doesn't verify the resetCode belongs to the shop context in which it's being used (though this is mitigated by the reset being initiated through email, not a shop-specific URL)

However, the attack is real in a multi-shop scenario because:
1. A passwordResets doc created for Shop A contains only email + resetCode, no shopId
2. An attacker with any Shop's resetCode can call the function from ANY URL/shop context
3. The function will reset the global Auth user with that email, regardless of which shop the reset was initiated from

The claim's specific scenario of "Shop A user and Shop B user with same email" cannot occur due to Auth's email uniqueness, BUT a malicious actor with a reset code can still reset accounts across tenant boundaries if they know the email.

---

## [HIGH] sendLoginCredentialsEmail allows any admin to email any user - cross-shop credential leaks
- **Layer:** functions-email-webhook  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/email-orchestrator/functions/sendLoginCredentialsEmail.ts:37`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** Shop A admin calls sendLoginCredentialsEmail({ userInfo: { email: shopB_admin@example.com }, accountType: 'B2B', credentials: { ... } }). requireAdmin only checks the caller is any admin, not that they own the target user. The function sends login credentials (temporary password, affiliate code) to a user outside the caller's shop, enabling account takeover if the attacker can intercept or manipulate email delivery.

**Fix:** Implement shop-scoping verification in the function itself. Option 1 (recommended for shop-admin calls): 

```typescript
// Add after requireAdmin check (line 37)
const callerDoc = await db.collection('users').doc(request.auth?.uid).get();
const callerData = callerDoc.data();

// Only platform admins can send to cross-shop users; shop admins scoped to own shop
if (!callerData?.platform && request.data.userId) {
  const targetUserDoc = await db.collection('users').doc(request.data.userId).get();
  const targetData = targetUserDoc.data();
  if (!targetData || targetData.shopId !== callerData?.shopId) {
    throw new HttpsError('permission-denied', 'Cannot send credentials to users outside your shop');
  }
}
```

Option 2 (more restrictive): Require platform-only by changing line 37 from `requireAdmin` to `requirePlatform`, since all current client call sites already have shop scoping (approveAffiliate reads applicationId scoped, AdminAffiliateEdit only allows reading own-shop affiliates).

Option 3: Accept email as parameter instead of userId, and validate it matches the user being targeted:

```typescript
// Instead of userId, require email parameter and match with userInfo.email
if (request.data.userId) {
  const userDoc = await db.collection('users').doc(request.data.userId).get();
  if (userDoc.data()?.email !== request.data.userInfo.email) {
    throw new HttpsError('permission-denied', 'Email mismatch');
  }
}
```

Recommend Option 1 (shop-scoping check) as it preserves current client patterns while closing the cross-shop leak.

**Verifier reasoning:** The vulnerability is confirmed and exploitable. The `sendLoginCredentialsEmail` cloud function at /Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/email-orchestrator/functions/sendLoginCredentialsEmail.ts uses `requireAdmin()` which only validates that the caller is ANY admin, not an admin OF THE TARGET USER'S SHOP. When a malicious Shop A admin calls this function with a Shop B user's uid in the `userId` parameter, the function proceeds to fetch that user's data via Admin SDK (which bypasses Firestore rules) and sends sensitive credentials (temporary password, affiliate code) to that user's email address. This enables:

1. Cross-tenant information disclosure (user email, name, company)
2. Credential interception attacks if email can be manipulated
3. Account takeover if temporary password is accessible to attacker
4. Denial of service (spamming another shop's admins with fake credential emails)

The bug exists because: (1) `requireAdmin()` lacks shop-scoping, (2) no validation that userId belongs to caller's shop, (3) Admin SDK bypasses Firestore rules during UserResolver lookup, (4) no shop-scoping check in EmailOrchestrator.

I verified by reading the actual source code at lines 37-84 of sendLoginCredentialsEmail.ts, the authGuard.ts requireAdmin function (lines 8-16), and UserResolver.ts (lines 93-116) which confirms Admin SDK access without scoping.

---

## [HIGH] sendOrderConfirmationEmail allows any admin to trigger customer emails for any order - cross-shop data leakage
- **Layer:** functions-email-webhook  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/email-orchestrator/functions/sendOrderConfirmationEmail.ts:51`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** Shop A admin calls sendOrderConfirmationEmail({ orderId: 'shop-b-order-id', customerInfo: { email: attacker@evil.com } }). requireAdmin only checks caller is any admin, not that the order belongs to the caller's shop. The function sends an order confirmation email to the attacker containing Shop B's customer data (name, items, totals, shipping address). If the orderId is guessable or obtained via enumeration, the attacker enumerates all Shop B orders and extracts customer PII.

**Fix:** After requireAdmin(authUid) at line 51, read the order document and validate the caller's shop ownership before proceeding: const orderDoc = await db.collection('orders').doc(request.data.orderId).get(); if (!orderDoc.exists) throw new HttpsError('not-found', ...); const orderData = orderDoc.data()!; const userDoc = (await db.collection('users').doc(authUid).get()).data()!; if (userDoc.platform !== true && orderData.shopId !== userDoc.shopId) throw new HttpsError('permission-denied', 'You do not have access to this order'). This forces all non-platform admins to respect tenant boundaries on order operations.

**Verifier reasoning:** The vulnerability is REAL and reachable. sendOrderConfirmationEmail accepts an orderId in the request but never reads the order doc from Firestore to verify the order belongs to the caller's shop. The requireAdmin() check only verifies the caller is ANY admin, not a shop-scoped admin. This allows any Shop A admin to call the function with an arbitrary Shop B orderId (obtained through enumeration or other leaks) and trigger order confirmation emails to attacker-controlled addresses with Shop B's customer PII (name, email, items, totals, shipping address). The attack bypasses all defenses because: (1) orders can be read by anyone via the public get() rule, (2) the function does not cross-check the order's shopId against the caller's shopId, (3) the function accepts arbitrary customerInfo in the request (not reading it from the order doc), allowing the attacker to redirect the email to their own address. With 10-20 shops in production, this is a direct cross-tenant PII leak.

---

## [HIGH] sendOrderNotificationAdmin allows any admin to read/leak any order data - cross-shop order enumeration
- **Layer:** functions-email-webhook  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/email-orchestrator/functions/sendOrderNotificationAdmin.ts:67`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** Shop A admin calls sendOrderNotificationAdmin({ orderId: 'shop-b-order-id', ... }). The function requires any admin but does not verify the caller is admin of the order's shop. The function internally passes full order data to EmailOrchestrator, which can be logged or inferred from email content. By iterating orderId values, the attacker enumerates Shop B's order IDs and metadata (customer names, totals, products) without being an admin of Shop B.

**Fix:** After requireAdmin(request.auth?.uid), add: const orderDoc = await db.collection('orders').doc(request.data.orderId).get(); if (!orderDoc.exists) throw new HttpsError('not-found', 'Order not found'); const order = orderDoc.data(); const userDoc = await db.collection('users').doc(request.auth.uid).get(); const callerShopId = userDoc.data().shopId; if (callerShopId && order.shopId !== callerShopId && !userDoc.data().platform) { throw new HttpsError('permission-denied', 'You are not an admin of this order's shop'); }. This ensures only the order's shop admin (or platform admin) can send notifications for that order. The order data should also come from the fetched doc, not the request, to prevent client-side injection.

**Verifier reasoning:** The vulnerability is confirmed and reachable. sendOrderNotificationAdmin is exported as a callable Cloud Function (functions/src/index.ts:12) and uses requireAdmin() which only verifies the caller is ANY admin (role=='admin'), not that they are an admin of the order's shop. The function receives an orderId and orderData in the request but does NOT fetch the order from Firestore to validate the order belongs to the caller's shop. Since the orderId parameter is user-supplied and the function never calls db.collection('orders').doc(orderId).get(), a Shop A admin can pass any Shop B order ID and arbitrary order data. The orderId enumeration attack is viable: order IDs are either Stripe payment intent IDs (potentially guessable/enumerable) or Firestore auto-IDs (sequential/scannable). The function then passes this data to EmailOrchestrator, which sends it to admins, leaking customer names, totals, and product details. This is a direct cross-tenant read/leak path with no Firestore rule protection (Cloud Functions use Admin SDK which bypasses rules).

---

## [HIGH] DynamicRouteHandler pages query missing shopId filter
- **Layer:** client-queries  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/src/components/shop/DynamicRouteHandler.jsx:46-53`  
- **Verdict:** confirmed (claimed critical → real high)

**Attack:** A customer of shop A visiting a storefront URL with a dynamic CMS page slug (e.g., /about-us) can load pages belonging to shop B if both shops have pages with the same slug. The query does not filter by shopId, so Firestore returns the first matching doc across all shops. If two shops use the same slug name, the wrong shop's page content loads.

**Fix:** Add shopId filter to DynamicRouteHandler's query. Change lines 46-51 from:
```javascript
const pagesRef = collection(db, 'pages');
const q = query(
  pagesRef,
  where('slug', '==', slugPath),
  where('status', '==', 'published')
);
```
to:
```javascript
import { useShopId } from '../../contexts/ShopContext';
...
const shopId = useShopId();
const pagesRef = collection(db, 'pages');
const q = query(
  pagesRef,
  where('shopId', '==', shopId),
  where('slug', '==', slugPath),
  where('status', '==', 'published')
);
```
This ensures DynamicRouteHandler respects shop boundaries when checking for CMS page existence, preventing slug enumeration across tenants.

**Verifier reasoning:** The vulnerability is real and reachable. DynamicRouteHandler (src/components/shop/DynamicRouteHandler.jsx:46-51) queries the `pages` collection without filtering by shopId: `query(pagesRef, where('slug', '==', slugPath), where('status', '==', 'published'))`. The Firestore rules intentionally allow global anonymous read on pages (`allow read: if true;` at line 176 of firestore.rules), making this a genuine cross-tenant information disclosure. An unauthenticated customer can visit any storefront URL like `/shop-a/about-us` and trigger a Firestore read that returns page documents from ALL shops, revealing whether other shops use specific CMS page slugs. While DynamicPage does correctly filter by shopId in its own query (line 75 of DynamicPage.jsx), the damage is already done at the DynamicRouteHandler layer. The vulnerability allows slug enumeration across all shops—a tenant isolation defect. The attack is reachable via the public storefront route `/:shopId/*` without authentication. Severity is high (not critical) because the leaked information is limited to CMS page slug existence, not page content, but it is still a breach of tenant isolation that violates the 10-20-shop isolation mandate.

---

## [HIGH] Admin user enumeration: shop admins can list all admins via adminUIDs collection global write
- **Layer:** claims-provisioning  
- **Location:** `firestore.rules:389-391 (adminUIDs match rule) and functions/src/customer-admin/functions.ts AuthContext.updateUserRole`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** A shop-X admin reads (via query or admin SDK listing) the global adminUIDs collection to enumerate all platform super-admins and other shop admins. The Firestore rule allows read: if isAdmin() with no shop-scoping (line 390). While individual user docs are scoped in the hardened users read rule (line 93-95), adminUIDs is a cross-shop admin registry. Attacker learns the UID, email, and shop assignment of every admin in the platform.

**Fix:** Two options, in order of preference:

OPTION A (Recommended): Remove client-side access to adminUIDs entirely and replace the collection with a platform-only Cloud Function.
  - Delete the adminUIDs collection or mark it server-only
  - Provide a Cloud Function (platform-admin-callable) to manage admin role changes
  - adminUIDManager.js becomes internal (no client imports)
  - Eliminates the leak entirely

OPTION B: Scope adminUIDs to platform-only reads in the rule:
  ```
  match /adminUIDs/{adminUID} {
    allow read, write: if isPlatform();
  }
  ```
  Impact: Breaks the current AuthContext.updateUserRole → adminUIDManager.addAdminUID/removeAdminUID flow (line 451-454), because shop admins would lose write access.
  
  Mitigation for Option B: Refactor role-toggle to use a platform-callable Cloud Function instead of direct client writes.

OPTION C (Partial): Add shopId to adminUIDs docs and scope reads:
  ```
  allow read, write: if isPlatform() || (isAdmin() && resource.data.shopId == userDoc().shopId);
  ```
  Impact: Reduces leakage (shop admin only sees admins in their own shop), but does NOT eliminate platform-admin enumeration (a shop-X admin still learns they are not a platform super-admin, which is also sensitive).
  Effort: Requires backfilling shopId on all adminUIDs docs and updating addAdminUID() to capture shop context (but shop admins have no "shop context" in the role-toggle path, so this requires architectural changes).

**Verifier reasoning:** The exploit is REAL and REACHABLE. A shop-scoped admin (role='admin', shopId='shopX') can call getDocs(collection(db, 'adminUIDs')) and successfully enumerate ALL platform admins and other shop admins in the system.

ROOT CAUSE: The Firestore rule at line 389-390 (`match /adminUIDs/{adminUID} { allow read, write: if isAdmin(); }`) grants READ access to ANY authenticated user with role='admin', without filtering by shopId. The adminUIDs docs have NO shopId field (confirmed in adminUIDManager.js lines 51-59), so the rule cannot scope access by tenant even if it wanted to.

ATTACK PATH (fully reachable):
1. Attacker is a shop-X admin (authenticated, role='admin', shopId='shopX')
2. Attacker calls getDocs(collection(db, 'adminUIDs')) via Firebase SDK
3. SDK sends authenticated request to Firestore
4. For EACH adminUIDs doc in the collection: isAdmin() evaluates to true
5. Rule allows READ on all docs
6. getDocs() returns complete list of ALL admins (uid, email, level fields)
7. Attacker learns: (a) UID of every platform super-admin, (b) email of every admin, (c) privilege level (super vs admin)

ACTUAL IMPACT: This is a cross-tenant information disclosure leak. A malicious shop admin can enumerate the entire admin roster and identify key platform operators by email and privilege level. While the adminUIDs docs lack a shopId field (so shop assignments are not revealed), the enumeration of all administrative personnel is itself sensitive infrastructure information.

WHY SEVERITY IS HIGH (not medium): In a 10-20 shop platform with adversarial tenants, admin enumeration enables reconnaissance attacks, social engineering, and competitor intelligence gathering. A determined attacker can cross-reference the disclosed admin emails with public records (GitHub, LinkedIn, company websites) to map platform structure.

MAINTAINER WAS AWARE: The code comment (line 387-388) explicitly states "Revisit when adminUIDs is deprecated," acknowledging this is a deferred risk, not an oversight. However, deferral does not reduce the current severity.

---

## [HIGH] No explicit revocation of claims when a user is deleted
- **Layer:** claims-provisioning  
- **Location:** `functions/src/customer-admin/functions.ts:76-199 and 202-345 (deleteCustomerAccount and deleteB2CCustomerAccount)`  
- **Verdict:** confirmed (claimed medium → real high)

**Attack:** When deleteCustomerAccount or deleteB2CCustomerAccount deletes a user's Firestore doc and Firebase Auth account, the syncUserClaimsOnWrite trigger (functions/src/auth/syncUserClaimsOnWrite.ts) will NOT fire (triggers fire on writes, not deletes). A deleted admin's stale token (with old admin claims) may remain valid for up to 1h until the client refreshes. If the user's Auth account is deleted but the token lingers, they retain the claim until expiry.

**Fix:** In `deleteCustomerAccount` and `deleteB2CCustomerAccount`:

**Option 1 (Proposed in claim): Explicit revocation BEFORE deletion**
After fetching the customer doc but BEFORE calling `auth.deleteUser()`, explicitly revoke refresh tokens:
```typescript
if (customerData.firebaseAuthUid) {
  try {
    await auth.revokeRefreshTokens(customerData.firebaseAuthUid);
  } catch (err) {
    if (err?.code !== 'auth/user-not-found') throw err;
  }
}
```
Then proceed with `deleteUser()`. This ensures even if the user already has a token, it's invalidated server-side. The user will be forced to re-authenticate before the token expires.

**Option 2 (Safer): Delete Firestore FIRST, then Auth**
Reverse the order: delete the Firestore doc before deleting Auth. Then the trigger can successfully get the Auth user and revoke tokens. However, this creates a different race condition (Auth user exists but Firestore doc doesn't), so requires careful handling.

**Option 3 (Recommended for multi-tenant): Add shop-scoping check**
Before any deletion, verify the customer belongs to the caller's shop:
```typescript
const adminData = adminDoc.data() as any;
const customerData = customerDoc.data() as any;
if (!adminData.platform && adminData.shopId !== customerData.shopId) {
  throw new Error('Cannot delete user from another shop');
}
```
Combined with Option 1 revocation, this closes both the token and cross-tenant windows.

**Firestore Rules Already Enforce Shop-Scoping**
The delete rule at line 132-135 of firestore.rules correctly checks:
```
allow delete: if isPlatform() ||
  (isAdmin() && resource.data.shopId == userDoc().shopId);
```
But Cloud Functions use Admin SDK (bypasses rules), so function-level checks are required.

**Verifier reasoning:** The claim is CONFIRMED as a real and reachable vulnerability. Analysis:

**Core Issue: Order-of-Operations Bug**
The function `deleteCustomerAccount` (lines 76-199) deletes the Firebase Auth account BEFORE deleting the Firestore doc:
- Line 106: `await auth.deleteUser(customerData.firebaseAuthUid);` — Auth user deleted
- Line 181: `await db.collection('users').doc(customerId).delete();` — Firestore delete triggers

The `syncUserClaimsOnWrite` trigger (lines 52-107) fires on the Firestore deletion, then attempts to get the Auth user via `await auth.getUser(userId)` at line 73. Since the Auth user was already deleted in step 1, this fails with `auth/user-not-found`, causing the trigger to return early at line 79 WITHOUT calling `revokeRefreshTokens()`.

**Attack Window**
A deleted user's Firebase ID token remains cryptographically valid for up to 1 hour (standard Firebase token TTL) until the client refreshes. If a deleted user has a stale token in their browser/app, they can use it to:
- Call Cloud Functions (onCall functions check `request.auth != null`)
- Read/write Firestore (rules check `request.auth`, not whether the user was deleted)
- Access Storage (rules check token claims)

Example: An admin (with claims `{role:'admin', shopId:'shop-a'}`) is deleted. Their old token remains valid. Until logout or 1h passes, they can still call deleteCustomerAccount or any other onCall function that checks only `if (!userAuth?.uid)` but not deletion status.

**Secondary Issue: Lack of Cross-Tenant Scoping**
While less critical, `deleteCustomerAccount` also fails to verify the customer's shopId matches the caller's shopId. The function checks only `role == 'admin'` but not `adminDoc.data()?.shopId === customerDoc.data()?.shopId`. This allows a shop-A admin to delete a shop-B admin (cross-tenant escalation). However, the trigger bug means the victim admin's tokens won't be revoked immediately, widening the window further.

**Why This Is Confirmed as HIGH Severity**
1. Real: The bug is in shipped code (commit be149b5)
2. Reachable: Any authenticated user with an old token can exploit it (no additional auth/permission required beyond having held a token)
3. Impact: A deleted user retains full auth identity for 1h, can impersonate themselves for all operations
4. Scale Risk: With 10-20 shops, an admin who is deleted but retains token access could read/write cross-tenant data if firestore.rules has gaps or if other onCall functions lack shop scoping

---

## [HIGH] Cross-shop campaign query in logAffiliateClick without shopId scoping
- **Layer:** data-integrity-integrations  
- **Location:** `functions/src/affiliate/callable/logAffiliateClick.ts:75`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** A malicious affiliate admin (shop X) calls logAffiliateClickV2 with a campaignCode. Lines 74-76 query campaigns by 'code' only, reading ANY campaign doc in the collection regardless of shopId. The function then increments totalClicks (line 81), mutating shop Y's campaign doc if shop Y's campaign has the same code.

**Fix:** Add .where('shopId', '==', shopId) to the campaign query BEFORE querying by code. The shopId is already available at line 43 (resolved from affiliateDoc.data().shopId). The fix is:

```typescript
// Line 72-76: Update campaign stats if campaign code provided
if (campaignCode) {
  try {
    const campaignsRef = db.collection('campaigns');
    const campaignQuery = campaignsRef
      .where('shopId', '==', shopId)          // ADD THIS LINE
      .where('code', '==', campaignCode);     // (moved to second condition for efficiency)
    const campaignSnapshot = await campaignQuery.get();
    
    if (!campaignSnapshot.empty) {
      const campaignDoc = campaignSnapshot.docs[0];
      await campaignDoc.ref.update({
        'totalClicks': FieldValue.increment(1)
      });
      console.log(`Campaign click logged for campaign ${campaignCode}`);
    } else {
      console.warn(`Campaign not found for code: ${campaignCode}`);
    }
  } catch (campaignError) {
    console.error(`Error updating campaign stats for ${campaignCode}:`, campaignError);
    // Don't throw error here - affiliate click was successful
  }
}
```

This mirrors the correct pattern in order-processing/functions.ts:667-669 and ensures only the affiliate's own shop's campaigns are mutated. Additionally, review whether logAffiliateClickV2 should require the caller to be authenticated to a specific shop (or be unauthenticated for storefront use only), to further restrict abuse surface.

**Verifier reasoning:** CONFIRMED: logAffiliateClickV2 uses the Admin SDK to query campaigns by 'code' only (line 75 of logAffiliateClick.ts), bypassing Firestore rules. The function unconditionally increments totalClicks on ANY campaign doc matching the code, regardless of shopId. This allows a malicious caller (unauthenticated, cross-shop customer, or cross-shop admin) to discover campaign codes (e.g., via brute-force, URL enumeration, or business intelligence) and artificially inflate campaign click statistics for shops they do not own. Campaign statistics drive business decisions and revenue-share calculations, making this a data-integrity violation with business impact. The correct pattern (scoping by shopId before code, as in order-processing/functions.ts:667-669) exists elsewhere in the same codebase, confirming this is a code-consistency bug, not a design decision. Cloud Functions run on Admin SDK (bypassing rules), so no Firestore rule can defend; the fix MUST be code-level.

---

## [HIGH] Unscoped passwordResets and emailVerifications collections lack shopId field
- **Layer:** data-integrity-integrations  
- **Location:** `functions/src/email-orchestrator/functions/sendPasswordResetEmail.ts:50; functions/src/email-orchestrator/functions/sendCustomEmailVerification.ts:84`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** passwordResets and emailVerifications are server-only collections (no Firestore rules, client-inaccessible). When created, they store only email + code + metadata, no shopId field. An attacker who knows another shop's user email can exploit a weak/leaked reset code to reset that user's password across shops. The backfill script (scripts/backfill-shopid.cjs) does NOT include these in IN_SCOPE_COLLECTIONS or OPT_IN_COLLECTIONS, meaning they were never stamped with shopId during Phase 1. No query scoping exists to partition reads.

**Fix:** 1. ADD shopId field to passwordResets at creation (line 50 of sendPasswordResetEmail.ts): extract shopId from the user doc by looking up the target email in the users collection OR infer from caller's shopId context if available. 2. ADD shopId field to emailVerifications at creation (line 84 of sendCustomEmailVerification.ts): use the authenticated caller's request.auth context to extract shopId from their users/{uid} doc. 3. UPDATE confirmPasswordReset (line 36-39) to query by BOTH resetCode AND shopId, extracting the target user's shopId from the users collection before confirming the reset. 4. UPDATE verifyEmailCode (line 37) to query by BOTH verificationCode AND shopId, stamping shopId on emailVerifications creation and validating it on verification. 5. RUN backfill script on existing passwordResets and emailVerifications to retroactively stamp shopId (infer from the user doc matched by email). 6. ADD Firestore security rules (even for server-only collections) that prevent client access but document the required shopId scoping for code reviewers. 7. ADD unit tests confirming a reset code from shop X cannot reset a user in shop Y.

**Verifier reasoning:** The vulnerability is confirmed and real. passwordResets and emailVerifications documents lack shopId fields and are created without tenant scoping. The confirmPasswordReset function queries ONLY by resetCode and used status with no shopId constraint, allowing an attacker to reset any user's password if they know the email address. The function uses Admin SDK (no Firestore rules protection) and has no caller-shop validation. The backfill script did not include these collections in IN_SCOPE_COLLECTIONS or OPT_IN_COLLECTIONS, confirming they were never stamped. An authenticated attacker from shop X can reset a user's password in shop Y by obtaining a reset code for that user's email. Similarly, emailVerifications lacks shopId and can be exploited to mark any user's email as verified cross-shop. This is a concrete, reachable cross-tenant read/write/escalate path that violates the tenancy model with 10-20 shops.

---

## [HIGH] Storage rules not shop-partitioned (Phase B deferred); any admin write to any shop's products/branding
- **Layer:** data-integrity-integrations  
- **Location:** `storage.rules:48-58 (products and branding paths)`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** Storage rules check isAdmin() (line 50, 57) which is role=='admin' from the token claim. Storage rules cannot read the named Firestore DB (only the default DB), so they cannot enforce shopId. A shop-X admin with isAdmin()=true can write/delete to /products/* and /branding/* paths meant for shop Y, since the paths are flat (not /products/{shopId}/{file}). This is deferred to Phase B per the comments (lines 16-20); currently any admin mutates any shop's storefront images.

**Fix:** 1. IMMEDIATE (Phase B): Restructure Storage paths to shop-prefix all shop-scoped uploads. Replace flat paths:
   - `/products/{file}` → `/products/{shopId}/{file}`
   - `/branding/{file}` → `/branding/{shopId}/{file}`
   - `/marketing-materials/generic/{file}` → `/marketing-materials/{shopId}/generic/{file}`
   - `/marketing-materials/customers/{customerId}/{file}` → `/marketing-materials/{shopId}/customers/{customerId}/{file}`
   - `/orders/{orderId}/{file}` → `/orders/{shopId}/{orderId}/{file}`
   - `/pages/{pageId}/attachments/{file}` → `/pages/{shopId}/{pageId}/attachments/{file}`
   - `/affiliates/{affiliateId}/invoices/{file}` → `/affiliates/{shopId}/{affiliateId}/invoices/{file}` (if tenant-scoped)
   - `/admin-documents/customers/{customerId}/{file}` → `/admin-documents/{shopId}/customers/{customerId}/{file}`

2. UPDATE storage.rules to enforce shop-scoping:
   - Add a helper: `function isAdminOfShop(pathShopId) { return request.auth != null && request.auth.token.role == 'admin' && (request.auth.token.platform == true || request.auth.token.shopId == pathShopId); }`
   - For each shop-scoped match, extract shopId from the path and guard: `allow write: if isAdminOfShop(shopId_from_path);`
   - Example: `match /products/{shopId}/{file=**} { allow read: if true; allow write: if isAdminOfShop(shopId); }`

3. CLIENT-SIDE UPDATES: Update all upload callsites to include shopId in the path:
   - ProductForm.jsx line 303: `products/${shopId}/${productId}/...` 
   - imageUpload.js: Document that pathPrefix MUST include shopId or the upload will fail.
   - AdminStorefront.jsx (branding): `branding/${shopId}/...`
   - (Identify all upload callsites via grep for uploadImageToStorage and ref(storage).

4. MIGRATION PATH for existing images:
   - Option A (cleanup-only): Serve old image URLs via a read-only fallback rule that checks flat paths, then gradually redirect clients to the new paths. Eventually deprecate the fallback.
   - Option B (move): Run a script to read flat-path images and copy them to the new shopId-prefixed paths (requires Admin SDK, can be run once).
   - For rapid iteration: accept orphaning flat-path images temporarily; they exist in Storage but are no longer referenced by Firestore docs (which will have new paths after re-upload).

5. RULES DEPLOY SAFETY: Before deploying the new rules, ensure:
   - All client upload code is updated to use shopId-prefixed paths (or rollback will lock customers out).
   - A grace period where old + new rules both allow the flat paths (dual-write during transition).
   - Post-deploy, monitor for "permission denied" errors in storage uploads and revert if found.

**Verifier reasoning:** The claim is confirmed as a REAL and EXPLOITABLE cross-tenant storage write vulnerability. Attack trace:

1. STORAGE RULES VULNERABILITY: storage.rules lines 48-58 define `/products/{allPaths=**}` and `/braking/{allPaths=**}` with `allow write: if isAdmin()`. The `isAdmin()` function (line 21-23) only checks `request.auth.token.role == 'admin'` — it does NOT validate the shopId claim against the path.

2. FLATTENED PATHS: Storage paths are NOT shopId-partitioned (lines 16-20 explicitly document this as deferred Phase 0b). A write to `products/shop-y-prod-id/image.webp` uses the same rule as `products/shop-x-prod-id/image.webp`.

3. TOKEN CONTAINS SHOPID: The custom auth token DOES include `shopId` (verified in syncAdminClaims.ts:548-552 and createShopUser.ts:115), so the claim is trustworthy and could be used to enforce shop-scoping.

4. REACHABLE ATTACK PATH:
   - A shop-X admin has `token = {role:'admin', shopId:'shop-x', platform:false}`.
   - They satisfy `isAdmin()` ✓.
   - They enumerate all product IDs via `getDocs(collection(db, 'products'))` (Firestore rule line 162: `allow read: if true` — no shopId filter in the rule itself; client-side filtering is not enforced).
   - They directly call `uploadBytes(ref(storage, 'products/shop-y-product-id/...'), file)`.
   - Storage rule passes `isAdmin()` ✓, no path-based shopId check, write succeeds.
   - Result: shop-Y's product images are corrupted/overwritten.

5. FIRESTORE PROTECTS THE DATABASE, NOT STORAGE: The Firestore rule on products (line 164) enforces `allow update: if isAdminOfShop(resource.data.shopId)`, which DOES prevent cross-tenant database writes. But Storage is a separate service with separate rules; Firestore protection does not extend to Storage.

6. CLIENT UI DOES NOT EXPOSE THIS EASILY: The normal ProductForm flow in AdminProducts only fetches and edits same-shop products (line 46: where shopId==this shop). An attacker would need to bypass the SDK directly, which requires admin auth but is otherwise undefended.

The vulnerability is REAL, REACHABLE, and has HIGH SEVERITY: a malicious shop admin can corrupt another shop's product images without triggering any Firestore audit or visibility. The only mitigation today is (a) the client doesn't expose it via UI, and (b) a curious attacker would need to know or guess a shop-Y product ID. But neither is a reliable defense.

---

## [HIGH] adminCustomerDocuments is server-only, never backfilled for missing shopId
- **Layer:** data-integrity-integrations  
- **Location:** `functions/src/customer-admin/functions.ts:171 (deletion context); scripts/backfill-shopid.cjs (IN_SCOPE_COLLECTIONS)`  
- **Verdict:** confirmed (claimed medium → real high)

**Attack:** adminCustomerDocuments is queried by customerId (line 171) but never scoped by shopId. The backfill script does NOT list it in IN_SCOPE_COLLECTIONS. If legacy adminCustomerDocuments docs exist (created before Phase 1), they lack shopId. An admin reading this collection via a hypothetical admin tools query could see cross-shop customer documents without scoping.

**Fix:** 1. Add 'adminCustomerDocuments' to IN_SCOPE_COLLECTIONS in scripts/backfill-shopid.cjs (after line 65). 2. Add shopId field to the document schema in uploadAdminDocument and in the Cloud Function creation (adminDocFormData should include shopId when saved). 3. Stamp shopId on all uploads: in adminDocuments.js uploadAdminDocument (line 96), add `shopId: (current user's shop OR derive from context)` to docData. 4. Harden deleteCustomerAccount: before deleting adminCustomerDocuments, fetch the customer doc and verify `customer.shopId == userDoc().shopId` (shop-scoped deletion check). 5. Run the backfill: `node scripts/backfill-shopid.cjs --only=adminCustomerDocuments --shop=b8shield --commit` (assuming all current docs belong to b8shield). 6. (Optional, Phase B) Update Firestore rules to add per-shop filtering: `match /adminCustomerDocuments/{docId} { allow read, write: if isPlatform() || (isAdmin() && resource.data.shopId == userDoc().shopId); }` for future flexibility, even though Cloud Functions will still bypass rules.

**Verifier reasoning:** The claim is CONFIRMED and UPGRADED to HIGH severity. While the Firestore rules protect `adminCustomerDocuments` with `isPlatform()` gates, preventing direct client-side cross-shop reads, a critical enforcement gap exists in the Cloud Function layer: deleteCustomerAccount (functions.ts:76-199) is callable by any role=='admin' user and deletes adminCustomerDocuments by customerId alone, without verifying the customer belongs to the caller's shop. The Admin SDK in the function bypasses Firestore rules entirely. A shop-X admin can pass a shop-Y customer ID and the function will delete shop-Y's documents. Additionally, adminCustomerDocuments were never included in the backfill-shopid.cjs script (IN_SCOPE_COLLECTIONS), so legacy docs lack shopId entirely, creating an unauditable state. The collection has no shopId field at all, making per-shop scoping impossible for any future Cloud Function that might need to read these docs. This violates the tenant-isolation mandate that "shop X must not touch shop Y's data at ANY layer".

---

## [HIGH] auditLogs collection created but never backfilled; no shopId on audit records
- **Layer:** data-integrity-integrations  
- **Location:** `functions/src/customer-admin/functions.ts:303`  
- **Verdict:** confirmed (claimed medium → real high)

**Attack:** auditLogs is created on delete (line 303) with no shopId field. The backfill script does NOT list it. An admin reading audit logs (if a future admin-audit UI queries them) sees all deletions across all shops without scoping, leaking operational data.

**Fix:** 1. **Stamp shopId on all auditLogs creates**: Extract the admin's shopId from adminDoc.data().shopId and include it in the auditLogs document:
   ```typescript
   const adminData = adminDoc.data();
   const adminShopId = adminData?.shopId;
   
   await db.collection('auditLogs').add({
     shopId: adminShopId,
     action: 'delete_b2c_customer',
     targetId: customerId,
     targetType: 'b2cCustomer',
     targetEmail: customerData.email,
     targetName: `${customerData.firstName} ${customerData.lastName}`,
     performedBy: userAuth.uid,
     performedAt: FieldValue.serverTimestamp(),
     details: { ... }
   });
   ```

2. **Add tenant validation before the deletion**: Before fetching the customer, verify the admin is authorized for that shop:
   ```typescript
   const customerDoc = await db.collection('b2cCustomers').doc(customerId).get();
   if (!customerDoc.exists) {
     throw new Error('B2C-kunden kunde inte hittas');
   }
   const customerData = customerDoc.data() as any;
   const customerShopId = customerData.shopId;
   
   // Check that admin is authorized for this shop
   const isPlatform = adminData?.platform === true;
   const isSameShop = adminData?.shopId === customerShopId;
   if (!isPlatform && !isSameShop) {
     throw new Error('Du är inte auktoriserad för denna butik');
   }
   ```

3. **Add 'auditLogs' to IN_SCOPE_COLLECTIONS in backfill-shopid.cjs** if any legacy records exist (unlikely since auditLogs is new, but future-proof):
   ```javascript
   const IN_SCOPE_COLLECTIONS = [
     'products',
     'productGroups',
     'b2cCustomers',
     'affiliates',
     'affiliateApplications',
     'affiliateClicks',
     'campaigns',
     'campaignRevenueTracking',
     'campaignParticipants',
     'pages',
     'marketingMaterials',
     'affiliatePayouts',
     'orders',
     'auditLogs', // <-- ADD THIS
   ];
   ```

4. **Add Firestore rule for auditLogs** (in firestore.rules):
   ```
   match /auditLogs/{auditId} {
     allow read: if isPlatform() || (isAdmin() && resource.data.shopId == userDoc().shopId);
     allow create: if false; // Cloud Functions only (Admin SDK)
     allow update, delete: if false; // Never
   }
   ```

This ensures auditLogs is fully scoped to the shop and cannot be read cross-tenant even if Admin SDK usage leaks.

**Verifier reasoning:** The finding is confirmed and real. The deleteB2CCustomerAccount Cloud Function (functions/src/customer-admin/functions.ts:202-345) has a critical multi-tenant isolation gap:

1. **Missing shopId field**: auditLogs document created at line 303 carries NO shopId, violating the tenant-scoping schema.

2. **No tenant validation**: The function checks role=='admin' but never validates that the admin's shopId matches the b2cCustomer's shopId. The customer is fetched via unscoped db.collection('b2cCustomers').doc(customerId) without shopId verification.

3. **Admin SDK bypass**: Cloud Functions use the Admin SDK which bypasses Firestore rules entirely, making the function's code the ONLY access control.

4. **Cross-shop data access**: A malicious shop-X admin can call this function with any b2cCustomer ID from any shop, causing:
   - Unscoped auditLogs creation (potential future data leak if an audit UI queries logs without shopId filter)
   - Cross-shop order updates (lines 268-295) marking orders from other shops as deleted
   - Cross-shop Firebase Auth account deletion (line 232, 249)

5. **Latent but real**: No client-side auditLogs queries exist today (verified via grep), so the leak is currently latent. However, this is a vulnerability waiting for the UI to materialize.

6. **Backfill confirms it's new**: auditLogs is missing from IN_SCOPE_COLLECTIONS in backfill-shopid.cjs, confirming it was never part of the tenancy migration and has no shopId by design—or rather, by omission.

This is HIGH severity because a) the Admin SDK path is reachable by authenticated shop admins, b) cross-shop data writes are confirmed exploitable, and c) audit-log data integrity is broken.

---

## [HIGH] deleteB2CCustomerAccount queries orders by b2cCustomerId only, no shopId scope
- **Layer:** data-integrity-integrations  
- **Location:** `functions/src/customer-admin/functions.ts:268`  
- **Verdict:** confirmed (claimed medium → real high)

**Attack:** Line 268 queries orders by b2cCustomerId without scoping by shopId. If the same b2cCustomerId existed across multiple shops (unlikely but possible if customer signed up for multiple shops with same auth), a shop-X admin deleting the customer would mark orders in shop Y as orphaned, cross-shop data mutation.

**Fix:** In deleteB2CCustomerAccount (functions/src/customer-admin/functions.ts), after reading the b2cCustomer doc (line 221-224), add shop-scoping validation: Extract the customer's shopId from the retrieved doc and verify it matches the calling admin's shopId (from users/{uid}.shopId). If they don't match, throw an error immediately. Then, add shopId to the orders query: `const ordersWithAccountQuery = await db.collection('orders').where('b2cCustomerId', '==', customerId).where('shopId', '==', adminShopId).get()` (line 268, after the shopId extraction). Similarly, scope the email-based orders query at line 279 by adding `.where('shopId', '==', adminShopId)` after the email where clause. This ensures orders in other shops are never touched. The same pattern applies to the email-based order update at line 284-291.

**Verifier reasoning:** CONFIRMED VULNERABILITY: deleteB2CCustomerAccount in functions/src/customer-admin/functions.ts (lines 202-345) is missing shop-scoping validation. Attack path: (1) A shop-X admin crafts a request with a b2cCustomerId from shop-Y (obtained via URL guessing, social engineering, or leaked doc ID). (2) The function reads the customer doc from b2cCustomers/{customerId} using Admin SDK (line 221), which bypasses Firestore rules and allows cross-shop reads. (3) The function queries orders at line 268 with ONLY b2cCustomerId, no shopId scope: `await db.collection('orders').where('b2cCustomerId', '==', customerId).get()`. (4) The Admin SDK query returns ALL orders across all shops matching that b2cCustomerId (no firestore-rules filtering on Admin SDK). (5) Lines 269-276 update all retrieved orders to mark them as orphaned (customerDeleted=true). If shop-Y has orders linked to that customer, they are mutated. Root cause: function checks only `isAdmin()` (line 211), NOT `isAdminOfShop(customerShop)`. The proposed fix is correct: add shopId scope validation after reading the customer doc and verify the admin's shopId matches before updating orders. Severity is HIGH (not CRITICAL) because the b2cCustomerId is a random Firestore doc ID that is difficult to guess/enumerate, and the attacked orders are merely marked as orphaned (not deleted), but it is a confirmed cross-shop data mutation that violates the 100% isolation requirement.

---

## [HIGH] Storage rule for marketing-materials/customers/{customerId} not scoped by shop; any admin reads any customer's files
- **Layer:** data-integrity-integrations  
- **Location:** `storage.rules:67-82`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** Lines 67-82 allow any isAdmin() to read/write all files under /marketing-materials/customers/{customerId}/*, regardless of which shop the customer belongs to. An admin from shop X can access marketing materials for customers in shop Y.

**Fix:** Implement Phase 0b (storage path restructuring): (1) Partition storage paths by shop: change from `marketing-materials/customers/{customerId}/{fileName}` to `marketing-materials/{shopId}/customers/{customerId}/{fileName}`. This requires a schema migration in Storage (move existing files), plus client code updates (upload/download paths). (2) In storage.rules, add a helper function to extract shopId from the path or require token claim validation: `function isAdminOfShopFromPath(shopIdFromPath) { return request.auth.token.shopId == shopIdFromPath; }` (3) Harden the write rule: `allow write: if isAdmin() && (isPlatform() || isAdminOfShopFromPath(resource.data.shopId))`. Note: storage rules cannot read Firestore, so shop extraction must come from the path itself or the token claim. (4) Alternatively, for rapid mitigation without path restructuring: add Cloud Function middleware that validates all Storage operations against Firestore user docs (but this bypasses the rule engine and introduces Admin SDK trust assumptions).

**Verifier reasoning:** The vulnerability is REAL and documented as a known open (Phase 0b deferred work). The storage rule at line 72 uses only `isAdmin()` without shop-scoping, while storage paths are not shopId-partitioned. An authenticated admin can write to ANY customer's path `marketing-materials/customers/{customerId}/*` regardless of which shop the customer belongs to, because: (1) The storage rule checks only `request.auth.token.role == 'admin'`, not shopId; (2) Storage paths don't encode the shop ID (structure is `marketing-materials/customers/{customerId}/{file}`, not `marketing-materials/{shopId}/customers/{customerId}/{file}`); (3) An admin from shop X can invoke the Storage SDK directly to upload files to shop Y's customer paths. However, practical exploitation is limited: client-side routing would need to be bypassed, and Firestore metadata writes are blocked by Firestore rules (line 151), so the metadata won't exist — but the files themselves will be stored in the cross-shop customer path in Storage. The code comment at lines 14-20 explicitly acknowledges this is deferred ("Phase 0b"), treating it as accepted technical debt rather than a surprise bug.

---

## [HIGH] affiliates/{affiliateId}/invoices/ storage path not scoped by shop; any admin reads any affiliate's invoices
- **Layer:** data-integrity-integrations  
- **Location:** `storage.rules:85-91`  
- **Verdict:** confirmed (claimed high → real high)

**Attack:** An affiliate's invoice storage under /affiliates/{affiliateId}/invoices/ can be read/written by ANY isAdmin() user. A shop-X admin can access invoices for affiliates in shop Y.

**Fix:** Restructure storage paths to /affiliates/{shopId}/{affiliateId}/invoices/{fileName}. Update storage rule at lines 85-91 to enforce isAdminOfShop(shopId). Example fix:
```
match /affiliates/{shopId}/{affiliateId}/invoices/{fileName} {
  allow read: if isAdminOfShop(shopId) ||
    request.auth.uid == affiliateId;
  allow write: if isAdminOfShop(shopId);
}
```

Also update uploadInvoicePDF() in src/utils/affiliatePayouts.js to accept shopId as a parameter and construct the path as ref(storage, `affiliates/${shopId}/${affiliateId}/invoices/${fileName}`). Update the call site in AdminAffiliatePayout.jsx to pass shopId to uploadInvoicePDF().

**Verifier reasoning:** The cross-tenant storage vulnerability is REAL and reachable. Firestore rules properly enforce shop-scoping on the affiliates/{affiliateId} document (line 304-313), preventing a shop-X admin from reading a shop-Y affiliate's metadata through the normal UI flow. HOWEVER, the storage rule at lines 85-91 (affiliates/{affiliateId}/invoices/{fileName}) uses only isAdmin() to check authorization, NOT isAdminOfShop(). 

A shop-X admin can bypass the Firestore firewall by directly constructing a Firebase Storage reference to a shop-Y affiliate's invoices (e.g., ref(storage, 'affiliates/{shop-Y-uid}/invoices/invoice.pdf')) and calling getBytes() directly against the SDK. The storage rule will permit this because isAdmin() checks only role=='admin', completely ignoring shopId. The Firestore layer does not defend storage paths. 

While the attack requires SDK-level knowledge (not GUI-only), it is still a concrete, reachable cross-tenant read path. The affiliateId does not need to be guessed—it is Firebase Auth uid, but affiliates might be enumerable through public storefront metadata, past order details, or email-based lookups in the affiliateApplications or marketingMaterials collections. 

The claim's severity is HIGH because invoice PDFs are sensitive financial documents (payout amounts, business details, personal payment info).

---

## [HIGH] Default-shop fallback in stripeWebhook.ts and order-processing could mask missing shopId metadata
- **Layer:** data-integrity-integrations  
- **Location:** `functions/src/payment/stripeWebhook.ts:179; functions/src/order-processing/functions.ts:668, 207`  
- **Verdict:** confirmed (claimed medium → real high)

**Attack:** Orders and campaign queries use .where('shopId', '==', orderData.shopId || DEFAULT_SHOP_ID). If Stripe metadata corruption or client tampering sends shopId=null, the fallback stamps DEFAULT_SHOP_ID ('b8shield') on the order. A large-scale tampering attack could funnel all orders to the default shop, cross-tenant data aggregation.

**Fix:** 

**Layer 1: createPaymentIntent.ts (line 269)**
Before using the shopId, validate it exists:

```typescript
// Validate shopId exists in shops collection (unless using default)
if (shopId && shopId !== DEFAULT_SHOP_ID) {
  const shopSnap = await db.collection('shops').doc(shopId).get();
  if (!shopSnap.exists) {
    logger.error('Invalid shopId in payment intent', { shopId });
    response.status(400).json({ error: 'Invalid shop identifier' });
    return;
  }
}

const resolvedShopId = shopId || DEFAULT_SHOP_ID;
```

**Layer 2: stripeWebhook.ts (line 179)**
Mirror the validation:

```typescript
// Validate shopId in metadata before using it
const incomingShopId = metadata.shopId;
let validatedShopId = DEFAULT_SHOP_ID;

if (incomingShopId) {
  const shopSnap = await db.collection('shops').doc(incomingShopId).get();
  if (!shopSnap.exists) {
    logger.error('Stripe webhook: invalid shopId in metadata', { 
      paymentIntentId: paymentIntent.id,
      incomingShopId 
    });
    // Log the poisoning attempt but still create order with default shop
    // (to avoid silently dropping legitimate orders if shops collection is stale)
  } else {
    validatedShopId = incomingShopId;
  }
}

shopId: validatedShopId,
```

**Layer 3: order-processing/functions.ts (line 668)**
The order doc already carries the validated shopId from the webhook, so no additional check needed there - but add a defensive assertion:

```typescript
// Defensive: order must have a known shopId stamped by the webhook
const orderShopId = orderData.shopId || DEFAULT_SHOP_ID;
if (orderShopId && orderShopId !== DEFAULT_SHOP_ID) {
  const shopSnap = await localDb.collection('shops').doc(orderShopId).get();
  if (!shopSnap.exists) {
    console.error(`Stale shopId in order ${orderId}: ${orderShopId}`);
    // Continue with the order but log the anomaly
  }
}
```

**Rationale:**
- Layers 1 & 2 are the primary defense: validate at the trust boundary (where customer data enters)
- Layer 3 is defense-in-depth: a sanity check that order processing is operating on a known shop
- The shops collection is small and hot (cached), so the lookup cost is minimal
- This matches the audit's principle: validate tenant-scoping data at every boundary, especially where it crosses from untrusted client to trusted server logic


**Verifier reasoning:** The vulnerability is REAL and exploitable. A B2C customer can craft a direct HTTP request to createPaymentIntentV2 with a crafted shopId parameter, causing that value to be embedded in the Stripe PaymentIntent metadata without validation. When the Stripe webhook fires, stripeWebhook.ts accepts this metadata value without verifying it against the shops collection, creating an order tagged with an arbitrary (but valid) shop ID. This allows:

1. Cross-shop order attribution: Orders from customer A at shop "melodieomc" get tagged as belonging to shop "sillmans"
2. Cross-shop affiliate commission: Affiliate commission from the poisoned order accrues to the wrong affiliate  
3. Cross-shop campaign revenue: Campaign tracking and revenue shares are attributed to the wrong shop
4. Cross-shop customer stats pollution: B2C customer stats for the wrong shop are incremented

The attack is reachable because: (a) createPaymentIntentV2 is a public HTTP endpoint (onRequest with region='us-central1'), (b) the client is untrusted (browser requests can be replayed/modified), (c) neither function validates shopId against the shops collection before embedding it in metadata, and (d) the Stripe webhook uses the metadata value without validation.

The fallback to DEFAULT_SHOP_ID is NOT a defense because the attacker provides a valid (non-null) shopId value - the fallback only triggers when the value is missing/null. This is a critical gap: the code assumes if shopId is present, it's legitimate.

The Admin SDK bypass of Firestore rules is not relevant here - this is a data-integrity flaw (malicious customer data), not a rule bypass.

---

## [MEDIUM] adminPresence: Cross-Shop Presence Enumeration
- **Layer:** firestore-rules  
- **Location:** `firestore.rules:378-381`  
- **Verdict:** confirmed (claimed medium → real medium)

**Attack:** A shop-X admin reads all adminPresence docs (line 379: `allow read: if isAdmin();`) and learns which other admins from ALL shops are currently online. With 10-20 shops, this reveals cross-tenant activity patterns and real-time admin availability, enabling timing attacks or social engineering. The rule lacks shopId scoping despite admins from different shops being logically separated.

**Fix:** 1. Add shopId to adminPresence docs: In useAdminPresence.js lines 53-61, extend setDoc to include `shopId: userDoc?.shopId` (read the caller's shop from their users/{uid} doc). 2. Harden the read rule: Change line 379 to `allow read: if isAdmin() && (isPlatform() || userDoc().shopId == resource.data.shopId);` so shop admins only see their own shop's presence, and platform admins see all. This mirrors the pattern used in other shop-scoped collections (products, campaigns, etc.). Alternative: if adminPresence needs to stay global (e.g., for cross-shop operator awareness), make the read platform-only and document the business decision.

**Verifier reasoning:** The claim is CONFIRMED as a real cross-tenant information leak. The adminPresence collection's read rule (line 379: `allow read: if isAdmin();`) has zero shop-scoping, and adminPresence docs carry NO shopId field. An authenticated shop-X admin can call `onSnapshot(collection(db, 'adminPresence'))` via the Firestore SDK and receive ALL admin presence docs from ALL shops, exposing email addresses, online/offline status, and activity patterns of admins from rival shops. The dev team explicitly acknowledged this as "cross-shop presence visibility is a minor info leak, deferred" (line 374), confirming awareness. In a 10-20 shop scenario, this scales into systematic enumeration of cross-tenant admin activity. Severity is MEDIUM (not HIGH) because it is an information leak only—no data corruption, no access to orders/products/customers, and it requires prior authentication as an admin. The proposed fix (add shop-scoping to the read rule and stamp shopId on each presence doc) is correct and necessary.

---

## [MEDIUM] adminUIDs: Cross-Shop Admin Roster Enumeration
- **Layer:** firestore-rules  
- **Location:** `firestore.rules:389-391`  
- **Verdict:** confirmed (claimed medium → real medium)

**Attack:** A shop-X admin reads and writes all adminUIDs docs (line 390: `allow read, write: if isAdmin();`). These docs track all admin accounts in the system globally without shop scoping. A malicious shop-X admin enumerates which email addresses are admins in other shops via getDocs(collection(db, 'adminUIDs')), or writes false entries to poison the admin roster across the entire platform.

**Fix:** The proposed fix is directionally correct. Refined implementation: (1) Add `shopId` field to the adminUIDs schema — when addAdminUID() is called during role updates, stamp `shopId: userDoc().shopId` (the updating admin's shop). (2) Scope the rule: `allow read, write: if isAdmin() && (isPlatform() || resource.data.shopId == userDoc().shopId);` matching the pattern used for users/products/orders/campaigns/affiliates. (3) For platform admins updating users across shops: `isPlatform()` bypass applies as-is. (4) MIGRATION: if any adminUIDs docs exist in production, backfill shopId from the calling context (audit logs) or deprecate + clear them (since it's marked deprecated anyway). (5) Test via rules emulator: verify shop-X admin denied on shop-Y adminUIDs docs; platform can read/write all; own-shop reads/writes pass.

**Verifier reasoning:** The vulnerability is REAL and REACHABLE: a shop-X admin's Firestore rules permit them to read and write the entire adminUIDs collection without shop scoping (rule at line 390 uses `isAdmin()` only, not `isAdminOfShop()`). Unlike every other admin-scoped collection in the hardened rules, adminUIDs carries NO shopId field and NO per-shop access guard. The exploit is directly executable via browser console (getDocs + direct SDK calls). However, practical impact is LIMITED because: (1) adminUIDs is never read by the application (no functional role), (2) it's explicitly marked deprecated, (3) no auth decisions depend on it. This is a valid isolation gap that should be closed per the tenant hardening spec (TENANT_ISOLATION_HARDENING_PLAN.md line 28 lists it as a confirmed leak), but the real-world harm is low in the 10-20 shop future unless adminUIDs gains a security role.

---

## [MEDIUM] orders get: Unguessable ID Weakness at Scale
- **Layer:** firestore-rules  
- **Location:** `firestore.rules:254`  
- **Verdict:** confirmed (claimed medium → real medium)

**Attack:** The orders `get` rule (line 254: `allow get: if true;`) permits anonymous or authenticated users to read any order by ID without shop scoping. While IDs are stated as unguessable (Stripe payment intent or Firestore auto-ID), at 10-20 shops with thousands of orders, ID enumeration becomes feasible via birthday-paradox or leaked IDs. A user from shop-Y can read a shop-X order if they learn its ID (e.g., from an admin, supplier, or via side-channel). No tenant isolation check exists.

**Fix:** The proposed fix is INCOMPLETE but points in the right direction. The current proposal (`allow get: if true && resource.data.shopId == getUserShop()`) breaks anonymous guest access to order confirmations (guests have no shopId in their user doc). A correct fix must either: (1) Preserve the unscoped guest read but add shop-scoping for authenticated multi-tenant users—`allow get: if !isAuthenticated() || isAdminOfShop(resource.data.shopId) || (isAuthenticated() && resource.data.source == 'b2c' && (resource.data.b2cCustomerAuthId == request.auth.uid || resource.data.customerInfo.email == request.auth.token.email));`, OR (2) Replace the capability model with a session token or email-verified guest flow (more secure but higher friction). Option (1) is a minimal hardening: it denies authenticated cross-tenant reads while preserving anonymous guest access via the unguessable ID assumption. The fix should be: `allow get: if !isAuthenticated() || isAdminOfShop(resource.data.shopId) || (isAuthenticated() && resource.data.b2cCustomerAuthId == request.auth.uid) || (isAuthenticated() && resource.data.customerInfo.email == request.auth.token.email);`

**Verifier reasoning:** The claim is CONFIRMED. Orders ARE shop-scoped documents with a `shopId` field (verified in stripeWebhook.ts line 179). The firestore.rules line 254 (`allow get: if true;`) contains NO shop-scoping check and permits ANY user (authenticated or anonymous) to read any order document by ID without validating tenant isolation. The stated rationale—that "unguessable IDs" (Stripe payment intent IDs) make this safe—breaks down at scale: with 10-20 shops and thousands of orders, leaked/discovered order IDs become feasible through employee access, data breaches, shared supplier portals, or social engineering. An authenticated user from shop-Y can directly call `getDoc(doc(db, 'orders', '<shop-X-order-id>'))` and receive the full cross-tenant order data if they learn the ID. This is a genuine cross-tenant read vulnerability. The vulnerability is REAL and EXPLOITABLE, though IDs being random (not sequential) raises the practical bar—hence MEDIUM not HIGH. However, at scale with automated discovery or leaked IDs, this becomes a concrete isolation break that violates the tenancy guarantee.

---

## [MEDIUM] admin-documents/customers/{customerId}/{fileName} not scoped to shopId; admin of any shop reads/writes any shop's admin docs
- **Layer:** storage-rules  
- **Location:** `storage.rules:93-96 (admin-documents path block) + adminDocuments.js:84-124`  
- **Verdict:** downgraded (claimed high → real medium)

**Attack:** uploadAdminDocument (line 84) in adminDocuments.js uploads to 'admin-documents/customers/{customerId}/{timestamp}_{fileName}'. The rule (lines 94-95) is `allow read, write: if isAdmin();`. ANY admin from ANY shop can read and write documents for ANY customer across all shops. This is the most dangerous single path.

**Fix:** While the proposed fix is correct, prioritize it as Phase B (after current Firestore hardening). Immediate workaround already in place: Firestore rules gate `adminCustomerDocuments` to platform-only, so shop admins cannot invoke `uploadAdminDocument()` successfully. Future storage.rules fix: partition paths to `admin-documents/{shopId}/customers/{customerId}/{fileName}` and update storage rule to `allow read, write: if isAdmin() && request.auth.token.shopId == shopId;` (or isPlatform). Update `uploadAdminDocument()` function signature to accept `shopId` param and thread it through all callers (AdminUserEdit.jsx:313, ContactDetail.jsx:653). Run a one-time script to migrate existing docs from unscoped to scoped paths (fetch storagePath from adminCustomerDocuments, re-upload to scoped location, update metadata, delete old).

**Verifier reasoning:** The finding correctly identifies that storage.rules paths are NOT shopId-partitioned and `isAdmin()` is too broad. However, the exploit is BLOCKED by firestore.rules:416-418, which restricts the `adminCustomerDocuments` collection to `isPlatform()` only. This means shop admins cannot create or list admin documents via the normal `uploadAdminDocument()` flow. While a malicious admin could theoretically craft a storage URL if they knew the exact path structure (customerId + timestamp), this is impractical: (1) they cannot enumerate other shops' customers through Firestore, (2) the timestamp is unguessable, (3) no API exposes cross-shop storage paths. The real risk is residual (unscoped storage paths) but is effectively mitigated by the Firestore gate, making this a medium severity (needs hardening but not exploitable today).

---

## [MEDIUM] syncAdminClaims Endpoint Accepts No shopId Restriction
- **Layer:** functions-callables  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/customer-admin/functions.ts:524-576`  
- **Verdict:** confirmed (claimed medium → real medium)

**Attack:** The syncAdminClaims HTTP endpoint (lines 524-576) re-syncs custom claims for ALL users with role=='admin' in the system (line 537). It is guarded only by a maintenance secret (isMaintenanceAuthorized), not by shop-scoping. An operator who gains the ADMIN_MAINTENANCE_SECRET can synchronously re-claim ANY admin's custom claims across ALL shops. While this is an operator-level action (not a per-admin cross-shop escalation), a compromise of the secret + delayed claim revocation exposes all shops' admin tokens to re-claim in one call, widening the blast radius of a secret leak.

**Fix:** 1. Add optional shopId parameter to allow targeted claim sync: `const shopIdParam = req.query.shopId || req.body.shopId; const query = shopIdParam ? db.collection('users').where('role', '==', 'admin').where('shopId', '==', shopIdParam) : db.collection('users').where('role', '==', 'admin');`. 2. ADDITIONALLY: Firestore rules should keep reading the user DOC directly (they already do), but Storage rules need hardening—consider requiring storage.rules to validate the shopId claim against a server-backed user DOC read, OR restructure storage paths to include shopId (e.g., products/{shopId}/{file}) and enforce with rules that read the token claim. 3. MONITOR: Log all syncAdminClaims calls with the secret and the admin count affected, to detect if the secret is being abused post-compromise.

**Verifier reasoning:** The syncAdminClaims endpoint is indeed a real tenant-isolation risk, but with important caveats. The endpoint re-syncs custom claims for ALL admins across all shops when called with the ADMIN_MAINTENANCE_SECRET, with no shop-scoping parameter. While it correctly copies claim values FROM the user DOC (not accepting attacker input), Storage rules directly trust these custom claims (token.role, token.platform) without reading the Firestore DOC, making them vulnerable if claims become stale or out-of-sync. Firestore rules are NOT vulnerable to this—they read the user DOC directly, not the token. The real threat is: (1) if the secret leaks, an attacker can re-sync all admins' tokens in one call, (2) creating a synchronized window if any user DOC has been escalated to platform:true. This is an operator-level credential compromise (not a per-tenant escalation), but it does expose all shops' Storage to re-claimed tokens in one operation, widening the blast radius. The claim is correct that a shopId parameter would reduce this blast radius and is a sensible hardening, though it doesn't fully prevent escalation if the user DOC itself is compromised separately.

---

## [MEDIUM] Shop enumeration: public shops/{shopId} read allows attackers to learn all tenant configs
- **Layer:** claims-provisioning  
- **Location:** `firestore.rules:223-228 (shops/{shopId} match rule)`  
- **Verdict:** confirmed (claimed medium → real medium)

**Attack:** A shop-X admin or any authenticated user can query `collection(db, 'shops')` or individually read `doc(db, 'shops', 'shop-y')` to enumerate all tenant identities, names, status, features, and config. The rule allows read: if true (line 224), making it public. While shop admins are already supposed to be blocked by Firestore read rules on shop-specific data, the shops collection itself is an enumeration vector for reconnaissance and shop-switching attempts.

**Fix:** Change line 224 from `allow read: if true;` to `allow read: if isPlatform() || (isAdmin() && userDoc().shopId == shopId);` This restricts reads to: (1) platform super-admins (any shop), and (2) shop admins reading their own shop config only. The storefront's doc(db, 'shops', shopId) read will still work because shopId comes from the URL (public), the rule permits the shop's own admin to read it, and for unauthenticated storefront access, the storefront data is already publicly readable via products/pages/settings (not shops/* directly). If truly unauthenticated public access to a shop's status/features is required, that can be handled via a separate public API or a dedicated rule amendment with explicit guards (e.g., allow read if resource.data.status == 'active').

**Verifier reasoning:** The firestore.rules line 224 allows `read: if true;` on shops/{shopId}, which exposes all tenant configs to enumeration. While the comment claims this is for "storefront public read," the storefront only reads doc(db, 'shops', currentShopId) via loadShopConfig() — not a collection query. The rule inadvertently opens getDocs(collection(db, 'shops')) to any authenticated user, including shop admins from other tenants. Shop-admin malicious actor can open DevTools and enumerate all shop identities, names, status, features, and config without app-level guards (PlatformRoute is UI-only, not a security boundary). In a 10-20 shop model, this is reconnaissance value and privilege-escalation foothold, but NOT direct data theft or write access. The proposed fix (isAdminOfShop(...) || isPlatform()) correctly closes the vector and aligns intent with implementation.

---

## [LOW] userWagonSettings: Cross-Shop Read via Global isAdmin Check
- **Layer:** firestore-rules  
- **Location:** `firestore.rules:366-369`  
- **Verdict:** confirmed (claimed high → real low)

**Attack:** A shop-X admin calls getDoc(doc(db, 'userWagonSettings', 'shop-Y-user-uid')) and reads wagon configuration for users from other shops. The rule checks isAdmin() globally without scoping to shopId. A malicious shop-X admin learns which wagons/features shop-Y users have enabled, information that could reveal business logic or automation patterns.

**Fix:** OPTION 1 (RECOMMENDED for this codebase): Delete the `userWagonSettings` rule and the dead methods entirely to remove the attack surface cleanly:
- Delete lines 366-369 from firestore.rules
- Delete `getAdminMenuItems(userId)` and `getRoutesForUser(userId)` methods from WagonRegistry.js (lines 209-359)
- Confirm no other code references these dead methods (already verified)

OPTION 2 (If retaining for future use): Scope the rule to platform-only to prevent any shop-admin abuse:
```
match /userWagonSettings/{userId} {
  allow read: if isPlatform();
  allow write: if isPlatform();
}
```

OPTION 3 (Proposed fix, fully correct but more complex): Scope reads to the admin's own shop and platform-only writes:
```
match /userWagonSettings/{userId} {
  allow read: if isActiveUser() && (
    request.auth.uid == userId || 
    isPlatform() || 
    (isAdmin() && (
      get(/databases/$(database)/documents/users/$(userId)).data.shopId == userDoc().shopId
    ))
  );
  allow write: if isPlatform();
}
```
This allows: user reads own, platform reads any, shop-admin reads only same-shop users.

**Recommendation**: Choose OPTION 1 (removal) since the collection is dead code per the design docs. Cleaning up unused attack surface is the cleanest hardening.

**Verifier reasoning:** The finding is technically CORRECT: the firestore.rules at line 367 allows any admin to read any user's `userWagonSettings` doc globally, bypassing shop-scoping with `isAdmin()` without checking shopId. This violates the tenant-isolation model where shop-X admin should only read shop-X docs.

HOWEVER, the real-world severity is LOW, not HIGH, for these reasons:

1. **Dead Code (Eliminates Attack Surface)**: The vulnerable read path exists only in `WagonRegistry.isWagonEnabledForUser(wagonId, userId)`, which is called from `getAdminMenuItems(userId)` and `getRoutesForUser(userId)`. Both methods are defined but NEVER invoked anywhere in the codebase (verified by grep of all src/ files). The actual used methods are `getAdminMenuItemsSync()` and `getRoutes()`, which bypass the vulnerable code entirely.

2. **No App-Driven Exploitation**: An authenticated admin cannot trigger this through legitimate app flows. The vulnerability only becomes exploitable if a malicious admin directly imports WagonRegistry in the browser console and calls the dead methods — an advanced social engineering/compromised-admin scenario.

3. **Harmless Data**: `userWagonSettings` only contains wagon feature toggles (enabled: true/false) for internal add-on tooling. No secrets, customer data, orders, pricing, or sensitive business logic. The actual add-on control moved to per-shop `shops/{id}.features` (properly scoped). Even if read, the information leaks only: 'shop-Y has wagon X enabled/disabled' — not commercially damaging.

4. **Intentional Orphaning**: Per ADDONS_PLATFORM_CONTROL_PLAN.md, the collection is intentionally left (non-destructive) as dead code pending a future cleanup. The firestore rule can stay or be removed since the collection is unused.

A malicious admin COULD manually call the vulnerable code to enumerate wagon settings across shops, but the attack is: (a) not reachable via normal app use, (b) requires technical sophistication, and (c) yields only toggle state, not sensitive data.

---

## [LOW] Deliberate Global-Config Leaks: orderStatuses, adminUIDs, adminPresence Accepted Risk
- **Layer:** firestore-rules  
- **Location:** `firestore.rules:275-277, 383-391, 378-381`  
- **Verdict:** confirmed (claimed low → real low)

**Attack:** The rules intentionally leave orderStatuses (read isActiveUser, no shopId), adminUIDs, and adminPresence as global, unscoped collections. The comments acknowledge this is a known-accepted risk. However, at 10-20 shops, an active user from shop-X can read orderStatuses shared across all shops (no leak here, it's config), but the adminPresence and adminUIDs collections leak cross-tenant admin metadata as noted above.

**Fix:** Add shopId field to adminPresence and adminUIDs documents at write-time (capture via userDoc().shopId). Tighten read rules to shop-scoped: `allow read: if isPlatform() || (isAdmin() && resource.data.shopId == userDoc().shopId);`. This hardens isolation while preserving collection structure (no client refactoring). Preserves admin role-toggle flow. For 10+ shops, migrate to per-shop sub-collections (shops/{shopId}/presence/adminPresence) to fully eliminate cross-tenant enumeration. Current design acceptable at 3-4 shops with 2 trusted platform admins but Phase 1 hardening should precede significant tenant growth.

**Verifier reasoning:** The claim is accurate: orderStatuses, adminUIDs, and adminPresence are intentionally left as unscoped global collections in Firestore rules. Verified by examining firestore.rules (lines 275-277, 378-381, 389-391) and the client code that writes these documents. adminPresence documents (useAdminPresence.js:53-61) contain only userId, email, status, activity metadata - no shopId field. adminUIDs documents (adminUIDManager.js:51-60) contain uid, email, level - no shopId field. A shop-X admin can read all records via `allow read: if isAdmin()`, exposing cross-shop admin email addresses and activity status. The rules explicitly acknowledge this: line 374 states "cross-shop presence visibility is a minor info leak, deferred" and line 387 notes "low risk: no shopId, internal admin bookkeeping." The leak is real and reachable (authenticated admin can enumerate other shop admins' identities and status), but limited in scope: email addresses and activity only, with no shop-to-admin mapping. This is metadata enumeration, not data access. Consciously accepted as acceptable trade-off to avoid breaking legitimate admin role-toggle and presence workflows.

---

## [LOW] users/{userId}/profile.jpg not scoped to shopId; but only self-writable, so cross-tenant write is unlikely (low risk)
- **Layer:** storage-rules  
- **Location:** `storage.rules:29-33`  
- **Verdict:** confirmed (claimed low → real low)

**Attack:** A user's profile photo is writable only by themselves (line 32: `request.auth.uid == userId`), so cross-tenant write is blocked. However, the path is global, and if user IDs collide across shops (Firebase Auth UIDs are globally unique, so this is NOT a risk), a malicious user could potentially impersonate another shop's user by guessing their UID and re-uploading a profile photo. Because UIDs are globally unique, this is not a practical attack.

**Fix:** No action required on users/{userId}/profile.jpg. The rule is correct and the path is unused. However, note that this finding is a red herring: the real Phase B storage isolation work must focus on shopId-partitioning actively-used storage paths (products/, branding/, marketing-materials/, admin-documents/) and replacing the global isAdmin() check with isAdminOfShop(shopId) guards. The current state (per storage.rules comments) defers this to Phase 0b, but it is critical for a 10-20 shop future.

**Verifier reasoning:** The claim correctly identifies that users/{userId}/profile.jpg is self-scoped by Firebase Auth UID (globally unique), making cross-tenant write impossible. The path is NOT USED in production code, so there is no active risk surface. The rule `request.auth.uid == userId` is correct and properly blocks unauthorized writes. However, this specific finding is a LOW-SEVERITY non-issue because: (1) the path is unused, (2) Firebase Auth UIDs are globally unique by design (not guessable), and (3) the self-scoping is effective. The real multi-tenant storage isolation risk lies in ACTIVELY USED paths (products, branding, marketing-materials, admin-documents) that lack shopId partitioning and rely on a global isAdmin() check that does NOT differentiate between admins of different shops — but that is OUT OF SCOPE for this specific claim, which is correctly assessed as low-risk.

---

## [LOW] Stripe webhook metadata carries shopId and falls back to DEFAULT - order creation is scoped
- **Layer:** functions-email-webhook  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/payment/stripeWebhook.ts:179`  
- **Verdict:** confirmed (claimed info → real low)

**Attack:** N/A - webhook is properly scoped

**Fix:** Add shop-existence validation in createPaymentIntent.ts (line 269): before resolving shopId, verify that resolvedShopId is a valid, active shop by reading from the shops collection. Example: const shopDoc = await db.collection('shops').doc(resolvedShopId).get(); if (!shopDoc.exists || !shopDoc.data().active) throw new Error('Invalid or inactive shop'). This prevents orphaned orders for non-existent shops and hardens the system for 10-20 shop production scale.

**Verifier reasoning:** The Stripe webhook correctly stamps shopId on orders from payment-intent metadata. The client's shopId comes from URL resolution (not spoofable at checkout), and prices are server-computed. However, the comment at lines 265-268 of createPaymentIntent.ts explicitly notes that validation against the shops collection is missing—a latent robustness issue, not an immediate isolation break. With multiple shops live, an invalid/tampered shopId would still create an order, but Firestore rules (isAdminOfShop gating) enforce isolation at read/write time. The isolation holds because the shopId is server-determined and Firestore rules pivot on the stored shopId field, which is immutable after creation.

---

## [LOW] AffiliateAnalyticsTab unscoped affiliateClicks batch read
- **Layer:** client-queries  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/src/pages/shop/AffiliateAnalyticsTab.jsx:57-62`  
- **Verdict:** confirmed (claimed high → real low)

**Attack:** The query fetches affiliateClicks by document ID using where('__name__', 'in', batch) without filtering by shopId. An authenticated affiliate/admin of shop A who discovers or enumerates affiliateClick IDs from shop B can read those clicks. The Firestore rules gate this on isAdminOfShop(resource.data.shopId), so currently only admins can exploit this, but the unscoped query is a code smell indicating lack of defensive client-side filtering. If rules change or an admin views this component, cross-shop data leaks.

**Fix:** Change lines 57-60 from: `const clicksQuery = query(collection(db, 'affiliateClicks'), where('__name__', 'in', batch));` to: `const clicksQuery = query(collection(db, 'affiliateClicks'), where('shopId', '==', shopId), where('__name__', 'in', batch));`. This adds a client-side scoping filter that matches the shop admin's shopId, ensuring clicks are fetched only from their own shop. The shopId variable is already imported via useShopId() at line 18, so no additional imports are needed. This hardens the code against rule misconfiguration and aligns with the defensive-filtering pattern used elsewhere (AdminAffiliateAnalytics.jsx, lines 38).

**Verifier reasoning:** The claimed unscoped batch read query IS present in the code (lines 57-62 of AffiliateAnalyticsTab.jsx), and it IS a code smell indicating lack of defensive client-side filtering. However, the exploit does NOT succeed in practice: Firestore's rule `allow read: if isAdminOfShop(resource.data.shopId)` is enforced at the database level and blocks unauthorized access per-document. If a shop A admin attempts to query a shop B click ID, the rule evaluation fails and the entire getDocs() call throws a permission error — no partial results are returned. The vulnerability is REAL as a code smell (defense-in-depth violation, inconsistency with AdminAffiliateAnalytics.jsx pattern, and latent configuration risk) but NOT exploitable given the current rule configuration. The proposed fix (add `where('shopId', '==', shopId)` alongside the `__name__ in` clause) is correct, implementable (shopId is in scope), and follows defensive coding practices.

---

## [LOW] Storage metadata userId field is NOT scoped by shopId; any admin can read/write order attachments for any shop's orders
- **Layer:** data-integrity-integrations  
- **Location:** `storage.rules:35-44 (orders/{orderId}/{fileName})`  
- **Verdict:** downgraded (claimed high → real low)

**Attack:** Order attachments are stored under /orders/{orderId}/. The read/write rules check isAdmin() OR resource.metadata.userId == request.auth.uid. An admin from shop X has isAdmin()=true and can read/write ANY order's attachments in /orders/*, including orders belonging to shop Y, since the path has no shopId prefix. An order doc is scoped by shopId in Firestore, but its Storage blobs at /orders/{orderId}/* are not.

**Fix:** Remove the unused /orders/{orderId}/{fileName} storage rule entirely (lines 35-44 in storage.rules) as part of Phase B cleanup. If order attachment storage is ever needed in the future, it should be restructured from the start with shopId partitioning: /orders/{shopId}/{orderId}/{fileName}, with rules enforcing isAdminOfShop(shopId) and NO admin-only bypass without shop scoping. Document why the rule was removed to prevent future re-adds of unscoped rules for "future features."

**Verifier reasoning:** The storage rule for /orders/{orderId}/{fileName} is technically written without shopId scoping, and the isAdmin() check would allow cross-tenant reads/writes IF an order document existed at that path with unmatched metadata.userId. However, the codebase never uses the /orders/ storage path — no client code, Cloud Functions, or order schema includes attachment uploading. All actual file uploads use properly scoped paths (pages/, admin-documents/, marketing-materials/, affiliates/). The rule is orphaned/legacy boilerplate with no reachable exploit, as there are no documents at /orders/* to attack. Severity is downgraded from high to low: the rule exists but is inert.

---

## [LOW] Firestore rules: orders list rule is complex but may have edge-case leaks with b2c guest order email matching
- **Layer:** data-integrity-integrations  
- **Location:** `firestore.rules:257-264`  
- **Verdict:** downgraded (claimed medium → real low)

**Attack:** The orders list rule at line 257-264 allows b2c guest orders to be listed by customerInfo.email. If two shops have customers with the same email, the rule matching resource.data.customerInfo.email == request.auth.token.email could theoretically match orders from both shops (though Firestore's matching is doc-by-doc). The rule appears scoped, but the email-based matching (line 263) is not explicitly filtered by shopId on the query side, relying on Firestore's path matching.

**Fix:** The Firestore rule at lines 257-264 is adequately protected by client-side shopId filtering and requires no change. The rule structure is sound (email-match is final, not primary).

However, harden the Cloud Function `deleteB2CCustomerAccount`:
1. Validate that the target customer's shopId matches the caller's shopId (from their user doc).
2. Add a shopId filter to the email-based order query: `.where('shopId', '==', targetCustomerShopId)`.
3. Consider moving this function to use the callable API with explicit tenant scoping rather than raw Admin SDK calls without validation.

**Verifier reasoning:** The claimed vulnerability in the Firestore rules list handler at lines 257-264 is **NOT EXPLOITABLE in practice** for the following reasons:

1. **Client-side safeguard is effective**: All client code that queries orders by email (CustomerAccount.jsx, AdminB2CCustomers.jsx, AdminB2CCustomerEdit.jsx) explicitly includes `where('shopId', '==', shopId)` in the query BEFORE the email filter. This means Firestore's SDK only evaluates the list rule against documents matching the shopId, preventing the cross-shop leak.

2. **Email-based matching alone is not a path to cross-tenant access**: While the rule at line 263 (`resource.data.customerInfo.email == request.auth.token.email`) doesn't explicitly check shopId, it only permits listing documents that ALSO pass the query filters. Since all callers scope by shopId first, this condition is safe.

3. **The rule does NOT allow unauthenticated access**: Only `isAuthenticated()` users can reach the email-matching clause (line 259), and their token email must match. A guest from shop A cannot impersonate a guest from shop B via email alone.

4. **No client endpoint exposes unscoped email queries**: The entire codebase shows no path where a guest or customer can query orders by email without shopId.

**However**: A more serious issue exists in the Cloud Function `deleteB2CCustomerAccount` (functions/lib/customer-admin/functions.js, lines 235-238), which queries orders by email WITHOUT shopId filtering. This function uses the Admin SDK (bypasses rules) and doesn't validate that the customer being deleted belongs to the caller's shop, allowing an admin from shop A to delete/modify customers and orders from shop B. This is a **separate, higher-severity issue** but is outside the scope of the claimed Firestore rule leak.

---

## [INFO] userDoc() Calls Scale Linearly with Query Load
- **Layer:** firestore-rules  
- **Location:** `firestore.rules:44, 73-76, 95, 127, 149, 151, 227`  
- **Verdict:** downgraded (claimed low → real info)

**Attack:** Multiple rules call `userDoc()` which invokes `get(/databases/$(database)/documents/users/$(request.auth.uid)).data` on every permission check. A shop admin querying 1000 orders triggers 1000 userDoc() reads to evaluate isAdminOfShop(). With 10-20 shops and shared rule evaluation load, this scales poorly and may hit Firestore read limits or introduce latency. An attacker could DoS the platform by crafting large list queries.

**Fix:** No code change needed — the current design is intentional and correctly isolates tenants. If performance becomes a documented issue with actual Firestore read billing problems, consider the hybrid approach proposed in the claim: (1) for list queries on read-heavy collections (orders), use cached custom claims (role/shopId/platform from request.auth.token) for the shop-scoping check, trusting the syncUserClaimsOnWrite trigger to keep them in sync (will be ~1-2s stale); (2) for mutating operations (create/update/delete), keep the userDoc() re-check for instant privilege revokes. This requires no client changes (rules-only) and would reduce scaling from O(n) reads to O(1) for large list queries. Example: change line 257 from `resource.data.shopId == userDoc().shopId` to `resource.data.shopId == request.auth.token.shopId` for admins (after adding a guard that platform admins bypass the check, since they have no shopId claim). However, prioritize this only if Firebase read metrics show it as a real bottleneck in production (monitor Firestore Capacity metrics in Google Cloud Console).

**Verifier reasoning:** This claim conflates a performance optimization concern with tenant isolation hardening. Examined evidence: (1) userDoc() is indeed called per-document during the orders list rule evaluation (firestore.rules:257), triggering get() reads; (2) custom claims ARE available and synced via syncUserClaimsOnWrite.ts, mirroring the rules' role/shopId/platform fields; (3) rules INTENTIONALLY use userDoc() for "instant revokes" rather than claims (documented in lines 23-26), a deliberate security-over-performance trade-off; (4) client code always filters orders by shopId at the query level (OrderContext.jsx:251, 308-310, 374), limiting result sets; (5) Firestore rejects entire getDocs() calls if any matched doc is unreadable (firestore.rules:89-92), preventing cross-tenant reads. The alleged DoS requires an authenticated shop admin querying their own shop's orders — no cross-tenant read is possible, no data confidentiality breach occurs, and the admin is acting within their own tenant. The performance scaling (userDoc() reads per document) is real but: (a) was an intentional design choice documented in the code, (b) only affects query performance within the caller's own shop (not a privilege escalation or isolation breach), and (c) is mitigated by typical query result limits and per-shop admin counts (~1-2 per shop). This is a resource-consumption optimization note, not a tenant isolation vulnerability.

---

## [INFO] createShopUser correctly enforces platform-only + shop existence (no issue)
- **Layer:** functions-email-webhook  
- **Location:** `/Users/mikaelohlen/Cursor Apps/b8shield_portal/functions/src/email-orchestrator/functions/createShopUser.ts:39-54`  
- **Verdict:** confirmed (claimed info → real info)

**Attack:** N/A - this function is properly protected

**Fix:** No fix needed. The function correctly implements all three layers of protection and is well-integrated with the tenant isolation hardening. Keep the current implementation and continue to rely on the requirePlatform guard and the Firestore rule enforcement for this critical access control.

**Verifier reasoning:** The createShopUser function is correctly implemented with three complementary security mechanisms that work together to enforce multi-tenant isolation: (1) requirePlatform guard at line 39 verifies the caller is a platform super-admin via Admin SDK read of the users doc (not token-based, immune to stale claims); (2) shop existence check at lines 51-54 prevents stranding admins on non-existent tenants; (3) privilege escalation guard at lines 77-86 correctly denies reuse of Auth accounts belonging to other shops, B2C customers, or affiliates. The Firestore rules (firestore.rules lines 101-104) reinforce this by preventing non-platform admins from creating users outside their own shop, and the update rule (line 126) prevents blind-writes via shopId enforcement on the existing doc. The syncUserClaimsOnWrite trigger ensures token claims stay in sync and are invalidated on privilege reduction. No cross-tenant creation path exists.

---

## Rejected (false positives)

- **[claims-provisioning] createShopUser reuse-guard allows privilege escalation if a user already has a users/{uid} doc with role==admin from a DIFFERENT shop** — The claimed exploit is not reachable. The code at line 79-86 in createShopUser.ts contains an effective isSameShopAdmin check that blocks the attack: if the check is false (meaning shopId mismatch, e.g., 'shop-y' !== 'shop-x'), the function throws an HttpsError immediately and never reaches the set() call at line 97. There is no race condition because no async operations occur between the check and the write — the updateUser call at line 87 only updates the Auth password, not the Firestore doc. The Admin SDK is used, which bypasses Firestore rules, but createShopUser is a Cloud Function callable guarded by requirePlatform, so only trusted platform operators can invoke it. The existing reuse-guard logic is sound and correctly ordered. The proposed additional guard (checking again at set-time) would be belt-and-suspenders but is not required for security.
- **[data-integrity-integrations] campaignParticipants collection lacks explicit shopId validation on creation** — The claim is factually incorrect on its core premise. campaignParticipants was added to IN_SCOPE_COLLECTIONS in the original backfill script (commit 81ce50f, line 61 of scripts/backfill-shopid.cjs). The backfill has been run to completion (2026-06-14: all 815 docs stamped, verified 0 remaining). Current state confirms 0 unstamped docs (dry-run shows "14 docs, 0 need shopId ✅"). The collection is server-only with default deny in Firestore rules; the write path (processOrderCompletion) uses Admin SDK with correct shopId stamping from trusted source (orderData.shopId). No client-side reads of campaignParticipants exist anywhere in the codebase. The claimed risk of "legacy unstamped docs" is eliminated by backfill completion and the dry-run verification showing no missing shopIds.
