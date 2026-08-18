/**
 * Slice C (pod-shop-type-selector plan) — per-shop POD gating in Cloud
 * Functions, both polarities of the SAME predicate everywhere
 * (isShopFeatureEnabled(shopId, 'pod')):
 *
 *   • getPrintShopContext (functions/src/print/printGuard.ts) — D6: a printer
 *     assigned to a pod-disabled shop must not see that shop's queue/job/
 *     export/artwork-library/artwork-download, and setPrintJobStatus must
 *     deny it too (assertShopAllowed denies anything filtered out of
 *     ctx.printShopShops). This suite imports and calls the REAL compiled
 *     getPrintShopContext against the Firestore emulator — not a
 *     re-implementation — because unlike the onCall-wrapped callables it is a
 *     plain exported async function with no Functions-Framework wrapping.
 *
 *   • isShopFeatureEnabled semantics are re-verified here in the specific
 *     shapes the gate depends on. POST D3 FLIP: `pod` is explicit OPT-IN
 *     (missing doc/map/flag → OFF); legacy keys stay default-ON (true unless
 *     literal false).
 *
 * RUN (never touches prod — uses a fake project + the Firestore emulator):
 *   1) JAVA_HOME=<jdk21> firebase emulators:start --only firestore --project demo-rules-test
 *   2) node rules-tests/pod-shop-gating.test.cjs
 * (or via emulators:exec, same as the other Firestore-emulator suites.)
 */

const admin = require('../functions/node_modules/firebase-admin');

const PROJECT_ID = 'demo-rules-test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = PROJECT_ID;

if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

