#!/usr/bin/env node
// Proves the admin build holds no Firebase code, no source map and no secret,
// and that its files are the ones the admin Worker serves (CP5 brief WX rule 5,
// rule 18 of CP5_BRIEFS.md §0).
//
//   node cloudflare/admin/check-admin-build.mjs                 build, then check
//   node cloudflare/admin/check-admin-build.mjs --no-build      check the last build
//   node cloudflare/admin/check-admin-build.mjs --no-build --dist <dir>
//                                                               check another directory
//
// Plain Node, no dependency: runs `vite build --config vite.admin.config.js` at
// the repository root (unit FA writes that config; while it does not exist the
// check fails with one clear line), then reads every file of
// cloudflare/admin/dist. Exit 0 when clean, 1 with the offenders listed. Not a
// vitest suite on purpose (the Worker suites run inside workerd and cannot run
// a build); named without `.test.` so that vitest never picks it up.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = dirname(fileURLToPath(import.meta.url));
const ROOT = join(ADMIN, '..', '..');
const CONFIG = 'vite.admin.config.js';

const distFlag = process.argv.indexOf('--dist');
const DIST = distFlag === -1 ? join(ADMIN, 'dist') : resolve(process.argv[distFlag + 1] ?? '');

// What the Firebase JS SDK and its endpoints leave in a bundle. Any one of
// them in any file of the build fails the check.
const FIREBASE_MARKERS = [
  /firebase/i,
  /firestore/i,
  /identitytoolkit/i,
  /securetoken\.googleapis/i,
  /cloudfunctions\.net/i,
  /firebasestorage/i,
];

// What a secret looks like when one is inlined into a bundle (an env value
// read whole, a key pasted into a fixture). A build holds public values only.
const SECRET_MARKERS = [
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/, 'a Stripe secret or restricted key'],
  [/\bwhsec_[A-Za-z0-9]{8,}/, 'a Stripe webhook signing secret'],
  [/\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{10,}/, 'a Resend API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an access key id'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/BETTER_AUTH_SECRET|BOOTSTRAP_TOKEN|RENDER_FARM_TOKEN|R2_SECRET_ACCESS_KEY|STRIPE_SECRET_KEY|RESEND_API_KEY/, 'the name of a Worker secret'],
];

// The admin Worker serves /index.html (never as a file), /assets/…, /images/…
// and top-level files with a dot (cloudflare/admin/src/routing.ts).
function servable(path) {
  return path === 'index.html' || path.startsWith('assets/') || path.startsWith('images/') || path.startsWith('template-thumbs/') || (!path.includes('/') && path.includes('.'));
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function excerpt(text, at) {
  return text.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, ' ');
}

if (!process.argv.includes('--no-build')) {
  if (!existsSync(join(ROOT, CONFIG))) {
    console.error(`admin build: ${CONFIG} does not exist yet (unit FA writes it); nothing was built or checked.`);
    process.exit(1);
  }
  execFileSync('npx', ['vite', 'build', '--config', CONFIG], { cwd: ROOT, stdio: 'inherit' });
}

const problems = [];
if (!existsSync(join(DIST, 'index.html'))) {
  problems.push('index.html is missing (the Worker serves the shell from /index.html)');
} else if (!readFileSync(join(DIST, 'index.html'), 'utf8').includes('<div id="root"></div>')) {
  problems.push('index.html has no empty #root element');
}

const files = existsSync(DIST) ? walk(DIST) : [];
let textFiles = 0;
for (const file of files) {
  const path = relative(DIST, file).split('\\').join('/');
  if (!servable(path)) problems.push(`${path}: not a path the admin Worker serves`);
  if (path.endsWith('.map')) problems.push(`${path}: a source map is shipped`);

  const bytes = readFileSync(file);
  // Binary files (a NUL in the first 8000 bytes, as git decides) hold no code.
  if (bytes.subarray(0, 8000).includes(0)) continue;
  textFiles += 1;
  const text = bytes.toString('utf8');
  if (/[#@]\s*sourceMappingURL=/.test(text)) problems.push(`${path}: a sourceMappingURL comment`);
  for (const marker of FIREBASE_MARKERS) {
    const match = marker.exec(text);
    if (match) problems.push(`${path}: "${match[0]}" at ${match.index}: …${excerpt(text, match.index)}…`);
  }
  for (const [marker, what] of SECRET_MARKERS) {
    const match = marker.exec(text);
    // The value itself is never printed: its first characters are enough to find it.
    if (match) problems.push(`${path}: ${what} at ${match.index} ("${match[0].slice(0, 8)}…")`);
  }
}

if (files.length === 0) problems.push('the build is empty');

if (problems.length > 0) {
  console.error(`admin build: ${problems.length} problem(s) in ${DIST}`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`admin build: ${files.length} files (${textFiles} text) checked, no Firebase code, no source map, no secret, every file servable.`);
