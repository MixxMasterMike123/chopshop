/**
 * scripts/cf-port/migrate/lib/plan.mjs — assembles the deterministic plan.sql
 * text from a list of per-table statement groups, wraps it in the
 * `import_runs` bracket (C5), and writes one `import_row_hashes` row per
 * carried row so a re-run of the same bundle is a no-op and a re-run with
 * changed content for the same id aborts (via 0033's triggers).
 *
 * DETERMINISM (C4): the same bundle + the same options must produce a
 * byte-identical plan.sql. This module never uses `Date.now()`, `Math.random()`
 * or `crypto.randomUUID()` for anything that ends up in the SQL text — every
 * id and timestamp the plan writes is either preserved from the bundle,
 * derived deterministically (lib/ids.mjs), or passed in explicitly by the
 * caller (import.mjs derives the run's `now` from the bundle's own
 * `exportedAt`, never the wall clock — see import.mjs for why).
 */

import { createHash } from 'node:crypto';
import { insertStatement, sqlLiteral } from './sql.mjs';

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Canonical content hash of one row for import_row_hashes: sha256 of the
 * row's own INSERT statement's column/value pairs, in a fixed column order
 * (the same order the importer always builds that row in), so the hash is
 * stable across runs and changes if and only if the row's content changes.
 */
export function rowContentHash(table, columns, row) {
  const canonical = JSON.stringify({ columns, row: columns.map((c) => row[c] ?? null), table });
  return sha256Hex(canonical);
}

/**
 * Builds the row-hash bookkeeping statement for one carried row:
 *   INSERT OR IGNORE INTO import_row_hashes (table_name, row_pk, content_sha, run_id)
 *   VALUES (...);
 * `rowPk` must be the row's own primary key value(s) joined the same way on
 * every call for a given table (a single string for a single-column PK, or a
 * caller-joined composite string, e.g. `${tenantId}:${key}`).
 */
export function rowHashStatement(table, rowPk, contentSha, runId) {
  return insertStatement(
    'import_row_hashes',
    ['table_name', 'row_pk', 'content_sha', 'run_id'],
    { content_sha: contentSha, row_pk: rowPk, run_id: runId, table_name: table },
    { orIgnore: true },
  );
}

/**
 * A "carried row" bundles together everything the plan builder needs to emit
 * both the data statement and its row-hash bookkeeping statement:
 *   table       the target table name (row-hash table_name column)
 *   pk          the row's own primary-key string (row-hash row_pk column)
 *   statement   the fully-built INSERT/UPDATE statement text for the row
 *   contentSha  sha256 of the row's canonical content (rowContentHash)
 */
export function carriedRow(table, pk, statement, contentSha) {
  return { contentSha, pk, statement, table };
}

/**
 * Assembles the full plan.sql text:
 *   1. one `import_runs` INSERT, status 'running'
 *   2. every section's statements, in the caller-given order (import.mjs is
 *      responsible for a stable table order — see its SECTION_ORDER)
 *   3. one import_row_hashes statement per carried row, in the same order
 *   4. one `import_runs` UPDATE, status 'completed', with counts_json
 *
 * `sections` is an ordered array of { name, rows: carriedRow[] }.
 * `run` is { runId, env, bundleSha, planShaPlaceholder: false, startedAt,
 * finishedAt, kind? }. `kind` (0052: 'platform' | 'catalogue') is written into
 * the run's first statement when given; a plan that gives none (import.mjs,
 * restore-archive.mjs) is unchanged and its run is a platform run by the
 * column's default. planSha is computed by the CALLER after this function returns
 * (it hashes the text this function produces) and is not embedded in the text
 * itself — the run's own INSERT/UPDATE bind plan_sha as an argument the
 * caller supplies once known (see import.mjs's two-pass build).
 */
export function buildPlanSql(run, sections, planSha) {
  const lines = [];
  lines.push('-- scripts/cf-port/migrate/import.mjs — generated import plan.');
  lines.push(`-- run_id=${run.runId} env=${run.env} bundle_sha=${run.bundleSha} plan_sha=${planSha}`);
  lines.push('-- Every statement below is INSERT, INSERT OR IGNORE, UPDATE or SELECT.');
  lines.push('');
  lines.push('-- ── import_runs: begin ──');
  const withKind = run.kind !== undefined;
  lines.push(
    insertStatement(
      'import_runs',
      ['run_id', 'env', ...(withKind ? ['kind'] : []), 'bundle_sha', 'plan_sha', 'started_at', 'finished_at', 'status', 'counts_json'],
      {
        bundle_sha: run.bundleSha,
        counts_json: null,
        env: run.env,
        finished_at: null,
        ...(withKind ? { kind: run.kind } : {}),
        plan_sha: planSha,
        run_id: run.runId,
        started_at: run.startedAt,
        status: 'running',
      },
      { orIgnore: false },
    ),
  );
  lines.push('');

  const counts = {};
  for (const section of sections) {
    lines.push(`-- ── ${section.name} (${section.rows.length} rows) ──`);
    counts[section.name] = section.rows.length;
    for (const row of section.rows) {
      lines.push(row.statement);
      lines.push(rowHashStatement(row.table, row.pk, row.contentSha, run.runId));
    }
    lines.push('');
  }

  lines.push('-- ── import_runs: complete ──');
  const countsJson = JSON.stringify(counts);
  lines.push(
    `UPDATE import_runs SET status = 'completed', finished_at = ${sqlLiteral(run.finishedAt)}, counts_json = ${sqlLiteral(countsJson)} WHERE run_id = ${sqlLiteral(run.runId)};`,
  );
  lines.push('');

  return { counts, text: lines.join('\n') };
}

export { sha256Hex };
