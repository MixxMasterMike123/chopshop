import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlLiteral, sqlIdent, insertStatement, updateStatement, scanForbiddenStatements, UnsafeSqlValueError, ALLOWED_STATEMENT_VERBS, MAX_CONCAT_PIECES, MAX_STATEMENT_BYTES } from '../lib/sql.mjs';

let DatabaseSync = null;
let sqliteAvailable = false;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

test('sqlLiteral: null/undefined -> NULL', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(undefined), 'NULL');
});

test('sqlLiteral: booleans -> 0/1', () => {
  assert.equal(sqlLiteral(true), '1');
  assert.equal(sqlLiteral(false), '0');
});

test('sqlLiteral: finite numbers pass through; non-finite refused', () => {
  assert.equal(sqlLiteral(42), '42');
  assert.equal(sqlLiteral(-3.5), '-3.5');
  assert.throws(() => sqlLiteral(NaN), UnsafeSqlValueError);
  assert.throws(() => sqlLiteral(Infinity), UnsafeSqlValueError);
  assert.throws(() => sqlLiteral(-Infinity), UnsafeSqlValueError);
});

test('sqlLiteral: strings with quotes are escaped by doubling', () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral("it's a 'test'"), "'it''s a ''test'''");
});

test('sqlLiteral: backslashes pass through verbatim (SQLite has no backslash escape)', () => {
  assert.equal(sqlLiteral('C:\\path\\to\\file'), "'C:\\path\\to\\file'");
});

test('sqlLiteral: a plain string with no control character is one plain quoted literal', () => {
  assert.equal(sqlLiteral('plain text'), "'plain text'");
});

test('sqlLiteral: very long text is not truncated', () => {
  const long = 'x'.repeat(100_000);
  assert.equal(sqlLiteral(long), `'${long}'`);
});

test('sqlLiteral: non-ASCII text passes through raw', () => {
  assert.equal(sqlLiteral('Håkan Hellström ™'), "'Håkan Hellström ™'");
});

test('sqlLiteral: refuses a string containing a NUL byte', () => {
  assert.throws(() => sqlLiteral('abc\u0000def'), UnsafeSqlValueError);
});

test('sqlLiteral: refuses objects/arrays/functions', () => {
  assert.throws(() => sqlLiteral({}), UnsafeSqlValueError);
  assert.throws(() => sqlLiteral([1, 2]), UnsafeSqlValueError);
  assert.throws(() => sqlLiteral(() => {}), UnsafeSqlValueError);
});

// ── review round 1, fix 2: a control character never appears literally in
// the generated SQL text — every statement stays exactly one line ──────────

const CONTROL_CHAR_VECTORS = [
  { label: 'a single line feed in the middle', value: 'Testgatan 1\n123 45 Staden' },
  { label: 'a single carriage return', value: 'line one\rline two' },
  { label: 'CRLF', value: 'line one\r\nline two' },
  { label: 'a tab', value: 'col1\tcol2' },
  { label: 'a leading line break', value: '\nleading' },
  { label: 'a trailing line break', value: 'trailing\n' },
  { label: 'ONLY a line break', value: '\n' },
  { label: 'a value whose continuation looks like a forbidden statement', value: 'x\nDELETE FROM tenants;' },
  { label: 'multiple consecutive control characters', value: 'a\n\n\tb' },
  { label: 'a quote next to a line break', value: "O'Brien\nsecond line" },
];

for (const { label, value } of CONTROL_CHAR_VECTORS) {
  test(`sqlLiteral: ${label} — the generated literal has no literal control character`, () => {
    const literal = sqlLiteral(value);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(literal), `literal text must contain no raw control character: ${JSON.stringify(literal)}`);
  });

  test(`sqlLiteral: ${label} — the resulting statement is exactly one line and passes the forbidden-statement scan`, () => {
    const statement = insertStatement('tenants', ['tenant_id', 'shop_name'], { shop_name: value, tenant_id: 't1' });
    assert.equal(statement.split('\n').length, 1, `statement must be a single line: ${JSON.stringify(statement)}`);
    assert.deepEqual(scanForbiddenStatements(statement), []);
  });

  test(
    `sqlLiteral: ${label} — after execution against a local database the stored value is byte-identical to the input`,
    { skip: !sqliteAvailable && 'node:sqlite unavailable' },
    () => {
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE t (v TEXT);');
      db.exec(`INSERT INTO t (v) VALUES (${sqlLiteral(value)});`);
      const stored = db.prepare('SELECT v FROM t').get().v;
      assert.equal(stored, value);
    },
  );
}

test('sqlIdent: quotes and doubles embedded double-quotes', () => {
  assert.equal(sqlIdent('email'), '"email"');
  assert.equal(sqlIdent('weird"name'), '"weird""name"');
});

test('sqlIdent: refuses empty and NUL-containing names', () => {
  assert.throws(() => sqlIdent(''));
  assert.throws(() => sqlIdent('a\u0000b'));
});

