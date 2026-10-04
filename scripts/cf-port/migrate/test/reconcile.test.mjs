/**
 * CP7-T2: scripts/cf-port/reconcile-staging.mjs's production mode — read-only,
 * confirmed, on the pinned production API, the Stripe key only from
 * ~/.config/chopshop/stripe.production.env — and staging's rules kept. Offline:
 * a scratch HOME, a scratch pinned file, the repository's fake API on
 * 127.0.0.1 and an injected fake Stripe client. No real host is reached.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RefusedError } from '../lib/api-session.mjs';
import { parseArgs, readOnlyRequest, reconcileTarget, runReconcile } from '../../reconcile-staging.mjs';
import { startFakeStagingApi } from './fake-staging-api.mjs';
import { rmDir, tmpDir } from './fixtures.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../reconcile-staging.mjs');
const LIVE_PLATFORM = 'acct_live_platform_test';
const LIVE_KEY = 'rk_live_test_reconcile_0123456789';
const ORDER_ID = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';

/** A scratch HOME and repository root: production's pinned file, the Stripe file, the secrets file. */
function scratch({ api = 'https://api.production.invalid', stripeAccountId = LIVE_PLATFORM, stripe = `STRIPE_SECRET_KEY=${LIVE_KEY}\n`, stripeMode = 0o600, secrets = 'CHOPSHOP_PLATFORM_EMAIL=platform@example.com\nPLATFORM_ADMIN_PASSWORD=platform-password-1\n' } = {}) {
  const base = tmpDir('reconcile-');
  const config = path.join(base, 'home', '.config', 'chopshop');
  mkdirSync(config, { recursive: true });
  mkdirSync(path.join(base, 'repo', 'cloudflare'), { recursive: true });
  writeFileSync(path.join(base, 'repo', 'cloudflare', 'pinned.production.json'), JSON.stringify({ origins: { admin: null, api, web: null }, stripeAccountId }));
  writeFileSync(path.join(base, 'repo', 'cloudflare', 'pinned.staging.json'), JSON.stringify({ origins: { api: 'https://api.staging.invalid' }, stripeAccountId: 'acct_sandbox_platform' }));
  if (stripe !== null) {
    writeFileSync(path.join(config, 'stripe.production.env'), stripe);
    chmodSync(path.join(config, 'stripe.production.env'), stripeMode);
  }
  if (secrets !== null) writeFileSync(path.join(config, 'secrets.production.env'), secrets, { mode: 0o600 });
  return { base, config, homeDir: path.join(base, 'home'), repoRoot: path.join(base, 'repo') };
}

const PRODUCTION = ['--env', 'production', '--confirm', 'production', '--tenant', 'melodie-mc'];

function targetOf(argv, s, environment = {}) {
  return reconcileTarget(parseArgs(argv), { environment, homeDir: s.homeDir, repoRoot: s.repoRoot });
}

function refusedWith(fn, pattern) {
  assert.throws(fn, (error) => error instanceof RefusedError && pattern.test(error.message), `expected a refusal matching ${pattern}`);
}

/** A fake Stripe client: GET only by construction; every call is recorded. */
function fakeStripe({ accountId = LIVE_PLATFORM, transferAmount = 10_000 } = {}) {
  const calls = [];
  const answers = {
    '/v1/account': { id: accountId },
    '/v1/application_fees/fee_1': { amount: 500, amount_refunded: 0, id: 'fee_1' },
    '/v1/payment_intents/pi_1': { application_fee_amount: 500, created: 1_790_000_000, latest_charge: { amount_captured: 10_000, amount_refunded: 0, application_fee: 'fee_1', transfer: 'tr_1' }, status: 'succeeded', transfer_data: { destination: 'acct_shop' } },
    '/v1/refunds': { data: [], has_more: false },
    '/v1/transfers': { data: [], has_more: false },
    '/v1/transfers/tr_1': { amount: transferAmount, amount_reversed: 0, id: 'tr_1' },
  };
  const stripeGet = async (route, params = {}) => {
    calls.push({ params, route });
    if (!Object.hasOwn(answers, route)) throw new Error(`fake Stripe: no answer for ${route}`);
    return answers[route];
  };
  return { calls, stripeGet };
}

