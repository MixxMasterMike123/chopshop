/**
 * scripts/cf-port/migrate/lib/sql.mjs — the ONE function every generated SQL
 * literal goes through, plus small statement-building helpers.
 *
 * D1/SQLite string literals: wrap in single quotes, double any embedded single
 * quote. No escaping of backslashes (SQLite string literals do not treat `\`
 * specially), so a backslash is written verbatim inside the quotes, which is
 * correct.
 *
 * EVERY GENERATED STATEMENT MUST BE EXACTLY ONE LINE (review round 1, fix 2):
 * the forbidden-statement scan (hard rule 7) reads plan.sql one line at a
 * time, and real shop data routinely contains a line break (a multi-line
 * return address, a legal-text snapshot). A control character below U+0020 —
 * line feed, carriage return, tab, or any other C0 control — is therefore
 * NEVER written literally inside the quotes. Instead the string is split
 * around each such character and re-assembled as a `||` concatenation of
 * ordinary quoted segments and `char(N)` calls, e.g.
 * `'Testgatan 1' || char(10) || '123 45 Staden'`. SQLite evaluates `||` at
 * statement-execution time, so the STORED value is exactly the original
 * string, byte for byte — only the SOURCE TEXT of plan.sql never contains the
 * control character itself.
 *
 * NUL bytes (U+0000) are refused outright rather than encoded: a NUL inside a
 * text pipeline (this tool writes plan.sql as UTF-8 text, not a byte stream to
 * a driver) is unsafe regardless of how it is escaped, because tools between
 * this writer and the eventual D1 import (editors, `cat`, a reviewer's pager)
 * commonly treat NUL as a string terminator. Callers that might legitimately
 * see one (there are none in this importer's inputs) must strip or re-encode
 * it before calling this function.
 */

/** Thrown by sqlLiteral() when given a value it must refuse to encode. */
export class UnsafeSqlValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeSqlValueError';
  }
}

/** Every C0 control character except NUL (refused separately, above) and
 * except none we allow raw: space (U+0020) and everything above it is left
 * alone. Matches U+0001–U+001F and the DEL character U+007F for good
 * measure (not itself a line-breaking character, but not printable either,
 * and `char(127)` is exactly as safe to emit this way). */
const CONTROL_CHAR_PATTERN = /[\u0001-\u001f\u007f]/;
const CONTROL_CHAR_SPLIT = /([\u0001-\u001f\u007f])/;
/** Well under SQLite's expression depth limit of 1000. */
export const MAX_CONCAT_PIECES = 800;
/** D1 refuses a statement longer than 100 000 bytes. */
export const MAX_STATEMENT_BYTES = 100_000;

/**
 * Quotes an ordinary (control-character-free) string segment: wraps in single
 * quotes, doubles embedded single quotes. Never called directly on a value
 * that might still contain a control character — see quoteStringLiteral.
 */
function quotePlainSegment(segment) {
  return `'${segment.replaceAll("'", "''")}'`;
}

/**
 * Turns one string into a single-line SQL expression that evaluates to that
 * exact string: when it contains no control character, an ordinary quoted
 * literal; when it does, a `||` chain alternating quoted segments (possibly
 * empty-string segments, when a control character is first/last or two are
 * adjacent — SQLite's empty string literal `''` is valid on either side of
 * `||`) and `char(N)` calls for each control character, in order.
 */
function quoteStringLiteral(value) {
  if (!CONTROL_CHAR_PATTERN.test(value)) {
    return quotePlainSegment(value);
  }
  const parts = value.split(CONTROL_CHAR_SPLIT).filter((part) => part !== undefined);
  // `a || b || c` parses as a left-deep tree, one level per operator, and
  // SQLite refuses an expression deeper than 1000. Refused here, when the
  // plan is built, rather than halfway through an apply.
  if (parts.length > MAX_CONCAT_PIECES) {
    throw new UnsafeSqlValueError(`sqlLiteral: a string with ${(parts.length - 1) / 2} control characters needs more than ${MAX_CONCAT_PIECES} concatenated pieces`);
  }
  const pieces = parts.map((part) => (CONTROL_CHAR_PATTERN.test(part) && part.length === 1 ? `char(${part.codePointAt(0)})` : quotePlainSegment(part)));
  return pieces.join(' || ');
}

/**
 * The one function that turns a JS value into a SQL literal (or, for a
 * control-character-bearing string, a single-line SQL EXPRESSION that
 * evaluates to that string) for plan.sql.
 *   null | undefined → NULL
 *   boolean          → 0 | 1
 *   number           → decimal literal (must be finite)
 *   string           → single-quoted (single-quotes doubled), or, when it
 *                      contains a control character, the `||`/`char(N)` form
 *                      above; NUL bytes refused
 * Anything else (object, array, function, symbol, NaN, Infinity) throws.
 */
