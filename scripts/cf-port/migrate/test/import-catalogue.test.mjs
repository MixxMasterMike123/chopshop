/**
 * import-catalogue.mjs + verify-catalogue.mjs, end to end on node:sqlite: the
 * CP3 plan applied, the copy's objects in place, the catalogue plan built,
 * applied and verified. Refusals first, then the rows, then the checks of
 * the verifier. All data invented (test/catalogue-fixtures.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runImport } from '../import.mjs';
import { productionOptions } from './production-fixtures.mjs';
import { buildApplyMd, buildTargetState, productionPinProblems, readPinned, REPO_ROOT, runImportCatalogue, targetQueries } from '../import-catalogue.mjs';
import { actualQueries, buildActualState, envProblem, liftedShopGate, runChecks } from '../verify-catalogue.mjs';
import { loadWorkerRules } from '../lib/worker-rules.mjs';
import { scanForbiddenStatements } from '../lib/sql.mjs';
import { FIREBASE_STORAGE_HOSTS } from '../lib/scrub.mjs';
import { deterministicId } from '../lib/ids.mjs';
import { objectKeyOf, sourceKeyOf as sourceKey } from '../lib/copy-manifest.mjs';
import { verifyBundle } from '../lib/verify-bundle.mjs';
import { FIXED_EMAIL_MAP, rmDir, tmpDir } from './fixtures.mjs';
import { buildCatalogueBundle, DatabaseSync, img, insertCopiedObjects, inventCopyManifest, migratedDb, writeQueryResults } from './catalogue-fixtures.mjs';

const skip = DatabaseSync === null && 'node:sqlite is unavailable on this Node build';
const rules = await loadWorkerRules();

/** CP3 applied, the copy's objects written, the target state read: what a reviewer has before the plan. */
async function setup({ patch = null, statusOf, manifestPatch = null, objectFilter = null, dbPatch = null } = {}) {
  const base = tmpDir('cfport-catalogue-');
  const bundleDir = path.join(base, 'bundle');
  await buildCatalogueBundle(bundleDir, { patch });
  const emailMapPath = path.join(base, 'email-map.json');
  writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
  const cp3 = runImport({ bundleDir, emailMapPath, env: 'staging' });
  assert.equal(cp3.ok, true, JSON.stringify(cp3.problems));
  const db = migratedDb();
  db.exec(cp3.planText);
  const manifest = inventCopyManifest(bundleDir, { statusOf });
  if (manifestPatch) manifestPatch(manifest);
  const manifestPath = path.join(base, 'copy-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  insertCopiedObjects(db, objectFilter ? { ...manifest, entries: manifest.entries.filter(objectFilter) } : manifest);
  if (dbPatch) dbPatch(db);
  const targetPath = readTarget(db, base, 'target');
  return { base, bundleDir, db, emailMapPath, manifest, manifestPath, targetPath };
}

function readTarget(db, base, name, env = 'staging') {
  const dir = path.join(base, `${name}-queries`);
  mkdirSync(dir, { recursive: true });
  writeQueryResults(db, targetQueries(env), dir);
  const file = path.join(base, `${name}-state.json`);
  writeFileSync(file, JSON.stringify(buildTargetState(dir)));
  return file;
}

function readActual(db, base, name = 'actual') {
  const dir = path.join(base, `${name}-queries`);
  mkdirSync(dir, { recursive: true });
  writeQueryResults(db, actualQueries(rules), dir);
  return buildActualState(dir);
}

const run = (s, extra = {}) =>
  runImportCatalogue({ bundleDir: s.bundleDir, copyManifestPath: s.manifestPath, env: 'staging', scrubUnmapped: true, targetStatePath: s.targetPath, ...extra });

const one = (db, sql, ...args) => db.prepare(sql).get(...args);
const all = (db, sql, ...args) => db.prepare(sql).all(...args);
const objectOf = (manifest, address) => manifest.entries.find((e) => e.shopId === 'test-shop-a' && e.sourceKey === sourceKey(address));

// ── refusals ────────────────────────────────────────────────────────────────

// ── production (CP7-T1) ─────────────────────────────────────────────────────

// Injected, as the tests inject every origin: cloudflare/pinned.production.json
// is never edited. `https://api.invalid` is the invented manifest's API.
const PRODUCTION_PINS = Object.freeze({ origins: { api: 'https://api.invalid' }, r2: { publicBaseUrl: 'https://img.example.test' } });

/** The production platform plan applied, the copy's objects in place, the target state read. */
async function setupProduction({ manifestPatch = null, statusOf } = {}) {
  const base = tmpDir('cfport-catalogue-prod-');
  const bundleDir = path.join(base, 'bundle');
  await buildCatalogueBundle(bundleDir);
  const cp3 = runImport({ bundleDir, env: 'production', ...(await productionOptions(base, { buildRescan: (dir, exportedAt) => buildCatalogueBundle(dir, { exportedAt }) })) });
  assert.equal(cp3.ok, true, JSON.stringify(cp3.problems));
  const db = migratedDb();
  db.exec(cp3.planText);
  const manifest = inventCopyManifest(bundleDir, { env: 'production', statusOf });
  if (manifestPatch) manifestPatch(manifest);
  const manifestPath = path.join(base, 'copy-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  insertCopiedObjects(db, manifest);
  const targetPath = readTarget(db, base, 'target', 'production');
  return { base, bundleDir, cp3, db, manifest, manifestPath, targetPath };
}

const runProduction = (s, extra = {}) =>
  runImportCatalogue({ bundleDir: s.bundleDir, confirm: 'production', copyManifestPath: s.manifestPath, env: 'production', pinned: PRODUCTION_PINS, targetStatePath: s.targetPath, ...extra });

test('production: refused without --confirm production; --confirm belongs to production only', { skip }, async () => {
  const s = await setupProduction();
  try {
    for (const confirm of [null, undefined, 'yes', 'staging']) {
      const result = await runProduction(s, { confirm });
      assert.equal(result.ok, false);
      assert.deepEqual(result.problems, ['REFUSED: --env production needs --confirm production (the explicit confirmation of a production run)']);
    }
    const staging = await runImportCatalogue({ bundleDir: s.bundleDir, confirm: 'production', copyManifestPath: s.manifestPath, env: 'staging', targetStatePath: s.targetPath });
    assert.deepEqual(staging.problems, ['REFUSED: --confirm production belongs to --env production only']);
    assert.deepEqual((await runProduction(s, { env: 'prod' })).problems, ['REFUSED: --env must be staging or production']);
  } finally {
    rmDir(s.base);
  }
});

test('production: each null pin of cloudflare/pinned.production.json is its own refusal; the CLI reads the real file', { skip }, async () => {
  const s = await setupProduction();
  try {
    assert.deepEqual((await runProduction(s, { pinned: null })).problems, ['REFUSED: cloudflare/pinned.production.json does not exist']);
    assert.deepEqual((await runProduction(s, { pinned: { ...PRODUCTION_PINS, origins: { api: null } } })).problems, [
      'REFUSED: cloudflare/pinned.production.json origins.api is null: the copy manifest cannot be checked against the production API',
    ]);
    assert.deepEqual((await runProduction(s, { pinned: { ...PRODUCTION_PINS, r2: { publicBaseUrl: null } } })).problems, [
      'REFUSED: cloudflare/pinned.production.json r2.publicBaseUrl is null: a page image would have no public address',
    ]);
    // Without an injected pin the file itself is read (never written): whatever it lacks today is refused.
    const today = productionPinProblems(readPinned('production'));
    if (today.length > 0) {
      const result = await runImportCatalogue({ bundleDir: s.bundleDir, confirm: 'production', copyManifestPath: s.manifestPath, env: 'production', targetStatePath: s.targetPath });
      assert.deepEqual(result.problems, today);
    }
  } finally {
    rmDir(s.base);
  }
});

test('production: --email-map and --scrub-unmapped are staging options', { skip }, async () => {
  const s = await setupProduction();
  try {
    assert.match((await runProduction(s, { scrubUnmapped: true })).problems.join('\n'), /--scrub-unmapped is a staging option/);
    assert.match((await runProduction(s, { emailMapPath: s.manifestPath })).problems.join('\n'), /--email-map is a staging option/);
  } finally {
    rmDir(s.base);
  }
});

test('production: the copy manifest must be of production, of the pinned API, without a failed file, and cover every file', { skip }, async () => {
  const s = await setupProduction();
  try {
    const manifest = JSON.parse(readFileSync(s.manifestPath, 'utf8'));
    const refused = async (patched, pattern) => {
      writeFileSync(s.manifestPath, JSON.stringify(patched));
      const result = await runProduction(s);
      assert.equal(result.ok, false);
      assert.match(result.problems.join('\n'), pattern);
    };
    await refused({ ...manifest, env: 'staging' }, /the copy manifest is of staging, not production/);
    await refused({ ...manifest, apiOrigin: 'https://chopshop-api-stg.example.test' }, /written against another API than the pinned production API/);
    const failed = structuredClone(manifest);
    Object.assign(failed.entries.find((e) => e.use === 'product_image' && e.status === 'copied'), { contentType: null, objectId: null, reason: 'timeout', sha256: null, sizeBytes: 0, status: 'failed' });
    await refused(failed, /the copy manifest holds 1 failed file\(s\): run storage-copy\.mjs again until none is failed/);
    await refused({ ...manifest, entries: manifest.entries.slice(1) }, /1 file\(s\) of the export have no entry in the copy manifest/);
    writeFileSync(s.manifestPath, JSON.stringify(manifest));
    const ok = await runProduction(s);
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));
    // A refused or missing file is a final result of the copy: the plan is made without it.
    const missing = structuredClone(manifest);
    Object.assign(missing.entries.find((e) => e.use === 'product_image'), { contentType: null, objectId: null, reason: 'http_404', sha256: null, sizeBytes: 0, status: 'missing' });
    writeFileSync(s.manifestPath, JSON.stringify(missing));
    assert.equal((await runProduction(s)).ok, true);
  } finally {
    rmDir(s.base);
  }
});

