/** P1-16 immutable production snapshot — pure/fake-Firestore regression tests. */
const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-rules-test' });

const {
  PRODUCTION_SNAPSHOT_VERSION,
  artworkDeliverable,
  buildProductionSnapshot,
  findUnresolvedPodLines,
  orderHasPodLine,
  productionSnapshotLines,
  productionSnapshotPending,
  toPrintNotificationLines,
  toQueueRow,
} = require('../functions/lib/print/printProjection.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

const fakeDb = (artworks) => ({
  collection: (name) => {
    if (name !== 'podArtwork') throw new Error(`unexpected collection ${name}`);
    return { doc: (id) => ({ get: async () => ({ exists: !!artworks[id], data: () => artworks[id] }) }) };
  },
});

const mappingMap = (artworkId = 'art-old') => new Map([['TEE', [{
  id: 'map-front', sku: 'TEE', placementSlot: 'front', slotLabel: 'Framsida',
  placement: 'Centrerad', profileId: 'apparel_dtg', artworkId,
}]]]);

const readyArt = (path = 'pod-artwork/shopA/print/old.png') => ({
  shopId: 'shopA', status: 'ready', printStoragePath: path,
  printUrl: 'https://firebasestorage.googleapis.com/old', previewUrl: 'https://firebasestorage.googleapis.com/preview',
  fileName: 'logo.tiff', purpose: 'apparel_dtg',
  validation: { gate: 'PASS', tier: 'PASS', pipelineVersion: 'sharp-v1' },
});

(async () => {
  console.log('\n=== artworkDeliverable: only current ready/PASS files enter new snapshots ===');
  ok(artworkDeliverable(readyArt(), 'shopA').deliverable === true, 'ready + PASS + own print path → deliverable');
  ok(artworkDeliverable({ ...readyArt(), status: 'rejected' }, 'shopA').deliverable === false,
    'rejected artwork with stale print path → rejected');
  ok(artworkDeliverable({ ...readyArt(), validation: { gate: 'FAIL' } }, 'shopA').deliverable === false,
    'ready doc without current PASS verdict → rejected');
  ok(artworkDeliverable(readyArt('pod-artwork/shopB/print/foreign.png'), 'shopA').deliverable === false,
    'foreign print path → rejected');

  console.log('\n=== buildProductionSnapshot: freeze exact production identity ===');
  const order = { shopId: 'shopA', items: [{ sku: 'TEE-BLACK-L', name: 'T-shirt', quantity: 2, isPodProduct: true }] };
  const snapshot = await buildProductionSnapshot(order, mappingMap(), fakeDb({ 'art-old': readyArt() }));
  const line = snapshot.lines[0];
  ok(snapshot.version === PRODUCTION_SNAPSHOT_VERSION && snapshot.lines.length === 1, 'one frozen item×slot line');
  ok(line.mappingId === 'map-front' && line.artworkId === 'art-old', 'mapping and artwork ids frozen');
  ok(line.printStoragePath === 'pod-artwork/shopA/print/old.png', 'exact approved print path frozen');
  ok(line.placement === 'Framsida — Centrerad' && line.placementSlot === 'front', 'slot and placement frozen');
  ok(line.artworkVersion === 'old.png', 'unique artifact version frozen from print path');
  ok(!('printFallbackUrl' in line) && !('previewUrl' in line),
    'snapshot stores paths only — no long-lived Storage token URLs');

  console.log('\n=== mutation stability: paid order ignores the live graph ===');
  const frozenOrder = { ...order, productionSnapshotRequired: true, productionSnapshot: snapshot };
  const changedMappings = mappingMap('art-new');
  ok(productionSnapshotLines(frozenOrder)[0].artworkId === 'art-old', 'snapshot still points to original artwork');
  ok(orderHasPodLine(frozenOrder, new Map()) === true, 'POD detection works after every live mapping is deleted');
  ok(toPrintNotificationLines(frozenOrder, changedMappings)[0].placement === 'Framsida — Centrerad',
    'notification ignores replacement mapping');
  ok(toQueueRow('o1', frozenOrder, 'Shop A', new Map()).podLineCount === 1,
    'queue count ignores deleted mappings');
  ok((await findUnresolvedPodLines(frozenOrder, changedMappings, fakeDb({}), async () => true)).length === 0,
    'completion gate trusts valid frozen path, not changed/deleted artwork doc');
  ok((await findUnresolvedPodLines(frozenOrder, changedMappings, fakeDb({}), async () => false)).length === 1,
    'completion gate blocks when the frozen object is missing or cannot be signed');

  console.log('\n=== unresolved and pending states fail closed ===');
  const rejected = await buildProductionSnapshot(order, mappingMap(), fakeDb({
    'art-old': { ...readyArt(), status: 'rejected', validation: { gate: 'FAIL' } },
  }));
  ok(!!rejected.lines[0].unresolvedReason && !rejected.lines[0].printStoragePath,
    'rejected artwork becomes explicit unresolved line');
  const foreignDoc = await buildProductionSnapshot(order, mappingMap(), fakeDb({
    'art-old': { ...readyArt(), shopId: 'shopB' },
  }));
  ok(/annan butik/i.test(foreignDoc.lines[0].unresolvedReason), 'foreign artwork document is explicitly rejected');
  const legacyOriginal = await buildProductionSnapshot(order, mappingMap(), fakeDb({
    'art-old': { shopId: 'shopA', originalStoragePath: 'pod-artwork/shopA/originals/legacy.tif' },
  }));
  ok(/valideras/i.test(legacyOriginal.lines[0].unresolvedReason),
    'new order rejects legacy raw-original fallback until it is validated');
  const noMapping = await buildProductionSnapshot(order, new Map(), fakeDb({}));
  ok(noMapping.lines.length === 1 && /tryckkoppling/i.test(noMapping.lines[0].unresolvedReason),
    'POD marker + missing mapping remains visible and blocking');
  ok((await findUnresolvedPodLines({ ...order, productionSnapshot: rejected }, new Map(), fakeDb({}))).length === 1,
    'unresolved frozen line blocks completion');
  ok(productionSnapshotPending({ productionSnapshotRequired: true }) === true,
    'required snapshot absence is a locked pending state');
  ok(orderHasPodLine({ ...order, productionSnapshotRequired: true }, mappingMap()) === false,
    'pending snapshot cannot fall back to mutable live mapping');

  console.log('\n=== legacy compatibility is explicit ===');
  const legacyOrder = { shopId: 'shopA', items: [{ sku: 'TEE-BLACK-L', quantity: 1 }] };
  ok(productionSnapshotLines(legacyOrder) === null && productionSnapshotPending(legacyOrder) === false,
    'pre-migration order is recognized as legacy');
  ok(orderHasPodLine(legacyOrder, mappingMap()) === true, 'legacy order retains live-mapping fallback');

  console.log(`\n=== production-snapshot: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
