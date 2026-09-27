#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/lib/verify-bundle.mjs — verifies an export bundle
 * written by scripts/cf-port/migrate/export.mjs, per
 * docs/cf-port/MIGRATION_MANIFEST.md §(c)/(d) precondition C2.
 *
 * Checks, in order:
 *   1. SHA256SUMS exists, every entry's path is SAFE (relative, no `..`
 *      segment, not absolute — REVIEW ROUND 1 FIX 8), and every listed
 *      file's live sha256 matches (and no file it lists is missing).
 *   2. Every file actually present under the bundle (except SHA256SUMS
 *      itself) is listed in SHA256SUMS — catches an ADDED file/line that
 *      SHA256SUMS doesn't know about.
 *   3. The root manifest.json exists and its schemaVersion is the expected
 *      one (1).
 *   4. Every collection directory's own manifest.json: doc count and each
 *      part's {docs, bytes, sha256} match what's on disk, and the part file
 *      list is exactly what the manifest says (no extra/missing parts).
 *      REVIEW ROUND 1 FIX 8: a collection the root manifest lists is now a
 *      FAIL (not a silently-skipped `continue`) if its directory or
 *      manifest.json is missing, UNLESS its fate is `verify-only` (those
 *      legitimately have no collection directory/manifest — see fix 8b).
 *   5. `_auth/users.jsonl` has exactly `authUserCount` lines (root manifest).
 *   6. Each `_verify/<name>.jsonl` has the line count the root manifest
 *      records for that collection.
 *
 * Usable as a library (verifyBundle(dir)) AND as a CLI:
 *   node scripts/cf-port/migrate/lib/verify-bundle.mjs <bundle dir>
 * The CLI prints PASS/FAIL per check and exits 0 (all pass) or 1 (any fail).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_SCHEMA_VERSION = 1;

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseShaSums(content) {
  const rows = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
    if (!match) {
      throw new Error(`SHA256SUMS: unparsable line ${JSON.stringify(line)}`);
    }
    rows.push({ hash: match[1], rel: match[2] });
  }
  return rows;
}

/** REVIEW ROUND 1 FIX 8: a SHA256SUMS relative path must stay inside the
 * bundle — reject an absolute path (POSIX or Windows-drive-letter) or any
 * path containing a `..` segment, which could otherwise be used to read or
 * (if later trusted for a write) escape the bundle directory. */
function isUnsafeRelativePath(rel) {
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return true;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return true; // Windows drive-letter absolute
  const segments = rel.split(/[\\/]/);
  return segments.some((segment) => segment === '..');
}

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

/**
 * Verifies the bundle at `bundleDir`. Returns
 * { ok: boolean, checks: [{ name, ok, detail }] } — never throws for an
 * ordinary verification failure (only for a truly malformed bundle it can't
 * even parse, e.g. SHA256SUMS itself unreadable).
 */