const PLATFORM_ORDER = {
  money: { applicationFeeMinor: 500, chargedMinor: 10_000, refundPendingMinor: 0, refundedMinor: 0, withholdingReleasedMinor: 0 },
  orderId: ORDER_ID,
  paymentIntentId: 'pi_1',
  payout: { amountMinor: 9_500, eligibleAt: '2026-10-11T00:00:00.000Z', state: 'pending' },
  status: 'paid',
  tenantId: 'melodie-mc',
};

// ── production: the refusals before any request ─────────────────────────────

test('production without --confirm production is refused', () => {
  const s = scratch();
  try {
    refusedWith(() => targetOf(['--env', 'production', '--tenant', 'melodie-mc'], s), /--env production needs --confirm production/);
  } finally {
    rmDir(s.base);
  }
});

test('--confirm production on staging is refused', () => {
  const s = scratch();
  try {
    refusedWith(() => targetOf(['--confirm', 'production'], s, { CHOPSHOP_API_URL: 'https://api.staging.invalid' }), /--confirm production belongs to --env production only/);
  } finally {
    rmDir(s.base);
  }
});

test('production is refused while the pinned API origin is null, and with a CHOPSHOP_API_URL that is not the pin', () => {
  const nullPin = scratch({ api: null });
  try {
    refusedWith(() => targetOf(PRODUCTION, nullPin), /origins\.api is null/);
  } finally {
    rmDir(nullPin.base);
  }
  const s = scratch();
  try {
    refusedWith(() => targetOf(PRODUCTION, s, { CHOPSHOP_API_URL: 'https://chopshop-api-stg.example.invalid' }), /CHOPSHOP_API_URL is not the pinned production API origin/);
  } finally {
    rmDir(s.base);
  }
});

test('production needs an explicit --tenant (no slice default)', () => {
  const s = scratch();
  try {
    refusedWith(() => targetOf(['--env', 'production', '--confirm', 'production'], s), /--tenant is required for --env production/);
  } finally {
    rmDir(s.base);
  }
});

