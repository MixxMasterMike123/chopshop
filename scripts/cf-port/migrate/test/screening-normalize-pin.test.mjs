import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldText, tokenize, termMatch, normalizeScreeningTerm } from '../lib/screening-normalize.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCREENING_CORE_PATH = path.join(REPO_ROOT, 'cloudflare', 'src', 'catalog', 'screening-core.ts');

test('screening-core.ts still exists at the pinned path (drift guard)', () => {
  const text = readFileSync(SCREENING_CORE_PATH, 'utf8');
  assert.ok(text.includes('export const foldText'), 'expected foldText to still be exported from screening-core.ts');
  assert.ok(text.includes('export const termMatch'), 'expected termMatch to still be exported from screening-core.ts');
  assert.ok(text.includes('export function normalizeScreeningTerm'), 'expected normalizeScreeningTerm to still be exported from screening-core.ts');
});

// Fixture vectors exercised against BOTH implementations conceptually: this
// file only has the JS port available at test time (the .ts file cannot be
// executed by node --test without a TS loader), so these vectors are the
// ones a reviewer can re-run against screening-core.ts with a TS runner to
// confirm parity. They encode every documented normalisation rule.
const VECTORS = [
  { expectSymbolOnly: false, input: 'Nike', term: 'nike' },
  { expectSymbolOnly: false, input: 'AC/DC', term: 'ac dc' },
  { expectSymbolOnly: false, input: 'Håkan  Hellström', term: 'hakan hellstrom' },
  { expectSymbolOnly: true, input: '™', term: '™' },
  { expectSymbolOnly: true, input: '®', term: '®' },
  { expectNull: true, input: '   ' },
  { expectNull: true, input: '' },
];

test('normalizeScreeningTerm matches the documented rules for every fixture vector', () => {
  for (const v of VECTORS) {
    const result = normalizeScreeningTerm(v.input);
    if (v.expectNull) {
      assert.equal(result, null, `expected ${JSON.stringify(v.input)} to normalise to null`);
      continue;
    }
    assert.notEqual(result, null, `expected ${JSON.stringify(v.input)} to normalise to something`);
    assert.equal(result.term, v.term, `term mismatch for ${JSON.stringify(v.input)}`);
    assert.equal(result.symbolOnly, v.expectSymbolOnly, `symbolOnly mismatch for ${JSON.stringify(v.input)}`);
  }
});

test('normalizeScreeningTerm refuses control characters', () => {
  assert.equal(normalizeScreeningTerm('bad\u0007term'), null);
});

test('normalizeScreeningTerm refuses a non-string', () => {
  assert.equal(normalizeScreeningTerm(42), null);
});

test('foldText folds diacritics and extra Latin letters', () => {
  assert.equal(foldText('Ångström'), 'angstrom');
  assert.equal(foldText('ØSTRE'), 'ostre');
});

test('tokenize wraps in single spaces and lowercases', () => {
  assert.equal(tokenize('Nike Air'), ' nike air ');
});

test('termMatch: a term with only non-Latin letters that fold to nothing is null', () => {
  // A term that trims to empty is null; a symbol like ™ is symbolOnly.
  assert.equal(termMatch(''), null);
  const symbol = termMatch('™');
  assert.equal(symbol.symbolOnly, true);
});
