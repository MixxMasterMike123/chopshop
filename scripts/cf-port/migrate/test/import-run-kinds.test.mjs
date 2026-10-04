/**
 * CP7-T1 — migration 0052 against the plans themselves, on node:sqlite with
 * every migration: production takes one completed import run PER KIND (the
 * platform plan of import.mjs, the catalogue plan of import-catalogue.mjs), the
 * catalogue only after the platform run of the same export, and nothing once
 * production holds an order, a payment event or a checkout (manifest §d P2,
 * P7). The rules of 0052 alone are pinned in cloudflare/test/import-run-kinds.test.ts;
 * the P2/P7 guard is proven here, where every case can start from a fresh
 * database. All data invented (test/catalogue-fixtures.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runImport } from '../import.mjs';
import { buildTargetState, runImportCatalogue, targetQueries } from '../import-catalogue.mjs';
import { rmDir, tmpDir } from './fixtures.mjs';
import { buildCatalogueBundle, DatabaseSync, insertCopiedObjects, inventCopyManifest, migratedDb, writeQueryResults } from './catalogue-fixtures.mjs';

const skip = DatabaseSync === null && 'node:sqlite is unavailable on this Node build';
const PINS = Object.freeze({ origins: { api: 'https://api.invalid' }, r2: { publicBaseUrl: 'https://img.example.test' } });
const ORDERS_REFUSAL = /production holds orders: nothing is imported after the first order/;
const ONCE_REFUSAL = /an import run starts running, once, one at a time/;

/** The production platform plan and catalogue plan of one invented export, both built before either is applied. */
async function productionPlans() {
  const base = tmpDir('cfport-run-kinds-');
  const bundleDir = path.join(base, 'bundle');
  await buildCatalogueBundle(bundleDir);
  const platform = runImport({ bundleDir, env: 'production' });
  assert.equal(platform.ok, true, JSON.stringify(platform.problems));
  const manifest = inventCopyManifest(bundleDir, { env: 'production' });
  const manifestPath = path.join(base, 'copy-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));

  // The target the catalogue plan is read from: the platform plan and the copy's objects applied.
  const reference = migratedDb();
  reference.exec(platform.planText);
  insertCopiedObjects(reference, manifest);
  const queries = path.join(base, 'target-queries');
  mkdirSync(queries);
  writeQueryResults(reference, targetQueries('production'), queries);
  const targetPath = path.join(base, 'target-state.json');
  writeFileSync(targetPath, JSON.stringify(buildTargetState(queries)));
  const catalogue = await runImportCatalogue({ bundleDir, confirm: 'production', copyManifestPath: manifestPath, env: 'production', pinned: PINS, targetStatePath: targetPath });
  assert.equal(catalogue.ok, true, JSON.stringify(catalogue.problems));
  return { base, bundleDir, catalogue, manifest, manifestPath, platform, targetPath };
}

/** A migrated database with the copy's objects of `manifest` (and the platform plan when `platform` is given). */
function target(plans, { platform = true } = {}) {
  const db = migratedDb();
  if (platform) {
    db.exec(plans.platform.planText);
    insertCopiedObjects(db, plans.manifest);
  }
  return db;
}

/**
 * One row in `table`, every NOT NULL column without a default filled with a
 * placeholder, foreign keys and CHECKs off for that one insert: the guard
 * asks only whether a row exists.
 */
function insertRow(db, table, fixed) {
  const columns = db.prepare(`SELECT name, type, "notnull" AS required, dflt_value AS fallback FROM pragma_table_info('${table}')`).all();
  const row = {};
  for (const column of columns) {
    if (column.name in fixed) row[column.name] = fixed[column.name];
    else if (column.required === 1 && column.fallback === null) row[column.name] = /INT/i.test(column.type) ? 0 : 'x';
  }
  const names = Object.keys(row);
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
  try {
    db.prepare(`INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => row[n]));
  } finally {
    db.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON;');
  }
}

const ORDER_TABLES = {
  checkouts: (db) => insertRow(db, 'checkouts', { checkout_id: 'co-1', tenant_id: 'shop-x' }),
  orders: (db) => {
    // An order is made from a checkout of its own tenant (0011's trigger).
    insertRow(db, 'checkouts', { checkout_id: 'co-1', tenant_id: 'shop-x' });
    insertRow(db, 'orders', { checkout_id: 'co-1', order_id: 'ord-1', tenant_id: 'shop-x' });
  },
  payment_events: (db) => insertRow(db, 'payment_events', { event_id: 'evt_1', tenant_id: null }),
};

const runsOf = (db) => db.prepare('SELECT kind, status FROM import_runs ORDER BY kind, status').all().map((r) => ({ ...r }));

test('production, in order: the platform plan, then the catalogue plan; neither lands a second time', { skip }, async () => {
  const plans = await productionPlans();
  try {
    assert.ok(plans.platform.planText.includes("INSERT INTO import_runs (run_id, env, bundle_sha,"), 'the platform plan names no kind: the column default');
    assert.ok(plans.catalogue.planText.includes("INSERT INTO import_runs (run_id, env, kind, bundle_sha,"));

    // The catalogue cannot go first: its rows name the platform import's tenants.
    const empty = target(plans, { platform: false });
    assert.throws(() => empty.exec(plans.catalogue.planText), /the catalogue is imported after the platform import of the same export/);
    assert.deepEqual(runsOf(empty), []);

    const db = target(plans);
    db.exec(plans.catalogue.planText);
    assert.deepEqual(runsOf(db), [
      { kind: 'catalogue', status: 'completed' },
      { kind: 'platform', status: 'completed' },
    ]);

    // The same files again: refused by their first statement.
    assert.throws(() => db.exec(plans.platform.planText), ONCE_REFUSAL);
    assert.throws(() => db.exec(plans.catalogue.planText), ONCE_REFUSAL);

    // New plans with other run ids (other options): the database refuses them, whatever the tools let through.
    const otherState = path.join(plans.base, 'other-target.json');
    writeFileSync(otherState, JSON.stringify({ tenants: { ids: [] } }));
    const platform2 = runImport({ bundleDir: plans.bundleDir, env: 'production', targetStatePath: otherState });
    assert.equal(platform2.ok, true, JSON.stringify(platform2.problems));
    assert.notEqual(platform2.planJson.runId, plans.platform.planJson.runId);
    assert.throws(() => db.exec(platform2.planText), ONCE_REFUSAL);
    writeFileSync(plans.manifestPath, JSON.stringify(plans.manifest, null, 1));
    const catalogue2 = await runImportCatalogue({ bundleDir: plans.bundleDir, confirm: 'production', copyManifestPath: plans.manifestPath, env: 'production', pinned: PINS, targetStatePath: plans.targetPath });
    assert.equal(catalogue2.ok, true, JSON.stringify(catalogue2.problems));
    assert.notEqual(catalogue2.runId, plans.catalogue.runId);
    assert.throws(() => db.exec(catalogue2.planText), ONCE_REFUSAL);
    assert.deepEqual(runsOf(db), [
      { kind: 'catalogue', status: 'completed' },
      { kind: 'platform', status: 'completed' },
    ]);
  } finally {
    rmDir(plans.base);
  }
});

test('P2/P7: an order, a payment event or a checkout refuses either production plan at its first statement', { skip }, async () => {
  const plans = await productionPlans();
  try {
    for (const [table, insert] of Object.entries(ORDER_TABLES)) {
      const before = target(plans, { platform: false });
      insert(before);
      assert.throws(() => before.exec(plans.platform.planText), ORDERS_REFUSAL, `${table} before the platform plan`);
      assert.deepEqual(runsOf(before), [], table);

      const between = target(plans);
      insert(between);
      assert.throws(() => between.exec(plans.catalogue.planText), ORDERS_REFUSAL, `${table} before the catalogue plan`);
      assert.equal(between.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0, table);
    }
  } finally {
    rmDir(plans.base);
  }
});

test('P2/P7: a production run started before the first order does not complete after it; staging is not guarded', { skip }, () => {
  const db = migratedDb();
  const start = (runId, env) =>
    db.exec(`INSERT INTO import_runs (run_id, env, bundle_sha, plan_sha, started_at, status) VALUES ('${runId}', '${env}', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '2026-10-04T00:00:00.000Z', 'running');`);
  const finish = (runId, status) =>
    db.exec(`UPDATE import_runs SET status = '${status}', finished_at = '2026-10-04T00:01:00.000Z' WHERE run_id = '${runId}';`);
  start('prod-1', 'production');
  ORDER_TABLES.payment_events(db);
  assert.throws(() => finish('prod-1', 'completed'), ORDERS_REFUSAL);
  finish('prod-1', 'failed'); // closing it is always allowed
  assert.throws(() => start('prod-2', 'production'), ORDERS_REFUSAL);
  start('stg-1', 'staging');
  finish('stg-1', 'completed');
  assert.deepEqual(db.prepare('SELECT run_id, status FROM import_runs ORDER BY run_id').all().map((r) => ({ ...r })), [
    { run_id: 'prod-1', status: 'failed' },
    { run_id: 'stg-1', status: 'completed' },
  ]);
});
