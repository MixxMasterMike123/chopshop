// The admin client, under Node (no browser, no bundler):
//   node --test src/api/admin/client.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  AdminApiError,
  adminRequest,
  authRequest,
  getMeRaw,
  onSessionLost,
  platformRequest,
  setRequestShopId,
  withQuery,
  segment,
} from './client.js';

const realFetch = globalThis.fetch;
let calls;

function answer(status, body, headers = {}) {
  return new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), {
    headers,
    status,
  });
}

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ init, url });
    return handler(url, init, calls.length);
  };
}

const headerOf = (call, name) => call.init.headers[name.toLowerCase()];

beforeEach(() => {
  calls = [];
  setRequestShopId(null);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('the headers of each kind of request', () => {
  it('an admin request goes to /_api on this origin, same-origin credentials, X-Shop-Id of the active shop', async () => {
    stubFetch(() => answer(200, { shop: { tenantId: 'test-shop-a' } }));
    setRequestShopId('test-shop-a');
    const { data } = await adminRequest('GET', '/v1/admin/shop');
    assert.equal(data.shop.tenantId, 'test-shop-a');
    assert.equal(calls[0].url, '/_api/v1/admin/shop');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(headerOf(calls[0], 'X-Shop-Id'), 'test-shop-a');
  });

  it('an admin request may name its shop; the named one wins', async () => {
    stubFetch(() => answer(200, {}));
    setRequestShopId('test-shop-a');
    await adminRequest('GET', '/v1/admin/settings', { shopId: 'test-shop-b' });
    assert.equal(headerOf(calls[0], 'x-shop-id'), 'test-shop-b');
  });

  it('an admin request refuses to run without a shop, and sends nothing', async () => {
    stubFetch(() => answer(200, {}));
    await assert.rejects(adminRequest('GET', '/v1/admin/shop'), (e) => e instanceof AdminApiError && e.code === 'no_shop' && e.status === 0);
    assert.equal(calls.length, 0);
  });

  it('a platform request never carries X-Shop-Id, even with an active shop', async () => {
    stubFetch(() => answer(200, { tenants: [] }));
    setRequestShopId('test-shop-a');
    await platformRequest('GET', '/v1/platform/tenants');
    assert.equal(calls[0].url, '/_api/v1/platform/tenants');
    assert.equal(headerOf(calls[0], 'x-shop-id'), undefined);
    assert.equal(calls[0].init.credentials, 'same-origin');
  });

  it('a platform request that names a shop is refused before it is sent', async () => {
    stubFetch(() => answer(200, {}));
    await assert.rejects(platformRequest('GET', '/v1/platform/tenants', { shopId: 'x' }), { code: 'bad_request' });
    assert.equal(calls.length, 0);
  });

  it('an auth request goes to /_api/api/auth/… without X-Shop-Id', async () => {
    stubFetch(() => answer(200, { status: true }));
    setRequestShopId('test-shop-a');
    await authRequest('POST', '/api/auth/sign-out', { json: {} });
    assert.equal(calls[0].url, '/_api/api/auth/sign-out');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, '{}');
    assert.equal(headerOf(calls[0], 'content-type'), 'application/json');
    assert.equal(headerOf(calls[0], 'x-shop-id'), undefined);
  });

  it('each function accepts only its own family of paths', async () => {
    stubFetch(() => answer(200, {}));
    setRequestShopId('test-shop-a');
    await assert.rejects(adminRequest('GET', '/v1/platform/tenants'), { code: 'bad_request' });
    await assert.rejects(adminRequest('GET', '/v1/me'), { code: 'bad_request' });
    await assert.rejects(platformRequest('GET', '/v1/admin/shop'), { code: 'bad_request' });
    await assert.rejects(authRequest('GET', '/v1/admin/shop'), { code: 'bad_request' });
    assert.equal(calls.length, 0);
  });

  it('a JSON body, an Idempotency-Key, a raw body with its type', async () => {
    stubFetch(() => answer(201, { ok: true }));
    setRequestShopId('test-shop-a');
    await adminRequest('POST', '/v1/admin/orders/o1/refunds', { json: { amountMinor: 100 }, idempotencyKey: 'k-1' });
    assert.equal(calls[0].init.body, '{"amountMinor":100}');
    assert.equal(headerOf(calls[0], 'idempotency-key'), 'k-1');
    const blob = new Blob(['abc'], { type: 'image/png' });
    await adminRequest('PUT', '/v1/admin/objects/x/content', { body: blob, contentType: 'image/png' });
    assert.equal(calls[1].init.body, blob);
    assert.equal(headerOf(calls[1], 'content-type'), 'image/png');
    await assert.rejects(adminRequest('POST', '/v1/admin/x', { json: {}, body: blob }), { code: 'bad_request' });
    await assert.rejects(adminRequest('POST', '/v1/admin/x', { idempotencyKey: '' }), { code: 'bad_request' });
  });
});

describe('error mapping', () => {
  it("the API's error shape: status, code, message, reason, details", async () => {
    stubFetch(() =>
      answer(400, { error: { code: 'invalid_request', message: 'Request is not valid', reason: 'type_not_as_stated' } }),
    );
    setRequestShopId('test-shop-a');
    await assert.rejects(adminRequest('PUT', '/v1/admin/objects/x/content'), (e) => {
      assert.ok(e instanceof AdminApiError);
      assert.equal(e.status, 400);
      assert.equal(e.code, 'invalid_request');
      assert.equal(e.reason, 'type_not_as_stated');
      assert.equal(e.details.reason, 'type_not_as_stated');
      return true;
    });
  });

  it("Better Auth's error shape ({ code, message } at the top)", async () => {
    stubFetch(() => answer(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }));
    await assert.rejects(authRequest('POST', '/api/auth/sign-in/email', { json: {} }), {
      status: 401,
      code: 'INVALID_EMAIL_OR_PASSWORD',
    });
  });

  it('a 429 carries Retry-After', async () => {
    stubFetch(() => answer(429, { error: { code: 'rate_limited', message: 'Too many requests' } }, { 'retry-after': '30' }));
    await assert.rejects(authRequest('POST', '/api/auth/request-password-reset', { json: {} }), {
      code: 'rate_limited',
      retryAfterSeconds: 30,
    });
  });

  it('no body, a body that is not JSON, a failed connection', async () => {
    stubFetch(() => answer(500));
    await assert.rejects(authRequest('POST', '/api/auth/sign-out'), { status: 500, code: 'http_error' });
    stubFetch(() => answer(200, '<html>'));
    await assert.rejects(authRequest('POST', '/api/auth/sign-out'), { status: 200, code: 'bad_response' });
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await assert.rejects(authRequest('POST', '/api/auth/sign-out'), { status: 0, code: 'network_error' });
  });

  it('an abort is the AbortError itself', async () => {
    stubFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    await assert.rejects(authRequest('GET', '/api/auth/get-session'), { name: 'AbortError' });
  });

  it('an empty 2xx body is null data', async () => {
    stubFetch(() => answer(204));
    setRequestShopId('test-shop-a');
    const { status, data } = await adminRequest('DELETE', '/v1/admin/objects/x');
    assert.equal(status, 204);
    assert.equal(data, null);
  });
});

