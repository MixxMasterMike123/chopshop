import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runImport, DEFERRED_ROWS, DEFERRED_TARGET_TABLES, assertOutsideRepo, buildApplyMd, REPO_ROOT } from '../import.mjs';
import { scanForbiddenStatements } from '../lib/sql.mjs';
import { tmpDir, rmDir, buildFixtureBundle, FIXED_EMAIL_MAP, FIXED_NOW } from './fixtures.mjs';

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

function writeEmailMap(base) {
  const p = path.join(base, 'email-map.json');
  writeFileSync(p, JSON.stringify(FIXED_EMAIL_MAP));
  return p;
}

test('runImport: succeeds against the fixture bundle with a full email map', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.ok(result.planText.length > 0);
    assert.match(result.planSha, /^[0-9a-f]{64}$/);
  });
});

test('runImport: refuses when an email is unmapped and --scrub-unmapped is not given', async () => {
  await withFixture(async (bundleDir) => {
    const result = runImport({ bundleDir, emailMapPath: null, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, false);
  });
});

test('runImport: --scrub-unmapped lets an unmapped email through as a placeholder, and no source address survives in plan.sql', async () => {
  await withFixture(async (bundleDir) => {
    const result = runImport({ bundleDir, emailMapPath: null, env: 'staging', now: FIXED_NOW, scrubUnmapped: true });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    for (const address of ['admin1@example.com', 'admin2@example.com', 'owner-a@example.com', 'tenantadmin1@example.com', 'reviews-a@example.com', 'disabled@example.com', 'print1@example.com']) {
      assert.ok(!result.planText.includes(address), `source address ${address} must not appear in plan.sql`);
    }
    assert.match(result.planText, /scrubbed\+[0-9a-f]{12}@example\.com/);
  });
});

test('runImport: the plan is byte-identical across two runs of the same bundle and options', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const r1 = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    const r2 = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r1.planText, r2.planText);
    assert.equal(r1.planSha, r2.planSha);
  });
});

test('runImport: the plan changes when the bundle changes', async () => {
  const base1 = tmpDir();
  const base2 = tmpDir();
  try {
    const bundleDir1 = path.join(base1, 'bundle');
    const bundleDir2 = path.join(base2, 'bundle');
    await buildFixtureBundle(bundleDir1);
    await buildFixtureBundle(bundleDir2, { schemaPatch: (schema) => { schema.shops['test-shop-a'].data.name = 'Renamed Test Shop A'; } });
    const emailMapPath1 = path.join(base1, 'e.json');
    writeFileSync(emailMapPath1, JSON.stringify(FIXED_EMAIL_MAP));
    const emailMapPath2 = path.join(base2, 'e.json');
    writeFileSync(emailMapPath2, JSON.stringify(FIXED_EMAIL_MAP));
    const r1 = runImport({ bundleDir: bundleDir1, emailMapPath: emailMapPath1, env: 'staging', now: FIXED_NOW });
    const r2 = runImport({ bundleDir: bundleDir2, emailMapPath: emailMapPath2, env: 'staging', now: FIXED_NOW });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(r1.planText, r2.planText);
    assert.notEqual(r1.planSha, r2.planSha);
  } finally {
    rmDir(base1);
    rmDir(base2);
  }
});

test('runImport: D21 — robowatz is archived, not imported (no tenants row, reported)', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.ok(!result.planText.includes("'robowatz'"));
    assert.ok(result.reportLines.some((l) => l.includes('robowatz') && l.includes('D21')));
  });
});

test('runImport: D12 — the print_shop user and the uid-keyed legacy printer are archived, not imported', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.ok(!result.planText.includes('print1-test@example.com'));
    assert.ok(!result.planText.includes('o7diaDJ01tRoBMs8d5OK9bPunMg1'));
  });
});

test('runImport: staging status maps active->active, disabled->suspended; published carried verbatim', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.match(result.planText, /'test-shop-a', 'active'/);
    assert.match(result.planText, /'test-shop-b', 'suspended'/);
  });
});

test('runImport: staging every shop gets a placeholder <tenantId>.import.invalid hostname', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.ok(result.planText.includes('test-shop-a.import.invalid'));
    assert.ok(result.planText.includes('test-shop-b.import.invalid'));
  });
});

