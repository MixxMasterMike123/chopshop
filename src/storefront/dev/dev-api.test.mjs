// The storefront's dev API, under Node:
//   node --test src/storefront/dev/dev-api.test.mjs
// Answers are checked against the API's public shapes; the last case proves
// the dev API is not in the storefront's build output (when one exists).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { EventEmitter } from 'node:events';

import { createDevApi, DEV_API_MARKER, loadShops, readJsonBody, route } from './dev-api.mjs';
import { toPageProduct, toPageProducts } from '../adapters/products.js';

const shops = loadShops();
const get = (path, options) => route(shops, 'GET', new URL(path, 'http://dev.invalid'), options);

const SUMMARY_KEYS = [
  'category', 'compareAtPriceMinor', 'currency', 'description', 'featured', 'handle', 'image',
  'isFromPrice', 'lowestPriceMinor', 'name', 'path', 'priceMinor', 'productId', 'sku',
  'sortOrder', 'swatches', 'tags',
].sort();

describe('the dev API answers the storefront routes in the API\'s shapes', () => {
  it('the storefront response', () => {
    const { status, body } = get('/_api/provbutiken/v1/storefront');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.storefront).sort(), [
      'accent', 'branding', 'currency', 'features', 'identity', 'locale', 'menu', 'name', 'pickupLocations', 'templateId', 'theme',
    ]);
    assert.equal(body.storefront.features.pod, true);
  });

  it('an unknown shop is the one 404 on every route', () => {
    for (const path of ['/v1/storefront', '/v1/products', '/v1/legal/kopvillkor']) {
      const { status, body } = get(`/_api/stangd-butik${path}`);
      assert.equal(status, 404, path);
      assert.equal(body.error.code, 'not_found');
    }
  });

  it('the product list: summaries only, in the display order, filtered by key', () => {
    const { body } = get('/_api/provbutiken/v1/products');
    assert.equal(body.nextCursor, null);
    for (const product of body.products) assert.deepEqual(Object.keys(product).sort(), SUMMARY_KEYS);
    const orders = body.products.map((p) => p.sortOrder);
    assert.deepEqual(orders.slice(0, 2), [1, 2]);
    assert.ok(orders.slice(2).every((o) => o === null));

    const tagged = get('/_api/provbutiken/v1/products?tag=sommar-2026').body.products.map((p) => p.sku);
    assert.deepEqual(tagged.sort(), ['FT-400', 'LT-100']);
    const category = get('/_api/provbutiken/v1/products?category=kok').body.products.map((p) => p.sku);
    assert.deepEqual(category.sort(), ['FL-600', 'KH-700']);
    assert.equal(get('/_api/provbutiken/v1/products?colour=red').status, 400);
  });

  it('pages a list by the dev page size, and the cursor walks it without gap or repeat', () => {
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 10; i += 1) {
      const { body } = get(`/_api/provbutiken/v1/products${cursor ? `?cursor=${cursor}` : ''}`, { pageSize: 3 });
      assert.ok(body.products.length <= 3);
      seen.push(...body.products.map((p) => p.productId));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    const all = get('/_api/provbutiken/v1/products').body.products.map((p) => p.productId);
    assert.deepEqual(seen, all);
  });

  it('one product by id, handle or the sku after the last underscore', () => {
    const byId = get('/_api/provbutiken/v1/products/p-linnetroja').body.product;
    assert.equal(get(`/_api/provbutiken/v1/products/${encodeURIComponent(byId.handle)}`).body.product.productId, 'p-linnetroja');
    assert.equal(get('/_api/provbutiken/v1/products/en-gammal-adress_LT-100').body.product.productId, 'p-linnetroja');
    assert.equal(get('/_api/provbutiken/v1/products/saknas_XX-1').status, 404);
    assert.equal(get('/_api/provbutiken/v1/products/a%2Fb').status, 404);
    // A detail passes the storefront adapter.
    const page = toPageProduct(byId, { apiUrl: (p) => p });
    assert.equal(page.variants.length, 5);
    assert.deepEqual(page.delivery, { shipping: true, pickup: true });
  });

  it('collections: published only, members in the collection\'s order', () => {
    const list = get('/_api/provbutiken/v1/collections').body.collections.map((c) => c.handle);
    assert.deepEqual(list, ['sommar', 'vinter', 'tom', 'kok']);
    const one = get('/_api/provbutiken/v1/collections/sommar').body;
    assert.deepEqual(one.products.map((p) => p.productId), ['p-linnetroja', 'p-kanvasvaska', 'p-fjarilstryck']);
    assert.equal(get('/_api/provbutiken/v1/collections/ext-kok').body.collection.handle, 'kok');
    assert.equal(get('/_api/provbutiken/v1/collections/utkast').status, 404);
    assert.deepEqual(get('/_api/provbutiken/v1/collections/tom?limit=1').body.products, []);
    assert.equal(toPageProducts(get('/_api/provbutiken/v1/collections/vinter?limit=1').body.products).length, 1);
  });

  it('pages and posts: published only, newest first, by kind', () => {
    const pages = get('/_api/provbutiken/v1/pages?kind=page').body.pages.map((p) => p.slug);
    assert.deepEqual(pages, ['kontakt', 'om-oss']);
    assert.equal(get('/_api/provbutiken/v1/pages/utkast').status, 404);
    assert.equal(get('/_api/provbutiken/v1/pages/om-oss').body.page.lang, 'sv-SE');
  });

  it('legal pages by key or by the address\'s last segment; the platform terms as the archived text', () => {
    assert.deepEqual(get('/_api/provbutiken/v1/legal').body.pages.map((p) => p.key), [
      'kopvillkor', 'angerratt', 'integritetspolicy', 'plattformsvillkor',
    ]);
    assert.equal(get('/_api/provbutiken/v1/legal/angerratt-och-returer').body.page.key, 'angerratt');
    const terms = get('/_api/provbutiken/v1/legal/plattformsvillkor').body.page;
    assert.equal(typeof JSON.parse(terms.text).terms, 'string');
    assert.equal(get('/_api/provbutiken/v1/legal/okand').status, 404);
  });

  it('no route that is not a storefront read', () => {
    assert.equal(get('/_api/provbutiken/v1/admin/products').status, 404);
    assert.equal(route(shops, 'POST', new URL('http://dev.invalid/_api/provbutiken/v1/products')).status, 404);
  });

  it('the middleware marks every answer and leaves other paths alone', () => {
    const api = createDevApi();
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; }, end: () => {} };
    api({ method: 'GET', url: '/_api/provbutiken/v1/storefront' }, res, () => assert.fail('handled'));
    assert.equal(res.statusCode, 200);
    assert.equal(headers['X-Storefront-Dev'], DEV_API_MARKER);
    let passed = false;
    api({ method: 'GET', url: '/provbutiken/' }, res, () => { passed = true; });
    assert.equal(passed, true);
  });
});

