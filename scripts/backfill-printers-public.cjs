/**
 * Backfill printersPublic from printers (A13 "seller sees ONE number").
 *
 * WHY: printers/{uid} (the price tiers) becomes platform-only and the Design
 * Studio reads the price-free printersPublic/{uid} mirror instead. The
 * syncPrintersPublicOnWrite trigger only fires on FUTURE printer writes, so
 * every EXISTING tier (Kim & co — anything not written by the SnapWear seed)
 * needs a one-time projection BEFORE the hosting deploy repoints the studio.
 * Skipping it: the studio sees no printers → routes nothing → offers every
 * template (the "no printers configured" fallback), incl. garments nobody
 * makes, which checkout then refuses.
 *
 * Uses the COMPILED projection from functions/lib so backfill and trigger are
 * byte-identical logic (run `npm run build` in functions/ first). Also deletes
 * mirror docs whose source tier no longer exists, so re-runs converge.
 *
 *   (cd functions && npm run build)
 *   node scripts/backfill-printers-public.cjs            # dry run
 *   node scripts/backfill-printers-public.cjs --commit   # apply
 *
 * Named DB b8s-reseller-db; needs micke ADC (NOT the merchant SA).
 */
const { createRequire } = require('module');
const path = require('path');
const req = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { Firestore } = req('@google-cloud/firestore');
const { projectPrinterPublic } = require(path.join(
  __dirname, '..', 'functions', 'lib', 'print', 'projectPrinterPublic.js'
));

const COMMIT = process.argv.includes('--commit');
const db = new Firestore({ projectId: 'b8shield-reseller-app', databaseId: 'b8s-reseller-db' });

(async () => {
  const [srcSnap, pubSnap] = await Promise.all([
    db.collection('printers').get(),
    db.collection('printersPublic').get(),
  ]);

  const toSet = new Map();
  srcSnap.forEach((d) => toSet.set(d.id, projectPrinterPublic(d.data())));
  const toDelete = pubSnap.docs.map((d) => d.id).filter((id) => !toSet.has(id));

  console.log(`Scanned ${srcSnap.size} printers; existing mirrors: ${pubSnap.size}; orphans to delete: ${toDelete.length}.`);
  for (const [id, pub] of toSet) {
    console.log(`  ${id}  "${pub.name || ''}"  active=${pub.active}  garments=${pub.garments.join(',') || '—'}  frames=${Object.keys(pub.printAreasMm).join(',') || '—'}`);
  }
  toDelete.forEach((id) => console.log(`  DELETE orphan ${id}`));

  if (!COMMIT) { console.log('\nDRY RUN — re-run with --commit to apply.'); return; }

  const batch = db.batch();
  for (const [id, pub] of toSet) batch.set(db.collection('printersPublic').doc(id), pub); // overwrite, not merge
  for (const id of toDelete) batch.delete(db.collection('printersPublic').doc(id));
  await batch.commit();
  console.log(`Done. ${toSet.size} set, ${toDelete.length} delete.`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
