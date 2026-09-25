/**
 * SnapWear A1 — POD production-cost withholding in the Connect application fee.
 *
 * Pure (no emulator, no Stripe; needs `npm --prefix functions run build`).
 * Asserts the money path end to end on the compiled lib the handlers call:
 *
 *  1. STAMPING. buildProductionSnapshot freezes printerShippingSek (ex moms)
 *     ONCE per printer — on the first line routed to it — from
 *     printers/{uid}.shippingSek; null everywhere else.
 *  2. WITHHOLDING. computeProductionWithholding: Σ itemCostSek × qty (first
 *     line per item only) + one shipping per distinct printerUid, × 1.25,
 *     rounded to integer öre ONCE at the end. Unrouted lines withhold 0;
 *     routed-but-unpriced items are reported (the caller 409s).
 *  3. FEE. buildConnectChargeParams(pay, gross, bps, withheldOre): fee = pct +
 *     withheld, feeExceedsGross flags an under-floor price, and withheld = 0
 *     leaves the pre-A1 params + metadata byte-identical.
 *
 * RUN: node rules-tests/production-withholding.test.cjs
 */
const path = require('path');
const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-rules-test' });

const LIB = path.join(__dirname, '..', 'functions', 'lib');
const { computeProductionWithholding, DEFAULT_PRODUCTION_VAT_RATE } = require(path.join(LIB, 'payment', 'productionWithholding'));
const { buildConnectChargeParams } = require(path.join(LIB, 'payment', 'connectParams'));
const { buildProductionSnapshot } = require(path.join(LIB, 'print', 'printProjection'));

let pass = 0, fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

/** A frozen line as stampRouting leaves it (only the fields the fee reads matter). */
const line = (itemIndex, sku, quantity, printerUid, itemCostSek, printerShippingSek = null, slot = 'front') => ({
  itemIndex, sku, quantity, placementSlot: slot, printerUid, itemCostSek, printerShippingSek,
});
const CONNECT = { chargesEnabled: true, stripeAccountId: 'acct_SHOP', commissionBps: 800 };

