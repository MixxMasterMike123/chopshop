// The dev API's product rows (unit FC), under Node:
//   node --test src/admin-app/dev/products-dev.test.mjs
// The answers are the Worker's shapes, read back through the page adapter.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';
import { productFromDetail, productFromListItem } from '../adapters/product.js';

const call = (state, method, path, { headers = {}, body = null } = {}) =>
  route(state, method, new URL(path, 'http://dev.invalid'), headers, body);

function shopA() {
  const state = createState();
  const answer = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'admin@example.com', password: 'dev-password-1' } });
  const headers = { cookie: answer.setCookie.split(';')[0], 'x-shop-id': 'test-shop-a' };
  return { state, req: (method, path, body = null) => call(state, method, `/_api${path}`, { headers, body }) };
}

const skuFromName = (name) => String(name).toLowerCase().replace(/\s+/g, '-');

describe('the dev catalogue', () => {
  it('the list, as the page sees it: the archived product hidden', () => {
    const { req } = shopA();
    const list = req('GET', '/v1/admin/products?limit=100');
    assert.equal(list.status, 200);
    const page = list.body.products.map(productFromListItem).filter(Boolean);
    assert.ok(page.length >= 4);
    assert.equal(page.some((p) => p.sku === 'gammal-vara'), false);
  });

  it('the list carries variantCount (active only) and tags, as the page reads them', () => {
    const { req } = shopA();
    const items = req('GET', '/v1/admin/products?limit=100').body.products;
    const tee = items.find((p) => p.productId === 'prod-tee');
    assert.equal(tee.variantCount, 6);
    assert.deepEqual(items.find((p) => p.productId === 'prod-towel').tags, ['Linne', 'Nyhet']);
    const row = productFromListItem(tee);
    assert.equal(row.variants.length, 6);
    req('DELETE', '/v1/admin/products/prod-tee/variants/var-tee-svart-s'); // in use: deactivated, no longer counted
    assert.equal(req('GET', '/v1/admin/products?limit=100').body.products.find((p) => p.productId === 'prod-tee').variantCount, 5);
  });

  it('the rail product reads back as groups with sizes and images', () => {
    const { req } = shopA();
    const detail = req('GET', '/v1/admin/products/prod-tee');
    const p = productFromDetail(detail.body, { skuFromName });
    assert.deepEqual(p.variantGroups.map((g) => [g.label, g.sizes.join(',')]), [['Svart', 'S,M,L'], ['Vit', 'S,M'], ['Sand', '']]);
    assert.equal(p.variantGroups[0].images.length, 2);
    assert.equal(p.b2cImageGallery.length, 3);
  });

  it('the quote: three fields for a mapped product, 422 for one without', () => {
    const { req } = shopA();
    assert.deepEqual(Object.keys(req('GET', '/v1/admin/pod/quote?productId=prod-tee').body).sort(), ['currency', 'inkopMinor', 'priceFloorMinor']);
    assert.equal(req('GET', '/v1/admin/pod/quote?productId=prod-hoodie').status, 422);
  });

  it('the refusals: a taken sku, a variant on an order, a publish without a mapping, HTML', () => {
    const { req } = shopA();
    assert.equal(req('POST', '/v1/admin/products', { sku: 'kaffemugg', name: 'X', priceMinor: 100, currency: 'SEK' }).status, 409);
    assert.equal(req('DELETE', '/v1/admin/products/prod-tee/variants/var-tee-svart-s').body.outcome, 'deactivated');
    assert.equal(req('POST', '/v1/admin/products/prod-hoodie/publish').body.error.code, 'pod_mapping_missing');
    assert.equal(req('PATCH', '/v1/admin/products/prod-towel', { moreInfo: '<script>x</script>' }).status, 400);
    assert.equal(req('PATCH', '/v1/admin/products/prod-tee', { priceMinor: 100 }).body.error.code, 'price_below_floor');
  });

  it('an upload: reserve, the bytes, then the object in an image list', () => {
    const { req } = shopA();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reserved = req('POST', '/v1/admin/objects', { contentType: 'image/png', kind: 'product_media', sha256, sizeBytes: bytes.length });
    assert.equal(reserved.status, 201);
    const objectId = reserved.body.object.objectId;
    const put = req('PUT', `/v1/admin/objects/${objectId}/content`, { raw: bytes });
    assert.equal(put.status, 200);
    assert.match(put.body.object.url, /^data:image\/png;base64,/);
    const images = req('PUT', '/v1/admin/products/prod-mug/images', [{ objectId, variantId: null }]);
    assert.equal(images.status, 200);
    assert.equal(images.body.images[0].image.url, put.body.object.url);
    assert.equal(req('PUT', '/v1/admin/products/prod-mug/images', [{ objectId: 'nope' }]).body.error.reason, 'image_not_referencable');
  });
});
