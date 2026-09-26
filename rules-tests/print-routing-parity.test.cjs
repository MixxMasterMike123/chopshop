/**
 * Slice 3 — the print-routing resolver exists TWICE and must never disagree.
 *
 * src/wagons/pod-wagon/printRouting.js  (client: the studio's routing + frames)
 * functions/src/print/printRouting.ts   (server: the payment-time snapshot)
 *
 * They are logic twins rather than one shared module because functions/
 * tsconfig.json pins `rootDir: "src"` — the Cloud Functions build cannot compile
 * a file from the app's src/, and there is no bundler step (the same reason
 * migrationShared.ts is a byte-identical extraction). So this suite runs ONE
 * fixture table through BOTH and fails on any divergence: if the studio routes a
 * design to printer A, the order must not later be frozen against printer B.
 *
 * COST is no longer twinned (A13, "seller sees ONE number"): the client has no
 * cost code at all and the studio asks the quotePodCost callable. The cost
 * fixtures that used to live here moved to one-number-pure.test.cjs, which
 * runs them against the server alone (plus a grep guard that keeps tier-price
 * code out of the client module).
 *
 * The ESM client module is loaded with createRequire → dynamic import (this file
 * is .cjs, matching the rules-tests convention); the server twin is required
 * from functions/lib, so `npm --prefix functions run build` must have run.
 */
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const requireFromHere = createRequire(__filename);
const server = requireFromHere('../functions/lib/print/printRouting.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

// ── Fixtures ────────────────────────────────────────────────────────────────
// printersPublic-shaped (capability only) — routing never looks at prices.
const KIM = { garments: ['tee', 'hoodie'] };
const SMALAND = { garments: ['cap'] };
const PRINTERS = { kim: KIM, smaland: SMALAND };

const R_KIM_TEE = { byGarment: { tee: 'kim' }, defaultPrinterUid: 'smaland' };
const R_STALE = { byGarment: { hoodie: 'smaland' }, defaultPrinterUid: 'kim' };
const R_DEFAULT_ONLY = { byGarment: {}, defaultPrinterUid: 'smaland' };
const R_EMPTY = {};

// Each row: [name, garment, routing, printersById]
const TABLE = [
  ['explicit route',                 'tee',     R_KIM_TEE,      PRINTERS],
  ['stale route → default printer',  'hoodie',  R_STALE,        PRINTERS],
  ['route to deleted printer',       'tee',     { byGarment: { tee: 'gone' }, defaultPrinterUid: 'kim' }, PRINTERS],
  ['route to DEACTIVATED printer',   'tee',     R_KIM_TEE, { ...PRINTERS, kim: { ...KIM, active: false } }],
  ['default is DEACTIVATED',         'tee',     R_DEFAULT_ONLY, { ...PRINTERS, smaland: { ...SMALAND, active: false } }],
  // SnapWear A4: the default must LIST the garment too (Småland only makes caps).
  ['default does not make the garment', 'tee',  R_DEFAULT_ONLY, PRINTERS],
  ['default makes it',               'cap',     R_DEFAULT_ONLY, PRINTERS],
  ['unknown garment → nobody',       'parasol', R_KIM_TEE,      PRINTERS],
  ['null garment → nobody',          null,      R_KIM_TEE,      PRINTERS],
  ['blank garment → nobody',         '   ',     R_KIM_TEE,      PRINTERS],
  ['default makes it (no route)',    'hoodie',  { byGarment: {}, defaultPrinterUid: 'kim' }, PRINTERS],
  ['nothing routed',                 'tee',     R_EMPTY,        {}],
  ['no default, no route',           'tee',     { byGarment: {} }, PRINTERS],
  ['default without a doc',          'tee',     { byGarment: {}, defaultPrinterUid: 'gone' }, PRINTERS],
  ['null routing + null printers',   'tee',     null,           null],
];

(async () => {
  const clientUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'wagons', 'pod-wagon', 'printRouting.js'));
  const client = await import(clientUrl.href);

  console.log('\n=== resolvePrinterUid: client and server pick the SAME printer ===');
  for (const [name, garment, routing, printers] of TABLE) {
    const c = client.resolvePrinterUid(garment, routing, printers);
    const s = server.resolvePrinterUid(garment, routing, printers);
    ok(c === s, `${name}: ${JSON.stringify(c)} (both)`);
  }

  console.log('\n=== SnapWear A4: the default printer must MAKE the garment (bypass closed) ===');
  ok(client.resolvePrinterUid('tee', R_DEFAULT_ONLY, PRINTERS) === null,
    'a tee is NOT routed to a caps-only default — nobody makes it → null (checkout 409s)');
  ok(client.resolvePrinterUid('parasol', R_KIM_TEE, PRINTERS) === null &&
     client.resolvePrinterUid(null, R_KIM_TEE, PRINTERS) === null,
    'an unknown or missing garment routes to nobody (fail closed, no guessing)');
  ok(client.resolvePrinterUid('cap', R_DEFAULT_ONLY, PRINTERS) === 'smaland',
    'the default still takes the garments it DOES make');

  console.log('\n=== A13: the client twin has NO cost code (server-only) ===');
  ok(!('tierCostForSlots' in client) && !('podCostForSlotsRouted' in client),
    'client exports no tier-cost function (cost comes from quotePodCost)');
  ok(typeof server.quoteRoutedCost === 'function' && typeof server.tierCostForSlots === 'function',
    'the server keeps the cost functions (quotePodCost + payment-time stamping)');

  console.log('\n=== isSlotPrintable: client and server agree on print capability ===');
  const SNAP = {
    garments: ['tee', 'hoodie', 'cap'],
    printAreasMm: {
      tee: { front: { w: 390, h: 490, offsetTopMm: 30 }, back: { w: 390, h: 490 }, pocket: { w: 100, h: 100 } },
      hoodie: { front: { w: 390, h: 280 } },            // no pocket key → rides on front
      cap: { front: { w: 70, h: 50 } },
      broken: { front: { w: 0, h: 50 }, back: { w: '390', h: 490 } }, // unusable frames
      bare: {}, // offered, every frame cleared (PrinterRow keeps the key — F3)
    },
  };
  const SLOT_TABLE = [
    // [name, tier, garment, slot, expected]
    ['tee front has a frame',           SNAP, 'tee', 'front', true],
    ['tee back has a frame',            SNAP, 'tee', 'back', true],
    ['tee pocket has its own frame',    SNAP, 'tee', 'pocket', true],
    ['tee sleeve has NO frame',         SNAP, 'tee', 'left_sleeve', false],
    ['tee right sleeve has NO frame',   SNAP, 'tee', 'right_sleeve', false],
    ['hoodie pocket rides on front',    SNAP, 'hoodie', 'pocket', true],
    ['hoodie back absent → no',         SNAP, 'hoodie', 'back', false],
    ['cap back absent → no',            SNAP, 'cap', 'back', false],
    ["'other' is never gated",          SNAP, 'tee', 'other', true],
    ['garment without frames → open',   SNAP, 'bag', 'left_sleeve', true],
    ['tier without printAreasMm → open', KIM, 'tee', 'left_sleeve', true],
    ['null tier → open',                null, 'tee', 'back', true],
    ['null garment → open',             SNAP, null, 'left_sleeve', true],
    ['zero-width frame is no frame',    SNAP, 'broken', 'front', false],
    ['string mm is no frame',           SNAP, 'broken', 'back', false],
    ['pocket via an unusable front',    SNAP, 'broken', 'pocket', false],
    // F3 (CODEX audit 2026-09-26): an EXPLICIT empty map is "printable
    // nowhere", not "no capability data" — the two must never be conflated.
    ['explicit {} → front gated',       SNAP, 'bare', 'front', false],
    ['explicit {} → sleeve gated',      SNAP, 'bare', 'left_sleeve', false],
    ['explicit {} → pocket gated',      SNAP, 'bare', 'pocket', false],
    ["explicit {} → 'other' still open", SNAP, 'bare', 'other', true],
  ];
  for (const [name, tier, garment, slot, expected] of SLOT_TABLE) {
    const c = client.isSlotPrintable(tier, garment, slot);
    const s = server.isSlotPrintable(tier, garment, slot);
    ok(c === s && c === expected, `${name}: ${c} (client) / ${s} (server), expected ${expected}`);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} print-routing parity: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
