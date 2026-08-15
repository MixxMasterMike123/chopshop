/**
 * Storage security-rules test — Tenant ISOLATION (Phase B).
 *
 * Proves the shopId-partitioned storage.rules BOTH ways: a shop admin may
 * write ONLY their own shop's partitioned paths, a platform admin may write
 * any shop's, cross-shop writes are DENIED, and the LEGACY flat blocks are
 * READ-ONLY (the cross-shop write hole during transition is closed). Reads that
 * the storefront/customers need stay open.
 *
 * Storage rules read the TOKEN claim (role/shopId/platform) — this suite seeds
 * those claims to mirror production (syncAdminClaims/syncUserClaimsOnWrite).
 *
 * RUN (never touches prod):
 *   1) JAVA_HOME=<jdk21> firebase emulators:start --only storage --project demo-rules-test
 *   2) node rules-tests/storage-isolation.test.cjs
 */

const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');

const PROJECT_ID = 'demo-rules-test';
const RULES = fs.readFileSync(path.join(__dirname, '..', 'storage.rules'), 'utf8');
const BYTES = new Uint8Array([1, 2, 3]);

let env;
let passed = 0;
let failed = 0;
async function check(name, p) {
  try { await p; console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name} — ${e.message}`); failed++; }
}

// Auth contexts WITH the storage token claims production sets.
const platform = () => env.authenticatedContext('mikael', { role: 'admin', platform: true, shopId: 'shopA' }).storage();
const shopAAdmin = () => env.authenticatedContext('adminA', { role: 'admin', platform: false, shopId: 'shopA' }).storage();
const shopBAdmin = () => env.authenticatedContext('adminB', { role: 'admin', platform: false, shopId: 'shopB' }).storage();
const customer = (uid) => env.authenticatedContext(uid, {}).storage();
const anon = () => env.unauthenticatedContext().storage();

async function run() {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: { rules: RULES, host: '127.0.0.1', port: 9199 },
  });
  await env.clearStorage();

  // Seed a couple of legacy + partitioned files with rules disabled so reads
  // have something to fetch.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.storage();
    await uploadBytes(ref(s, 'products/legacyflat/old.jpg'), BYTES);          // legacy flat
    await uploadBytes(ref(s, 'products/shopA/p1/img.jpg'), BYTES);             // partitioned shopA
    await uploadBytes(ref(s, 'branding/shopA/logo.png'), BYTES);
  });

  console.log('\n=== LEGIT WRITES (allow) ===');
  await check('shopA admin writes OWN partitioned product image', assertSucceeds(
    uploadBytes(ref(shopAAdmin(), 'products/shopA/p2/img.jpg'), BYTES)));
  await check('shopA admin writes OWN partitioned branding', assertSucceeds(
    uploadBytes(ref(shopAAdmin(), 'branding/shopA/hero.jpg'), BYTES)));
  await check('platform admin writes ANY shop partitioned product (shopB)', assertSucceeds(
    uploadBytes(ref(platform(), 'products/shopB/p9/img.jpg'), BYTES)));
  await check('shopA admin writes OWN partitioned affiliate invoice', assertSucceeds(
    uploadBytes(ref(shopAAdmin(), 'affiliates/shopA/aff1/invoices/inv.pdf'), BYTES)));
  await check('shopA admin writes OWN partitioned page attachment', assertSucceeds(
    uploadBytes(ref(shopAAdmin(), 'pages/shopA/page1/attachments/doc.pdf'), BYTES)));

  console.log('\n=== LEGIT READS (allow) ===');
  await check('anon reads partitioned product image (storefront)', assertSucceeds(
    getBytes(ref(anon(), 'products/shopA/p1/img.jpg'))));
  await check('anon reads partitioned branding (storefront)', assertSucceeds(
    getBytes(ref(anon(), 'branding/shopA/logo.png'))));
  await check('anon reads LEGACY flat product (still renders during transition)', assertSucceeds(
    getBytes(ref(anon(), 'products/legacyflat/old.jpg'))));

  console.log('\n=== CROSS-SHOP / overlap WRITES (deny) ===');
  await check('shopA admin CANNOT write shopB partitioned product', assertFails(
    uploadBytes(ref(shopAAdmin(), 'products/shopB/p1/img.jpg'), BYTES)));
  await check('shopB admin CANNOT write shopA partitioned branding', assertFails(
    uploadBytes(ref(shopBAdmin(), 'branding/shopA/logo.png'), BYTES)));
  await check('shopA admin CANNOT write shopB affiliate invoice', assertFails(
    uploadBytes(ref(shopAAdmin(), 'affiliates/shopB/aff2/invoices/inv.pdf'), BYTES)));
  await check('shopA admin CANNOT write shopB page attachment', assertFails(
    uploadBytes(ref(shopAAdmin(), 'pages/shopB/page2/attachments/x.pdf'), BYTES)));
  // THE KEY OVERLAP CHECK: a partitioned path also matches the legacy
  // products/{allPaths=**} block. If that legacy block still granted write, this
  // cross-shop write would WRONGLY succeed. Read-only legacy block => denied.
  await check('shopA admin CANNOT write shopB product via legacy-overlap', assertFails(
    uploadBytes(ref(shopAAdmin(), 'products/shopB/sneaky/img.jpg'), BYTES)));
  await check('shopA admin CANNOT write a LEGACY flat product path', assertFails(
    uploadBytes(ref(shopAAdmin(), 'products/legacyflat/hack.jpg'), BYTES)));
  await check('non-admin customer CANNOT write a product image', assertFails(
    uploadBytes(ref(customer('c1'), 'products/shopA/p1/img.jpg'), BYTES)));
  await check('anon CANNOT write branding', assertFails(
    uploadBytes(ref(anon(), 'branding/shopA/logo.png'), BYTES)));

  // ── P1-17 (2026-08-15 audit): print/ files are fully SERVER-OWNED — client
  //    delete is denied (a same-shop client could otherwise strand a paid
  //    order's production file). Library cleanup OUTSIDE print/ stays allowed. ──
  console.log('\n=== POD print/ partition — server-owned (create/update/DELETE) ===');
  await env.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.storage();
    await uploadBytes(ref(s, 'pod-artwork/shopA/print/art1.png'), BYTES);      // server-minted print file
    await uploadBytes(ref(s, 'pod-artwork/shopA/originals/art1.tiff'), BYTES); // seller library original
  });
  await check('shopA admin CANNOT delete own shop print/ file (server-owned)', assertFails(
    deleteObject(ref(shopAAdmin(), 'pod-artwork/shopA/print/art1.png'))));
  await check('platform via client SDK CANNOT delete print/ file either', assertFails(
    deleteObject(ref(platform(), 'pod-artwork/shopA/print/art1.png'))));
  await check('shopA admin CANNOT upload into print/ (pre-existing gate holds)', assertFails(
    uploadBytes(ref(shopAAdmin(), 'pod-artwork/shopA/print/injected.png'), BYTES)));
  await check('shopA admin deletes own LIBRARY original (cleanup still allowed)', assertSucceeds(
    deleteObject(ref(shopAAdmin(), 'pod-artwork/shopA/originals/art1.tiff'))));
  await check('shopB admin CANNOT delete shopA print file (cross-shop + server-owned)', assertFails(
    deleteObject(ref(shopBAdmin(), 'pod-artwork/shopA/print/art1.png'))));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), 'pod-artwork/shopA/originals/art2.tiff'), BYTES);
  });
  await check('shopB admin CANNOT delete shopA LIBRARY original (cross-shop)', assertFails(
    deleteObject(ref(shopBAdmin(), 'pod-artwork/shopA/originals/art2.tiff'))));

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  await env.cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('Harness error:', e); process.exit(2); });
