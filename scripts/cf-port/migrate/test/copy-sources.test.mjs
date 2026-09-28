import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  collectCopySources,
  fetchAddressOf,
  isFetchable,
  isSourceStorageAddress,
  loadWorkerModule,
  SOURCE_STORAGE_MARKERS,
  sourceAddressesInHtml,
} from '../lib/copy-sources.mjs';
import { sourceKeyOf } from '../lib/copy-manifest.mjs';
import { REPO_ROOT } from '../lib/api-session.mjs';
import { writeTestBundle } from './fake-staging-api.mjs';

const SRC = 'https://files.example.test/v0/b/test-bucket.firebasestorage.app/o';

test('SOURCE_STORAGE_MARKERS equals the Worker list (tenant-config.ts)', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'cloudflare/src/platform/tenant-config.ts'), 'utf8');
  const block = /const SOURCE_STORAGE_MARKERS = \[([\s\S]*?)\] as const;/.exec(source);
  assert.ok(block, 'the Worker list is where the pin expects it');
  const live = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...SOURCE_STORAGE_MARKERS], live);
});

test('isSourceStorageAddress: markers anywhere, percent-escapes decoded, case-insensitive', () => {
  assert.equal(isSourceStorageAddress(`${SRC}/x.png?alt=media`), true);
  assert.equal(isSourceStorageAddress('https://STORAGE.GOOGLEAPIS.COM/bucket/x.png'), true);
  assert.equal(isSourceStorageAddress('https://x%2Eappspot%2Ecom/y'), true);
  assert.equal(isSourceStorageAddress('gs://bucket/x.png'), true);
  assert.equal(isSourceStorageAddress('/images/logo.png'), false);
  assert.equal(isSourceStorageAddress('https://cdn.example.test/x.png'), false);
  assert.equal(isSourceStorageAddress(null), false);
});

test('fetchAddressOf and isFetchable', () => {
  assert.equal(fetchAddressOf(`${SRC}/x.png?alt=media&amp;token=t`), `${SRC}/x.png?alt=media&token=t`);
  assert.equal(fetchAddressOf(`${SRC}/x.png?alt=media&token=t`), `${SRC}/x.png?alt=media&token=t`);
  assert.equal(isFetchable(`${SRC}/x.png`), true);
  assert.equal(isFetchable('gs://bucket/x.png'), false);
});

test('sourceAddressesInHtml: attributes, srcset, url(), raw text, de-duplicated, only source storage', () => {
  const html = [
    `<img src="${SRC}/a.png?alt=media&amp;token=1" alt="">`,
    `<img src='${SRC}/b.png'>`,
    `<img srcset="${SRC}/c.png 1x, ${SRC}/d.png 2x">`,
    `<div style="background:url('${SRC}/e.png')"></div>`,
    `<a href="${SRC}/a.png?alt=media&amp;token=1">again</a>`,
    '<img src="https://cdn.example.test/other.png">',
    `<p>${SRC}/text-only.png</p>`,
  ].join('');
  assert.deepEqual(sourceAddressesInHtml(html), [
    `${SRC}/a.png?alt=media&amp;token=1`,
    `${SRC}/b.png`,
    `${SRC}/c.png`,
    `${SRC}/d.png`,
    `${SRC}/e.png`,
  ]);
  assert.deepEqual(sourceAddressesInHtml(''), []);
  assert.deepEqual(sourceAddressesInHtml(null), []);
});

test('collectCopySources: fields per use, one source per (shop, address), counts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'copy-sources-'));
  try {
    writeTestBundle(dir, {
      collections: [
        { data: { imageUrl: `${SRC}/cover.png`, shopId: 's1' }, id: 'c1' },
        { data: { imageUrl: `${SRC}/shared.png`, shopId: 's1' }, id: 'c2' },
      ],
      pages: [{ data: { attachments: [{}], content: `<img src="${SRC}/page.png">`, shopId: 's1' }, id: 'p1' }],
      products: [
        {
          data: {
            b2cImageGallery: [`${SRC}/g1.png`, '', `${SRC}/g2.png`],
            b2cImageUrl: `${SRC}/shared.png`,
            imageUrl: `${SRC}/shared.png`,
            shopId: 's1',
            variantGroups: [{ image: `${SRC}/vg.png`, images: [`${SRC}/vg2.png`] }],
            variants: [{ image: 'https://cdn.example.test/v.png', images: [`${SRC}/v1.png`] }],
          },
          id: 'p1',
        },
        { data: { b2cImageUrl: `${SRC}/shared.png`, shopId: 's2' }, id: 'p2' },
        { data: { b2cImageUrl: `${SRC}/orphan.png` }, id: 'p3' },
      ],
      shops: [
        {
          data: {
            storeIdentity: {
              emailLogoUrl: `${SRC}/mail.png`,
              faviconUrl: '/images/favicon.ico',
              gallery: [{ imageUrl: `${SRC}/tile.png` }, { label: 'x' }],
              heroImageUrl: `${SRC}/hero.png`,
              logoUrl: `${SRC}/logo.png`,
              social: { website: 'https://example.test' },
            },
          },
          id: 's1',
        },
        { data: {}, id: 's2' },
      ],
    });
    const { counts, sources } = collectCopySources(dir);
    const s1 = sources.filter((source) => source.shopId === 's1');
    const byUse = (use) => s1.filter((source) => source.use === use).length;
    assert.equal(byUse('product_image'), 6); // shared, g1, g2, vg, vg2, v1
    assert.equal(byUse('collection_cover'), 1); // cover (shared is a product image first)
    assert.equal(byUse('branding'), 4);
    assert.equal(byUse('page_image'), 1);
    const shared = s1.find((source) => source.sourceKey === sourceKeyOf(`${SRC}/shared.png`));
    assert.deepEqual(shared.uses, ['product_image', 'collection_cover']);
    assert.equal(shared.references, 3);
    assert.equal(sources.filter((source) => source.shopId === 's2').length, 1, 'the same address in another shop is its own source');
    assert.equal(counts.rowsWithoutShop, 1);
    assert.equal(counts.pageAttachments, 1);
    assert.deepEqual(counts.notSourceStorage.s1, { branding: 1, product_image: 1 });
    // Deterministic order: shop, use, sourceKey.
    const again = collectCopySources(dir).sources.map((source) => source.sourceKey);
    assert.deepEqual(sources.map((source) => source.sourceKey), again);
    assert.deepEqual(
      collectCopySources(dir, { shop: 's2' }).sources.map((source) => source.shopId),
      ['s2'],
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('loadWorkerModule: the Worker sniff and HTML check run under Node', async () => {
  const sniff = await loadWorkerModule('storage/image-sniff.ts');
  assert.equal(sniff.sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniff.sniffImageType(new Uint8Array([0x3c, 0x73, 0x76, 0x67])), null);
  const html = await loadWorkerModule('content/html-refusal.ts');
  assert.equal(html.checkHtml('<p>ok</p>').ok, true);
  assert.equal(html.checkHtml('<script>x</script>').ok, false);
  await assert.rejects(loadWorkerModule('storage/object-routes.ts'), /imports other modules/);
});
