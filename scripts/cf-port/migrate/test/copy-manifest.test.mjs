import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  COPY_MANIFEST_FILE,
  copyManifestProblems,
  emptyCopyManifest,
  entryProblems,
  indexCopyManifest,
  kindOfUse,
  lookupAddress,
  lookupCopied,
  lookupEntry,
  objectKeyOf,
  readCopyManifest,
  sourceKeyOf,
  uploadFileName,
  upsertEntry,
  writeCopyManifest,
} from '../lib/copy-manifest.mjs';

const SHA = 'a'.repeat(64);
const ADDRESS = 'https://files.example.test/v0/b/bucket/o/products%2Fone.jpg?alt=media&token=t';

function manifest() {
  return emptyCopyManifest({
    env: 'staging',
    apiOrigin: 'https://api.example.test',
    bundleManifestSha256: SHA,
    createdAt: '2026-09-28T10:00:00.000Z',
  });
}

function copied(overrides = {}) {
  return {
    shopId: 'shop-a',
    sourceKey: sourceKeyOf(ADDRESS),
    use: 'product_image',
    status: 'copied',
    objectId: '11111111-2222-4333-8444-555555555555',
    sha256: 'b'.repeat(64),
    sizeBytes: 1234,
    contentType: 'image/jpeg',
    reason: null,
    ...overrides,
  };
}

function refused(overrides = {}) {
  return copied({ status: 'refused', objectId: null, reason: 'type_not_as_stated', ...overrides });
}

test('sourceKeyOf: sha256 hex of the address exactly as given, UTF-8', () => {
  assert.equal(sourceKeyOf(ADDRESS), createHash('sha256').update(ADDRESS, 'utf8').digest('hex'));
  assert.notEqual(sourceKeyOf(ADDRESS), sourceKeyOf(`${ADDRESS} `));
  assert.equal(sourceKeyOf('å'), createHash('sha256').update(Buffer.from('å', 'utf8')).digest('hex'));
  assert.throws(() => sourceKeyOf(''));
  assert.throws(() => sourceKeyOf(null));
});

test('kindOfUse and objectKeyOf follow the Worker reserve rule', () => {
  assert.equal(kindOfUse('product_image'), 'product_media');
  assert.equal(kindOfUse('collection_cover'), 'product_media');
  assert.equal(kindOfUse('page_image'), 'product_media');
  assert.equal(kindOfUse('branding'), 'shop_branding');
  assert.throws(() => kindOfUse('artwork'));
  const entry = copied();
  assert.equal(objectKeyOf(entry), `shops/shop-a/product_media/${entry.objectId}/v1/image.jpg`);
  assert.equal(
    objectKeyOf(copied({ use: 'branding', contentType: 'image/svg+xml' })),
    `shops/shop-a/shop_branding/${entry.objectId}/v1/image.svg`,
  );
  assert.equal(objectKeyOf(refused()), null);
  assert.equal(uploadFileName('text/html'), null);
});

test('upload file names are fixed points of the Worker safeFileName rule', () => {
  for (const type of ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp', 'image/x-icon']) {
    const name = uploadFileName(type);
    const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 100);
    assert.equal(cleaned, name);
  }
});

test('entryProblems: a valid copied and a valid refused entry pass', () => {
  assert.deepEqual(entryProblems(copied()), []);
  assert.deepEqual(entryProblems(refused()), []);
  assert.deepEqual(entryProblems(refused({ status: 'missing', reason: 'http_404', sha256: null, sizeBytes: 0, contentType: null })), []);
  assert.deepEqual(entryProblems(refused({ status: 'failed', reason: 'timeout', sha256: null, sizeBytes: 0, contentType: null })), []);
});

