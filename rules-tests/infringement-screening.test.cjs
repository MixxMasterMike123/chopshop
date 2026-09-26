/**
 * Firestore rules — SnapWear A10 (notice & takedown) + A11 (brand screening).
 *
 *   infringementReports: reporter PII (name + email) → PLATFORM-only read;
 *     never client-creatable (only the submitInfringementReport callable,
 *     Admin SDK); platform may move status/note/handledAt/handledBy only.
 *   products.screening / products.takedown: server/platform-written only — a
 *     shop admin can't stamp, clear or forge them, and can't flip isActive on a
 *     taken-down product (the takedown would be one checkbox from undone).
 *     Ordinary seller edits must keep working (lockout regression guard).
 *
 * RUN (never touches prod):
 *   1) JAVA_HOME=<jdk21> firebase emulators:start --only firestore --project demo-rules-test
 *   2) node rules-tests/infringement-screening.test.cjs
 */

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { setDoc, getDoc, getDocs, addDoc, doc, collection, query, where, updateDoc, deleteDoc, deleteField } =
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

const platformDb = () =>
  env.authenticatedContext('mikael', { role: 'admin', platform: true, shopId: 'shopA' }).firestore();
const shopAAdminDb = () =>
  env.authenticatedContext('adminA', { role: 'admin', platform: false, shopId: 'shopA' }).firestore();
const shopBAdminDb = () =>
  env.authenticatedContext('adminB', { role: 'admin', platform: false, shopId: 'shopB' }).firestore();
const customerDb = () => env.authenticatedContext('cust1', { email: 'c@x.com' }).firestore();
const anonDb = () => env.unauthenticatedContext().firestore();

const REPORT = {
  shopId: 'shopA', productId: 'prodA', productName: 'Kent tee', productUrl: 'https://shop/shopA/product/kent_KENT',
  reporterName: 'Rättighetshavare', reporterOrg: 'Label AB', reporterEmail: 'legal@label.se',
  rightType: 'trademark', description: 'Säljer vårt skyddade varumärke utan licens.', attestation: true,
  status: 'new', source: 'storefront', createdAt: new Date(),
};

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/mikael'), { role: 'admin', platform: true, shopId: 'shopA', active: true });
    await setDoc(doc(db, 'users/adminA'), { role: 'admin', platform: false, shopId: 'shopA', active: true });
    await setDoc(doc(db, 'users/adminB'), { role: 'admin', platform: false, shopId: 'shopB', active: true });
    await setDoc(doc(db, 'users/cust1'), { role: 'user', shopId: 'shopA', active: true });

    await setDoc(doc(db, 'infringementReports/rep1'), REPORT);
    await setDoc(doc(db, 'infringementReports/rep2'), { ...REPORT, shopId: 'shopB' });

    // A live flagged product, a live clean product, and a taken-down product.
    await setDoc(doc(db, 'products/flagged'), {
      shopId: 'shopA', name: 'Kent tee', sku: 'KENT', isActive: true, availability: { b2c: true },
      screening: { status: 'flagged', hits: ['kent'], source: 'server' },
    });
    await setDoc(doc(db, 'products/clean'), {
      shopId: 'shopA', name: 'Fisk tee', sku: 'FISK', isActive: true, availability: { b2c: true },
    });
    await setDoc(doc(db, 'products/down'), {
      shopId: 'shopA', name: 'Nike tee', sku: 'NIKE', isActive: false, availability: { b2c: true },
      takedown: { reportId: 'rep1', by: 'mikael', note: 'befogad' },
    });
    // A second taken-down product for the delete checks (F1) — 'down' is
    // reinstated further down and must still exist then.
    await setDoc(doc(db, 'products/down2'), {
      shopId: 'shopA', name: 'Adidas tee', sku: 'ADIDAS', isActive: false, availability: { b2c: true },
      takedown: { reportId: null, by: 'mikael', note: 'screening' },
    });
    await setDoc(doc(db, 'products/deletable'), {
      shopId: 'shopA', name: 'Gammal tee', sku: 'OLD', isActive: false, availability: { b2c: true },
    });
    await setDoc(doc(db, 'settings/contentScreening'), { blocklist: [{ term: 'kent', kind: 'band' }], reviewFirstProducts: 2 });
  });
}

