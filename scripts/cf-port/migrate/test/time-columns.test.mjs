import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIME_COLUMN_TYPES, TABLES_THIS_IMPORTER_WRITES, VERBATIM_TIME_COLUMNS, INTEGER_MS, TEXT_ISO, timeColumnType, formatTime, formatTimeOrNull } from '../lib/time-columns.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'cloudflare', 'migrations');

/** Very small SQL parser, good enough for this schema's style: finds every
 * `CREATE TABLE <name> (` block and every `ALTER TABLE <name> ADD COLUMN
 * <col> <TYPE>` statement, and for CREATE TABLE blocks, every column
 * declaration line's name + declared type (INTEGER or TEXT), filtering to
 * names that look like a time column (created_at, updated_at, verified_at,
 * synced_at, imported_at, accepted_at, started_at, finished_at, archived_at,
 * handled_at, or the Better Auth camelCase createdAt/updatedAt/expiresAt). */
function findDeclaredTimeColumns() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const declared = {}; // table -> { column: 'INTEGER'|'TEXT' }
  const timeNamePattern = /^(created_at|updated_at|verified_at|synced_at|imported_at|accepted_at|accepted_at_original|started_at|finished_at|archived_at|handled_at|createdAt|updatedAt|expiresAt|stripe_account_synced_at)$/;

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    // CREATE TABLE blocks: capture table name + the parenthesised body,
    // handling nested parens by counting depth.
    const createRe = /CREATE TABLE\s+"?([a-zA-Z_]+)"?\s*\(/g;
    let match;
    while ((match = createRe.exec(sql)) !== null) {
      const tableName = match[1];
      let depth = 1;
      let i = match.index + match[0].length;
      const start = i;
      while (depth > 0 && i < sql.length) {
        if (sql[i] === '(') depth += 1;
        else if (sql[i] === ')') depth -= 1;
        i += 1;
      }
      const body = sql.slice(start, i - 1);
      // Column lines: split on commas that are NOT inside parens (CHECK(...) etc).
      const lines = splitTopLevel(body);
      for (const line of lines) {
        const colMatch = line.trim().match(/^"?([a-zA-Z_]+)"?\s+(INTEGER|TEXT|DATE)\b/);
        if (colMatch && timeNamePattern.test(colMatch[1])) {
          declared[tableName] = declared[tableName] ?? {};
          declared[tableName][colMatch[1]] = colMatch[2] === 'DATE' ? 'TEXT' : colMatch[2]; // DATE -> TEXT (Better Auth's D1 adapter)
        }
      }
    }

    // ALTER TABLE ... ADD COLUMN ... lines.
    const alterRe = /ALTER TABLE\s+"?([a-zA-Z_]+)"?\s+ADD COLUMN\s+"?([a-zA-Z_]+)"?\s+(INTEGER|TEXT|DATE)\b/g;
    let alterMatch;
    while ((alterMatch = alterRe.exec(sql)) !== null) {
      const [, tableName, colName, type] = alterMatch;
      if (timeNamePattern.test(colName)) {
        declared[tableName] = declared[tableName] ?? {};
        declared[tableName][colName] = type === 'DATE' ? 'TEXT' : type;
      }
    }
  }
  return declared;
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

test('every time column of every table this importer writes is mapped in TIME_COLUMN_TYPES or explicitly listed as verbatim', () => {
  const declared = findDeclaredTimeColumns();
  const verbatimSet = new Set(VERBATIM_TIME_COLUMNS.map((v) => `${v.table}.${v.column}`));
  const missing = [];
  for (const table of TABLES_THIS_IMPORTER_WRITES) {
    const declaredCols = declared[table] ?? {};
    const mappedCols = TIME_COLUMN_TYPES[table] ?? {};
    for (const col of Object.keys(declaredCols)) {
      if (!Object.hasOwn(mappedCols, col) && !verbatimSet.has(`${table}.${col}`)) {
        missing.push(`${table}.${col}`);
      }
    }
  }
  assert.deepEqual(missing, [], `time columns declared in a migration but missing from TIME_COLUMN_TYPES (and not listed as VERBATIM_TIME_COLUMNS): ${missing.join(', ')}`);
});

test('TIME_COLUMN_TYPES never disagrees with the migration-declared SQLite storage class', () => {
  const declared = findDeclaredTimeColumns();
  const disagreements = [];
  for (const [table, columns] of Object.entries(TIME_COLUMN_TYPES)) {
    const declaredCols = declared[table] ?? {};
    for (const [col, mappedType] of Object.entries(columns)) {
      const declaredType = declaredCols[col];
      if (declaredType === undefined) continue; // e.g. accepted_at_original: not itself a formatTime() target
      const expectedSqlType = mappedType === INTEGER_MS ? 'INTEGER' : 'TEXT';
      // Better Auth's "user"/"account" DATE columns are confirmed TEXT on the
      // live D1 adapter (round 1 fix 1) even though 0002 declares them DATE;
      // findDeclaredTimeColumns() already folds DATE -> TEXT above, so a
      // straight comparison is correct here too.
      if (declaredType !== expectedSqlType) {
        disagreements.push(`${table}.${col}: mapped as ${mappedType} (expects SQL type ${expectedSqlType}) but the migration declares ${declaredType}`);
      }
    }
  }
  assert.deepEqual(disagreements, [], disagreements.join('\n'));
});

test('formatTime: INTEGER_MS columns produce a plain millisecond number', () => {
  assert.equal(formatTime('tenants', 'created_at', 1735689600000), 1735689600000);
});

test('formatTime: TEXT_ISO columns produce the exact toISOString() shape', () => {
  assert.equal(formatTime('tenant_settings', 'updated_at', 1735689600000), '2025-01-01T00:00:00.000Z');
});

test('formatTime: refuses a non-finite millis value', () => {
  assert.throws(() => formatTime('tenants', 'created_at', NaN));
  assert.throws(() => formatTime('tenants', 'created_at', 'not-a-number'));
});

test('formatTime: throws loudly for an unmapped (table, column) pair', () => {
  assert.throws(() => formatTime('tenants', 'nonexistent_column', 123), /no entry for/);
});

test('formatTimeOrNull: passes null/undefined through untouched', () => {
  assert.equal(formatTimeOrNull('tenant_domains', 'verified_at', null), null);
  assert.equal(formatTimeOrNull('tenant_domains', 'verified_at', undefined), null);
});

test('formatTimeOrNull: formats a real value the same as formatTime', () => {
  assert.equal(formatTimeOrNull('tenant_domains', 'verified_at', 1735689600000), formatTime('tenant_domains', 'verified_at', 1735689600000));
});

test('timeColumnType: known pairs resolve, unknown pairs throw', () => {
  assert.equal(timeColumnType('tenants', 'created_at'), INTEGER_MS);
  assert.equal(timeColumnType('printers', 'created_at'), TEXT_ISO);
  assert.throws(() => timeColumnType('nonexistent_table', 'x'));
});
