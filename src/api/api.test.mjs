// The storefront client, under Node (no browser, no bundler):
//   node --test src/api/api.test.mjs
// fetch, location and document are stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ApiError, apiUrl, parseShopSegment, request, segment, shopHref, storefrontRoot } from './client.js';
import { createCheckout, createPayment } from './checkout.js';
import { getProduct, listAllProducts } from './products.js';
import { getOrder, pollReceipt, receiptPollTimeLeft } from './orders.js';
import { resolveCheckoutRecovery, unsubscribeCheckoutReminders } from './checkoutRecovery.js';

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

beforeEach(() => {
  calls = [];
  globalThis.location = { pathname: '/sillmans/cart' };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.location;
});

describe('the root', () => {
  it('is the first segment on the shared host, read from the current path', () => {
    assert.equal(storefrontRoot('/sillmans/product/x'), '/sillmans');
    assert.equal(storefrontRoot('/melodie-mc'), '/melodie-mc');
    globalThis.location = { pathname: '/other-shop/' };
    assert.equal(storefrontRoot(), '/other-shop');
  });

  it('is null for a path that names no shop', () => {
    for (const path of ['/', '/admin/x', '/login', '/assets/a.js', '/Sillmans', '/sill%6Dans', '/_api/x']) {
      assert.equal(storefrontRoot(path), null, path);
    }
    assert.equal(parseShopSegment('se'), null);
  });

  it("is '' on a shop's own domain, whatever the path", async () => {
    globalThis.document = {
      querySelector: (selector) =>
        selector === 'meta[name="storefront-root"]' ? { getAttribute: () => '' } : null,
    };
    try {
      // A fresh module instance: the tag is read once per page.
      const own = await import('./client.js?own-domain');
      assert.equal(own.storefrontRoot('/product/x'), '');
      assert.equal(own.storefrontRoot('/'), '');
    } finally {
      delete globalThis.document;
    }
  });

  it('puts the root in front of a relative address, and nothing else', () => {
    assert.equal(shopHref('/product/x'), '/sillmans/product/x');
    assert.equal(shopHref('//evil.test'), null);
    assert.equal(shopHref('/\\evil.test'), null);
    assert.equal(shopHref('https://evil.test'), null);
    assert.equal(apiUrl('/v1/storefront/pod-previews/p/a'), '/_api/sillmans/v1/storefront/pod-previews/p/a');
    assert.equal(apiUrl('/api/auth/x'), null);
  });

  it('encodes a segment so the web Worker takes it', () => {
    assert.equal(segment("t-shirt (röd)!*'"), 't-shirt%20%28r%C3%B6d%29%21%2A%27');
    assert.equal(segment('a/b'), 'a%2Fb');
  });
});

describe('request', () => {
  it('calls /_api/<shop>/v1/… with no credentials and JSON', async () => {
    stubFetch(() => answer(201, { ok: true }));
    const result = await request('/v1/checkout', { body: { a: 1 }, method: 'POST' });

    assert.deepEqual(result, { data: { ok: true }, status: 201 });
    assert.equal(calls[0].url, '/_api/sillmans/v1/checkout');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, '{"a":1}');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.equal(calls[0].init.cache, undefined, 'the browser cache revalidates by ETag');
  });

  it("reads the API's error shape into an ApiError", async () => {
    stubFetch(() =>
      answer(429, { error: { code: 'rate_limited', message: 'Too many requests' } }, { 'retry-after': '12' }),
    );
    await assert.rejects(request('/v1/storefront'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.message, 'Too many requests');
      assert.equal(error.retryAfterSeconds, 12);
      return true;
    });
  });

  it('names a failure that is not the API shape', async () => {
    stubFetch(() => answer(502, '<html>bad gateway</html>'));
    await assert.rejects(request('/v1/storefront'), { code: 'http_error', status: 502 });

    stubFetch(() => answer(200, 'not json'));
    await assert.rejects(request('/v1/storefront'), { code: 'bad_response', status: 200 });

    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await assert.rejects(request('/v1/storefront'), { code: 'network_error', status: 0 });
  });

  it('refuses a path that is not an API path, and an address with no shop', async () => {
    stubFetch(() => answer(200, {}));
    await assert.rejects(request('/api/auth/get-session'), { code: 'bad_request' });
    globalThis.location = { pathname: '/' };
    await assert.rejects(request('/v1/storefront'), { code: 'no_shop' });
    assert.equal(calls.length, 0);
  });

  it('answers null for a 404 read of one thing', async () => {
    stubFetch(() => answer(404, { error: { code: 'not_found', message: 'Product not found' } }));
    assert.equal(await getProduct('gone'), null);
    assert.equal(calls[0].url, '/_api/sillmans/v1/products/gone');
  });
});

