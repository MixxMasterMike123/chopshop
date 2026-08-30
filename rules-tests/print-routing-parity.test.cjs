/**
 * Slice 3 — the print-routing resolver exists TWICE and must never disagree.
 *
 * src/wagons/pod-wagon/printRouting.js  (client: the studio's cost + floor)
 * functions/src/print/printRouting.ts   (server: the payment-time snapshot)
 *
 * They are logic twins rather than one shared module because functions/
 * tsconfig.json pins `rootDir: "src"` — the Cloud Functions build cannot compile
 * a file from the app's src/, and there is no bundler step (the same reason
 * migrationShared.ts is a byte-identical extraction). So this suite runs ONE
 * fixture table through BOTH and fails on any divergence: if a seller is shown a
 * floor computed from printer A's tier, the order must not later be frozen
 * against printer B's.
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
const KIM = {
  garments: ['tee', 'hoodie'],
  pricing: { blankCostSek: { tee: 60, hoodie: 380 }, printCostSek: { front: 40, back: 40, pocket: 20 } },
};
const SMALAND = {
  garments: ['cap'],
  pricing: { blankCostSek: { cap: 50 }, printCostSek: { front: 35 } },
};
const PRINTERS = { kim: KIM, smaland: SMALAND };
// Legacy template prices, deliberately different from Kim's so a wrong basis shows.
const LEGACY_TEE = { blankCostSek: 70, printCostSek: { front: 45, back: 45 } };
const LEGACY_FLAT = { costSek: 149 };  // the deprecated flat field on stale cached docs

const R_KIM_TEE = { byGarment: { tee: 'kim' }, defaultPrinterUid: 'smaland' };
const R_STALE = { byGarment: { hoodie: 'smaland' }, defaultPrinterUid: 'kim' };
const R_DEFAULT_ONLY = { byGarment: {}, defaultPrinterUid: 'smaland' };
const R_EMPTY = {};

// Each row: [name, garment, slots, routing, printersById, template]
const TABLE = [
  ['explicit route',                 'tee',   ['front'],          R_KIM_TEE,      PRINTERS, LEGACY_TEE],
  ['explicit route, front+back',     'tee',   ['front', 'back'],  R_KIM_TEE,      PRINTERS, LEGACY_TEE],
  ['explicit route, no slots',       'tee',   [],                 R_KIM_TEE,      PRINTERS, LEGACY_TEE],
  ['stale route → default printer',  'hoodie',['front'],          R_STALE,        PRINTERS, LEGACY_TEE],
  ['route to deleted printer',       'tee',   ['front'],          { byGarment: { tee: 'gone' }, defaultPrinterUid: 'kim' }, PRINTERS, LEGACY_TEE],
  ['route to DEACTIVATED printer',   'tee',   ['front'],          R_KIM_TEE, { ...PRINTERS, kim: { ...KIM, active: false } }, LEGACY_TEE],
  ['default is DEACTIVATED',         'tee',   ['front'],          R_DEFAULT_ONLY, { ...PRINTERS, smaland: { ...SMALAND, active: false } }, LEGACY_TEE],
  ['default lacks the blank price',  'tee',   ['front'],          R_DEFAULT_ONLY, PRINTERS, LEGACY_TEE],
  ['default prices it',              'cap',   ['front'],          R_DEFAULT_ONLY, PRINTERS, LEGACY_TEE],
  ['default, unpriced slot = 0 kr',  'cap',   ['front', 'back'],  R_DEFAULT_ONLY, PRINTERS, LEGACY_TEE],
  ['unknown garment → default',      'parasol', ['front'],        R_KIM_TEE,      PRINTERS, LEGACY_TEE],
  ['null garment → default',         null,    ['front'],          R_KIM_TEE,      PRINTERS, LEGACY_TEE],
  ['nothing routed → template',      'tee',   ['front'],          R_EMPTY,        {},       LEGACY_TEE],
  ['nothing routed → flat legacy',   'tee',   ['front'],          R_EMPTY,        {},       LEGACY_FLAT],
  ['nothing prices it at all',       'tee',   ['front'],          R_EMPTY,        {},       {}],
  ['no default, no route',           'tee',   ['front'],          { byGarment: {} }, PRINTERS, LEGACY_TEE],
  ['default without a tier doc',     'tee',   ['front'],          { byGarment: {}, defaultPrinterUid: 'gone' }, PRINTERS, LEGACY_TEE],
  ['null routing + null printers',   'tee',   ['front'],          null,           null,     LEGACY_TEE],
];

(async () => {
  const clientUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'wagons', 'pod-wagon', 'printRouting.js'));
  const client = await import(clientUrl.href);

  console.log('\n=== resolvePrinterUid: client and server pick the SAME printer ===');
  for (const [name, garment, , routing, printers] of TABLE) {
    const c = client.resolvePrinterUid(garment, routing, printers);
    const s = server.resolvePrinterUid(garment, routing, printers);
    ok(c === s, `${name}: ${JSON.stringify(c)} (both)`);
  }

  console.log('\n=== podCostForSlotsRouted: identical cost, source AND printerUid ===');
  for (const [name, garment, slots, routing, printers, template] of TABLE) {
    const args = { garment, slots, routing, printersById: printers, template };
    const c = client.podCostForSlotsRouted(args);
    const s = server.podCostForSlotsRouted(args);
    ok(JSON.stringify(c) === JSON.stringify(s), `${name}: ${JSON.stringify(c)} (both)`);
  }

  console.log('\n=== the numbers themselves (a matching pair of WRONG answers is still wrong) ===');
  const cost = (garment, slots, routing, printers, template) =>
    client.podCostForSlotsRouted({ garment, slots, routing, printersById: printers, template });
  ok(cost('tee', ['front'], R_KIM_TEE, PRINTERS, LEGACY_TEE).cost === 140,
    'tee + front on Kims tier = 60 + 40 + 40 kr uttag = 140 kr ex moms');
  ok(cost('tee', ['front'], R_KIM_TEE, PRINTERS, LEGACY_TEE).printerUid === 'kim',
    'the routed printer is stamped alongside the cost');
  ok(cost('tee', ['front', 'back'], R_KIM_TEE, PRINTERS, LEGACY_TEE).cost === 180,
    'front+back charges exactly one more print (180 kr)');
  ok(cost('tee', ['front'], R_EMPTY, {}, LEGACY_TEE).cost === 155 &&
     cost('tee', ['front'], R_EMPTY, {}, LEGACY_TEE).source === 'template',
    'unconfigured routing keeps the legacy template price (70 + 45 + 40 = 155)');
  ok(cost('tee', ['front'], R_EMPTY, {}, LEGACY_TEE).printerUid === null,
    'the template fallback stamps NO printer — nobody stands behind that price');
  ok(server.PLATFORM_CUT_SEK === 40, 'the server twin carries the same 40 kr ex-moms platform cut');

  console.log(`\n${fail === 0 ? '✅' : '❌'} print-routing parity: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
