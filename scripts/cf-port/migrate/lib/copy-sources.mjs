/**
 * scripts/cf-port/migrate/lib/copy-sources.mjs — which addresses of the export
 * bundle name a FILE of the source's storage, per shop and use (CP4_BRIEFS.md
 * §S1). Read-only; nothing here makes a request.
 *
 * The fields are the ones the row importer (S2) reads:
 *   product_image     products: b2cImageUrl, b2cImageGallery[], imageUrl,
 *                     variants[].image, variants[].images[],
 *                     variantGroups[].image, variantGroups[].images[]
 *   collection_cover  collections: imageUrl
 *   branding          shops: storeIdentity.logoUrl, heroImageUrl, faviconUrl,
 *                     emailLogoUrl, gallery[].imageUrl
 *   page_image        pages: every source-storage address inside the HTML of
 *                     `content` (a string, or a map of language → string),
 *                     as `sourceAddressesInHtml` finds it
 *
 * An address is taken EXACTLY as the bundle holds it: its sha256 is the
 * manifest's `sourceKey` (copy-manifest.mjs). Inside HTML that is the raw
 * attribute or url() text, entities undecoded; `fetchAddressOf` decodes the
 * few entities an address can carry before it is fetched.
 *
 * One source = one (shopId, address); `use` is the first use it was found
 * under in the order of USES, `uses` all of them. An address that is not of the
 * source's storage (another host, a root path, a data: URI) is never copied and
 * only counted.
 *
 * Also here: `loadWorkerModule`, which imports one self-contained module of
 * cloudflare/src (no imports of its own, types only) under plain Node, so the
 * Worker's pure rules (image-sniff.ts, content/html-refusal.ts) run here as
 * they run in the Worker: one copy of each rule.
 */

import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { readCollection } from './bundle-reader.mjs';
import { sourceKeyOf, USES } from './copy-manifest.mjs';
import { REPO_ROOT } from './api-session.mjs';

/**
 * Must equal cloudflare/src/platform/tenant-config.ts SOURCE_STORAGE_MARKERS
 * (pinned by test/copy-sources.test.mjs).
 */
export const SOURCE_STORAGE_MARKERS = Object.freeze([
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  'firebasestorage.app',
  '.appspot.com',
  'gs://',
]);

