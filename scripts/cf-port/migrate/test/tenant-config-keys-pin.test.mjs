import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFUSED_STORE_IDENTITY_KEYS, REFUSED_LEGAL_KEYS, FEATURE_KEYS, OPT_IN_FEATURE_KEYS, FEATURE_DEFAULTS } from '../lib/transform-shops.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TENANT_CONFIG_PATH = path.join(REPO_ROOT, 'cloudflare', 'src', 'platform', 'tenant-config.ts');

/** Extracts the string literals inside a `export const NAME = [ ... ] as const;`
 * array declaration from the .ts source text, so this test fails loudly if
 * the Worker source changes without this importer's restated copy changing
 * too (the brief: "the two must not drift"). */
function extractConstArray(source, constName) {
  const re = new RegExp(`export const ${constName}[^=]*=\\s*\\[([^\\]]*)\\]`, 's');
  const match = source.match(re);
  if (!match) {
    throw new Error(`could not find "export const ${constName}" array in tenant-config.ts — has it been renamed?`);
  }
  const body = match[1];
  const literals = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return literals;
}

test('REFUSED_STORE_IDENTITY_KEYS matches the live Worker source exactly', () => {
  const source = readFileSync(TENANT_CONFIG_PATH, 'utf8');
  const live = extractConstArray(source, 'REFUSED_STORE_IDENTITY_KEYS').sort();
  const mine = [...REFUSED_STORE_IDENTITY_KEYS].sort();
  assert.deepEqual(mine, live, 'transform-shops.mjs REFUSED_STORE_IDENTITY_KEYS has drifted from cloudflare/src/platform/tenant-config.ts');
});

test('REFUSED_LEGAL_KEYS matches the live Worker source exactly', () => {
  const source = readFileSync(TENANT_CONFIG_PATH, 'utf8');
  const live = extractConstArray(source, 'REFUSED_LEGAL_KEYS').sort();
  const mine = [...REFUSED_LEGAL_KEYS].sort();
  assert.deepEqual(mine, live);
});

test('FEATURE_KEYS matches the live Worker source exactly', () => {
  const source = readFileSync(TENANT_CONFIG_PATH, 'utf8');
  const live = extractConstArray(source, 'FEATURE_KEYS').sort();
  const mine = [...FEATURE_KEYS].sort();
  assert.deepEqual(mine, live, 'transform-shops.mjs FEATURE_KEYS has drifted from cloudflare/src/platform/tenant-config.ts');
});

test('OPT_IN_FEATURE_KEYS matches the live Worker source\'s OPT_IN_KEYS Set literal', () => {
  const source = readFileSync(TENANT_CONFIG_PATH, 'utf8');
  const match = source.match(/const OPT_IN_KEYS[^=]*=\s*new Set<FeatureKey>\(\[([^\]]*)\]\)/s);
  assert.ok(match, 'could not find OPT_IN_KEYS in tenant-config.ts — has it been renamed?');
  const live = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).sort();
  const mine = [...OPT_IN_FEATURE_KEYS].sort();
  assert.deepEqual(mine, live);
});

test('FEATURE_DEFAULTS: opt-in keys default false, every other allowed key defaults true', () => {
  for (const key of FEATURE_KEYS) {
    const expected = !OPT_IN_FEATURE_KEYS.has(key);
    assert.equal(FEATURE_DEFAULTS[key], expected, `default for ${key}`);
  }
});