test('production: the target must hold the completed platform run of this export, and no completed catalogue run', { skip }, async () => {
  const s = await setupProduction();
  try {
    const state = JSON.parse(readFileSync(s.targetPath, 'utf8'));
    const noRun = path.join(s.base, 'no-run.json');
    writeFileSync(noRun, JSON.stringify({ ...state, importRuns: [] }));
    assert.match((await runProduction(s, { targetStatePath: noRun })).problems.join('\n'), /no completed CP3 import run of this bundle: apply CP3 first/);
    const other = path.join(s.base, 'other-export.json');
    writeFileSync(other, JSON.stringify({ ...state, importRuns: state.importRuns.map((r) => ({ ...r, bundleSha: 'f'.repeat(64) })) }));
    assert.match((await runProduction(s, { targetStatePath: other })).problems.join('\n'), /no completed CP3 import run of this bundle/);
    // A completed catalogue run of ANY export: production imports its catalogue once.
    const done = path.join(s.base, 'catalogue-done.json');
    writeFileSync(done, JSON.stringify({ ...state, importRuns: [...state.importRuns, { bundleSha: 'f'.repeat(64), env: 'production', runId: 'catalogue_production_x', status: 'completed' }] }));
    const result = await runProduction(s, { targetStatePath: done });
    assert.deepEqual(result.problems.filter((p) => /catalogue run/.test(p)), ['REFUSED: production already holds a completed catalogue run: the catalogue is imported once (0052)']);
  } finally {
    rmDir(s.base);
  }
});

