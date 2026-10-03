import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ACTING_AS_REASON,
  checkPages,
  loadLegalSources,
  PAGE_KEYS,
  parseArgs,
  platformTermsText,
  PUBLISHED_FILE,
  reviewAdminEmail,
  runStagingLegal,
  seededTermsSha256,
  STAGING_RETURN_ADDRESS,
} from '../../staging-legal.mjs';
import { RefusedError, REPO_ROOT } from '../lib/api-session.mjs';
import { startFakeStagingApi, writeTestBundle } from './fake-staging-api.mjs';

const REVIEW_PASSWORD = 'review-password-123';
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function world({ terms, tenants, users = [] } = {}) {
  const sources = await loadLegalSources();
  const termsText = platformTermsText(sources.terms);
  const api = await startFakeStagingApi({
    tenants: tenants ?? {
      'shop-a': { published: false },
      'shop-b': { published: true, returnAddress: 'Test Returns 1, 111 11 Teststad', vatRegistered: true },
      'shop-c': { published: false },
    },
    terms: terms ?? [{ publishedAt: '2026-09-07T00:00:00.000Z', sha256: sha(termsText), text: null, version: sources.terms.PLATFORM_TERMS_VERSION }],
  });
  for (const user of users) api.state.users.set(user.email, user);
  const dir = mkdtempSync(path.join(tmpdir(), 'staging-legal-'));
  const bundle = path.join(dir, 'bundle');
  writeTestBundle(bundle, {
    shops: [
      { data: { features: { pod: true }, published: false, storeIdentity: { shopName: 'Test Shop A' } }, id: 'shop-a' },
      {
        data: {
          features: { pod: false },
          storeIdentity: { returnAddress: 'Test Returns 1, 111 11 Teststad', sellerType: 'company', shopName: 'Test Shop B', vatRegistered: true },
        },
        id: 'shop-b',
      },
      { data: { published: false, storeIdentity: { shopName: 'Test Shop C' } }, id: 'shop-c' },
    ],
  });
  const lines = [];
  const deps = {
    apiOrigin: api.origin,
    credentials: { email: api.state.platformUser.email, password: api.state.platformUser.password },
    environment: { CHOPSHOP_REVIEW_ADMIN_PASSWORD: REVIEW_PASSWORD },
    log: (line) => lines.push(line),
    secretsFile: path.join(dir, 'no-secrets.env'),
    sleep: async () => {},
  };
  const args = { bundle, dryRun: false, env: 'staging', out: path.join(dir, 'out'), publish: false, shop: null, unpublish: false };
  return {
    api,
    args,
    close: async () => {
      await api.close();
      rmSync(dir, { force: true, recursive: true });
    },
    deps,
    lines,
    sources,
    termsText,
  };
}

