/**
 * Backfill productsPublic from products (P1-11 public catalogue projection).
 *
 * WHY: the syncProductsPublicOnWrite trigger only fires on FUTURE product
 * writes. Existing products need a one-time projection pass BEFORE the
 * storefront hosting deploy repoints reads to productsPublic — otherwise
 * every storefront goes empty until each product is next edited.
 *
 * Uses the COMPILED projection from functions/lib so backfill and trigger are
 * byte-identical logic (run `npm run build` in functions/ first). Also removes
 * orphaned projection docs whose source product no longer exists or is no
 * longer publishable, so re-runs converge (idempotent).
 *
 *   node scripts/backfill-products-public.cjs            # dry run
 *   node scripts/backfill-products-public.cjs --commit   # apply
 *
 * Named DB b8s-reseller-db; needs micke ADC (NOT the merchant SA).
 */
const { createRequire } = require('module');
const path = require('path');
const req = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { Firestore } = req('@google-cloud/firestore');
const { projectPublicProduct } = require(path.join(
  __dirname, '..', 'functions', 'lib', 'catalog', 'projectProduct.js'
));

const COMMIT = process.argv.includes('--commit');
const db = new Firestore({ projectId: 'b8shield-reseller-app', databaseId: 'b8s-reseller-db' });

(async () => {
  const [prodSnap, pubSnap] = await Promise.all([
    db.collection('products').get(),
    db.collection('productsPublic').get(),
  ]);

  const toSet = new Map(); // id -> projected doc
  let drafts = 0;
  prodSnap.forEach((doc) => {
    const pub = projectPublicProduct(doc.data());
    if (pub) toSet.set(doc.id, pub);
    else drafts++;
  });

  const toDelete = pubSnap.docs.map((d) => d.id).filter((id) => !toSet.has(id));

  console.log(`Scanned ${prodSnap.size} products: ${toSet.size} publishable, ${drafts} draft/inactive (no projection).`);
  console.log(`Existing projections: ${pubSnap.size}; orphans to delete: ${toDelete.length}.`);
  for (const [id, pub] of toSet) {
    console.log(`  ${pub.shopId}  ${id}  "${typeof pub.name === 'string' ? pub.name : pub.sku || ''}"`);
  }
  toDelete.forEach((id) => console.log(`  DELETE orphan ${id}`));

  if (!COMMIT) { console.log('\nDRY RUN — re-run with --commit to apply.'); return; }

  console.log('\nApplying…');
  let batch = db.batch(); let ops = 0; let flushed = 0;
  const flush = async () => { if (ops) { await batch.commit(); flushed += ops; batch = db.batch(); ops = 0; } };
  for (const [id, pub] of toSet) {
    batch.set(db.collection('productsPublic').doc(id), pub); // overwrite, not merge
    if (++ops >= 400) await flush();
  }
  for (const id of toDelete) {
    batch.delete(db.collection('productsPublic').doc(id));
    if (++ops >= 400) await flush();
  }
  await flush();
  console.log(`Done. ${flushed} write(s) committed (${toSet.size} set, ${toDelete.length} delete).`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
