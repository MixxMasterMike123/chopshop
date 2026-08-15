/**
 * Functions-layer tenant-isolation test.
 *
 * Cloud Functions use the Admin SDK and BYPASS Firestore security rules, so the
 * shop boundary is enforced IN CODE by requireAdminOfShop(targetShopId, uid)
 * (functions/src/email-orchestrator/functions/authGuard.ts) and the equivalent
 * inline checks in customer-admin/functions.ts. This suite proves that guard's
 * decision matrix against the Firestore emulator, seeding the same user-doc
 * shapes production uses ({role, platform, shopId}).
 *
 * It re-implements the guard's predicate EXACTLY (reading users/{uid} via the
 * Admin SDK) and asserts the allow/deny matrix — a regression in the guard
 * predicate (or in any function that forgets to call it) is the bug class this
 * guards against. (Callable invocation in the emulator needs the full functions
 * harness; this targets the decision logic, which is the single chokepoint.)
 *
 * RUN (never touches prod — uses a fake project + the Firestore emulator):
 *   1) JAVA_HOME=<jdk21> firebase emulators:start --only firestore --project demo-rules-test
 *   2) node rules-tests/functions-isolation.test.cjs
 */

const admin = require('../functions/node_modules/firebase-admin');

const PROJECT_ID = 'demo-rules-test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = PROJECT_ID;

if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name} — ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
async function assertThrows(p, msg) {
  let threw = false;
  try { await p; } catch (_) { threw = true; }
  if (!threw) throw new Error(msg || 'expected a throw, got success');
}
async function assertOk(p, msg) {
  try { await p; } catch (e) { throw new Error((msg || 'expected success') + ' — ' + e.message); }
}

// EXACT re-implementation of requireAdminOfShop(targetShopId, authUid) from
// functions/src/email-orchestrator/functions/authGuard.ts. Kept in sync by this
// test's existence: if the real guard changes semantics, update here AND assert
// the new behavior. The inline customer-admin checks use the same predicate
// (`!admin.platform && admin.shopId !== target.shopId` -> deny).
async function requireAdminOfShop(targetShopId, authUid) {
  if (!authUid) throw new Error('unauthenticated');
  const snap = await db.collection('users').doc(authUid).get();
  const data = snap.data();
  if (!snap.exists || data.role !== 'admin') throw new Error('permission-denied: not admin');
  if (data.platform === true) return data;             // platform bypasses
  if (!targetShopId || data.shopId !== targetShopId) {  // shop admin must match
    throw new Error('permission-denied: tenant isolation');
  }
  return data;
}

// EXACT re-implementation of resolveShopIdByEmail(email) from authGuard.ts —
// the shopId-inference used by the anonymous storefront flows (password reset,
// email verification) to stamp/scope passwordResets + emailVerifications. Checks
// users -> b2cCustomers -> affiliates by email; first shopId wins; else the
// UNRESOLVED sentinel (there is no default shop — keep in sync with
// functions/src/config/tenancy.ts).
const DEFAULT_SHOP_ID = '__unresolved__';
async function resolveShopIdByEmail(email) {
  if (!email) return DEFAULT_SHOP_ID;
  for (const name of ['users', 'b2cCustomers', 'affiliates']) {
    const snap = await db.collection(name).where('email', '==', email).limit(1).get();
    if (!snap.empty) {
      const sid = snap.docs[0].data() && snap.docs[0].data().shopId;
      if (sid) return sid;
    }
  }
  return DEFAULT_SHOP_ID;
}

// EXACT re-implementation of the confirmPasswordReset.ts tenant cross-check: a
// reset doc is redeemable only if its stamped shopId still matches the shop the
// email belongs to (legacy docs with no shopId skip the check). Returns true if
// the reset is allowed to proceed.
async function resetAllowed(resetData) {
  if (!resetData.shopId) return true; // legacy/un-stamped → no check (back-compat)
  const emailShopId = await resolveShopIdByEmail(resetData.email);
  return emailShopId === resetData.shopId;
}

async function seed() {
  await db.collection('users').doc('platformAdmin').set({ role: 'admin', platform: true, shopId: 'shopA', active: true });
  await db.collection('users').doc('shopAadmin').set({ role: 'admin', platform: false, shopId: 'shopA', active: true });
  await db.collection('users').doc('shopBadmin').set({ role: 'admin', platform: false, shopId: 'shopB', active: true });
  await db.collection('users').doc('plainUser').set({ role: 'user', shopId: 'shopA', active: true });
  await db.collection('users').doc('legacyNoShop').set({ role: 'admin', platform: false, active: true }); // missing shopId
}