function verifyBundle(bundleDir) {
  const checks = [];
  const record = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    return ok;
  };

  const shaSumsPath = path.join(bundleDir, 'SHA256SUMS');
  if (!existsSync(shaSumsPath)) {
    record('SHA256SUMS exists', false, `missing: ${shaSumsPath}`);
    return { ok: false, checks };
  }
  record('SHA256SUMS exists', true);

  let rows;
  try {
    rows = parseShaSums(readFileSync(shaSumsPath, 'utf8'));
  } catch (error) {
    record('SHA256SUMS parses', false, error.message);
    return { ok: false, checks };
  }
  record('SHA256SUMS parses', true, `${rows.length} entries`);

  // 0. every listed path is safe (no absolute path, no `..` segment).
  const unsafe = rows.filter((row) => isUnsafeRelativePath(row.rel)).map((row) => row.rel);
  record('every SHA256SUMS path is safe (relative, no .. segment)', unsafe.length === 0, unsafe.join('; '));
  if (unsafe.length > 0) {
    // Do not attempt to resolve/read an unsafe path at all.
    return { ok: false, checks };
  }

  // 1. every listed file's hash matches, and none is missing.
  let hashOk = true;
  const hashProblems = [];
  for (const row of rows) {
    const absPath = path.join(bundleDir, row.rel);
    if (!existsSync(absPath)) {
      hashOk = false;
      hashProblems.push(`missing file listed in SHA256SUMS: ${row.rel}`);
      continue;
    }
    const actual = sha256Hex(readFileSync(absPath));
    if (actual !== row.hash) {
      hashOk = false;
      hashProblems.push(`hash mismatch: ${row.rel} (expected ${row.hash}, got ${actual})`);
    }
  }
  record('every listed file hashes correctly', hashOk, hashProblems.join('; '));

  // 2. every file on disk (except SHA256SUMS) is listed.
  const onDisk = listFilesRecursive(bundleDir)
    .map((absPath) => path.relative(bundleDir, absPath).split(path.sep).join('/'))
    .filter((rel) => rel !== 'SHA256SUMS');
  const listedSet = new Set(rows.map((r) => r.rel));
  const unlisted = onDisk.filter((rel) => !listedSet.has(rel));
  record('no unlisted files on disk', unlisted.length === 0, unlisted.join('; '));

  const missingFromDisk = rows.map((r) => r.rel).filter((rel) => !existsSync(path.join(bundleDir, rel)));
  record('no SHA256SUMS entries missing from disk', missingFromDisk.length === 0, missingFromDisk.join('; '));

  // 3. root manifest.json + schema version.
  const rootManifestPath = path.join(bundleDir, 'manifest.json');
  if (!existsSync(rootManifestPath)) {
    record('root manifest.json exists', false, `missing: ${rootManifestPath}`);
    return { ok: checks.every((c) => c.ok), checks };
  }
  record('root manifest.json exists', true);
  let rootManifest;
  try {
    rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'));
  } catch (error) {
    record('root manifest.json parses', false, error.message);
    return { ok: false, checks };
  }
  record('root manifest.json parses', true);
  record(
    'root schemaVersion matches',
    rootManifest.schemaVersion === EXPECTED_SCHEMA_VERSION,
    `expected ${EXPECTED_SCHEMA_VERSION}, got ${rootManifest.schemaVersion}`,
  );

  // 4. every collection manifest vs its parts on disk.
  //
  // REVIEW ROUND 1 FIX 8: previously a missing collectionDir/manifest.json
  // was silently `continue`d, so a collection that failed to write (or was
  // dropped from the bundle by a bug) produced NO failing check at all. Now
  // only `verify-only` entries are allowed to have no collection directory
  // (their data lives in _verify/<name>.jsonl instead, checked in section 6
  // below) — every other fate's missing manifest is a hard FAIL.
  const collections = Array.isArray(rootManifest.collections) ? rootManifest.collections : [];
  for (const entry of collections) {
    const collectionDir = path.join(bundleDir, entry.name);
    const manifestPath = path.join(collectionDir, 'manifest.json');
    if (entry.fate === 'verify-only') {
      continue; // legitimately no collection directory; see section 6.
    }
    if (!existsSync(manifestPath)) {
      record(`${entry.name}: manifest.json exists`, false, `missing: ${manifestPath}`);
      continue;
    }
    let collectionManifest;
    try {
      collectionManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      record(`${entry.name}: manifest.json parses`, false, error.message);
      continue;
    }
    record(`${entry.name}: schemaVersion`, collectionManifest.schemaVersion === EXPECTED_SCHEMA_VERSION);

    const partsOnDisk = readdirSync(collectionDir)
      .filter((name) => /^part-\d{5}\.jsonl$/.test(name))
      .sort();
    const partsInManifest = (collectionManifest.parts ?? []).map((p) => p.file).sort();
    const partsMatch = JSON.stringify(partsOnDisk) === JSON.stringify(partsInManifest);
    record(`${entry.name}: part file list matches manifest`, partsMatch, `disk=${partsOnDisk.join(',')} manifest=${partsInManifest.join(',')}`);

    let totalDocsFromParts = 0;
    for (const part of collectionManifest.parts ?? []) {
      const partPath = path.join(collectionDir, part.file);
      if (!existsSync(partPath)) {
        record(`${entry.name}: ${part.file} exists`, false);
        continue;
      }
      const content = readFileSync(partPath, 'utf8');
      const lines = content.length === 0 ? [] : content.split('\n').filter((l) => l.length > 0);
      const bytes = Buffer.byteLength(content, 'utf8');
      const hash = sha256Hex(Buffer.from(content, 'utf8'));
      totalDocsFromParts += lines.length;
      record(`${entry.name}/${part.file}: docs count`, lines.length === part.docs, `expected ${part.docs}, got ${lines.length}`);
      record(`${entry.name}/${part.file}: bytes`, bytes === part.bytes, `expected ${part.bytes}, got ${bytes}`);
      record(`${entry.name}/${part.file}: sha256`, hash === part.sha256, `expected ${part.sha256}, got ${hash}`);
    }
    record(
      `${entry.name}: total doc count matches manifest`,
      totalDocsFromParts === collectionManifest.documentCount,
      `expected ${collectionManifest.documentCount}, got ${totalDocsFromParts}`,
    );
  }

  // 5. _auth/users.jsonl has exactly authUserCount lines.
  if (typeof rootManifest.authUserCount === 'number') {
    const authPath = path.join(bundleDir, '_auth', 'users.jsonl');
    if (!existsSync(authPath)) {
      record('_auth/users.jsonl exists', false, `missing: ${authPath}`);
    } else {
      const content = readFileSync(authPath, 'utf8');
      const lines = content.length === 0 ? [] : content.split('\n').filter((l) => l.length > 0);
      record(
        '_auth/users.jsonl line count matches authUserCount',
        lines.length === rootManifest.authUserCount,
        `expected ${rootManifest.authUserCount}, got ${lines.length}`,
      );
    }
  }

  // 6. each _verify/<name>.jsonl has the count the root manifest records for
  // that (verify-only) collection.
  for (const entry of collections) {
    if (entry.fate !== 'verify-only') continue;
    const verifyPath = path.join(bundleDir, '_verify', `${entry.name}.jsonl`);
    if (!existsSync(verifyPath)) {
      record(`_verify/${entry.name}.jsonl exists`, false, `missing: ${verifyPath}`);
      continue;
    }
    const content = readFileSync(verifyPath, 'utf8');
    const lines = content.length === 0 ? [] : content.split('\n').filter((l) => l.length > 0);
    record(
      `_verify/${entry.name}.jsonl line count matches root manifest`,
      lines.length === entry.count,
      `expected ${entry.count}, got ${lines.length}`,
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}

function runCli(bundleDir) {
  const { ok, checks } = verifyBundle(bundleDir);
  for (const check of checks) {
    const label = check.ok ? 'PASS' : 'FAIL';
    console.log(`[${label}] ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  console.log(ok ? '\nPASS: bundle verified' : '\nFAIL: bundle verification failed');
  return ok;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const bundleDir = process.argv[2];
  if (!bundleDir) {
    console.error('usage: node verify-bundle.mjs <bundle dir>');
    process.exit(1);
  }
  const ok = runCli(path.resolve(bundleDir));
  process.exit(ok ? 0 : 1);
}

export { verifyBundle, EXPECTED_SCHEMA_VERSION, isUnsafeRelativePath };
