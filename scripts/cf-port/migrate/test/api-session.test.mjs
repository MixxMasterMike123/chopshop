import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  apiTarget,
  confirmationProblem,
  createApiSession,
  credentialsFor,
  parseEnvFile,
  platformCredentials,
  preflight,
  productionCredentials,
  productionTarget,
  RefusedError,
  REPO_ROOT,
  secretValue,
  stagingTarget,
} from '../lib/api-session.mjs';
import { startFakeStagingApi } from './fake-staging-api.mjs';

const PINNED_API = JSON.parse(readFileSync(path.join(REPO_ROOT, 'cloudflare/pinned.staging.json'), 'utf8')).origins.api;

test('stagingTarget: production and anything but staging are refused; the origin is the pinned one', () => {
  assert.throws(() => stagingTarget({ env: 'production', environment: {} }), /production is refused/);
  assert.throws(() => stagingTarget({ env: 'prod', environment: {} }), RefusedError);
  assert.throws(() => stagingTarget({ env: undefined, environment: {} }), RefusedError);
  assert.equal(stagingTarget({ env: 'staging', environment: {} }).apiOrigin, new URL(PINNED_API).origin);
  assert.equal(stagingTarget({ env: 'staging', environment: { CHOPSHOP_API_URL: PINNED_API } }).apiOrigin, new URL(PINNED_API).origin);
  assert.throws(
    () => stagingTarget({ env: 'staging', environment: { CHOPSHOP_API_URL: 'https://api.example.test' } }),
    /not the pinned staging/,
  );
  assert.throws(() => stagingTarget({ env: 'staging', environment: { CHOPSHOP_API_URL: 'nope' } }), /not a URL/);
});