test('production: the plan names its kind, applies after the platform run, verifies, and is refused a second time', { skip }, async () => {
  const s = await setupProduction();
  try {
    const result = await runProduction(s);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.match(result.runId, /^catalogue_production_[0-9a-f]{16}_[0-9a-f]{16}$/);
    assert.equal(result.planJson.kind, 'catalogue');
    assert.equal(result.planJson.env, 'production');
    const first = result.planText.split('\n').find((line) => line.startsWith('INSERT INTO import_runs'));
    assert.match(first, /^INSERT INTO import_runs \(run_id, env, kind, bundle_sha,/);
    assert.ok(first.includes("'production', 'catalogue', "));
    assert.equal(result.planText.includes('shopowner@example.com'), true, 'production carries an address inside a text as it is');
    assert.match(buildApplyMd({ env: 'production', planSha: result.planSha, runId: result.runId }), /verify-catalogue\.mjs --env production --confirm production --bundle/);

    s.db.exec(result.planText);
    assert.deepEqual(all(s.db, 'SELECT kind, status FROM import_runs ORDER BY kind').map((r) => ({ ...r })), [
      { kind: 'catalogue', status: 'completed' },
      { kind: 'platform', status: 'completed' },
    ]);
    const checks = runChecks({ actualState: readActual(s.db, s.base), bundleVerified: true, planJson: result.planJson, rules });
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    // A shop that is not live yet: production says what makes it live, not staging's review step.
    s.db.exec("UPDATE tenants SET published = 0 WHERE tenant_id = 'test-shop-a';");
    const hidden = runChecks({ actualState: readActual(s.db, s.base, 'hidden'), bundleVerified: true, planJson: result.planJson, rules });
    assert.deepEqual(hidden.filter((c) => !c.ok), []);
    assert.match(hidden.find((c) => c.name === 'public test-shop-a: the projection now (the shop is not live yet)').note, /adopted the legal pages.*CP7 runbook/);

    // The same file again: refused by its first statement.
    assert.throws(() => s.db.exec(result.planText), /an import run starts running, once, one at a time/);
    // A new plan read from the target after the apply: refused by the tool.
    const after = readTarget(s.db, s.base, 'after', 'production');
    const again = await runProduction(s, { targetStatePath: after });
    assert.equal(again.ok, false);
    assert.match(again.problems.join('\n'), /production already holds a completed catalogue run/);
  } finally {
    rmDir(s.base);
  }
});

test('the CLIs: production needs --confirm production, for the queries and for the run alike', () => {
  const MIGRATE = path.join(REPO_ROOT, 'scripts', 'cf-port', 'migrate');
  const cli = (tool, ...args) => spawnSync(process.execPath, [path.join(MIGRATE, tool), ...args], { encoding: 'utf8' });
  const confirmRefusal = /REFUSED: --env production needs --confirm production/;
  for (const [tool, label] of [['import-catalogue.mjs', 'IMPORT-CATALOGUE'], ['verify-catalogue.mjs', 'VERIFY-CATALOGUE']]) {
    const queries = cli(tool, '--print-queries', '--env', 'production');
    assert.equal(queries.status, 1, `${tool}: ${queries.stderr}`);
    assert.match(queries.stderr, new RegExp(`${label} REFUSED: --env production needs --confirm production`));
    const confirmed = cli(tool, '--print-queries', '--env', 'production', '--confirm', 'production');
    assert.equal(confirmed.status, 0, `${tool}: ${confirmed.stderr}`);
    assert.match(confirmed.stdout, /scripts\/cf-preflight\.sh production -- d1 execute chopshop-prod --remote --json/);
    const staging = cli(tool, '--print-queries', '--env', 'staging', '--confirm', 'production');
    assert.equal(staging.status, 1);
    assert.match(staging.stderr, /--confirm production belongs to --env production only/);
  }
  const verifyRun = cli('verify-catalogue.mjs', '--env', 'production', '--bundle', '/nonexistent', '--plan', '/nonexistent', '--actual-state', '/nonexistent');
  assert.equal(verifyRun.status, 1);
  assert.match(verifyRun.stderr, confirmRefusal);
  const importRun = cli('import-catalogue.mjs', '--env', 'production', '--bundle', '/nonexistent', '--copy-manifest', '/nonexistent', '--target-state', '/nonexistent', '--out', '/nonexistent-out');
  assert.equal(importRun.status, 1);
  assert.match(importRun.stdout, confirmRefusal);
});

test('verify-catalogue: --env production needs --confirm production; --confirm belongs to production only', () => {
  assert.equal(envProblem('staging', null), null);
  assert.equal(envProblem('production', 'production'), null);
  assert.equal(envProblem('production', null), '--env production needs --confirm production (the explicit confirmation of a production run)');
  assert.equal(envProblem('staging', 'production'), '--confirm production belongs to --env production only');
  assert.equal(envProblem('prod', 'production'), '--env must be staging or production');
  assert.equal(envProblem(null, null), '--env must be staging or production');
});

test('refuses without a target state, and a target without CP3\'s completed run of this bundle', { skip }, async () => {
  const s = await setup();
  try {
    const none = await run(s, { targetStatePath: null });
    assert.equal(none.ok, false);
    assert.match(none.problems.join('\n'), /--target-state is required/);
    const state = JSON.parse(readFileSync(s.targetPath, 'utf8'));
    state.importRuns = [];
    const noRun = path.join(s.base, 'no-run.json');
    writeFileSync(noRun, JSON.stringify(state));
    const result = await run(s, { targetStatePath: noRun });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /no completed CP3 import run of this bundle/);
  } finally {
    rmDir(s.base);
  }
});

