import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runExport,
  parseArgs,
  assertOutsideRepo,
  pickAuthUserFields,
  REPO_ROOT,
  PROJECT_ID,
  mapWithConcurrency,
} from '../export.mjs';
import { FakeFirestore, FakeAuth, FakeFieldPath } from './fake-firestore.mjs';

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'cfport-export-'));
}

// REVIEW ROUND 1: the fake's schema shape is now a generic recursive tree
// (see fake-firestore.mjs's header comment) — each doc entry is
// `{ data, subcollections: { subName: { docId: {...} } } }`, to arbitrary
// depth, instead of the old flat `{ docs, subcollections }` shape that only
// supported the two manifest-known subcollections one level deep.
function baseSchema() {
  return {
    collections: {
      c1: { data: { title: 'Herr', handle: 'herr', shopId: 'ninetone' } },
    },
    adminPresence: {
      u1: { data: { lastSeen: 'now' } },
    },
    users: {
      realUser: { data: { email: 'admin@example.com', role: 'admin' } },
      // realUser has no marketingMaterials; a PHANTOM parent (no `data` key
      // at all) has one — this is exactly the scenario the brief calls out
      // (7 phantom parents in prod).
      phantomUser: {
        subcollections: {
          marketingMaterials: {
            doc1: { data: { note: 'legacy material' } },
          },
        },
      },
    },
    someUnknownThing: {
      x: { data: { whatever: true } },
    },
    productsPublic: {
      p1: { data: { name: 'Public product' } },
    },
    settings: {
      platform: { data: { defaultCommissionBps: 500 } },
      SdYOaQ7bqCrKT38V969d: { data: { legacy: true } },
    },
  };
}

function baseAuthUsers() {
  return [
    {
      uid: 'u1',
      email: 'admin@example.com',
      emailVerified: true,
      disabled: false,
      displayName: 'Admin',
      metadata: { creationTime: 'a', lastSignInTime: 'b' },
      providerData: [{ providerId: 'password' }],
      passwordHash: 'SHOULD_NEVER_APPEAR',
      passwordSalt: 'SHOULD_NEVER_APPEAR_EITHER',
      customClaims: { role: 'admin' },
      phoneNumber: '+46700000000',
      photoURL: 'https://example.com/photo.jpg',
    },
  ];
}

