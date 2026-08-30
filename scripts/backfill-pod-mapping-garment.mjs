/**
 * backfill-pod-mapping-garment.mjs — stamp `garment` on legacy podMappings docs,
 * ahead of multi-printer routing (plan: ~/.claude/plans/pod-multi-printer-routing.md,
 * Slice 1).
 *
 * WHAT `garment` IS: the print-ROUTING key on a mapping row — 'tee' | 'longsleeve'
 * | 'hoodie' | 'sweatshirt' | 'bag' | 'cap' | 'beanie' | 'flatcap'. A later slice
 * routes each production line to the printer that actually makes that garment.
 * The Design Studio now writes it on every mapping it creates
 * (src/config/podMockupTemplates.js garmentOfTemplate → utils/podMappings
 * setMapping). Rows written BEFORE that shipped have no field at all.
 *
 * ⚠️ WHAT THIS SCRIPT CAN AND CANNOT DERIVE — read before running:
 *
 *   A mapping does NOT record which mockup template produced it, and neither does
 *   the product: products carry only `isPodProduct` + `podCostSek` (no
 *   templateId / mockupTemplateId field exists anywhere on products — verified
 *   2026-08-30). The studio's mockup Storage paths do encode the template id
 *   (pod-artwork/{shopId}/mockups/{templateId}/…) but nothing links a product
 *   back to them, so they are not a usable join either.
 *
 *   The ONE reliable signal on a legacy row is `profileId` (settings/podProfiles),
 *   which is 1:1 with a garment for the non-apparel templates:
 *       bag_dtg → bag · cap_dtg → cap · beanie_dtg → beanie · flatcap_dtg → flatcap
 *   `apparel_dtg` is AMBIGUOUS — tee, longsleeve, hoodie and sweatshirt all use
 *   it — so apparel rows are left ALONE (no field written). null/absent means
 *   "unknown garment" and routes to the default printer, which is the correct,
 *   safe outcome; guessing 'tee' would silently route hoodies to the wrong
 *   printer at a wrong cost.
 *
 *   Consequence: expect most rows to come out UNKNOWN. That is not a failure.
 *   The real fix for those is the seller re-publishing from the studio (which
 *   rewrites the mapping with the right garment), or a manual per-shop review.
 *
 * SAFETY: DRY RUN by default — prints exactly what it would write and exits.
 * Pass `--apply` to write. Only ever ADDS the `garment` field via a dot-path
 * update; no other field is touched, and a row that already HAS `garment` is
 * never overwritten. After --apply it re-reads every touched doc and prints a
 * verification table.
 *
 * USAGE:
 *   node scripts/backfill-pod-mapping-garment.mjs              # dry run (default)
 *   node scripts/backfill-pod-mapping-garment.mjs --shop=xyz   # limit to one shop
 *   node scripts/backfill-pod-mapping-garment.mjs --apply      # write, then verify
 *
 * Requires Application Default Credentials (gcloud auth application-default
 * login) — same idiom as scripts/backfill-shop-type.cjs / seed-pod-profiles.cjs.
 * NEVER run this against anything but the named prod database below; there is no
 * emulator fallback (the Firestore emulator cannot serve a named DB).
 */

// firebase-admin is installed in functions/node_modules (not the repo root), so
// resolve it from there regardless of where this script is run from.
// (idiom copied from scripts/backfill-shop-type.cjs:49-54)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const admin = functionsRequire('firebase-admin');
const { getFirestore } = functionsRequire('firebase-admin/firestore');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const getArg = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1].trim() : dflt;
};
const ONLY_SHOP = getArg('shop', null);

admin.initializeApp(); // default credentials (ADC), like backfill-shop-type.cjs
const db = getFirestore('b8s-reseller-db'); // the CORRECT named database — prod

const log = (...a) => console.log(...a);
const pad = (s, len) => {
  const str = String(s ?? '');
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
};

// profileId → garment, for the profiles that map to exactly ONE garment.
// `apparel_dtg` is deliberately ABSENT: it covers tee/longsleeve/hoodie/
// sweatshirt and there is no way to tell them apart from a legacy mapping.
const GARMENT_BY_PROFILE = {
  bag_dtg: 'bag',
  cap_dtg: 'cap',
  beanie_dtg: 'beanie',
  flatcap_dtg: 'flatcap',
};

const OUTCOME = {
  ALREADY: 'already-set',
  DERIVED: 'derived-from-profile',
  UNKNOWN: 'unknown-left-null',
};

function classify(data) {
  const existing = String(data?.garment || '').trim();
  if (existing) return { outcome: OUTCOME.ALREADY, garment: existing };
  const profileId = String(data?.profileId || '').trim();
  const derived = GARMENT_BY_PROFILE[profileId];
  if (derived) return { outcome: OUTCOME.DERIVED, garment: derived, profileId };
  return { outcome: OUTCOME.UNKNOWN, garment: null, profileId: profileId || '(none)' };
}