describe('the discount code in the dev API (CP8-DC)', () => {
  const post = (path, body) => route(shops, 'POST', new URL(path, 'http://dev.invalid'), { body });
  const ITEMS = [{ productId: 'p-linnetroja', quantity: 1 }];

  it('one invented shop has the add-on on, the other off', () => {
    assert.equal(get('/_api/provbutiken/v1/storefront').body.storefront.features.discountCodes, true);
    assert.equal(get('/_api/sportbutiken/v1/storefront').body.storefront.features.discountCodes, false);
  });

  it('the preview applies a code of the shop\'s table, normalised, and answers every other with the one body', () => {
    // 20 % of one Linnetröja (399 kr), as the server rounds: up to the öre.
    assert.deepEqual(post('/_api/provbutiken/v1/discount-codes/preview', { code: ' sommar20 ', items: ITEMS }), {
      body: { discount: { applies: true, code: 'SOMMAR20', discountMinor: 7_980 } },
      headers: undefined,
      status: 200,
    });
    // A fixed amount is clamped to the lines.
    assert.equal(post('/_api/provbutiken/v1/discount-codes/preview', { code: 'VINTER100', items: [{ productId: 'p-randstrumpor', quantity: 1 }] }).body.discount.discountMinor, 8_900);
    assert.deepEqual(post('/_api/provbutiken/v1/discount-codes/preview', { code: 'NOPE', items: ITEMS }).body, {
      discount: { applies: false, code: 'NOPE', discountMinor: 0 },
    });
    for (const body of [{ code: 'SOM MAR', items: ITEMS }, { code: 'SOMMAR20', items: [] }, undefined]) {
      assert.equal(post('/_api/provbutiken/v1/discount-codes/preview', body).status, 400);
    }
  });

  it('the checkout applies the code it is sent, and echoes one it does not know with 0', () => {
    const plain = post('/_api/provbutiken/v1/checkout', {}).body.checkout;
    assert.equal(plain.discountMinor, 0);
    const coded = post('/_api/provbutiken/v1/checkout', { discountCode: 'SOMMAR20' }).body.checkout;
    // 20 % of the fixture's 847 kr.
    assert.deepEqual(
      [coded.discountCode, coded.discountMinor, coded.totalMinor, coded.vatMinor],
      ['SOMMAR20', 16_940, plain.subtotalMinor + plain.shippingMinor - 16_940, 14_712],
    );
    const unknown = post('/_api/provbutiken/v1/checkout', { discountCode: 'nope' }).body.checkout;
    assert.deepEqual([unknown.discountCode, unknown.discountMinor, unknown.totalMinor], ['NOPE', 0, plain.totalMinor]);
  });

  it('the buyer\'s order carries totals.discountCode, null without a code', () => {
    const { body } = get('/_api/provbutiken/v1/orders/8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d');
    assert.equal(body.order.totals.discountCode, null);
  });

  it('the middleware reads a write\'s JSON body and hands it on', async () => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/_api/provbutiken/v1/discount-codes/preview' });
    const headers = {};
    let ended;
    const done = new Promise((resolve) => {
      ended = resolve;
    });
    const res = { setHeader: (k, v) => { headers[k] = v; }, end: (text) => ended(text) };
    createDevApi()(req, res, () => assert.fail('handled'));
    req.emit('data', Buffer.from(JSON.stringify({ code: 'vinter100', items: [{ productId: 'p', quantity: 1 }] })));
    req.emit('end');
    // An id the dev catalogue does not know prices at 0: nothing to discount.
    assert.deepEqual(JSON.parse(await done), { discount: { applies: false, code: 'VINTER100', discountMinor: 0 } });
    assert.equal(headers['X-Storefront-Dev'], DEV_API_MARKER);
  });

  it('a body that is not JSON, or too large, is no body', async () => {
    const read = async (chunks) => {
      const req = new EventEmitter();
      const body = readJsonBody(req);
      for (const chunk of chunks) req.emit('data', Buffer.from(chunk));
      req.emit('end');
      return body;
    };
    assert.equal(await read(['{not json']), undefined);
    assert.equal(await read(['x'.repeat(70_000)]), undefined);
    assert.deepEqual(await read(['{"a":', '1}']), { a: 1 });
  });
});

describe('the dev API is never part of the build', () => {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cloudflare', 'web', 'dist');
  it('no file of the last storefront build holds its marker or its fixtures', { skip: !existsSync(dist) && 'no build' }, () => {
    const walk = (dir) => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
    for (const file of walk(dist)) {
      const text = readFileSync(file, 'latin1');
      assert.equal(text.includes(DEV_API_MARKER), false, file);
      assert.equal(text.includes('/_dev/images/'), false, file);
    }
  });
});
