/**
 * seed-snapwear-printer.cjs — seed SnapWear (Łódź) as the platform's API
 * printer: its tier doc printers/snapwear, the seller-readable price-free
 * mirror printersPublic/snapwear, its catalog printerCatalog/snapwear, and
 * (only with --route) the routing settings/printRouting.
 *
 * ⚠️ BUILD FIRST: `cd functions && npm run build` before running this. The
 * printersPublic mirror is produced by the COMPILED projection
 * (functions/lib/print/projectPrinterPublic.js) — the same code the
 * syncPrintersPublicOnWrite trigger runs, so there is ONE implementation. The
 * seed writes the mirror itself because it runs BEFORE the deploy (B9a), when
 * the trigger does not exist yet; once deployed, the trigger re-projects the
 * same doc on this write and converges to the identical result.
 *
 * TWO-STEP IMPORT (plan ~/.claude/plans/snapwear-printer-areas.md §1): there is
 * no xlsx parser in node_modules and no dependency may be added, so
 *   (a) scripts/snapwear-xlsx-to-json.py turns SnapWear's PrintArea.xlsx +
 *       SKU 21.09.xlsx into docs/SnapWearDocs/snapwear-catalog.json (checked in),
 *   (b) THIS script reads ONLY that JSON. Re-run (a) when SnapWear sends new
 *       sheets, then this.
 *
 * WHAT GETS WRITTEN
 *   printers/snapwear — { name, type:'api', active, garments[], pricing,
 *     shippingSek, printAreasMm, provisionalAreas[], catalog }. PLATFORM-only
 *     read (A13); still NO pricingBasis here — the supplier's raw basis stays
 *     on printerCatalog/* which not even the platform console reads.
 *   printersPublic/snapwear — projectPrinterPublic(printers/snapwear AS
 *     STORED after the write): name, type, active, garments, printAreasMm,
 *     provisionalAreas — NO prices. What sellers' studios read (A13).
 *     type:'api' = no users/ counterpart (no print-portal login); orders go out
 *     over SnapWear's API (A6). The routing resolver treats it like any tier.
 *   printerCatalog/snapwear — { models, skus, importedAt, source, pricingBasis }
 *     straight from the JSON: per-model print frames + per-SKU model/garment/
 *     colour/size, PLUS the EUR basis (list prices, rate, buffer) — kept here
 *     because this collection has no client rule (default deny), so the
 *     supplier's raw price never reaches a seller. The outbound submit (A6)
 *     maps our variant → SnapWear SKU by NUMBER from here.
 *   settings/printRouting — ONLY with --route: every SnapWear garment + the
 *     default → 'snapwear'. Separate flag because it changes who prints
 *     everything, not just what SnapWear offers.
 *
 * PRICING (all stored SEK EX MOMS, integer kronor — the POD money-path
 * convention). SnapWear's EUR price per garment INCLUDES the first print; each
 * extra print location is +€3.30. We split that into our tier's two axes:
 *     blankCostSek[g] = round((P_eur − 3.30) × rate × (1 + buffer))
 *     printCostSek    = round(3.30 × rate × (1 + buffer))  for front/back/pocket
 * so blank + one print reproduces SnapWear's own price and every extra print
 * adds one €3.30. The buffer (default 3 %) absorbs EUR/SEK drift between
 * re-seeds; the basis is stored on printerCatalog/snapwear.pricingBasis (NOT on
 * the seller-readable printer doc) for the next re-seed.
 *   ⚠️ KNOWN OVER-COUNT (deliberate, SAFE direction): front + pocket are both
 *   inside SnapWear's FRONT canvas → ONE print at SnapWear, but our tier charges
 *   two (≈ 37 kr ex moms too much withheld). Rare combo (the studio blocks
 *   bröst+ficka on the same garment today); over-withholding never fronts cost.
 *
 * PRINT AREAS (printAreasMm[garment][slot] = { w, h, offsetTopMm? } in mm):
 *   ABSENT slot = SnapWear cannot print it → the studio hides it and checkout
 *   refuses it (slot-not-printable). Sleeves: SnapWear prints no sleeves → no
 *   key. `pocket` is a position INSIDE the front canvas (placed 1:1 there), so
 *   a garment with `front` supports it; written explicitly anyway.
 *   Frames come from the catalog JSON per Kent's model; where SnapWear has not
 *   sent a frame yet (C1: 64400, SF500, W101, B445 patch, trucker panel) the
 *   nearest model / our spec stands in and the garment is listed in
 *   provisionalAreas (the platform editor shows a ⚠ chip on it).
 *
 * The DPI gate is UNCHANGED by any of this: artwork must still hold ≥300 DPI
 * at contain-fit in the podProfiles reference area (processArtwork.ts), and the
 * studio's per-artwork DPI clamp (placementMath maxWidthForDpiMm) stops a
 * low-res motif from growing into blur inside SnapWear's larger frames.
 *
 * Conventions mirror seed-pod-profiles.cjs:
 *   - DRY RUN by default — prints a diff summary against what is stored, exits.
 *   - `--commit` writes; refuses to overwrite an existing printers/snapwear
 *     without `--force` (the platform editor may have tuned it since).
 *   - `--eur-sek <rate>` is REQUIRED with --commit (no silent default rate).
 *   - `--buffer <fraction>` rate buffer, default 0.03.
 *   - `--route` also writes settings/printRouting.
 *
 * USAGE (run by Mikael — live data write, STOP-and-surface class):
 *   (cd functions && npm run build)                                     # REQUIRED first (projection)
 *   node scripts/seed-snapwear-printer.cjs                              # dry run
 *   node scripts/seed-snapwear-printer.cjs --eur-sek 11.20 --commit     # write tier + mirror + catalog
 *   node scripts/seed-snapwear-printer.cjs --eur-sek 11.20 --commit --force --route
 *
 * Requires Application Default Credentials (gcloud auth application-default
 * login) — same as the other admin scripts. NAMED database b8s-reseller-db.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const admin = functionsRequire('firebase-admin');
const { getFirestore } = functionsRequire('firebase-admin/firestore');
// ONE implementation of the seller-readable projection (see header): fail
// loudly if functions/lib has not been built rather than write a stale shape.
let projectPrinterPublic;
try {
  ({ projectPrinterPublic } = require(path.join(__dirname, '..', 'functions', 'lib', 'print', 'projectPrinterPublic.js')));
} catch (e) {
  console.error('❌ functions/lib/print/projectPrinterPublic.js not found — run `cd functions && npm run build` first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const FORCE = args.includes('--force');
const ROUTE = args.includes('--route');
const argValue = (name) => {
  const i = args.indexOf(name);
  if (i !== -1) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};

const PRINTER_UID = 'snapwear';
const CATALOG_PATH = path.join(__dirname, '..', 'docs', 'SnapWearDocs', 'snapwear-catalog.json');

// ── Rate + buffer ────────────────────────────────────────────────────────────
const rateArg = argValue('--eur-sek');
if (COMMIT && rateArg === undefined) {
  console.error('❌ --eur-sek <rate> is required with --commit (e.g. --eur-sek 11.20).');
  process.exit(1);
}
const EUR_SEK = rateArg === undefined ? 11.2 : Number(String(rateArg).replace(',', '.'));
const BUFFER = argValue('--buffer') === undefined ? 0.03 : Number(String(argValue('--buffer')).replace(',', '.'));
if (!(EUR_SEK > 5 && EUR_SEK < 20)) { console.error(`❌ implausible --eur-sek ${rateArg}`); process.exit(1); }
if (!(BUFFER >= 0 && BUFFER < 0.5)) { console.error(`❌ implausible --buffer ${BUFFER}`); process.exit(1); }
const FACTOR = EUR_SEK * (1 + BUFFER);

// SnapWear's per-garment EUR price INCLUDING the first print (Kent's picks,
// snapwear.pro 2026-09). Model per garment for provenance.
const EXTRA_PRINT_EUR = 3.3;
const BASE_EUR = {
  tee: { eur: 5.99, model: '64000' },
  longsleeve: { eur: 12.1, model: '64400' },
  sweatshirt: { eur: 11.9, model: '18000' },
  hoodie: { eur: 13.72, model: 'SF500' },
  cap: { eur: 5.52, model: 'TRUCKER' },
  beanie: { eur: 8.9, model: 'B445' },
  bag: { eur: 5.22, model: 'W101' },
};
// NOT flatcap: SnapWear has no flat cap in its catalog → not offerable.
const GARMENTS = ['tee', 'longsleeve', 'hoodie', 'sweatshirt', 'bag', 'cap', 'beanie'];

// ── Print areas ─────────────────────────────────────────────────────────────
// Which catalog model's frames stand for each garment. `provisional` = the real
// model's frame is missing from PrintArea.xlsx (C1) and a stand-in is used.
const POCKET = { w: 100, h: 100 };
const AREA_SOURCE = {
  tee: { model: '64000' },
  sweatshirt: { model: '18000' },
  // SF500 (Kent's hoodie) is missing; JH050 / 18500 share one hoodie frame
  // (front 390×280 — the kangaroo pocket caps the height — back 390×490).
  hoodie: { model: 'JH050', provisional: false },
  longsleeve: { model: '64000', provisional: true },  // 64400 frame missing (C1)
  bag: { model: 'STAU760', provisional: true },        // W101 missing — Stanley/Stella tote stands in
};
// No SnapWear frame at all yet → our own spec (POD_PRINT_SPEC §1) / their FAQ.
const FIXED_AREAS = {
  cap: { areas: { front: { w: 70, h: 50 } }, provisional: true },     // trucker panel unknown
  beanie: { areas: { front: { w: 100, h: 50 } }, provisional: true }, // B445 patch 10×5 cm (FAQ)
};

const frameOf = (f) => (f && f.w > 0 && f.h > 0
  ? { w: f.w, h: f.h, ...(Number.isFinite(f.offsetTopMm) ? { offsetTopMm: f.offsetTopMm } : {}) }
  : null);

function buildAreas(catalog) {
  const printAreasMm = {};
  const provisionalAreas = [];
  const problems = [];
  for (const g of GARMENTS) {
    if (FIXED_AREAS[g]) {
      printAreasMm[g] = FIXED_AREAS[g].areas;
      if (FIXED_AREAS[g].provisional) provisionalAreas.push(g);
      continue;
    }
    const src = AREA_SOURCE[g];
    const model = catalog.models[src.model];
    const front = frameOf(model && model.front);
    const back = frameOf(model && model.back);
    if (!front) { problems.push(`${g}: model ${src.model} has no front frame in the catalog`); continue; }
    printAreasMm[g] = { front, ...(back ? { back } : {}), pocket: { ...POCKET } };
    if (src.provisional) provisionalAreas.push(g);
  }
  return { printAreasMm, provisionalAreas, problems };
}

function buildPricing() {
  const blankCostSek = {};
  for (const g of GARMENTS) blankCostSek[g] = Math.round((BASE_EUR[g].eur - EXTRA_PRINT_EUR) * FACTOR);
  const print = Math.round(EXTRA_PRINT_EUR * FACTOR);
  return { blankCostSek, printCostSek: { front: print, back: print, pocket: print } };
}

// ── Diff helpers (dry-run summary) ───────────────────────────────────────────
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
function diffFields(current, next, keys) {
  return keys.map((k) => {
    const a = current ? current[k] : undefined;
    const b = next[k];
    if (a === undefined) return `  + ${k}`;
    return stable(a) === stable(b) ? `  = ${k} (unchanged)` : `  ~ ${k} (changes)`;
  });
}

async function readOrNull(ref, label) {
  try {
    const snap = await ref.get();
    return { exists: snap.exists, data: snap.exists ? snap.data() : null };
  } catch (e) {
    if (COMMIT) throw e;
    console.log(`   (could not read ${label}: ${e.message.split('\n')[0]} — diffing against empty)`);
    return { exists: false, data: null, unreadable: true };
  }
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const { printAreasMm, provisionalAreas, problems } = buildAreas(catalog);
  if (problems.length) {
    console.error('❌ Catalog is missing frames the seed depends on:');
    problems.forEach((p) => console.error('   ', p));
    process.exit(1);
  }
  const pricing = buildPricing();

  console.log('🌱 Seed SnapWear printer — printers/snapwear + printerCatalog/snapwear' + (ROUTE ? ' + settings/printRouting' : ''));
  console.log(`   mode:     ${COMMIT ? '🔴 COMMIT (will write)' : '🟡 DRY RUN (no write)'}${FORCE ? ' --force' : ''}`);
  console.log(`   rate:     1 EUR = ${EUR_SEK} SEK${rateArg === undefined ? ' (dry-run placeholder — pass --eur-sek)' : ''}, buffer ${(BUFFER * 100).toFixed(1)} % → ×${FACTOR.toFixed(4)}`);
  console.log(`   catalog:  ${path.relative(process.cwd(), CATALOG_PATH)} (generated ${catalog.generatedAt})`);
  console.log('');

  // ── Summary tables ──
  console.log('   Garment      Model     EUR    blank SEK  front  back   pocket  areas (mm)');
  for (const g of GARMENTS) {
    const a = printAreasMm[g];
    const fmt = (s) => (a[s] ? `${a[s].w}×${a[s].h}${a[s].offsetTopMm != null ? `@${a[s].offsetTopMm}` : ''}` : '—');
    console.log(
      `   ${g.padEnd(12)} ${BASE_EUR[g].model.padEnd(9)} ${BASE_EUR[g].eur.toFixed(2).padStart(5)}  ${String(pricing.blankCostSek[g]).padStart(9)}` +
      `  ${fmt('front').padEnd(10)} ${fmt('back').padEnd(10)} ${fmt('pocket').padEnd(8)}${provisionalAreas.includes(g) ? ' ⚠ provisional' : ''}`
    );
  }
  console.log(`   print price per extra location (front/back/pocket): ${pricing.printCostSek.front} kr ex moms`);
  console.log('   sleeves: not offered (no key) · flatcap: not in SnapWear catalog → not offered');
  const skuCount = Object.keys(catalog.skus).length;
  const byGarment = {};
  for (const s of Object.values(catalog.skus)) byGarment[s.garment || '—'] = (byGarment[s.garment || '—'] || 0) + 1;
  console.log(`   catalog: ${Object.keys(catalog.models).length} models, ${skuCount} SKUs ${JSON.stringify(byGarment)}`);
  const missing = Object.entries(catalog.models).filter(([, m]) => m.garment && m.framesMissing).map(([id]) => id);
  console.log(`   frames missing for Kent's models (C1): ${missing.join(', ') || 'none'}`);
  console.log('');

  const printerDoc = {
    name: 'Snapwear (Łódź)',
    type: 'api',
    active: true,
    garments: GARMENTS,
    pricing,
    // Placeholder until C8 (Natalia's SE shipping rate). 0 = nothing withheld
    // for shipping; the A1 withholding reads it off the frozen snapshot.
    shippingSek: 0,
    printAreasMm,
    provisionalAreas,
    catalog: 'printerCatalog/snapwear',
  };
  // ⚠️ pricingBasis (SnapWear's EUR list prices, the FX rate, the buffer) lives
  // on the CATALOG doc, never on printers/{uid}. printers/* is platform-only
  // since A13 (sellers read the price-free printersPublic mirror and get their
  // cost as one quoted number); printerCatalog/* has no client rule at all
  // (default deny; Admin SDK only) — "never show our hand", Mikael 2026-09-25.
  const catalogDoc = {
    models: catalog.models,
    skus: catalog.skus,
    source: { ...catalog.source, generatedAt: catalog.generatedAt, generator: catalog.generator },
    pricingBasis: {
      eurSek: EUR_SEK,
      buffer: BUFFER,
      extraPrintEur: EXTRA_PRINT_EUR,
      baseEur: Object.fromEntries(GARMENTS.map((g) => [g, BASE_EUR[g]])),
      source: 'snapwear.pro 2026-09 (Kent)',
    },
  };
  const routingDoc = {
    byGarment: Object.fromEntries(GARMENTS.map((g) => [g, PRINTER_UID])),
    defaultPrinterUid: PRINTER_UID,
  };

  admin.initializeApp(); // default credentials, like seed-pod-profiles.cjs
  const db = getFirestore('b8s-reseller-db'); // the CORRECT named database
  db.settings({ ignoreUndefinedProperties: true });

  const printerRef = db.collection('printers').doc(PRINTER_UID);
  const publicRef = db.collection('printersPublic').doc(PRINTER_UID);
  const catalogRef = db.collection('printerCatalog').doc(PRINTER_UID);
  const routingRef = db.collection('settings').doc('printRouting');
  const [printerNow, catalogNow, routingNow] = await Promise.all([
    readOrNull(printerRef, 'printers/snapwear'),
    readOrNull(catalogRef, 'printerCatalog/snapwear'),
    ROUTE ? readOrNull(routingRef, 'settings/printRouting') : Promise.resolve(null),
  ]);

  console.log(`📝 printers/${PRINTER_UID} ${printerNow.exists ? '(exists)' : '(new)'}:`);
  diffFields(printerNow.data, printerDoc, Object.keys(printerDoc)).forEach((l) => console.log(l));
  // Preview of the mirror from what the stored doc WILL be (mergeFields keeps
  // unlisted stored fields, so project the merge, not printerDoc alone).
  const publicPreview = projectPrinterPublic({ ...(printerNow.data || {}), ...printerDoc });
  console.log(`📝 printersPublic/${PRINTER_UID} (price-free mirror): ${Object.keys(publicPreview).join(', ')}`);
  console.log(`📝 printerCatalog/${PRINTER_UID} ${catalogNow.exists ? '(exists)' : '(new)'}:`);
  diffFields(catalogNow.data, catalogDoc, Object.keys(catalogDoc)).forEach((l) => console.log(l));
  if (ROUTE) {
    console.log(`📝 settings/printRouting ${routingNow.exists ? '(exists)' : '(new)'}:`);
    diffFields(routingNow.data, routingDoc, Object.keys(routingDoc)).forEach((l) => console.log(l));
    if (routingNow.data) {
      const before = routingNow.data.byGarment || {};
      const moved = Object.entries(routingDoc.byGarment).filter(([g, uid]) => before[g] !== uid).map(([g]) => g);
      console.log(`   garments changing printer: ${moved.join(', ') || 'none'}; default ${routingNow.data.defaultPrinterUid || '∅'} → ${PRINTER_UID}`);
      const dropped = Object.keys(before).filter((g) => !(g in routingDoc.byGarment));
      if (dropped.length) console.log(`   routes REMOVED (no SnapWear offer): ${dropped.join(', ')}`);
    }
  } else {
    console.log('   (settings/printRouting untouched — pass --route to route every SnapWear garment + the default here)');
  }
  console.log('');

  if (!COMMIT) {
    console.log('🟡 Dry run complete. Re-run with --eur-sek <rate> --commit to write.');
    return;
  }
  if (printerNow.exists && !FORCE) {
    console.log('✅ printers/snapwear already exists — nothing written.');
    console.log('   (Pass --force to overwrite; the platform editor may have tuned it since.)');
    return;
  }

  const stamp = admin.firestore.FieldValue.serverTimestamp();
  // mergeFields (not merge:true): the listed top-level fields are REPLACED
  // whole — a deep merge would keep a stale slot/garment key inside
  // printAreasMm or byGarment alive — while unlisted fields survive.
  const printerData = { ...printerDoc, updatedAt: stamp };
  await printerRef.set(printerData, { mergeFields: Object.keys(printerData) });
  // Project the doc AS STORED (after mergeFields + the resolved timestamp), so
  // the mirror equals what the trigger will compute from the same source.
  const stored = (await printerRef.get()).data();
  await publicRef.set(projectPrinterPublic(stored));
  const catalogData = { ...catalogDoc, importedAt: stamp };
  await catalogRef.set(catalogData);
  console.log(`🔴 Wrote printers/${PRINTER_UID} + printersPublic/${PRINTER_UID} + printerCatalog/${PRINTER_UID}.`);
  if (ROUTE) {
    const routingData = { ...routingDoc, updatedAt: stamp, updatedBy: 'seed-snapwear-printer' };
    await routingRef.set(routingData, { mergeFields: Object.keys(routingData) });
    console.log('🔴 Wrote settings/printRouting — every SnapWear garment + the default → snapwear.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  });