async function loadMappings() {
  const col = db.collection('podMappings');
  const snap = ONLY_SHOP ? await col.where('shopId', '==', ONLY_SHOP).get() : await col.get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
}

async function main() {
  log(`\n==> backfill-pod-mapping-garment (${APPLY ? 'APPLY — WILL WRITE' : 'DRY RUN — writes nothing'})`);
  log(`    database: b8s-reseller-db${ONLY_SHOP ? ` · shop filter: ${ONLY_SHOP}` : ' · all shops'}`);

  const rows = await loadMappings();
  if (rows.length === 0) {
    log('\n    No podMappings docs found. Nothing to do.\n');
    return;
  }

  const counts = { [OUTCOME.ALREADY]: 0, [OUTCOME.DERIVED]: 0, [OUTCOME.UNKNOWN]: 0 };
  const byShop = new Map();
  const toWrite = [];

  for (const row of rows) {
    const verdict = classify(row.data);
    counts[verdict.outcome] += 1;
    const shopId = String(row.data.shopId || '(no shopId)');
    if (!byShop.has(shopId)) byShop.set(shopId, { [OUTCOME.ALREADY]: 0, [OUTCOME.DERIVED]: 0, [OUTCOME.UNKNOWN]: 0 });
    byShop.get(shopId)[verdict.outcome] += 1;
    if (verdict.outcome === OUTCOME.DERIVED) toWrite.push({ ...row, ...verdict, shopId });
  }

  const W = [22, 26, 16, 16, 22];
  log('\n    Rows that WOULD be written (profileId → garment):');
  if (toWrite.length === 0) {
    log('      (none)');
  } else {
    log('      ' + ['mappingId', 'shopId', 'sku', 'profileId', 'garment →'].map((h, i) => pad(h, W[i])).join(' '));
    log('      ' + W.map((w) => '-'.repeat(w)).join(' '));
    for (const r of toWrite) {
      log('      ' + [r.id, r.shopId, r.data.sku, r.profileId, r.garment].map((c, i) => pad(c, W[i])).join(' '));
    }
  }

  log('\n    Per-shop outcome counts:');
  const SW = [26, 14, 24, 22];
  log('      ' + ['shopId', 'already-set', 'derived-from-profile', 'unknown-left-null'].map((h, i) => pad(h, SW[i])).join(' '));
  log('      ' + SW.map((w) => '-'.repeat(w)).join(' '));
  for (const [shopId, c] of [...byShop.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    log('      ' + [shopId, c[OUTCOME.ALREADY], c[OUTCOME.DERIVED], c[OUTCOME.UNKNOWN]].map((v, i) => pad(v, SW[i])).join(' '));
  }

  log('\n    TOTALS');
  log(`      scanned              : ${rows.length}`);
  log(`      already-set          : ${counts[OUTCOME.ALREADY]}  (untouched)`);
  log(`      derived-from-profile : ${counts[OUTCOME.DERIVED]}  (${APPLY ? 'written' : 'would be written'})`);
  log(`      unknown-left-null    : ${counts[OUTCOME.UNKNOWN]}  (apparel_dtg or no profile — left as-is, routes to default printer)`);

  if (!APPLY) {
    log('\n    DRY RUN — nothing written. Re-run with --apply to write.\n');
    return;
  }
  if (toWrite.length === 0) {
    log('\n    --apply given but nothing is derivable. Nothing written.\n');
    return;
  }

  // Dot-path field add only — never a whole-doc set (a mapping row carries the
  // artwork link the print queue depends on).
  let written = 0;
  const CHUNK = 400; // under the 500-write batch limit
  for (let i = 0; i < toWrite.length; i += CHUNK) {
    const batch = db.batch();
    for (const r of toWrite.slice(i, i + CHUNK)) {
      batch.update(db.collection('podMappings').doc(r.id), { garment: r.garment });
    }
    await batch.commit();
    written += Math.min(CHUNK, toWrite.length - i);
    log(`      …committed ${written}/${toWrite.length}`);
  }

  log('\n    VERIFY (re-read of every written doc):');
  const VW = [22, 26, 16, 10];
  log('      ' + ['mappingId', 'shopId', 'garment', 'OK?'].map((h, i) => pad(h, VW[i])).join(' '));
  log('      ' + VW.map((w) => '-'.repeat(w)).join(' '));
  let bad = 0;
  for (const r of toWrite) {
    const snap = await db.collection('podMappings').doc(r.id).get();
    const got = snap.exists ? snap.data()?.garment : undefined;
    const ok = got === r.garment;
    if (!ok) bad += 1;
    log('      ' + [r.id, r.shopId, String(got), ok ? 'OK' : 'FAIL'].map((c, i) => pad(c, VW[i])).join(' '));
  }
  log(`\n    ${bad === 0 ? '✅ all writes verified' : `❌ ${bad} doc(s) did NOT verify`}\n`);
  if (bad > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
