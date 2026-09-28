/**
 * scripts/cf-port/migrate/lib/copy-manifest.mjs — the ONE format the storage
 * copy (storage-copy.mjs, S1) writes and the row importer (S2) reads
 * (CP4_BRIEFS.md §S "The copy manifest"):
 *
 *   <out>/copy-manifest.json
 *   { schemaVersion: 1, env, apiOrigin, bundleManifestSha256, createdAt,
 *     entries: [ { shopId, sourceKey, use, status, objectId, sha256,
 *                  sizeBytes, contentType, reason } ] }
 *
 * One entry per (shopId, sourceKey): one file, one object, many rows. The
 * manifest never holds a source address, only `sourceKey` = sha256 (hex) of
 * the address exactly as the bundle holds it. A reader hashes the address a
 * row holds (`sourceKeyOf`) and looks it up by shop (`lookupCopied`).
 *
 * `use` is the use the file was first found under, in the fixed order of
 * USES; a file named by rows of two uses is still one entry and one object.
 * The object's kind follows from its use (`kindOfUse`), and the object's
 * storage key is fixed by the Worker's reserve rule
 * (`shops/<tenant>/<kind>/<objectId>/v1/<file name>`) with the file name the
 * copy sends (`uploadFileName`), so `objectKeyOf` gives a reader the key
 * without a field of its own. The copy checks that the Worker answered
 * exactly this key before it records an entry as copied.
 *
 * Writes are atomic: the JSON is written beside the target and renamed over
 * it, so a reader never sees half a manifest.
 */

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export const COPY_MANIFEST_FILE = 'copy-manifest.json';
export const COPY_MANIFEST_SCHEMA_VERSION = 1;

export const USES = Object.freeze(['product_image', 'collection_cover', 'branding', 'page_image']);
export const STATUSES = Object.freeze(['copied', 'refused', 'missing', 'failed']);
export const ENVS = Object.freeze(['staging', 'production']);

// The kind the Worker stores a file of each use under: every storefront read
// of a product, collection or page image asks for `product_media`, the store
// identity's images for `shop_branding` (cloudflare/src/catalog/*,
// src/content/pages.ts, src/storefront/public-storefront.ts).
const KIND_BY_USE = Object.freeze({
  product_image: 'product_media',
  collection_cover: 'product_media',
  page_image: 'product_media',
  branding: 'shop_branding',
});

// The file name the copy sends with every reservation, by the proven type.
// Each passes the Worker's safeFileName() unchanged ([a-z0-9._-], no leading
// dot), so it is the key's last segment as is.
const FILE_NAME_BY_TYPE = Object.freeze({
  'image/avif': 'image.avif',
  'image/gif': 'image.gif',
  'image/jpeg': 'image.jpg',
  'image/png': 'image.png',
  'image/svg+xml': 'image.svg',
  'image/webp': 'image.webp',
  'image/x-icon': 'image.ico',
  'image/vnd.microsoft.icon': 'image.ico',
});

const HEX64 = /^[0-9a-f]{64}$/;
const ENTRY_KEYS = Object.freeze([
  'shopId',
  'sourceKey',
  'use',
  'status',
  'objectId',
  'sha256',
  'sizeBytes',
  'contentType',
  'reason',
]);
const TOP_KEYS = Object.freeze([
  'schemaVersion',
  'env',
  'apiOrigin',
  'bundleManifestSha256',
  'createdAt',
  'entries',
]);

/** sha256 (hex) of a source address exactly as the bundle holds it (UTF-8). */
export function sourceKeyOf(address) {
  if (typeof address !== 'string' || address.length === 0) {
    throw new TypeError('sourceKeyOf: address must be a non-empty string');
  }
  return createHash('sha256').update(address, 'utf8').digest('hex');
}

export function kindOfUse(use) {
  const kind = KIND_BY_USE[use];
  if (kind === undefined) throw new TypeError(`kindOfUse: unknown use ${String(use)}`);
  return kind;
}

/** The file name the copy reserves an object of this type under, or null. */
export function uploadFileName(contentType) {
  return FILE_NAME_BY_TYPE[contentType] ?? null;
}

/**
 * The storage key of a copied entry's object (the Worker's reserve rule), or
 * null for an entry that is not copied. The public address is
 * `<PUBLIC_OBJECT_BASE_URL>/<key, each segment percent-encoded>`.
 */
export function objectKeyOf(entry) {
  if (!entry || entry.status !== 'copied') return null;
  const fileName = uploadFileName(entry.contentType);
  if (fileName === null) return null;
  return `shops/${entry.shopId}/${kindOfUse(entry.use)}/${entry.objectId}/v1/${fileName}`;
}