test('parseArgs: modes and their options', () => {
  assert.throws(() => parseArgs(['--out', 'o', '--bundle', 'b']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--bundle', 'b']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--out', 'o']), /--bundle is required/);
  assert.throws(() => parseArgs(['--env', 'staging', '--out', 'o', '--unpublish-after-review', '--publish-for-review']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--out', 'o', '--unpublish-after-review', '--bundle', 'b']), RefusedError);
  assert.equal(parseArgs(['--env', 'staging', '--out', 'o', '--unpublish-after-review']).unpublish, true);
  assert.equal(parseArgs(['--env', 'staging', '--out', 'o', '--bundle', 'b', '--publish-for-review']).publish, true);
});

test('the terms text is the one 0031 seeded', async () => {
  const sources = await loadLegalSources();
  const seeded = seededTermsSha256(sources.terms.PLATFORM_TERMS_VERSION);
  assert.match(seeded, /^[0-9a-f]{64}$/);
  assert.equal(sha(platformTermsText(sources.terms)), seeded);
  const parsed = JSON.parse(platformTermsText(sources.terms));
  assert.deepEqual(Object.keys(parsed), ['version', 'terms', 'dpa']);
});

test('the pages are the source renderer\'s, and every one passes the Worker\'s checkHtml', async () => {
  const sources = await loadLegalSources();
  const direct = sources.render.renderLegalPage('legal/kopvillkor', { shopName: 'Test Shop' }, { pod: true }).html;
  assert.match(direct, /^<h1>Köpvillkor – Test Shop<\/h1>/);
  for (const pod of [true, false]) {
    for (const identity of [{}, { sellerType: 'company', shopName: 'Test <Shop> & Co', vatRegistered: true }]) {
      const pages = Object.fromEntries(
        PAGE_KEYS.map((key) => [key, sources.render.renderLegalPage(sources.templates.LEGAL_SLUG_BY_KEY[key], identity, { pod }).html]),
      );
      assert.deepEqual(checkPages(sources, pages), []);
    }
  }
  assert.deepEqual(checkPages(sources, { angerratt: '<p>x</p>', integritetspolicy: '', kopvillkor: '<script>x</script>' }), [
    'kopvillkor:' + sources.checkHtml('<script>x</script>').reason,
    'integritetspolicy:empty',
  ]);
});

test('refuses an output directory inside the repository', async () => {
  const w = await world();
  try {
    await assert.rejects(runStagingLegal({ ...w.args, out: path.join(REPO_ROOT, 'legal-out') }, w.deps), RefusedError);
    assert.equal(w.api.state.log.length, 0);
  } finally {
    await w.close();
  }
});

test('--dry-run makes no request', async () => {
  const w = await world();
  try {
    const result = await runStagingLegal({ ...w.args, dryRun: true, publish: true }, w.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(w.api.state.log.length, 0);
    assert.equal(existsSync(w.args.out), false);
    assert.ok(w.lines.some((line) => line.includes('equal to the hash 0031 seeded')));
    assert.ok(w.lines.some((line) => line.includes('shop-a') && line.includes('would publish for review')));
  } finally {
    await w.close();
  }
});

test('archives the terms text, completes the readiness, adopts the pages as the review admin', async () => {
  const w = await world();
  try {
    const result = await runStagingLegal(w.args, w.deps);
    assert.deepEqual(result.problems, []);
    assert.equal(result.exitCode, 0);

    assert.equal(w.api.state.terms[0].text, w.termsText, 'the terms text is archived as it hashes');

    // shop-a: settings written under acting-as, pages adopted by its review admin.
    const tenantA = w.api.state.tenants.get('shop-a');
    assert.equal(tenantA.settings.returnAddress, STAGING_RETURN_ADDRESS);
    assert.equal(tenantA.settings.vatRegistered, false);
    const acceptanceA = w.api.state.acceptances.find((a) => a.tenantId === 'shop-a');
    assert.equal(acceptanceA.pod, true);
    assert.equal(acceptanceA.custom, false);
    assert.equal(acceptanceA.templateVersion, w.sources.templates.LEGAL_TEMPLATE_VERSION);
    assert.deepEqual(Object.keys(acceptanceA.texts).sort(), ['angerratt', 'integritetspolicy', 'kopvillkor']);
    assert.ok(acceptanceA.texts.angerratt.includes('platshållare'), 'the page shows the placeholder return address');
    const reviewer = w.api.state.users.get(reviewAdminEmail('shop-a'));
    assert.equal(acceptanceA.userId, reviewer.id, 'signed by the review admin, not the platform user');
    assert.ok(w.api.state.memberships.has(`${reviewer.id}\nshop-a`));

    // shop-b already had its settings: only the pages, with its own identity.
    const acceptanceB = w.api.state.acceptances.find((a) => a.tenantId === 'shop-b');
    assert.equal(acceptanceB.pod, false);
    assert.ok(acceptanceB.texts.angerratt.includes('Test Returns 1'));
    assert.equal(w.api.state.tenants.get('shop-b').settings.returnAddress, 'Test Returns 1, 111 11 Teststad');

    // The settings PUT is an acting-as request; the grant reason names the review.
    const settingsPuts = w.api.state.log.filter((entry) => entry.path === '/v1/admin/settings' && entry.method === 'PUT');
    assert.equal(settingsPuts.length, 2); // shop-a, shop-c
    assert.ok(settingsPuts.every((entry) => entry.shop !== null && entry.origin === w.api.origin));
    const grants = w.api.state.audit.filter((a) => a.action === 'acting_as.granted');
    assert.equal(grants.length, 3);
    assert.ok(grants.every((a) => a.reason === ACTING_AS_REASON));
    // Platform routes never carry X-Shop-Id.
    const platformCalls = w.api.state.log.filter((entry) => entry.path.startsWith('/v1/platform/'));
    assert.ok(platformCalls.every((entry) => entry.shop === null));
    // Nothing published without the flag.
    assert.equal(w.api.state.tenants.get('shop-a').published, false);
    // No text, password or cookie in the output.
    const output = w.lines.join('\n');
    assert.ok(!output.includes(REVIEW_PASSWORD) && !output.includes('Test Shop') && !output.includes('session='));
  } finally {
    await w.close();
  }
});

test('a second run finds everything done and adopts nothing again', async () => {
  const w = await world();
  try {
    await runStagingLegal(w.args, w.deps);
    const again = await runStagingLegal(w.args, w.deps);
    assert.equal(again.exitCode, 0);
    assert.equal(w.api.state.acceptances.length, 3);
    assert.ok(w.lines.some((line) => line.includes('text already archived')));
  } finally {
    await w.close();
  }
});

test('a terms version whose hash is not the template text is not archived', async () => {
  const w = await world({ terms: [{ publishedAt: '2026-09-07T00:00:00.000Z', sha256: 'a'.repeat(64), text: null, version: '2026-09-07' }] });
  try {
    const result = await runStagingLegal({ ...w.args, shop: 'shop-b' }, w.deps);
    assert.equal(result.exitCode, 1);
    assert.ok(result.problems.some((p) => p.includes('does not hash')));
    assert.equal(w.api.state.log.filter((entry) => entry.method === 'PUT' && entry.path.includes('terms-versions')).length, 0);
  } finally {
    await w.close();
  }
});

test('without a review admin password nothing is adopted and the run says why', async () => {
  const w = await world();
  try {
    const result = await runStagingLegal({ ...w.args, shop: 'shop-a' }, { ...w.deps, environment: {} });
    assert.equal(result.exitCode, 1);
    assert.ok(result.problems.some((p) => p.includes('review admin password')));
    assert.equal(w.api.state.acceptances.length, 0);
  } finally {
    await w.close();
  }
});

test('a run that set the placeholder address and stopped before the adoption is carried on with the address staging holds', async () => {
  const w = await world();
  try {
    const stopped = await runStagingLegal({ ...w.args, shop: 'shop-a' }, { ...w.deps, environment: {} });
    assert.equal(stopped.exitCode, 1);
    assert.equal(w.api.state.tenants.get('shop-a').settings.returnAddress, STAGING_RETURN_ADDRESS, 'the first run set the address');
    assert.equal(w.api.state.acceptances.length, 0);

    const result = await runStagingLegal({ ...w.args, shop: 'shop-a' }, w.deps);
    assert.deepEqual(result.problems, []);
    const adopted = w.api.state.acceptances.find((a) => a.tenantId === 'shop-a');
    assert.ok(adopted.texts.angerratt.includes('platshållare'), 'the adopted page shows the address staging holds');
    assert.ok(!Object.values(adopted.texts).some((text) => text.includes('⚠️')), 'no page says an answer is missing');
  } finally {
    await w.close();
  }
});

test('an existing review admin with another password is reported, not worked around', async () => {
  const w = await world({
    users: [{ accountType: 'tenant_admin', email: reviewAdminEmail('shop-a'), id: 'old-reviewer', password: 'another-password-9' }],
  });
  try {
    const result = await runStagingLegal({ ...w.args, shop: 'shop-a' }, w.deps);
    assert.equal(result.exitCode, 1);
    assert.ok(result.problems.some((p) => p.includes('review admin sign-in failed')));
    assert.equal(w.api.state.acceptances.length, 0);
  } finally {
    await w.close();
  }
});

test('a shop of the bundle that staging does not hold is skipped and reported', async () => {
  const w = await world({ tenants: { 'shop-b': { returnAddress: 'x', vatRegistered: true } } });
  try {
    const result = await runStagingLegal(w.args, w.deps);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.problems.filter((p) => p.includes('acting-as')).sort(), ['shop-a: acting-as refused', 'shop-c: acting-as refused']);
    assert.ok(w.lines.some((line) => line.includes('shop-a') && line.includes('not a shop on staging')));
  } finally {
    await w.close();
  }
});

test('--publish-for-review publishes exactly the shops unpublished in the source and on staging; --unpublish-after-review hides exactly those', async () => {
  const w = await world({
    tenants: {
      'shop-a': { published: false },
      'shop-b': { published: true, returnAddress: 'x', vatRegistered: true },
      'shop-c': { published: true }, // unpublished in the source, already published on staging
    },
  });
  try {
    const result = await runStagingLegal({ ...w.args, publish: true }, w.deps);
    assert.equal(result.exitCode, 0);
    const file = path.join(w.args.out, PUBLISHED_FILE);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tenants, ['shop-a']);
    assert.equal(w.api.state.tenants.get('shop-a').published, true);
    const publishes = w.api.state.log.filter((entry) => entry.path.endsWith('/publish'));
    assert.deepEqual(publishes.map((entry) => entry.path), ['/v1/platform/tenants/shop-a/publish']);

    const back = await runStagingLegal({ env: 'staging', out: w.args.out, unpublish: true, dryRun: false }, w.deps);
    assert.equal(back.exitCode, 0);
    assert.equal(w.api.state.tenants.get('shop-a').published, false);
    assert.equal(w.api.state.tenants.get('shop-c').published, true, 'a shop this step did not publish stays as it was');
    assert.equal(existsSync(file), false);
    await assert.rejects(runStagingLegal({ env: 'staging', out: w.args.out, unpublish: true, dryRun: false }, w.deps), /nothing was published/);
  } finally {
    await w.close();
  }
});