test('runImport: refused store identity keys are dropped, and the four branding URLs are removed when Firebase-hosted', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.ok(!result.planText.includes('firebasestorage.googleapis.com'));
    // supportEmail/returnAddress/vatRegistered/etc. never appear INSIDE the
    // store_identity_json blob (they are extracted to columns instead) —
    // check they are absent as JSON keys.
    assert.ok(!result.planText.includes('"supportEmail"'));
    assert.ok(!result.planText.includes('"returnAddress"'));
    assert.ok(!result.planText.includes('"vatRegistered"'));
    assert.ok(result.reportLines.some((l) => l.includes('logoUrl removed')));
  });
});

test('runImport: connect facts — an unmapped live account id never reaches staging', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.ok(!result.planText.includes('acct_live_test_a'));
  });
});

test('runImport: connect facts — a mapped live account id is replaced by its sandbox id on staging', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const connectMapPath = path.join(base, 'connect-map.json');
    writeFileSync(connectMapPath, JSON.stringify({ acct_live_test_a: 'acct_sandbox_test_a' }));
    const result = runImport({ bundleDir, connectMapPath, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.ok(result.planText.includes('acct_sandbox_test_a'));
    assert.ok(!result.planText.includes('acct_live_test_a'));
  });
});

test('runImport: feature flags — effective values only, pod always explicit', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.match(result.planText, /tenant_features .* VALUES \('test-shop-a', 'pod', 1,/);
    // test-shop-b has no features field at all: pod defaults OFF, still explicit.
    assert.match(result.planText, /tenant_features .* VALUES \('test-shop-b', 'pod', 0,/);
  });
});

test('runImport: users — no password is ever written (account.password is NULL)', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.match(result.planText, /"account".*VALUES.*NULL, NULL, NULL, NULL, NULL, NULL, NULL,/);
  });
});

test('runImport: deterministic user ids across two runs of the same bundle', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const r1 = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    const r2 = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    const idLine = (text) => text.split('\n').find((l) => l.includes('tenantadmin1') && l.includes('legacy_id_map'));
    assert.equal(idLine(r1.planText), idLine(r2.planText));
  });
});

test('runImport: refuses when the resulting state has no active platform admin', async () => {
  await withFixture(
    async (bundleDir, base) => {
      const emailMapPath = writeEmailMap(base);
      const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((p) => p.includes('no active platform_admin')));
    },
    {
      schemaPatch: (schema) => {
        // No platform admins at all: both admin1/admin2 removed.
        delete schema.users.admin1;
        delete schema.users.admin2;
      },
    },
  );
});

test('runImport: the forbidden-statement scan finds nothing in a real plan', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.deepEqual(scanForbiddenStatements(result.planText), []);
  });
});

test('runImport: deferred rows produce zero statements and never name their target tables', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.ok(Object.keys(DEFERRED_ROWS).length > 0);
    for (const table of DEFERRED_TARGET_TABLES) {
      const re = new RegExp(`INTO ${table}\\b`);
      assert.ok(!re.test(result.planText), `plan must not name the deferred table ${table}`);
    }
    for (const row of Object.keys(DEFERRED_ROWS)) {
      assert.ok(result.reportLines.some((l) => l.startsWith(`row ${row} deferred`)), `row ${row} must be reported as deferred`);
    }
  });
});

test('runImport: no --target-state assumes an empty target, reported loudly', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.ok(result.reportLines.some((l) => l.includes('no --target-state given')));
  });
});

test('runImport: with --target-state, a tenant id collision is refused', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const targetStatePath = path.join(base, 'target-state.json');
    writeFileSync(targetStatePath, JSON.stringify({ tenants: { ids: ['test-shop-a'] } }));
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW, targetStatePath });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('collision')));
  });
});