test('parseEnvFile and the secrets fallback', () => {
  assert.deepEqual(parseEnvFile('# c\nA=1\nexport B="two"\nC=\'3\'\nnot a line\n\n'), { A: '1', B: 'two', C: '3' });
  const dir = mkdtempSync(path.join(tmpdir(), 'api-session-'));
  try {
    const file = path.join(dir, 'secrets.env');
    writeFileSync(file, 'PLATFORM_ADMIN_PASSWORD=from-file-password\n');
    assert.equal(secretValue(['X', 'PLATFORM_ADMIN_PASSWORD'], { environment: {}, secretsFile: file }), 'from-file-password');
    assert.equal(secretValue(['X'], { environment: { X: 'env' }, secretsFile: file }), 'env');
    assert.equal(secretValue(['Y'], { environment: {}, secretsFile: path.join(dir, 'absent') }), null);
    assert.deepEqual(platformCredentials({ environment: { CHOPSHOP_PLATFORM_EMAIL: 'p@example.com' }, secretsFile: file }), {
      email: 'p@example.com',
      password: 'from-file-password',
    });
    assert.throws(() => platformCredentials({ environment: {}, secretsFile: file }), /CHOPSHOP_PLATFORM_EMAIL/);
    assert.throws(
      () => platformCredentials({ environment: { CHOPSHOP_PLATFORM_EMAIL: 'p@example.com' }, secretsFile: path.join(dir, 'absent') }),
      /no platform password/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('sign-in keeps the cookie; a wrong password is refused without echoing it', async () => {
  const api = await startFakeStagingApi({ tenants: { 's1': {} } });
  try {
    const session = createApiSession({ apiOrigin: api.origin });
    await assert.rejects(session.signIn({ email: api.state.platformUser.email, password: 'wrong-password-x' }), (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes('wrong-password-x'));
      return true;
    });
    await session.signIn({ email: api.state.platformUser.email, password: api.state.platformUser.password });
    await session.ensureActingAs('s1', 'test reason');
    await session.ensureActingAs('s1', 'test reason');
    const grants = api.state.log.filter((entry) => entry.path.endsWith('/acting-as'));
    assert.equal(grants.length, 1, 'a live grant is kept, not minted again');
    assert.equal(grants[0].shop, null);
    const status = await session.request('GET', '/v1/admin/legal/status', { shop: 's1' });
    assert.equal(status.status, 200);
    await assert.rejects(session.ensureActingAs('unknown-shop', 'x'), /acting-as unknown-shop: HTTP 404/);
    assert.equal(await session.endActingAs('s1'), 204);
  } finally {
    await api.close();
  }
});

test('a grant close to its end is renewed', async () => {
  const api = await startFakeStagingApi({ tenants: { 's1': {} } });
  try {
    let clock = Date.now();
    const session = createApiSession({ apiOrigin: api.origin, now: () => clock });
    await session.signIn({ email: api.state.platformUser.email, password: api.state.platformUser.password });
    await session.ensureActingAs('s1', 'r');
    clock += 55 * 60 * 1_000;
    assert.deepEqual(await session.ensureActingAs('s1', 'r'), { renewed: true });
  } finally {
    await api.close();
  }
});

test('429 waits for Retry-After (bounded), then answers', async () => {
  const api = await startFakeStagingApi({
    faults: [{ method: 'GET', path: /^\/health$/, retryAfter: 3, status: 429, times: 2 }],
  });
  try {
    const sleeps = [];
    const session = createApiSession({ apiOrigin: api.origin, sleep: async (ms) => sleeps.push(ms) });
    const health = await session.request('GET', '/health', { anonymous: true });
    assert.equal(health.status, 200);
    assert.deepEqual(sleeps, [3_000, 3_000]);
    assert.equal(session.stats.rateLimitWaits, 2);
  } finally {
    await api.close();
  }
});

test('a sign-in the rate limit answers is tried again after Retry-After, for both identities', async () => {
  const api = await startFakeStagingApi({
    faults: [{ method: 'POST', path: /^\/api\/auth\/sign-in\/email$/, retryAfter: 45, status: 429, times: 2 }],
  });
  try {
    const sleeps = [];
    const session = createApiSession({ apiOrigin: api.origin, sleep: async (ms) => sleeps.push(ms) });
    const { email, password } = api.state.platformUser;
    assert.equal((await session.signIn({ email, password })).userId, api.state.platformUser.id);
    assert.deepEqual(sleeps, [45_000, 45_000]);
    assert.equal(session.stats.rateLimitWaits, 2);
    // A limit that never lifts is refused, not waited on for ever.
    api.state.faults.push({ method: 'POST', path: /sign-in/, retryAfter: 1, status: 429, times: 99 });
    await assert.rejects(session.signInAs({ email, password }), /sign-in failed: HTTP 429/);
  } finally {
    await api.close();
  }
});

test('preflight: /health must say staging and /ready must be on the migration or later', async () => {
  const old = await startFakeStagingApi({ migration: '0036_old' });
  const fresh = await startFakeStagingApi({ migration: '0042_new' });
  try {
    await assert.rejects(preflight(createApiSession({ apiOrigin: old.origin }), { requiredMigration: '0039' }), /0039/);
    assert.deepEqual(await preflight(createApiSession({ apiOrigin: fresh.origin }), { requiredMigration: '0039' }), {
      migration: '0042_new',
    });
  } finally {
    await old.close();
    await fresh.close();
  }
});

test('a timeout is reported as a timeout', async () => {
  const session = createApiSession({
    apiOrigin: 'http://127.0.0.1:9',
    fetchImpl: async () => {
      const error = new Error('t');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  await assert.rejects(session.request('GET', '/health'), (error) => error.code === 'timeout');
});

// ── production (CP7-T1) ─────────────────────────────────────────────────────

const CONFIRM_REFUSAL = '--env production needs --confirm production (the explicit confirmation of a production run)';

/** A repository root holding only cloudflare/pinned.production.json (never the real file, which is only read). */
function repoWithPins(pinned) {
  const root = mkdtempSync(path.join(tmpdir(), 'api-session-repo-'));
  mkdirSync(path.join(root, 'cloudflare'));
  if (pinned !== undefined) writeFileSync(path.join(root, 'cloudflare', 'pinned.production.json'), JSON.stringify(pinned));
  return root;
}

test('productionTarget: --confirm production, then the pinned origin, refused while it is null', () => {
  const ok = repoWithPins({ origins: { admin: null, api: 'https://api.example.test/', web: null } });
  const missing = repoWithPins(undefined);
  const nullOrigin = repoWithPins({ origins: { admin: null, api: null, web: null } });
  const noOrigins = repoWithPins({});
  const notUrl = repoWithPins({ origins: { api: 'nope' } });
  try {
    for (const confirm of [undefined, null, '', 'yes', 'Production']) {
      assert.throws(() => productionTarget({ confirm, environment: {}, repoRoot: ok }), (error) => error instanceof RefusedError && error.message === CONFIRM_REFUSAL);
    }
    assert.throws(() => productionTarget({ confirm: 'production', environment: {}, repoRoot: missing }), (error) => error.message === 'cloudflare/pinned.production.json does not exist');
    for (const root of [nullOrigin, noOrigins]) {
      assert.throws(
        () => productionTarget({ confirm: 'production', environment: {}, repoRoot: root }),
        (error) => error.message === 'cloudflare/pinned.production.json origins.api is null: production has no pinned API origin yet',
      );
    }
    assert.throws(() => productionTarget({ confirm: 'production', environment: {}, repoRoot: notUrl }), /origins\.api is not a URL/);
    assert.equal(productionTarget({ confirm: 'production', environment: {}, repoRoot: ok }).apiOrigin, 'https://api.example.test');
    assert.equal(productionTarget({ confirm: 'production', environment: { CHOPSHOP_API_URL: 'https://api.example.test' }, repoRoot: ok }).apiOrigin, 'https://api.example.test');
    assert.throws(
      () => productionTarget({ confirm: 'production', environment: { CHOPSHOP_API_URL: PINNED_API }, repoRoot: ok }),
      (error) => error.message === 'CHOPSHOP_API_URL is not the pinned production API origin',
    );
    assert.throws(() => productionTarget({ confirm: 'production', environment: { CHOPSHOP_API_URL: 'nope' }, repoRoot: ok }), /CHOPSHOP_API_URL is not a URL/);
  } finally {
    for (const root of [ok, missing, nullOrigin, noOrigins, notUrl]) rmSync(root, { force: true, recursive: true });
  }
});

test('productionTarget on the real pinned file (read only): its origin, or the refusal that names the null pin', () => {
  const pinned = JSON.parse(readFileSync(path.join(REPO_ROOT, 'cloudflare/pinned.production.json'), 'utf8'));
  if (pinned.origins?.api === null) {
    assert.throws(() => productionTarget({ confirm: 'production', environment: {} }), /origins\.api is null/);
  } else {
    assert.equal(productionTarget({ confirm: 'production', environment: {} }).apiOrigin, new URL(pinned.origins.api).origin);
  }
  assert.throws(() => productionTarget({ environment: {} }), (error) => error.message === CONFIRM_REFUSAL);
});

test('apiTarget: staging as before, production by productionTarget, --confirm only with production', () => {
  assert.equal(apiTarget({ env: 'staging', environment: {} }).apiOrigin, new URL(PINNED_API).origin);
  assert.throws(() => apiTarget({ confirm: 'production', env: 'staging', environment: {} }), (error) => error.message === '--confirm production belongs to --env production only');
  assert.throws(() => apiTarget({ env: 'production', environment: {} }), (error) => error.message === CONFIRM_REFUSAL);
  assert.throws(() => apiTarget({ env: 'prod', environment: {} }), RefusedError);
  const root = repoWithPins({ origins: { api: 'https://api.example.test' } });
  try {
    assert.equal(apiTarget({ confirm: 'production', env: 'production', environment: {}, repoRoot: root }).apiOrigin, 'https://api.example.test');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
  assert.equal(confirmationProblem('staging', undefined), null);
  assert.equal(confirmationProblem('production', 'production'), null);
});

test('productionCredentials: the environment or the production file only, mode 600, never staging\'s file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'api-session-secrets-'));
  const staging = path.join(dir, 'secrets.staging.env');
  const production = path.join(dir, 'secrets.production.env');
  const options = (environment = {}) => ({ environment, secretsFile: production, stagingSecretsFile: staging });
  try {
    writeFileSync(staging, 'CHOPSHOP_PLATFORM_EMAIL=staging@example.com\nPLATFORM_ADMIN_PASSWORD=staging-password-1\n', { mode: 0o600 });

    // The environment alone is enough; no file is needed.
    assert.deepEqual(productionCredentials(options({ CHOPSHOP_PLATFORM_EMAIL: 'p@example.com', CHOPSHOP_PLATFORM_PASSWORD: 'env-password-1' })), {
      email: 'p@example.com',
      password: 'env-password-1',
    });
    // No production file and nothing in the environment: refused, never staging's values.
    assert.throws(() => productionCredentials(options()), (error) => error instanceof RefusedError && error.message === `CHOPSHOP_PLATFORM_EMAIL is not set in the environment or in ${production}`);

    writeFileSync(production, 'CHOPSHOP_PLATFORM_EMAIL=p@example.com\n', { mode: 0o600 });
    chmodSync(production, 0o600);
    assert.throws(() => productionCredentials(options()), (error) => error.message === `no production platform password: set CHOPSHOP_PLATFORM_PASSWORD or PLATFORM_ADMIN_PASSWORD in ${production}`);
    writeFileSync(production, 'CHOPSHOP_PLATFORM_EMAIL=p@example.com\nPLATFORM_ADMIN_PASSWORD=file-password-1\n');
    assert.deepEqual(productionCredentials(options()), { email: 'p@example.com', password: 'file-password-1' });
    assert.deepEqual(productionCredentials(options({ CHOPSHOP_PLATFORM_PASSWORD: 'env-password-1' })).password, 'env-password-1');

    // Readable by others: refused before anything is read.
    chmodSync(production, 0o644);
    assert.throws(() => productionCredentials(options()), (error) => error.message === `${production} can be read by others (mode 644): chmod 600 it`);
    chmodSync(production, 0o640);
    assert.throws(() => productionCredentials(options()), /mode 640/);
    chmodSync(production, 0o600);

    // CHOPSHOP_SECRETS_FILE may only name the production file itself.
    assert.throws(
      () => productionCredentials(options({ CHOPSHOP_SECRETS_FILE: staging })),
      (error) => error.message === `CHOPSHOP_SECRETS_FILE is set: production reads its credentials only from the environment or ${production}`,
    );
    assert.equal(productionCredentials(options({ CHOPSHOP_SECRETS_FILE: production })).password, 'file-password-1');

    // The production file as a link to the staging file: refused.
    rmSync(production);
    symlinkSync(staging, production);
    assert.throws(() => productionCredentials(options()), (error) => error.message === `${production} is the staging secrets file: production never reads staging's credentials`);

    // credentialsFor: staging keeps its own rule.
    assert.deepEqual(credentialsFor('staging', { environment: {}, secretsFile: staging }), { email: 'staging@example.com', password: 'staging-password-1' });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('preflight: a production run needs /health to say production', async () => {
  const staging = await startFakeStagingApi({ migration: '0052_import_run_kinds.sql' });
  const production = await startFakeStagingApi({ environment: 'production', migration: '0052_import_run_kinds.sql' });
  try {
    await assert.rejects(
      preflight(createApiSession({ apiOrigin: staging.origin }), { environment: 'production', requiredMigration: '0052' }),
      (error) => error.message === '/health does not say production (HTTP 200)',
    );
    await assert.rejects(preflight(createApiSession({ apiOrigin: production.origin }), { requiredMigration: '0039' }), /does not say staging/);
    assert.deepEqual(await preflight(createApiSession({ apiOrigin: production.origin }), { environment: 'production', requiredMigration: '0052' }), {
      migration: '0052_import_run_kinds.sql',
    });
  } finally {
    await staging.close();
    await production.close();
  }
});