test('a publish whose answer is lost is in the file all the same, and --unpublish-after-review hides the shop', async () => {
  const w = await world();
  try {
    w.api.state.faults.push({ afterEffect: true, method: 'POST', path: /\/shop-a\/publish$/, status: 502, times: 1 });
    const result = await runStagingLegal({ ...w.args, publish: true }, w.deps);
    assert.equal(result.exitCode, 1);
    assert.ok(result.problems.some((p) => p.includes('publish: shop-a HTTP 502')));
    assert.equal(w.api.state.tenants.get('shop-a').published, true, 'the publish happened; only its answer was lost');
    const file = path.join(w.args.out, PUBLISHED_FILE);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tenants, ['shop-a', 'shop-c']);

    // The next run finds it published and keeps it listed.
    const again = await runStagingLegal({ ...w.args, publish: true }, w.deps);
    assert.equal(again.exitCode, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tenants, ['shop-a', 'shop-c']);

    const back = await runStagingLegal({ env: 'staging', out: w.args.out, unpublish: true, dryRun: false }, w.deps);
    assert.equal(back.exitCode, 0);
    assert.equal(w.api.state.tenants.get('shop-a').published, false);
    assert.equal(w.api.state.tenants.get('shop-c').published, false);
  } finally {
    await w.close();
  }
});

test('an unpublish that fails keeps the shop in the file for the next run', async () => {
  const w = await world();
  try {
    await runStagingLegal({ ...w.args, publish: true }, w.deps);
    const file = path.join(w.args.out, PUBLISHED_FILE);
    const listed = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...listed, tenants: [...listed.tenants, 'gone-shop'] }));
    const back = await runStagingLegal({ env: 'staging', out: w.args.out, unpublish: true, dryRun: false }, w.deps);
    assert.equal(back.exitCode, 1);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tenants, ['gone-shop']);
  } finally {
    await w.close();
  }
});
