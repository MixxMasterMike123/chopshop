/**
 * scripts/cf-port/build-locales.mjs: the storefront's translation files. The
 * scrub reads the guard's and the build check's own patterns (never restated,
 * and never written into this file: the samples below are made from the
 * patterns at run time). Also pins the files that ARE in the tree:
 * src/locales/*.json hold nothing the scrub would leave out, in sorted order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLocales, buildMarkerPatterns, buildTable, DEFAULT_OUT, guardNamePatterns, LANGUAGES, leaveOutReason } from '../../build-locales.mjs';
import { loadWorkerRules } from '../lib/worker-rules.mjs';
import { buildFixtureBundle, rmDir, tmpDir } from './fixtures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const worker = await loadWorkerRules();
const rules = { isSourceStorageAddress: worker.isSourceStorageAddress, markers: buildMarkerPatterns(), names: guardNamePatterns() };

/** A word the family's pattern matches, taken from the pattern itself. */
function sampleOf(re) {
  const first = re.source.split('|')[0];
  assert.match(first, /^[a-z0-9]+$/i, 'the sample is a plain word of the pattern');
  return first;
}

test('the scrub reads the guard\'s name families and the build\'s markers from their own files', () => {
  assert.ok(rules.names.length >= 2);
  for (const { re } of rules.names) assert.ok(re instanceof RegExp && re.flags.includes('i'));
  assert.ok(rules.markers.length >= 6);
  assert.throws(() => guardNamePatterns('const FAMILIES = [];'), /no name family/);
  assert.throws(() => buildMarkerPatterns('const OTHER = [];'), /FIREBASE_MARKERS not found/);
  // A family the guard applies to import statements only is not a name.
  const onlyImports = "const FAMILIES = [{ name: 'x', re: /from\\s*['\"]x['\"/-]/, matchPath: false }];";
  assert.throws(() => guardNamePatterns(onlyImports), /no name family among 1/);
});

test('a text is left out for each reason, counted by reason, never by a name', () => {
  const [first, second] = rules.names;
  const reason = (key, text) => leaveOutReason({ key, text }, rules);
  assert.equal(reason('a.b', ''), 'empty');
  assert.equal(reason('a.b', `Welcome to ${sampleOf(first.re).toUpperCase()}`), 'guard_family_1');
  assert.equal(reason(`${sampleOf(second.re)}.title`, 'Hi'), 'guard_family_2');
  assert.equal(reason('a.b', 'Built on Firestore'), 'build_marker');
  assert.equal(reason('a.b', 'gs://bucket/x.png'), 'source_storage');
  assert.equal(reason('a.b', 'Write to hello@example.com'), 'email_address');
  assert.equal(reason('a.b', '© Example Trading AB'), 'company_name');
  assert.equal(reason('a.b', 'Org.nr 556677-8899'), 'company_name');
  assert.equal(reason('a.b', 'bad\u0007text'), 'control_character');
  assert.equal(reason('a.b', 'Lägg i varukorgen\nnu'), null);
  assert.equal(reason('a.b', 'ABC-kurs och Absolut'), null);
});

test('a table: the source\'s value rule (value, else translation), keys sorted, counts per reason', () => {
  const docs = [
    { data: { value: 'Zeta' }, id: 'z.key' },
    { data: { translation: 'Alfa' }, id: 'a.key' },
    { data: { value: '' }, id: 'e.key' },
    { data: { value: 'Mail x@example.com' }, id: 'm.key' },
  ];
  const { counts, table } = buildTable(docs, rules);
  assert.deepEqual(Object.keys(table), ['a.key', 'z.key']);
  assert.deepEqual(counts, { leftOut: { email_address: 1, empty: 1 }, read: 4, written: 2 });
});

test('from a bundle: three files, deterministic, nothing left out shipped', async () => {
  const base = tmpDir('cfport-locales-');
  try {
    const bundleDir = path.join(base, 'bundle');
    const leaky = sampleOf(rules.names[0].re);
    const feature = sampleOf(rules.names[1].re);
    await buildFixtureBundle(bundleDir, {
      schemaPatch(schema) {
        schema.translations_sv_SE = {
          'cart.title': { data: { value: 'Varukorg' } },
          'footer.brand': { data: { value: `Av ${leaky}` } },
          'nav.home': { data: { value: 'Hem' } },
          'nav.partner': { data: { value: 'Bli partner' } },
        };
        schema.translations_en_GB = { 'cart.title': { data: { value: 'Basket' } }, 'nav.partner': { data: { value: `Become a ${feature}` } } };
        schema.translations_en_US = { 'cart.title': { data: { value: 'Cart' } } };
      },
    });
    const out = path.join(base, 'locales');
    const first = await buildLocales({ bundleDir, outDir: out });
    const bytes = Object.keys(LANGUAGES).map((language) => readFileSync(path.join(out, `${language}.json`), 'utf8'));
    await buildLocales({ bundleDir, outDir: out });
    assert.deepEqual(Object.keys(LANGUAGES).map((language) => readFileSync(path.join(out, `${language}.json`), 'utf8')), bytes);
    assert.deepEqual(JSON.parse(bytes[Object.keys(LANGUAGES).indexOf('sv-SE')]), { 'cart.title': 'Varukorg', 'nav.home': 'Hem' });
    // The Swedish text of a key whose English text names a guard family goes with it.
    assert.deepEqual(first['sv-SE'], { leftOut: { guard_family_1: 1, guard_family_in_another_language: 1 }, read: 4, written: 2 });
    assert.deepEqual(first['en-GB'], { leftOut: { guard_family_2: 1 }, read: 2, written: 1 });
  } finally {
    rmDir(base);
  }
});

test('the files in the tree (src/locales) hold nothing the scrub leaves out, keys sorted', () => {
  assert.equal(DEFAULT_OUT, path.join(REPO_ROOT, 'src', 'locales'));
  for (const language of Object.keys(LANGUAGES)) {
    const file = path.join(DEFAULT_OUT, `${language}.json`);
    assert.ok(existsSync(file), `${language}.json is generated and in the tree`);
    const text = readFileSync(file, 'utf8');
    const table = JSON.parse(text);
    const keys = Object.keys(table);
    assert.deepEqual(keys, [...keys].sort(), `${language}: keys sorted`);
    assert.ok(keys.length > 0);
    for (const key of keys) assert.equal(leaveOutReason({ key, text: table[key] }, rules), null, `${language}: an entry the scrub would leave out`);
    assert.equal(text, `${JSON.stringify(table, null, 2)}\n`);
  }
});
