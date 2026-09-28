/**
 * scripts/cf-port/migrate/test/catalogue-fixtures.mjs — what the catalogue
 * tests (and the rehearsal on the real bundle) share: a migrated node:sqlite
 * database, query results written in the shape of `wrangler d1 execute
 * --json`, an INVENTED copy manifest that marks every file of a bundle as
 * copied, the stored_objects rows the copy would have made through the
 * Worker, and an invented bundle with a catalogue. All data invented.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectCopySources } from '../lib/copy-sources.mjs';
import { kindOfUse, objectKeyOf } from '../lib/copy-manifest.mjs';
import { buildFixtureBundle } from './fixtures.mjs';
import { FakeTimestamp } from './fake-firestore.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'cloudflare', 'migrations');

export let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A database with every migration applied, in name order. */
export function migratedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

/** Runs each query and writes `<dir>/<file>.json` as wrangler's --json prints it. */
export function writeQueryResults(db, queries, dir) {
  for (const query of queries) {
    const rows = db.prepare(query.sql).all().map((row) => ({ ...row }));
    writeFileSync(path.join(dir, `${query.file}.json`), `${JSON.stringify([{ meta: {}, results: rows, success: true }])}\n`);
  }
}

/**
 * A copy manifest in the format of lib/copy-manifest.mjs, INVENTED: every
 * source of the bundle `copied` (or the status `statusOf(source)` answers),
 * with an object id derived from the source key.
 */
