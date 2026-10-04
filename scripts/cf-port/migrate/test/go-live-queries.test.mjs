/**
 * CP7-T2: state-from-queries.mjs — production's commands carry `--bootstrap`,
 * the go-live queries verify.mjs needs are printed for production, run as
 * written on a database with every migration (node:sqlite), and read back into
 * a `goLive` section of counts and booleans only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTUAL_QUERIES, buildActualState, goLiveQueries, GO_LIVE_QUERIES, preflightCommand, printQueries, TARGET_QUERIES } from '../state-from-queries.mjs';
import { buildApplyMd } from '../import.mjs';
import { SOURCE_STORAGE_MARKERS } from '../lib/copy-sources.mjs';
import { storageTextQueries, textColumnsByTable } from '../lib/schema-text-columns.mjs';
import { scanForbiddenStatements } from '../lib/sql.mjs';
import { rmDir, tmpDir } from './fixtures.mjs';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../cloudflare/migrations');
const { DatabaseSync } = await import('node:sqlite');

function printed(kind, env) {
  const lines = [];
  const original = console.log;
  console.log = (line = '') => lines.push(String(line));
  try {
    printQueries(kind, env);
  } finally {
    console.log = original;
  }
  return lines;
}

function migrated() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  return db;
}

/** One row with the given columns; every other NOT NULL column without a default gets a placeholder. */
function insertRow(db, table, fixed) {
  const columns = db.prepare(`SELECT name, type, "notnull" AS required, dflt_value AS fallback FROM pragma_table_info('${table}')`).all();
  const row = {};
  for (const c of columns) {
    if (Object.hasOwn(fixed, c.name)) row[c.name] = fixed[c.name];
    else if (c.required === 1 && c.fallback === null) row[c.name] = /INT/i.test(c.type) ? 0 : 'x';
  }
  const names = Object.keys(row);
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
  db.prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => row[n]));
  db.exec('PRAGMA ignore_check_constraints = OFF;');
}

function writeResults(db, queries, dir) {
  mkdirSync(dir, { recursive: true });
  for (const q of queries) {
    const results = db.prepare(q.sql).all().map((r) => ({ ...r }));
    writeFileSync(path.join(dir, `${q.file}.json`), JSON.stringify([{ meta: {}, results, success: true }]));
  }
}

function withExitStub(fn) {
  let message = null;
  const originalExit = process.exit;
  const originalError = console.error;
  process.exit = () => {
    throw new Error('exit');
  };
  console.error = (msg) => {
    message = msg;
  };
  try {
    fn();
  } catch {
    // refused
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  return message;
}

test('blocker 11: every production command runs through `--bootstrap`; staging\'s commands are unchanged', () => {
  assert.equal(preflightCommand('production'), 'scripts/cf-preflight.sh production --bootstrap --');
  assert.equal(preflightCommand('staging'), 'scripts/cf-preflight.sh staging --');
  for (const kind of ['target', 'actual']) {
    const production = printed(kind, 'production').filter((l) => l.startsWith('scripts/cf-preflight.sh'));
    assert.ok(production.length > 0);
    assert.ok(production.every((l) => l.startsWith('scripts/cf-preflight.sh production --bootstrap -- d1 execute chopshop-prod --remote --json --command="SELECT ')), kind);
    const staging = printed(kind, 'staging').filter((l) => l.startsWith('scripts/cf-preflight.sh'));
    assert.ok(staging.every((l) => l.startsWith('scripts/cf-preflight.sh staging -- d1 execute ') && !l.includes('--bootstrap')), kind);
  }
  assert.match(buildApplyMd({ env: 'production', planSha: 'a'.repeat(64) }), /scripts\/cf-preflight\.sh production --bootstrap -- d1 execute chopshop-prod --remote --file=plan\.sql/);
  assert.match(buildApplyMd({ env: 'production', planSha: 'a'.repeat(64) }), /scripts\/cf-preflight\.sh production --bootstrap -- d1 time-travel info chopshop-prod/);
  assert.ok(!buildApplyMd({ env: 'staging', planSha: 'a'.repeat(64) }).includes('--bootstrap'));
});

test('the go-live queries are printed for --print-queries actual --env production only', () => {
  const files = (lines) => lines.filter((l) => l.startsWith('# -> ')).map((l) => l.slice(5, -5));
  const production = files(printed('actual', 'production'));
  assert.deepEqual(production, [...ACTUAL_QUERIES, ...goLiveQueries()].map((q) => q.file));
  assert.ok(production.includes('go_live_counts') && production.includes('go_live_legal') && production.includes('storage_texts_1'));
  assert.deepEqual(files(printed('actual', 'staging')), ACTUAL_QUERIES.map((q) => q.file));
  assert.deepEqual(files(printed('target', 'production')), TARGET_QUERIES.map((q) => q.file));
});

test('every go-live query is one read-only SELECT with no compound term (D1 refuses more than five)', () => {
  for (const q of goLiveQueries()) {
    assert.match(q.sql, /^SELECT /, q.file);
    assert.equal(q.sql.split(';').filter((part) => part.trim() !== '').length, 1, `${q.file}: one statement`);
    assert.deepEqual(scanForbiddenStatements(q.sql), [], q.file);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|PRAGMA|ATTACH|UNION|INTERSECT|EXCEPT)\b/i.test(q.sql), q.file);
    assert.ok(q.sql.length < 90_000, `${q.file}: under D1's statement length`);
  }
});