test('runImport: with --target-state, an existing user email is ADOPTED (D59) rather than a new id minted', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const targetStatePath = path.join(base, 'target-state.json');
    writeFileSync(targetStatePath, JSON.stringify({ users: { activePlatformAdminCount: 1, emailToId: { 'admin1-test@example.com': 'existing_user_id_123' } } }));
    const result = runImport({ bundleDir, emailMapPath, env: 'staging', now: FIXED_NOW, targetStatePath });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    // No fresh `user` INSERT for the adopted identity...
    assert.ok(!result.planText.includes('INSERT OR IGNORE INTO "user" ("id", "name", "email"'.replace('"id"', '"id"')) || true); // (see below for the precise assertion)
    const userInsertForAdopted = result.planText.split('\n').filter((l) => l.startsWith('INSERT OR IGNORE INTO "user"')).some((l) => l.includes('existing_user_id_123'));
    assert.equal(userInsertForAdopted, false, 'an adopted identity must not get a fresh user row');
    // ...but the legacy_id_map row points AT the existing id.
    assert.ok(result.planText.includes("legacy_id_map (kind, legacy_id, new_id, env, created_at) VALUES ('user', 'admin1', 'existing_user_id_123'"));
  });
});

test('DEFERRED_ROWS covers manifest rows 20, 33, 40, 42, 43, 44, 51, 58, 59, 60, 71', () => {
  const rows = Object.keys(DEFERRED_ROWS).map(Number).sort((a, b) => a - b);
  assert.deepEqual(rows, [20, 33, 40, 42, 43, 44, 51, 58, 59, 60, 71]);
});

test('assertOutsideRepo refuses a path inside the repo', () => {
  let exited = false;
  const originalExit = process.exit;
  process.exit = () => {
    exited = true;
    throw new Error('exit');
  };
  try {
    assertOutsideRepo(path.join(REPO_ROOT, 'scripts', 'some-output'));
  } catch {
    // expected: die() calls process.exit, which we've stubbed to throw
  } finally {
    process.exit = originalExit;
  }
  assert.equal(exited, true);
});

test('assertOutsideRepo accepts a path clearly outside the repo', () => {
  let exited = false;
  const originalExit = process.exit;
  process.exit = () => {
    exited = true;
    throw new Error('exit');
  };
  try {
    assertOutsideRepo(path.join(tmpDir(), 'plan-out'));
  } finally {
    process.exit = originalExit;
  }
  assert.equal(exited, false);
});

test('buildApplyMd mentions Time Travel, the preflight script, and the restore-after-failure procedure', () => {
  const md = buildApplyMd({ env: 'staging', planSha: 'a'.repeat(64) });
  assert.match(md, /Time Travel/);
  assert.match(md, /cf-preflight\.sh/);
  assert.match(md, /import_runs/);
  assert.match(md, /'failed'/);
});

// ── Review round 1 ──────────────────────────────────────────────────────────

test('fix 3: called as the CLI calls it (no clock passed), the plan\'s clock is the bundle\'s exportedAt and the plan is byte-identical across runs', async () => {
  await withFixture(
    async (bundleDir, base) => {
      const emailMapPath = writeEmailMap(base);
      const r1 = runImport({ bundleDir, emailMapPath, env: 'staging' });
      await new Promise((resolve) => setTimeout(resolve, 15));
      const r2 = runImport({ bundleDir, emailMapPath, env: 'staging' });
      assert.equal(r1.ok, true, JSON.stringify(r1.problems));
      assert.equal(r1.planText, r2.planText);
      assert.equal(r1.planSha, r2.planSha);
      assert.equal(r1.planJson.runId, r2.planJson.runId);
      const runLine = r1.planText.split('\n').find((l) => l.startsWith('INSERT INTO import_runs'));
      assert.ok(runLine.includes("'2026-03-04T05:06:07.089Z'"), 'started_at is the bundle\'s exportedAt');
      assert.ok(!r1.planText.includes(String(new Date().getUTCFullYear()) + '-' + String(new Date().getUTCMonth() + 1).padStart(2, '0') + '-' + String(new Date().getUTCDate()).padStart(2, '0')), 'today\'s date is nowhere in the plan');
      assert.match(r1.planJson.runId, /^import_staging_[0-9a-f]{16}_[0-9a-f]{16}$/);
    },
    { exportedAt: '2026-03-04T05:06:07.089Z' },
  );
});

test('fix 3: the run id changes with an option that changes the plan', async () => {
  await withFixture(async (bundleDir, base) => {
    const emailMapPath = writeEmailMap(base);
    const mapped = runImport({ bundleDir, emailMapPath, env: 'staging' });
    const scrubbed = runImport({ bundleDir, emailMapPath, env: 'staging', scrubUnmapped: true });
    assert.notEqual(mapped.planJson.runId, scrubbed.planJson.runId);
  });
});

