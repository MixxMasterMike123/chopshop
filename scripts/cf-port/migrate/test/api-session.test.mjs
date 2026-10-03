import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createApiSession,
  parseEnvFile,
  platformCredentials,
  preflight,
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
