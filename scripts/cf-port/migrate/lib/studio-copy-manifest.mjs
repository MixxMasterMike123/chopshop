/**
 * scripts/cf-port/migrate/lib/studio-copy-manifest.mjs — CP5-WH: the copy
 * manifest of the design studio's platform files (import-studio-assets.mjs).
 * The same discipline as lib/copy-manifest.mjs (CP4 S1), without a shop:
 *
 *   <out>/studio-copy-manifest.json
 *   { schemaVersion: 1, env, apiOrigin, bundleManifestSha256, createdAt,
 *     entries: [ { sourceKey, kind, status, fileId, sha256, sizeBytes,
 *                  contentType, reason } ] }
 *
 * One entry per (sourceKey, kind). `sourceKey` = sha256 of the address
 * exactly as the export holds it (lib/copy-manifest.mjs sourceKeyOf): the
 * manifest never holds an address. `kind` is `studio_file` (the only kind:
 * a platform file of pod_studio_files, cloudflare/migrations/0049). Status as
 * in CP4: copied (with the Worker's file id), refused (the Worker or the
 * local checks said no, with the reason), missing (the source has no such
 * file), failed (anything else; tried again on the next run).
 *
 * Writes are atomic (written beside the target, renamed over it).
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export const STUDIO_COPY_MANIFEST_FILE = 'studio-copy-manifest.json';
export const STUDIO_FILE_KIND = 'studio_file';
const SCHEMA_VERSION = 1;
const STATUSES = ['copied', 'refused', 'missing', 'failed'];
const ENTRY_KEYS = ['sourceKey', 'kind', 'status', 'fileId', 'sha256', 'sizeBytes', 'contentType', 'reason'];
const TOP_KEYS = ['schemaVersion', 'env', 'apiOrigin', 'bundleManifestSha256', 'createdAt', 'entries'];
const HEX64 = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STUDIO_TYPES = ['image/avif', 'image/jpeg', 'image/png', 'image/webp'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function emptyStudioCopyManifest({ env, apiOrigin, bundleManifestSha256, createdAt }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    env,
    apiOrigin,
    bundleManifestSha256,
    createdAt: createdAt ?? new Date().toISOString(),
    entries: [],
  };
}

export function studioEntryProblems(entry) {
  if (!isPlainObject(entry)) return ['entry is not an object'];
  const problems = [];
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) problems.push(`unknown key ${key}`);
  for (const key of ENTRY_KEYS) if (!(key in entry)) problems.push(`missing key ${key}`);
  if (problems.length > 0) return problems;
  if (typeof entry.sourceKey !== 'string' || !HEX64.test(entry.sourceKey)) problems.push('sourceKey');
  if (entry.kind !== STUDIO_FILE_KIND) problems.push('kind');
  if (!STATUSES.includes(entry.status)) problems.push('status');
  if (entry.sha256 !== null && (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256))) problems.push('sha256');
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) problems.push('sizeBytes');
  if (entry.status === 'copied') {
    if (typeof entry.fileId !== 'string' || !FILE_ID.test(entry.fileId)) problems.push('copied needs fileId');
    if (entry.sha256 === null) problems.push('copied needs sha256');
    if (!STUDIO_TYPES.includes(entry.contentType)) problems.push('copied needs a studio contentType');
    if (entry.reason !== null) problems.push('copied has no reason');
  } else {
    if (entry.fileId !== null) problems.push('only copied has fileId');
    if (typeof entry.reason !== 'string' || entry.reason.length === 0) problems.push(`${entry.status} needs reason`);
  }
  return problems;
}

export function studioCopyManifestProblems(manifest) {
  if (!isPlainObject(manifest)) return ['manifest is not an object'];
  const problems = [];
  for (const key of Object.keys(manifest)) if (!TOP_KEYS.includes(key)) problems.push(`unknown key ${key}`);
  if (manifest.schemaVersion !== SCHEMA_VERSION) problems.push('schemaVersion');
  if (manifest.env !== 'staging' && manifest.env !== 'production') problems.push('env');
  if (typeof manifest.apiOrigin !== 'string') problems.push('apiOrigin');
  if (typeof manifest.bundleManifestSha256 !== 'string' || !HEX64.test(manifest.bundleManifestSha256)) {
    problems.push('bundleManifestSha256');
  }
  if (!Array.isArray(manifest.entries)) return [...problems, 'entries'];
  const seen = Object.create(null);
  manifest.entries.forEach((entry, index) => {
    for (const problem of studioEntryProblems(entry)) problems.push(`entries[${index}]: ${problem}`);
    const key = `${entry?.sourceKey}\n${entry?.kind}`;
    if (seen[key] === true) problems.push(`entries[${index}]: duplicate (sourceKey, kind)`);
    seen[key] = true;
  });
  return problems;
}

function assertValid(manifest) {
  const problems = studioCopyManifestProblems(manifest);
  if (problems.length > 0) throw new Error(`studio copy manifest is not valid: ${problems.slice(0, 10).join('; ')}`);
  return manifest;
}

export function readStudioCopyManifest(filePath) {
  return assertValid(JSON.parse(readFileSync(filePath, 'utf8')));
}

export function writeStudioCopyManifest(filePath, manifest) {
  assertValid(manifest);
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
}

/** The entry of (sourceKey, kind), or null. */
export function findStudioEntry(manifest, sourceKey, kind = STUDIO_FILE_KIND) {
  return manifest.entries.find((entry) => entry.sourceKey === sourceKey && entry.kind === kind) ?? null;
}

/** Replaces the entry of the same (sourceKey, kind) in place, or appends it. */
export function putStudioEntry(manifest, entry) {
  const problems = studioEntryProblems(entry);
  if (problems.length > 0) throw new Error(`studio copy manifest entry is not valid: ${problems.join('; ')}`);
  const at = manifest.entries.findIndex((existing) => existing.sourceKey === entry.sourceKey && existing.kind === entry.kind);
  if (at === -1) manifest.entries.push(entry);
  else manifest.entries[at] = entry;
  return manifest;
}