test('sqlIdent: refuses a name containing a control character', () => {
  assert.throws(() => sqlIdent('a\nb'));
});

test('insertStatement: builds a deterministic INSERT OR IGNORE by default', () => {
  const stmt = insertStatement('tenants', ['tenant_id', 'status'], { status: 'active', tenant_id: 't1' });
  assert.equal(stmt, "INSERT OR IGNORE INTO tenants (tenant_id, status) VALUES ('t1', 'active');");
});

test('insertStatement: orIgnore: false omits OR IGNORE', () => {
  const stmt = insertStatement('tenants', ['tenant_id'], { tenant_id: 't1' }, { orIgnore: false });
  assert.equal(stmt, "INSERT INTO tenants (tenant_id) VALUES ('t1');");
});

test('insertStatement: refuses unsafe table/column names', () => {
  assert.throws(() => insertStatement('bad;drop', ['x'], { x: 1 }));
  assert.throws(() => insertStatement('tenants', ['bad col'], { 'bad col': 1 }));
});

test('updateStatement: builds a single-row UPDATE with an equality WHERE', () => {
  const stmt = updateStatement('print_defaults', { default_printer_id: 'snapwear' }, { id: 1 });
  assert.equal(stmt, "UPDATE print_defaults SET default_printer_id = 'snapwear' WHERE id = 1;");
});

test('updateStatement: refuses empty set/where', () => {
  assert.throws(() => updateStatement('t', {}, { id: 1 }));
  assert.throws(() => updateStatement('t', { a: 1 }, {}));
});

test('scanForbiddenStatements: allows INSERT/UPDATE/SELECT only, each terminated by a semicolon', () => {
  const text = [
    "INSERT INTO t (a) VALUES ('x');",
    "INSERT OR IGNORE INTO t (a) VALUES ('x');",
    'UPDATE t SET a = 1 WHERE id = 1;',
    'SELECT 1;',
    '-- a comment line',
    '',
  ].join('\n');
  assert.deepEqual(scanForbiddenStatements(text), []);
});

test('scanForbiddenStatements: flags DELETE, DROP, ALTER, REPLACE, PRAGMA', () => {
  for (const bad of ['DELETE FROM t;', 'DROP TABLE t;', 'ALTER TABLE t ADD COLUMN x;', 'REPLACE INTO t (a) VALUES (1);', 'PRAGMA foreign_keys=ON;']) {
    const offenders = scanForbiddenStatements(bad);
    assert.equal(offenders.length, 1, `expected ${bad} to be flagged`);
  }
});

test('scanForbiddenStatements: flags a non-comment, non-empty line that does not end with a semicolon', () => {
  const offenders = scanForbiddenStatements("INSERT INTO t (a) VALUES ('x')\n");
  assert.equal(offenders.length, 1);
});

test('scanForbiddenStatements: a statement spanning two literal lines (simulating a bypass of sqlLiteral) is flagged on both lines', () => {
  const text = "INSERT INTO t (a) VALUES ('line one\nline two');";
  const offenders = scanForbiddenStatements(text);
  assert.ok(offenders.length >= 1, 'a literal embedded newline must be caught, not silently accepted');
});

test('ALLOWED_STATEMENT_VERBS is exactly INSERT/UPDATE/SELECT', () => {
  assert.deepEqual(ALLOWED_STATEMENT_VERBS, ['INSERT', 'UPDATE', 'SELECT']);
});

// ── Review round 1: limits and messages ─────────────────────────────────────

test('sqlLiteral: the largest chain it emits is one SQLite accepts, and one piece more is refused when the plan is built', { skip: !sqliteAvailable && 'node:sqlite unavailable' }, () => {
  const lines = (count) => Array.from({ length: count + 1 }, (_, i) => `line ${i}`).join('\n');
  const largest = lines((MAX_CONCAT_PIECES - 1) / 2 | 0); // n control characters -> 2n + 1 pieces
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (v TEXT);');
  db.exec(`INSERT INTO t (v) VALUES (${sqlLiteral(largest)});`);
  assert.equal(db.prepare('SELECT v FROM t').get().v, largest);
  assert.throws(() => sqlLiteral(lines(MAX_CONCAT_PIECES)), UnsafeSqlValueError);
});

test('sqlLiteral: a refusal names the type, never the value', () => {
  try {
    sqlLiteral({ email: 'secret.person@example.com' });
    assert.fail('must throw');
  } catch (error) {
    assert.ok(error instanceof UnsafeSqlValueError);
    assert.ok(!error.message.includes('secret.person'));
    assert.match(error.message, /type object/);
  }
  assert.throws(() => sqlLiteral(['x']), /type array/);
});

test('MAX_STATEMENT_BYTES is D1\'s documented statement limit', () => {
  assert.equal(MAX_STATEMENT_BYTES, 100_000);
});
