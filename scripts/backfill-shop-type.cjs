/**
 * backfill-shop-type.cjs — backfill explicit `features.pod` (+ `shopType` crumb)
 * on every shops/{id} doc, ahead of flipping the pod feature-flag predicate
 * from default-ON (`features?.pod !== false`) to explicit opt-in
 * (`features?.pod === true`) — see plan D3/D4, Slice D
 * (~/.claude/plans/pod-shop-type-selector-plan.md).
 *
 * WHY THIS EXISTS (the polarity flip risk):
 *   Today, a shop with NO `features.pod` field is POD-ENTITLED (default-ON).
 *   After the D3 flip ships, a shop with no `features.pod` field goes DARK
 *   (default-OFF) — any legacy POD shop that was relying on the missing-field
 *   default would silently lose its print pipeline/checkout/Studio access.
 *   This script makes that field explicit on every shop BEFORE the flip, so
 *   the flip changes nothing observable for any existing shop.
 *
 * STRICT ORDERING (do not skip a step):
 *   1. Run this script in dry-run (default) — review the table with Mikael.
 *   2. Run with --apply — writes `features.pod` + `shopType` (dot-paths only,
 *      the `features` map is NEVER replaced wholesale).
 *   3. This script RE-READS every shop after --apply and prints a verification
 *      table proving the writes landed as intended.
 *   4. ONLY THEN ship the D3 polarity flip (src/config/addons.js +
 *      functions/src/config/shopFeatures.ts, client+server same deploy).
 *   Shipping the flip before this backfill is verified will take POD shops
 *   dark. Do not reorder.
 *
 * THINGS LIST (shops that get explicit `pod:false`; everyone else gets
 * `pod:true`) — hardcoded per plan D4, override with --things if the
 * authoritative list changes:
 *   melodie-mc, sillmans, giffarna, ninetone
 *
 * USAGE:
 *   node scripts/backfill-shop-type.cjs                       # dry run (default) — prints the plan, writes nothing
 *   node scripts/backfill-shop-type.cjs --things=a,b,c         # override the things-list shopIds
 *   node scripts/backfill-shop-type.cjs --apply                # write features.pod + shopType, then verify
 *   node scripts/backfill-shop-type.cjs --apply --things=a,b,c # same, with an overridden things list
 *
 * Requires Application Default Credentials (gcloud auth application-default
 * login) — same idiom as scripts/rename-shopid.cjs / seed-pod-profiles.cjs.
 * NEVER run this against anything but the named prod database below; there
 * is no emulator fallback (the Firestore emulator can't serve a named DB).
 */

// firebase-admin is installed in functions/node_modules (not the repo root),
// so resolve it from there regardless of where this script is run from.
// (idiom copied from scripts/rename-shopid.cjs:49-54 / seed-pod-profiles.cjs:33-37)
const path = require('path');
const { createRequire } = require('module');
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const admin = functionsRequire('firebase-admin');
const { getFirestore } = functionsRequire('firebase-admin/firestore');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const getArg = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1].trim() : dflt;
};

const DEFAULT_THINGS = ['melodie-mc', 'sillmans', 'giffarna', 'ninetone'];
const thingsArg = getArg('things', null);
const THINGS_LIST = thingsArg
  ? thingsArg.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_THINGS;
const THINGS_SET = new Set(THINGS_LIST);

admin.initializeApp(); // default credentials (ADC), like seed-pod-profiles.cjs
const db = getFirestore('b8s-reseller-db'); // the CORRECT named database — prod

const log = (...a) => console.log(...a);

// Mirrors the CURRENT (pre-flip) default-ON predicate:
// src/config/addons.js isFeatureEnabled = (features, key) => features?.[key] !== false
function currentEffectivePod(features) {
  return features?.pod !== false;
}

function proposedPod(shopId) {
  return !THINGS_SET.has(shopId);
}

