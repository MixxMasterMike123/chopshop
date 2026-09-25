/**
 * A13 — "seller sees ONE number" (Mikael 2026-09-25): the PURE half.
 *
 * The rule: everything money-related a seller can read — in the UI OR straight
 * from Firestore — is ONE baked number (Inköp per product, one Avgift per
 * order). Firestore rules cannot hide fields, so the guarantees live in code
 * that decides WHAT is written where. This suite pins that code (no emulator;
 * needs `npm --prefix functions run build`):
 *
 *  1. projectPrinterPublic — the seller-readable printer mirror carries no
 *     money key at ANY depth, even when the source tier is stuffed with them.
 *  2. quoteRoutedCost — the server's one number (moved here from the parity
 *     suite: the client no longer has a cost twin), and it EQUALS the
 *     itemCostSek the payment-time snapshot freezes.
 *  3. stripSnapshotMoney / splitConnect / orderCarriesMoney — what reaches the
 *     order doc (open get) vs the server-only orderProduction doc.
 *  4. parseQuoteInput — the callable's payload gate.
 *  5. GREP GUARDS — the client modules contain no tier-price code, and the
 *     template seed writes no price field.
 * The rules half (who may read printers / printersPublic / orderProduction)
 * is rules-tests/one-number.test.cjs against the emulator.
 */
const fs = require('node:fs');
const path = require('node:path');
const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-rules-test' });

