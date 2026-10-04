#!/usr/bin/env node
/**
 * scripts/cf-port/build-locales.mjs — the storefront's static translation
 * files from the export (D16, CP4_BRIEFS.md §S2 item 11):
 *
 *   node scripts/cf-port/build-locales.mjs --bundle <export bundle dir> [--out <dir>]
 *
 * Writes `<out>/sv-SE.json`, `en-GB.json`, `en-US.json` (default out:
 * src/locales/, which src/storefront/providers/Translation.jsx reads): one flat
 * object `{ "<key>": "<text>" }` per language, keys sorted, from the export's
 * `translations_<lang>` collections (the key is the document id, the text its
 * `value`, else `translation` — the source's TranslationContext.jsx rule).
 *
 * THESE FILES ARE SHIPPED TO EVERY VISITOR, so a text is LEFT OUT (the page
 * then shows the text built into its code, as for any missing key) when it or
 * its key:
 *   - is empty (the source falls back the same way);
 *   - matches a name family of the repository's guard (guard/guards.test.mjs:
 *     the earlier brand, the retired resale feature) — the patterns are READ
 *     from the guard's own source, never restated here;
 *   - matches a marker the storefront build refuses
 *     (cloudflare/web/check-storefront-build.mjs FIREBASE_MARKERS), also read
 *     from that file;
 *   - names the source system's storage (the Worker's isSourceStorageAddress);
 *   - holds an e-mail address (a placeholder or the earlier business's own:
 *     neither belongs in every shop's storefront);
 *   - names a company by its legal form or organisation number (a shop's own
 *     company comes from its store identity, never from a shared text);
 *   - holds a control character other than a line break or tab;
 *   - has a key that a guard family refuses in ANOTHER language (the same key
 *     means the same thing everywhere: the Swedish text of a string whose
 *     English text names the retired feature goes with it).
 * Each is counted per language and reason. Nothing of a text is printed.
 *
 * Deterministic: the same bundle gives the same bytes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCollection } from './migrate/lib/bundle-reader.mjs';
import { verifyBundle } from './migrate/lib/verify-bundle.mjs';
import { loadWorkerRules } from './migrate/lib/worker-rules.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_OUT = path.join(REPO_ROOT, 'src', 'locales');
const GUARD_FILE = path.join(REPO_ROOT, 'guard', 'guards.test.mjs');
const BUILD_CHECK_FILE = path.join(REPO_ROOT, 'cloudflare', 'web', 'check-storefront-build.mjs');

/** language → the export's collection (manifest rows 58–60). */
export const LANGUAGES = Object.freeze({
  'en-GB': 'translations_en_GB',
  'en-US': 'translations_en_US',
  'sv-SE': 'translations_sv_SE',
});

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;
// A Swedish company's legal form as a word, or an organisation number.
const COMPANY = /\b(?:AB|HB|KB|Aktiebolag|Handelsbolag|Kommanditbolag)\b|\b\d{6}-\d{4}\b/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** The regex literal written in `text` at `from`: { re, end } (end = the index after its flags). */
function regexLiteralAt(text, from) {
  if (text[from] !== '/') throw new Error('not a regex literal');
  let i = from + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') throw new Error('unterminated regex literal');
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    i += 1;
  }
  const flags = /^[a-z]*/.exec(text.slice(i + 1))[0];
  return { end: i + 1 + flags.length, re: new RegExp(text.slice(from + 1, i), flags) };
}

/**
 * The guard's name families (those it also applies to paths: the NAMES, not
 * the import patterns), read from guard/guards.test.mjs. Throws when the
 * guard's shape changed, so the scrub can never silently lose a family.
 */
