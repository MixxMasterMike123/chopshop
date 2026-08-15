/**
 * purge-b8shield-shop.cjs — delete the legacy `b8shield` tenant, completely.
 *
 * CONTEXT (2026-08-15): `shops/b8shield` was the platform's original single-shop
 * tenant, kept only as a reference while the app was generalized. Mikael
 * confirmed nothing in it needs saving. Removing it is the data half of killing
 * the default-shop fallback (the code half — the UNRESOLVED_SHOP_ID sentinel +
 * ShopPicker — landed in the same change).
 *
 * WHAT IT DELETES
 *   - every doc with `shopId == 'b8shield'` across the shop-scoped collections
 *   - the `shops/b8shield` tenant doc itself
 *   - the legacy `settings/app` doc (--with-legacy-settings), the pre-tenancy
 *     single-shop identity doc that shopConfig only reads for b8shield
 *
 * WHAT IT NEVER DELETES (hard guards, not conventions)
 *   1. PLATFORM USERS — the super-admin login is preserved, with FULL access to
 *      EVERY shop. The b8shield-tagged `users` doc is Mikael's own super-admin
 *      (platform:true); deleting it would destroy the operator login. Platform
 *      users are RE-STAMPED to shopId:null instead — which is also what
 *      set-platform-admin.cjs now writes, since an operator belongs to no shop
 *      and picks a tenant via the ShopPicker.
 *
 *      Why shopId:null does NOT reduce access (verified against the rules):
 *      cross-shop authority comes from `platform == true`, never from shopId.
 *      Both firestore.rules and storage.rules gate on
 *        isAdminOfShop(s) = isPlatform() || (isAdmin() && shopId == s)
 *      where the isPlatform() branch short-circuits and never reads shopId. The
 *      "every admin MUST have a non-null shopId" invariant in firestore.rules is
 *      explicitly scoped to NON-platform admins. syncUserClaimsOnWrite likewise
 *      preserves platform:true when shopId becomes null. Net effect: the
 *      operator keeps access to ALL shops and simply loses a "home shop"
 *      pointer — which is the entire point of the picker.
 *      ⚠️ The shopId change counts as a claim move, so live tokens are revoked:
 *      sign out and back in once after running this.
 *   2. Any doc whose shopId is not exactly 'b8shield'. Every read is an
 *      equality query on that value; other tenants are never enumerated.
 *   3. Non-platform `role:'admin'` users, unless --allow-admin-delete. If a
 *      real shop admin were somehow tagged b8shield, the script STOPS rather
 *      than silently removing someone's login.
 *
 * SAFETY
 *   - DRY RUN by default: prints the exact per-collection plan and exits.
 *     Pass `--commit` to actually delete. Deletion is IRREVERSIBLE.
 *   - Batched at 400 writes/commit (under Firestore's 500 limit).
 *   - Targets the named database `b8s-reseller-db` (the app's real DB — NOT
 *     '(default)', which is empty). Requires Application Default Credentials.
 *   - Re-runnable: a second run finds nothing and reports a clean slate.
 *
 * USAGE (Mikael runs — live data DELETE, STOP-and-surface class):
 *   node scripts/purge-b8shield-shop.cjs                            # dry run
 *   node scripts/purge-b8shield-shop.cjs --commit                   # delete
 *   node scripts/purge-b8shield-shop.cjs --commit --with-legacy-settings
 */

const path = require('path');
const { createRequire } = require('module');
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const admin = functionsRequire('firebase-admin');
const { getFirestore } = functionsRequire('firebase-admin/firestore');

const SHOP_ID = 'b8shield';
const BATCH_SIZE = 400;

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const ALLOW_ADMIN_DELETE = args.includes('--allow-admin-delete');
const WITH_LEGACY_SETTINGS = args.includes('--with-legacy-settings');

// Every shop-scoped collection. Superset of scripts/backfill-shopid.cjs (the
// Phase 1 stamp sites) plus the collections added since (add-ons, POD, CRM), so
// nothing b8shield-tagged is left orphaned. A collection that doesn't exist or
// holds no b8shield docs simply reports 0.
const COLLECTIONS = [
  'products', 'productGroups', 'b2cCustomers', 'affiliates',
  'affiliateApplications', 'affiliateClicks', 'campaigns',
  'campaignRevenueTracking', 'campaignParticipants', 'pages',
  'marketingMaterials', 'affiliatePayouts', 'orders',
  'adminCustomerDocuments', 'auditLogs', 'passwordResets', 'emailVerifications',
  'collections', 'discountCodes', 'productReviews', 'podMappings', 'podArtwork',
  'leads', 'socialPosts', 'activities', 'followUps', 'customerDocuments',
  'b2bCustomers', 'ambassadorActivities', 'deferredActivities', 'userMentions',
  'impersonationAudit', 'adminPresence', 'dac7CorrectionRequests',
];

admin.initializeApp(); // Application Default Credentials, like the sibling scripts
const db = getFirestore('b8s-reseller-db');

