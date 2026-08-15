/**
 * set-platform-admin.cjs — Phase 3 step (a).
 *
 * Marks the platform super-admin on their users/{uid} doc:
 *   - platform: true   → bypasses shop-scoping in the new rules
 *   - shopId: null     → a platform operator belongs to NO shop. They pick the
 *                        tenant they are administering (ShopPicker), which the
 *                        admin top bar then names. Stamping a real shopId here
 *                        is what used to bind operators silently to b8shield.
 * Keeps role:'admin' untouched (so all existing role=='admin' rules keep working).
 *
 * Idempotent + DRY-RUN by default. Reversible (delete the two fields to revert).
 *
 * USAGE (Mikael runs — live data write, STOP-and-surface class):
 *   node scripts/set-platform-admin.cjs                       # dry run, all admins
 *   node scripts/set-platform-admin.cjs --commit              # write
 *   node scripts/set-platform-admin.cjs --uid=<uid> --commit  # target one uid
 *
 * Default: every users doc with role=='admin' gets platform:true + shopId:null.
 * (Today there is exactly one admin = Mikael.)
 */

const path = require('path');
const { createRequire } = require('module');
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const admin = functionsRequire('firebase-admin');
const { getFirestore } = functionsRequire('firebase-admin/firestore');

// A platform operator has NO home shop — see the header. There is no default
// shop id any more (src/config/tenancy.js exports only an inert sentinel).

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const uidArg = args.find((a) => a.startsWith('--uid='));
const TARGET_UID = uidArg ? uidArg.split('=')[1] : null;
const shopArg = args.find((a) => a.startsWith('--shop='));
// --shop=<id> is still honored for the rare case of pinning an operator to a
// home shop; omitted (the normal case) means shopId:null → they use the picker.
const SHOP_ID = shopArg ? shopArg.split('=')[1] : null;

admin.initializeApp();
const db = getFirestore('b8s-reseller-db');
db.settings({ ignoreUndefinedProperties: true });

async function main() {
  console.log('👑 Set platform super-admin — multi-tenant Phase 3');
  console.log(`   shopId: ${SHOP_ID === null ? 'null (no home shop — uses the shop picker)' : SHOP_ID}`);
  console.log(`   mode:   ${COMMIT ? '🔴 COMMIT (will write)' : '🟡 DRY RUN (no write)'}`);
  console.log('');

  let docs;
  if (TARGET_UID) {
    const snap = await db.collection('users').doc(TARGET_UID).get();
    if (!snap.exists) { console.log(`❌ users/${TARGET_UID} not found`); return; }
    docs = [snap];
  } else {
    const snap = await db.collection('users').where('role', '==', 'admin').get();
    docs = snap.docs;
  }

  console.log(`Found ${docs.length} admin user(s):`);
  for (const d of docs) {
    const x = d.data();
    const needsPlatform = x.platform !== true;
    // Target shopId: an explicit --shop=<id>, else null (no home shop). An
    // operator carrying a stale real shopId gets CLEARED to null, so they land
    // on the picker instead of silently inheriting a tenant.
    const targetShop = SHOP_ID || null;
    const needsShop = (x.shopId || null) !== targetShop;
    console.log(
      `  - ${d.id} (${x.email}) | platform:${x.platform === true ? 'already' : 'WILL SET'} | shopId:${
        needsShop ? `${x.shopId || 'none'} → WILL SET ${targetShop === null ? 'null (uses shop picker)' : targetShop}` : x.shopId || 'null (uses shop picker)'
      }`
    );
    if (COMMIT && (needsPlatform || needsShop)) {
      await d.ref.set(
        { platform: true, shopId: targetShop },
        { merge: true }
      );
      console.log(`    ✅ updated`);
    }
  }

  console.log('');
  if (!COMMIT) {
    console.log('🟡 Dry run complete. Re-run with --commit to write.');
  } else {
    console.log('🔴 Done. NEXT: deploy + run syncAdminClaims so the custom claim');
    console.log('   carries {role, shopId, platform}, then re-login to refresh the token.');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ failed:', e); process.exit(1); });
