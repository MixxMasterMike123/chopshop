import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExport } from '../export.mjs';
import { verifyBundle, isUnsafeRelativePath } from '../lib/verify-bundle.mjs';
import { FakeFirestore, FakeAuth, FakeFieldPath } from './fake-firestore.mjs';

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'cfport-verify-'));
}

function freshBundleDir() {
  const base = tmpDir();
  return path.join(base, 'bundle');
}

// REVIEW ROUND 1: the fake's schema shape is now a recursive tree (see
// fake-firestore.mjs's header comment), not the old flat { docs, subcollections }.
async function makeBundle(outDir) {
  const schema = {
    collections: {
      gif1: { data: { title: 'Summer', handle: 'summer', shopId: 'gif-sundsvall' } },
    },
  };
  const db = new FakeFirestore(schema);
  const auth = new FakeAuth([{ uid: 'u1', email: 'admin@example.com', emailVerified: true, disabled: false, displayName: 'Admin', metadata: { creationTime: 'x', lastSignInTime: 'y' }, providerData: [{ providerId: 'password' }] }]);
  await runExport({
    db,
    auth,
    FieldPath: FakeFieldPath,
    outDir,
    apply: true,
    only: null,
    now: () => new Date('2026-09-27T00:00:00.000Z'),
    git: () => ({ sha: 'deadbeef', dirty: false }),
  });
}