test('refuses a copy manifest of another bundle or another environment', { skip }, async () => {
  const s = await setup();
  try {
    const manifest = JSON.parse(readFileSync(s.manifestPath, 'utf8'));
    writeFileSync(s.manifestPath, JSON.stringify({ ...manifest, bundleManifestSha256: 'a'.repeat(64) }));
    let result = await run(s);
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /not made from this bundle/);
    writeFileSync(s.manifestPath, JSON.stringify({ ...manifest, env: 'production' }));
    result = await run(s);
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /copy manifest is of production/);
  } finally {
    rmDir(s.base);
  }
});

test('refuses when an object of the manifest is not the copied object in the target', { skip }, async () => {
  const logo = img('logo.png');
  const s = await setup({ objectFilter: (entry) => entry.sourceKey !== sourceKey(logo) });
  try {
    const result = await run(s);
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /1 object id\(s\) of the copy manifest are not in the target/);
  } finally {
    rmDir(s.base);
  }
});

test('refuses an e-mail address inside a text on staging unless it is mapped or --scrub-unmapped is given', { skip }, async () => {
  const s = await setup();
  try {
    const result = await run(s, { emailMapPath: s.emailMapPath, scrubUnmapped: false });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /unmapped email address at products\/p-free\.description/);
    assert.doesNotMatch(result.problems.join('\n'), /shopowner/);
  } finally {
    rmDir(s.base);
  }
});

test('refuses a target that already holds its rows, and re-applying the same file refuses on its first line', { skip }, async () => {
  const s = await setup();
  try {
    const result = await run(s);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    s.db.exec(result.planText);
    assert.throws(() => s.db.exec(result.planText), /an import run starts running, once, one at a time/);
    const after = readTarget(s.db, s.base, 'after');
    const again = await run(s, { targetStatePath: after });
    assert.equal(again.ok, false);
    const text = again.problems.join('\n');
    assert.match(text, /already holds \d+ row\(s\) this plan writes \(product id\)/);
    assert.match(text, /already holds a completed catalogue run of this bundle/);
  } finally {
    rmDir(s.base);
  }
});

test('an apply that stopped halfway resumes: the same file without its first statement completes the same run', { skip }, async () => {
  const s = await setup();
  try {
    const result = await run(s);
    const lines = result.planText.split('\n');
    const half = lines.findIndex((line) => line.startsWith('-- ── collections'));
    s.db.exec(lines.slice(0, half).join('\n'));
    assert.equal(one(s.db, 'SELECT status FROM import_runs WHERE run_id = ?', result.runId).status, 'running');
    const first = lines.findIndex((line) => line.startsWith('INSERT INTO import_runs'));
    s.db.exec(lines.filter((_, i) => i !== first).join('\n'));
    assert.equal(one(s.db, 'SELECT status FROM import_runs WHERE run_id = ?', result.runId).status, 'completed');
    const checks = runChecks({ actualState: readActual(s.db, s.base), bundleVerified: true, planJson: result.planJson, rules });
    assert.deepEqual(checks.filter((c) => !c.ok), []);
  } finally {
    rmDir(s.base);
  }
});

// ── the plan ────────────────────────────────────────────────────────────────

test('the plan passes CP3\'s checks and is deterministic; another option is another run', { skip }, async () => {
  const s = await setup();
  try {
    const a = await run(s);
    const b = await run(s);
    assert.equal(a.ok, true, JSON.stringify(a.problems));
    assert.equal(a.planText, b.planText);
    assert.deepEqual(scanForbiddenStatements(a.planText), []);
    for (const host of FIREBASE_STORAGE_HOSTS) assert.equal(a.planText.includes(host), false);
    assert.equal(rules.isSourceStorageAddress(a.planText), false, 'no address of the source\'s storage anywhere in the plan');
    assert.equal(a.planText.includes('files.example.test'), false);
    assert.equal(a.planText.includes('shopowner@example.com'), false, 'the address in a text is scrubbed');
    assert.ok(a.planText.startsWith('-- scripts/cf-port/migrate/import-catalogue.mjs'));
    assert.match(a.runId, /^catalogue_staging_[0-9a-f]{16}_[0-9a-f]{16}$/);
    const mapped = path.join(s.base, 'map2.json');
    writeFileSync(mapped, JSON.stringify({ 'shopowner@example.com': 'owner-test@example.com' }));
    const c = await run(s, { emailMapPath: mapped, scrubUnmapped: false });
    assert.equal(c.ok, true, JSON.stringify(c.problems));
    assert.notEqual(c.runId, a.runId);
    assert.ok(c.planText.includes('owner-test@example.com'));
    assert.match(buildApplyMd({ env: 'staging', planSha: a.planSha, runId: a.runId }), /screening-terms\/rescreen/);
  } finally {
    rmDir(s.base);
  }
});