async function run() {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
  });
  await env.clearFirestore();
  await seed();

  console.log('\n=== A10: infringementReports is platform-only ===');
  await check('anon CANNOT read a report', assertFails(getDoc(doc(anonDb(), 'infringementReports/rep1'))));
  await check('anon CANNOT list reports', assertFails(getDocs(collection(anonDb(), 'infringementReports'))));
  await check('shop admin CANNOT read a report about its OWN shop', assertFails(getDoc(doc(shopAAdminDb(), 'infringementReports/rep1'))));
  await check('shop admin CANNOT list its shop\'s reports', assertFails(
    getDocs(query(collection(shopAAdminDb(), 'infringementReports'), where('shopId', '==', 'shopA')))));
  await check('customer CANNOT read a report', assertFails(getDoc(doc(customerDb(), 'infringementReports/rep1'))));
  await check('platform reads a report', assertSucceeds(getDoc(doc(platformDb(), 'infringementReports/rep1'))));
  await check('platform lists all reports', assertSucceeds(getDocs(collection(platformDb(), 'infringementReports'))));

  await check('anon CANNOT create a report (callable only)', assertFails(
    addDoc(collection(anonDb(), 'infringementReports'), REPORT)));
  await check('shop admin CANNOT create a report', assertFails(
    addDoc(collection(shopAAdminDb(), 'infringementReports'), REPORT)));
  await check('platform CANNOT create a report either (callable only)', assertFails(
    addDoc(collection(platformDb(), 'infringementReports'), REPORT)));
  await check('shop admin CANNOT reject a report against itself', assertFails(
    updateDoc(doc(shopAAdminDb(), 'infringementReports/rep1'), { status: 'rejected' })));

  // The REAL client payload of PlatformReports' "Avvisa" / "Markera som granskas".
  await check('platform marks reviewing (status only)', assertSucceeds(
    updateDoc(doc(platformDb(), 'infringementReports/rep1'), { status: 'reviewing' })));
  await check('platform rejects with note + handledAt/By', assertSucceeds(
    updateDoc(doc(platformDb(), 'infringementReports/rep1'), { status: 'rejected', note: 'Ej befogad', handledAt: new Date(), handledBy: 'mikael' })));
  await check('platform CANNOT set an unknown status', assertFails(
    updateDoc(doc(platformDb(), 'infringementReports/rep1'), { status: 'deleted' })));
  await check('platform CANNOT rewrite the reporter\'s statement', assertFails(
    updateDoc(doc(platformDb(), 'infringementReports/rep1'), { description: 'edited' })));
  await check('platform CANNOT re-home a report to another shop', assertFails(
    updateDoc(doc(platformDb(), 'infringementReports/rep1'), { status: 'new', shopId: 'shopB' })));
  await check('reports are never deletable (platform)', assertFails(deleteDoc(doc(platformDb(), 'infringementReports/rep1'))));

  console.log('\n=== A11: products.screening / takedown are server/platform-only ===');
  await check('shop admin CANNOT clear its own flag', assertFails(
    updateDoc(doc(shopAAdminDb(), 'products/flagged'), { 'screening.status': 'cleared' })));
  await check('shop admin CANNOT delete the screening stamp', assertFails(
    updateDoc(doc(shopAAdminDb(), 'products/flagged'), { screening: deleteField() })));
  await check('shop admin CANNOT pre-stamp a clean product as cleared', assertFails(
    updateDoc(doc(shopAAdminDb(), 'products/clean'), { screening: { status: 'cleared', hits: [] } })));
  await check('shop admin CANNOT create a product carrying screening', assertFails(
    setDoc(doc(shopAAdminDb(), 'products/new1'), { shopId: 'shopA', name: 'X', isActive: true, screening: { status: 'cleared', hits: [] } })));
  await check('shop admin CANNOT create a product carrying takedown', assertFails(
    setDoc(doc(shopAAdminDb(), 'products/new2'), { shopId: 'shopA', name: 'X', isActive: true, takedown: null })));
  await check('shop admin CANNOT re-activate a taken-down product', assertFails(
    updateDoc(doc(shopAAdminDb(), 'products/down'), { isActive: true })));
  await check('shop admin CANNOT remove the takedown stamp', assertFails(
    updateDoc(doc(shopAAdminDb(), 'products/down'), { takedown: deleteField(), isActive: true })));

  // F1 (CODEX audit 2026-09-26): the delete → re-create-same-id bypass. The
  // takedown must survive every seller-side route to a fresh, stamp-free doc.
  await check('F1: shop admin CANNOT delete a taken-down product', assertFails(
    deleteDoc(doc(shopAAdminDb(), 'products/down2'))));
  await check('F1: shop admin CANNOT overwrite a taken-down product wholesale (setDoc without the stamp)', assertFails(
    setDoc(doc(shopAAdminDb(), 'products/down2'), { shopId: 'shopA', name: 'Adidas tee', sku: 'ADIDAS', isActive: true, availability: { b2c: true } })));
  await check('F1: the taken-down product is still there afterwards', (async () => {
    let snap = null;
    await env.withSecurityRulesDisabled(async (ctx) => { snap = await getDoc(doc(ctx.firestore(), 'products/down2')); });
    if (!snap?.exists() || snap.data().isActive !== false || !snap.data().takedown) throw new Error('doc changed');
  })());
  await check('F1: shop admin still deletes a product WITHOUT a takedown', assertSucceeds(
    deleteDoc(doc(shopAAdminDb(), 'products/deletable'))));
  await check('F1: platform may delete a taken-down product', assertSucceeds(
    deleteDoc(doc(platformDb(), 'products/down2'))));

  // Lockout guards — the ordinary seller paths keep working.
  await check('shop admin still edits a flagged product (name/price) — screening untouched', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'products/flagged'), { name: 'Tour tee', b2cPrice: 299 })));
  await check('shop admin still edits a taken-down product (isActive unchanged)', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'products/down'), { name: 'Omdöpt', isActive: false })));
  await check('shop admin still deactivates a clean product', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'products/clean'), { isActive: false })));
  await check('shop admin still creates a normal product', assertSucceeds(
    setDoc(doc(shopAAdminDb(), 'products/new3'), { shopId: 'shopA', name: 'Ny', isActive: true, availability: { b2c: true } })));
  await check('shop B admin CANNOT touch shop A\'s product at all', assertFails(
    updateDoc(doc(shopBAdminDb(), 'products/clean'), { name: 'x' })));

  // Platform = the review queue + reinstate path.
  await check('platform clears a flag (Godkänn)', assertSucceeds(
    updateDoc(doc(platformDb(), 'products/flagged'), { 'screening.status': 'cleared', 'screening.clearedBy': 'mikael' })));
  await check('platform queue query (screening.status in …) is allowed', assertSucceeds(
    getDocs(query(collection(platformDb(), 'products'), where('screening.status', 'in', ['flagged', 'review', 'blocked'])))));
  await check('shop admin CANNOT run the cross-shop queue query', assertFails(
    getDocs(query(collection(shopAAdminDb(), 'products'), where('screening.status', 'in', ['flagged', 'review', 'blocked'])))));
  await check('platform reinstates a taken-down product (clears stamp + activates)', assertSucceeds(
    updateDoc(doc(platformDb(), 'products/down'), { takedown: deleteField(), isActive: true })));
  await check('after reinstatement the seller may toggle isActive again', assertSucceeds(
    updateDoc(doc(shopAAdminDb(), 'products/down'), { isActive: false })));

  console.log('\n=== settings/contentScreening: platform-written, active users read ===');
  await check('shop admin reads the blocklist (publish notice)', assertSucceeds(getDoc(doc(shopAAdminDb(), 'settings/contentScreening'))));
  await check('shop admin CANNOT edit the blocklist', assertFails(
    updateDoc(doc(shopAAdminDb(), 'settings/contentScreening'), { blocklist: [] })));
  await check('anon CANNOT read the blocklist', assertFails(getDoc(doc(anonDb(), 'settings/contentScreening'))));
  await check('platform edits the blocklist', assertSucceeds(
    updateDoc(doc(platformDb(), 'settings/contentScreening'), { reviewFirstProducts: 3 })));

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  await env.cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('Harness error:', e); process.exit(2); });