(async () => {
  console.log('\n=== worked example (plan): 349 kr hoodie, 8%, cost 156, shipping 70 ===');
  {
    const snap = { lines: [line(0, 'HOOD', 1, 'snapwear', 156, 70)] };
    const w = computeProductionWithholding(snap);
    ok(DEFAULT_PRODUCTION_VAT_RATE === 0.25, 'default production moms = 25%');
    ok(w.withheldOre === 28250, `withheld = (156+70) × 1.25 × 100 = 28250 öre (got ${w.withheldOre})`);
    ok(eq(w.perPrinter, { snapwear: { itemsOre: 19500, shippingOre: 8750 } }), 'perPrinter split: items 19500 + shipping 8750');
    ok(w.unpricedRouted.length === 0, 'nothing unpriced');
    const b = buildConnectChargeParams(CONNECT, 34900, 500, w.withheldOre);
    ok(b.params.application_fee_amount === 31042, `fee = pct 2792 + withheld 28250 = 31042 (got ${b.params.application_fee_amount})`);
    ok(34900 - b.params.application_fee_amount === 3858, 'shop transfer = 3858 öre');
    ok(b.feeExceedsGross === false, 'fee within gross → not flagged');
    ok(b.meta.applicationFeeAmount === '31042', 'meta.applicationFeeAmount = TOTAL fee "31042"');
    ok(b.meta.commissionBps === '800', 'meta.commissionBps unchanged ("800")');
    ok(b.meta.productionWithheldOre === '28250', 'meta.productionWithheldOre = "28250"');
    ok(b.meta.productionVatRate === '0.25', 'meta.productionVatRate = "0.25"');
  }

  console.log('\n=== quantity multiplies the item cost (shipping does NOT) ===');
  {
    const w = computeProductionWithholding({ lines: [line(0, 'HOOD', 3, 'snapwear', 156, 70)] });
    ok(w.withheldOre === Math.round((156 * 3 + 70) * 1.25 * 100), `qty 3 → (468+70)×125 = 67250 (got ${w.withheldOre})`);
  }

  console.log('\n=== front+back item: cost on the FIRST line only, never double-counted ===');
  {
    const w = computeProductionWithholding({ lines: [
      line(0, 'TEE', 2, 'kim', 180, 50, 'front'),
      line(0, 'TEE', 2, 'kim', null, null, 'back'),
    ] });
    ok(w.withheldOre === Math.round((180 * 2 + 50) * 1.25 * 100), `two slots, one item → (360+50)×125 = 51250 (got ${w.withheldOre})`);
    ok(w.unpricedRouted.length === 0, "the item's 2nd line (itemCostSek null by design) is NOT flagged unpriced");
  }

  console.log('\n=== two printers: shipping counted ONCE per printer ===');
  {
    const w = computeProductionWithholding({ lines: [
      line(0, 'TEE', 1, 'kim', 140, 50),
      line(1, 'TEE2', 1, 'kim', 140, null), // same printer, 2nd item → no 2nd shipping
      line(2, 'CAP', 2, 'smaland', 125, 39),
    ] });
    const expected = Math.round((140 + 140 + 50 + 125 * 2 + 39) * 1.25 * 100);
    ok(w.withheldOre === expected, `kim (280+50) + smaland (250+39) → ${expected} (got ${w.withheldOre})`);
    ok(eq(Object.keys(w.perPrinter).sort(), ['kim', 'smaland']), 'perPrinter has both printers');
    ok(w.perPrinter.kim.shippingOre === 6250 && w.perPrinter.smaland.shippingOre === 4875, 'one shipping each: 6250 / 4875');
  }

  console.log('\n=== unrouted lines (pre-routing) withhold nothing ===');
  {
    const w = computeProductionWithholding({ lines: [line(0, 'OLD', 5, null, null), line(1, 'OLD2', 1, null, null)] });
    ok(w.withheldOre === 0 && eq(w.perPrinter, {}) && w.unpricedRouted.length === 0, 'printerUid null → 0, no printers, nothing flagged');
    ok(computeProductionWithholding(null).withheldOre === 0, 'null snapshot (pod-disabled shop) → 0');
    ok(computeProductionWithholding({ lines: [] }).withheldOre === 0, 'empty snapshot → 0');
  }

  console.log('\n=== routed but unpriced → detected (caller 409 routed-line-unpriced) ===');
  {
    const w = computeProductionWithholding({ lines: [
      line(0, 'TEE', 1, 'kim', 140, 50),
      line(1, 'MUG', 1, 'kim', null, null), // routed to Kim, whose tier has no mug price
    ] });
    ok(eq(w.unpricedRouted, ['MUG']), 'unpricedRouted = ["MUG"]');
  }

  console.log('\n=== rounding happens ONCE, at the end ===');
  {
    // 0.3 kr × 1.25 = 37.5 öre per item. Per-line rounding: 38 + 38 = 76.
    // End rounding: 0.6 × 125 = 75. The fee must use the end-rounded total.
    const w = computeProductionWithholding({ lines: [line(0, 'A', 1, 'p', 0.3), line(1, 'B', 1, 'p', 0.3)] });
    ok(w.withheldOre === 75, `Σ 0.6 kr × 1.25 → 75 öre, not per-line 76 (got ${w.withheldOre})`);
    ok(Number.isInteger(w.withheldOre), 'withheldOre is an integer');
  }

  console.log('\n=== fee > gross → flagged, never silently clamped into a charge ===');
  {
    const w = computeProductionWithholding({ lines: [line(0, 'HOOD', 1, 'snapwear', 156, 70)] });
    const b = buildConnectChargeParams(CONNECT, 29000, 500, w.withheldOre); // 290 kr < floor
    ok(b.feeExceedsGross === true, '2320 pct + 28250 withheld > 29000 → feeExceedsGross');
    ok(b.params.application_fee_amount <= 29000, 'params stay Stripe-valid (fee ≤ gross) — the caller blocks anyway');
    const exact = buildConnectChargeParams({ ...CONNECT, commissionBps: 0 }, 28250, 0, 28250);
    ok(exact.feeExceedsGross === false && exact.params.application_fee_amount === 28250, 'fee exactly = gross → allowed (shop gets 0, platform whole)');
  }

  console.log('\n=== withheld = 0 → legacy build byte-identical ===');
  {
    // The pre-A1 builder's exact output for this input (hand-frozen).
    const PRE_A1 = {
      params: { transfer_data: { destination: 'acct_SHOP' }, application_fee_amount: 2792 },
      meta: { connectedAccountId: 'acct_SHOP', applicationFeeAmount: '2792', commissionBps: '800' },
    };
    for (const b of [buildConnectChargeParams(CONNECT, 34900, 500), buildConnectChargeParams(CONNECT, 34900, 500, 0)]) {
      ok(eq(b.params, PRE_A1.params), 'params identical to pre-A1 (key order included)');
      ok(eq(b.meta, PRE_A1.meta), 'meta identical — NO production* keys when nothing is withheld');
      ok(b.feeExceedsGross === false, 'not flagged');
    }
    const legacy = buildConnectChargeParams({ chargesEnabled: false }, 34900, 500, 28250);
    ok(eq(legacy.params, {}) && eq(legacy.meta, {}) && legacy.useConnect === false,
      'non-Connect shop: still empty params/meta (caller 409s pod-requires-connect)');
  }

  console.log('\n=== stamping: printerShippingSek frozen once per printer ===');
  {
    const artOk = (id) => ({
      shopId: 'shopA', status: 'ready', printStoragePath: `pod-artwork/shopA/print/${id}.png`,
      fileName: `${id}.tiff`, purpose: 'apparel_dtg', validation: { gate: 'PASS', tier: 'PASS' },
    });
    const fakeDb = (artworks) => ({
      collection: () => ({ doc: (id) => ({ get: async () => ({ exists: !!artworks[id], data: () => artworks[id] }) }) }),
    });
    const mapRow = (sku, slot, artworkId, garment) => ({
      id: `map-${sku}-${slot}`, sku, placementSlot: slot, placement: '', profileId: 'apparel_dtg', artworkId, garment,
    });
    const mappings = new Map();
    [mapRow('TEE', 'front', 'a1', 'tee'), mapRow('TEE', 'back', 'a2', 'tee'),
      mapRow('HOOD', 'front', 'a3', 'hoodie'), mapRow('CAP', 'front', 'a4', 'cap')]
      .forEach((r) => mappings.set(r.sku, [...(mappings.get(r.sku) || []), r]));
    const ROUTING = {
      routing: { byGarment: { tee: 'kim', hoodie: 'kim', cap: 'smaland' }, defaultPrinterUid: null },
      printersById: {
        kim: { active: true, garments: ['tee', 'hoodie'], shippingSek: 50,
          pricing: { blankCostSek: { tee: 60, hoodie: 380 }, printCostSek: { front: 40, back: 40 } } },
        // No shippingSek on Småland → its stamp is null (withholds 0 shipping).
        smaland: { active: true, garments: ['cap'], pricing: { blankCostSek: { cap: 50 }, printCostSek: { front: 35 } } },
      },
    };
    const order = { shopId: 'shopA', items: [
      { sku: 'TEE', name: 'T', quantity: 2, isPodProduct: true },
      { sku: 'HOOD', name: 'H', quantity: 1, isPodProduct: true },
      { sku: 'CAP', name: 'C', quantity: 1, isPodProduct: true },
    ] };
    const snap = await buildProductionSnapshot(order, mappings,
      fakeDb({ a1: artOk('a1'), a2: artOk('a2'), a3: artOk('a3'), a4: artOk('a4') }), ROUTING);
    const ships = snap.lines.map((l) => [l.sku, l.placementSlot, l.printerUid, l.printerShippingSek]);
    ok(snap.version === 1, 'snapshot version stays 1 (additive field)');
    ok(snap.lines.every((l) => 'printerShippingSek' in l && l.printerShippingSek !== undefined), 'every line carries an explicit value (Firestore-safe, no undefined)');
    ok(eq(ships.filter((s) => s[2] === 'kim').map((s) => s[3]), [50, null, null]), "Kim's 50 kr stamped on its FIRST line only (tee front), null on tee back + hoodie");
    ok(eq(ships.filter((s) => s[2] === 'smaland').map((s) => s[3]), [null]), 'Småland has no shippingSek → null');
    // End to end: tee (60+40+40+40 cut)=180 ×2, hoodie (380+40+40)=460, cap (50+35+40)=125, + Kim shipping 50.
    const w = computeProductionWithholding(snap);
    const expected = Math.round((180 * 2 + 460 + 125 + 50) * 1.25 * 100);
    ok(w.withheldOre === expected, `frozen snapshot → withheld ${expected} öre (got ${w.withheldOre})`);
    ok(w.unpricedRouted.length === 0, 'every routed item priced');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
