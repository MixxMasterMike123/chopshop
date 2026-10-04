/**
 * scripts/cf-port/migrate/test/cli-production.mjs — CP7-T1: a check shared by
 * the tests of storage-copy.mjs and import-studio-assets.mjs (a helper, not a
 * test file: importing a *.test.mjs would run its tests twice).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeTestBundle } from './fake-staging-api.mjs';

/**
 * The CLI itself, in production mode: `fetch` is disabled in the child (any
 * request would fail the test as a network error, exit 1), HOME is a scratch
 * directory that holds ONLY a staging secrets file with credentials, and the
 * real cloudflare/pinned.production.json is read (never written). Every run
 * must end in a refusal (exit 2) before any request.
 */
export function cliInProductionMode(script, label) {
  return () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cli-production-'));
    try {
      mkdirSync(path.join(home, '.config', 'chopshop'), { recursive: true });
      writeFileSync(path.join(home, '.config', 'chopshop', 'secrets.staging.env'), 'CHOPSHOP_PLATFORM_EMAIL=staging@example.com\nPLATFORM_ADMIN_PASSWORD=staging-password-1\n', { mode: 0o600 });
      const bundle = path.join(home, 'bundle');
      writeTestBundle(bundle, { products: [{ data: { b2cImageUrl: 'https://files.example.test/v0/b/x.firebasestorage.app/o/a.png?alt=media', shopId: 'shop-a' }, id: 'p' }], settings: [], shops: [{ data: {}, id: 'shop-a' }] });
      const noNetwork = `data:text/javascript,${encodeURIComponent('globalThis.fetch = () => Promise.reject(new Error("network refused in this test"));')}`;
      const run = (...extra) =>
        spawnSync(process.execPath, ['--import', noNetwork, script, '--env', 'production', '--bundle', bundle, '--out', path.join(home, 'out'), ...extra], {
          encoding: 'utf8',
          env: { HOME: home, PATH: process.env.PATH },
        });
      const unconfirmed = run();
      assert.equal(unconfirmed.status, 2, unconfirmed.stderr);
      assert.match(unconfirmed.stderr, new RegExp(`${label} REFUSED: --env production needs --confirm production`));
      const confirmed = run('--confirm', 'production');
      assert.equal(confirmed.status, 2, confirmed.stderr);
      assert.match(
        confirmed.stderr,
        new RegExp(`${label} REFUSED: (cloudflare/pinned\\.production\\.json origins\\.api is null|CHOPSHOP_PLATFORM_EMAIL is not set in the environment or in ~/\\.config/chopshop/secrets\\.production\\.env)`),
        'the staging secrets file is never read for production',
      );
      const named = spawnSync(process.execPath, ['--import', noNetwork, script, '--env', 'production', '--confirm', 'production', '--bundle', bundle, '--out', path.join(home, 'out')], {
        encoding: 'utf8',
        env: { CHOPSHOP_SECRETS_FILE: path.join(home, '.config', 'chopshop', 'secrets.staging.env'), HOME: home, PATH: process.env.PATH },
      });
      assert.equal(named.status, 2, named.stderr);
      assert.match(named.stderr, new RegExp(`${label} REFUSED: (cloudflare/pinned\\.production\\.json origins\\.api is null|CHOPSHOP_SECRETS_FILE is set)`));
      assert.equal(existsSync(path.join(home, 'out')), false, 'nothing written');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  };
}

