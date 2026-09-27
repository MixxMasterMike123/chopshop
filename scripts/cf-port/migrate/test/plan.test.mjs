import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowContentHash, rowHashStatement, carriedRow, buildPlanSql, sha256Hex } from '../lib/plan.mjs';
import { insertStatement } from '../lib/sql.mjs';

test('rowContentHash: deterministic and content-sensitive', () => {
  const columns = ['a', 'b'];
  const h1 = rowContentHash('t', columns, { a: 1, b: 'x' });
  const h2 = rowContentHash('t', columns, { a: 1, b: 'x' });
  const h3 = rowContentHash('t', columns, { a: 1, b: 'y' });
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('rowHashStatement: builds an INSERT OR IGNORE into import_row_hashes', () => {
  const stmt = rowHashStatement('tenants', 't1', 'deadbeef', 'run1');
  assert.match(stmt, /^INSERT OR IGNORE INTO import_row_hashes/);
  assert.match(stmt, /'tenants'/);
  assert.match(stmt, /'t1'/);
  assert.match(stmt, /'deadbeef'/);
  assert.match(stmt, /'run1'/);
});

test('carriedRow: bundles table/pk/statement/hash', () => {
  const row = carriedRow('tenants', 't1', 'INSERT ...', 'abc');
  assert.deepEqual(row, { contentSha: 'abc', pk: 't1', statement: 'INSERT ...', table: 'tenants' });
});

test('buildPlanSql: wraps sections in an import_runs bracket and writes a row-hash per row', () => {
  const run = { bundleSha: 'b'.repeat(64), env: 'staging', finishedAt: '2026-01-01T00:00:00.000Z', runId: 'run1', startedAt: '2026-01-01T00:00:00.000Z' };
  const row = carriedRow('tenants', 't1', insertStatement('tenants', ['tenant_id'], { tenant_id: 't1' }), rowContentHash('tenants', ['tenant_id'], { tenant_id: 't1' }));
  const { text, counts } = buildPlanSql(run, [{ name: 'tenants', rows: [row] }], 'p'.repeat(64));

  assert.match(text, /INSERT INTO import_runs .* 'running'/);
  assert.match(text, /INSERT OR IGNORE INTO tenants/);
  assert.match(text, /INSERT OR IGNORE INTO import_row_hashes/);
  assert.match(text, /UPDATE import_runs SET status = 'completed'/);
  assert.deepEqual(counts, { tenants: 1 });
});

test('buildPlanSql: same inputs -> byte-identical text', () => {
  const run = { bundleSha: 'b'.repeat(64), env: 'staging', finishedAt: '2026-01-01T00:00:00.000Z', runId: 'run1', startedAt: '2026-01-01T00:00:00.000Z' };
  const row = carriedRow('tenants', 't1', insertStatement('tenants', ['tenant_id'], { tenant_id: 't1' }), rowContentHash('tenants', ['tenant_id'], { tenant_id: 't1' }));
  const a = buildPlanSql(run, [{ name: 'tenants', rows: [row] }], 'p'.repeat(64));
  const b = buildPlanSql(run, [{ name: 'tenants', rows: [row] }], 'p'.repeat(64));
  assert.equal(a.text, b.text);
});

test('sha256Hex is a standard sha256 hex digest (known vector: sha256("") )', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.match(sha256Hex('x'), /^[0-9a-f]{64}$/);
});
