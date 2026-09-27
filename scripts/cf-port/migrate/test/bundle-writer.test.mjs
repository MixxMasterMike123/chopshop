import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeParts, writeCollectionManifest, writeShaSums, listFilesRecursive, ensureDir, writeFileSecure, sha256Hex } from '../lib/bundle-writer.mjs';

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'cfport-bundle-'));
}

function doc(p, id, data) {
  return { path: p, id, createTime: '2026-01-01T00:00:00.000Z', updateTime: '2026-01-01T00:00:00.000Z', data };
}

test('part rotation: rotates at the size limit with correct per-part counts and hashes', () => {
  const dir = tmpDir();
  try {
    const docs = Array.from({ length: 10 }, (_, i) => doc(`c/${i}`, String(i), { n: i, pad: 'x'.repeat(50) }));
    // Each line is roughly 70-80 bytes; force a tiny limit so we get multiple parts.
    const parts = writeParts(path.join(dir, 'c'), docs, { maxPartBytes: 200 });
    assert.ok(parts.length > 1, 'expected more than one part');
    let totalDocs = 0;
    for (const part of parts) {
      const filePath = path.join(dir, 'c', part.file);
      const content = readFileSync(filePath);
      assert.equal(content.length, part.bytes);
      assert.equal(sha256Hex(content), part.sha256);
      const lineCount = content.toString('utf8').split('\n').filter((l) => l.length > 0).length;
      assert.equal(lineCount, part.docs);
      totalDocs += part.docs;
    }
    assert.equal(totalDocs, docs.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty collection still writes one empty part', () => {
  const dir = tmpDir();
  try {
    const parts = writeParts(path.join(dir, 'empty'), []);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].docs, 0);
    assert.equal(parts[0].bytes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('determinism: same docs in different insertion order produce byte-identical parts', () => {
  const dirA = tmpDir();
  const dirB = tmpDir();
  try {
    const docsInOrder = [doc('c/a', 'a', { x: 1, y: 2 }), doc('c/b', 'b', { y: 2, x: 1 }), doc('c/c', 'c', { z: 3 })];
    const docsShuffled = [docsInOrder[2], docsInOrder[0], docsInOrder[1]];
    // Both callers must sort by path before calling writeParts (export.mjs does this);
    // simulate that here.
    const sortByPath = (arr) => [...arr].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const partsA = writeParts(path.join(dirA, 'c'), sortByPath(docsInOrder));
    const partsB = writeParts(path.join(dirB, 'c'), sortByPath(docsShuffled));
    assert.deepEqual(
      partsA.map((p) => ({ docs: p.docs, bytes: p.bytes, sha256: p.sha256 })),
      partsB.map((p) => ({ docs: p.docs, bytes: p.bytes, sha256: p.sha256 })),
    );
    const contentA = readFileSync(path.join(dirA, 'c', partsA[0].file));
    const contentB = readFileSync(path.join(dirB, 'c', partsB[0].file));
    assert.deepEqual(contentA, contentB);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('writeShaSums covers every file except itself, sorted by path', () => {
  const dir = tmpDir();
  try {
    ensureDir(path.join(dir, 'sub'));
    writeFileSecure(path.join(dir, 'b.txt'), Buffer.from('b'));
    writeFileSecure(path.join(dir, 'a.txt'), Buffer.from('a'));
    writeFileSecure(path.join(dir, 'sub', 'c.txt'), Buffer.from('c'));
    const files = listFilesRecursive(dir);
    const rows = writeShaSums(dir, files);
    assert.deepEqual(rows.map((r) => r.rel), ['a.txt', 'b.txt', 'sub/c.txt']);
    const shaSumsContent = readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8');
    assert.ok(!shaSumsContent.includes('SHA256SUMS'));
    for (const row of rows) {
      assert.match(row.hash, /^[0-9a-f]{64}$/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file modes: directories 0700, files 0600', () => {
  const dir = tmpDir();
  try {
    ensureDir(path.join(dir, 'sub'));
    writeFileSecure(path.join(dir, 'sub', 'f.txt'), Buffer.from('x'));
    const dirMode = statSync(path.join(dir, 'sub')).mode & 0o777;
    const fileMode = statSync(path.join(dir, 'sub', 'f.txt')).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCollectionManifest writes valid JSON', () => {
  const dir = tmpDir();
  try {
    writeCollectionManifest(dir, { collection: 'c', schemaVersion: 1 });
    const parsed = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(parsed.collection, 'c');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
