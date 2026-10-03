// The platform shop detail's legal facts (unit WJ/FW), under Node, from the dev API:
//   node --test src/admin-app/replacements/platform-legal.test.mjs
// PlatformShopDetail's data modules as the page calls them: the shop, its
// readiness (the GO LIVE warning, the "Juridik" pill) and the signer rows.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createState, route } from '../dev/dev-api.mjs';
import { readFileSync } from 'node:fs';

import { getTenantDetail } from '../../api/admin/platform.js';
import { toDetailShop } from '../adapters/platformShops.js';
import * as cells from './shopCellsData.js';

// platformShopDetailData.js reads import.meta.env (urls.js) and cannot load under
// Node: its read of a shop is its two steps below, and its one extra line is checked in the source.
async function loadShop(id) {
  const detail = await getTenantDetail(id);
  cells.noteCurrentTermsVersion(detail.legal?.terms?.currentVersion);
  return { shop: toDetailShop(detail, null) };
}

const realFetch = globalThis.fetch;

before(() => {
  const state = createState();
  const answer = route(state, 'POST', new URL('/_api/api/auth/sign-in/email', 'http://dev.invalid'), {}, { email: 'platform@example.com', password: 'dev-password-2' });
  const cookie = answer.setCookie.split(';')[0];
  globalThis.fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const out = route(state, init.method ?? 'GET', new URL(String(url), 'http://dev.invalid'), { ...(init.headers ?? {}), cookie }, body);
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
  };
});
after(() => { globalThis.fetch = realFetch; });

describe('the shop detail\'s legal readiness and signers', () => {
  it('the detail\'s data module hands every read\'s current terms version to the cells', () => {
    const source = readFileSync(new URL('./platformShopDetailData.js', import.meta.url), 'utf8');
    assert.match(source, /noteCurrentTermsVersion\(detail\.legal\?\.terms\?\.currentVersion\);\n\s*return \{ shop: toDetailShop\(detail, connect\)/);
  });

  it('a shop the checkout is open for: ready, who adopted the pages and accepted the terms', async () => {
    const { shop } = await loadShop('test-shop-a');
    assert.deepEqual(cells.legalReadinessOf(shop), { ready: true, blockers: [], missing: [], needsReacceptance: false });
    assert.equal(shop.storeIdentity.legal.acceptance.email, 'admin@example.com');
    assert.equal(shop.platformTerms.email, 'admin@example.com');
    assert.equal(cells.PLATFORM_TERMS_VERSION, '2026-09-07', 'the "gammal version" pill compares with the server\'s current version');
    assert.equal(shop.platformTerms.version, cells.PLATFORM_TERMS_VERSION);
  });

  it('a shop in the terms grace period with an older acceptance: blocked on VAT and the pages, the old version shown', async () => {
    const { shop } = await loadShop('test-shop-b');
    const r = cells.legalReadinessOf(shop);
    assert.equal(r.ready, false);
    assert.deepEqual(r.blockers.map((b) => b.key), ['vatRegistered', 'acceptance']);
    assert.equal(shop.platformTerms.version, '2026-01-01');
    assert.notEqual(shop.platformTerms.version, cells.PLATFORM_TERMS_VERSION);
    assert.equal(shop.platformTerms.email, 'platform@example.com');
    assert.deepEqual(shop.storeIdentity, {}, 'no adoption: "Ej godkända"');
  });

  it('a new shop: nothing accepted, every part a blocker', async () => {
    const { shop } = await loadShop('test-shop-c');
    assert.deepEqual(cells.legalReadinessOf(shop).blockers.map((b) => b.key), ['platformTerms', 'returnAddress', 'vatRegistered', 'acceptance']);
    assert.equal(shop.platformTerms, null);
  });
});