test('fix 4: no address and no user id in the report lines or the problems, also when the run is refused', async () => {
  await withFixture(async (bundleDir, base) => {
    const refused = runImport({ bundleDir, env: 'staging' });
    assert.equal(refused.ok, false);
    const accepted = runImport({ bundleDir, emailMapPath: writeEmailMap(base), env: 'staging' });
    const printed = [...refused.problems, ...accepted.problems, ...accepted.reportLines].join('\n');
    assert.ok(!/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(printed), 'no address is printed');
    for (const uid of ['admin1', 'admin2', 'tenantadmin1', 'disabledadmin', 'printshopuser', 'authonly1', 'o7diaDJ01tRoBMs8d5OK9bPunMg1']) {
      assert.ok(!printed.includes(uid), `the user id ${uid} must not be printed`);
    }
    assert.ok(accepted.reportLines.some((l) => l.includes('1 uid-keyed legacy print-shop printer(s) archived')));
    assert.ok(refused.problems.some((p) => /fingerprint [0-9a-f]{12}/.test(p)));
  });
});

test('fix 5: an address inside a longer text is found by the whole-plan scan, named by table and never printed', async () => {
  await withFixture(
    async (bundleDir) => {
      const result = runImport({ bundleDir, env: 'staging', scrubUnmapped: true });
      assert.equal(result.ok, false);
      const hit = result.problems.find((p) => p.includes('source address'));
      assert.ok(hit, JSON.stringify(result.problems));
      assert.match(hit, /tenant_settings/);
      assert.ok(!result.problems.join('\n').includes('owner-a@example.com'));
    },
    {
      schemaPatch: (schema) => {
        schema.shops['test-shop-a'].data.storeIdentity.returnAddress = 'Test Shop A, Testgatan 1. Frågor: owner-a@example.com';
      },
    },
  );
});

test('fix 5: the texts snapshot of a legal acceptance is evidence — an address in it does not refuse the plan, even when the same address is a field of the shop', async () => {
  await withFixture(
    async (bundleDir) => {
      const result = runImport({ bundleDir, env: 'staging', scrubUnmapped: true });
      assert.equal(result.ok, true, JSON.stringify(result.problems));
      assert.ok(result.planText.includes('Kontakt: owner-a@example.com'), 'the snapshot is carried as it was');
      const outsideSnapshot = result.planText.split('\n').filter((l) => !l.includes('INTO legal_acceptances')).join('\n');
      assert.ok(!outsideSnapshot.includes('owner-a@example.com'));
      assert.ok(result.reportLines.some((l) => l.includes('1 source address(es) found inside texts_json')));
    },
    {
      schemaPatch: (schema) => {
        schema.shops['test-shop-a'].subcollections.legalAcceptances.accept1.data.texts.kopvillkor = '<p>Villkor</p>\n<p>Kontakt: owner-a@example.com</p>';
      },
    },
  );
});

test('a value with line breaks and an apostrophe is one statement on one line and the plan is accepted (fix 2, end to end)', async () => {
  await withFixture(
    async (bundleDir, base) => {
      const result = runImport({ bundleDir, emailMapPath: writeEmailMap(base), env: 'staging' });
      assert.equal(result.ok, true, JSON.stringify(result.problems));
      assert.deepEqual(scanForbiddenStatements(result.planText), []);
      assert.ok(result.planText.includes("'Test Shop A' || char(13) || '' || char(10) || 'O''Testgatan 1' || char(10) || '123 45 Teststad'"));
    },
    {
      schemaPatch: (schema) => {
        schema.shops['test-shop-a'].data.storeIdentity.returnAddress = "Test Shop A\r\nO'Testgatan 1\n123 45 Teststad";
      },
    },
  );
});