/** Delete a list of DocumentReferences in batches. */
async function deleteRefs(refs) {
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    refs.slice(i, i + BATCH_SIZE).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

async function main() {
  console.log('🔥 Purge legacy shop — b8shield');
  console.log(`   database: b8s-reseller-db`);
  console.log(`   mode:     ${COMMIT ? '🔴 COMMIT (will DELETE)' : '🟡 DRY RUN (no writes)'}`);
  console.log('');

  // Confirm the tenant doc's state up front — a shop that is still ACTIVE is a
  // strong sign the wrong id was passed, so refuse it.
  const shopSnap = await db.collection('shops').doc(SHOP_ID).get();
  if (shopSnap.exists) {
    const s = shopSnap.data();
    console.log(`   tenant:   shops/${SHOP_ID} status=${s.status || '(none)'} name=${s.name || '(none)'}`);
    if (s.status !== 'disabled') {
      console.error(`\n❌ REFUSING: shops/${SHOP_ID}.status is "${s.status}", not "disabled".`);
      console.error('   Disable the shop first — an active shop should never be purged.');
      process.exit(1);
    }
  } else {
    console.log(`   tenant:   shops/${SHOP_ID} does not exist (already purged?)`);
  }
  console.log('');

  const plan = [];          // { collection, refs[] }
  const platformKeeps = []; // platform users to re-stamp instead of delete
  const adminCasualties = [];
  let totalDeletes = 0;

  for (const col of COLLECTIONS) {
    let snap;
    try {
      snap = await db.collection(col).where('shopId', '==', SHOP_ID).get();
    } catch (e) {
      console.log(`   ${col.padEnd(26)} ⚠️  query failed: ${e.message.slice(0, 60)}`);
      continue;
    }
    if (snap.empty) continue;
    plan.push({ collection: col, refs: snap.docs.map((d) => d.ref) });
    totalDeletes += snap.size;
    console.log(`   ${col.padEnd(26)} ${snap.size}`);
  }

  // `users` is handled SEPARATELY from the loop above: a user doc is an identity,
  // not shop content, and deleting the wrong one destroys a login.
  const userSnap = await db.collection('users').where('shopId', '==', SHOP_ID).get();
  const userDeletes = [];
  userSnap.forEach((d) => {
    const x = d.data();
    if (x.platform === true) {
      platformKeeps.push({ ref: d.ref, uid: d.id, email: x.email });
    } else if (x.role === 'admin' && !ALLOW_ADMIN_DELETE) {
      adminCasualties.push({ uid: d.id, email: x.email });
    } else {
      userDeletes.push(d.ref);
    }
  });
  if (userDeletes.length) {
    plan.push({ collection: 'users', refs: userDeletes });
    totalDeletes += userDeletes.length;
    console.log(`   ${'users'.padEnd(26)} ${userDeletes.length}`);
  }

  console.log('');
  console.log(`   TOTAL docs to delete: ${totalDeletes}`);

  if (platformKeeps.length) {
    console.log('');
    console.log('   🛡️  PLATFORM users KEPT (re-stamped shopId → null, never deleted):');
    platformKeeps.forEach((p) => console.log(`       ${p.uid}  ${p.email}`));
  }

  if (adminCasualties.length) {
    console.error('');
    console.error('❌ REFUSING: these NON-platform admin users are tagged b8shield:');
    adminCasualties.forEach((a) => console.error(`       ${a.uid}  ${a.email}`));
    console.error('   Deleting them would destroy a real admin login.');
    console.error('   Re-run with --allow-admin-delete only if you are certain.');
    process.exit(1);
  }

  if (!COMMIT) {
    console.log('');
    console.log('🟡 Dry run complete. Nothing was written.');
    console.log('   Re-run with --commit to delete. This is IRREVERSIBLE.');
    return;
  }

  // ── COMMIT ────────────────────────────────────────────────────────────────
  console.log('');
  console.log('🔴 Deleting…');
  for (const { collection: col, refs } of plan) {
    await deleteRefs(refs);
    console.log(`   ✅ ${col}: ${refs.length} deleted`);
  }

  // Re-stamp platform operators to "no home shop" so they use the ShopPicker.
  for (const p of platformKeeps) {
    await p.ref.set({ shopId: null }, { merge: true });
    console.log(`   ✅ users/${p.uid}: shopId → null (${p.email})`);
  }

  if (shopSnap.exists) {
    await db.collection('shops').doc(SHOP_ID).delete();
    console.log(`   ✅ shops/${SHOP_ID} deleted`);
  }

  if (WITH_LEGACY_SETTINGS) {
    const legacy = await db.collection('settings').doc('app').get();
    if (legacy.exists) {
      await legacy.ref.delete();
      console.log('   ✅ settings/app (legacy single-shop identity) deleted');
    } else {
      console.log('   ℹ️  settings/app not present');
    }
  } else {
    console.log('   ⏭️  settings/app kept (pass --with-legacy-settings to delete)');
  }

  console.log('');
  console.log('🎉 Done. NEXT:');
  console.log('   1. Sign out and back in — the shopId claim change revoked live tokens.');
  console.log('      Your super-admin (platform:true) access to ALL shops is unchanged.');
  console.log('   2. Storage: purge the b8shield partitions (see the storage note below).');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