const { projectPrinterPublic } = require('../functions/lib/print/projectPrinterPublic.js');
const routing = require('../functions/lib/print/printRouting.js');
const { buildProductionSnapshot } = require('../functions/lib/print/printProjection.js');
const {
  stripSnapshotMoney, splitConnect, orderCarriesMoney, findMoneyKeys, ORDER_MONEY_DENYLIST,
} = require('../functions/lib/payment/orderMoney.js');
const { parseQuoteInput } = require('../functions/lib/pod/quoteInput.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

// The plan's printer denylist (§1) — a superset lives in ORDER_MONEY_DENYLIST.
const PRINTER_DENYLIST = ['pricing', 'blankCostSek', 'printCostSek', 'shippingSek', 'catalog', 'pricingBasis'];

// Kim's real tier (2026-08-10, ex moms) + SnapWear-style extras.
const KIM = {
  name: 'Kim Tryck', type: 'user', active: true,
  garments: ['tee', 'hoodie'],
  pricing: { blankCostSek: { tee: 60, hoodie: 380 }, printCostSek: { front: 40, back: 40, pocket: 20 } },
  shippingSek: 49,
  catalog: 'printerCatalog/kim',
  // A careless editor could nest money anywhere — the projection rebuilds
  // frames key by key, so none of it may survive.
  printAreasMm: { tee: { front: { w: 390, h: 490, offsetTopMm: 30, printCostSek: 40 }, back: { w: 390, h: 490 } } },
  provisionalAreas: ['hoodie'],
  pricingBasis: { eurSek: 11.2 },
  updatedAt: 'ts',
};
const SMALAND = { active: true, garments: ['cap'], pricing: { blankCostSek: { cap: 50 }, printCostSek: { front: 35 } } };
const PRINTERS = { kim: KIM, smaland: SMALAND };
const R = { byGarment: { tee: 'kim', hoodie: 'kim' }, defaultPrinterUid: 'smaland' };

(async () => {
  // ── 1. printersPublic projection ──────────────────────────────────────────
  console.log('\n=== projectPrinterPublic: capability only, no money at any depth ===');
  const pub = projectPrinterPublic(KIM);
  ok(findMoneyKeys(pub, PRINTER_DENYLIST).length === 0,
    `no denylisted key anywhere (found: ${JSON.stringify(findMoneyKeys(pub, PRINTER_DENYLIST))})`);
  ok(findMoneyKeys(pub).length === 0, 'no key from the full ORDER_MONEY_DENYLIST either');
  ok(JSON.stringify(Object.keys(pub).sort()) ===
     JSON.stringify(['active', 'garments', 'name', 'printAreasMm', 'provisionalAreas', 'type', 'updatedAt']),
    `exactly the allowlisted keys: ${Object.keys(pub).sort().join(', ')}`);
  ok(pub.printAreasMm.tee.front.w === 390 && pub.printAreasMm.tee.front.offsetTopMm === 30 &&
     !('printCostSek' in pub.printAreasMm.tee.front), 'frames kept (w/h/offsetTopMm), a nested price dropped');
  ok(pub.garments.join() === 'tee,hoodie' && pub.provisionalAreas.join() === 'hoodie', 'garments + provisional kept');
  ok(projectPrinterPublic({ garments: ['tee'] }).active === true, 'absent active → true (the resolver rule)');
  ok(projectPrinterPublic({ active: false }).active === false, 'active:false is kept (un-routes the printer)');
  ok(projectPrinterPublic(null) === null, 'missing source → null (the trigger deletes the mirror)');
  // The mirror must route exactly like the tier did — capability is intact.
  const pubById = { kim: projectPrinterPublic(KIM), smaland: projectPrinterPublic(SMALAND) };
  ok(['tee', 'hoodie', 'cap', 'parasol'].every((g) =>
    routing.resolvePrinterUid(g, R, pubById) === routing.resolvePrinterUid(g, R, PRINTERS)),
  'resolvePrinterUid on the mirror == on the tiers (studio and checkout route alike)');

  // ── 2. The ONE number ─────────────────────────────────────────────────────
  console.log('\n=== quoteRoutedCost: the server\'s one number (was the parity cost block) ===');
  const q = (garment, slots, r = R, p = PRINTERS) => routing.quoteRoutedCost({ garment, slots, routing: r, printersById: p });
  ok(routing.PLATFORM_CUT_SEK === 40, 'platform cut 40 kr ex moms (50 inkl), server-only');
  ok(JSON.stringify(q('tee', ['front'])) === JSON.stringify({ costSek: 140, printerUid: 'kim' }),
    'tee + front on Kim = 60 + 40 + 40 cut = 140, printer kim');
  ok(q('tee', ['front', 'back']).costSek === 180, 'front+back costs exactly one more print (180)');
  ok(q('tee', []).costSek === 100, 'no slots → blank + cut (100)');
  ok(q('cap', ['front', 'back']).costSek === 125, 'unpriced slot counts 0, not null (50 + 35 + 0 + 40)');
  ok(JSON.stringify(q('tee', ['front'], { byGarment: {}, defaultPrinterUid: 'smaland' })) ===
     JSON.stringify({ costSek: null, printerUid: null }), 'default that does not make the garment → null');
  ok(q('tee', ['front'], {}, {}).costSek === null, 'nothing routed → null (no template fallback any more)');
  ok(q('tee', ['front'], R, { ...PRINTERS, kim: { ...KIM, pricing: {} } }).costSek === null,
    'routed printer without a blank price → null, printerUid null');
  ok(q(null, ['front']).costSek === null, 'no garment → null');

  console.log('\n=== quote == the itemCostSek frozen at payment ===');
  const artOk = (id) => ({
    shopId: 'shopA', status: 'ready', printStoragePath: `pod-artwork/shopA/print/${id}.png`,
    purpose: 'apparel_dtg', validation: { gate: 'PASS', tier: 'PASS' },
  });
  const fakeDb = { collection: () => ({ doc: (id) => ({ get: async () => ({ exists: true, data: () => artOk(id) }) }) }) };
  const mapRow = (slot, artworkId) => ({ id: `m-${slot}`, sku: 'TEE', placementSlot: slot, placement: '', profileId: 'apparel_dtg', artworkId, garment: 'tee' });
  const snap = await buildProductionSnapshot(
    { shopId: 'shopA', items: [{ sku: 'TEE', name: 'T-shirt', quantity: 2, isPodProduct: true }] },
    new Map([['TEE', [mapRow('front', 'a1'), mapRow('back', 'a2')]]]),
    fakeDb,
    { routing: R, printersById: PRINTERS }
  );
  ok(snap.lines[0].itemCostSek === q('tee', ['front', 'back']).costSek,
    `stamped itemCostSek ${snap.lines[0].itemCostSek} == quoted ${q('tee', ['front', 'back']).costSek} (Inköp and withheld agree)`);

  // ── 3. What reaches the order doc ─────────────────────────────────────────
  console.log('\n=== stripSnapshotMoney: routing stays, money goes ===');
  const before = JSON.stringify(snap);
  const stripped = stripSnapshotMoney(snap);
  ok(findMoneyKeys(stripped).length === 0, `stripped snapshot has no money key (found: ${JSON.stringify(findMoneyKeys(stripped))})`);
  ok(stripped.lines.every((l) => l.printerUid === 'kim' && l.garment === 'tee' && l.printStoragePath),
    'printerUid / garment / print path kept (the portal + gates run on them)');
  ok(stripped.version === snap.version && stripped.lines.length === snap.lines.length, 'version + line count kept');
  ok(JSON.stringify(snap) === before && snap.lines[0].itemCostSek === 180,
    'the input is NOT mutated (the full copy goes to orderProduction in the same batch)');
  ok(stripSnapshotMoney(null) === null && stripSnapshotMoney({ version: 1 }).version === 1, 'non-snapshot input passes through');

  console.log('\n=== splitConnect: ONE fee on the order, the breakdown private ===');
  const connect = {
    isDestinationCharge: true, connectedAccountId: 'acct_X', applicationFeeAmount: 31042,
    applicationFeeId: 'fee_1', transferId: 'tr_1', commissionBps: 800,
    productionWithheldOre: 28250, productionVatRate: 0.25, transferReversed: false,
    somethingNew: { commissionBps: 1 },
  };
  const split = splitConnect(connect);
  ok(findMoneyKeys(split.onOrder).length === 0, `on-order connect has no money key (found: ${JSON.stringify(findMoneyKeys(split.onOrder))})`);
  ok(split.onOrder.applicationFeeAmount === 31042 && split.onOrder.transferId === 'tr_1' &&
     split.onOrder.isDestinationCharge === true && split.onOrder.transferReversed === false,
    'on-order keeps the ONE fee + the reconciliation ids');
  ok(!('somethingNew' in split.onOrder), 'an unlisted key does NOT reach the order (allowlist)');
  ok(JSON.stringify(split.private) === JSON.stringify({ commissionBps: 800, productionWithheldOre: 28250, productionVatRate: 0.25 }),
    'private = commissionBps + productionWithheldOre + productionVatRate');
  const legacy = splitConnect({ isDestinationCharge: true, connectedAccountId: 'a', applicationFeeAmount: 625, commissionBps: 500 });
  ok(Object.values(legacy.onOrder).every((v) => v !== undefined) && !('productionWithheldOre' in legacy.private),
    'absent keys stay absent (never undefined for Firestore)');
  ok(JSON.stringify(splitConnect(null)) === JSON.stringify({ onOrder: {}, private: {} }), 'null connect → empty halves');

  console.log('\n=== orderCarriesMoney: the migration selector ===');
  ok(orderCarriesMoney({ productionSnapshot: snap }) === true, 'a full snapshot carries money');
  ok(orderCarriesMoney({ productionSnapshot: stripped }) === false, 'a stripped snapshot does not');
  ok(orderCarriesMoney({ connect }) === true, 'a connect with the breakdown carries money');
  ok(orderCarriesMoney({ connect: split.onOrder, productionSnapshot: stripped }) === false, 'a migrated order does not');
  ok(orderCarriesMoney({}) === false, 'a plain order does not');

  // ── 4. The callable's payload gate ────────────────────────────────────────
  console.log('\n=== parseQuoteInput ===');
  const okIn = parseQuoteInput({ shopId: ' s1 ', garment: 'tee', slots: ['back', 'front', 'front'] });
  ok(typeof okIn === 'object' && okIn.shopId === 's1' && okIn.slots.join() === 'back,front', 'trims, dedupes slots');
  ok(typeof parseQuoteInput({ garment: 'tee', slots: [] }) === 'string', 'missing shopId → error');
  ok(typeof parseQuoteInput({ shopId: 's', garment: '', slots: [] }) === 'string', 'empty garment → error');
  ok(typeof parseQuoteInput({ shopId: 's', garment: 'tee', slots: ['front', 'sleeve'] }) === 'string', 'unknown slot → error');
  ok(typeof parseQuoteInput({ shopId: 's', garment: 'tee', slots: new Array(7).fill('front') }) === 'string', '> 6 slots → error');
  ok(typeof parseQuoteInput({ shopId: 's', garment: 'tee', slots: 'front' }) === 'string', 'slots not an array → error');
  ok(typeof parseQuoteInput(null) === 'string', 'null payload → error');

  // ── 5. Grep guards ────────────────────────────────────────────────────────
  console.log('\n=== grep guards: no tier-price code in the client ===');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const TIER_WORDS = /blankCostSek|printCostSek|shippingSek|pricing/;
  for (const rel of ['src/wagons/pod-wagon/printRouting.js', 'src/config/printRouting.js', 'src/config/podCostQuote.js']) {
    const m = read(rel).match(TIER_WORDS);
    ok(!m, `${rel} mentions none of blankCostSek|printCostSek|shippingSek|pricing${m ? ` (found "${m[0]}")` : ''}`);
  }
  const panel = read('src/wagons/pod-wagon/studio/PublishPanel.jsx');
  // ("pricing" alone is too generic here — the panel IS the pricing step.)
  ok(!/from '\.\.\/printRouting'/.test(panel) && !/blankCostSek|printCostSek|shippingSek/.test(panel),
    'PublishPanel does not import printRouting and names no tier price');
  const studio = read('src/wagons/pod-wagon/studio/DesignStudio.jsx');
  ok(!/podCostForSlotsRouted|tierCostForSlots|podCostForSlots\b/.test(studio),
    'DesignStudio has no client-side cost computation');
  const pricing = read('src/wagons/pod-wagon/podPricing.js');
  ok(!/export const (PLATFORM_CUT_SEK|podCostForSlots)\b/.test(pricing),
    'podPricing.js exports neither the platform cut nor a template cost');
  const seed = read('scripts/seed-pod-mockup-templates.cjs');
  ok(!/\b(blankCostSek|printCostSek|costSek)\s*:/.test(seed),
    'the template seed writes no price field (settings/podMockupTemplates is seller-readable)');
  // The platform printer editor ships in the PUBLIC bundle: it must hold no
  // built-in price list (the old DEFAULT_TIER / "Fyll i standardprislista"
  // carried a supplier's real prices to every browser). Any object literal
  // assigning a number to a garment or slot key is a hard-coded price.
  const PRICE_LITERAL = /\b(tee|longsleeve|hoodie|sweatshirt|bag|cap|beanie|flatcap|front|back|pocket|left_sleeve|right_sleeve)\s*:\s*-?\d/;
  for (const rel of ['src/pages/platform/PlatformPrinters.jsx', 'src/components/platform/PrinterRow.jsx']) {
    const src = read(rel);
    const m = src.match(PRICE_LITERAL);
    ok(!m && !/DEFAULT_TIER|standardprislista/.test(src.replace(/\/\/.*$/gm, '')),
      `${rel} has no hard-coded price list${m ? ` (found "${m[0]}")` : ''}`);
  }
  const webhook = read('functions/src/payment/stripeWebhook.ts');
  ok(/connect: connectSplit\.onOrder/.test(webhook) && /stripSnapshotMoney\(productionSnapshot\)/.test(webhook) &&
     /collection\('orderProduction'\)/.test(webhook),
    'stripeWebhook writes the stripped snapshot + on-order connect, and the full one to orderProduction');
  ok(ORDER_MONEY_DENYLIST.includes('commissionBps') && ORDER_MONEY_DENYLIST.includes('itemCostSek'),
    'the shared denylist covers both the fee split and the line costs');

  console.log(`\n${fail === 0 ? '✅' : '❌'} one-number (pure): ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
