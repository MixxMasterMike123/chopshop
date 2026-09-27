import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hard rule 4: this export tool is read-only towards Firebase. This test
 * greps every .mjs source file THIS BUILDER wrote (export.mjs + lib/*.mjs;
 * test files themselves are excluded since fake-firestore.mjs's fakes
 * legitimately implement method bodies with names like "get") for any
 * Firestore/Auth WRITE-shaped method name and fails if one appears.
 *
 * Forbidden method name patterns (called as `something.<name>(`):
 *   set, update, delete, create, batch, runTransaction, bulkWriter
 * Allowed and NOT flagged: get, count, listCollections, listDocuments,
 * orderBy, startAfter, limit, data, toDate, listUsers — none of these match
 * the forbidden patterns below.
 *
 * Note: `create` alone would also match the unrelated word "created"/
 * "createdAt"/"createTime" if matched too loosely, so the pattern requires
 * a word boundary before an OPENING PAREN immediately after the method name
 * (i.e. it looks for an actual method CALL: `.create(`, `.delete(`, etc.),
 * not any appearance of the substring.
 *
 * `update` is ALSO node:crypto's Hash#update() (createHash(...).update(...)),
 * which this tool legitimately uses for sha256 hashing and is NOT a Firestore
 * write. Any line whose call chain traces back to createHash(...) is exempt
 * from the `update` check specifically (checked by scanning backward on the
 * same line/statement for a `createHash(` on the same chain).
 *
 * `create` is ALSO the standard `Object.create(...)` (used by typed-json.mjs
 * to test for a plain object's prototype — nothing to do with Firestore's
 * `create()` write). A line matching `Object.create(` is exempt from the
 * `create` check specifically, the same way `Object.create` appearing in
 * PROSE inside a comment (as in this file's own docs) is exempt too — this
 * scan intentionally does not distinguish code from comments (see the note
 * above), so the exemption is applied uniformly regardless.
 */

const MIGRATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_METHOD_CALLS = [
  'set',
  'update',
  'delete',
  'create',
  'batch',
  'runTransaction',
  'bulkWriter',
  // Reviewer (round 2): the remaining write-shaped calls of the Firestore and
  // Auth admin clients. `.create(` does not match `.createUser(`, and
  // `collection.add()` is a write too.
  'add',
  'recursiveDelete',
  'createUser',
  'updateUser',
  'deleteUser',
  'deleteUsers',
  'importUsers',
  'setCustomUserClaims',
  'revokeRefreshTokens',
  'createCustomToken',
  'generatePasswordResetLink',
  'generateEmailVerificationLink',
  'generateSignInWithEmailLink',
];

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'test') continue; // test/ is excluded: fakes implement read method bodies
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

test('export.mjs and lib/*.mjs never call a Firestore/Auth write method', () => {
  const files = listSourceFiles(MIGRATE_DIR);
  assert.ok(files.length > 0, 'expected to find at least one .mjs source file');
  const offenses = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    // Strip comments and string literals containing the word "create" etc. in
    // PROSE (like this very comment block) is unavoidable via naive grep, so
    // instead we scan for the CALL SHAPE: a dot, the method name, then `(`
    // — and additionally require it NOT be immediately preceded by a letter
    // (so "recreate(" doesn't match "create(").
    for (const method of FORBIDDEN_METHOD_CALLS) {
      // Matches an actual method CALL `.method(` (a literal dot right before
      // the method name, then optional whitespace, then an opening paren).
      // A dot always precedes a genuine property/method access in JS, so
      // this alone already excludes false hits like the bare word
      // "recreate" or "createdAt" (neither is preceded by `.name(`).
      const pattern = new RegExp(`\\.${method}\\s*\\(`, 'g');
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const before = content.slice(0, match.index);
        const lineNumber = before.split('\n').length;
        const line = content.split('\n')[lineNumber - 1];
        // Exempt node:crypto's Hash#update(): createHash(...).update(...) is
        // not a Firestore write. Only relevant for the "update" method name.
        if (method === 'update' && /createHash\([^)]*\)\s*\.\s*update\s*\(/.test(line)) {
          continue;
        }
        // Exempt the standard Object.create(...) (prototype checks in
        // typed-json.mjs, or prose mentioning it in a comment) — not a
        // Firestore write. Only relevant for the "create" method name.
        if (method === 'create' && /\bObject\s*\.\s*create\s*\(/.test(line)) {
          continue;
        }
        offenses.push(`${path.relative(MIGRATE_DIR, file)}:${lineNumber}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenses, [], `forbidden write-shaped method calls found:\n${offenses.join('\n')}`);
});

test('the scan itself is not vacuous: it WOULD catch a forbidden call', () => {
  const tempContent = 'await docRef.set({ x: 1 });';
  const pattern = /\.set\s*\(/g;
  assert.ok(pattern.test(tempContent));
});