export function sqlLiteral(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UnsafeSqlValueError(`sqlLiteral: refusing non-finite number ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.includes('\u0000')) {
      throw new UnsafeSqlValueError('sqlLiteral: refusing a string containing a NUL byte (U+0000)');
    }
    return quoteStringLiteral(value);
  }
  // The value itself is never printed: it is shop data and can hold an address.
  throw new UnsafeSqlValueError(`sqlLiteral: cannot encode a value of type ${Array.isArray(value) ? 'array' : typeof value}`);
}

/** A SQL identifier (table or column name), double-quoted, double-quotes doubled.
 * Only used for the small set of names this tool ever needs to quote as
 * identifiers (Better Auth's camelCase columns); every other identifier in
 * this tool's generated SQL is a fixed literal string already known safe.
 * Identifier names are always fixed strings this tool controls (never data),
 * so — unlike sqlLiteral — no control-character handling is needed here. */
export function sqlIdent(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new UnsafeSqlValueError('sqlIdent: name must be a non-empty string');
  }
  if (name.includes('\u0000')) {
    throw new UnsafeSqlValueError('sqlIdent: refusing a name containing a NUL byte');
  }
  if (CONTROL_CHAR_PATTERN.test(name)) {
    throw new UnsafeSqlValueError('sqlIdent: refusing a name containing a control character');
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Builds a single deterministic, SINGLE-LINE
 *   INSERT [OR IGNORE] INTO <table> (<cols>) VALUES (<literals-or-expressions>);
 * statement. `columns` is an ordered array of column names (fixed strings the
 * caller controls, never user input); `row` is a plain object with exactly
 * those keys. `orIgnore` defaults to true (idempotent re-run safety, C5) —
 * pass false only for the few statements this importer explicitly wants to
 * fail loudly on conflict (import_runs' leading insert; kept general and
 * tested for completeness).
 */
export function insertStatement(table, columns, row, { orIgnore = true } = {}) {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) {
    throw new UnsafeSqlValueError(`insertStatement: unsafe table name ${JSON.stringify(table)}`);
  }
  for (const col of columns) {
    if (!/^[a-z][a-z0-9_]*$/.test(col)) {
      throw new UnsafeSqlValueError(`insertStatement: unsafe column name ${JSON.stringify(col)}`);
    }
  }
  const values = columns.map((col) => sqlLiteral(row[col]));
  const verb = orIgnore ? 'INSERT OR IGNORE INTO' : 'INSERT INTO';
  return `${verb} ${table} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
}

/**
 * A single-row UPDATE with a WHERE clause built from an equality map (all
 * ANDed, all literal-encoded). Used for the few upsert-style "singleton row"
 * tables (platform_settings, print_defaults) where the plan writes an UPDATE
 * instead of an INSERT (the migration already seeded the row), and for the
 * screening terms-version bump (a raw SQL expression). `set` and `where` are
 * plain objects of column -> value.
 */
export function updateStatement(table, set, where) {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) {
    throw new UnsafeSqlValueError(`updateStatement: unsafe table name ${JSON.stringify(table)}`);
  }
  const setCols = Object.keys(set);
  const whereCols = Object.keys(where);
  if (setCols.length === 0) {
    throw new UnsafeSqlValueError('updateStatement: set must have at least one column');
  }
  if (whereCols.length === 0) {
    throw new UnsafeSqlValueError('updateStatement: where must have at least one column');
  }
  for (const col of [...setCols, ...whereCols]) {
    if (!/^[a-z][a-z0-9_]*$/.test(col)) {
      throw new UnsafeSqlValueError(`updateStatement: unsafe column name ${JSON.stringify(col)}`);
    }
  }
  const setClause = setCols.map((col) => `${col} = ${sqlLiteral(set[col])}`).join(', ');
  const whereClause = whereCols.map((col) => `${col} = ${sqlLiteral(where[col])}`).join(' AND ');
  return `UPDATE ${table} SET ${setClause} WHERE ${whereClause};`;
}

/** The exact three leading keywords this tool's generated SQL may ever use
 * (hard rule 7). Used by the forbidden-statement scan (test + import.mjs
 * itself, defence in depth). */
export const ALLOWED_STATEMENT_VERBS = ['INSERT', 'UPDATE', 'SELECT'];

/**
 * Scans a whole plan.sql text for any statement not starting with one of
 * ALLOWED_STATEMENT_VERBS (case-sensitive: this tool only ever emits
 * upper-case keywords, so a lower-case "insert" appearing would itself be
 * suspicious and is deliberately NOT matched — it would fail this scan and
 * surface as a violation, which is the intended fail-closed behaviour), and,
 * per review round 1 fix 2, any non-comment/non-empty line that does not END
 * with a semicolon: since every generated statement is exactly one line
 * (sqlLiteral never emits a literal line break — see the module header), a
 * "statement" spanning more than one line is by construction either a bug in
 * this tool or a value that slipped past that discipline, and either way must
 * refuse rather than silently execute a fragment. Blank lines and lines
 * starting with `--` (this tool's own comments) are skipped. Returns an
 * array of { line, text } for every offending line (empty = clean).
 */
export function scanForbiddenStatements(sqlText) {
  const offenders = [];
  const lines = sqlText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('--')) continue;
    const startsAllowed = ALLOWED_STATEMENT_VERBS.some((allowed) => trimmed.toUpperCase().startsWith(allowed));
    const endsWithSemicolon = trimmed.endsWith(';');
    if (!startsAllowed || !endsWithSemicolon) {
      offenders.push({ line: i + 1, text: raw });
    }
  }
  return offenders;
}