function proposedShopType(shopId) {
  return THINGS_SET.has(shopId) ? 'things' : 'pod';
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

async function loadShops() {
  const snap = await db.collection('shops').get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
}

function computeRow(shop) {
  const { id, data } = shop;
  const features = data.features || {};
  const hasExplicitPod = Object.prototype.hasOwnProperty.call(features, 'pod');
  const currentPodLabel = hasExplicitPod ? String(features.pod) : '(missing→ON)';
  const currentEffective = currentEffectivePod(features);
  const propPod = proposedPod(id);
  const propType = proposedShopType(id);
  const hasShopType = Object.prototype.hasOwnProperty.call(data, 'shopType');

  const podChanges = !hasExplicitPod || features.pod !== propPod;
  const typeChanges = !hasShopType || data.shopType !== propType;
  const needsChange = podChanges || typeChanges;

  return {
    id,
    name: data.name || data.displayName || '(no name)',
    currentPodLabel,
    currentEffective,
    propPod,
    propType,
    needsChange,
    podChanges,
    typeChanges,
  };
}

function printTable(rows, { verify } = { verify: false }) {
  const headers = verify
    ? ['shopId', 'name', 'features.pod', 'shopType', 'OK?']
    : ['shopId', 'name', 'current pod', 'proposed pod', 'proposed shopType', 'change?'];
  const widths = verify ? [20, 24, 14, 10, 6] : [20, 24, 16, 14, 18, 10];

  log(headers.map((h, i) => pad(h, widths[i])).join(' '));
  log(widths.map((w) => '-'.repeat(w)).join(' '));

  for (const r of rows) {
    if (verify) {
      const cells = [r.id, r.name, String(r.features?.pod), String(r.shopType), r.ok ? 'OK' : 'FAIL'];
      log(cells.map((c, i) => pad(c, widths[i])).join(' '));
    } else {
      const cells = [
        r.id,
        r.name,
        r.currentPodLabel,
        String(r.propPod),
        r.propType,
        r.needsChange ? 'CHANGE' : 'no-op',
      ];
      log(cells.map((c, i) => pad(c, widths[i])).join(' '));
    }
  }
}

async function guardThingsListExists(shopIds) {
  const missing = THINGS_LIST.filter((id) => !shopIds.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `--apply refused: things-list shopId(s) not found in shops collection: ${missing.join(', ')}. ` +
      `Typo protection — check spelling or pass --things= with the correct ids.`
    );
  }
}

async function applyChanges(rows) {
  const toChange = rows.filter((r) => r.needsChange);
  log(`\n🔴 APPLY: writing ${toChange.length} shop doc(s) (dot-paths features.pod / shopType only)...\n`);

  let written = 0;
  const failures = [];
  for (const r of toChange) {
    try {
      await db.collection('shops').doc(r.id).update({
        'features.pod': r.propPod,
        shopType: r.propType,
      });
      written += 1;
      log(`   ✅ ${r.id}: features.pod=${r.propPod}, shopType=${r.propType}`);
    } catch (err) {
      failures.push({ id: r.id, error: err.message });
      log(`   ❌ ${r.id}: WRITE FAILED — ${err.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} write(s) failed: ${failures.map((f) => f.id).join(', ')}`);
  }
  log(`\n   ${written} doc(s) written successfully.`);
}

async function verifyChanges(expectedRows) {
  log(`\n🔍 VERIFY: re-reading every shop doc...\n`);
  const shops = await loadShops();
  const byId = new Map(shops.map((s) => [s.id, s.data]));

  const verifyRows = expectedRows.map((r) => {
    const data = byId.get(r.id) || {};
    const features = data.features || {};
    const ok = features.pod === r.propPod && data.shopType === r.propType;
    return { id: r.id, name: r.name, features, shopType: data.shopType, ok };
  });

  printTable(verifyRows, { verify: true });

  const failed = verifyRows.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new Error(
      `Verification FAILED for ${failed.length} shop(s): ${failed.map((f) => f.id).join(', ')}`
    );
  }
  log(`\n✅ Verification passed — all ${verifyRows.length} shop doc(s) confirmed.`);
}

async function main() {
  log(`\n📋 Backfill shop-type / features.pod — ${APPLY ? '🔴 APPLY' : '🟡 DRY RUN (no writes)'}`);
  log(`   database: b8s-reseller-db (named, ADC)`);
  log(`   things-list (pod:false): ${THINGS_LIST.join(', ')}`);
  log('');

  const shops = await loadShops();
  const shopIds = shops.map((s) => s.id);

  if (APPLY) {
    await guardThingsListExists(shopIds);
  }

  const rows = shops.map(computeRow).sort((a, b) => a.id.localeCompare(b.id));
  printTable(rows);

  const changing = rows.filter((r) => r.needsChange);
  log(`\nSummary: ${rows.length} shop(s) total, ${changing.length} need change, ${rows.length - changing.length} no-op.`);

  if (!APPLY) {
    log('\n🟡 Dry run complete. Run with --apply to write.');
    return;
  }

  if (changing.length === 0) {
    log('\n✅ Nothing to apply — all shops already match the proposed state.');
    return;
  }

  await applyChanges(rows);
  await verifyChanges(rows);

  log('\n✅ APPLY + VERIFY complete.');
  log('   Next step (per plan D3, Slice D step 3): ship the polarity flip');
  log('   (src/config/addons.js + functions/src/config/shopFeatures.ts,');
  log('   client+server in the SAME deploy), then re-verify rendered on one');
  log('   POD shop + one things shop immediately after deploy.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌', err.message);
    process.exit(1);
  });