describe('products', () => {
  it('follows the cursor to the end', async () => {
    stubFetch((url) => {
      const cursor = new URL(url, 'https://x.invalid').searchParams.get('cursor');
      return answer(200, cursor === null
        ? { nextCursor: 'c2', products: [{ productId: 'a' }] }
        : { nextCursor: null, products: [{ productId: 'b' }] });
    });
    const products = await listAllProducts({ tag: 'sommar' });

    assert.deepEqual(products.map((p) => p.productId), ['a', 'b']);
    assert.deepEqual(calls.map((c) => c.url), [
      '/_api/sillmans/v1/products?tag=sommar',
      '/_api/sillmans/v1/products?tag=sommar&cursor=c2',
    ]);
  });
});

describe('checkout', () => {
  it('sends only the fields the API takes, and no discount code', async () => {
    stubFetch(() => answer(201, { checkout: { checkoutId: 'c1', totalMinor: 19900 } }));
    const result = await createCheckout({
      consent: { terms: true },
      deliveryMethod: 'pickup',
      email: 'a@b.test',
      idempotencyKey: 'key-12345678',
      items: [{ extra: 'x', productId: 'p1', quantity: 2, variantId: 'v1' }, { productId: 'p2', quantity: 1 }],
      shippingCountry: 'SE',
    });

    assert.deepEqual(result, { checkout: { checkoutId: 'c1', totalMinor: 19900 }, replayed: false });
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      consent: { terms: true },
      deliveryMethod: 'pickup',
      email: 'a@b.test',
      idempotencyKey: 'key-12345678',
      items: [{ productId: 'p1', quantity: 2, variantId: 'v1' }, { productId: 'p2', quantity: 1 }],
    });
  });

  it('sends the recipient as given (D98)', async () => {
    stubFetch(() => answer(201, { checkout: { checkoutId: 'c2', totalMinor: 19900 } }));
    const recipient = { name: 'Testa Köpare', pickupLocationId: 'plats-1', pickupDate: '2026-10-01' };
    await createCheckout({
      consent: { terms: true },
      deliveryMethod: 'pickup',
      email: 'a@b.test',
      idempotencyKey: 'key-12345679',
      items: [{ productId: 'p1', quantity: 1 }],
      recipient,
    });
    assert.deepEqual(JSON.parse(calls[0].init.body).recipient, recipient);
  });

  it('asks for the payment with no body', async () => {
    stubFetch(() => answer(201, { payment: { clientSecret: 'cs', paymentIntentId: 'pi' } }));
    const payment = await createPayment('c 1');

    assert.deepEqual(payment, { clientSecret: 'cs', created: true, paymentIntentId: 'pi' });
    assert.equal(calls[0].url, '/_api/sillmans/v1/checkout/c%201/payment');
    assert.equal(calls[0].init.body, undefined);
  });
});

describe('the receipt poll', () => {
  function clock() {
    let t = 0;
    return {
      now: () => t,
      wait: async (ms, signal) => {
        if (signal?.aborted) throw signal.reason;
        t += ms;
      },
    };
  }

  it('polls every 2 s until the order is ready', async () => {
    stubFetch((_url, _init, n) =>
      answer(200, { receipt: n < 3 ? { status: 'pending' } : { orderId: 'o1', receiptToken: 't', status: 'ready' } }),
    );
    const c = clock();
    const receipt = await pollReceipt('c1', c);

    assert.deepEqual(receipt, { orderId: 'o1', receiptToken: 't', status: 'ready' });
    assert.equal(calls.length, 3);
    assert.equal(c.now(), 4_000);
    assert.equal(calls[0].url, '/_api/sillmans/v1/checkout/c1/receipt');
    assert.equal(calls[0].init.method, 'POST');
  });

  it('gives up with an explicit timeout after 90 s', async () => {
    stubFetch(() => answer(200, { receipt: { status: 'pending' } }));
    const c = clock();

    assert.deepEqual(await pollReceipt('c1', c), { status: 'timeout' });
    assert.ok(c.now() <= 90_000, `stopped at ${c.now()} ms`);
    // At 0, 2, … 88 s; no request is started at the deadline itself.
    assert.equal(calls.length, 45);
  });

  it('waits out a network error and a 429, and stops on a refusal', async () => {
    stubFetch((_url, _init, n) => {
      if (n === 1) throw new TypeError('offline');
      if (n === 2) return answer(429, { error: { code: 'rate_limited', message: 'x' } }, { 'retry-after': '5' });
      return answer(200, { receipt: { status: 'issued' } });
    });
    const c = clock();
    assert.deepEqual(await pollReceipt('c1', c), { status: 'issued' });
    assert.equal(c.now(), 2_000 + 5_000);

    calls = [];
    stubFetch(() => answer(404, { error: { code: 'not_found', message: 'Order not found' } }));
    await assert.rejects(pollReceipt('c1', clock()), { code: 'not_found', status: 404 });
    assert.equal(calls.length, 1);
  });

  it('answers its timeout when a request stalls past the deadline', async () => {
    // A request that never answers until it is aborted.
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const started = Date.now();
    assert.deepEqual(await pollReceipt('c1', { intervalMs: 5, timeoutMs: 40 }), { status: 'timeout' });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(calls.length, 1);
  });

  it('waits out a connection that fails while the body is read', async () => {
    stubFetch((_url, _init, n) => {
      if (n === 1) {
        const broken = new ReadableStream({
          pull(controller) {
            controller.error(new TypeError('connection lost'));
          },
        });
        return new Response(broken, { status: 200 });
      }
      return answer(200, { receipt: { status: 'issued' } });
    });
    assert.deepEqual(await pollReceipt('c1', clock()), { status: 'issued' });
    assert.equal(calls.length, 2);
  });

  it('stops when cancelled and makes no further request', async () => {
    stubFetch(() => answer(200, { receipt: { status: 'pending' } }));
    const controller = new AbortController();
    const polling = pollReceipt('c1', { intervalMs: 5, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 12));
    controller.abort();

    await assert.rejects(polling, { name: 'AbortError' });
    const made = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, made);
  });

  it('reads the order with the receipt token as a bearer', async () => {
    stubFetch(() => answer(200, { order: { orderId: 'o1' } }));
    assert.deepEqual(await getOrder('o1', 'tok'), { orderId: 'o1' });
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  });
});