test('applied: the rows are the field table\'s, the screening is a new product\'s, and verify passes every check', { skip }, async () => {
  const s = await setup();
  try {
    const result = await run(s);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const versionBefore = one(s.db, "SELECT catalog_version AS v FROM tenants WHERE tenant_id = 'test-shop-a'").v;
    s.db.exec(result.planText);
    const { db, manifest } = s;

    const plain = one(db, "SELECT * FROM products WHERE product_id = 'p-plain'");
    assert.equal(plain.handle, rules.productHandle('Plain Tee', null, 'PLAIN-1'));
    assert.equal(plain.handle, 'plain-tee_PLAIN-1');
    assert.equal(plain.status, 'active');
    assert.equal(plain.b2c_price_minor, 10000);
    assert.equal(plain.compare_at_price_minor, 14950);
    assert.equal(plain.category, 'Tröjor');
    assert.equal(plain.category_key, 'trojor');
    assert.equal(plain.featured, 1);
    assert.equal(plain.weight_grams, 250);
    assert.equal(plain.allow_shipping, 1);
    assert.equal(plain.allow_pickup, 0);
    assert.deepEqual(JSON.parse(plain.shipping_json), { eu: { cost: 0 }, nordic: { cost: 0 }, sweden: { cost: 4900 }, worldwide: { cost: 0 } });
    assert.equal(plain.more_info, '<p>More <strong>info</strong></p>');
    assert.equal(plain.is_personalized, 0);
    assert.deepEqual(all(db, "SELECT tag, tag_key, position FROM product_tags WHERE product_id = 'p-plain'").map((r) => ({ ...r })), [{ position: 0, tag: 'Nyhet', tag_key: 'nyhet' }]);
    assert.deepEqual(
      all(db, "SELECT object_id, variant_id FROM product_images WHERE product_id = 'p-plain' ORDER BY position").map((r) => r.object_id),
      [objectOf(manifest, img('plain-1.jpg')).objectId, objectOf(manifest, img('plain-2.jpg')).objectId],
    );

    // The rail: 4 variants in the source's order; each colour's photos once, on its first size.
    const variants = all(db, "SELECT variant_id, sku, variant_group, size, position, price_minor FROM product_variants WHERE product_id = 'p-rail' ORDER BY position");
    assert.deepEqual(variants.map((v) => [v.sku, v.variant_group, v.size, v.position, v.price_minor]), [
      ['RAIL-1-BLK-S', 'Svart', 'S', 0, 10000],
      ['RAIL-1-BLK-M', 'Svart', 'M', 1, 10000],
      ['RAIL-1-WHT-S', 'Vit', 'S', 2, 9000],
      ['RAIL-1-WHT-M', 'Vit', 'M', 3, 9050],
    ]);
    assert.equal(variants[0].variant_id, deterministicId('product_variant', 'staging', 'p-rail', 'RAIL-1-BLK-S'));
    const railImages = all(db, "SELECT position, variant_id, object_id FROM product_images WHERE product_id = 'p-rail' ORDER BY position");
    assert.deepEqual(railImages.map((r) => [r.object_id, r.variant_id]), [
      [objectOf(manifest, img('rail-main.jpg')).objectId, null],
      [objectOf(manifest, img('black.jpg')).objectId, variants[0].variant_id],
      [objectOf(manifest, img('black-2.jpg')).objectId, variants[0].variant_id],
      [objectOf(manifest, img('white.jpg')).objectId, variants[2].variant_id],
    ]);

    // Inactive → draft, no publication, no screening row (the Worker's new product); delivery absent → both on.
    const draft = one(db, "SELECT status, allow_shipping, allow_pickup FROM products WHERE product_id = 'p-draft'");
    assert.deepEqual({ ...draft }, { allow_pickup: 1, allow_shipping: 1, status: 'draft' });
    assert.equal(one(db, "SELECT COUNT(*) AS n FROM product_publications WHERE product_id = 'p-draft'").n, 0);
    assert.equal(one(db, "SELECT COUNT(*) AS n FROM product_screening WHERE product_id = 'p-draft'").n, 0);

    // Screening: never approved; the term version empty, so the sweep screens every published product.
    const screening = all(db, 'SELECT product_id, status, decided_by, terms_version, requires_approval, screened_tokens FROM product_screening ORDER BY product_id');
    assert.deepEqual(screening.map((r) => r.product_id), ['p-free', 'p-plain', 'p-pod', 'p-rail']);
    for (const row of screening) assert.deepEqual({ ...row, product_id: undefined }, { decided_by: 'import', product_id: undefined, requires_approval: 0, screened_tokens: null, status: 'advisory', terms_version: null });

    // The POD product is published but off the storefront without a mapping (D83).
    const pod = one(db, "SELECT is_pod FROM products WHERE product_id = 'p-pod'");
    assert.equal(pod.is_pod, 1);
    const publicNow = all(db, `SELECT product.product_id AS id ${rules.ELIGIBLE_PRODUCTS_FROM} WHERE product.tenant_id = 'test-shop-a' AND ${rules.PUBLIC_ELIGIBILITY_PREDICATE} ORDER BY 1`).map((r) => r.id);
    assert.deepEqual(publicNow, ['p-free', 'p-plain', 'p-rail']);

    // Collections: the dangling and the repeated member left out; the smart one holds its tag only.
    assert.deepEqual(all(db, "SELECT product_id FROM collection_products WHERE collection_id = 'c-manual' ORDER BY position").map((r) => r.product_id), ['p-rail', 'p-plain']);
    const manual = one(db, "SELECT handle, image_object_id, description, featured, sort_order, type, rule_tag FROM collections WHERE collection_id = 'c-manual'");
    assert.deepEqual({ ...manual }, { description: null, featured: 1, handle: 'favoriter', image_object_id: objectOf(manifest, img('cover.jpg')).objectId, rule_tag: null, sort_order: 2, type: 'manual' });
    assert.deepEqual({ ...one(db, "SELECT type, rule_tag FROM collections WHERE collection_id = 'c-smart'") }, { rule_tag: 'Nyhet', type: 'smart' });
    assert.equal(one(db, "SELECT COUNT(*) AS n FROM collection_products WHERE collection_id = 'c-smart'").n, 0);

    // Pages: the copied image by its public address, the missing one removed; the page with a script refused.
    const page = one(db, "SELECT * FROM pages WHERE page_id = 'pg-about'");
    const html = JSON.parse(page.content_json)['sv-SE'];
    const pageObject = manifest.entries.find((e) => e.sourceKey === sourceKey(img('page.jpg').replaceAll('&', '&amp;')));
    const base = rules.publicObjectBase({ PUBLIC_OBJECT_BASE_URL: readPinned('staging').r2.publicBaseUrl });
    assert.ok(html.includes(`src="${rules.publicObjectUrl(base, objectKeyOf(pageObject))}"`));
    assert.equal(html.includes('gone.jpg'), false);
    assert.equal(rules.checkHtml(html).ok, true);
    assert.equal(page.status, 'published');
    assert.equal(page.published_at, '2026-01-10T00:00:00.000Z');
    assert.equal(page.meta_title_json, null);
    assert.deepEqual(JSON.parse(page.meta_description_json), { 'sv-SE': 'About us' });
    assert.equal(page.created_by, one(db, "SELECT new_id FROM legacy_id_map WHERE legacy_id = 'tenantadmin1'").new_id);
    assert.equal(page.updated_by, null);
    assert.equal(one(db, "SELECT COUNT(*) AS n FROM pages WHERE page_id = 'pg-bad'").n, 0);
    assert.equal(result.planJson.report['test-shop-a']['pages_left_out:content_refused:script'], 1);
    assert.equal(result.planJson.report['test-shop-a'].page_attachments_not_carried, 1);

    // Branding: object ids of the shop's own branding objects in the identity CP3 wrote.
    const identity = JSON.parse(one(db, "SELECT store_identity_json AS j FROM tenant_settings WHERE tenant_id = 'test-shop-a'").j);
    assert.equal(identity.logoObjectId, objectOf(manifest, img('logo.png')).objectId);
    assert.equal(identity.heroObjectId, objectOf(manifest, img('hero.png')).objectId);
    assert.equal(identity.gallery[0].imageObjectId, objectOf(manifest, img('tile.png')).objectId);
    assert.equal(identity.gallery[0].label, 'Tile');
    assert.equal(one(db, 'SELECT kind FROM stored_objects WHERE object_id = ?', identity.logoObjectId).kind, 'shop_branding');
    assert.deepEqual(rules.parseStoreSettingsInput({ storeIdentity: identity }).status, 'ok');
    // CP3 removed only the two hosts it knew; what else names the source's storage goes now.
    assert.equal(rules.isSourceStorageAddress(JSON.stringify(identity)), false);
    assert.ok(result.planJson.report['test-shop-a'].identity_source_addresses_removed >= 1, JSON.stringify(result.planJson.report['test-shop-a']));

    assert.ok(one(db, "SELECT catalog_version AS v FROM tenants WHERE tenant_id = 'test-shop-a'").v > versionBefore);

    const checks = runChecks({ actualState: readActual(db, s.base), bundleVerified: verifyBundle(s.bundleDir).ok, planJson: JSON.parse(JSON.stringify(result.planJson)), rules });
    const failed = checks.filter((c) => !c.ok);
    assert.deepEqual(failed, []);
    assert.ok(checks.some((c) => c.name.startsWith('public total')));
  } finally {
    rmDir(s.base);
  }
});

