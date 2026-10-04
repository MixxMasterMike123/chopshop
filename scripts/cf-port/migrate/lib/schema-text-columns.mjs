/**
 * scripts/cf-port/migrate/lib/schema-text-columns.mjs — CP7-T2: every text
 * column of the Worker's schema, and the read-only queries that count, table by
 * table, the rows whose text names the source's storage (manifest (e) 13:
 * "zero occurrences ... in any D1 text column").
 *
 *   textColumnsByTable()   { table: [column, …] } — the columns of TEXT affinity
 *                          and the untyped ones (they can hold text), of every
 *                          table the repository's migrations create
 *   storageTextQueries()   [{ file, sql, tables }] — at most TABLES_PER_QUERY
 *                          tables per query; each query ONE SELECT of scalar
 *                          subqueries, one per table, named after the table
 *                          (no compound SELECT: D1 refuses more than five terms)
 *
 * The schema is read from cloudflare/migrations/*.sql applied, in order, to an
 * IN-MEMORY SQLite database: never from D1, never from the network. The
 * markers are the Worker's own list (lib/copy-sources.mjs, pinned to
 * src/platform/tenant-config.ts by test/copy-sources.test.mjs). LIKE is
 * ASCII-case-insensitive, so a marker in capitals counts too.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCE_STORAGE_MARKERS } from './copy-sources.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'cloudflare', 'migrations');
export const TABLES_PER_QUERY = 25;
export const STORAGE_TEXTS_FILE_PREFIX = 'storage_texts_';

/** SQLite's affinity rule (datatype3 §3.1): TEXT for CHAR/CLOB/TEXT, none for an untyped column. */
function mayHoldText(declaredType) {
  const type = String(declaredType ?? '').toUpperCase();
  if (type.includes('INT')) return false;
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return true;
  return type.trim() === '';
}

const quoted = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * { table: [text column, …] }, tables by name, columns in their order. node:sqlite
 * is loaded here, on first use, so a tool that never scans prints no
 * experimental warning.
 */
export function textColumnsByTable({ migrationsDir = MIGRATIONS_DIR } = {}) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
      db.exec(readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name")
      .all()
      .map((row) => row.name);
    const out = {};
    for (const table of tables) {
      const columns = db
        .prepare('SELECT name, type FROM pragma_table_info(?) ORDER BY cid')
        .all(table)
        .filter((column) => mayHoldText(column.type))
        .map((column) => column.name);
      if (columns.length > 0) out[table] = columns;
    }
    return out;
  } finally {
    db.close();
  }
}

/** One table's subquery: the rows whose text columns, joined, hold a marker. */
function tableSubquery(table, columns, markers) {
  const joined = columns.map((column) => `COALESCE(${quoted(column)}, '')`).join(" || char(10) || ");
  const matches = markers.map((marker) => `t LIKE '%${marker.replace(/'/g, "''")}%'`).join(' OR ');
  return `(SELECT COUNT(*) FROM (SELECT ${joined} AS t FROM ${quoted(table)}) WHERE ${matches}) AS ${quoted(table)}`;
}

/** The queries of manifest (e) 13's text scan, TABLES_PER_QUERY tables each. */
export function storageTextQueries(columnsByTable, { markers = SOURCE_STORAGE_MARKERS } = {}) {
  const tables = Object.keys(columnsByTable).sort();
  const queries = [];
  for (let start = 0; start < tables.length; start += TABLES_PER_QUERY) {
    const chunk = tables.slice(start, start + TABLES_PER_QUERY);
    queries.push({
      file: `${STORAGE_TEXTS_FILE_PREFIX}${queries.length + 1}`,
      sql: `SELECT ${chunk.map((table) => tableSubquery(table, columnsByTable[table], markers)).join(', ')};`,
      tables: chunk,
    });
  }
  return queries;
}
