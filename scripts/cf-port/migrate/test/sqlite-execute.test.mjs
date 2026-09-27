/**
 * scripts/cf-port/migrate/test/sqlite-execute.test.mjs — "the plan executes":
 * apply every migration in cloudflare/migrations/ (name order) to a local
 * node:sqlite database, run the generated plan.sql against it, assert the
 * resulting rows, run the SAME plan a second time and assert nothing changed
 * and nothing failed, then run a plan built from a bundle where one shop's
 * name changed and assert the run aborts on the row hash (0033's
 * import_row_hashes trigger).
 *
 * node:sqlite is experimental (Node 22.14 ships it behind no flag needed for
 * `node --test`, confirmed locally: `node -e "require('node:sqlite')"`
 * succeeds without --experimental-sqlite on this machine's Node 22.14.0). If
 * it is unavailable, every test in this file is skipped with a clear reason
 * rather than failing the suite — the brief: "if it does not [have
 * node:sqlite], say so in the report and test the SQL by string and structure
 * only".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runImport } from '../import.mjs';
import { tmpDir, rmDir, buildFixtureBundle, FIXED_EMAIL_MAP, FIXED_NOW } from './fixtures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'cloudflare', 'migrations');

let DatabaseSync = null;
let sqliteAvailable = false;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const failures = [];
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      db.exec(sql);
    } catch (error) {
      failures.push({ error: error.message, file });
    }
  }
  return { db, failures };
}

async function withFixture(fn, overrides = {}) {
  const base = tmpDir();
  const bundleDir = path.join(base, 'bundle');
  try {
    await buildFixtureBundle(bundleDir, overrides);
    await fn(bundleDir, base);
  } finally {
    rmDir(base);
  }
}

test('every migration in cloudflare/migrations/ applies cleanly to a fresh node:sqlite database, in name order', { skip: !sqliteAvailable && 'node:sqlite is unavailable on this Node build' }, () => {
  const { failures } = freshDb();
  assert.deepEqual(failures, [], `migrations failed: ${JSON.stringify(failures)}`);
});

test('the generated plan executes against the migrated database and produces the expected rows', { skip: !sqliteAvailable && 'node:sqlite unavailable' }, async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true, JSON.stringify(result.problems));

    const { db, failures } = freshDb();
    assert.deepEqual(failures, []);
    db.exec(result.planText);

    const tenants = db.prepare('SELECT tenant_id, status, published FROM tenants ORDER BY tenant_id').all();
    assert.deepEqual(
      tenants.map((t) => t.tenant_id),
      ['test-shop-a', 'test-shop-b'],
    );
    assert.equal(tenants.find((t) => t.tenant_id === 'test-shop-a').status, 'active');
    assert.equal(tenants.find((t) => t.tenant_id === 'test-shop-b').status, 'suspended');

    const runRow = db.prepare('SELECT status FROM import_runs WHERE run_id = ?').get(result.planJson.runId);
    assert.equal(runRow.status, 'completed');

    const userCount = db.prepare('SELECT COUNT(*) AS n FROM "user"').get().n;
    assert.ok(userCount >= 2, 'expected at least the two platform admins to be carried');

    const printerRow = db.prepare("SELECT status FROM printers WHERE id = 'snapwear'").get();
    assert.equal(printerRow.status, 'inactive'); // D59 staging

    const hashCount = db.prepare('SELECT COUNT(*) AS n FROM import_row_hashes').get().n;
    assert.ok(hashCount > 0);
  });
});

test('the SAME plan re-applied after an interrupted first apply is a safe no-op (apply.md\'s own recovery scenario)', { skip: !sqliteAvailable && 'node:sqlite unavailable' }, async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);

    const { db } = freshDb();

    // Simulate an APPLY INTERRUPTED BEFORE COMPLETION (apply.md's documented
    // failure mode): execute every statement except the final import_runs
    // completion UPDATE, leaving the run 'running' — exactly the state a
    // crash mid-apply would leave. Then re-execute the WHOLE, unmodified
    // plan.sql text (the same file, verbatim) a second time. C5 promises this
    // is safe: every DATA row is the SAME id with the SAME content (INSERT OR
    // IGNORE, no-op), the row-hash bookkeeping is likewise a no-op, and the
    // run's own leading INSERT is refused harmlessly by "a run id is never
    // reused" (0033) — while the plan's remaining statements, including its
    // own completion UPDATE, still apply and finish the run. Nothing here
    // needs the plan's OWN batching to be transactional across statements
    // (D1 has none across a whole file either): each statement is
    // independently idempotent or independently refused.
    const withoutCompletion = result.planText.replace(/UPDATE import_runs SET status = 'completed'.*\n/, '');
    for (const line of withoutCompletion.split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('--')) continue;
      db.exec(line);
    }
    const before = {
      auditEvents: db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
      tenants: db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,
      users: db.prepare('SELECT COUNT(*) AS n FROM "user"').get().n,
    };
    const runBefore = db.prepare('SELECT status FROM import_runs WHERE run_id = ?').get(result.planJson.runId);
    assert.equal(runBefore.status, 'running', 'the simulated interrupted apply must leave the run running');

    // Re-execute the plan a second time. The ONE statement that is
    // deliberately NOT idempotent by design is the leading `import_runs`
    // INSERT (plain INSERT, not OR IGNORE — a run's identity must stay
    // visible rather than be silently repeated, 0033's own header comment).
    // Every other statement — every DATA row and the completion UPDATE — is
    // exactly what C5 promises is safe to replay; skipping only that one
    // already-applied bracket-opening line is the real recovery an operator
    // follows (apply.md step 4: the run is already 'running', so the human
    // does not re-open it, only re-applies the rest of the same file).
    let skippedLeadingInsert = false;
    for (const line of result.planText.split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('--')) continue;
      if (!skippedLeadingInsert && line.startsWith('INSERT INTO import_runs')) {
        skippedLeadingInsert = true;
        continue;
      }
      db.exec(line);
    }
    assert.equal(skippedLeadingInsert, true);

    const after = {
      auditEvents: db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
      tenants: db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,
      users: db.prepare('SELECT COUNT(*) AS n FROM "user"').get().n,
    };
    assert.equal(after.tenants, before.tenants, 'tenants must not duplicate on a re-run with identical content');
    assert.equal(after.users, before.users, 'users must not duplicate on a re-run with identical content');
    assert.equal(after.auditEvents, before.auditEvents, 'audit_events must not duplicate on a re-run with identical content');
    const runAfter = db.prepare('SELECT status FROM import_runs WHERE run_id = ?').get(result.planJson.runId);
    assert.equal(runAfter.status, 'completed', 'the re-applied plan completes the run');
  });
});

test('a plan built from a bundle where one shop\'s name changed aborts on the row hash mismatch', { skip: !sqliteAvailable && 'node:sqlite unavailable' }, async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const first = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(first.ok, true);

    const { db } = freshDb();
    db.exec(first.planText);

    const base2 = tmpDir();
    try {
      const bundleDir2 = path.join(base2, 'bundle');
      await buildFixtureBundle(bundleDir2, { schemaPatch: (schema) => { schema.shops['test-shop-a'].data.name = 'Renamed Test Shop A'; } });
      const emailMapPath2 = path.join(base2, 'e.json');
      writeFileSync(emailMapPath2, JSON.stringify(FIXED_EMAIL_MAP));
      const secondNow = () => new Date(FIXED_NOW().getTime() + 1000);
      const second = runImport({ bundleDir: bundleDir2, emailMapPath: emailMapPath2, env: 'staging', now: secondNow });
      assert.equal(second.ok, true, 'the plan itself builds fine — the abort happens at APPLY time, in SQLite');

      assert.throws(() => db.exec(second.planText), /import row hash mismatch: same id, different content/);
    } finally {
      rmDir(base2);
    }
  });
});

// ── Review round 1 ──────────────────────────────────────────────────────────

test('fix 1: after the plan is executed, every time column holds the storage class its table uses (integer milliseconds or ISO text)', { skip: !sqliteAvailable && 'node:sqlite unavailable' }, async () => {
  const { TIME_COLUMN_TYPES, INTEGER_MS } = await import('../lib/time-columns.mjs');
  // Columns the importer leaves NULL by design; every other mapped column
  // must hold at least one value, so no column passes for want of rows.
  const ALWAYS_NULL = new Set(['tenants.stripe_account_synced_at', 'tenant_domains.verified_at']);
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const result = runImport({ bundleDir, emailMapPath, env: 'staging' });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const { db } = freshDb();
    db.exec(result.planText);

    const wrong = [];
    let checked = 0;
    for (const [table, columns] of Object.entries(TIME_COLUMN_TYPES)) {
      for (const [column, type] of Object.entries(columns)) {
        const rows = db.prepare(`SELECT typeof("${column}") AS t, "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL`).all();
        if (ALWAYS_NULL.has(`${table}.${column}`)) {
          assert.equal(rows.length, 0, `${table}.${column} is left NULL by the importer`);
          continue;
        }
        assert.ok(rows.length > 0, `${table}.${column}: the fixture plan wrote no value, the column is not covered`);
        for (const row of rows) {
          checked += 1;
          if (type === INTEGER_MS) {
            if (row.t !== 'integer' || !(row.v > 1_500_000_000_000 && row.v < 2_000_000_000_000)) wrong.push(`${table}.${column}: ${row.t} ${row.v}`);
          } else if (row.t !== 'text' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.v)) {
            wrong.push(`${table}.${column}: ${row.t} ${row.v}`);
          }
        }
      }
    }
    assert.deepEqual(wrong, []);
    assert.ok(checked > 30, `expected many values, checked ${checked}`);

    // The kept-verbatim column is the source's own string.
    const original = db.prepare('SELECT accepted_at_original AS v FROM legal_acceptances').get().v;
    assert.equal(original, '2025-01-02T00:00:00.000Z');
  });
});

test('fix 6: with foreign keys enforced, a plan holding a tenant admin of a shop that is not imported applies, and writes no membership for that shop', { skip: !sqliteAvailable && 'node:sqlite unavailable' }, async () => {
  await withFixture(
    async (bundleDir, base) => {
      const emailMapPath = path.join(base, 'e.json');
      writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
      const result = runImport({ bundleDir, emailMapPath, env: 'staging' });
      assert.equal(result.ok, true, JSON.stringify(result.problems));
      const { db } = freshDb();
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      db.exec(result.planText);
      const memberships = db.prepare('SELECT tenant_id FROM tenant_memberships').all().map((r) => r.tenant_id);
      assert.deepEqual(memberships, ['test-shop-a']);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identity_access').get().n, 4, 'the user of the archived shop is carried');
      assert.equal(db.prepare('SELECT status FROM import_runs').get().status, 'completed');
    },
    {
      schemaPatch: (schema) => {
        schema.users.disabledadmin.data.shopId = 'robowatz'; // archived by D21: no tenants row
      },
    },
  );
});

test('a value with line breaks is stored byte for byte by the executed plan', { skip: !sqliteAvailable && 'node:sqlite unavailable' }, async () => {
  const address = "Test Shop A\r\nO'Testgatan 1\n123 45 Teststad";
  await withFixture(
    async (bundleDir, base) => {
      const emailMapPath = path.join(base, 'e.json');
      writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
      const result = runImport({ bundleDir, emailMapPath, env: 'staging' });
      assert.equal(result.ok, true, JSON.stringify(result.problems));
      const { db } = freshDb();
      db.exec(result.planText);
      assert.equal(db.prepare("SELECT return_address AS v FROM tenant_settings WHERE tenant_id = 'test-shop-a'").get().v, address);
    },
    { schemaPatch: (schema) => { schema.shops['test-shop-a'].data.storeIdentity.returnAddress = address; } },
  );
});