describe("the time left of a checkout's receipt poll", () => {
  it('is the 90 s of the checkout, not of the page: asked again later, it is what is left', () => {
    assert.equal(receiptPollTimeLeft('left-1', 1_000), 90_000);
    assert.equal(receiptPollTimeLeft('left-1', 22_000), 69_000);
    assert.equal(receiptPollTimeLeft('left-1', 89_000), 2_000);
  });

  it('is never less than one interval: a page mounted after the time is up asks once', () => {
    assert.equal(receiptPollTimeLeft('left-2', 0), 90_000);
    assert.equal(receiptPollTimeLeft('left-2', 90_500), 2_000);
    assert.equal(receiptPollTimeLeft('left-2', 500_000), 2_000);
  });

  it('is kept per checkout', () => {
    assert.equal(receiptPollTimeLeft('left-3', 50_000), 90_000);
    assert.equal(receiptPollTimeLeft('left-4', 60_000), 90_000);
    assert.equal(receiptPollTimeLeft('left-3', 60_000), 80_000);
  });
});

describe('the reminder links (CP9-AC)', () => {
  const TOKEN = `v1.3f2a6b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c.${'A'.repeat(43)}`;

  it('resolves through POST /v1/checkout-recovery/:token, without a body', async () => {
    stubFetch(() => answer(200, { recovery: { items: [{ productId: 'p', quantity: 1 }], status: 'open' } }));
    assert.deepEqual(await resolveCheckoutRecovery(TOKEN), { items: [{ productId: 'p', quantity: 1 }], status: 'open' });
    assert.equal(calls[0].url, `/_api/sillmans/v1/checkout-recovery/${TOKEN}`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, undefined);
  });

  it('answers completed, and invalid for the one 404', async () => {
    stubFetch(() => answer(200, { recovery: { status: 'completed' } }));
    assert.deepEqual(await resolveCheckoutRecovery(TOKEN), { items: [], status: 'completed' });
    stubFetch(() => answer(404, { error: { code: 'not_found', message: 'Route not found' } }));
    assert.deepEqual(await resolveCheckoutRecovery(TOKEN), { items: [], status: 'invalid' });
  });

  it('rejects a 429, a 502 and an unknown shape (the page shows its error)', async () => {
    for (const reply of [answer(429, { error: { code: 'rate_limited' } }), answer(502, {}), answer(200, { recovery: { status: 'x' } })]) {
      stubFetch(() => reply);
      await assert.rejects(resolveCheckoutRecovery(TOKEN), ApiError);
    }
  });

  it('unsubscribes through POST …/unsubscribe: true, false for the 404, rejects otherwise', async () => {
    stubFetch(() => answer(200, { unsubscribed: true }));
    assert.equal(await unsubscribeCheckoutReminders(TOKEN), true);
    assert.equal(calls[0].url, `/_api/sillmans/v1/checkout-recovery/${TOKEN}/unsubscribe`);
    assert.equal(calls[0].init.method, 'POST');
    stubFetch(() => answer(404, { error: { code: 'not_found' } }));
    assert.equal(await unsubscribeCheckoutReminders(TOKEN), false);
    stubFetch(() => answer(500, {}));
    await assert.rejects(unsubscribeCheckoutReminders(TOKEN), ApiError);
    stubFetch(() => answer(200, {}));
    await assert.rejects(unsubscribeCheckoutReminders(TOKEN), ApiError);
  });
});
