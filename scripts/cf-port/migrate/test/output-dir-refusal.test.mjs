import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertOutsideRepo as importAssertOutsideRepo, REPO_ROOT as IMPORT_REPO_ROOT } from '../import.mjs';
import { assertOutsideRepo as restoreAssertOutsideRepo } from '../restore-archive.mjs';

function withExitStub(fn) {
  let exited = false;
  let message = '';
  const originalExit = process.exit;
  const originalError = console.error;
  process.exit = () => {
    exited = true;
    throw new Error('exit');
  };
  console.error = (msg) => {
    message = msg;
  };
  try {
    fn();
  } catch {
    // expected when refused
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  return { exited, message };
}

test('import.mjs assertOutsideRepo: refuses a path literally inside the repo', () => {
  const { exited } = withExitStub(() => importAssertOutsideRepo(path.join(IMPORT_REPO_ROOT, 'scripts', 'x')));
  assert.equal(exited, true);
});

test('import.mjs assertOutsideRepo: refuses a path that is the repo root itself', () => {
  const { exited } = withExitStub(() => importAssertOutsideRepo(IMPORT_REPO_ROOT));
  assert.equal(exited, true);
});

test('import.mjs assertOutsideRepo: refuses through a symlink pointing into the repo', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cfport-symlink-'));
  try {
    const linkPath = path.join(base, 'link-to-repo');
    symlinkSync(IMPORT_REPO_ROOT, linkPath);
    const outDir = path.join(linkPath, 'some-output');
    const { exited } = withExitStub(() => importAssertOutsideRepo(outDir));
    assert.equal(exited, true);
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
});

test('import.mjs assertOutsideRepo: accepts a genuinely external path', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cfport-external-'));
  try {
    const { exited } = withExitStub(() => importAssertOutsideRepo(path.join(base, 'plan-out')));
    assert.equal(exited, false);
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
});

test('restore-archive.mjs assertOutsideRepo: refuses a path inside the repo', () => {
  const { exited } = withExitStub(() => restoreAssertOutsideRepo(path.join(IMPORT_REPO_ROOT, 'scripts', 'y')));
  assert.equal(exited, true);
});

test('restore-archive.mjs assertOutsideRepo: accepts a genuinely external path', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cfport-external-'));
  try {
    const { exited } = withExitStub(() => restoreAssertOutsideRepo(path.join(base, 'restore-out')));
    assert.equal(exited, false);
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
});

test('restore-archive.mjs assertOutsideRepo: refuses through a symlink pointing into the repo', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cfport-symlink-'));
  try {
    const linkPath = path.join(base, 'link-to-repo');
    symlinkSync(IMPORT_REPO_ROOT, linkPath);
    const { exited } = withExitStub(() => restoreAssertOutsideRepo(path.join(linkPath, 'some-output')));
    assert.equal(exited, true);
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
});

test('state-from-queries.mjs assertOutsideRepo: refuses inside the repo and through a symlink, accepts an external path', async () => {
  const { assertOutsideRepo: stateAssertOutsideRepo } = await import('../state-from-queries.mjs');
  assert.equal(withExitStub(() => stateAssertOutsideRepo(path.join(IMPORT_REPO_ROOT, 'target-state.json'))).exited, true);
  const base = mkdtempSync(path.join(tmpdir(), 'cfport-symlink-'));
  try {
    const linkPath = path.join(base, 'link-to-repo');
    symlinkSync(IMPORT_REPO_ROOT, linkPath);
    assert.equal(withExitStub(() => stateAssertOutsideRepo(path.join(linkPath, 'target-state.json'))).exited, true);
    assert.equal(withExitStub(() => stateAssertOutsideRepo(path.join(base, 'target-state.json'))).exited, false);
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
});