test('dry run (default) writes nothing to disk', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: false, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.equal(existsSync(outDir), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--apply writes a bundle; drop collections are counted but never read, and never written', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  const callLog = [];
  try {
    const schema = baseSchema();
    const db = new FakeFirestore(schema, callLog);
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z'), git: () => ({ sha: 'abc123', dirty: false }) });

    // adminPresence is a DROP collection: no directory written.
    assert.equal(existsSync(path.join(outDir, 'adminPresence')), false);

    // The fake logged a "get" (full data read) call scoped to adminPresence?
    const gotAdminPresenceData = callLog.some((c) => c.method === 'get' && c.collection === 'adminPresence');
    assert.equal(gotAdminPresenceData, false, 'drop collection adminPresence must never have get() called on it');
    const countedAdminPresence = callLog.some((c) => c.method === 'count' && c.collection === 'adminPresence');
    assert.ok(countedAdminPresence, 'drop collection adminPresence should still be counted');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('phantom parent: a subcollection under a missing parent document is exported', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    const partPath = path.join(outDir, 'users__marketingMaterials', 'part-00001.jsonl');
    assert.ok(existsSync(partPath), 'expected users__marketingMaterials to be written');
    const content = readFileSync(partPath, 'utf8');
    assert.match(content, /phantomUser/);
    assert.match(content, /legacy material/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unknown collection is exported with fate unknown and appears in the warnings', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    const result = await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.ok(result.warnings.some((w) => w.includes('someUnknownThing')));
    const item = result.plan.find((p) => p.name === 'someUnknownThing');
    assert.equal(item.fate, 'unknown');
    // and it was actually written since unknown != drop
    assert.ok(existsSync(path.join(outDir, 'someUnknownThing', 'part-00001.jsonl')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('verify-only projection (productsPublic) is written to _verify/, not to the archive part of the bundle', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.equal(existsSync(path.join(outDir, 'productsPublic')), false);
    const verifyFile = path.join(outDir, '_verify', 'productsPublic.jsonl');
    assert.ok(existsSync(verifyFile));
    assert.match(readFileSync(verifyFile, 'utf8'), /Public product/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('settings collection: exports the whole collection with per-document fate recorded', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'settings', 'manifest.json'), 'utf8'));
    assert.equal(manifest.documentCount, 2);
    assert.equal(manifest.perDocumentFate.platform, 'carry');
    assert.equal(manifest.perDocumentFate.SdYOaQ7bqCrKT38V969d, 'archive');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a manifest-named collection that is absent is reported as 0 (absent)', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    const result = await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: false, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    const shopsEntry = result.plan.find((p) => p.name === 'shops');
    assert.ok(shopsEntry);
    assert.equal(shopsEntry.absent, true);
    assert.equal(shopsEntry.docCount, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Auth allowlist: a user carrying passwordHash/passwordSalt/customClaims/phoneNumber/photoURL produces a line without them', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    const content = readFileSync(path.join(outDir, '_auth', 'users.jsonl'), 'utf8');
    assert.ok(!content.includes('SHOULD_NEVER_APPEAR'));
    assert.ok(!content.includes('phoneNumber'));
    assert.ok(!content.includes('photoURL'));
    assert.ok(!content.includes('customClaims'));
    assert.ok(!content.includes('+46700000000'));
    const parsed = JSON.parse(content.trim());
    assert.deepEqual(Object.keys(parsed).sort(), ['disabled', 'displayName', 'email', 'emailVerified', 'metadata', 'providerData', 'uid']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('pickAuthUserFields never copies forbidden fields even if present', () => {
  const picked = pickAuthUserFields({
    uid: 'x',
    email: 'a@example.com',
    passwordHash: 'nope',
    passwordSalt: 'nope',
    tokensValidAfterTime: 'nope',
    customClaims: { admin: true },
    phoneNumber: '123',
    photoURL: 'y',
    metadata: {},
    providerData: [],
  });
  assert.deepEqual(Object.keys(picked).sort(), ['disabled', 'displayName', 'email', 'emailVerified', 'metadata', 'providerData', 'uid']);
});

test('--out inside the repo is refused', () => {
  // assertOutsideRepo calls process.exit on refusal; stub it so the refusal
  // path can be asserted without actually terminating the test process.
  const insidePath = path.join(REPO_ROOT, 'some-export-dir');
  const originalExit = process.exit;
  let exited = false;
  process.exit = (code) => {
    exited = true;
    throw new Error(`process.exit(${code})`);
  };
  try {
    assert.throws(() => assertOutsideRepo(insidePath));
    assert.ok(exited);
  } finally {
    process.exit = originalExit;
  }
});

// REVIEW ROUND 1 FIX 7: symlink resolution. A symlink OUTSIDE the repo that
// points INTO the repo must be refused even though its literal path string
// does not mention the repo root.
test('fix 7: --out that is a symlink pointing INTO the repo is refused', () => {
  const base = tmpDir();
  const symlinkPath = path.join(base, 'sneaky-link');
  try {
    symlinkSync(REPO_ROOT, symlinkPath, 'dir');
    const outDirViaSymlink = path.join(symlinkPath, 'some-export-dir');
    const originalExit = process.exit;
    let exited = false;
    process.exit = (code) => {
      exited = true;
      throw new Error(`process.exit(${code})`);
    };
    try {
      assert.throws(() => assertOutsideRepo(outDirViaSymlink));
      assert.ok(exited, 'expected assertOutsideRepo to refuse a symlink into the repo');
    } finally {
      process.exit = originalExit;
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fix 7: --out that is a genuinely external symlink target is NOT refused', () => {
  const base = tmpDir();
  const externalTarget = tmpDir();
  const symlinkPath = path.join(base, 'external-link');
  try {
    symlinkSync(externalTarget, symlinkPath, 'dir');
    const outDirViaSymlink = path.join(symlinkPath, 'some-export-dir');
    // Should NOT throw / exit.
    assertOutsideRepo(outDirViaSymlink);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(externalTarget, { recursive: true, force: true });
  }
});

// Review round 1 answer to open question 4: a subprocess-level test for the
// --out repo refusal, matching the style of verify-bundle.test.mjs's CLI
// test (spawns the real `node export.mjs` process rather than calling the
// exported function directly), so the full CLI wiring — argument parsing →
// path resolution → refusal → exit code — is proven end to end, not just the
// underlying assertOutsideRepo() function in isolation.
test('CLI mode: --out pointing inside the repo is refused end-to-end, before touching firebase-admin', async () => {
  const { execFileSync } = await import('node:child_process');
  const scriptPath = path.resolve(REPO_ROOT, 'scripts/cf-port/migrate/export.mjs');
  const insideRepoOut = path.join(REPO_ROOT, 'cli-refusal-test-dir');
  let threw = false;
  try {
    execFileSync('node', [scriptPath, '--out', insideRepoOut, '--apply'], { encoding: 'utf8' });
  } catch (error) {
    threw = true;
    assert.equal(error.status, 1);
    assert.match(error.stderr, /EXPORT REFUSED.*resolves inside the repo root/);
    assert.ok(!existsSync(insideRepoOut), 'the refused --out directory must never be created');
  }
  assert.ok(threw, 'expected the CLI to exit non-zero');
});

test('an existing bundle directory is refused BEFORE any database walk (fix 7)', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  mkdirSync(outDir, { recursive: true });
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error('exit');
  };
  const callLog = [];
  try {
    const db = new FakeFirestore(baseSchema(), callLog);
    const auth = new FakeAuth(baseAuthUsers());
    await assert.rejects(() =>
      runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') }),
    );
    assert.equal(exitCode, 1);
    // fix 7: the refusal must happen BEFORE any collection listing/read.
    assert.equal(callLog.length, 0, 'expected NO database calls before the existing-bundle refusal');
  } finally {
    process.exit = originalExit;
    rmSync(base, { recursive: true, force: true });
  }
});

test('determinism: two exports of the same fake database with docs inserted in different order give identical SHA256SUMS', async () => {
  const base1 = tmpDir();
  const base2 = tmpDir();
  const outDir1 = path.join(base1, 'bundle');
  const outDir2 = path.join(base2, 'bundle');
  try {
    const schemaA = {
      collections: {
        b: { data: { title: 'B', handle: 'b' } },
        a: { data: { handle: 'a', title: 'A' } },
      },
    };
    const schemaB = {
      collections: {
        a: { data: { title: 'A', handle: 'a' } },
        b: { data: { handle: 'b', title: 'B' } },
      },
    };
    const db1 = new FakeFirestore(schemaA);
    const db2 = new FakeFirestore(schemaB);
    const auth1 = new FakeAuth([{ uid: 'u1', email: 'x@example.com', metadata: {}, providerData: [] }]);
    const auth2 = new FakeAuth([{ uid: 'u1', email: 'x@example.com', metadata: {}, providerData: [] }]);
    const fixedNow = () => new Date('2026-05-01T00:00:00.000Z');
    const fixedGit = () => ({ sha: 'fixed-sha', dirty: false });
    await runExport({ db: db1, auth: auth1, FieldPath: FakeFieldPath, outDir: outDir1, apply: true, only: null, now: fixedNow, git: fixedGit });
    await runExport({ db: db2, auth: auth2, FieldPath: FakeFieldPath, outDir: outDir2, apply: true, only: null, now: fixedNow, git: fixedGit });
    const sums1 = readFileSync(path.join(outDir1, 'SHA256SUMS'), 'utf8');
    const sums2 = readFileSync(path.join(outDir2, 'SHA256SUMS'), 'utf8');
    assert.equal(sums1, sums2);
  } finally {
    rmSync(base1, { recursive: true, force: true });
    rmSync(base2, { recursive: true, force: true });
  }
});

test('--only limits the export to the named collections', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: ['collections'], now: () => new Date('2026-01-01T00:00:00Z') });
    assert.ok(existsSync(path.join(outDir, 'collections')));
    assert.equal(existsSync(path.join(outDir, 'someUnknownThing')), false);
    assert.equal(existsSync(path.join(outDir, 'settings')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('parseArgs parses --out, --apply, --only', () => {
  const parsed = parseArgs(['--out', '/tmp/x', '--apply', '--only', 'a,b,c']);
  assert.equal(parsed.out, '/tmp/x');
  assert.equal(parsed.apply, true);
  assert.deepEqual(parsed.only, ['a', 'b', 'c']);
});

// ── Review round 1, fix 6 ───────────────────────────────────────────────────

test('fix 6: dry run reads counts only — get() on a document query is never called for any collection', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  const callLog = [];
  try {
    const db = new FakeFirestore(baseSchema(), callLog);
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: false, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    const gotCalls = callLog.filter((c) => c.method === 'get');
    assert.deepEqual(gotCalls, [], `expected no get() calls in a dry run, saw: ${JSON.stringify(gotCalls)}`);
    // but count() calls DID happen (the dry run still needs counts).
    const countCalls = callLog.filter((c) => c.method === 'count');
    assert.ok(countCalls.length > 0, 'expected count() calls in a dry run');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fix 6: dry run still reports correct counts (including subcollections) without reading data', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    const result = await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: false, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    const usersEntry = result.plan.find((p) => p.name === 'users');
    // 2, not 1: realUser (has `data`) + phantomUser (no `data`, exists only
    // because it holds a subcollection) — count() sees both doc keys.
    assert.equal(usersEntry.docCount, 2);
    const marketingEntry = result.plan.find((p) => p.name === 'users__marketingMaterials');
    assert.ok(marketingEntry, 'expected the phantom-parent subcollection to be counted in the dry run too');
    assert.equal(marketingEntry.docCount, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── Review round 1, fix 4 ───────────────────────────────────────────────────

test('fix 4: an unknown subcollection under a KNOWN collection is exported and warned about', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const schema = baseSchema();
    // `shops` is a known top-level collection (fate carry); give it a
    // subcollection the manifest does NOT name.
    schema.shops = {
      s1: {
        data: { name: 'Test Shop' },
        subcollections: {
          mysterySubcollection: {
            m1: { data: { note: 'not in the manifest' } },
          },
        },
      },
    };
    const db = new FakeFirestore(schema);
    const auth = new FakeAuth(baseAuthUsers());
    const result = await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.ok(result.warnings.some((w) => w.includes('shops__mysterySubcollection')), `warnings: ${JSON.stringify(result.warnings)}`);
    const partPath = path.join(outDir, 'shops__mysterySubcollection', 'part-00001.jsonl');
    assert.ok(existsSync(partPath));
    assert.match(readFileSync(partPath, 'utf8'), /not in the manifest/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fix 4: an unknown subcollection under a PHANTOM parent is exported', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const schema = baseSchema();
    schema.shops = {
      // s1 has NO `data` key: a phantom parent, discovered only via
      // listDocuments() because it holds a subcollection.
      s1: {
        subcollections: {
          weirdStuff: {
            w1: { data: { note: 'under a phantom shop' } },
          },
        },
      },
    };
    const db = new FakeFirestore(schema);
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    const partPath = path.join(outDir, 'shops__weirdStuff', 'part-00001.jsonl');
    assert.ok(existsSync(partPath));
    const content = readFileSync(partPath, 'utf8');
    assert.match(content, /shops\/s1\/weirdStuff/);
    assert.match(content, /under a phantom shop/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fix 4: a second-level subcollection (a subcollection under a subcollection document) is exported', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const schema = baseSchema();
    schema.shops = {
      s1: {
        data: { name: 'Test Shop' },
        subcollections: {
          orders: {
            o1: {
              data: { total: 100 },
              subcollections: {
                lineItems: {
                  li1: { data: { sku: 'ABC' } },
                },
              },
            },
          },
        },
      },
    };
    const db = new FakeFirestore(schema);
    const auth = new FakeAuth(baseAuthUsers());
    const result = await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    // level 1: shops__orders
    assert.ok(existsSync(path.join(outDir, 'shops__orders', 'part-00001.jsonl')));
    // level 2: shops__orders__lineItems
    const level2Path = path.join(outDir, 'shops__orders__lineItems', 'part-00001.jsonl');
    assert.ok(existsSync(level2Path), 'expected a 2nd-level subcollection to be exported');
    const content = readFileSync(level2Path, 'utf8');
    assert.match(content, /shops\/s1\/orders\/o1\/lineItems\/li1/);
    assert.match(content, /"sku":"ABC"/);
    assert.ok(result.warnings.every((w) => !w.includes('lineItems') || w.includes('unknown subcollection')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fix 4: a third-level subcollection produces a loud warning and is NOT read/exported', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const schema = baseSchema();
    schema.shops = {
      s1: {
        data: { name: 'Test Shop' },
        subcollections: {
          orders: {
            o1: {
              data: { total: 100 },
              subcollections: {
                lineItems: {
                  li1: {
                    data: { sku: 'ABC' },
                    subcollections: {
                      tooDeep: {
                        td1: { data: { secret: 'SHOULD_NEVER_APPEAR_ANYWHERE' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const db = new FakeFirestore(schema);
    const auth = new FakeAuth(baseAuthUsers());
    const result = await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    // The 3rd level must be named in a warning...
    assert.ok(
      result.warnings.some((w) => w.includes('shops/s1/orders/o1/lineItems/li1/tooDeep')),
      `warnings: ${JSON.stringify(result.warnings)}`,
    );
    // ...but NEVER written anywhere, and its data never appears in the bundle.
    assert.equal(existsSync(path.join(outDir, 'shops__orders__lineItems__tooDeep')), false);
    const allFilesContent = [
      readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
      readFileSync(path.join(outDir, 'shops__orders__lineItems', 'part-00001.jsonl'), 'utf8'),
    ].join('\n');
    assert.ok(!allFilesContent.includes('SHOULD_NEVER_APPEAR_ANYWHERE'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fix 4: subcollection discovery uses bounded concurrency (mapWithConcurrency correctness)', async () => {
  const seen = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);
  await mapWithConcurrency(items, 5, async (item) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 1));
    concurrent -= 1;
    seen.push(item);
  });
  assert.equal(seen.length, 50);
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
  assert.ok(maxConcurrent <= 5, `expected at most 5 concurrent, saw ${maxConcurrent}`);
  assert.ok(maxConcurrent > 1, 'expected some actual concurrency, not serial execution');
});

// ── Review round 1, fix 3 ───────────────────────────────────────────────────

test('fix 3: a collection that gains a document between the read and the re-count produces a named warning', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const schema = baseSchema();
    const db = new FakeFirestore(schema);
    // Simulate a write racing the export: as soon as the WRITE phase begins
    // (i.e. after the read that populates the bundle has already happened),
    // mutate the underlying schema so any FRESH count() call — exactly what
    // the fix 3 re-count issues after the bundle is written — sees one more
    // document than the read saw. Patched onto db.collection so it affects
    // every FakeCollectionRef made for 'collections' from this point on,
    // regardless of how it's chained (.orderBy/.limit/.startAfter/.count all
    // read the same live `schema` object, so mutating schema is sufficient
    // and does not depend on intercepting any particular chained call).
    const originalCollection = db.collection.bind(db);
    db.collection = (name) => {
      const ref = originalCollection(name);
      if (name !== 'collections') return ref;
      const originalCount = ref.count.bind(ref);
      ref.count = () => {
        // The mutation happens lazily, the FIRST time count() is invoked for
        // 'collections' — which in this export only happens during the
        // fix-3 live re-count phase (the read phase uses .get(), not
        // .count()), so this reliably simulates "changed after the read".
        if (schema.collections.c2 === undefined) {
          schema.collections.c2 = { data: { title: 'Added after the read', handle: 'added-after' } };
        }
        return originalCount();
      };
      return ref;
    };
    const auth = new FakeAuth(baseAuthUsers());
    const result = await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.ok(
      result.consistencyWarnings.some((w) => w.includes('collections') && w.includes('live re-count')),
      `expected a live re-count mismatch warning, got: ${JSON.stringify(result.consistencyWarnings)}`,
    );
    const recountEntry = result.recounts.find((r) => r.name === 'collections');
    assert.ok(recountEntry);
    assert.equal(recountEntry.written, 1);
    assert.equal(recountEntry.recount, 2);
    assert.equal(recountEntry.match, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fix 3: an unchanged collection re-counts as a match, with no warning', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    const result = await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    const recountEntry = result.recounts.find((r) => r.name === 'collections');
    assert.ok(recountEntry);
    assert.equal(recountEntry.match, true);
    assert.equal(result.consistencyWarnings.length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── Review round 1, fix 5 ───────────────────────────────────────────────────

test('fix 5: PROJECT_ID is exported and pinned to the manifest project id', () => {
  assert.equal(PROJECT_ID, 'b8shield-reseller-app');
});

test('fix 5: main() refuses to run when GOOGLE_CLOUD_PROJECT is set to a different project, BEFORE loading firebase-admin', async () => {
  const { execFileSync } = await import('node:child_process');
  const scriptPath = path.resolve(REPO_ROOT, 'scripts/cf-port/migrate/export.mjs');
  let threw = false;
  try {
    execFileSync('node', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, GOOGLE_CLOUD_PROJECT: 'some-other-project' },
    });
  } catch (error) {
    threw = true;
    assert.equal(error.status, 1);
    assert.match(error.stderr, /GOOGLE_CLOUD_PROJECT is set to "some-other-project"/);
    // Confirm it never got as far as trying to load firebase-admin (which
    // would fail with a MODULE_NOT_FOUND-shaped error instead, if this ran
    // outside a checkout with functions/node_modules present, or would hang
    // trying to reach a real project if it did find it).
    assert.ok(!error.stderr.includes('firebase-admin'), error.stderr);
  }
  assert.ok(threw, 'expected the process to exit non-zero');
});

// ── Review round 1, open question answer 2 ─────────────────────────────────

test("open question 2: the root manifest records _maps/user-id-map.json and _storage/storage-manifest.jsonl as notIncluded, and neither file is written", async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'bundle');
  try {
    const db = new FakeFirestore(baseSchema());
    const auth = new FakeAuth(baseAuthUsers());
    await runExport({ db, auth, FieldPath: FakeFieldPath, outDir, apply: true, only: null, now: () => new Date('2026-01-01T00:00:00Z') });
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.notIncluded['_maps/user-id-map.json']);
    assert.ok(manifest.notIncluded['_storage/storage-manifest.jsonl']);
    assert.equal(existsSync(path.join(outDir, '_maps')), false);
    assert.equal(existsSync(path.join(outDir, '_storage')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