export function emptyCopyManifest({ env, apiOrigin, bundleManifestSha256, createdAt }) {
  return {
    schemaVersion: COPY_MANIFEST_SCHEMA_VERSION,
    env,
    apiOrigin,
    bundleManifestSha256,
    createdAt: createdAt ?? new Date().toISOString(),
    entries: [],
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** The problems of one entry, as short strings; [] = valid. */
export function entryProblems(entry) {
  if (!isPlainObject(entry)) return ['entry is not an object'];
  const problems = [];
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.includes(key)) problems.push(`unknown key ${key}`);
  }
  for (const key of ENTRY_KEYS) {
    if (!(key in entry)) problems.push(`missing key ${key}`);
  }
  if (problems.length > 0) return problems;

  if (!nonEmptyString(entry.shopId) || entry.shopId.includes('/')) problems.push('shopId');
  if (typeof entry.sourceKey !== 'string' || !HEX64.test(entry.sourceKey)) problems.push('sourceKey');
  if (!USES.includes(entry.use)) problems.push('use');
  if (!STATUSES.includes(entry.status)) problems.push('status');
  if (entry.sha256 !== null && (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256))) {
    problems.push('sha256');
  }
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) problems.push('sizeBytes');
  if (entry.contentType !== null && !nonEmptyString(entry.contentType)) problems.push('contentType');
  if (entry.reason !== null && !nonEmptyString(entry.reason)) problems.push('reason');

  if (entry.status === 'copied') {
    if (!nonEmptyString(entry.objectId) || entry.objectId.includes('/')) problems.push('copied needs objectId');
    if (entry.sha256 === null) problems.push('copied needs sha256');
    if (entry.sizeBytes < 1) problems.push('copied needs sizeBytes');
    if (uploadFileName(entry.contentType) === null) problems.push('copied needs an image contentType');
    if (entry.reason !== null) problems.push('copied has no reason');
  } else if (STATUSES.includes(entry.status)) {
    if (entry.objectId !== null) problems.push('only copied has objectId');
    if (entry.reason === null) problems.push(`${entry.status} needs reason`);
  }
  return problems;
}

/** The problems of a whole manifest, as short strings; [] = valid. */
export function copyManifestProblems(manifest) {
  if (!isPlainObject(manifest)) return ['manifest is not an object'];
  const problems = [];
  for (const key of Object.keys(manifest)) {
    if (!TOP_KEYS.includes(key)) problems.push(`unknown key ${key}`);
  }
  if (manifest.schemaVersion !== COPY_MANIFEST_SCHEMA_VERSION) problems.push('schemaVersion');
  if (!ENVS.includes(manifest.env)) problems.push('env');
  if (!isOrigin(manifest.apiOrigin)) problems.push('apiOrigin');
  if (typeof manifest.bundleManifestSha256 !== 'string' || !HEX64.test(manifest.bundleManifestSha256)) {
    problems.push('bundleManifestSha256');
  }
  if (!isIsoTime(manifest.createdAt)) problems.push('createdAt');
  if (!Array.isArray(manifest.entries)) {
    problems.push('entries');
    return problems;
  }
  // Plain objects, not Map/Set: test/no-write-calls.test.mjs forbids write-shaped
  // method calls (set, add) anywhere in lib/.
  const seen = Object.create(null);
  manifest.entries.forEach((entry, index) => {
    for (const problem of entryProblems(entry)) problems.push(`entries[${index}]: ${problem}`);
    if (isPlainObject(entry)) {
      const key = `${entry.shopId}\n${entry.sourceKey}`;
      if (seen[key] === true) problems.push(`entries[${index}]: duplicate (shopId, sourceKey)`);
      seen[key] = true;
    }
  });
  return problems;
}

export function assertValidCopyManifest(manifest) {
  const problems = copyManifestProblems(manifest);
  if (problems.length > 0) {
    throw new Error(`copy manifest is not valid: ${problems.slice(0, 10).join('; ')}`);
  }
  return manifest;
}

/** Reads and validates; throws on a missing file, bad JSON or a bad shape. */
export function readCopyManifest(filePath) {
  return assertValidCopyManifest(JSON.parse(readFileSync(filePath, 'utf8')));
}

/** Validates, then writes beside the target and renames over it. */
export function writeCopyManifest(filePath, manifest) {
  assertValidCopyManifest(manifest);
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
}

/**
 * An index for lookups: Map `${shopId}\n${sourceKey}` → entry. Built once by
 * a reader; entries are the manifest's own objects.
 */
export function indexCopyManifest(manifest) {
  return new Map(manifest.entries.map((entry) => [`${entry.shopId}\n${entry.sourceKey}`, entry]));
}

/** The entry for (shopId, sourceKey), or null. */
export function lookupEntry(index, shopId, sourceKey) {
  return index.get(`${shopId}\n${sourceKey}`) ?? null;
}

/** The entry for the address a row of `shopId` holds, or null. */
export function lookupAddress(index, shopId, address) {
  return lookupEntry(index, shopId, sourceKeyOf(address));
}

/** The entry for that address only when it is `copied`, else null. */
export function lookupCopied(index, shopId, address) {
  const entry = lookupAddress(index, shopId, address);
  return entry !== null && entry.status === 'copied' ? entry : null;
}

/**
 * Puts `entry` into the manifest, replacing the entry of the same
 * (shopId, sourceKey) in place, or appending it. Validates the entry.
 */
export function upsertEntry(manifest, entry) {
  const problems = entryProblems(entry);
  if (problems.length > 0) throw new Error(`copy manifest entry is not valid: ${problems.join('; ')}`);
  const at = manifest.entries.findIndex(
    (existing) => existing.shopId === entry.shopId && existing.sourceKey === entry.sourceKey,
  );
  if (at === -1) manifest.entries.push(entry);
  else manifest.entries[at] = entry;
  return manifest;
}