test('an image that was refused, missing or failed is left out and counted; the row is imported without it', { skip }, async () => {
  const statuses = { [img('plain-2.jpg')]: 'refused', [img('black-2.jpg')]: 'missing', [img('white.jpg')]: 'failed', [img('hero.png')]: 'missing' };
  const s = await setup({ statusOf: (source) => statuses[source.address] ?? 'copied' });
  try {
    const result = await run(s);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const report = result.planJson.report['test-shop-a'];
    assert.equal(report['images_left_out:refused'], 1);
    assert.equal(report['images_left_out:missing'], 1);
    assert.equal(report['images_left_out:failed'], 1);
    assert.equal(report['branding_left_out:missing'], 1);
    s.db.exec(result.planText);
    assert.equal(one(s.db, "SELECT COUNT(*) AS n FROM product_images WHERE product_id = 'p-rail'").n, 2);
    assert.equal(one(s.db, "SELECT COUNT(*) AS n FROM products WHERE product_id IN ('p-plain', 'p-rail')").n, 2);
    const identity = JSON.parse(one(s.db, "SELECT store_identity_json AS j FROM tenant_settings WHERE tenant_id = 'test-shop-a'").j);
    assert.equal(identity.heroObjectId, undefined);
    assert.equal(typeof identity.logoObjectId, 'string');
  } finally {
    rmDir(s.base);
  }
});

test('the same file as a product image and as the shop\'s logo: two objects, each named where its kind is asked for', { skip }, async () => {
  const shared = img('plain-1.jpg');
  const s = await setup({
    patch(schema) {
      schema.shops['test-shop-a'].data.storeIdentity.logoUrl = shared;
    },
  });
  try {
    const entries = s.manifest.entries.filter((e) => e.shopId === 'test-shop-a' && e.sourceKey === sourceKey(shared));
    assert.deepEqual(entries.map((e) => e.use), ['product_image', 'branding']);
    const [media, branding] = entries.map((e) => e.objectId);
    assert.notEqual(media, branding);
    const result = await run(s);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.planJson.report['test-shop-a']['branding_left_out:wrong_kind'], undefined);
    s.db.exec(result.planText);
    assert.equal(JSON.parse(one(s.db, "SELECT store_identity_json AS j FROM tenant_settings WHERE tenant_id = 'test-shop-a'").j).logoObjectId, branding);
    assert.equal(one(s.db, "SELECT COUNT(*) AS n FROM product_images WHERE product_id = 'p-plain' AND object_id = ?", media).n, 1);
    assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM product_images WHERE object_id = ?', branding).n, 0);
    const checks = runChecks({ actualState: readActual(s.db, s.base), bundleVerified: true, planJson: result.planJson, rules });
    assert.deepEqual(checks.filter((c) => !c.ok && !c.name.startsWith('public')).map((c) => c.name), []);
  } finally {
    rmDir(s.base);
  }
});

