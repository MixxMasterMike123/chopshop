#!/usr/bin/env node
// Zero-B8shield / zero-Firebase guard — docs/cf-port/PLAN.md §0 "Zero B8shield transfer", §8.
//
// Forbidden in tracked files (pattern families):
//   b8shield  /b8shield|b8s[-_]/i   path or text content
//   reseller  /reseller/i           path or text content
//   firebase  import of any firebase package: from '…firebase…', require('firebase…'),
//             import('firebase…')   text content
// A matching file passes only if it is listed in guard/allowlist.txt (legacy debt that may
// only SHRINK and must be empty by CP7), or — for the reseller family ONLY — in
// guard/permanent-exemptions.txt (a live legal/business term). An exemption never covers
// the b8shield or firebase families.
//
//   (a) a matching file that is listed nowhere                    → FAIL (offenders listed)
//   (b) an allowlist/exemption entry that no longer needs to exist → FAIL (stale — remove it)
//   (c) allowlist size > guard/allowlist.baseline                  → FAIL; on success the
//       baseline is refreshed to the current size, so it can only ratchet down.
//
// Run: node guard/guards.test.mjs   (no deps; the file list comes from `git ls-files`, so
// untracked clutter is ignored and a clean checkout of the SHA gives the same answer).

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = 'guard/allowlist.txt';
const EXEMPTIONS = 'guard/permanent-exemptions.txt';
const BASELINE = 'guard/allowlist.baseline';

const FAMILIES = [
  { name: 'b8shield', re: /b8shield|b8s[-_]/i, matchPath: true },
  { name: 'reseller', re: /reseller/i, matchPath: true },
  { name: 'firebase', re: /from\s*['"]firebase['"/-]|require\(\s*['"]firebase|import\(\s*['"]firebase/, matchPath: false },
];

// Out of scope: dependencies, build output, archived material, tool state, lockfiles — and
// the guard's own data files, which necessarily spell out the forbidden words. Also
// scripts/cf-port/: the one-time Firebase EXPORT tooling (PLAN §4) must import firebase-admin
// and name the old database; the directory is deleted at CP7 (docs/cf-port/RETIRED.md).
const EXCLUDED_PREFIXES = ['dist/', 'functions/lib/', 'OBSOLETE/', 'docs/_archive/', '.claude/', 'scripts/cf-port/'];
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
const SELF = new Set([ALLOWLIST, EXEMPTIONS, BASELINE, 'guard/guards.test.mjs']);

const inScope = (p) =>
  !p.split('/').includes('node_modules') &&
  !EXCLUDED_PREFIXES.some((d) => p.startsWith(d)) &&
  !LOCKFILES.has(basename(p)) &&
  !SELF.has(p);

// Text content of a tracked file; '' for binaries (git's heuristic: a NUL in the first
// 8000 bytes — same as `git grep -I`), gitlinks, and files deleted in the worktree.
function readText(p) {
  const abs = join(ROOT, p);
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
  if (st.isSymbolicLink()) return readlinkSync(abs);
  if (!st.isFile()) return '';
  const buf = readFileSync(abs);
  return buf.subarray(0, 8000).includes(0) ? '' : buf.toString('utf8');
}

// One path per line; blank lines and '#' comment lines ignored; an inline reason follows ' #'.
function readList(file, { reasonRequired }) {
  const abs = join(ROOT, file);
  const errors = [];
  if (!existsSync(abs)) return { entries: new Set(), errors: [`${file} is missing`] };
  const entries = new Set();
  readFileSync(abs, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cut = line.indexOf(' #');
    const path = (cut === -1 ? line : line.slice(0, cut)).trim();
    if (reasonRequired && (cut === -1 || !line.slice(cut + 2).trim())) errors.push(`${file}:${i + 1}: "${path}" has no "# reason"`);
    if (entries.has(path)) errors.push(`${file}:${i + 1}: duplicate entry "${path}"`);
    entries.add(path);
  });
  return { entries, errors };
}

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean),
);

const hits = new Map(); // path -> family names that match
for (const p of tracked) {
  if (!inScope(p)) continue;
  let text = null;
  const matched = [];
  for (const { name, re, matchPath } of FAMILIES) {
    if (matchPath && re.test(p)) {
      matched.push(name);
      continue;
    }
    text ??= readText(p);
    if (re.test(text)) matched.push(name);
  }
  if (matched.length) hits.set(p, matched);
}

const allow = readList(ALLOWLIST, { reasonRequired: false });
const exempt = readList(EXEMPTIONS, { reasonRequired: true });
const needsAllowlist = (p) => (hits.get(p) ?? []).filter((f) => !(f === 'reseller' && exempt.entries.has(p)));

const failures = [...allow.errors, ...exempt.errors];

const offenders = [...hits.keys()].filter((p) => needsAllowlist(p).length && !allow.entries.has(p)).sort();
if (offenders.length) {
  failures.push(
    `(a) ${offenders.length} file(s) match a forbidden pattern and are not allowlisted — clean them; the allowlist only shrinks:\n` +
      offenders.map((p) => `      ${p}  [${needsAllowlist(p).join(', ')}]`).join('\n'),
  );
}

const staleAllow = [...allow.entries].filter((p) => !needsAllowlist(p).length).sort();
if (staleAllow.length) {
  failures.push(
    `(b) ${staleAllow.length} stale ${ALLOWLIST} entr${staleAllow.length === 1 ? 'y' : 'ies'} — remove it: the allowlist only shrinks:\n` +
      staleAllow.map((p) => `      ${p}`).join('\n'),
  );
}

const staleExempt = [...exempt.entries].filter((p) => !(hits.get(p) ?? []).includes('reseller')).sort();
if (staleExempt.length) {
  failures.push(
    `(b) ${staleExempt.length} stale ${EXEMPTIONS} entr${staleExempt.length === 1 ? 'y' : 'ies'} (no longer contains "reseller", or not tracked) — remove it:\n` +
      staleExempt.map((p) => `      ${p}`).join('\n'),
  );
}

const size = allow.entries.size;
console.log(`guard: ${tracked.size} tracked files scanned, ${hits.size} match a pattern`);
console.log(`guard: allowlist size = ${size}, permanent exemptions = ${exempt.entries.size}`);

const baselineAbs = join(ROOT, BASELINE);
if (existsSync(baselineAbs)) {
  const raw = readFileSync(baselineAbs, 'utf8').trim();
  const baseline = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isNaN(baseline)) failures.push(`(c) ${BASELINE} must hold a single integer, found "${raw}"`);
  else if (size > baseline) failures.push(`(c) allowlist grew: ${size} > baseline ${baseline} — the allowlist only shrinks`);
  else console.log(`guard: baseline = ${baseline}`);
}

if (failures.length) {
  console.error(`\nguard: FAIL\n${failures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}

const next = `${size}\n`;
if (!existsSync(baselineAbs) || readFileSync(baselineAbs, 'utf8') !== next) {
  writeFileSync(baselineAbs, next);
  console.log(`guard: ${BASELINE} set to ${size}`);
}
console.log('guard: PASS');