export function inventCopyManifest(bundleDir, { env = 'staging', statusOf = () => 'copied', contentTypeOf = () => 'image/jpeg' } = {}) {
  const { sources } = collectCopySources(bundleDir);
  const entries = sources.map((source) => {
    const status = statusOf(source);
    const copied = status === 'copied';
    return {
      contentType: copied ? contentTypeOf(source) : null,
      objectId: copied ? `obj-${sha(`${source.shopId}\n${source.sourceKey}`).slice(0, 24)}` : null,
      reason: copied ? null : status === 'refused' ? 'type_not_admitted' : status === 'missing' ? 'http_404' : 'timeout',
      sha256: copied ? sha(`bytes:${source.sourceKey}`) : null,
      shopId: source.shopId,
      sizeBytes: copied ? 1234 : 0,
      sourceKey: source.sourceKey,
      status,
      use: source.use,
    };
  });
  return {
    apiOrigin: 'https://api.invalid',
    bundleManifestSha256: sha(readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')),
    createdAt: '2026-09-28T00:00:00.000Z',
    entries,
    env,
    schemaVersion: 1,
  };
}

/** The stored_objects rows the Worker's object routes would have written for the copied entries. */
export function insertCopiedObjects(db, manifest, { nowMillis = Date.parse('2026-09-28T00:00:00.000Z') } = {}) {
  const tenants = new Set(db.prepare('SELECT tenant_id FROM tenants').all().map((r) => r.tenant_id));
  const insert = db.prepare(
    `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind, content_type, size_bytes, sha256, status, immutable, created_at, updated_at)
     VALUES (?, ?, 'public', ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
  );
  let n = 0;
  for (const entry of manifest.entries) {
    if (entry.status !== 'copied' || !tenants.has(entry.shopId)) continue;
    insert.run(entry.objectId, entry.shopId, objectKeyOf(entry), kindOfUse(entry.use), entry.contentType, entry.sizeBytes, entry.sha256, nowMillis, nowMillis);
    n += 1;
  }
  return n;
}

// An invented host; the bucket's name carries a marker of the source's storage (as S1's tests do).
const STORAGE = 'https://files.example.test/v0/b/fixture-bucket.firebasestorage.app/o';
export const img = (name) => `${STORAGE}/${encodeURIComponent(`products/${name}`)}?alt=media&token=t-${name}`;

/**
 * The CP3 fixture bundle plus an invented catalogue for test-shop-a:
 * p-plain (published, 2 own images, a tag, a category, carriage), p-rail
 * (published, 2 colours × 2 sizes with a photo each colour), p-draft
 * (inactive), p-pod (published POD), p-free (price 0); two collections (manual
 * with a dangling member, smart); two pages (one clean with a storage image,
 * one with a script); a branding logo and hero.
 */
export async function buildCatalogueBundle(bundleDir, { patch = null } = {}) {
  await buildFixtureBundle(bundleDir, {
    schemaPatch(schema) {
      const shop = schema.shops['test-shop-a'].data;
      shop.storeIdentity.logoUrl = img('logo.png');
      shop.storeIdentity.heroImageUrl = img('hero.png');
      shop.storeIdentity.gallery = [{ imageUrl: img('tile.png'), label: 'Tile', linkSku: 'PLAIN-1' }];
      const ts = FakeTimestamp.fromDate(new Date('2026-01-10T00:00:00.000Z'));
      const base = {
        availability: { b2c: true },
        b2cImageGallery: [],
        b2cImageUrl: '',
        basePrice: 100,
        b2cPrice: 100,
        createdAt: ts,
        delivery: { pickup: false, shipping: true },
        descriptions: { b2c: 'A description.', b2cMoreInfo: '<p>More <strong>info</strong></p>' },
        imageUrl: '',
        isActive: true,
        shipping: { eu: { cost: 0, service: 'x' }, nordic: { cost: 0, service: 'x' }, sweden: { cost: 49, service: 'x' }, worldwide: { cost: 0, service: 'x' } },
        shopId: 'test-shop-a',
        tags: [],
        updatedAt: ts,
        weight: { unit: 'g', value: 250 },
      };
      schema.products = {
        'p-plain': { data: { ...base, b2cImageGallery: [img('plain-2.jpg')], b2cImageUrl: img('plain-1.jpg'), category: 'Tröjor', featured: true, name: 'Plain Tee', sku: 'PLAIN-1', tags: ['Nyhet', 'nyhet', ''], compareAtPrice: 149.5 } },
        'p-rail': {
          data: {
            ...base,
            b2cImageUrl: img('rail-main.jpg'),
            name: 'Rail Hoodie',
            sku: 'RAIL-1',
            variantGroups: [
              { image: img('black.jpg'), images: [img('black.jpg'), img('black-2.jpg')], label: 'Svart', price: null, sizes: ['S', 'M'], sku: 'RAIL-1-BLK' },
              { image: img('white.jpg'), images: [img('white.jpg')], label: 'Vit', price: null, sizes: ['S', 'M'], sku: 'RAIL-1-WHT' },
            ],
            variants: [
              { group: 'Svart', image: img('black.jpg'), images: [img('black.jpg'), img('black-2.jpg')], label: 'Svart / S', price: 100, size: 'S', sku: 'RAIL-1-BLK-S' },
              { group: 'Svart', image: img('black.jpg'), images: [img('black.jpg'), img('black-2.jpg')], label: 'Svart / M', price: 100, size: 'M', sku: 'RAIL-1-BLK-M' },
              { group: 'Vit', image: img('white.jpg'), images: [img('white.jpg')], label: 'Vit / S', price: 90, size: 'S', sku: 'RAIL-1-WHT-S' },
              { group: 'Vit', image: img('white.jpg'), images: [img('white.jpg')], label: 'Vit / M', price: 90.5, size: 'M', sku: 'RAIL-1-WHT-M' },
            ],
          },
        },
        'p-draft': { data: { ...base, availability: { b2c: false }, delivery: null, isActive: false, name: 'Draft Cap', sku: 'DRAFT-1' } },
        'p-pod': { data: { ...base, b2cImageUrl: img('pod.jpg'), isPodProduct: true, name: 'Pod Print', sku: 'POD-1' } },
        'p-free': { data: { ...base, b2cPrice: 0, basePrice: 0, name: 'Free Sticker', sku: 'FREE-1', descriptions: { b2c: 'Mail us at shopowner@example.com', b2cMoreInfo: '' } } },
      };
      schema.collections = {
        'c-manual': { data: { createdAt: ts, description: '', featured: true, handle: 'favoriter', imageUrl: img('cover.jpg'), productIds: ['p-rail', 'p-missing', 'p-plain', 'p-rail'], published: true, rule: { tag: '' }, shopId: 'test-shop-a', sortOrder: 2, title: 'Favoriter', type: 'manual', updatedAt: ts } },
        'c-smart': { data: { description: 'New things', featured: false, handle: 'nyheter', imageUrl: '', productIds: ['p-plain'], published: true, rule: { tag: 'Nyhet' }, shopId: 'test-shop-a', sortOrder: null, title: 'Nyheter', type: 'smart', updatedAt: ts } },
      };
      schema.pages = {
        'pg-about': { data: { attachments: [], content: { 'sv-SE': `<h2>Om oss</h2><p>Hej</p><img src="${img('page.jpg').replaceAll('&', '&amp;')}" alt="x"><img src="${img('gone.jpg')}">` }, createdAt: ts, createdBy: 'tenantadmin1', metaDescription: 'About us', metaTitle: '', shopId: 'test-shop-a', slug: 'om-oss', status: 'published', title: { 'sv-SE': 'Om oss' }, updatedAt: ts, updatedBy: 'nobody' } },
        'pg-bad': { data: { attachments: [{ name: 'a.pdf' }], content: { 'sv-SE': '<p>x</p><script>alert(1)</script>' }, createdAt: ts, shopId: 'test-shop-a', slug: 'bad', status: 'draft', title: { 'sv-SE': 'Bad' }, updatedAt: ts } },
      };
      if (patch) patch(schema);
    },
  });
}
