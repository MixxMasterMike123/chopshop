/**
 * Firestore security-rules test — Phase 3 tenant isolation.
 *
 * Proves the new firestore.rules BOTH ways (Mikael's mandate: admin-vs-store
 * AND store-vs-admin): legitimate access still WORKS (no lockout) AND cross-shop
 * access is DENIED (no leak). Runs against the Firestore emulator.
 *
 * HOW TO RUN (does not touch production):
 *   1) firebase emulators:start --only firestore --project demo-rules-test
 *   2) node rules-tests/firestore-rules.test.cjs
 * (uses a fake project id 'demo-rules-test' so it can never hit real data)
 *
 * Requires dev dep: @firebase/rules-unit-testing (and firebase).
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

// Auth contexts
function platformDb() {
  return env.authenticatedContext('mikael', {}).firestore();
}
function shopAAdminDb() {
  return env.authenticatedContext('adminA', {}).firestore();
}
function shopBAdminDb() {
  return env.authenticatedContext('adminB', {}).firestore();
}
function customerDb(uid) {
  return env.authenticatedContext(uid, { email: uid + '@x.com' }).firestore();
}
function anonDb() {
  return env.unauthenticatedContext().firestore();
}

async function seed() {
  // Seed users + data with security rules DISABLED.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // platform super-admin (Mikael) — role admin + platform true, shop A
    await setDoc(doc(db, 'users/mikael'), { role: 'admin', platform: true, shopId: 'shopA', active: true });
    // shop A admin (not platform)
    await setDoc(doc(db, 'users/adminA'), { role: 'admin', platform: false, shopId: 'shopA', active: true });
    // shop B admin (not platform)
    await setDoc(doc(db, 'users/adminB'), { role: 'admin', platform: false, shopId: 'shopB', active: true });
    // shops
    await setDoc(doc(db, 'shops/shopA'), { name: 'Shop A', status: 'active' });
    await setDoc(doc(db, 'shops/shopB'), { name: 'Shop B', status: 'active' });
    // products in each shop
    await setDoc(doc(db, 'products/pA'), { shopId: 'shopA', isActive: true, name: 'A prod' });
    await setDoc(doc(db, 'products/pB'), { shopId: 'shopB', isActive: true, name: 'B prod' });
    // orders in each shop
    await setDoc(doc(db, 'orders/oA'), { shopId: 'shopA', source: 'b2c', customerInfo: { email: 'cust@x.com' }, b2cCustomerId: 'cA' });
    await setDoc(doc(db, 'orders/oB'), { shopId: 'shopB', source: 'b2c', customerInfo: { email: 'other@x.com' } });
    // b2c customers
    await setDoc(doc(db, 'b2cCustomers/cA'), { shopId: 'shopA', firebaseAuthUid: 'cust', email: 'cust@x.com' });
    await setDoc(doc(db, 'b2cCustomers/cB'), { shopId: 'shopB', firebaseAuthUid: 'otherCust', email: 'other@x.com' });
    // affiliates
    await setDoc(doc(db, 'affiliates/affA'), { shopId: 'shopA', email: 'aff@x.com', affiliateCode: 'AFFA', status: 'active' });
    await setDoc(doc(db, 'affiliates/affB'), { shopId: 'shopB', email: 'affb@x.com', affiliateCode: 'AFFB', status: 'active' });
    // campaigns
    await setDoc(doc(db, 'campaigns/camA'), { shopId: 'shopA', status: 'active', code: 'CAMA' });
    await setDoc(doc(db, 'campaigns/camB'), { shopId: 'shopB', status: 'active', code: 'CAMB' });
  });
}

async function run() {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
  });
  await env.clearFirestore();
  await seed();

  console.log('\n=== STORE → ADMIN direction: legitimate access must WORK (no lockout) ===');

  await check('anon reads products (storefront)', assertSucceeds(getDoc(doc(anonDb(), 'products/pA'))));
  await check('anon reads shops/{id} (storefront config)', assertSucceeds(getDoc(doc(anonDb(), 'shops/shopA'))));
  await check('anon reads single order by id (confirmation page)', assertSucceeds(getDoc(doc(anonDb(), 'orders/oA'))));
  await check('customer reads OWN b2cCustomer doc', assertSucceeds(getDoc(doc(customerDb('cust'), 'b2cCustomers/cA'))));
  await check('affiliate reads OWN affiliate doc (by email)', assertSucceeds(getDoc(doc(customerDb('aff'), 'affiliates/affA'))));
  await check('platform reads any shop product (shopB)', assertSucceeds(getDoc(doc(platformDb(), 'products/pB'))));
  await check('platform lists shopB orders', assertSucceeds(getDocs(query(collection(platformDb(), 'orders'), where('shopId', '==', 'shopB')))));
  await check('shopA admin lists OWN shop orders', assertSucceeds(getDocs(query(collection(shopAAdminDb(), 'orders'), where('shopId', '==', 'shopA')))));
  await check('shopA admin updates OWN product', assertSucceeds(updateDoc(doc(shopAAdminDb(), 'products/pA'), { name: 'A2' })));
  await check('platform updates any shop product (shopB)', assertSucceeds(updateDoc(doc(platformDb(), 'products/pB'), { name: 'B2' })));
  await check('shopA admin reads OWN campaign', assertSucceeds(getDoc(doc(shopAAdminDb(), 'campaigns/camA'))));
  await check('shopA admin creates product in OWN shop', assertSucceeds(setDoc(doc(shopAAdminDb(), 'products/pA2'), { shopId: 'shopA', isActive: true })));

  console.log('\n=== ADMIN → STORE direction: cross-shop / privilege access must be DENIED (no leak) ===');

  await check('shopA admin CANNOT read shopB order list', assertFails(getDocs(query(collection(shopAAdminDb(), 'orders'), where('shopId', '==', 'shopB')))));
  await check('shopA admin CANNOT update shopB product', assertFails(updateDoc(doc(shopAAdminDb(), 'products/pB'), { name: 'hacked' })));
  await check('shopA admin CANNOT delete shopB product', assertFails(deleteDoc(doc(shopAAdminDb(), 'products/pB'))));
  await check('shopA admin CANNOT read shopB campaign', assertFails(getDoc(doc(shopAAdminDb(), 'campaigns/camB'))));
  await check('shopA admin CANNOT read shopB affiliate', assertFails(getDoc(doc(shopAAdminDb(), 'affiliates/affB'))));
  await check('shopA admin CANNOT read shopB b2cCustomer', assertFails(getDoc(doc(shopAAdminDb(), 'b2cCustomers/cB'))));
  await check('shopA admin CANNOT create product in shopB', assertFails(setDoc(doc(shopAAdminDb(), 'products/pX'), { shopId: 'shopB', isActive: true })));
  await check('shopA admin CANNOT provision a shop (platform-only)', assertFails(setDoc(doc(shopAAdminDb(), 'shops/shopC'), { name: 'C', status: 'active' })));
  await check('shopA admin CANNOT update shopB shop doc', assertFails(updateDoc(doc(shopAAdminDb(), 'shops/shopB'), { status: 'disabled' })));
  await check('customer CANNOT read another customer doc', assertFails(getDoc(doc(customerDb('cust'), 'b2cCustomers/cB'))));
  await check('anon CANNOT read affiliateClicks', assertFails(getDoc(doc(anonDb(), 'affiliateClicks/x'))));
  await check('anon CANNOT list all orders', assertFails(getDocs(collection(anonDb(), 'orders'))));
  await check('anon CANNOT write a product', assertFails(setDoc(doc(anonDb(), 'products/pHack'), { shopId: 'shopA' })));
  await check('customer CANNOT self-promote to admin (role field)', assertFails(setDoc(doc(customerDb('cust'), 'users/cust'), { role: 'admin' })));
  // The public affiliate form must stay open, but the send-once stamp is
  // server-only: forging it at create time would suppress the notification
  // emails for that application.
  await check('anon submits affiliate application (public form stays open)',
    assertSucceeds(setDoc(doc(anonDb(), 'affiliateApplications/appOk'), { email: 'a@b.se', shopId: 'shopA' })));
  await check('anon CANNOT forge applicationEmailsSentAt (suppresses notifications)',
    assertFails(setDoc(doc(anonDb(), 'affiliateApplications/appHack'), { email: 'a@b.se', shopId: 'shopA', applicationEmailsSentAt: new Date() })));

  console.log('\n=== PLATFORM privileges ===');
  await check('platform provisions a new shop', assertSucceeds(setDoc(doc(platformDb(), 'shops/shopC'), { name: 'C', status: 'active' })));
  await check('platform kills a shop (status)', assertSucceeds(updateDoc(doc(platformDb(), 'shops/shopB'), { status: 'disabled' })));

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  await env.cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('Harness error:', e); process.exit(2); });
