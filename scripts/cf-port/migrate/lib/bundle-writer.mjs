/**
 * scripts/cf-port/migrate/lib/bundle-writer.mjs — writes a collection's
 * part-NNNNN.jsonl files (rotated at a byte limit), computes their sha256,
 * and writes SHA256SUMS + manifest.json, per
 * docs/cf-port/MIGRATION_MANIFEST.md §(c).
 *
 * No Firebase import here: everything takes plain JS values so tests can
 * drive it without firebase-admin.
 *
 * File modes: every directory this module creates is mode 0700, every file
 * mode 0600 (hard rule: no secrets/PII readable by anyone else on the export
 * host).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { canonicalStringify } from './typed-json.mjs';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_MAX_PART_BYTES = 64 * 1024 * 1024; // 64 MB, per §(c)

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  // mkdirSync's mode is only reliably honoured for the FINAL segment on some
  // platforms/umasks (any parent segments it also had to create may end up
  // with a laxer mode); force it explicitly on the directory itself.
  // REVIEW ROUND 1 FIX 9: removed a dead "walk up collecting non-existent
  // ancestors" loop that ran AFTER mkdirSync had already created them all —
  // existsSync(current) was therefore always true and the loop never added
  // anything. The final chmodSync below is the only chmod that ever did
  // anything; kept as-is.
  chmodSync(dirPath, DIR_MODE);
}

function writeFileSecure(filePath, content) {
  writeFileSync(filePath, content, { mode: FILE_MODE });
  chmodSync(filePath, FILE_MODE);
}

/**
 * Writes one collection's documents to `<collectionDir>/part-NNNNN.jsonl`,
 * rotating to a new part when adding the next line would exceed
 * `maxPartBytes`. `docs` must already be sorted by `path` (callers sort
 * before calling, so this module stays a pure writer) and each doc's `data`
 * must already be typed-encoded (see typed-json.mjs encode()).
 *
 * Returns the per-part manifest entries: { file, docs, bytes, sha256 }.
 */
function writeParts(collectionDir, docs, { maxPartBytes = DEFAULT_MAX_PART_BYTES } = {}) {
  ensureDir(collectionDir);
  const parts = [];
  let partIndex = 0;
  let currentLines = [];
  let currentBytes = 0;

  function flush() {
    if (currentLines.length === 0 && parts.length > 0) return; // never write a trailing empty part if we already wrote one
    partIndex += 1;
    const fileName = `part-${String(partIndex).padStart(5, '0')}.jsonl`;
    const content = currentLines.length > 0 ? currentLines.join('\n') + '\n' : '';
    const buffer = Buffer.from(content, 'utf8');
    writeFileSecure(path.join(collectionDir, fileName), buffer);
    parts.push({
      file: fileName,
      docs: currentLines.length,
      bytes: buffer.length,
      sha256: sha256Hex(buffer),
    });
    currentLines = [];
    currentBytes = 0;
  }

  if (docs.length === 0) {
    // Still write one empty part so the collection directory is non-empty
    // and consistency checks have a file to point at.
    flush();
    return parts;
  }

  for (const doc of docs) {
    const line = canonicalStringify({
      path: doc.path,
      id: doc.id,
      createTime: doc.createTime,
      updateTime: doc.updateTime,
      data: doc.data,
    });
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for the newline
    if (currentLines.length > 0 && currentBytes + lineBytes > maxPartBytes) {
      flush();
    }
    currentLines.push(line);
    currentBytes += lineBytes;
  }
  flush();
  return parts;
}

/** Writes `<collectionDir>/manifest.json`. */
function writeCollectionManifest(collectionDir, manifest) {
  writeFileSecure(path.join(collectionDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
}

/**
 * Writes `<bundleRoot>/SHA256SUMS`: one `sha256sum`-compatible line
 * (`<hex>  <relative path>`) per file in `fileList`, EXCLUDING SHA256SUMS
 * itself, sorted by relative path. `fileList` is an array of absolute paths
 * under bundleRoot; this function computes each file's hash itself (it does
 * not trust a caller-supplied hash) so it is a true check of what is on disk.
 */
function writeShaSums(bundleRoot, absoluteFilePaths) {
  const rows = absoluteFilePaths
    .filter((absPath) => path.resolve(absPath) !== path.resolve(bundleRoot, 'SHA256SUMS'))
    .map((absPath) => {
      const rel = path.relative(bundleRoot, absPath).split(path.sep).join('/');
      const hash = sha256Hex(readFileSync(absPath));
      return { rel, hash };
    })
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const content = rows.map((r) => `${r.hash}  ${r.rel}\n`).join('');
  writeFileSecure(path.join(bundleRoot, 'SHA256SUMS'), Buffer.from(content, 'utf8'));
  return rows;
}

/** Recursively lists every regular file under `dir`, returning absolute paths. */
function listFilesRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

export {
  DIR_MODE,
  FILE_MODE,
  DEFAULT_MAX_PART_BYTES,
  sha256Hex,
  ensureDir,
  writeFileSecure,
  writeParts,
  writeCollectionManifest,
  writeShaSums,
  listFilesRecursive,
};