test('the text scan covers every table of the migrations that has a text column, each once', () => {
  const columns = textColumnsByTable();
  const scanned = storageTextQueries(columns).flatMap((q) => q.tables);
  assert.deepEqual([...scanned].sort(), Object.keys(columns).sort());
  assert.equal(new Set(scanned).size, scanned.length);
  for (const table of ['products', 'pages', 'tenant_settings', 'legal_acceptances', 'audit_events', 'stored_objects']) assert.ok(columns[table]?.length > 0, table);
  assert.ok(!columns.products.includes('price_minor') && columns.products.includes('description'), 'integers are not scanned; text is');
});

test('the go-live queries run as written on the migrated schema and read back into counts and booleans; no address is kept', () => {
  const db = migrated();
  const marker = SOURCE_STORAGE_MARKERS[0];
  insertRow(db, 'tenants', { tenant_id: 'melodie-mc' });
  insertRow(db, 'tenants', { tenant_id: 'shop-b' });
  insertRow(db, 'tenant_settings', { return_address: 'Testgatan 1, 123 45 Teststad', tenant_id: 'melodie-mc', vat_registered: 0 });
  insertRow(db, 'tenant_settings', { return_address: ' \n\t ', tenant_id: 'shop-b', vat_registered: null });
  insertRow(db, 'legal_acceptances', { acceptance_id: 'acc-1', tenant_id: 'melodie-mc', type: 'legalPages' });
  const version = db.prepare('SELECT version FROM platform_terms_versions ORDER BY published_at DESC LIMIT 1').get().version;
  insertRow(db, 'platform_terms_acceptances', { id: 'pta-1', tenant_id: 'melodie-mc', terms_version: version });
  insertRow(db, 'products', { description: `<img src="https://${marker}/x.png">`, product_id: 'p-1', tenant_id: 'melodie-mc' });
  insertRow(db, 'checkouts', { checkout_id: 'co-1', tenant_id: 'melodie-mc' });
  insertRow(db, 'orders', { checkout_id: 'co-1', order_id: 'o-1', tenant_id: 'melodie-mc' });
  insertRow(db, 'stored_objects', { object_id: 'obj-1', object_key: 'k/1', sha256: 'a'.repeat(64), status: 'active', tenant_id: 'melodie-mc' });
  insertRow(db, 'stored_objects', { object_id: 'obj-2', object_key: 'k/2', sha256: null, status: 'active', tenant_id: 'melodie-mc' });
  // The schema's triggers already refuse a mapping or artwork of another shop;
  // the query counts them anyway (defence in depth), so this scratch database
  // drops those triggers to hold one of each.
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN ('pod_artwork', 'pod_mappings')").all()) db.exec(`DROP TRIGGER "${name}"`);
  insertRow(db, 'pod_artwork', { artwork_id: 'art-1', original_object_id: 'obj-1', profile_id: 'no-such-profile', status: 'processing', tenant_id: 'melodie-mc' });
  insertRow(db, 'pod_mappings', { artwork_id: 'art-1', id: 'map-1', tenant_id: 'melodie-mc' });
  insertRow(db, 'pod_mappings', { artwork_id: 'art-elsewhere', id: 'map-2', tenant_id: 'melodie-mc' });

  const base = tmpDir();
  try {
    writeResults(db, [...ACTUAL_QUERIES, ...goLiveQueries()], base);
    const state = buildActualState(base);
    assert.deepEqual(state.goLive.counts, {
      checkouts: 1,
      orders: 1,
      outbox_events: 0,
      payment_events: 0,
      pod_artwork: 1,
      pod_artwork_profile_unresolved: 1,
      pod_mapped_artwork_not_ready: 1,
      pod_mappings: 2,
      pod_mappings_unresolved: 1,
      stored_objects: 2,
      stored_objects_not_active_with_sha256: 1,
    });
    assert.deepEqual(state.goLive.legal, {
      'melodie-mc': { currentTermsAccepted: true, legalPagesAccepted: true, returnAddress: true, vatAnswered: true },
      'shop-b': { currentTermsAccepted: false, legalPagesAccepted: false, returnAddress: false, vatAnswered: false },
    });
    assert.deepEqual(state.goLive.storageTexts.hits, { products: 1 });
    assert.deepEqual(state.goLive.storageTexts.scanned, Object.keys(textColumnsByTable()).sort());
    assert.ok(!JSON.stringify(state).includes('Testgatan'), 'the return address is read as set / not set, never kept');
    assert.equal(GO_LIVE_QUERIES.length, 2);
  } finally {
    rmDir(base);
    db.close();
  }
});

test('some but not all go-live files refuses; a malformed counts row refuses; none at all is no section (staging)', () => {
  const db = migrated();
  const base = tmpDir();
  try {
    writeResults(db, ACTUAL_QUERIES, base);
    assert.equal(buildActualState(base).goLive, undefined, 'no go-live file: no section');
    writeResults(db, [GO_LIVE_QUERIES[0]], base);
    assert.match(String(withExitStub(() => buildActualState(base))), /the go-live query files are incomplete: missing go_live_legal, storage_texts_1/);
    writeResults(db, goLiveQueries(), base);
    writeFileSync(path.join(base, 'go_live_counts.json'), JSON.stringify([{ results: [{ orders: '0' }] }]));
    assert.match(String(withExitStub(() => buildActualState(base))), /go_live_counts\.json does not hold one row of counts/);
  } finally {
    rmDir(base);
    db.close();
  }
});
