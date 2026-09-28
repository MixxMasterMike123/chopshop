#!/usr/bin/env node
// Proves the storefront build holds no Firebase code (CP4 brief E, "must be
// proven"), and that its files are the ones the web Worker serves.
//
//   node cloudflare/web/check-storefront-build.mjs            build, then check
//   node cloudflare/web/check-storefront-build.mjs --no-build  check the last build
//
// Plain Node, no dependency: runs `vite build --config vite.storefront.config.js`
// at the repository root, then reads every file of cloudflare/web/dist. Exit 0
// when clean, 1 with the offenders listed. Not a vitest suite on purpose (the
// API's vitest runs inside workerd and cannot run a build); named without
// `.test.` so that vitest never picks it up.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = dirname(fileURLToPath(import.meta.url));
const ROOT = join(WEB, '..', '..');
const DIST = join(WEB, 'dist');

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

// The web Worker serves /index.html (never as a file), /assets/…, /images/…
// and top-level files with a dot (cloudflare/web/src/routing.ts).
function servable(path) {
  return path === 'index.html' || path.startsWith('assets/') || path.startsWith('images/') || (!path.includes('/') && path.includes('.'));
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (!process.argv.includes('--no-build')) {
  execFileSync('npx', ['vite', 'build', '--config', 'vite.storefront.config.js'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

const problems = [];
if (!existsSync(join(DIST, 'index.html'))) {
  problems.push('index.html is missing');
} else if (!readFileSync(join(DIST, 'index.html'), 'utf8').includes('<div id="root"></div>')) {
  problems.push('index.html has no empty #root element');
}

const files = existsSync(DIST) ? walk(DIST) : [];
let textFiles = 0;
for (const file of files) {
  const path = relative(DIST, file).split('\\').join('/');
  if (!servable(path)) problems.push(`${path}: not a path the web Worker serves`);
  if (path.endsWith('.map')) problems.push(`${path}: a source map is shipped`);

  const bytes = readFileSync(file);
  // Binary files (a NUL in the first 8000 bytes, as git decides) hold no code.
  if (bytes.subarray(0, 8000).includes(0)) continue;
  textFiles += 1;
  const text = bytes.toString('utf8');
  for (const marker of FIREBASE_MARKERS) {
    const match = marker.exec(text);
    if (match) {
      const at = match.index;
      problems.push(`${path}: "${match[0]}" at ${at}: …${text.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, ' ')}…`);
    }
  }
}

if (files.length === 0) problems.push('the build is empty');

if (problems.length > 0) {
  console.error(`storefront build: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`storefront build: ${files.length} files (${textFiles} text) checked, no Firebase code, every file servable.`);
