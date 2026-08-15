/**
 * Firestore security-rules test — Tenant ISOLATION HARDENING (Phase A).
 *
 * Targets the cross-shop LEAKS found in the 2026-06-17 audit (see
 * docs/TENANT_ISOLATION_HARDENING_PLAN.md). Each DENY here is a leak in the
 * CURRENT rules and must pass after the rewrite; each ALLOW guards against a
 * lockout regression. Complements rules-tests/firestore-rules.test.cjs (which
 * covers the already-correct collections).
 *
 * Seeds AUTH CUSTOM CLAIMS ({role, shopId, platform}) to mirror production
 * (syncAdminClaims / createShopUser write these to the token). The hardened
 * rules prefer the claim (cheap, no get()) with a userDoc() fallback, so this
 * suite also implicitly verifies the claim path.
 *
 * RUN (never touches prod):
 *   1) JAVA_HOME=<jdk21> firebase emulators:start --only firestore --project demo-rules-test
 *   2) node rules-tests/firestore-isolation.test.cjs
 */

const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { setDoc, getDoc, doc, getDocs, query, where, collection, deleteDoc, updateDoc } =
  require('firebase/firestore');

const PROJECT_ID = 'demo-rules-test';
const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

let env;
let passed = 0;
let failed = 0;

async function check(name, promise) {
  try {
    await promise;
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name} — ${e.message}`);
    failed++;
  }
}

// Auth contexts WITH custom claims (production shape).
const platformDb = () =>
  env.authenticatedContext('mikael', { role: 'admin', platform: true, shopId: 'shopA' }).firestore();
const shopAAdminDb = () =>
  env.authenticatedContext('adminA', { role: 'admin', platform: false, shopId: 'shopA' }).firestore();
const shopBAdminDb = () =>
  env.authenticatedContext('adminB', { role: 'admin', platform: false, shopId: 'shopB' }).firestore();
const customerDb = (uid) =>
  env.authenticatedContext(uid, { email: uid + '@x.com' }).firestore();
// B2B customers are plain authenticated users (no admin/platform claims) — the
// b2bCustomers profile doc, not a claim, carries their shop + active state.
const b2bUserDb = (uid) =>
  env.authenticatedContext(uid, { email: uid + '@x.com' }).firestore();

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // users — mirror the claims on the docs too (rules may fall back to userDoc)
    await setDoc(doc(db, 'users/mikael'), { role: 'admin', platform: true, shopId: 'shopA', active: true, email: 'mikael@x.com' });
    await setDoc(doc(db, 'users/adminA'), { role: 'admin', platform: false, shopId: 'shopA', active: true, email: 'adminA@x.com' });
    await setDoc(doc(db, 'users/adminB'), { role: 'admin', platform: false, shopId: 'shopB', active: true, email: 'adminB@x.com' });
    // a plain B2B/customer user in shop B (the kind a shopA admin must not read)
    await setDoc(doc(db, 'users/custB'), { role: 'user', shopId: 'shopB', active: true, email: 'custB@x.com' });
    // a plain customer user in shop A (used to prove same-shop admin CAN manage,
    // cross-shop admin CANNOT — and that the customer reads their OWN sub-docs).
    await setDoc(doc(db, 'users/custA'), { role: 'user', shopId: 'shopA', active: true, email: 'custA@x.com' });
    // dedicated delete-target users (so the delete ALLOW tests don't remove a doc
    // that a later subcollection test depends on via parentUserShop()).
    await setDoc(doc(db, 'users/delA'), { role: 'user', shopId: 'shopA', active: true, email: 'delA@x.com' });
    await setDoc(doc(db, 'users/delB'), { role: 'user', shopId: 'shopB', active: true, email: 'delB@x.com' });

    await setDoc(doc(db, 'shops/shopA'), { name: 'Shop A', status: 'active' });
    await setDoc(doc(db, 'shops/shopB'), { name: 'Shop B', status: 'active' });

    // shop-scoped collections that currently leak on READ
    await setDoc(doc(db, 'orderStatuses/osA'), { shopId: 'shopA', label: 'Packad' });
    await setDoc(doc(db, 'orderStatuses/osB'), { shopId: 'shopB', label: 'Skickad' });
    await setDoc(doc(db, 'marketingMaterials/mmA'), { shopId: 'shopA', title: 'A flyer' });
    await setDoc(doc(db, 'marketingMaterials/mmB'), { shopId: 'shopB', title: 'B flyer' });

    // per-customer marketing materials subcollection (admin doc distribution).
    // custA is in shopA, custB is in shopB.
    await setDoc(doc(db, 'users/custA/marketingMaterials/pcmA'), { title: 'custA doc' });
    await setDoc(doc(db, 'users/custB/marketingMaterials/pcmB'), { title: 'custB doc' });

    // global config (a shop admin must NOT write these)
    await setDoc(doc(db, 'translations_sv_SE/k1'), { value: 'Hej' });
    await setDoc(doc(db, 'settings/app'), { COMPANY_NAME: 'X' });

    // wagon CRM (dining/ambassador add-ons) — platform-only after hardening
    await setDoc(doc(db, 'activities/a1'), { note: 'call' });
    await setDoc(doc(db, 'followUps/f1'), { note: 'fu' });
    await setDoc(doc(db, 'ambassadorActivities/aa1'), { note: 'amb' });
    await setDoc(doc(db, 'customerDocuments/cd1'), { note: 'doc' });
    await setDoc(doc(db, 'appSettings/s1'), { k: 'v' });
    // adminPresence keyed by the admin's OWN uid (the client writes doc id == uid).
    // TENANT-ISOLATION (Finding 2): now shopId-stamped so reads are shop-scoped.
    await setDoc(doc(db, 'adminPresence/adminA'), { uid: 'adminA', shopId: 'shopA' });
    await setDoc(doc(db, 'adminPresence/adminB'), { uid: 'adminB', shopId: 'shopB' });
    // adminUIDs registry keyed by uid, shopId-stamped (Finding 2). Platform
    // super-admin doc carries shopId: null.
    await setDoc(doc(db, 'adminUIDs/adminA'), { uid: 'adminA', shopId: 'shopA', level: 'admin' });
    await setDoc(doc(db, 'adminUIDs/adminB'), { uid: 'adminB', shopId: 'shopB', level: 'admin' });
    await setDoc(doc(db, 'adminUIDs/mikael'), { uid: 'mikael', shopId: null, level: 'super' });

    // B2B customer profiles (wholesale add-on). One per shop, owned by a
    // distinct Auth uid. Both seeded INACTIVE so the admin-activate LEGIT test
    // is a real diff and the customer self-activate DENY test is meaningful.
    await setDoc(doc(db, 'b2bCustomers/b2bA'), { firebaseAuthUid: 'b2bUserA', shopId: 'shopA', active: false, companyName: 'Acme A', email: 'b2bA@x.com' });
    await setDoc(doc(db, 'b2bCustomers/b2bB'), { firebaseAuthUid: 'b2bUserB', shopId: 'shopB', active: false, companyName: 'Acme B', email: 'b2bB@x.com' });
    // A dedicated self-owned doc for the customer self-activate/re-home DENY
    // tests, so the admin-activate LEGIT test (which flips b2bA) can't turn the
    // customer's self-activate into a value-unchanged no-op that the rule allows.
    await setDoc(doc(db, 'b2bCustomers/b2bSelf'), { firebaseAuthUid: 'b2bUserA', shopId: 'shopA', active: false, companyName: 'Self A', email: 'self@x.com' });

    // B2B Faktura orders (Phase 4): each links to a b2bCustomers doc via
    // b2bCustomerId. ordB2bA is owned by b2bUserA (via b2bA), ordB2bB by b2bUserB.
    await setDoc(doc(db, 'orders/ordB2bA'), { source: 'b2b', shopId: 'shopA', b2bCustomerId: 'b2bA', userId: 'b2bUserA', orderNumber: 'B8S-1-A', total: 100 });
    await setDoc(doc(db, 'orders/ordB2bB'), { source: 'b2b', shopId: 'shopB', b2bCustomerId: 'b2bB', userId: 'b2bUserB', orderNumber: 'B8S-1-B', total: 200 });

    // DAC7 seller due-diligence docs (sensitive PII). doc id == shopId; carries
    // shopId for the rules' equality check. Seeded for both shops to test that
    // a shop admin reads ONLY their own, and that anon CANNOT read PII at all.
    await setDoc(doc(db, 'dac7Sellers/shopA'), { shopId: 'shopA', sellerType: 'company', legalName: 'Acme A AB', taxId: '556677-8899' });
    await setDoc(doc(db, 'dac7Sellers/shopB'), { shopId: 'shopB', sellerType: 'individual', legalName: 'B Person', taxId: '19900101-1234', dateOfBirth: '1990-01-01' });

    // DAC7 identity-correction requests (seller asks, platform resolves).
    await setDoc(doc(db, 'dac7CorrectionRequests/reqA'), { shopId: 'shopA', field: 'taxId', requestedValue: 'x', status: 'pending', requestedBy: 'adminA' });
    await setDoc(doc(db, 'dac7CorrectionRequests/reqB'), { shopId: 'shopB', field: 'taxId', requestedValue: 'y', status: 'pending', requestedBy: 'adminB' });

    // POD add-on: artwork library + SKU→artwork mappings, one per shop. Shop-scoped
    // like campaigns. The print_shop role has NO rule branch (callable-projection
    // model), so these prove a SHOP ADMIN cannot cross shops — the only direct-DB
    // actor for these collections.
    await setDoc(doc(db, 'podArtwork/artA'), { shopId: 'shopA', label: 'A logo', purpose: 'apparel_dtg', originalUrl: 'gs://x', validation: { tier: 'PASS' } });
    await setDoc(doc(db, 'podArtwork/artB'), { shopId: 'shopB', label: 'B logo', purpose: 'apparel_dtg', originalUrl: 'gs://y', validation: { tier: 'PASS' } });
    await setDoc(doc(db, 'podMappings/mapA'), { shopId: 'shopA', sku: 'TSHIRT-A', artworkId: 'artA', placement: 'Brost' });
    await setDoc(doc(db, 'podMappings/mapB'), { shopId: 'shopB', sku: 'TSHIRT-B', artworkId: 'artB', placement: 'Rygg' });

    // Collections (curated product groups). PUBLISHED docs are public read
    // (storefront); DRAFTS are admin-only (P1-11). Seed both shops + a draft.
    await setDoc(doc(db, 'collections/collA'), { shopId: 'shopA', handle: 'artist-a', title: 'Artist A', type: 'manual', productIds: [], published: true, featured: true });
    await setDoc(doc(db, 'collections/collB'), { shopId: 'shopB', handle: 'artist-b', title: 'Artist B', type: 'smart', rule: { tag: 'b' }, published: true, featured: false });
    await setDoc(doc(db, 'collections/draftA'), { shopId: 'shopA', handle: 'draft-a', title: 'Unreleased drop', type: 'manual', productIds: [], published: false, featured: false });

    // P1-11 public catalogue projection: raw products (b2bPrice/podCostSek/
    // drafts) are admin-only; the storefront reads server-written productsPublic.
    await setDoc(doc(db, 'products/prodA'), { shopId: 'shopA', isActive: true, availability: { b2c: true }, name: 'A tee', b2cPrice: 199, b2bPrice: 90, podCostSek: 60 });
    await setDoc(doc(db, 'productsPublic/prodA'), { shopId: 'shopA', isActive: true, availability: { b2c: true }, name: 'A tee', b2cPrice: 199 });
    await setDoc(doc(db, 'productGroups/pgA'), { shopId: 'shopA', name: 'Legacy group' });

    // Durable printer-email outbox. This is backend infrastructure, not an
    // admin collection: even platform users must go through server functions.
    await setDoc(doc(db, 'printNotifications/orderA'), {
      orderId: 'orderA', shopId: 'shopA', status: 'pending', attempts: 0,
      createdAt: new Date(), nextAttemptAt: new Date(), lines: [],
    });

    // CMS pages: published is public, draft is admin-only (P1-11).
    await setDoc(doc(db, 'pages/pubPageA'), { shopId: 'shopA', slug: 'om-oss', status: 'published', title: 'Om oss' });
    await setDoc(doc(db, 'pages/draftPageA'), { shopId: 'shopA', slug: 'hemlig', status: 'draft', title: 'Hemlig kampanj', createdBy: 'adminA' });
  });
}

async function run() {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
  });
  await env.clearFirestore();
  await seed();

  console.log('\n=== LEGIT ACCESS still works (no lockout) ===');
  await check('shopA admin reads OWN orderStatus', assertSucceeds(getDoc(doc(shopAAdminDb(), 'orderStatuses/osA'))));
  await check('shopA admin reads OWN marketingMaterial', assertSucceeds(getDoc(doc(shopAAdminDb(), 'marketingMaterials/mmA'))));
  await check('shopA admin reads OWN user doc', assertSucceeds(getDoc(doc(shopAAdminDb(), 'users/adminA'))));
  await check('shopA admin creates a user in OWN shop (non-platform)', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'users/newA'), { role: 'admin', platform: false, shopId: 'shopA', active: true })));
  await check('shopA admin updates OWN-shop user (delA profile)', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'users/delA'), { active: false })));
  await check('shopA admin deletes OWN-shop user (delA)', assertSucceeds(
    deleteDoc(doc(shopAAdminDb(), 'users/delA'))));
  await check('platform reads any user (shopB)', assertSucceeds(getDoc(doc(platformDb(), 'users/adminB'))));
  await check('platform deletes any user (shopB delB)', assertSucceeds(deleteDoc(doc(platformDb(), 'users/delB'))));
  await check('platform writes global translation', assertSucceeds(setDoc(doc(platformDb(), 'translations_sv_SE/k2'), { value: 'Hej2' })));
  await check('platform reads wagon CRM (activities)', assertSucceeds(getDoc(doc(platformDb(), 'activities/a1'))));
  await check('anon reads global translation (storefront)', assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'translations_sv_SE/k1'))));
  // per-customer marketing materials: same-shop admin manages; customer reads own
  await check('shopA admin reads OWN-shop customer per-doc material', assertSucceeds(
    getDoc(doc(shopAAdminDb(), 'users/custA/marketingMaterials/pcmA'))));
  await check('shopA admin writes OWN-shop customer per-doc material', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'users/custA/marketingMaterials/pcmA2'), { title: 'new' })));
  await check('customer reads OWN per-doc material', assertSucceeds(
    getDoc(doc(customerDb('custA'), 'users/custA/marketingMaterials/pcmA'))));
  // marketing materials (top-level): an active non-admin (affiliate) reads OWN shop
  await check('active affiliate reads OWN-shop marketingMaterial', assertSucceeds(
    getDoc(doc(env.authenticatedContext('custA', { email: 'custA@x.com' }).firestore(), 'marketingMaterials/mmA'))));
  // adminPresence heartbeat: admin writes its OWN presence doc (id == uid),
  // shopId-stamped (Finding 2).
  await check('shopA admin writes OWN adminPresence (heartbeat)', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'adminPresence/adminA'), { uid: 'adminA', shopId: 'shopA', status: 'online' })));
  // Finding 2: presence read is now SHOP-SCOPED — own shop allowed.
  await check('shopA admin reads OWN-shop adminPresence', assertSucceeds(
    getDoc(doc(shopAAdminDb(), 'adminPresence/adminA'))));
  // adminUIDs registry: own-shop read allowed, own-shop write (role-toggle) allowed.
  await check('shopA admin reads OWN-shop adminUID doc', assertSucceeds(
    getDoc(doc(shopAAdminDb(), 'adminUIDs/adminA'))));
  await check('shopA admin creates OWN-shop adminUID (role-toggle preserved)', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'adminUIDs/newAdminA'), { uid: 'newAdminA', shopId: 'shopA', level: 'admin' })));
  await check('platform reads ANY-shop adminUID doc', assertSucceeds(
    getDoc(doc(platformDb(), 'adminUIDs/adminB'))));
  await check('platform reads ANY-shop adminPresence', assertSucceeds(
    getDoc(doc(platformDb(), 'adminPresence/adminB'))));
  // shops: own-shop admin may update storefront config (NOT payments)
  await check('shopA admin updates OWN shop storefront config', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'shops/shopA'), { storeIdentity: { tagline: 'Hej' } })));
  await check('platform sets payments.connectEnabled on a shop', assertSucceeds(
    updateDoc(doc(platformDb(), 'shops/shopA'), { 'payments.connectEnabled': true })));
  // b2bCustomers (wholesale add-on): owner reads/edits own; same-shop admin manages.
  await check('B2B customer reads OWN profile', assertSucceeds(
    getDoc(doc(b2bUserDb('b2bUserA'), 'b2bCustomers/b2bA'))));
  await check('B2B customer self-registers an INACTIVE profile (own uid)', assertSucceeds(
    setDoc(doc(b2bUserDb('b2bNewA'), 'b2bCustomers/b2bNewA'), { firebaseAuthUid: 'b2bNewA', shopId: 'shopA', active: false, companyName: 'New A', email: 'newA@x.com' })));
  await check('B2B customer edits OWN profile (non-active field)', assertSucceeds(
    updateDoc(doc(b2bUserDb('b2bUserA'), 'b2bCustomers/b2bA'), { phone: '070-1234567' })));
  await check('shopA admin reads OWN-shop b2bCustomer', assertSucceeds(
    getDoc(doc(shopAAdminDb(), 'b2bCustomers/b2bA'))));
  await check('shopA admin ACTIVATES a b2bCustomer (the gate)', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'b2bCustomers/b2bA'), { active: true })));
  await check('platform reads ANY-shop b2bCustomer', assertSucceeds(
    getDoc(doc(platformDb(), 'b2bCustomers/b2bB'))));
  // B2B orders LIST: a B2B customer lists their OWN orders (source=='b2b' +
  // b2bCustomerId links to their b2bCustomers doc). Query must be scoped the way
  // the client queries (where source/b2bCustomerId) so the per-doc rule passes.
  await check('B2B customer LISTS own orders (via b2bCustomerId linkage)', assertSucceeds(
    getDocs(query(collection(b2bUserDb('b2bUserA'), 'orders'),
      where('source', '==', 'b2b'), where('b2bCustomerId', '==', 'b2bA')))));

  // DAC7 seller PII — PLATFORM-owned record. A seller may READ their own (GDPR
  // access) + CORRECT contact fields, but NOT identity fields; platform writes
  // anything; anon NEVER.
  await check('platform creates a dac7Seller (authoritative record)', assertSucceeds(
    setDoc(doc(platformDb(), 'dac7Sellers/shopA'), { shopId: 'shopA', sellerType: 'company', legalName: 'Acme A AB', taxId: '556677-8899', address: 'Old 1' })));
  await check('shopA admin reads OWN dac7Seller (GDPR access)', assertSucceeds(
    getDoc(doc(shopAAdminDb(), 'dac7Sellers/shopA'))));
  await check('shopA admin CORRECTS own CONTACT field (address)', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'dac7Sellers/shopA'), { address: 'New 2' })));
  await check('platform reads ANY dac7Seller', assertSucceeds(
    getDoc(doc(platformDb(), 'dac7Sellers/shopB'))));
  await check('platform updates an IDENTITY field (authoritative)', assertSucceeds(
    updateDoc(doc(platformDb(), 'dac7Sellers/shopA'), { taxId: '556677-0000' })));
  // DAC7 correction requests — seller creates/reads OWN; platform resolves.
  await check('shopA admin reads OWN correction request', assertSucceeds(
    getDoc(doc(shopAAdminDb(), 'dac7CorrectionRequests/reqA'))));
  await check('shopA admin CREATES own pending correction request', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'dac7CorrectionRequests/reqA2'), { shopId: 'shopA', field: 'taxId', requestedValue: 'z', status: 'pending', requestedBy: 'adminA' })));
  await check('platform RESOLVES a correction request', assertSucceeds(
    updateDoc(doc(platformDb(), 'dac7CorrectionRequests/reqA'), { status: 'approved' })));
  await check('platform LISTS pending correction requests (across shops)', assertSucceeds(
    getDocs(query(collection(platformDb(), 'dac7CorrectionRequests'), where('status', '==', 'pending')))));

  console.log('\n=== ISOLATION: cross-shop / privilege escalation must be DENIED ===');
  // users — the biggest leak
  await check('shopA admin CANNOT read shopB admin user doc', assertFails(getDoc(doc(shopAAdminDb(), 'users/adminB'))));
  await check('shopA admin CANNOT read shopB customer user doc', assertFails(getDoc(doc(shopAAdminDb(), 'users/custB'))));
  await check('shopA admin CANNOT create a user for shopB', assertFails(
    setDoc(doc(shopAAdminDb(), 'users/evilB'), { role: 'admin', platform: false, shopId: 'shopB', active: true })));
  await check('shopA admin CANNOT create a PLATFORM user (escalation)', assertFails(
    setDoc(doc(shopAAdminDb(), 'users/evilP'), { role: 'admin', platform: true, shopId: 'shopA', active: true })));
  await check('shopA admin CANNOT create an UNSCOPED admin (no shopId)', assertFails(
    setDoc(doc(shopAAdminDb(), 'users/evilU'), { role: 'admin', active: true })));
  // users UPDATE — cross-shop blind-write (block fix #1): shopA admin must not
  // write a shopB user's doc even without re-homing/escalating (e.g. demote role).
  await check('shopA admin CANNOT update shopB user doc (blind cross-shop write)', assertFails(
    updateDoc(doc(shopAAdminDb(), 'users/adminB'), { active: false })));
  await check('shopA admin CANNOT re-home a shopB user to shopA via update', assertFails(
    updateDoc(doc(shopAAdminDb(), 'users/adminB'), { shopId: 'shopA' })));
  await check('shopA admin CANNOT escalate own-shop user to platform via update', assertFails(
    updateDoc(doc(shopAAdminDb(), 'users/adminA'), { platform: true })));
  // users DELETE — cross-shop deletion (block fix #2)
  await check('shopA admin CANNOT delete shopB user doc', assertFails(
    deleteDoc(doc(shopAAdminDb(), 'users/adminB'))));
  // per-customer marketingMaterials subcollection — cross-shop (block fix #3)
  await check('shopA admin CANNOT read shopB customer per-doc material', assertFails(
    getDoc(doc(shopAAdminDb(), 'users/custB/marketingMaterials/pcmB'))));
  await check('shopA admin CANNOT write shopB customer per-doc material', assertFails(
    setDoc(doc(shopAAdminDb(), 'users/custB/marketingMaterials/evil'), { title: 'x' })));
  // global config
  await check('shopA admin CANNOT write global translation', assertFails(setDoc(doc(shopAAdminDb(), 'translations_sv_SE/k1'), { value: 'hacked' })));
  await check('shopA admin CANNOT write settings/app (global)', assertFails(updateDoc(doc(shopAAdminDb(), 'settings/app'), { COMPANY_NAME: 'hacked' })));
  // cross-shop reads on shop-scoped collections.
  // orderStatuses is DEAD/GLOBAL config (no shopId) — by the locked decision its
  // read stays isActiveUser() and is intentionally NOT shop-scoped, so an active
  // admin reading any orderStatus is ALLOWED by design. The hardening on this
  // collection is the WRITE (now platform-only), asserted below.
  await check('shopA admin CAN read any orderStatus (global/dead by design)', assertSucceeds(getDoc(doc(shopAAdminDb(), 'orderStatuses/osB'))));
  await check('shopA admin CANNOT WRITE orderStatuses (platform-only global)', assertFails(setDoc(doc(shopAAdminDb(), 'orderStatuses/osHack'), { label: 'x' })));
  await check('shopA admin CANNOT read shopB marketingMaterial', assertFails(getDoc(doc(shopAAdminDb(), 'marketingMaterials/mmB'))));
  // wagon CRM — platform-only after hardening (a shop admin must be denied)
  await check('shopA admin CANNOT read wagon CRM (activities)', assertFails(getDoc(doc(shopAAdminDb(), 'activities/a1'))));
  await check('shopA admin CANNOT write wagon CRM (followUps)', assertFails(setDoc(doc(shopAAdminDb(), 'followUps/f2'), { note: 'x' })));
  await check('shopA admin CANNOT read ambassadorActivities', assertFails(getDoc(doc(shopAAdminDb(), 'ambassadorActivities/aa1'))));
  await check('shopA admin CANNOT read customerDocuments', assertFails(getDoc(doc(shopAAdminDb(), 'customerDocuments/cd1'))));
  await check('shopA admin CANNOT write appSettings', assertFails(setDoc(doc(shopAAdminDb(), 'appSettings/s2'), { k: 'x' })));
  // shops: single-doc GET public (storefront), LIST platform-only (no cross-tenant enumeration)
  await check('anon CAN get a single shop doc (storefront config)', assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'shops/shopB'))));
  await check('shopA admin CANNOT LIST all shops (enumeration)', assertFails(getDocs(collection(shopAAdminDb(), 'shops'))));
  await check('platform CAN list all shops (operator console)', assertSucceeds(getDocs(collection(platformDb(), 'shops'))));
  // shops.payments is platform-/server-set: a shop admin must NOT self-grant it.
  // Use shopB (whose payments map the platform ALLOW test did not touch, so the
  // write is a real diff and not a value-unchanged no-op) via the shopB admin.
  await check('shopB admin CANNOT set payments.connectEnabled on own shop', assertFails(
    updateDoc(doc(shopBAdminDb(), 'shops/shopB'), { 'payments.connectEnabled': true })));
  await check('shopB admin CANNOT set payments.commissionBps on own shop', assertFails(
    updateDoc(doc(shopBAdminDb(), 'shops/shopB'), { 'payments.commissionBps': 9999 })));
  // adminPresence: an admin may write ONLY their own presence doc (id == uid).
  await check('shopA admin CANNOT write ANOTHER admin presence doc (not own uid)', assertFails(
    setDoc(doc(shopAAdminDb(), 'adminPresence/adminB'), { uid: 'adminB', status: 'spoofed' })));
  // Finding 2: presence READ is now SHOP-SCOPED — cross-shop read denied.
  await check('shopA admin CANNOT read shopB adminPresence (cross-shop enum)', assertFails(
    getDoc(doc(shopAAdminDb(), 'adminPresence/adminB'))));
  // Finding 2: adminUIDs READ is now SHOP-SCOPED — no cross-shop admin enumeration.
  await check('shopA admin CANNOT read shopB adminUID doc (cross-shop enum)', assertFails(
    getDoc(doc(shopAAdminDb(), 'adminUIDs/adminB'))));
  await check('shopA admin CANNOT read PLATFORM super-admin UID doc (shopId null)', assertFails(
    getDoc(doc(shopAAdminDb(), 'adminUIDs/mikael'))));
  // Finding 2: adminUIDs WRITE is shop-scoped — cannot inject a cross-shop admin.
  await check('shopA admin CANNOT create a shopB adminUID (cross-shop injection)', assertFails(
    setDoc(doc(shopAAdminDb(), 'adminUIDs/evilB'), { uid: 'evilB', shopId: 'shopB', level: 'admin' })));
  await check('shopA admin CANNOT create an UNSCOPED adminUID (no shopId)', assertFails(
    setDoc(doc(shopAAdminDb(), 'adminUIDs/evilU'), { uid: 'evilU', level: 'admin' })));
  await check('shopA admin CANNOT delete a shopB adminUID doc', assertFails(
    deleteDoc(doc(shopAAdminDb(), 'adminUIDs/adminB'))));
  // b2bCustomers — cross-shop + self-activation escalation must be DENIED.
  await check('shopA admin CANNOT read shopB b2bCustomer (cross-shop)', assertFails(
    getDoc(doc(shopAAdminDb(), 'b2bCustomers/b2bB'))));
  await check('shopA admin CANNOT update shopB b2bCustomer (cross-shop)', assertFails(
    updateDoc(doc(shopAAdminDb(), 'b2bCustomers/b2bB'), { active: true })));
  await check('shopA admin CANNOT delete shopB b2bCustomer (cross-shop)', assertFails(
    deleteDoc(doc(shopAAdminDb(), 'b2bCustomers/b2bB'))));
  await check('B2B customer CANNOT read ANOTHER customer profile', assertFails(
    getDoc(doc(b2bUserDb('b2bUserA'), 'b2bCustomers/b2bB'))));
  await check('B2B self-registrant CANNOT create an ACTIVE profile (self-activation)', assertFails(
    setDoc(doc(b2bUserDb('b2bEvil'), 'b2bCustomers/b2bEvil'), { firebaseAuthUid: 'b2bEvil', shopId: 'shopA', active: true, email: 'evil@x.com' })));
  await check('B2B self-registrant CANNOT create a profile for ANOTHER uid', assertFails(
    setDoc(doc(b2bUserDb('b2bUserA'), 'b2bCustomers/spoof'), { firebaseAuthUid: 'someoneElse', shopId: 'shopA', active: false, email: 's@x.com' })));
  // Client contract: create MUST send an explicit active:false. A create that
  // OMITS active is denied (missing-key read fails closed) — register code must
  // always stamp active:false.
  await check('B2B self-registrant create OMITTING active is DENIED (must send active:false)', assertFails(
    setDoc(doc(b2bUserDb('b2bNoActive'), 'b2bCustomers/b2bNoActive'), { firebaseAuthUid: 'b2bNoActive', shopId: 'shopA', email: 'na@x.com' })));
  await check('B2B customer CANNOT self-activate via update (the gate)', assertFails(
    updateDoc(doc(b2bUserDb('b2bUserA'), 'b2bCustomers/b2bSelf'), { active: true })));
  await check('B2B customer CANNOT re-home self to another shop', assertFails(
    updateDoc(doc(b2bUserDb('b2bUserA'), 'b2bCustomers/b2bSelf'), { shopId: 'shopB' })));
  await check('B2B customer CANNOT rewrite own firebaseAuthUid (orphan/hand-off)', assertFails(
    updateDoc(doc(b2bUserDb('b2bUserA'), 'b2bCustomers/b2bSelf'), { firebaseAuthUid: 'someoneElse' })));
  // B2B orders LIST isolation: a B2B customer must NOT list ANOTHER customer's
  // B2B orders, even cross-shop (b2bUserA querying b2bUserB's order in shopB).
  await check('B2B customer CANNOT list ANOTHER customer B2B orders (cross-customer/shop)', assertFails(
    getDocs(query(collection(b2bUserDb('b2bUserA'), 'orders'),
      where('source', '==', 'b2b'), where('b2bCustomerId', '==', 'b2bB')))));
  // And cannot enumerate ALL b2b orders by source alone (matches b2bB → denied).
  await check('B2B customer CANNOT list ALL b2b orders (unscoped source query)', assertFails(
    getDocs(query(collection(b2bUserDb('b2bUserA'), 'orders'), where('source', '==', 'b2b')))));

  // DAC7 PII isolation — the whole reason it's NOT on the public shops doc.
  await check('ANON CANNOT read dac7Seller PII (not public, unlike shops)', assertFails(
    getDoc(doc(env.unauthenticatedContext().firestore(), 'dac7Sellers/shopA'))));
  await check('shopA admin CANNOT read shopB dac7Seller PII (cross-shop)', assertFails(
    getDoc(doc(shopAAdminDb(), 'dac7Sellers/shopB'))));
  await check('shopA admin CANNOT write a dac7Seller under shopB (cross-shop)', assertFails(
    setDoc(doc(shopAAdminDb(), 'dac7Sellers/shopB'), { shopId: 'shopB', legalName: 'evil' })));
  await check('plain customer CANNOT read dac7Seller PII', assertFails(
    getDoc(doc(customerDb('custA'), 'dac7Sellers/shopA'))));
  // Seller may NOT CREATE the record (platform-owned) nor SELF-EDIT identity.
  await check('shopA admin CANNOT create own dac7Seller (platform-owned record)', assertFails(
    setDoc(doc(shopAAdminDb(), 'dac7Sellers/shopNew'), { shopId: 'shopNew', legalName: 'x' })));
  await check('shopA admin CANNOT self-edit IDENTITY field (taxId)', assertFails(
    updateDoc(doc(shopAAdminDb(), 'dac7Sellers/shopA'), { taxId: 'fake-id' })));
  await check('shopA admin CANNOT self-edit IDENTITY field (dateOfBirth)', assertFails(
    updateDoc(doc(shopAAdminDb(), 'dac7Sellers/shopA'), { dateOfBirth: '2000-01-01' })));
  await check('shopA admin CANNOT self-write the reported transparency record', assertFails(
    updateDoc(doc(shopAAdminDb(), 'dac7Sellers/shopA'), { reported: [{ year: 2025, txCountReported: 999 }] })));
  await check('shopA admin CANNOT enumerate dac7Sellers (list denied)', assertFails(
    getDocs(query(collection(shopAAdminDb(), 'dac7Sellers')))));
  // Correction requests — cross-shop + self-approve denials.
  await check('shopA admin CANNOT read shopB correction request', assertFails(
    getDoc(doc(shopAAdminDb(), 'dac7CorrectionRequests/reqB'))));
  await check('shopA admin CANNOT create a request under shopB', assertFails(
    setDoc(doc(shopAAdminDb(), 'dac7CorrectionRequests/evilReq'), { shopId: 'shopB', field: 'taxId', requestedValue: 'x', status: 'pending' })));
  await check('shopA admin CANNOT create a PRE-APPROVED request (self-approve)', assertFails(
    setDoc(doc(shopAAdminDb(), 'dac7CorrectionRequests/evilReq2'), { shopId: 'shopA', field: 'taxId', requestedValue: 'x', status: 'approved' })));
  await check('shopA admin CANNOT resolve (approve) own request', assertFails(
    updateDoc(doc(shopAAdminDb(), 'dac7CorrectionRequests/reqA'), { status: 'approved' })));

  // ── POD add-on: podArtwork + podMappings are shop-scoped. The print_shop role
  //    has NO rule branch (callable-projection model), so the only direct-DB actor
  //    is the shop admin — these prove it can't cross shops. ──
  console.log('\n=== POD add-on isolation ===');
  // LEGIT (no lockout): own-shop admin can read + write own.
  await check('shopA admin reads OWN podArtwork', assertSucceeds(getDoc(doc(shopAAdminDb(), 'podArtwork/artA'))));
  await check('shopA admin reads OWN podMapping', assertSucceeds(getDoc(doc(shopAAdminDb(), 'podMappings/mapA'))));
  await check('shopA admin CREATES own podArtwork', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'podArtwork/artA2'), { shopId: 'shopA', label: 'A2', purpose: 'mug_wrap', originalUrl: 'gs://z' })));
  await check('shopA admin CREATES own podMapping', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'podMappings/mapA2'), { shopId: 'shopA', sku: 'MUG-A', artworkId: 'artA2', placement: 'Wrap' })));
  await check('platform reads ANY podArtwork', assertSucceeds(getDoc(doc(platformDb(), 'podArtwork/artB'))));
  await check('platform reads ANY podMapping', assertSucceeds(getDoc(doc(platformDb(), 'podMappings/mapB'))));
  // DENY: cross-shop read + write on both collections.
  await check('shopA admin CANNOT read shopB podArtwork', assertFails(getDoc(doc(shopAAdminDb(), 'podArtwork/artB'))));
  await check('shopA admin CANNOT read shopB podMapping', assertFails(getDoc(doc(shopAAdminDb(), 'podMappings/mapB'))));
  await check('shopA admin CANNOT update shopB podArtwork', assertFails(
    updateDoc(doc(shopAAdminDb(), 'podArtwork/artB'), { label: 'hacked' })));
  await check('shopA admin CANNOT delete shopB podArtwork', assertFails(deleteDoc(doc(shopAAdminDb(), 'podArtwork/artB'))));
  await check('shopA admin CANNOT update shopB podMapping', assertFails(
    updateDoc(doc(shopAAdminDb(), 'podMappings/mapB'), { placement: 'hacked' })));
  await check('shopA admin CANNOT delete shopB podMapping', assertFails(deleteDoc(doc(shopAAdminDb(), 'podMappings/mapB'))));
  await check('shopA admin CANNOT create podArtwork UNDER shopB (forged shopId)', assertFails(
    setDoc(doc(shopAAdminDb(), 'podArtwork/evilB'), { shopId: 'shopB', label: 'evil', originalUrl: 'gs://e' })));
  await check('shopA admin CANNOT create podMapping UNDER shopB (forged shopId)', assertFails(
    setDoc(doc(shopAAdminDb(), 'podMappings/evilMapB'), { shopId: 'shopB', sku: 'X', artworkId: 'artB' })));
  // A plain customer must not touch POD config at all.
  await check('plain customer CANNOT read podArtwork', assertFails(getDoc(doc(customerDb('custA'), 'podArtwork/artA'))));
  await check('plain customer CANNOT read podMapping', assertFails(getDoc(doc(customerDb('custA'), 'podMappings/mapA'))));

  // ── Collections (curated product groups). PUBLIC read is INTENDED (storefront
  //    renders them anonymously, exactly like products). Isolation is on the WRITE
  //    side: a shop admin may only create/update/delete their OWN shop's
  //    collections, and cannot forge another shop's shopId on create. ──
  console.log('\n=== Collections isolation ===');
  // LEGIT (no lockout): storefront (anon) + own-shop admin read; own admin writes.
  await check('anon reads a collection (storefront, public)', assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'collections/collA'))));
  await check('shopA admin reads OWN collection', assertSucceeds(getDoc(doc(shopAAdminDb(), 'collections/collA'))));
  await check('shopA admin CREATES own collection', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'collections/collA2'), { shopId: 'shopA', handle: 'artist-a2', title: 'A2', type: 'manual', productIds: [], published: false, featured: false })));
  await check('shopA admin UPDATES own collection', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'collections/collA'), { featured: false })));
  await check('shopA admin DELETES own collection', assertSucceeds(deleteDoc(doc(shopAAdminDb(), 'collections/collA2'))));
  await check('platform reads ANY collection (shopB)', assertSucceeds(getDoc(doc(platformDb(), 'collections/collB'))));
  await check('platform updates ANY collection (shopB)', assertSucceeds(updateDoc(doc(platformDb(), 'collections/collB'), { featured: true })));
  // DENY (the isolation guarantee): no cross-shop WRITE/DELETE, no forged create.
  await check('shopA admin CANNOT update shopB collection', assertFails(
    updateDoc(doc(shopAAdminDb(), 'collections/collB'), { title: 'hacked' })));
  await check('shopA admin CANNOT delete shopB collection', assertFails(deleteDoc(doc(shopAAdminDb(), 'collections/collB'))));
  await check('shopA admin CANNOT create collection UNDER shopB (forged shopId)', assertFails(
    setDoc(doc(shopAAdminDb(), 'collections/evilB'), { shopId: 'shopB', handle: 'evil', title: 'evil', type: 'manual', productIds: [] })));
  await check('shopA admin CANNOT create collection with NO shopId', assertFails(
    setDoc(doc(shopAAdminDb(), 'collections/noShop'), { handle: 'no-shop', title: 'x', type: 'manual', productIds: [] })));
  // A plain customer must not write collections (read is public, write is admin-only).
  await check('plain customer CANNOT create a collection', assertFails(
    setDoc(doc(customerDb('custA'), 'collections/custColl'), { shopId: 'shopA', handle: 'c', title: 'c', type: 'manual', productIds: [] })));
  // P1-11 draft disclosure: unpublished collections are admin-only.
  await check('anon CANNOT read a DRAFT collection (P1-11)', assertFails(
    getDoc(doc(env.unauthenticatedContext().firestore(), 'collections/draftA'))));
  await check('shopA admin reads OWN draft collection', assertSucceeds(getDoc(doc(shopAAdminDb(), 'collections/draftA'))));

  // ── P1-11 public catalogue projection: the storefront reads productsPublic
  //    (world-readable, server-written); the RAW products collection — which
  //    carries b2bPrice, podCostSek and drafts — is admin/platform-only, and
  //    the mirror is never client-writable (not even platform: the sync
  //    trigger + backfill write via Admin SDK, which bypasses rules). ──
  console.log('\n=== P1-11 public catalogue projection ===');
  await check('anon reads productsPublic (storefront catalogue)', assertSucceeds(
    getDoc(doc(env.unauthenticatedContext().firestore(), 'productsPublic/prodA'))));
  await check('anon CANNOT read RAW product (b2bPrice/podCostSek leak — P1-11)', assertFails(
    getDoc(doc(env.unauthenticatedContext().firestore(), 'products/prodA'))));
  await check('plain customer CANNOT read RAW product', assertFails(getDoc(doc(customerDb('custA'), 'products/prodA'))));
  await check('shopA admin reads OWN raw product', assertSucceeds(getDoc(doc(shopAAdminDb(), 'products/prodA'))));
  await check('shopB admin CANNOT read shopA raw product', assertFails(getDoc(doc(shopBAdminDb(), 'products/prodA'))));
  await check('platform reads any raw product', assertSucceeds(getDoc(doc(platformDb(), 'products/prodA'))));
  await check('anon CANNOT write productsPublic', assertFails(
    setDoc(doc(env.unauthenticatedContext().firestore(), 'productsPublic/hack'), { shopId: 'shopA', name: 'x' })));
  await check('shopA admin CANNOT write productsPublic (server-only mirror)', assertFails(
    updateDoc(doc(shopAAdminDb(), 'productsPublic/prodA'), { name: 'x' })));
  await check('platform CANNOT write productsPublic via client SDK', assertFails(
    updateDoc(doc(platformDb(), 'productsPublic/prodA'), { name: 'x' })));
  await check('anon CANNOT read productGroups (legacy, admin-only)', assertFails(
    getDoc(doc(env.unauthenticatedContext().firestore(), 'productGroups/pgA'))));

  // ── P1-11 CMS pages draft disclosure: published pages stay public. ──
  await check('anon reads a PUBLISHED page', assertSucceeds(
    getDoc(doc(env.unauthenticatedContext().firestore(), 'pages/pubPageA'))));
  await check('anon CANNOT read a DRAFT page (P1-11)', assertFails(
    getDoc(doc(env.unauthenticatedContext().firestore(), 'pages/draftPageA'))));
  await check('shopA admin reads OWN draft page', assertSucceeds(getDoc(doc(shopAAdminDb(), 'pages/draftPageA'))));
  await check('shopB admin CANNOT read shopA draft page', assertFails(getDoc(doc(shopBAdminDb(), 'pages/draftPageA'))));

  // ── P0-01 RE-HOMING (2026-08-15 audit): shopId is IMMUTABLE on client
  //    updates. The pre-fix rules authorized updates against the OLD
  //    resource.data.shopId only, so a shopA admin could take an A-owned doc
  //    and set shopId:'shopB' — re-homing it into another tenant. Every
  //    tenant-scoped collection family gets the same three probes:
  //      1. own-doc re-home to shopB → DENY (the vulnerability)
  //      2. platform re-home via client SDK → DENY (re-homing is server-only)
  //      3. benign same-shop update → ALLOW (no lockout regression)
  //    Plus: writing the IDENTICAL shopId passes (partial-update compat). ──
  console.log('\n=== P0-01 re-homing: shopId immutable on update ===');
  const REHOME = [
    ['products',              { name: 'P', isActive: true, b2cPrice: 100 }],
    ['productGroups',         { name: 'G' }],
    ['collections',           { handle: 'rh', title: 'C', type: 'manual', productIds: [] }],
    ['pages',                 { title: 'Pg' }],
    ['orders',                { status: 'pending', total: 1, source: 'b2c' }],
    ['affiliates',            { email: 'rhaff@x.com', status: 'active', affiliateCode: 'RH1' }],
    ['affiliateClicks',       { code: 'RH1' }],
    ['affiliatePayouts',      { amount: 1, affiliateId: 'rhaff' }],
    ['discountCodes',         { code: 'RHC', active: true }],
    ['campaigns',             { name: 'K' }],
    ['socialPosts',           { caption: 's' }],
    ['marketingMaterials',    { title: 'm' }],
    ['podArtwork',            { label: 'a', originalUrl: 'gs://a' }],
    ['podMappings',           { sku: 'RH-SKU', artworkId: 'a1' }],
    ['affiliateApplications', { email: 'rhapp@x.com', name: 'N', status: 'pending' }],
    ['b2cCustomers',          { firebaseAuthUid: 'rhOwnerC', email: 'rhc@x.com' }],
    ['b2bCustomers',          { firebaseAuthUid: 'rhOwnerB', email: 'rhb@x.com', active: false }],
  ];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const raw = ctx.firestore();
    for (const [coll, data] of REHOME) {
      await setDoc(doc(raw, `${coll}/rehome_${coll}`), { shopId: 'shopA', ...data });
    }
  });
  // Orders are field-allowlisted for shop admins (P1-09), so their benign
  // probe must use an allowlisted key; every other collection stays free-form.
  const BENIGN_PROBE = { orders: { status: 'processing', updatedAt: new Date() } };
  for (const [coll] of REHOME) {
    const path = `${coll}/rehome_${coll}`;
    await check(`${coll}: shopA admin CANNOT re-home own doc to shopB`, assertFails(
      updateDoc(doc(shopAAdminDb(), path), { shopId: 'shopB' })));
    await check(`${coll}: platform CANNOT re-home via client SDK (server-only op)`, assertFails(
      updateDoc(doc(platformDb(), path), { shopId: 'shopB' })));
    await check(`${coll}: benign same-shop update still ALLOWED`, assertSucceeds(
      updateDoc(doc(shopAAdminDb(), path), BENIGN_PROBE[coll] || { rehomeProbe: 1 })));
  }

  // ── P1-09: orders are ACCOUNTING records — field-allowlist + status guard ──
  console.log('\n=== P1-09: orders field-allowlist for shop admins ===');
  await check('shop admin updates STATUS WORKFLOW fields (ALLOW — the real admin flow)', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'orders/rehome_orders'),
      { status: 'shipped', updatedAt: new Date(), trackingNumber: 'ABC123', statusHistory: [] })));
  await check('shop admin CANNOT rewrite the order TOTAL', assertFails(
    updateDoc(doc(shopAAdminDb(), 'orders/rehome_orders'), { total: 0.01 })));
  await check('shop admin CANNOT touch payment.* (refund markers)', assertFails(
    updateDoc(doc(shopAAdminDb(), 'orders/rehome_orders'), { 'payment.refundedTotalSek': 99999 })));
  await check('shop admin CANNOT replace immutable productionSnapshot', assertFails(
    updateDoc(doc(shopAAdminDb(), 'orders/rehome_orders'), {
      productionSnapshot: { version: 1, lines: [] },
    })));
  await check('shop admin CANNOT disable the productionSnapshotRequired lock', assertFails(
    updateDoc(doc(shopAAdminDb(), 'orders/rehome_orders'), { productionSnapshotRequired: false })));
  await check('shop admin CANNOT rewrite customer PII on the order', assertFails(
    updateDoc(doc(shopAAdminDb(), 'orders/rehome_orders'), { 'customerInfo.email': 'evil@x.com' })));
  await check('shop admin CANNOT self-mark status refunded (commission-reversal without money)', assertFails(
    updateDoc(doc(shopAAdminDb(), 'orders/rehome_orders'), { status: 'refunded' })));
  await check('shop admin CANNOT mark partially_refunded from the client either', assertFails(
    updateDoc(doc(shopAAdminDb(), 'orders/rehome_orders'), { status: 'partially_refunded' })));
  await check('shop admin cancel flow (status+cancelledBy/At) still ALLOWED', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'orders/rehome_orders'),
      { status: 'cancelled', updatedAt: new Date(), cancelledBy: 'adminA', cancelledAt: new Date() })));
  await check('shop admin CANNOT delete an order (accounting record)', assertFails(
    deleteDoc(doc(shopAAdminDb(), 'orders/rehome_orders'))));
  // Terminal-refunded guard: a fully refunded order can't be flipped back into
  // the workflow by a shop admin (it would re-enter the print queue).
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'orders/refundedOrder'), {
      shopId: 'shopA', status: 'refunded', total: 100, source: 'b2c',
    });
  });
  await check('shop admin CANNOT resurrect a REFUNDED order back to processing', assertFails(
    updateDoc(doc(shopAAdminDb(), 'orders/refundedOrder'), { status: 'processing', updatedAt: new Date() })));
  await check('platform edits a non-workflow field (broad edit retained)', assertSucceeds(
    updateDoc(doc(platformDb(), 'orders/rehome_orders'), { adminNote: 'platform annotation' })));
  await check('platform deletes an order (cleanup stays possible)', assertSucceeds(
    deleteDoc(doc(platformDb(), 'orders/rehome_orders'))));
  // Partial-update compat: an update that WRITES shopId with the identical
  // value is not a re-home (affectedKeys excludes unchanged keys) — the common
  // "save whole form" admin pattern must keep working.
  await check('products: update writing IDENTICAL shopId still ALLOWED (form-save compat)', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'products/rehome_products'), { shopId: 'shopA', name: 'P2' })));
  // Owner-side re-home probes (customers must not move themselves either).
  await check('b2cCustomers: the OWNER cannot re-home their own profile', assertFails(
    updateDoc(doc(customerDb('rhOwnerC'), 'b2cCustomers/rehome_b2cCustomers'), { shopId: 'shopB' })));

  // ── P0-01 family: adminUIDs takeover + adminPresence forged stamp ──
  console.log('\n=== P0-01 family: adminUIDs update guard + adminPresence stamp ===');
  await check('shopA admin CANNOT take over a shopB adminUIDs doc (rewrite shopId to A)', assertFails(
    updateDoc(doc(shopAAdminDb(), 'adminUIDs/adminB'), { shopId: 'shopA' })));
  await check('shopA admin CANNOT move own adminUIDs doc to shopB', assertFails(
    updateDoc(doc(shopAAdminDb(), 'adminUIDs/adminA'), { shopId: 'shopB' })));
  await check('shopA admin updates own adminUIDs doc same-shop (ALLOW, no lockout)', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'adminUIDs/adminA'), { level: 'admin' })));
  await check('shopA admin CANNOT stamp own presence with shopB (forged tenant)', assertFails(
    setDoc(doc(shopAAdminDb(), 'adminPresence/adminA'), { uid: 'adminA', shopId: 'shopB', status: 'online' })));
  await check('shopA admin heartbeats own presence with own shopId (ALLOW)', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'adminPresence/adminA'), { uid: 'adminA', shopId: 'shopA', status: 'online' })));
  await check('shopA admin deletes own presence (ALLOW — sign-out cleanup)', assertSucceeds(
    deleteDoc(doc(shopAAdminDb(), 'adminPresence/adminA'))));

  // ── P1-04 (2026-08-15): impersonationAudit is APPEND-ONLY — create by the
  //    actor, endedAt-stamp the only legal mutation, everything else immutable. ──
  console.log('\n=== P1-04: impersonationAudit append-only ===');
  await check('platform CREATES own audit record', assertSucceeds(
    setDoc(doc(platformDb(), 'impersonationAudit/aud1'), {
      actorUid: 'mikael', shopId: 'shopB', reason: 'support', startedAt: new Date(), endedAt: null, endReason: null,
    })));
  await check('platform CANNOT create audit record spoofing another actor', assertFails(
    setDoc(doc(platformDb(), 'impersonationAudit/audSpoof'), {
      actorUid: 'someone-else', shopId: 'shopB', reason: 'support', startedAt: new Date(), endedAt: null,
    })));
  // THE REAL CLIENT PAYLOAD (writeImpersonationEnd): {endedAt, endReason} —
  // probing with anything less lets a too-strict rule pass the suite while
  // silently breaking prod (verifier finding, 2026-08-15).
  await check('platform ends session with the REAL {endedAt, endReason} payload', assertSucceeds(
    updateDoc(doc(platformDb(), 'impersonationAudit/aud1'), { endedAt: new Date(), endReason: 'manual' })));
  await check('platform CANNOT rewrite the reason (append-only)', assertFails(
    updateDoc(doc(platformDb(), 'impersonationAudit/aud1'), { reason: 'edited after the fact' })));
  await check('platform CANNOT rewrite actorUid (append-only)', assertFails(
    updateDoc(doc(platformDb(), 'impersonationAudit/aud1'), { actorUid: 'patsy' })));
  await check('platform CANNOT stamp endedAt AND touch another field', assertFails(
    updateDoc(doc(platformDb(), 'impersonationAudit/aud1'), { endedAt: new Date(), shopId: 'shopA' })));
  await check('audit records are NEVER deletable', assertFails(
    deleteDoc(doc(platformDb(), 'impersonationAudit/aud1'))));
  await check('shop admin CANNOT read audit records', assertFails(
    getDoc(doc(shopAAdminDb(), 'impersonationAudit/aud1'))));

  // ── P1-15: printNotifications is a strictly server-only outbox. The broad
  //    default-deny rule must cover every client role and operation. ──
  console.log('\n=== P1-15: printNotifications server-only outbox ===');
  const anonDb = env.unauthenticatedContext().firestore();
  await check('anon CANNOT read a print notification', assertFails(
    getDoc(doc(anonDb, 'printNotifications/orderA'))));
  await check('anon CANNOT list print notifications', assertFails(
    getDocs(collection(anonDb, 'printNotifications'))));
  await check('anon CANNOT create a print notification', assertFails(
    setDoc(doc(anonDb, 'printNotifications/anon'), { status: 'sent' })));
  for (const [label, actorDb] of [['shop admin', shopAAdminDb()], ['platform admin', platformDb()]]) {
    await check(`${label} CANNOT read a print notification`, assertFails(
      getDoc(doc(actorDb, 'printNotifications/orderA'))));
    await check(`${label} CANNOT list print notifications`, assertFails(
      getDocs(collection(actorDb, 'printNotifications'))));
    await check(`${label} CANNOT create a print notification`, assertFails(
      setDoc(doc(actorDb, `printNotifications/${label.replace(' ', '-')}`), { status: 'sent' })));
    await check(`${label} CANNOT update a print notification`, assertFails(
      updateDoc(doc(actorDb, 'printNotifications/orderA'), { status: 'sent' })));
    await check(`${label} CANNOT delete a print notification`, assertFails(
      deleteDoc(doc(actorDb, 'printNotifications/orderA'))));
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  await env.cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('Harness error:', e); process.exit(2); });