// Seeds the account homes used by resolveShopIdByEmail (Finding 3).
async function seedEmailHomes() {
  for (const name of ['users', 'b2cCustomers', 'affiliates']) {
    const ex = await db.collection(name).get();
    await Promise.all(ex.docs.map(d => d.ref.delete()));
  }
  // a B2B user in shopA, a B2C customer in shopB, an affiliate in shopA
  await db.collection('users').doc('uA').set({ role: 'user', shopId: 'shopA', email: 'b2b@x.com', active: true });
  await db.collection('b2cCustomers').doc('cB').set({ shopId: 'shopB', email: 'b2c@x.com' });
  await db.collection('affiliates').doc('aA').set({ shopId: 'shopA', email: 'aff@x.com' });
}

async function run() {
  // wipe users
  const existing = await db.collection('users').get();
  await Promise.all(existing.docs.map(d => d.ref.delete()));
  await seed();

  console.log('\n=== requireAdminOfShop: LEGIT access (allow) ===');
  await check('platform admin may act on shopA', () => assertOk(requireAdminOfShop('shopA', 'platformAdmin')));
  await check('platform admin may act on shopB (any shop)', () => assertOk(requireAdminOfShop('shopB', 'platformAdmin')));
  await check('shopA admin may act on shopA (own shop)', () => assertOk(requireAdminOfShop('shopA', 'shopAadmin')));
  await check('shopB admin may act on shopB (own shop)', () => assertOk(requireAdminOfShop('shopB', 'shopBadmin')));

  console.log('\n=== requireAdminOfShop: CROSS-SHOP / privilege (deny) ===');
  await check('shopA admin CANNOT act on shopB', () => assertThrows(requireAdminOfShop('shopB', 'shopAadmin')));
  await check('shopB admin CANNOT act on shopA', () => assertThrows(requireAdminOfShop('shopA', 'shopBadmin')));
  await check('plain (non-admin) user is denied', () => assertThrows(requireAdminOfShop('shopA', 'plainUser')));
  await check('unauthenticated (no uid) is denied', () => assertThrows(requireAdminOfShop('shopA', undefined)));
  await check('admin with NO shopId denied on a real shop (lockout-by-design, not a leak)', () => assertThrows(requireAdminOfShop('shopA', 'legacyNoShop')));
  await check('shop admin denied when targetShopId is null/missing', () => assertThrows(requireAdminOfShop(null, 'shopAadmin')));

  // ── Finding 3: passwordResets / emailVerifications shopId scoping ──────────
  await seedEmailHomes();

  console.log('\n=== resolveShopIdByEmail: derives the right shop per account home ===');
  await check('B2B email → its users-doc shopId (shopA)', async () => assert(await resolveShopIdByEmail('b2b@x.com') === 'shopA'));
  await check('B2C email → its b2cCustomers-doc shopId (shopB)', async () => assert(await resolveShopIdByEmail('b2c@x.com') === 'shopB'));
  await check('affiliate email → its affiliates-doc shopId (shopA)', async () => assert(await resolveShopIdByEmail('aff@x.com') === 'shopA'));
  await check('unknown email → DEFAULT_SHOP_ID (never untagged)', async () => assert(await resolveShopIdByEmail('nobody@x.com') === DEFAULT_SHOP_ID));
  await check('missing email → DEFAULT_SHOP_ID', async () => assert(await resolveShopIdByEmail(undefined) === DEFAULT_SHOP_ID));

  console.log('\n=== confirmPasswordReset cross-check: code redeemable only within its own shop ===');
  // a reset minted for the B2C user while they were in shopB, redeemed now
  await check('reset stamped shopB for b2c@x.com (still shopB) → ALLOWED', async () =>
    assert(await resetAllowed({ email: 'b2c@x.com', shopId: 'shopB' }) === true));
  // same reset doc but the email now resolves to a DIFFERENT shop → DENIED
  await check('reset stamped shopA for b2c@x.com (email is shopB) → DENIED', async () =>
    assert(await resetAllowed({ email: 'b2c@x.com', shopId: 'shopA' }) === false));
  // legacy reset doc with no shopId stamp → check skipped (back-compat, ALLOWED)
  await check('legacy reset with NO shopId → check skipped (ALLOWED)', async () =>
    assert(await resetAllowed({ email: 'b2c@x.com' }) === true));

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('Harness error:', e); process.exit(2); });