test('an object that exists only under another kind is not named where the reader asks for a different kind', { skip }, async () => {
  // The logo's file is in the manifest as a product image only (a manifest of
  // before the logo named it): the identity asks for shop_branding.
  const shared = img('plain-1.jpg');
  const s = await setup({
    manifestPatch(manifest) {
      manifest.entries = manifest.entries.filter((e) => !(e.sourceKey === sourceKey(shared) && e.use === 'branding'));
    },
    patch(schema) {
      schema.shops['test-shop-a'].data.storeIdentity.logoUrl = shared;
    },
  });
  try {
    const result = await run(s);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.planJson.report['test-shop-a']['branding_left_out:wrong_kind'], 1);
  } finally {
    rmDir(s.base);
  }
});

test('the 30-image cap keeps the main image and each colour\'s first photo, in their natural order', { skip }, async () => {
  const s = await setup({
    patch(schema) {
      schema.products['p-rail'].data.b2cImageGallery = Array.from({ length: 30 }, (_, i) => img(`extra-${i}.jpg`));
    },
  });
  try {
    const result = await run(s);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    s.db.exec(result.planText);
    const rows = all(s.db, "SELECT position, variant_id, object_id FROM product_images WHERE product_id = 'p-rail' ORDER BY position");
    assert.equal(rows.length, 30);
    assert.equal(rows[0].object_id, objectOf(s.manifest, img('rail-main.jpg')).objectId);
    const groupRows = rows.filter((r) => r.variant_id !== null).map((r) => r.object_id);
    assert.deepEqual(groupRows, [objectOf(s.manifest, img('black.jpg')).objectId, objectOf(s.manifest, img('white.jpg')).objectId]);
    assert.equal(result.planJson.report['test-shop-a']['images_left_out:over_cap'], 34 - 30);
  } finally {
    rmDir(s.base);
  }
});

test('a product whose price is not a whole number of öre is left out, never rounded', { skip }, async () => {
  const s = await setup({
    patch(schema) {
      schema.products['p-plain'].data.b2cPrice = 99.999;
      schema.collections['c-manual'].data.productIds = ['p-plain', 'p-rail'];
    },
  });
  try {
    const result = await run(s);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.planJson.report['test-shop-a']['products_left_out:price_not_exact'], 1);
    assert.equal(result.planJson.report['test-shop-a']['collection_members_left_out:product_not_imported'], 1);
    assert.equal(result.planText.includes("'p-plain'"), false);
  } finally {
    rmDir(s.base);
  }
});

test('a store identity an admin changed after the target state was read is not overwritten', { skip }, async () => {
  const s = await setup();
  try {
    const result = await run(s);
    s.db.exec("UPDATE tenant_settings SET updated_at = '2026-09-28T12:00:00.000Z', updated_by = 'someone' WHERE tenant_id = 'test-shop-a';");
    const before = one(s.db, "SELECT store_identity_json AS j FROM tenant_settings WHERE tenant_id = 'test-shop-a'").j;
    s.db.exec(result.planText);
    assert.equal(one(s.db, "SELECT store_identity_json AS j FROM tenant_settings WHERE tenant_id = 'test-shop-a'").j, before);
    const failed = runChecks({ actualState: readActual(s.db, s.base), bundleVerified: true, planJson: result.planJson, rules }).filter((c) => !c.ok).map((c) => c.name);
    assert.deepEqual(failed.filter((n) => n.startsWith('branding')), ['branding test-shop-a: the identity names the plan\'s images, each the shop\'s own active branding object']);
  } finally {
    rmDir(s.base);
  }
});

// ── the verifier ────────────────────────────────────────────────────────────

test('verify fails when a row is missing, an object was removed, or an identity image is not the plan\'s', { skip }, async () => {
  const s = await setup();
  try {
    const result = await run(s);
    s.db.exec(result.planText);
    s.db.exec("DELETE FROM product_tags WHERE product_id = 'p-plain';");
    const logo = JSON.parse(one(s.db, "SELECT store_identity_json AS j FROM tenant_settings WHERE tenant_id = 'test-shop-a'").j).logoObjectId;
    s.db.exec(`UPDATE stored_objects SET status = 'deleted' WHERE object_id = '${objectOf(s.manifest, img('plain-1.jpg')).objectId}';`);
    s.db.exec(`UPDATE stored_objects SET status = 'deleted' WHERE object_id = '${logo}';`);
    const checks = runChecks({ actualState: readActual(s.db, s.base), bundleVerified: true, planJson: result.planJson, rules });
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    assert.ok(failed.some((n) => n.startsWith('counts test-shop-a')));
    assert.ok(failed.some((n) => n.startsWith('objects test-shop-a')));
    assert.ok(failed.some((n) => n.startsWith('branding test-shop-a')));
    // A removed image does not change who is public: the public checks still pass.
    assert.equal(failed.some((n) => n.startsWith('public test-shop-a')), false);
  } finally {
    rmDir(s.base);
  }
});

/** The plan applied, and the verifier over what the target then holds. */
async function applied(options) {
  const s = await setup(options);
  const result = await run(s);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  s.db.exec(result.planText);
  const verify = () => runChecks({ actualState: readActual(s.db, s.base), bundleVerified: true, planJson: result.planJson, rules });
  const failed = () => verify().filter((c) => !c.ok).map((c) => c.name);
  return { failed, result, s, verify };
}

