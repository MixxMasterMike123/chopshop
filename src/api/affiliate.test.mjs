// The storefront's affiliate calls (CP13), under Node:
//   node --test src/api/*.test.mjs
// fetch and location are stubbed per test; nothing leaves the process. Invented data only.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  PROMOTION_METHODS,
  applicationReady,
  applicationRefusal,
  getAffiliateTerms,
  submitAffiliateApplication,
  toApplicationBody,
} from './affiliate.js';

// cloudflare/src/affiliate/applications.ts APPLY_KEYS: any other key is a 400.
const APPLY_KEYS = ['email', 'message', 'name', 'phone', 'preferredLang', 'promotionMethod', 'socials', 'termsAccepted', 'termsVersion'];

const realFetch = globalThis.fetch;
let calls;
function stubFetch(status, body, headers = {}) {
  globalThis.fetch = async (url, init) => {
    calls.push({ init, url });
    return new Response(body === undefined ? null : JSON.stringify(body), { headers, status });
  };
}

beforeEach(() => {
  calls = [];
  globalThis.location = { pathname: '/provbutik/affiliate' };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.location;
});

const FORM = {
  name: '  Anna Andersson ',
  email: ' anna@example.test ',
  phone: '',
  promotionMethod: 'instagram',
  socials: { instagram: ' https://instagram.com/anna ', youtube: '', website: '   ' },
  message: ' Hej! ',
  preferredLang: 'sv',
  termsAccepted: true,
};

describe('toApplicationBody', () => {
  it('trims, leaves empty optional fields out and names the terms version shown', () => {
    const body = toApplicationBody(FORM, '2026-10-22');
    assert.deepEqual(body, {
      name: 'Anna Andersson',
      email: 'anna@example.test',
      promotionMethod: 'instagram',
      preferredLang: 'sv',
      termsVersion: '2026-10-22',
      termsAccepted: true,
      message: 'Hej!',
      socials: { instagram: 'https://instagram.com/anna' },
    });
    for (const key of Object.keys(body)) assert.ok(APPLY_KEYS.includes(key), key);
  });

  it('sends no socials without a link, and termsAccepted only when literally ticked', () => {
    const body = toApplicationBody({ ...FORM, socials: {}, termsAccepted: 'yes', preferredLang: 'de' }, '2026-10-22');
    assert.equal('socials' in body, false);
    assert.equal(body.termsAccepted, false);
    assert.equal(body.preferredLang, 'sv');
  });
});

describe('applicationReady', () => {
  it('needs the starred fields and the ticked terms', () => {
    assert.equal(applicationReady(FORM), true);
    assert.equal(applicationReady({ ...FORM, name: '  ' }), false);
    assert.equal(applicationReady({ ...FORM, email: '' }), false);
    assert.equal(applicationReady({ ...FORM, promotionMethod: '' }), false);
    assert.equal(applicationReady({ ...FORM, promotionMethod: 'radio' }), false);
    assert.equal(applicationReady({ ...FORM, termsAccepted: false }), false);
    assert.equal(applicationReady({ ...FORM, message: 'x'.repeat(2001) }), false);
    assert.deepEqual(PROMOTION_METHODS, ['blog', 'youtube', 'instagram', 'facebook', 'tiktok', 'forum', 'other']);
  });
});

describe('the calls', () => {
  it('reads the terms from the flat storefront route', async () => {
    stubFetch(200, { terms: { version: '2026-10-22', publishedAt: '2026-10-22T00:00:00.000Z', sha256: 'a'.repeat(64), text: 'Villkor' } });
    const terms = await getAffiliateTerms();
    assert.equal(terms.version, '2026-10-22');
    assert.equal(calls[0].url, '/_api/provbutik/v1/affiliate-terms');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.credentials, 'omit');
  });

  it('posts the application and resolves the 202', async () => {
    stubFetch(202, { applicationId: 'app-1' });
    const answer = await submitAffiliateApplication(toApplicationBody(FORM, '2026-10-22'));
    assert.deepEqual(answer, { applicationId: 'app-1' });
    assert.equal(calls[0].url, '/_api/provbutik/v1/affiliate-applications');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(JSON.parse(calls[0].init.body).termsVersion, '2026-10-22');
  });

  it('a refusal is an ApiError the page words by its status', async () => {
    stubFetch(429, { error: { code: 'rate_limited', message: 'x' } }, { 'retry-after': '3600' });
    await assert.rejects(submitAffiliateApplication({}), (error) => {
      assert.equal(applicationRefusal(error), 'rate_limited');
      return error.status === 429 && error.retryAfterSeconds === 3600;
    });
    stubFetch(400, { error: { code: 'invalid_request', message: 'x' } });
    await assert.rejects(submitAffiliateApplication({}), (error) => applicationRefusal(error) === 'invalid');
    stubFetch(404, { error: { code: 'not_found', message: 'x' } });
    await assert.rejects(getAffiliateTerms(), (error) => applicationRefusal(error) === 'closed');
    assert.equal(applicationRefusal({ status: 0 }), 'other');
  });
});