test('entryProblems: refuses what the format does not allow', () => {
  const cases = [
    ['unknown key', { ...copied(), address: ADDRESS }],
    ['missing key', (() => { const e = copied(); delete e.reason; return e; })()],
    ['bad sourceKey', copied({ sourceKey: 'ABC' })],
    ['upper-case sourceKey', copied({ sourceKey: 'A'.repeat(64) })],
    ['bad use', copied({ use: 'artwork' })],
    ['bad status', copied({ status: 'done' })],
    ['copied without objectId', copied({ objectId: null })],
    ['copied without sha256', copied({ sha256: null })],
    ['copied with zero size', copied({ sizeBytes: 0 })],
    ['copied with non-image type', copied({ contentType: 'text/html' })],
    ['copied with reason', copied({ reason: 'x' })],
    ['refused with objectId', refused({ objectId: 'x' })],
    ['refused without reason', refused({ reason: null })],
    ['negative size', refused({ sizeBytes: -1 })],
    ['fractional size', refused({ sizeBytes: 1.5 })],
    ['shopId with slash', copied({ shopId: 'a/b' })],
    ['empty shopId', copied({ shopId: '' })],
  ];
  for (const [label, entry] of cases) {
    assert.notDeepEqual(entryProblems(entry), [], label);
  }
});

test('copyManifestProblems: header and duplicates', () => {
  assert.deepEqual(copyManifestProblems(manifest()), []);
  const bad = [
    ['schemaVersion', { ...manifest(), schemaVersion: 2 }],
    ['env', { ...manifest(), env: 'dev' }],
    ['apiOrigin with path', { ...manifest(), apiOrigin: 'https://api.example.test/v1' }],
    ['apiOrigin not url', { ...manifest(), apiOrigin: 'nope' }],
    ['bundle sha', { ...manifest(), bundleManifestSha256: 'x' }],
    ['createdAt', { ...manifest(), createdAt: 'yesterday' }],
    ['entries', { ...manifest(), entries: {} }],
    ['unknown top key', { ...manifest(), extra: 1 }],
  ];
  for (const [label, value] of bad) assert.notDeepEqual(copyManifestProblems(value), [], label);
  const dup = manifest();
  dup.entries.push(copied(), refused());
  assert.ok(copyManifestProblems(dup).some((p) => p.includes('duplicate')));
  const twoShops = manifest();
  twoShops.entries.push(copied(), copied({ shopId: 'shop-b' }));
  assert.deepEqual(copyManifestProblems(twoShops), []);
});

test('upsertEntry replaces in place and validates', () => {
  const m = manifest();
  upsertEntry(m, refused());
  upsertEntry(m, copied({ sourceKey: sourceKeyOf('other') }));
  upsertEntry(m, copied());
  assert.equal(m.entries.length, 2);
  assert.equal(m.entries[0].status, 'copied');
  assert.throws(() => upsertEntry(m, copied({ objectId: null })));
});

test('lookups: by shop and key, by address, copied only', () => {
  const m = manifest();
  upsertEntry(m, copied());
  upsertEntry(m, refused({ shopId: 'shop-b' }));
  const index = indexCopyManifest(m);
  assert.equal(lookupEntry(index, 'shop-a', sourceKeyOf(ADDRESS)).status, 'copied');
  assert.equal(lookupAddress(index, 'shop-b', ADDRESS).status, 'refused');
  assert.equal(lookupCopied(index, 'shop-b', ADDRESS), null);
  assert.equal(lookupCopied(index, 'shop-a', ADDRESS).objectId, copied().objectId);
  assert.equal(lookupAddress(index, 'shop-c', ADDRESS), null);
  assert.equal(lookupAddress(index, 'shop-a', `${ADDRESS}x`), null);
});

test('write and read: atomic, round-trips, refuses an invalid manifest either way', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'copy-manifest-'));
  try {
    const file = path.join(dir, COPY_MANIFEST_FILE);
    const m = manifest();
    upsertEntry(m, copied());
    writeCopyManifest(file, m);
    assert.deepEqual(readCopyManifest(file), m);
    assert.deepEqual(readdirSync(dir), [COPY_MANIFEST_FILE]);
    assert.ok(!readFileSync(file, 'utf8').includes('files.example.test'));

    const broken = { ...m, entries: [copied({ objectId: null })] };
    assert.throws(() => writeCopyManifest(file, broken));
    assert.deepEqual(readCopyManifest(file), m, 'a refused write leaves the old file');

    writeFileSync(file, JSON.stringify(broken));
    assert.throws(() => readCopyManifest(file));
    writeFileSync(file, '{');
    assert.throws(() => readCopyManifest(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
