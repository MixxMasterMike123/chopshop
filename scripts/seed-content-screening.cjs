/**
 * seed-content-screening.cjs — seed settings/contentScreening, the platform
 * blocklist for pre-publish brand screening (SnapWear A11).
 *
 * WHAT IT IS FOR: a seller printing a licensed name/logo (a band, a club, a
 * luxury brand) is the one expensive scenario on a POD platform. Products whose
 * name/description/tags/artwork file names contain a term below are FLAGGED by
 * the screenProductOnWrite trigger and land in Plattform → Anmälningar →
 * Granskning. Publishing is NOT blocked (a hard block only invites renaming);
 * a human decides. Matching is case-insensitive, diacritics-folded and
 * WHOLE-WORD (src/utils/contentScreening.js): "kent" hits "Kent tour" but not
 * "Kentucky".
 *
 * WHAT GETS WRITTEN — settings/contentScreening:
 *   { blocklist: [{ term, kind: 'brand'|'band'|'club'|'other', note }],
 *     reviewFirstProducts: 2,   // a new shop's first N live products → review
 *     hardBlock: false,         // true = every hit also switches the product off
 *     updatedAt }
 *   A single entry can carry hardBlock:true instead (edit in the console).
 *   settings/* is platform-written, active-user-readable (firestore.rules) —
 *   sellers read it for the publish notice; there is nothing secret in it.
 *
 * STARTER LIST, deliberately small: common bootleg targets, not every mark in
 * the world. Words that are ordinary Swedish/English on their own are left out
 * or written as the full name (e.g. "manchester united", not "united"; no
 * "apple", "puma", "jaguar", "ghost", "europe"), because every false flag costs
 * a human review. "kent" stays in: Swedish bootleg merch target, and the
 * whole-word match keeps "Kentucky" out.
 *
 * Conventions mirror the other seed scripts:
 *   - DRY RUN by default — prints what would be written vs what is stored.
 *   - `--commit` writes; refuses to overwrite an existing doc without `--force`
 *     (the platform may have tuned the list since).
 *
 * USAGE (run by Mikael — live data write):
 *   node scripts/seed-content-screening.cjs                    # dry run
 *   node scripts/seed-content-screening.cjs --commit           # first write
 *   node scripts/seed-content-screening.cjs --commit --force   # replace the list
 *
 * Requires Application Default Credentials (gcloud auth application-default
 * login). NAMED database b8s-reseller-db.
 */

const path = require('path');
const { createRequire } = require('module');
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const admin = functionsRequire('firebase-admin');
const { getFirestore, FieldValue } = functionsRequire('firebase-admin/firestore');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const FORCE = args.includes('--force');

const brand = (term, note = '') => ({ term, kind: 'brand', note });
const band = (term, note = '') => ({ term, kind: 'band', note });
const club = (term, note = '') => ({ term, kind: 'club', note });
const other = (term, note = '') => ({ term, kind: 'other', note });

const BLOCKLIST = [
  // ── Brands (fashion, entertainment, consumer) ──
  brand('nike'), brand('adidas'), brand('disney'), brand('marvel'), brand('pixar'),
  brand('pokemon'), brand('nintendo'), brand('lego'), brand('supreme'),
  brand('gucci'), brand('louis vuitton'), brand('chanel'), brand('prada'),
  brand('balenciaga'), brand('ferrari'), brand('coca-cola'), brand('cocacola'),
  brand('netflix'), brand('star wars'), brand('harry potter'), brand('hello kitty'),
  brand('north face'), brand('stone island'), brand('ralph lauren'), brand('tommy hilfiger'),
  brand('barbie'), brand('minecraft'), brand('fortnite'), brand('playstation'),

  // ── Bands & artists commonly bootlegged ──
  band('abba'), band('metallica'), band('iron maiden'), band('ac/dc'), band('acdc'),
  band('nirvana'), band('taylor swift'), band('beyonce'), band('drake'),
  band('håkan hellström'), band('kent', 'Swedish band — whole word, "Kentucky" does not match'),
  band('veronica maggio'), band('ghost bc', 'the band Ghost — plain "ghost" would flood'),
  band('rammstein'), band('rolling stones'), band('guns n roses', "also matches \"Guns N' Roses\""),
  band('beatles'), band('billie eilish'),

  // ── Sport clubs ──
  club('aik'), club('djurgården'), club('hammarby'), club('malmö ff'),
  club('ifk göteborg'), club('manchester united'), club('real madrid'),
  club('fc barcelona', 'plain "barcelona" would flag every city tee'),
  club('liverpool fc', 'plain "liverpool" would flag every city tee'), club('juventus'),

  // ── Licensing markers ──
  other('official', 'claims official merch'), other('officiell'), other('licensed'),
  other('licensierad'), other('™', 'trademark sign'), other('®', 'registered sign'),
];

async function main() {
  const terms = BLOCKLIST.map((e) => e.term.toLowerCase());
  const dupes = terms.filter((t, i) => terms.indexOf(t) !== i);
  if (dupes.length) {
    console.error(`❌ duplicate terms: ${dupes.join(', ')}`);
    process.exit(1);
  }

  admin.initializeApp(); // default credentials, like the other seed scripts
  const db = getFirestore('b8s-reseller-db'); // the CORRECT named database
  const ref = db.collection('settings').doc('contentScreening');
  const snap = await ref.get();
  const stored = snap.exists ? snap.data() : null;

  const next = {
    blocklist: BLOCKLIST,
    reviewFirstProducts: 2,
    hardBlock: false,
  };

  console.log(`settings/contentScreening — ${BLOCKLIST.length} terms ` +
    `(${['brand', 'band', 'club', 'other'].map((k) => `${BLOCKLIST.filter((e) => e.kind === k).length} ${k}`).join(', ')})`);
  if (stored) {
    const had = new Set((stored.blocklist || []).map((e) => String(e?.term || e).toLowerCase()));
    const want = new Set(terms);
    const added = [...want].filter((t) => !had.has(t));
    const removed = [...had].filter((t) => !want.has(t));
    console.log(`  stored: ${had.size} terms, reviewFirstProducts=${stored.reviewFirstProducts}, hardBlock=${stored.hardBlock === true}`);
    console.log(`  + add (${added.length}): ${added.join(', ') || '—'}`);
    console.log(`  - drop (${removed.length}): ${removed.join(', ') || '—'}`);
  } else {
    console.log('  stored: (no doc yet)');
    console.log(`  terms: ${terms.join(', ')}`);
  }

  if (!COMMIT) {
    console.log('\nDRY RUN — nothing written. Re-run with --commit to write.');
    return;
  }
  if (stored && !FORCE) {
    console.error('\n❌ settings/contentScreening already exists — it may have been tuned since. Re-run with --force to replace it.');
    process.exit(1);
  }
  await ref.set({ ...next, updatedAt: FieldValue.serverTimestamp() });
  console.log('\n✅ written settings/contentScreening');
}

main().catch((e) => {
  console.error('❌ seed failed:', e);
  process.exit(1);
});