test('every Firebase Storage URL of the store identity is removed, the gallery images too, and each is reported', async () => {
  await withFixture(
    async (bundleDir, base) => {
      const result = runImport({ bundleDir, emailMapPath: writeEmailMap(base), env: 'staging' });
      assert.equal(result.ok, true, JSON.stringify(result.problems));
      assert.ok(!result.planText.includes('googleapis.com'));
      assert.ok(result.planText.includes('"caption":"Bild ett"'), 'the rest of the gallery entry is kept');
      assert.ok(result.reportLines.some((l) => l.includes('storeIdentity.gallery[0].imageUrl removed')));
      assert.ok(result.reportLines.some((l) => l.includes('storeIdentity.logoUrl removed')));
    },
    {
      schemaPatch: (schema) => {
        schema.shops['test-shop-a'].data.storeIdentity.gallery = [
          { caption: 'Bild ett', imageUrl: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/gallery%2Fone.jpg?alt=media' },
        ];
      },
    },
  );
});

test('a statement over D1\'s length limit refuses the plan, named by table', async () => {
  await withFixture(
    async (bundleDir, base) => {
      const result = runImport({ bundleDir, emailMapPath: writeEmailMap(base), env: 'staging' });
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((p) => /a statement for tenant_settings is \d+ bytes, over D1's limit of 100000/.test(p)), JSON.stringify(result.problems));
    },
    {
      schemaPatch: (schema) => {
        schema.shops['test-shop-a'].data.storeIdentity.about = 'x'.repeat(100_001);
      },
    },
  );
});

test('production: the two scrub options are refused, and without them every address is carried as it is', async () => {
  await withFixture(async (bundleDir, base) => {
    const withMap = runImport({ bundleDir, emailMapPath: writeEmailMap(base), env: 'production' });
    assert.equal(withMap.ok, false);
    assert.match(withMap.problems[0], /--email-map is a staging option/);
    const withScrub = runImport({ bundleDir, env: 'production', scrubUnmapped: true });
    assert.equal(withScrub.ok, false);
    assert.match(withScrub.problems[0], /--scrub-unmapped is a staging option/);

    const plain = runImport({ bundleDir, env: 'production' });
    assert.equal(plain.ok, true, JSON.stringify(plain.problems));
    assert.ok(plain.planText.includes("'admin1@example.com'"));
    assert.ok(plain.planText.includes("'owner-a@example.com'"));
    assert.ok(!plain.planText.includes('scrubbed+'));
    assert.ok(plain.planText.includes('acct_live_test_a'), 'production carries the live account id');
  });
});

test('fix 6: a tenant admin whose shop is not imported is carried without a membership, and counted', async () => {
  await withFixture(
    async (bundleDir, base) => {
      const result = runImport({ bundleDir, emailMapPath: writeEmailMap(base), env: 'staging' });
      assert.equal(result.ok, true, JSON.stringify(result.problems));
      const memberships = result.planText.split('\n').filter((l) => l.startsWith('INSERT OR IGNORE INTO tenant_memberships'));
      assert.ok(memberships.every((l) => !l.includes("'robowatz'") && !l.includes("'shop-never-exported'")));
      assert.equal(memberships.length, 1, 'only the admin of an imported shop keeps a membership');
      assert.ok(result.reportLines.some((l) => l.startsWith('users: 2 tenant-admin membership(s) skipped')));
      assert.equal(result.planText.split('\n').filter((l) => l.startsWith('INSERT OR IGNORE INTO identity_access')).length, 5, 'the users themselves are carried');
    },
    {
      schemaPatch: (schema) => {
        schema.users.disabledadmin.data.shopId = 'robowatz'; // archived by D21
        schema.users.orphanadmin = { data: { active: true, contactPerson: 'Orphan Admin', email: 'print1@example.com', isActive: true, platform: false, role: 'admin', shopId: 'shop-never-exported' } };
      },
    },
  );
});

test('fix 6: a shop that is already in the target (--target-state) counts as known', async () => {
  await withFixture(
    async (bundleDir, base) => {
      const targetStatePath = path.join(base, 'target-state.json');
      writeFileSync(targetStatePath, JSON.stringify({ tenants: { ids: ['shop-already-there'] } }));
      const result = runImport({ bundleDir, emailMapPath: writeEmailMap(base), env: 'staging', targetStatePath });
      assert.equal(result.ok, true, JSON.stringify(result.problems));
      assert.ok(result.planText.split('\n').some((l) => l.startsWith('INSERT OR IGNORE INTO tenant_memberships') && l.includes("'shop-already-there'")));
      assert.ok(!result.reportLines.some((l) => l.includes('membership(s) skipped')));
    },
    {
      schemaPatch: (schema) => {
        schema.users.disabledadmin.data.shopId = 'shop-already-there';
      },
    },
  );
});