test('verify: a product the screening blocked is not expected in the projection; one still pending is', { skip }, async () => {
  const { failed, s, verify } = await applied();
  try {
    assert.deepEqual(failed(), []);
    s.db.exec("UPDATE product_screening SET status = 'blocked' WHERE product_id = 'p-plain';");
    const checks = verify();
    assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.name), []);
    assert.ok(checks.some((c) => c.name.startsWith('public test-shop-a') && c.note.includes('1 blocked by the screening')));
    assert.match(checks.find((c) => c.name.startsWith('public total')).expected, /blocked by the screening 1/);
    // Blocked AND still shown would be the Worker's predicate failing: not excused.
    s.db.exec("UPDATE product_screening SET status = 'pending' WHERE product_id = 'p-plain';");
    assert.ok(failed().some((n) => n.startsWith('public test-shop-a')), 'a pending product is the re-screen not run to its end');
  } finally {
    rmDir(s.base);
  }
});

test('verify: a product the shop published before the import is not the plan\'s to answer for', { skip }, async () => {
  const { failed, result, s } = await applied();
  try {
    assert.deepEqual(failed(), []);
    // The same shop with one more published product of its own, and the counts the plan saw before raised by it.
    s.db.exec(`INSERT INTO products (${all(s.db, "SELECT name FROM pragma_table_info('products')").map((r) => r.name).join(', ')})
      SELECT ${all(s.db, "SELECT name FROM pragma_table_info('products')").map((r) => (r.name === 'product_id' ? "'p-before'" : r.name === 'sku' ? "'BEFORE-1'" : r.name === 'handle' ? "'before_BEFORE-1'" : r.name)).join(', ')} FROM products WHERE product_id = 'p-plain';`);
    s.db.exec(`INSERT INTO product_publications (${all(s.db, "SELECT name FROM pragma_table_info('product_publications')").map((r) => r.name).join(', ')})
      SELECT ${all(s.db, "SELECT name FROM pragma_table_info('product_publications')").map((r) => (r.name === 'product_id' ? "'p-before'" : r.name)).join(', ')} FROM product_publications WHERE product_id = 'p-plain';`);
    const planJson = JSON.parse(JSON.stringify(result.planJson));
    const before = (planJson.expected.shops['test-shop-a'].countsBefore ??= {});
    before.products = (before.products ?? 0) + 1;
    before.publications = (before.publications ?? 0) + 1;
    const actualState = readActual(s.db, s.base);
    assert.ok(actualState.publicIfLive['test-shop-a'].includes('p-before'), 'the earlier product is public');
    assert.deepEqual(runChecks({ actualState, bundleVerified: true, planJson, rules }).filter((c) => !c.ok).map((c) => c.name), []);
  } finally {
    rmDir(s.base);
  }
});

test('verify: a menu the plan wrote is compared; a branding update its guard skipped fails on the menu alone', { skip }, async () => {
  // The source names a menu and no image, and the target's identity holds no
  // menu: the menu is all the branding update writes.
  const menuOnly = {
    dbPatch(db) {
      db.exec("UPDATE tenant_settings SET store_identity_json = json_remove(store_identity_json, '$.menu') WHERE tenant_id = 'test-shop-a';");
    },
    patch(schema) {
      const identity = schema.shops['test-shop-a'].data.storeIdentity;
      for (const key of ['logoUrl', 'heroImageUrl', 'faviconUrl', 'emailLogoUrl', 'gallery']) delete identity[key];
    },
  };
  const { failed, result, s } = await applied(menuOnly);
  try {
    const want = result.planJson.expected.branding['test-shop-a'];
    assert.equal(want.menuWritten, true);
    assert.deepEqual(want.menu.map((item) => item.label), ['Alla produkter']);
    assert.deepEqual(want.images, {});
    assert.deepEqual(failed(), []);
  } finally {
    rmDir(s.base);
  }
  // The same plan against a target an admin wrote to after the target state was read: the UPDATE changes nothing.
  const t = await setup(menuOnly);
  try {
    const result = await run(t);
    t.db.exec("UPDATE tenant_settings SET updated_at = '2026-09-28T12:00:00.000Z', updated_by = 'someone' WHERE tenant_id = 'test-shop-a';");
    t.db.exec(result.planText);
    const failedNames = runChecks({ actualState: readActual(t.db, t.base), bundleVerified: true, planJson: result.planJson, rules }).filter((c) => !c.ok).map((c) => c.name);
    assert.deepEqual(failedNames, ['branding test-shop-a: the identity holds the menu the plan wrote']);
    // A plan of before the menu was recorded cannot be verified on it.
    const old = JSON.parse(JSON.stringify(result.planJson));
    delete old.expected.branding['test-shop-a'].menu;
    const rebuilt = runChecks({ actualState: readActual(t.db, t.base), bundleVerified: true, planJson: old, rules }).find((c) => c.name.includes('holds the menu'));
    assert.equal(rebuilt.ok, false);
    assert.match(rebuilt.note, /rebuild the plan/);
  } finally {
    rmDir(t.base);
  }
});

test('verify: a missing expected block fails, and the shop gate is lifted only where the Worker\'s FROM names it once', () => {
  const checks = runChecks({ actualState: {}, bundleVerified: true, planJson: {}, rules });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.match(liftedShopGate(rules.ELIGIBLE_PRODUCTS_FROM), /\(SELECT tenant_id, 'active' AS status, 1 AS published FROM tenants\) AS tenant/);
  assert.throws(() => liftedShopGate('FROM products AS product'), /eligibility\.ts changed its FROM/);
});

// D1 refuses a compound SELECT of more than five terms; a local SQLite takes
// five hundred, so no rehearsal finds it.
test('no state query is a compound SELECT of more terms than D1 takes', async () => {
  const { targetQueries: target, D1_COMPOUND_TERMS: most } = await import('../import-catalogue.mjs');
  const { actualQueries: actual } = await import('../verify-catalogue.mjs');
  for (const query of [...target('staging'), ...actual(rules)]) {
    const terms = query.sql.split(/\bUNION(?:\s+ALL)?\b/).length;
    assert.ok(terms <= most, `${query.file}: ${terms} terms`);
  }
});