/** The Worker's isSourceStorageAddress, restated (same decode, same markers). */
export function isSourceStorageAddress(value) {
  if (typeof value !== 'string') return false;
  const plain = value
    .replace(/%([0-7][0-9a-f])/gi, (_escape, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .toLowerCase();
  return SOURCE_STORAGE_MARKERS.some((marker) => plain.includes(marker));
}

const HTML_ENTITIES = { '&amp;': '&', '&#38;': '&', '&#x26;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

/** The address to fetch: HTML entities an attribute may carry decoded. */
export function fetchAddressOf(address) {
  return address.replace(/&(?:amp|quot|apos|#38|#x26|#39);/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity);
}

/** May the copy fetch this address at all (http or https)? */
export function isFetchable(address) {
  try {
    const url = new URL(fetchAddressOf(address));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Every source-storage address inside an HTML text, in order of appearance,
 * de-duplicated: the values of src, href, poster and data-src attributes,
 * every candidate of a srcset, and every CSS url(…). Raw text, entities as
 * they stand. S2 finds page images with this same function.
 */
export function sourceAddressesInHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const found = [];
  const add = (candidate) => {
    const value = candidate.trim();
    if (value.length > 0 && isSourceStorageAddress(value) && !found.includes(value)) found.push(value);
  };
  const attribute = /\s(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (const match of html.matchAll(attribute)) add(match[1] ?? match[2] ?? match[3] ?? '');
  const srcset = /\s(?:srcset|data-srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of html.matchAll(srcset)) {
    for (const candidate of (match[1] ?? match[2] ?? '').split(',')) add(candidate.trim().split(/\s+/)[0] ?? '');
  }
  const cssUrl = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;
  for (const match of html.matchAll(cssUrl)) add(match[1] ?? match[2] ?? match[3] ?? '');
  return found;
}

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string');
  return [];
}

function productAddresses(data) {
  const out = [...strings(data.b2cImageUrl), ...strings(data.b2cImageGallery), ...strings(data.imageUrl)];
  for (const list of [data.variants, data.variantGroups]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      out.push(...strings(entry.image), ...strings(entry.images));
    }
  }
  return out;
}

function brandingAddresses(identity) {
  if (identity === null || typeof identity !== 'object') return [];
  const out = [];
  for (const key of ['logoUrl', 'heroImageUrl', 'faviconUrl', 'emailLogoUrl']) out.push(...strings(identity[key]));
  if (Array.isArray(identity.gallery)) {
    for (const tile of identity.gallery) {
      if (tile !== null && typeof tile === 'object') out.push(...strings(tile.imageUrl));
    }
  }
  return out;
}

function pageHtmlTexts(content) {
  if (typeof content === 'string') return [content];
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    return Object.keys(content)
      .sort()
      .map((key) => content[key])
      .filter((value) => typeof value === 'string');
  }
  return [];
}

function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

/**
 * Reads the bundle and answers:
 *   sources  [{ shopId, address, sourceKey, use, uses, references }], sorted by
 *            shop, then use (USES order), then sourceKey; one per (shop, address)
 *   counts   { references: {shop: {use: n}}, sourceReferences: {…},
 *              notSourceStorage: {shop: {use: n}}, notFetchable: {…},
 *              rowsWithoutShop: n, pageAttachments: n }
 * `shop` limits everything to one shop id.
 */
export function collectCopySources(bundleDir, { shop = null } = {}) {
  // A plain object, not a Map: test/no-write-calls.test.mjs forbids a set call in lib/.
  const byKey = Object.create(null);
  const counts = {
    notFetchable: {},
    notSourceStorage: {},
    pageAttachments: 0,
    references: {},
    rowsWithoutShop: 0,
    sourceReferences: {},
  };

  const note = (shopId, use, address) => {
    if (typeof address !== 'string' || address.trim().length === 0) return;
    counts.references[shopId] ??= {};
    bump(counts.references[shopId], use);
    if (!isSourceStorageAddress(address)) {
      counts.notSourceStorage[shopId] ??= {};
      bump(counts.notSourceStorage[shopId], use);
      return;
    }
    counts.sourceReferences[shopId] ??= {};
    bump(counts.sourceReferences[shopId], use);
    const key = `${shopId}\n${address}`;
    const existing = byKey[key];
    if (existing) {
      existing.references += 1;
      if (!existing.uses.includes(use)) existing.uses.push(use);
      return;
    }
    if (!isFetchable(address)) {
      counts.notFetchable[shopId] ??= {};
      bump(counts.notFetchable[shopId], use);
    }
    byKey[key] = { address, references: 1, shopId, sourceKey: sourceKeyOf(address), uses: [use] };
  };

  const shopIdOf = (doc) => {
    const value = doc.data?.shopId;
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const wanted = (shopId) => shop === null || shopId === shop;

  for (const doc of readCollection(bundleDir, 'products')) {
    const shopId = shopIdOf(doc);
    if (shopId === null) {
      counts.rowsWithoutShop += 1;
      continue;
    }
    if (!wanted(shopId)) continue;
    for (const address of productAddresses(doc.data)) note(shopId, 'product_image', address);
  }
  for (const doc of readCollection(bundleDir, 'collections')) {
    const shopId = shopIdOf(doc);
    if (shopId === null) {
      counts.rowsWithoutShop += 1;
      continue;
    }
    if (!wanted(shopId)) continue;
    for (const address of strings(doc.data?.imageUrl)) note(shopId, 'collection_cover', address);
  }
  for (const doc of readCollection(bundleDir, 'shops')) {
    if (!wanted(doc.id)) continue;
    for (const address of brandingAddresses(doc.data?.storeIdentity)) note(doc.id, 'branding', address);
  }
  for (const doc of readCollection(bundleDir, 'pages')) {
    const shopId = shopIdOf(doc);
    if (shopId === null) {
      counts.rowsWithoutShop += 1;
      continue;
    }
    if (!wanted(shopId)) continue;
    if (Array.isArray(doc.data?.attachments)) counts.pageAttachments += doc.data.attachments.length;
    for (const html of pageHtmlTexts(doc.data?.content)) {
      for (const address of sourceAddressesInHtml(html)) note(shopId, 'page_image', address);
    }
  }

  const sources = Object.values(byKey)
    .map((source) => {
      const uses = [...source.uses].sort((a, b) => USES.indexOf(a) - USES.indexOf(b));
      return { ...source, use: uses[0], uses };
    })
    .sort(
      (a, b) =>
        (a.shopId < b.shopId ? -1 : a.shopId > b.shopId ? 1 : 0) ||
        USES.indexOf(a.use) - USES.indexOf(b.use) ||
        (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0),
    );
  return { counts, sources };
}

const workerModules = Object.create(null);

/**
 * Imports `cloudflare/src/<relativePath>` under plain Node: its types are
 * stripped (node:module stripTypeScriptTypes) and the result imported from a
 * data: URL. Only for a module with no imports of its own; one that has any is
 * refused rather than half-loaded.
 */
export async function loadWorkerModule(relativePath, { repoRoot = REPO_ROOT } = {}) {
  const file = path.join(repoRoot, 'cloudflare', 'src', relativePath);
  if (workerModules[file] === undefined) {
    const source = readFileSync(file, 'utf8');
    if (/^\s*import\s[^;]*?\bfrom\s*['"]/m.test(source.replace(/^\s*import\s+type\s[^;]*;/gm, ''))) {
      throw new Error(`loadWorkerModule: ${relativePath} imports other modules`);
    }
    const javascript = stripTypeScriptTypes(source);
    workerModules[file] = import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
  }
  return workerModules[file];
}
