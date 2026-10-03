// The legal pages' data modules against the dev API (unit FW), under Node:
//   node --test src/admin-app/replacements/legal-signer.test.mjs
// Who signed (the platform terms, the legal-pages adoption) and the refused
// text naming its page, as the pages read them (the platform terms through
// the same two calls platformTermsData.js makes: it cannot be loaded under Node).

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from '../../api/admin/client.js';
import { createState, route } from '../dev/dev-api.mjs';
import { loadLegalState } from './adminSettingsData.js';
import { recordLegalAcceptance } from './legalAcceptance.js';
import { getPlatformTermsStatus } from '../../api/admin/legal.js';
import { acceptanceOf } from '../adapters/platformTerms.js';

const realFetch = globalThis.fetch;
let state;
let cookie;
let extraCookie = '';

beforeEach(() => {
  state = createState();
  const answer = route(state, 'POST', new URL('/_api/api/auth/sign-in/email', 'http://dev.invalid'), {}, { email: 'admin@example.com', password: 'dev-password-1' });
  cookie = answer.setCookie.split(';')[0];
  extraCookie = '';
  globalThis.fetch = async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}), cookie: `${cookie}${extraCookie}` };
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const out = route(state, init.method ?? 'GET', new URL(String(url), 'http://dev.invalid'), headers, body);
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
  };
});
before(() => setRequestShopId('test-shop-a'));
after(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

const TEXTS = { kopvillkor: '<h1>K</h1>', angerratt: '<h1>A</h1>', integritetspolicy: '<h1>I</h1>' };
const adopt = (texts) => recordLegalAcceptance({
  shopId: 'test-shop-a', user: { uid: 'u1', email: 'me@example.com' }, identity: {}, pod: false, custom: {}, customHtml: {}, texts,
});

describe('who signed the platform terms (AdminPlatformTerms: "Godkända av …")', () => {
  it('a person of the shop: the address', async () => {
    const acceptance = acceptanceOf(await getPlatformTermsStatus({ shopId: 'test-shop-a' }));
    assert.equal(acceptance.email, 'admin@example.com');
    assert.ok(acceptance.acceptedAt);
  });

  it('an older version signed by the platform: "Plattformen", with that version\'s own date', async () => {
    extraCookie = '; admin_dev_terms=stale';
    const acceptance = acceptanceOf(await getPlatformTermsStatus({ shopId: 'test-shop-a' }));
    assert.deepEqual(acceptance, { acceptedAt: '2026-02-01T09:00:00.000Z', version: '2026-01-01', email: 'Plattformen' });
  });
});

describe('who adopted the legal pages (AdminSettings: "Godkända av …")', () => {
  it('the adoption read names its signer', async () => {
    const { acceptance } = await loadLegalState('test-shop-a');
    assert.equal(acceptance.email, 'admin@example.com');
  });

  it('an adoption just made keeps the signed-in user\'s address (the answer names no signer)', async () => {
    const pointer = await adopt(TEXTS);
    assert.equal(pointer.email, 'me@example.com');
  });
});

describe('a refused legal text names its page', () => {
  it('one page: its name in Swedish and its key for the page to open', async () => {
    await assert.rejects(adopt({ ...TEXTS, angerratt: '<p onclick="x()">a</p>' }), (error) => {
      assert.deepEqual(error.refusedKeys, ['angerratt']);
      assert.match(error.message, /Texten för Ångerrätt innehåller HTML/);
      return true;
    });
  });

  it('two pages, in the Worker\'s order', async () => {
    await assert.rejects(adopt({ ...TEXTS, kopvillkor: '<script>x</script>', integritetspolicy: '<iframe></iframe>' }), (error) => {
      assert.deepEqual(error.refusedKeys, ['kopvillkor', 'integritetspolicy']);
      assert.match(error.message, /Köpvillkor och Integritetspolicy/);
      return true;
    });
  });
});
