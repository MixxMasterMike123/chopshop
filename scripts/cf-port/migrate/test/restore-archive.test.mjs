import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runRestore, SUPPORTED_COLLECTIONS, parseArgs } from '../restore-archive.mjs';
import { scanForbiddenStatements } from '../lib/sql.mjs';
import { tmpDir, rmDir, buildFixtureBundle, FIXED_EMAIL_MAP, FIXED_NOW } from './fixtures.mjs';

async function withFixture(fn) {
  const base = tmpDir();
  const bundleDir = path.join(base, 'bundle');
  try {
    await buildFixtureBundle(bundleDir);
    await fn(bundleDir, base);
  } finally {
    rmDir(base);
  }
}

test('runRestore: shops collection produces a plan with a tenants row', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const result = runRestore({ bundleDir, collection: 'shops', emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.match(result.planText, /INSERT OR IGNORE INTO tenants/);
    assert.deepEqual(scanForbiddenStatements(result.planText), []);
  });
});

test('runRestore: users collection produces a plan with a Better Auth user row', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const result = runRestore({ bundleDir, collection: 'users', emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.match(result.planText, /INSERT OR IGNORE INTO "user"/);
  });
});

test('runRestore: printers collection produces a snapwear printer row', async () => {
  await withFixture(async (bundleDir) => {
    const result = runRestore({ bundleDir, collection: 'printers', env: 'production', now: FIXED_NOW });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.match(result.planText, /INSERT OR IGNORE INTO printers/);
    assert.match(result.planText, /'snapwear'/);
  });
});

test('runRestore: auditLogs collection restores audit_events', async () => {
  await withFixture(async (bundleDir) => {
    const result = runRestore({ bundleDir, collection: 'auditLogs', env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.match(result.planText, /INSERT OR IGNORE INTO audit_events/);
  });
});

test('runRestore: legalAcceptances restore without --id-map keeps legacy_uid, user_id NULL, and reports the limitation', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const result = runRestore({ bundleDir, collection: 'shops__legalAcceptances', emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.match(result.planText, /INSERT OR IGNORE INTO legal_acceptances/);
    assert.ok(result.reportLines.some((l) => l.includes('no --id-map given')));
  });
});

test('runRestore: legalAcceptances restore WITH --id-map maps user_id from the supplied map', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const idMapPath = path.join(base, 'id-map.json');
    writeFileSync(idMapPath, JSON.stringify({ tenantadmin1: 'mapped-user-id-123' }));
    const result = runRestore({ bundleDir, collection: 'shops__legalAcceptances', emailMapPath, env: 'staging', idMapPath, now: FIXED_NOW });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.ok(!result.reportLines.some((l) => l.includes('no --id-map given')));
    assert.match(result.planText, /'mapped-user-id-123'/);
  });
});

test('parseArgs: refuses a collection with no transformation, naming the checkpoint that will add it', () => {
  let exited = false;
  let message = '';
  const originalExit = process.exit;
  const originalError = console.error;
  process.exit = () => { exited = true; throw new Error('exit'); };
  console.error = (msg) => { message = msg; };
  try {
    parseArgs(['--bundle', '/tmp/x', '--collection', 'discountCodes', '--env', 'staging', '--out', '/tmp/y']);
  } catch {
    // expected
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  assert.equal(exited, true);
  assert.match(message, /discountCodes/);
  assert.match(message, /CP4/);
});

test('parseArgs: refuses --target firestore, naming it out of scope', () => {
  let exited = false;
  let message = '';
  const originalExit = process.exit;
  const originalError = console.error;
  process.exit = () => { exited = true; throw new Error('exit'); };
  console.error = (msg) => { message = msg; };
  try {
    parseArgs(['--bundle', '/tmp/x', '--collection', 'shops', '--env', 'staging', '--out', '/tmp/y', '--target', 'firestore']);
  } catch {
    // expected
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  assert.equal(exited, true);
  assert.match(message, /Firestore target/);
});

test('SUPPORTED_COLLECTIONS is exactly the six CP3-owned collections', () => {
  assert.deepEqual(
    [...SUPPORTED_COLLECTIONS].sort(),
    ['auditLogs', 'printerCatalog', 'printers', 'shops', 'shops__legalAcceptances', 'users'].sort(),
  );
});

// ── Review round 1 ──────────────────────────────────────────────────────────

test('runRestore: called without a clock, the plan is the same on every run and its clock is the bundle\'s exportedAt', async () => {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir, { exportedAt: '2026-03-04T05:06:07.089Z' });
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const r1 = runRestore({ bundleDir, collection: 'shops', emailMapPath, env: 'staging' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const r2 = runRestore({ bundleDir, collection: 'shops', emailMapPath, env: 'staging' });
    assert.equal(r1.ok, true, JSON.stringify(r1.problems));
    assert.equal(r1.planText, r2.planText);
    assert.ok(r1.planText.split('\n').find((l) => l.startsWith('INSERT INTO import_runs')).includes("'2026-03-04T05:06:07.089Z'"));
  } finally {
    rmDir(base);
  }
});

test('runRestore: an unmapped address is a refusal with a fingerprint, not a crash, and names no address', async () => {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir);
    const result = runRestore({ bundleDir, collection: 'users', env: 'staging' });
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /fingerprint [0-9a-f]{12}/);
    assert.ok(!/@example\.com/.test(result.problems.join('\n')));
  } finally {
    rmDir(base);
  }
});

test('runRestore: production refuses the two scrub options and carries addresses as they are', async () => {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir);
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    assert.match(runRestore({ bundleDir, collection: 'users', emailMapPath, env: 'production' }).problems[0], /--email-map is a staging option/);
    assert.match(runRestore({ bundleDir, collection: 'users', env: 'production', scrubUnmapped: true }).problems[0], /--scrub-unmapped is a staging option/);
    const plain = runRestore({ bundleDir, collection: 'users', env: 'production' });
    assert.equal(plain.ok, true, JSON.stringify(plain.problems));
    assert.ok(plain.planText.includes("'admin1@example.com'"));
  } finally {
    rmDir(base);
  }
});

test('runRestore: the plan checks of the importer apply — an address inside a longer text refuses a staging restore', async () => {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir, {
      schemaPatch: (schema) => {
        schema.shops['test-shop-a'].data.storeIdentity.returnAddress = 'Testgatan 1. Frågor: owner-a@example.com';
      },
    });
    const result = runRestore({ bundleDir, collection: 'shops', env: 'staging', scrubUnmapped: true });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('source address') && p.includes('tenant_settings')));
    assert.ok(!result.problems.join('\n').includes('owner-a@example.com'));
  } finally {
    rmDir(base);
  }
});
