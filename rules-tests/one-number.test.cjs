/**
 * Firestore rules — A13 "seller sees ONE number" (Mikael 2026-09-25).
 *
 *   printers/{uid}          price tiers → PLATFORM-only read (was any active
 *                           user); platform-only write (unchanged).
 *   printersPublic/{uid}    the price-free mirror the studio reads → any active
 *                           user reads; NO client writes (trigger/seed only),
 *                           platform included.
 *   orderProduction/{id}    the order's money half (full snapshot + fee split)
 *                           → no client access at all, every role.
 *   orders/{id}             unchanged (open single get, gated list) — the
 *                           regression half: the confirmation page still works.
 *
 * The pure half (projection/strip/split/quote + client grep guards) is
 * rules-tests/one-number-pure.test.cjs.
 *
 * RUN (never touches prod):
 *   1) JAVA_HOME=<jdk21> firebase emulators:start --only firestore --project demo-rules-test
 *   2) node rules-tests/one-number.test.cjs
 */

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { setDoc, getDoc, getDocs, doc, collection, updateDoc, deleteDoc, query, where } = require('firebase/firestore');

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

const platformDb = () => env.authenticatedContext('mikael').firestore();
const shopAAdminDb = () => env.authenticatedContext('adminA').firestore();
const printShopDb = () => env.authenticatedContext('kim').firestore();
const customerDb = () => env.authenticatedContext('cust', { email: 'cust@x.com' }).firestore();
const anonDb = () => env.unauthenticatedContext().firestore();

const TIER = {
  name: 'Kim Tryck', garments: ['tee'], active: true,
  pricing: { blankCostSek: { tee: 60 }, printCostSek: { front: 40 } }, shippingSek: 49,
};
const MIRROR = { name: 'Kim Tryck', type: null, active: true, garments: ['tee'], printAreasMm: {}, provisionalAreas: [], updatedAt: null };
const PRODUCTION = {
  shopId: 'shopA', paymentIntentId: 'pi_A',
  snapshot: { version: 1, lines: [{ printerUid: 'kim', itemCostSek: 140, printCostSek: 40, printerShippingSek: 49 }] },
  connect: { commissionBps: 800, productionWithheldOre: 22250, productionVatRate: 0.25 },
};

async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/mikael'), { role: 'admin', platform: true, shopId: 'shopA', active: true });
    await setDoc(doc(db, 'users/adminA'), { role: 'admin', platform: false, shopId: 'shopA', active: true });
    await setDoc(doc(db, 'users/kim'), { role: 'print_shop', shopId: null, active: true });
    await setDoc(doc(db, 'printers/kim'), TIER);
    await setDoc(doc(db, 'printersPublic/kim'), MIRROR);
    await setDoc(doc(db, 'orders/pi_A'), {
      shopId: 'shopA', source: 'b2c', customerInfo: { email: 'cust@x.com' },
      connect: { isDestinationCharge: true, applicationFeeAmount: 31042 },
    });
    await setDoc(doc(db, 'orderProduction/pi_A'), PRODUCTION);
  });
}

async function run() {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
  });
  await env.clearFirestore();
  await seed();

  console.log('\n=== printers/{uid} — price tiers are PLATFORM-only ===');
  await check('platform reads a tier (Tryckerier editor)', assertSucceeds(getDoc(doc(platformDb(), 'printers/kim'))));
  await check('platform lists tiers', assertSucceeds(getDocs(collection(platformDb(), 'printers'))));
  await check('shop admin CANNOT read a tier', assertFails(getDoc(doc(shopAAdminDb(), 'printers/kim'))));
  await check('shop admin CANNOT list tiers', assertFails(getDocs(collection(shopAAdminDb(), 'printers'))));
  await check('print shop CANNOT read a tier (even its own)', assertFails(getDoc(doc(printShopDb(), 'printers/kim'))));
  await check('customer CANNOT read a tier', assertFails(getDoc(doc(customerDb(), 'printers/kim'))));
  await check('anon CANNOT read a tier', assertFails(getDoc(doc(anonDb(), 'printers/kim'))));
  await check('shop admin CANNOT write a tier', assertFails(updateDoc(doc(shopAAdminDb(), 'printers/kim'), { name: 'x' })));
  await check('platform writes a tier', assertSucceeds(updateDoc(doc(platformDb(), 'printers/kim'), { shippingSek: 55 })));

  console.log('\n=== printersPublic/{uid} — the price-free mirror ===');
  await check('shop admin reads the mirror (studio routing + frames)', assertSucceeds(getDoc(doc(shopAAdminDb(), 'printersPublic/kim'))));
  await check('shop admin lists the mirror (loadPrintRouting getDocs)', assertSucceeds(getDocs(collection(shopAAdminDb(), 'printersPublic'))));
  await check('platform reads the mirror', assertSucceeds(getDoc(doc(platformDb(), 'printersPublic/kim'))));
  await check('customer (no users doc) CANNOT read the mirror', assertFails(getDoc(doc(customerDb(), 'printersPublic/kim'))));
  await check('anon CANNOT read the mirror', assertFails(getDoc(doc(anonDb(), 'printersPublic/kim'))));
  await check('shop admin CANNOT write the mirror', assertFails(updateDoc(doc(shopAAdminDb(), 'printersPublic/kim'), { garments: ['tee', 'hoodie'] })));
  await check('platform CANNOT write the mirror via client SDK (trigger-only)', assertFails(setDoc(doc(platformDb(), 'printersPublic/kim'), MIRROR)));
  await check('platform CANNOT delete the mirror via client SDK', assertFails(deleteDoc(doc(platformDb(), 'printersPublic/kim'))));

  console.log('\n=== orderProduction/{id} — no client access, any role ===');
  for (const [who, db] of [['platform', platformDb], ['shop admin', shopAAdminDb], ['print shop', printShopDb], ['customer', customerDb], ['anon', anonDb]]) {
    await check(`${who} CANNOT read orderProduction`, assertFails(getDoc(doc(db(), 'orderProduction/pi_A'))));
    await check(`${who} CANNOT list orderProduction`, assertFails(getDocs(query(collection(db(), 'orderProduction'), where('shopId', '==', 'shopA')))));
    await check(`${who} CANNOT write orderProduction`, assertFails(setDoc(doc(db(), 'orderProduction/pi_X'), { shopId: 'shopA' })));
  }
  await check('shop admin CANNOT update its own order\'s orderProduction', assertFails(updateDoc(doc(shopAAdminDb(), 'orderProduction/pi_A'), { connect: {} })));

  console.log('\n=== orders — unchanged (regression) ===');
  await check('anon still gets a single order by id (confirmation page)', assertSucceeds(getDoc(doc(anonDb(), 'orders/pi_A'))));
  await check('shop admin still lists own shop orders', assertSucceeds(getDocs(query(collection(shopAAdminDb(), 'orders'), where('shopId', '==', 'shopA')))));
  await check('shop admin CANNOT write connect (fee is server-only)', assertFails(updateDoc(doc(shopAAdminDb(), 'orders/pi_A'), { 'connect.applicationFeeAmount': 0 })));

  console.log(`\n${failed === 0 ? '✅' : '❌'} one-number rules: ${passed} passed, ${failed} failed`);
  await env.cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(async (e) => {
  console.error(e);
  try { await env?.cleanup(); } catch { /* ignore */ }
  process.exit(1);
});
