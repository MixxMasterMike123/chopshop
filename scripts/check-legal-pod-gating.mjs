/**
 * check-legal-pod-gating.mjs — guards the [[IF pod]] gating of the MANDATORY
 * legal templates (src/config/legalTemplates.js).
 *
 * WHY THIS EXISTS: the three legal pages (köpvillkor, ångerrätt-och-returer,
 * integritetspolicy) are public, SEO-indexed, and legally binding. They used to
 * hardcode print vocabulary — a shop selling candles published "Print on Demand",
 * "sprucket tryck", and declared a "tryckeri/produktionspartner" as a GDPR data
 * recipient it does not use. That text now sits behind [[IF pod]] branches keyed
 * on shops/{id}.features.pod.
 *
 * Two invariants, both easy to break with an innocent-looking wording edit:
 *   1. THINGS SHOPS ARE CLEAN — with pod=false, no page contains print
 *      vocabulary, and no [[IF]]/[[ELSE]]/[[END]] marker survives unresolved.
 *   2. POD SHOPS ARE UNCHANGED — with pod=true, every page is byte-identical
 *      (modulo whitespace) to the same template on the git ref below. This is
 *      the one that catches you: while gating the print words it is very easy to
 *      also "tidy" a neighbouring phrase and silently alter mandatory legal text
 *      for POD shops. It caught exactly that twice during the original change
 *      (storleksguide→produktbeskrivning, "befintlig design"→produkt).
 *
 * The templates are VERBATIM from docs/legal-template-files/ (see the header of
 * legalTemplates.js) — any intended wording change belongs there FIRST, and then
 * BASELINE_REF below should be bumped so invariant 2 re-baselines deliberately
 * rather than by accident.
 *
 * USAGE:  node scripts/check-legal-pod-gating.mjs
 *         node scripts/check-legal-pod-gating.mjs --ref=<git-ref>
 * Exits non-zero on failure, so it can gate CI or a pre-deploy check.
 * No credentials, no network — pure text.
 */

import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = 'src/config/legalTemplates.js';
const RENDERER = join(ROOT, 'src/utils/legalPageRenderer.js');

// The commit whose POD-shop output is the accepted baseline for invariant 2.
// Bump ONLY together with a deliberate, reviewed legal-wording change.
const BASELINE_REF = process.argv.find((a) => a.startsWith('--ref='))?.slice(6) || 'origin/main';

// Print vocabulary that must never reach a things shop's legal pages.
const PRINT_WORDS = /print on demand|tryck/i;

// Use the SHIPPED evaluator rather than a copy, so this check can never pass
// against a reimplementation that has drifted from the real one.
const evaluateConditionals = (() => {
  const src = readFileSync(RENDERER, 'utf8');
  const fn = src.match(/function evaluateConditionals[\s\S]*?\n}/);
  if (!fn) throw new Error(`Could not extract evaluateConditionals from ${RENDERER}`);
  // eslint-disable-next-line no-eval
  return eval(`(${fn[0].replace('function evaluateConditionals', 'function')})`);
})();

const norm = (t) => t.replace(/\s+/g, ' ').trim();
const load = async (path) => (await import(`file://${path}`)).LEGAL_PAGES;

// Every flag combination — a pod branch must not disturb company/vat_registered.
const COMBOS = [true, false].flatMap((company) =>
  [true, false].flatMap((vat_registered) =>
    [true, false].map((pod) => ({ company, vat_registered, pod }))
  )
);

const failures = [];

const current = await load(join(ROOT, TEMPLATES));

// ── Invariant 1: things shops carry no print vocabulary, no stray markers ──
for (const [slug, page] of Object.entries(current)) {
  for (const flags of COMBOS) {
    const out = evaluateConditionals(page.template, flags);
    if (/\[\[(IF|ELSE|END)/.test(out)) {
      failures.push(`${slug}: unresolved [[…]] marker at ${JSON.stringify(flags)}`);
    }
    if (!flags.pod && PRINT_WORDS.test(out)) {
      const line = out.split('\n').find((l) => PRINT_WORDS.test(l));
      failures.push(`${slug}: print vocabulary with pod=false → "${line.trim().slice(0, 90)}"`);
    }
  }
}

// ── Invariant 2: POD shops render exactly what the baseline ref renders ──
let baseline;
try {
  const raw = execFileSync('git', ['show', `${BASELINE_REF}:${TEMPLATES}`], { cwd: ROOT, encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'legal-baseline-'));
  const file = join(dir, 'legalTemplates.baseline.js');
  writeFileSync(file, raw);
  baseline = await load(file);
} catch (err) {
  console.warn(`⚠️  Skipping the POD-parity check — could not read ${BASELINE_REF}:${TEMPLATES}`);
  console.warn(`   (${err.message.split('\n')[0]})`);
}

if (baseline) {
  for (const slug of Object.keys(current)) {
    if (!baseline[slug]) continue; // a newly added page has no baseline
    for (const flags of COMBOS.filter((c) => c.pod)) {
      const a = norm(evaluateConditionals(baseline[slug].template, flags));
      const b = norm(evaluateConditionals(current[slug].template, flags));
      if (a === b) continue;
      const A = a.split(' ');
      const B = b.split(' ');
      const i = A.findIndex((w, idx) => w !== B[idx]);
      failures.push(
        `${slug}: POD-shop text changed vs ${BASELINE_REF} at ${JSON.stringify(flags)}\n` +
          `      ${BASELINE_REF}: …${A.slice(Math.max(0, i - 10), i + 10).join(' ')}…\n` +
          `      working tree: …${B.slice(Math.max(0, i - 10), i + 10).join(' ')}…`
      );
    }
  }
}

if (failures.length) {
  console.error('\n❌ Legal POD-gating check FAILED:\n');
  [...new Set(failures)].forEach((f) => console.error('  • ' + f));
  console.error(
    '\nIf a POD-shop wording change is INTENDED: update docs/legal-template-files/ first,\n' +
      'then re-run with --ref=<the reviewed commit> to re-baseline.\n'
  );
  process.exit(1);
}

console.log('✅ Legal POD-gating OK');
console.log(`   • things shops (pod=false): no print vocabulary, no stray markers — ${Object.keys(current).length} pages × ${COMBOS.length} flag combos`);
console.log(`   • POD shops (pod=true): text identical to ${BASELINE_REF}`);
