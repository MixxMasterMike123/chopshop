/**
 * Slice 4 — WHO prints each line, what it costs, and who may see it.
 *
 * Two halves, both pure (no emulator; needs `npm --prefix functions run build`):
 *
 *  1. STAMPING. buildProductionSnapshot freezes `printerUid` + `printCostSek`
 *     (per line) + `itemCostSek` (once per ITEM, on its first line) from
 *     settings/printRouting + printers/{uid}. Money is ex moms. The blank and
 *     the 40 kr platform cut may be counted ONCE per item, never once per print.
 *
 *  2. VISIBILITY. A frozen line is visible to a printer when it is routed to
 *     that printer OR routed to nobody (printerUid null → every assigned printer
 *     sees it: legacy snapshots and unconfigured platforms must not go dark).
 *     Asserted on the PURE helpers the callables delegate to — isLineVisibleTo /
 *     visibleSnapshotLines / orderHasVisiblePodLine / excludedArtworkIds — plus
 *     toQueueRow and toPrintJob, which take the viewer uid. The onCall wrappers
 *     themselves need auth+Firestore and are covered by the emulator suites.
 */
const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-rules-test' });

const {
  buildProductionSnapshot,
  isLineVisibleTo,
  visibleSnapshotLines,
  orderHasVisiblePodLine,
  orderHasPodLine,
  excludedArtworkIds,
  toQueueRow,
  toPrintJob,
  PRODUCTION_SNAPSHOT_VERSION,
} = require('../functions/lib/print/printProjection.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

// ── Fixtures ────────────────────────────────────────────────────────────────
// Kim's tier, the real 2026-08-10 price list (ex moms): tee 60, hoodie 380;
// front/back 40, pocket 20. Småland prints caps only, at its own prices.
const KIM = {
  active: true,
  garments: ['tee', 'hoodie'],
  pricing: { blankCostSek: { tee: 60, hoodie: 380 }, printCostSek: { front: 40, back: 40, pocket: 20 } },
};
const SMALAND = {
  active: true,
  garments: ['cap'],
  pricing: { blankCostSek: { cap: 50 }, printCostSek: { front: 35 } },
};
const PRINTERS = { kim: KIM, smaland: SMALAND };
// tee → Kim explicitly; everything else (incl. an unmapped/unknown garment) → Småland.
const ROUTING_INPUTS = {
  routing: { byGarment: { tee: 'kim', hoodie: 'kim', cap: 'smaland' }, defaultPrinterUid: 'smaland' },
  printersById: PRINTERS,
};

const artOk = (id) => ({
  shopId: 'shopA', status: 'ready', printStoragePath: `pod-artwork/shopA/print/${id}.png`,
  fileName: `${id}.tiff`, purpose: 'apparel_dtg',
  validation: { gate: 'PASS', tier: 'PASS' },
});
const fakeDb = (artworks) => ({
  collection: (name) => {
    if (name !== 'podArtwork') throw new Error(`unexpected collection ${name}`);
    return { doc: (id) => ({ get: async () => ({ exists: !!artworks[id], data: () => artworks[id] }) }) };
  },
});

/** One mapping row per (sku, slot). */
const mapRow = (sku, slot, artworkId, garment) => ({
  id: `map-${sku}-${slot}`, sku, placementSlot: slot, placement: '', profileId: 'apparel_dtg',
  artworkId, garment,
});
const mappings = (rows) => {
  const m = new Map();
  rows.forEach((r) => { m.set(r.sku, [...(m.get(r.sku) || []), r]); });
  return m;
};

const frozenOrder = (snapshot, extra = {}) => ({
  shopId: 'shopA', productionSnapshotRequired: true, productionSnapshot: snapshot,
  items: [{ sku: 'TEE', name: 'T-shirt', quantity: 1 }, { sku: 'CAP', name: 'Keps', quantity: 1 }],
  ...extra,
});

(async () => {
  // ── 1. STAMPING ───────────────────────────────────────────────────────────
  console.log('\n=== stamping: the routed printer is frozen per line ===');
  const teeFrontBack = { shopId: 'shopA', items: [{ sku: 'TEE', name: 'T-shirt', quantity: 1, isPodProduct: true }] };
  const teeSnap = await buildProductionSnapshot(
    teeFrontBack,
    mappings([mapRow('TEE', 'front', 'a1', 'tee'), mapRow('TEE', 'back', 'a2', 'tee')]),
    fakeDb({ a1: artOk('a1'), a2: artOk('a2') }),
    ROUTING_INPUTS
  );
  ok(teeSnap.lines.length === 2, 'front + back → two production lines');
  ok(teeSnap.lines.every((l) => l.printerUid === 'kim'), 'both tee lines are routed to Kim (byGarment.tee)');

  const capSnap = await buildProductionSnapshot(
    { shopId: 'shopA', items: [{ sku: 'CAP', name: 'Keps', quantity: 1, isPodProduct: true }] },
    mappings([mapRow('CAP', 'front', 'a3', 'cap')]),
    fakeDb({ a3: artOk('a3') }),
    ROUTING_INPUTS
  );
  ok(capSnap.lines[0].printerUid === 'smaland', 'a cap is routed to Småland, not to Kim');

  const noGarmentSnap = await buildProductionSnapshot(
    { shopId: 'shopA', items: [{ sku: 'TEE', name: 'T-shirt', quantity: 1, isPodProduct: true }] },
    mappings([mapRow('TEE', 'front', 'a1', undefined)]),
    fakeDb({ a1: artOk('a1') }),
    ROUTING_INPUTS
  );
  ok(noGarmentSnap.lines[0].garment === null && noGarmentSnap.lines[0].printerUid === 'smaland',
    'a line with no garment falls to the DEFAULT printer — never to nobody');

  const noMappingSnap = await buildProductionSnapshot(
    { shopId: 'shopA', items: [{ sku: 'GHOST', name: 'Spöke', quantity: 1, isPodProduct: true }] },
    new Map(), fakeDb({}), ROUTING_INPUTS
  );
  ok(noMappingSnap.lines[0].unresolvedReason && noMappingSnap.lines[0].printerUid === 'smaland',
    'the no-mapping defect line is still routed (default) so it lands in a queue to be fixed');

  console.log('\n=== stamping: cost is per ITEM, not per print ===');
  const [front, back] = teeSnap.lines;
  ok(front.printCostSek === 40 && back.printCostSek === 40, 'each line carries ITS slot price (40 + 40)');
  ok(front.itemCostSek === 180,
    'itemCostSek = blank 60 + front 40 + back 40 + 40 kr uttag = 180 kr ex moms (blank + cut counted once)');
  ok(back.itemCostSek === null, 'the item\'s SECOND line carries null — summing the column never double-counts');
  ok(capSnap.lines[0].itemCostSek === 125 && capSnap.lines[0].printCostSek === 35,
    'Småland prices its own cap: 50 + 35 + 40 = 125 kr ex moms');

  const unpricedSlot = await buildProductionSnapshot(
    { shopId: 'shopA', items: [{ sku: 'CAP', name: 'Keps', quantity: 1, isPodProduct: true }] },
    mappings([mapRow('CAP', 'front', 'a3', 'cap'), mapRow('CAP', 'back', 'a4', 'cap')]),
    fakeDb({ a3: artOk('a3'), a4: artOk('a4') }),
    ROUTING_INPUTS
  );
  ok(unpricedSlot.lines[1].printCostSek === null,
    'a slot the tier does not price reports null on the line (not a guessed number)');
  ok(unpricedSlot.lines[0].itemCostSek === 125,
    'and counts as 0 kr in the item total — the same lenience the studio floor uses');

  console.log('\n=== stamping: unconfigured / unresolvable routing freezes nulls, never undefined ===');
  const unrouted = await buildProductionSnapshot(
    teeFrontBack,
    mappings([mapRow('TEE', 'front', 'a1', 'tee')]),
    fakeDb({ a1: artOk('a1') })
  );
  ok(unrouted.lines[0].printerUid === null && unrouted.lines[0].itemCostSek === null
    && unrouted.lines[0].printCostSek === null,
    'no routing inputs at all → printerUid + both costs null');
  const deadRoute = await buildProductionSnapshot(
    teeFrontBack,
    mappings([mapRow('TEE', 'front', 'a1', 'tee')]),
    fakeDb({ a1: artOk('a1') }),
    { routing: { byGarment: { tee: 'kim' }, defaultPrinterUid: null }, printersById: { kim: { ...KIM, active: false } } }
  );
  ok(deadRoute.lines[0].printerUid === null,
    'a DEACTIVATED routed printer with no default resolves to nobody (the line stays visible to all)');
  const allLines = [...teeSnap.lines, ...capSnap.lines, ...unrouted.lines, ...noMappingSnap.lines];
  ok(allLines.every((l) => Object.values(l).every((v) => v !== undefined)),
    'every frozen line stays Firestore-safe (no undefined values anywhere)');
  ok(teeSnap.version === PRODUCTION_SNAPSHOT_VERSION && PRODUCTION_SNAPSHOT_VERSION === 1,
    'snapshot version stays 1 — the routing fields are additive and readers tolerate their absence');

  // ── 2. VISIBILITY ─────────────────────────────────────────────────────────
  console.log('\n=== visibility rule: mine, or nobody\'s ===');
  ok(isLineVisibleTo({ printerUid: 'kim' }, 'kim') === true, 'a line routed to me is mine');
  ok(isLineVisibleTo({ printerUid: 'kim' }, 'smaland') === false, 'a line routed to Kim is NOT Smålands');
  ok(isLineVisibleTo({ printerUid: null }, 'smaland') === true, 'an UNROUTED line is visible to every printer');
  ok(isLineVisibleTo({}, 'smaland') === true, 'a pre-Slice-4 line (no field at all) is visible to every printer');

  // A mixed order: one tee item (Kim, 2 lines) + one cap item (Småland, 1 line)
  // + one legacy unrouted line.
  const mixed = {
    version: 1, createdAt: new Date(),
    lines: [
      { ...teeSnap.lines[0], itemIndex: 0 },
      { ...teeSnap.lines[1], itemIndex: 0 },
      { ...capSnap.lines[0], itemIndex: 1, sku: 'CAP' },
      { ...unrouted.lines[0], itemIndex: 2, sku: 'LEGACY', artworkId: 'a9' },
    ],
  };
  const mixedOrder = frozenOrder(mixed);
  ok(visibleSnapshotLines(mixedOrder, 'kim').length === 3,
    'Kim sees her 2 tee lines + the unrouted one (3 of 4)');
  ok(visibleSnapshotLines(mixedOrder, 'smaland').length === 2,
    'Småland sees its cap line + the unrouted one (2 of 4)');
  ok(visibleSnapshotLines(mixedOrder, 'kim').every((l) => l.sku !== 'CAP'),
    'Kim never sees Smålands cap line');
  ok(visibleSnapshotLines(mixedOrder, 'smaland').every((l) => l.printerUid !== 'kim'),
    'Småland never sees Kims tee lines');
  ok(visibleSnapshotLines({ shopId: 'shopA', items: [] }, 'kim') === null,
    'an order with NO snapshot returns null — the caller keeps its legacy live-mapping path');

  console.log('\n=== an order only shows up for a printer that has work in it ===');
  const kimOnly = frozenOrder({ version: 1, createdAt: new Date(), lines: [mixed.lines[0], mixed.lines[1]] });
  ok(orderHasVisiblePodLine(kimOnly, new Map(), 'kim') === true, 'Kim has work in a tee-only order');
  ok(orderHasVisiblePodLine(kimOnly, new Map(), 'smaland') === false,
    'Småland has NO work in a tee-only order — it must not appear in its queue');
  ok(orderHasVisiblePodLine(mixedOrder, new Map(), 'smaland') === true, 'both printers have work in the mixed order');
  const legacyLive = { shopId: 'shopA', items: [{ sku: 'TEE', name: 'T', quantity: 1 }] };
  const liveMappings = mappings([mapRow('TEE', 'front', 'a1', 'tee')]);
  ok(orderHasVisiblePodLine(legacyLive, liveMappings, 'kim') === true
    && orderHasVisiblePodLine(legacyLive, liveMappings, 'smaland') === true
    && orderHasPodLine(legacyLive, liveMappings) === true,
    'a legacy order with no snapshot stays visible to every assigned printer (unchanged)');

  console.log('\n=== toQueueRow counts only the viewer\'s lines ===');
  ok(toQueueRow('o1', mixedOrder, 'Shop A', new Map(), 'kim').podLineCount === 3, 'Kims row says 3 lines');
  ok(toQueueRow('o1', mixedOrder, 'Shop A', new Map(), 'smaland').podLineCount === 2, 'Smålands row says 2 lines');
  ok(toQueueRow('o1', mixedOrder, 'Shop A', new Map()).podLineCount === 4,
    'with no viewer uid the row keeps the whole-order count (shop-level view)');

  console.log('\n=== toPrintJob returns only the viewer\'s lines ===');
  const kimJob = await toPrintJob('o1', mixedOrder, 'Shop A', new Map(), 'kim');
  const smalandJob = await toPrintJob('o1', mixedOrder, 'Shop A', new Map(), 'smaland');
  ok(kimJob.lines.length === 3 && smalandJob.lines.length === 2, 'each printer gets its own line list');
  ok(kimJob.lines.every((l) => l.sku !== 'CAP'), 'Kims production view contains no cap line');
  ok(smalandJob.lines.every((l) => l.printerUid !== 'kim'), 'Smålands production view contains none of Kims lines');
  ok(kimJob.lines[0].printerUid === 'kim', 'the frozen printerUid is echoed onto the production line');
  const strangerJob = await toPrintJob('o1', kimOnly, 'Shop A', new Map(), 'smaland');
  ok(strangerJob.lines.length === 0,
    'a printer with no lines in the order gets an EMPTY view — getPrintJob turns this into permission-denied');
  ok(!!strangerJob.shipTo || strangerJob.deliveryMethod === 'pickup',
    '(and that is why the callable denies instead: the envelope alone still carries ship-to)');

  console.log('\n=== the artwork library drops only what is ANOTHER printer\'s ===');
  const orders = [mixedOrder];
  const kimDrops = excludedArtworkIds(orders, 'kim');
  const smalandDrops = excludedArtworkIds(orders, 'smaland');
  ok(kimDrops.has('a3'), 'Kim loses Smålands cap artwork');
  ok(!kimDrops.has('a1') && !kimDrops.has('a2'), 'Kim keeps her own tee artworks');
  ok(smalandDrops.has('a1') && smalandDrops.has('a2') && !smalandDrops.has('a3'),
    'Småland loses Kims tee artworks and keeps its own');
  ok(!kimDrops.has('a9') && !smalandDrops.has('a9'),
    'an UNROUTED line\'s artwork stays available to both');
  ok(!kimDrops.has('brand-new') && !smalandDrops.has('brand-new'),
    'an artwork on NO order at all is never excluded — vetting fresh uploads is what the library is for');
  const bothPrint = frozenOrder({
    version: 1, createdAt: new Date(),
    lines: [{ ...mixed.lines[0], artworkId: 'shared' }, { ...mixed.lines[2], artworkId: 'shared' }],
  });
  ok(!excludedArtworkIds([bothPrint], 'kim')?.has('shared'),
    'an artwork BOTH printers have a line for is excluded from neither');
  ok(excludedArtworkIds([frozenOrder({ version: 1, createdAt: new Date(), lines: [mixed.lines[3]] })], 'kim') === null,
    'a shop where nothing is routed excludes nothing (null) — the library stays shop-scoped, as before');
  ok(excludedArtworkIds([{ shopId: 'shopA', items: [] }], 'kim') === null,
    'orders with no snapshots exclude nothing either');

  console.log(`\n=== print-line-visibility: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