export function guardNamePatterns(guardSource = readFileSync(GUARD_FILE, 'utf8')) {
  const patterns = [];
  let families = 0;
  const entry = /\{\s*name:\s*'([a-z0-9-]+)',\s*re:\s*/g;
  let match;
  while ((match = entry.exec(guardSource)) !== null) {
    const { end, re } = regexLiteralAt(guardSource, entry.lastIndex);
    const matchPath = /^,\s*matchPath:\s*(true|false)/.exec(guardSource.slice(end));
    if (!matchPath) throw new Error(`guard family ${match[1]}: its matchPath could not be read (re-read guard/guards.test.mjs)`);
    families += 1;
    if (matchPath[1] === 'true') patterns.push({ name: match[1], re });
  }
  if (patterns.length === 0) throw new Error(`guard/guards.test.mjs: no name family among ${families} (its FAMILIES changed shape: re-read it)`);
  return patterns;
}

/** The storefront build's markers, read from cloudflare/web/check-storefront-build.mjs. */
export function buildMarkerPatterns(checkSource = readFileSync(BUILD_CHECK_FILE, 'utf8')) {
  const start = checkSource.indexOf('const FIREBASE_MARKERS = [');
  if (start === -1) throw new Error('check-storefront-build.mjs: FIREBASE_MARKERS not found (re-read it)');
  const patterns = [];
  let i = checkSource.indexOf('[', start) + 1;
  while (i < checkSource.length && checkSource[i] !== ']') {
    if (checkSource[i] === '/' && checkSource[i + 1] === '/') {
      i = checkSource.indexOf('\n', i);
    } else if (checkSource[i] === '/') {
      const { end, re } = regexLiteralAt(checkSource, i);
      patterns.push(re);
      i = end;
    } else {
      i += 1;
    }
  }
  if (patterns.length === 0) throw new Error('check-storefront-build.mjs: FIREBASE_MARKERS is empty or unreadable');
  return patterns;
}

/** Why a (key, text) pair may not ship, or null. The first reason found. */
export function leaveOutReason({ key, text }, { isSourceStorageAddress, markers, names }) {
  if (typeof text !== 'string' || text.length === 0) return 'empty';
  // Counted by the family's place in the guard, never by its name: the name
  // is what may not be written anywhere.
  for (const [index, { re }] of names.entries()) {
    if (re.test(key) || re.test(text)) return `guard_family_${index + 1}`;
  }
  if (markers.some((re) => re.test(key) || re.test(text))) return 'build_marker';
  if (isSourceStorageAddress(key) || isSourceStorageAddress(text)) return 'source_storage';
  if (EMAIL.test(text) || EMAIL.test(key)) return 'email_address';
  if (COMPANY.test(text)) return 'company_name';
  if (CONTROL.test(text) || CONTROL.test(key)) return 'control_character';
  return null;
}

/** The source's text of a translation document (TranslationContext.jsx: value, else translation). */
function textOf(doc) {
  const data = doc.data ?? {};
  return data.value || data.translation || '';
}

/**
 * The keys a guard name family refuses in ANY language. The same key means the
 * same thing in every language, so a Swedish text of the retired feature,
 * whose English text names it, is left out too — without this file ever
 * spelling the Swedish word.
 */
export function keysNamedInAnyLanguage(docsByLanguage, rules) {
  const keys = new Set();
  for (const docs of Object.values(docsByLanguage)) {
    for (const doc of docs) {
      const reason = leaveOutReason({ key: doc.id, text: textOf(doc) }, rules);
      if (reason !== null && reason.startsWith('guard_family_')) keys.add(doc.id);
    }
  }
  return keys;
}

/** The export's documents of one language → { table (sorted keys), counts }. */
export function buildTable(docs, rules, namedKeys = new Set()) {
  const entries = [];
  const leftOut = {};
  for (const doc of docs) {
    let reason = leaveOutReason({ key: doc.id, text: textOf(doc) }, rules);
    if (reason === null && namedKeys.has(doc.id)) reason = 'guard_family_in_another_language';
    if (reason !== null) {
      leftOut[reason] = (leftOut[reason] ?? 0) + 1;
      continue;
    }
    entries.push([doc.id, textOf(doc)]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { counts: { leftOut, read: docs.length, written: entries.length }, table: Object.fromEntries(entries) };
}

/**
 * The three files' bytes and counts, built in memory and written nowhere
 * (CP7-T2: verify.mjs compares them with the committed files, manifest (e) 16).
 * → { language: { counts, text } }
 */
export async function buildLocaleTexts({ bundleDir }) {
  const verify = verifyBundle(bundleDir);
  if (!verify.ok) throw new Error('the bundle does not verify: refusing to build from it');
  const worker = await loadWorkerRules();
  const rules = { isSourceStorageAddress: worker.isSourceStorageAddress, markers: buildMarkerPatterns(), names: guardNamePatterns() };
  const docsByLanguage = Object.fromEntries(Object.entries(LANGUAGES).map(([language, collection]) => [language, readCollection(bundleDir, collection)]));
  const namedKeys = keysNamedInAnyLanguage(docsByLanguage, rules);
  const out = {};
  for (const [language, docs] of Object.entries(docsByLanguage)) {
    const { counts, table } = buildTable(docs, rules, namedKeys);
    out[language] = { counts, text: `${JSON.stringify(table, null, 2)}\n` };
  }
  return out;
}

export async function buildLocales({ bundleDir, outDir = DEFAULT_OUT }) {
  const built = await buildLocaleTexts({ bundleDir });
  mkdirSync(outDir, { recursive: true });
  const summary = {};
  for (const [language, { counts, text }] of Object.entries(built)) {
    const file = path.join(outDir, `${language}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, file);
    summary[language] = counts;
  }
  return summary;
}

function parseArgs(argv) {
  const out = { bundle: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--bundle') out.bundle = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.bundle) throw new Error('--bundle is required');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await buildLocales({ bundleDir: path.resolve(args.bundle), outDir: path.resolve(args.out) });
  for (const [language, counts] of Object.entries(summary)) {
    const leftOut = Object.entries(counts.leftOut).sort(([a], [b]) => (a < b ? -1 : 1)).map(([reason, n]) => `${reason} ${n}`).join(', ') || 'none';
    console.log(`${language}: read ${counts.read}, written ${counts.written}, left out: ${leftOut}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`BUILD-LOCALES REFUSED: ${error?.message ?? error}`);
    process.exit(1);
  });
}