describe('a 404 re-reads /v1/me once', () => {
  it('/v1/me 401 → the session is gone: the listeners are told, the request fails unauthenticated', async () => {
    stubFetch((url) => (url === '/_api/v1/me' ? answer(401, { error: { code: 'unauthenticated' } }) : answer(404, { error: { code: 'not_found' } })));
    setRequestShopId('test-shop-a');
    let told = 0;
    const off = onSessionLost(() => {
      told += 1;
    });
    try {
      await assert.rejects(adminRequest('GET', '/v1/admin/products/p1'), { status: 401, code: 'unauthenticated' });
    } finally {
      off();
    }
    assert.equal(told, 1);
    assert.deepEqual(calls.map((c) => c.url), ['/_api/v1/admin/products/p1', '/_api/v1/me']);
    assert.equal(headerOf(calls[1], 'x-shop-id'), undefined);
  });

  it('/v1/me 200 → the 404 stands, nobody is told', async () => {
    stubFetch((url) => (url === '/_api/v1/me' ? answer(200, { user: { id: 'u' } }) : answer(404, { error: { code: 'not_found' } })));
    setRequestShopId('test-shop-a');
    let told = 0;
    const off = onSessionLost(() => {
      told += 1;
    });
    try {
      await assert.rejects(adminRequest('GET', '/v1/admin/products/p1'), { status: 404, code: 'not_found' });
    } finally {
      off();
    }
    assert.equal(told, 0);
  });

  it('/v1/me unreachable → the 404 stands (a failure to ask is not a lost session)', async () => {
    stubFetch((url) => {
      if (url === '/_api/v1/me') throw new TypeError('Failed to fetch');
      return answer(404, { error: { code: 'not_found' } });
    });
    setRequestShopId('test-shop-a');
    await assert.rejects(adminRequest('GET', '/v1/admin/x'), { status: 404 });
  });

  it('the platform routes follow the same rule', async () => {
    stubFetch((url) => (url === '/_api/v1/me' ? answer(401, {}) : answer(404, {})));
    await assert.rejects(platformRequest('GET', '/v1/platform/tenants'), { code: 'unauthenticated' });
  });

  it('concurrent 404s share one re-read', async () => {
    stubFetch((url) => (url === '/_api/v1/me' ? answer(200, {}) : answer(404, {})));
    setRequestShopId('test-shop-a');
    await Promise.allSettled([adminRequest('GET', '/v1/admin/a'), adminRequest('GET', '/v1/admin/b')]);
    assert.equal(calls.filter((c) => c.url === '/_api/v1/me').length, 1);
  });

  it('another status does not re-read /v1/me', async () => {
    stubFetch(() => answer(409, { error: { code: 'conflict' } }));
    setRequestShopId('test-shop-a');
    await assert.rejects(adminRequest('DELETE', '/v1/admin/objects/x'), { status: 409 });
    assert.equal(calls.length, 1);
  });

  it('an auth route never re-reads /v1/me', async () => {
    stubFetch(() => answer(404, {}));
    await assert.rejects(authRequest('POST', '/api/auth/reset-password'), { status: 404 });
    assert.equal(calls.length, 1);
  });
});

describe('/v1/me itself', () => {
  it('401 is null, 200 is the body, anything else rejects', async () => {
    stubFetch(() => answer(401, { error: { code: 'unauthenticated' } }));
    assert.equal(await getMeRaw(), null);
    stubFetch(() => answer(200, { user: { id: 'u1' } }));
    assert.deepEqual(await getMeRaw(), { user: { id: 'u1' } });
    stubFetch(() => answer(500, {}));
    await assert.rejects(getMeRaw(), { status: 500 });
  });
});

describe('helpers', () => {
  it('segment escapes what an id rule refuses; withQuery drops empty values', () => {
    assert.equal(segment("a b/c'(x)"), 'a%20b%2Fc%27%28x%29');
    assert.equal(withQuery('/v1/admin/orders', { status: 'paid', q: '', cursor: null, limit: 50 }), '/v1/admin/orders?status=paid&limit=50');
    assert.equal(withQuery('/v1/admin/orders'), '/v1/admin/orders');
  });
});
