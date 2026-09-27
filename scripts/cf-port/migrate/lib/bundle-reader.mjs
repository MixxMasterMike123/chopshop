/**
 * scripts/cf-port/migrate/lib/bundle-reader.mjs — reads an export bundle
 * (written by scripts/cf-port/migrate/export.mjs) back into plain JS
 * documents: `{ path, id, createTime, updateTime, data }` with `data` already
 * decoded (typed-json.mjs decode()) so callers see ordinary Firestore-shaped
 * values (Timestamp-like instances, Buffers, etc. — see typed-json.mjs).
 *
 * Read-only: this module never writes anything.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decode } from './typed-json.mjs';

function sha256HexOfFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** sha256 of the bundle's own SHA256SUMS file (C2's "bundle sha"). */
export function bundleSha(bundleDir) {
  return sha256HexOfFile(path.join(bundleDir, 'SHA256SUMS'));
}

export function readRootManifest(bundleDir) {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/**
 * Reads every document of one collection directory (a manifest-listed
 * top-level collection, a flattened subcollection directory, or the
 * `settings` collection) by reading its part-*.jsonl files in the order its
 * own manifest.json lists them. Returns decoded documents:
 *   [{ path, id, createTime, updateTime, data }]
 * Returns [] if the collection directory does not exist (an absent
 * collection — the manifest's plan records docCount 0 / absent: true for it).
 */
export function readCollection(bundleDir, collectionName) {
  const dir = path.join(bundleDir, collectionName);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(dir) || !existsSync(manifestPath)) {
    return [];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const docs = [];
  for (const part of manifest.parts ?? []) {
    const content = readFileSync(path.join(dir, part.file), 'utf8');
    if (content.length === 0) continue;
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      const raw = JSON.parse(line);
      docs.push({ ...raw, data: decode(raw.data) });
    }
  }
  return docs;
}

/** Reads `_auth/users.jsonl` (plain objects; Auth records carry no Firestore
 * typed values, so no decode() is needed). */
export function readAuthUsers(bundleDir) {
  const authPath = path.join(bundleDir, '_auth', 'users.jsonl');
  if (!existsSync(authPath)) return [];
  const content = readFileSync(authPath, 'utf8');
  if (content.length === 0) return [];
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Reads the `settings` collection and groups its documents by id (each
 * settings doc id has its own manifest row, so callers pick the ones they
 * want by id: `platform`, `printRouting`, `podProfiles`, `contentScreening`).
 */
export function readSettingsDocs(bundleDir) {
  const docs = readCollection(bundleDir, 'settings');
  const byId = {};
  for (const doc of docs) {
    byId[doc.id] = doc;
  }
  return byId;
}

/** Reads a flattened subcollection directory, e.g. `shops__legalAcceptances`. */
export function readSubcollection(bundleDir, flattenedName) {
  return readCollection(bundleDir, flattenedName);
}

/** Lists every top-level collection directory name actually present in the
 * bundle (excludes `_auth`, `_verify`, `_maps`, `_storage`, and files at the
 * bundle root such as manifest.json / SHA256SUMS). Useful for a diagnostic
 * "what's in this bundle" listing; not required for the fixed-shape reads
 * above. */
export function listBundleCollectionDirs(bundleDir) {
  return readdirSync(bundleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}