test('verify-bundle passes on a freshly written bundle', async () => {
  const outDir = freshBundleDir();
  try {
    await makeBundle(outDir);
    const { ok, checks } = verifyBundle(outDir);
    assert.equal(ok, true, JSON.stringify(checks.filter((c) => !c.ok), null, 2));
  } finally {
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});

test('verify-bundle FAILS when one byte of a part is changed', async () => {
  const outDir = freshBundleDir();
  try {
    await makeBundle(outDir);
    const partPath = path.join(outDir, 'collections', 'part-00001.jsonl');
    const content = readFileSync(partPath, 'utf8');
    writeFileSync(partPath, content.replace('Summer', 'SUMMER!!'));
    const { ok, checks } = verifyBundle(outDir);
    assert.equal(ok, false);
    assert.ok(checks.some((c) => !c.ok && c.name.includes('hashes correctly')));
  } finally {
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});

test('verify-bundle FAILS when a part is missing', async () => {
  const outDir = freshBundleDir();
  try {
    await makeBundle(outDir);
    const partPath = path.join(outDir, 'collections', 'part-00001.jsonl');
    unlinkSync(partPath);
    const { ok, checks } = verifyBundle(outDir);
    assert.equal(ok, false);
    assert.ok(checks.some((c) => !c.ok));
  } finally {
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});

test('verify-bundle FAILS when a line is added to a part (bytes/sha mismatch)', async () => {
  const outDir = freshBundleDir();
  try {
    await makeBundle(outDir);
    const partPath = path.join(outDir, 'collections', 'part-00001.jsonl');
    appendFileSync(partPath, '{"path":"collections/extra","id":"extra","createTime":null,"updateTime":null,"data":{}}\n');
    const { ok, checks } = verifyBundle(outDir);
    assert.equal(ok, false);
    assert.ok(checks.some((c) => !c.ok && (c.name.includes('hashes correctly') || c.name.includes('bytes') || c.name.includes('sha256'))));
  } finally {
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});

// ── Review round 1, fix 8 ───────────────────────────────────────────────────

test('fix 8: isUnsafeRelativePath rejects absolute paths and .. segments, accepts ordinary relative paths', () => {
  assert.equal(isUnsafeRelativePath('collections/part-00001.jsonl'), false);
  assert.equal(isUnsafeRelativePath('_verify/productsPublic.jsonl'), false);
  assert.equal(isUnsafeRelativePath('/etc/passwd'), true);
  assert.equal(isUnsafeRelativePath('../outside/file'), true);
  assert.equal(isUnsafeRelativePath('collections/../../../etc/passwd'), true);
  assert.equal(isUnsafeRelativePath('C:\\Windows\\System32'), true);
  assert.equal(isUnsafeRelativePath(''), true);
});

test('fix 8: verify-bundle FAILS (not throws) when SHA256SUMS contains an absolute or ..-escaping path', async () => {
  const outDir = freshBundleDir();
  try {
    await makeBundle(outDir);
    const shaSumsPath = path.join(outDir, 'SHA256SUMS');
    const original = readFileSync(shaSumsPath, 'utf8');
    writeFileSync(shaSumsPath, original + '0000000000000000000000000000000000000000000000000000000000000000  ../../../etc/passwd\n');
    const { ok, checks } = verifyBundle(outDir);
    assert.equal(ok, false);
    assert.ok(checks.some((c) => !c.ok && c.name.includes('safe')));
  } finally {
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});

test('fix 8: a collection listed in the root manifest whose directory/manifest.json is missing is a FAIL, not silently skipped', async () => {
  const outDir = freshBundleDir();
  try {
    await makeBundle(outDir);
    // Remove the whole 'collections' directory (a non-verify-only, carry
    // fate) after the fact, simulating a write that silently failed.
    rmSync(path.join(outDir, 'collections'), { recursive: true, force: true });
    // SHA256SUMS still lists those files, so re-verify would ALSO fail the
    // hash check; regenerate SHA256SUMS without them to isolate the "missing
    // collection manifest" check specifically.
    const shaSumsPath = path.join(outDir, 'SHA256SUMS');
    const filtered = readFileSync(shaSumsPath, 'utf8')
      .split('\n')
      .filter((line) => !line.includes('collections/'))
      .join('\n');
    writeFileSync(shaSumsPath, filtered);
    const { ok, checks } = verifyBundle(outDir);
    assert.equal(ok, false);
    assert.ok(
      checks.some((c) => !c.ok && c.name.includes('collections') && c.name.includes('manifest.json exists')),
      `checks: ${JSON.stringify(checks)}`,
    );
  } finally {
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});

test('fix 8: _auth/users.jsonl line count is checked against authUserCount', async () => {
  const outDir = freshBundleDir();
  try {
    await makeBundle(outDir);
    const passResult = verifyBundle(outDir);
    assert.equal(passResult.ok, true, JSON.stringify(passResult.checks.filter((c) => !c.ok)));

    // Corrupt: append an extra line to _auth/users.jsonl without updating
    // authUserCount in the root manifest, and refresh SHA256SUMS for that one
    // file so only the COUNT check (not the hash check) catches it.
    const authPath = path.join(outDir, '_auth', 'users.jsonl');
    appendFileSync(authPath, '{"uid":"extra","email":null,"emailVerified":false,"disabled":false,"displayName":null,"metadata":{"creationTime":null,"lastSignInTime":null},"providerData":[]}\n');
    const { createHash } = await import('node:crypto');
    const newHash = createHash('sha256').update(readFileSync(authPath)).digest('hex');
    const shaSumsPath = path.join(outDir, 'SHA256SUMS');
    const lines = readFileSync(shaSumsPath, 'utf8').split('\n');
    const updated = lines.map((line) => (line.endsWith('_auth/users.jsonl') ? `${newHash}  _auth/users.jsonl` : line)).join('\n');
    writeFileSync(shaSumsPath, updated);

    const { ok, checks } = verifyBundle(outDir);
    assert.equal(ok, false);
    assert.ok(checks.some((c) => !c.ok && c.name.includes('authUserCount')), `checks: ${JSON.stringify(checks)}`);
  } finally {
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});

test('fix 8: each _verify/<name>.jsonl line count is checked against the root manifest', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const schema = {
      collections: { c1: { data: { title: 'Herr' } } },
      productsPublic: { p1: { data: { name: 'Public product' } } },
    };
    const db = new FakeFirestore(schema);
    const auth = new FakeAuth([{ uid: 'u1', email: 'a@example.com', metadata: {}, providerData: [] }]);
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z'), git: () => ({ sha: 'x', dirty: false }) });

    const passResult = verifyBundle(outDir);
    assert.equal(passResult.ok, true, JSON.stringify(passResult.checks.filter((c) => !c.ok)));

    const verifyPath = path.join(outDir, '_verify', 'productsPublic.jsonl');
    appendFileSync(verifyPath, '{"path":"productsPublic/extra","id":"extra","createTime":null,"updateTime":null,"data":{}}\n');
    const { createHash } = await import('node:crypto');
    const newHash = createHash('sha256').update(readFileSync(verifyPath)).digest('hex');
    const shaSumsPath = path.join(outDir, 'SHA256SUMS');
    const lines = readFileSync(shaSumsPath, 'utf8').split('\n');
    const updated = lines.map((line) => (line.endsWith('_verify/productsPublic.jsonl') ? `${newHash}  _verify/productsPublic.jsonl` : line)).join('\n');
    writeFileSync(shaSumsPath, updated);

    const { ok, checks } = verifyBundle(outDir);
    assert.equal(ok, false);
    assert.ok(
      checks.some((c) => !c.ok && c.name.includes('_verify/productsPublic.jsonl') && c.name.includes('root manifest')),
      `checks: ${JSON.stringify(checks)}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('CLI mode: node lib/verify-bundle.mjs <dir> exits 0 on a good bundle, 1 on a bad one', async () => {
  const outDir = freshBundleDir();
  try {
    await makeBundle(outDir);
    const { execFileSync } = await import('node:child_process');
    const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/verify-bundle.mjs');
    const goodResult = execFileSync('node', [scriptPath, outDir], { encoding: 'utf8' });
    assert.match(goodResult, /PASS: bundle verified/);

    const partPath = path.join(outDir, 'collections', 'part-00001.jsonl');
    writeFileSync(partPath, 'tampered\n');
    let threw = false;
    try {
      execFileSync('node', [scriptPath, outDir], { encoding: 'utf8' });
    } catch (error) {
      threw = true;
      assert.equal(error.status, 1);
      assert.match(error.stdout, /FAIL: bundle verification failed/);
    }
    assert.ok(threw, 'expected the CLI to exit non-zero on a bad bundle');
  } finally {
    rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});