test('production refuses FAKE_PRINTER_TOKEN', () => {
  const s = scratch();
  try {
    refusedWith(() => targetOf(PRODUCTION, s, { FAKE_PRINTER_TOKEN: 'x' }), /FAKE_PRINTER_TOKEN is staging's/);
  } finally {
    rmDir(s.base);
  }
});

test('production is refused while the pinned stripeAccountId is null', () => {
  const s = scratch({ stripeAccountId: null });
  try {
    refusedWith(() => targetOf(PRODUCTION, s), /stripeAccountId is null/);
  } finally {
    rmDir(s.base);
  }
});

test('production never takes STRIPE_SECRET_KEY from the environment', () => {
  const s = scratch();
  try {
    refusedWith(() => targetOf(PRODUCTION, s, { STRIPE_SECRET_KEY: LIVE_KEY }), /STRIPE_SECRET_KEY is set in the environment: production reads its Stripe key only from/);
  } finally {
    rmDir(s.base);
  }
});

test('production without ~/.config/chopshop/stripe.production.env is refused', () => {
  const s = scratch({ stripe: null });
  try {
    refusedWith(() => targetOf(PRODUCTION, s), /stripe\.production\.env does not exist/);
  } finally {
    rmDir(s.base);
  }
});

test('a production Stripe file others can read is refused', () => {
  const s = scratch({ stripeMode: 0o644 });
  try {
    refusedWith(() => targetOf(PRODUCTION, s), /can be read by others \(mode 644\): chmod 600 it/);
  } finally {
    rmDir(s.base);
  }
});

test('the staging Stripe file under the production name is refused', () => {
  const s = scratch({ stripe: null });
  try {
    writeFileSync(path.join(s.config, 'stripe.staging.env'), 'STRIPE_SECRET_KEY=sk_test_x\n', { mode: 0o600 });
    symlinkSync(path.join(s.config, 'stripe.staging.env'), path.join(s.config, 'stripe.production.env'));
    refusedWith(() => targetOf(PRODUCTION, s), /is the staging Stripe file: production never reads staging's key/);
  } finally {
    rmDir(s.base);
  }
});

test('a production Stripe file without STRIPE_SECRET_KEY is refused', () => {
  const s = scratch({ stripe: 'OTHER=1\n' });
  try {
    refusedWith(() => targetOf(PRODUCTION, s), /defines no STRIPE_SECRET_KEY/);
  } finally {
    rmDir(s.base);
  }
});

test('a test-mode (sandbox) key is refused in production', () => {
  for (const key of ['sk_test_abc', 'rk_test_abc']) {
    const s = scratch({ stripe: `STRIPE_SECRET_KEY=${key}\n` });
    try {
      refusedWith(() => targetOf(PRODUCTION, s), /is not a live key \(sk_live_ or rk_live_\)/);
    } finally {
      rmDir(s.base);
    }
  }
});

test('production never reads the staging secrets file for the platform user', () => {
  const s = scratch({ secrets: null });
  try {
    writeFileSync(path.join(s.config, 'secrets.staging.env'), 'CHOPSHOP_PLATFORM_EMAIL=staging@example.com\nPLATFORM_ADMIN_PASSWORD=staging-password-1\n', { mode: 0o600 });
    refusedWith(() => targetOf(PRODUCTION, s), /CHOPSHOP_PLATFORM_EMAIL is not set in the environment or in .*secrets\.production\.env/);
  } finally {
    rmDir(s.base);
  }
});

// ── staging: its rules kept ─────────────────────────────────────────────────

test('staging keeps its rules: the pinned staging origin, a test-mode key (a live key refused), credentials from the environment', () => {
  const s = scratch();
  try {
    const environment = { CHOPSHOP_API_URL: 'https://api.staging.invalid', CHOPSHOP_PLATFORM_EMAIL: 'p@example.com', CHOPSHOP_PLATFORM_PASSWORD: 'pw', STRIPE_SECRET_KEY: 'sk_test_abc' };
    const target = targetOf(['--tenant', 'slice-20260927'], s, environment);
    assert.equal(target.env, 'staging');
    assert.equal(target.stripeAccountId, 'acct_sandbox_platform');
    refusedWith(() => targetOf([], s, { ...environment, STRIPE_SECRET_KEY: LIVE_KEY }), /^STRIPE_SECRET_KEY is not a test-mode key$/);
    refusedWith(() => targetOf([], s, { ...environment, CHOPSHOP_API_URL: 'https://api.production.invalid' }), /is not the pinned STAGING api origin/);
    refusedWith(() => targetOf([], s, { ...environment, CHOPSHOP_PLATFORM_PASSWORD: '' }), /^CHOPSHOP_PLATFORM_PASSWORD is not set$/);
  } finally {
    rmDir(s.base);
  }
});

// ── production: read-only, end to end against the fake API ──────────────────

test('production is read-only: the request helper refuses every method but GET, and any grant or token', async () => {
  const session = { request: async () => ({ status: 200 }) };
  const request = readOnlyRequest(session);
  await assert.rejects(request('POST', '/v1/platform/tenants/melodie-mc/acting-as'), (e) => e instanceof RefusedError && /production is read-only: POST \/v1\/platform\/tenants\/melodie-mc\/acting-as refused/.test(e.message));
  for (const method of ['PUT', 'PATCH', 'DELETE']) await assert.rejects(request(method, '/v1/admin/settings'), RefusedError);
  await assert.rejects(request('GET', '/v1/admin/orders/x', { shop: true }), /would need a grant or a token/);
  await assert.rejects(request('GET', '/v1/staging/fake-printer/jobs', { bearer: 't' }), /would need a grant or a token/);
  assert.equal((await request('GET', '/v1/platform/orders')).status, 200);
});

async function productionRun({ api = {}, stripe = {} } = {}) {
  const fake = await startFakeStagingApi({ environment: 'production', platformOrders: [PLATFORM_ORDER], tenants: { 'melodie-mc': {} }, ...api });
  const s = scratch({ api: fake.origin });
  const lines = [];
  try {
    const target = targetOf(PRODUCTION, s);
    const client = fakeStripe(stripe);
    let code;
    let refusal = null;
    try {
      code = await runReconcile(target, { log: (l) => lines.push(l), stripeGet: client.stripeGet });
    } catch (error) {
      if (!(error instanceof RefusedError)) throw error;
      refusal = error.message;
    }
    return { calls: client.calls, code, fake, lines, refusal, target };
  } finally {
    await fake.close();
    rmDir(s.base);
  }
}

test('production BALANCED: every API request a GET but the one sign-in, no acting-as, no key or cookie printed', async () => {
  const run = await productionRun();
  assert.equal(run.refusal, null);
  assert.equal(run.code, 0);
  assert.equal(run.lines.at(-1), 'BALANCED — 1 order(s), Δ 0 öre');
  const writes = run.fake.state.log.filter((entry) => entry.method !== 'GET');
  assert.deepEqual(writes.map((entry) => `${entry.method} ${entry.path}`), ['POST /api/auth/sign-in/email']);
  assert.equal(run.fake.state.grants.size, 0, 'no acting-as grant');
  assert.deepEqual(run.fake.state.audit, [], 'nothing audited: nothing written');
  assert.ok(run.fake.state.log.every((entry) => entry.shop === null), 'no request in a shop\'s context');
  assert.ok(run.calls.length > 0 && run.calls[0].route === '/v1/account');
  const printed = run.lines.join('\n');
  assert.ok(!printed.includes(LIVE_KEY) && !printed.includes('session=') && !printed.includes('platform-password'), 'no key, cookie or password printed');
});

test('production UNBALANCED: a payout that differs from the connected account\'s net exits 1, with the öre', async () => {
  const run = await productionRun({ stripe: { transferAmount: 9_900 } });
  assert.equal(run.code, 1);
  assert.equal(run.lines.at(-1), 'UNBALANCED — 1 of 1 order(s) disagree, Σ|Δ payout| 100 öre');
});

test('production: a Stripe key of another account than the pinned live platform is refused', async () => {
  const run = await productionRun({ stripe: { accountId: 'acct_someone_else' } });
  assert.match(run.refusal, /the Stripe key belongs to acct_someone_else, not the pinned live platform acct_live_platform_test/);
  assert.equal(run.fake.state.log.length, 0, 'refused before any API request');
});

test('production: an API whose /health does not say production is refused before the sign-in', async () => {
  const run = await productionRun({ api: { environment: 'staging' } });
  assert.match(run.refusal, /\/health does not say production \(HTTP 200\)/);
  assert.ok(!run.fake.state.log.some((entry) => entry.path === '/api/auth/sign-in/email'));
});

test('the CLI: a production refusal exits 2 before any request; staging\'s refusal keeps exit 1', () => {
  const s = scratch();
  try {
    const noNetwork = `data:text/javascript,${encodeURIComponent('globalThis.fetch = () => Promise.reject(new Error("network refused in this test"));')}`;
    const run = (...args) => spawnSync(process.execPath, ['--import', noNetwork, SCRIPT, ...args], { encoding: 'utf8', env: { HOME: s.homeDir, PATH: process.env.PATH } });
    const production = run('--env', 'production', '--tenant', 'melodie-mc');
    assert.equal(production.status, 2);
    assert.match(production.stderr, /^RECONCILE REFUSED: --env production needs --confirm production/m);
    const staging = run('--tenant', 'slice-20260927');
    assert.equal(staging.status, 1);
    assert.match(staging.stderr, /^RECONCILE REFUSED: CHOPSHOP_API_URL is not set/m);
  } finally {
    rmDir(s.base);
  }
});