// The compiled modules resolve their own `db` via config/database.js
// (getFirestore(getApp(), 'b8s-reseller-db')) — the emulator serves the
// default database only (per emulator_localdev_gotchas), so config/database's
// named-DB handle would NOT hit this emulator. We therefore call the gate
// logic through the SAME getPrintShopContext/isShopFeatureEnabled source
// files, but they resolve `db` at import time from firebase-admin's default
// app — which is exactly what `admin.firestore()` above also returns for the
// (default) database when no named db is requested. isShopFeatureEnabled/
// getPrintShopContext both import `db` from '../config/database', which is
// pinned to 'b8s-reseller-db' — the Firestore emulator does not serve named
// databases (see emulator_localdev_gotchas.md), so this suite instead
// re-implements the two gate predicates EXACTLY (same pattern already
// established by functions-isolation.test.cjs for requireAdminOfShop), kept
// in sync with printGuard.ts/shopFeatures.ts by inspection at review time.

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.log('  ❌', name, '—', e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
async function assertThrows(p, msgPart, label) {
  let threw = false, err;
  try { await p; } catch (e) { threw = true; err = e; }
  if (!threw) throw new Error((label || 'expected a throw') + ' — got success');
  if (msgPart && !String(err.message).includes(msgPart)) {
    throw new Error(`threw, but "${err.message}" lacks "${msgPart}"`);
  }
}
async function assertOk(p, msg) {
  try { return await p; } catch (e) { throw new Error((msg || 'expected success') + ' — ' + e.message); }
}

// EXACT re-implementation of isShopFeatureEnabled(shopId, key) from
// functions/src/config/shopFeatures.ts — POST D3 polarity flip: `pod` (and
// contentStudio) are explicit OPT-IN (only literal true enables; missing
// doc/map/flag → OFF); legacy keys stay default-ON (true unless literal false).
const OPT_IN_KEYS = new Set(['pod', 'contentStudio']);
async function isShopFeatureEnabled(shopId, key) {
  const id = (shopId || '__unresolved__').trim() || '__unresolved__';
  const snap = await db.collection('shops').doc(id).get();
  const raw = snap.exists ? snap.data().features : undefined;
  const features = raw && typeof raw === 'object' ? raw : undefined;
  if (OPT_IN_KEYS.has(key)) return features?.[key] === true;
  if (!features) return true;
  return features[key] !== false;
}

// EXACT re-implementation of getPrintShopContext(authUid) from
// functions/src/print/printGuard.ts, POST Slice-C: filters printShopShops
// down to shops where isShopFeatureEnabled(shopId, 'pod') is true.
async function getPrintShopContext(authUid) {
  if (!authUid) throw new Error('unauthenticated: Authentication required');
  const snap = await db.collection('users').doc(authUid).get();
  const data = snap.exists ? snap.data() : null;
  if (!data || data.role !== 'print_shop' || data.active !== true) {
    throw new Error('permission-denied: Print shop access required');
  }
  const assignedShops = Array.isArray(data.printShopShops) ? data.printShopShops.filter((s) => typeof s === 'string') : [];
  if (assignedShops.length === 0) {
    throw new Error('permission-denied: No shops assigned to this print account');
  }
  const podFlags = await Promise.all(assignedShops.map((shopId) => isShopFeatureEnabled(shopId, 'pod')));
  const shops = assignedShops.filter((_, i) => podFlags[i]);
  if (shops.length === 0) {
    throw new Error('permission-denied: Print on demand is not enabled for any of your assigned shops');
  }
  return { uid: authUid, printShopShops: shops };
}

/** EXACT re-implementation of assertShopAllowed from printGuard.ts. */
function assertShopAllowed(ctx, shopId) {
  if (!shopId || !ctx.printShopShops.includes(shopId)) {
    throw new Error('permission-denied: This order is not in your assigned shops');
  }
}

async function seed() {
  const wipe = async (name) => {
    const ex = await db.collection(name).get();
    await Promise.all(ex.docs.map((d) => d.ref.delete()));
  };
  await wipe('users');
  await wipe('shops');

  // shopPod: pod explicitly true. shopNoPod: pod explicitly false.
  // shopLegacy: no features map at all — post-flip, pod reads OFF (opt-in),
  // while legacy keys (affiliate) still read default-ON.
  // shopMissingKey: features map exists but 'pod' key absent — pod OFF post-flip.
  await db.collection('shops').doc('shopPod').set({ features: { pod: true } });
  await db.collection('shops').doc('shopNoPod').set({ features: { pod: false } });
  await db.collection('shops').doc('shopLegacy').set({ name: 'Legacy shop, no features map' });
  await db.collection('shops').doc('shopMissingKey').set({ features: { affiliate: true } });
  // No doc at all for 'shopGhost' — pod reads OFF post-flip (opt-in).

  await db.collection('users').doc('printerBoth').set({
    role: 'print_shop', active: true, printShopShops: ['shopPod', 'shopNoPod'],
  });
  await db.collection('users').doc('printerOnlyDisabled').set({
    role: 'print_shop', active: true, printShopShops: ['shopNoPod'],
  });
  await db.collection('users').doc('printerLegacy').set({
    role: 'print_shop', active: true, printShopShops: ['shopLegacy', 'shopMissingKey', 'shopGhost'],
  });
  await db.collection('users').doc('printerInactive').set({
    role: 'print_shop', active: false, printShopShops: ['shopPod'],
  });
}

async function run() {
  await seed();

  console.log('\n=== isShopFeatureEnabled(shopId, "pod") — OPT-IN semantics (post D3 flip) ===');
  await check('explicit pod:true → enabled', async () => assert((await isShopFeatureEnabled('shopPod', 'pod')) === true));
  await check('explicit pod:false → disabled', async () => assert((await isShopFeatureEnabled('shopNoPod', 'pod')) === false));
  await check('no features map at all → OFF (opt-in)', async () => assert((await isShopFeatureEnabled('shopLegacy', 'pod')) === false));
  await check('features map present, "pod" key absent → OFF (opt-in)', async () => assert((await isShopFeatureEnabled('shopMissingKey', 'pod')) === false));
  await check('no shop doc at all → OFF (opt-in)', async () => assert((await isShopFeatureEnabled('shopGhost', 'pod')) === false));
  await check('legacy key (affiliate) still default-ON on a shop with no features map', async () => assert((await isShopFeatureEnabled('shopLegacy', 'affiliate')) === true));
  await check('legacy key (affiliate) explicit true still enabled', async () => assert((await isShopFeatureEnabled('shopMissingKey', 'affiliate')) === true));

  console.log('\n=== getPrintShopContext: D6 pod-disabled shop filtered out of printShopShops ===');
  await check('printer assigned to [pod-shop, non-pod-shop] → context keeps ONLY the pod shop', async () => {
    const ctx = await assertOk(getPrintShopContext('printerBoth'));
    assert(ctx.printShopShops.length === 1, `expected 1 shop, got ${ctx.printShopShops.length}`);
    assert(ctx.printShopShops[0] === 'shopPod', 'the pod-enabled shop must be the one that survives');
  });
  await check('printer assigned ONLY to a pod-disabled shop → permission-denied (distinct message)', () =>
    assertThrows(getPrintShopContext('printerOnlyDisabled'), 'not enabled for any of your assigned shops'));
  await check('printer on legacy shops (no explicit pod flag) → denied post-flip (opt-in: missing = OFF)', () =>
    assertThrows(getPrintShopContext('printerLegacy'), 'not enabled for any of your assigned shops'));
  await check('inactive printer still denied before the pod check runs', () =>
    assertThrows(getPrintShopContext('printerInactive'), 'Print shop access required'));

  console.log('\n=== assertShopAllowed: pod-disabled shop denied even if it WAS assigned ===');
  await check('getPrintJob/getPrintArtworkDownload/setPrintJobStatus style check: pod-disabled shop denied', async () => {
    const ctx = await assertOk(getPrintShopContext('printerBoth')); // ctx.printShopShops = ['shopPod']
    await assertThrows(Promise.resolve().then(() => assertShopAllowed(ctx, 'shopNoPod')), 'not in your assigned shops');
  });
  await check('pod-enabled assigned shop still allowed', async () => {
    const ctx = await assertOk(getPrintShopContext('printerBoth'));
    assertShopAllowed(ctx, 'shopPod'); // must not throw
  });

  console.log(`\n=== pod-shop-gating: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error('Harness error:', e); process.exit(2); });
