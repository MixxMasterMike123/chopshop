// The dev API's POD rows (unit FM): node --test src/admin-app/dev/pod-dev.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';
import { RENDER_MS, setPodClock } from './pod-dev.mjs';

let state;
let cookie;
let now;

function signIn(email = 'admin@example.com', password = 'dev-password-1') {
  const answer = route(state, 'POST', new URL('http://dev.invalid/_api/api/auth/sign-in/email'), {}, { email, password });
  return answer.setCookie.split(';')[0];
}

const call = (method, path, body = null, { shop = 'test-shop-a', extraCookie = '' } = {}) =>
  route(state, method, new URL(`http://dev.invalid/_api${path}`), { cookie: cookie + extraCookie, ...(shop ? { 'x-shop-id': shop } : {}) }, body);

function upload(bytes = Buffer.from('fake png bytes'), contentType = 'image/png') {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reserved = call('POST', '/v1/admin/objects', { contentType, kind: 'artwork_original', sha256, sizeBytes: bytes.length });
  assert.equal(reserved.status, 201);
  const objectId = reserved.body.object.objectId;
  assert.equal(call('PUT', `/v1/admin/objects/${objectId}/content`, { raw: bytes }).status, 200);
  return objectId;
}

beforeEach(() => {
  state = createState();
  cookie = signIn();
  now = 1_760_000_000_000;
  setPodClock(() => now);
});
afterEach(() => setPodClock(null));

describe('the guards', () => {
  it('no session or a shop the user may not use: the opaque 404', () => {
    const saved = cookie;
    cookie = '';
    assert.equal(call('GET', '/v1/admin/pod/artwork').status, 404);
    cookie = saved;
    assert.equal(call('GET', '/v1/admin/pod/artwork', null, { shop: 'test-shop-c' }).status, 404);
  });

  it('the scenario "dark": the profile and artwork routes are the opaque 404', () => {
    const extra = '; admin_dev_pod=dark';
    assert.equal(call('GET', '/v1/admin/pod/profiles', null, { extraCookie: extra }).status, 404);
    assert.equal(call('GET', '/v1/admin/pod/artwork', null, { extraCookie: extra }).status, 404);
  });
});

describe('the library', () => {
  it('summaries in the Worker\'s keys, newest first; no user id', () => {
    const { status, body } = call('GET', '/v1/admin/pod/artwork');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.artwork[0]).sort(), [
      'artworkId', 'createdAt', 'createdBySelf', 'effectiveDpi', 'heightPx', 'label', 'originalObjectId', 'profileId', 'rightsConfirmedAt', 'status', 'widthPx',
    ]);
    assert.equal(body.artwork[0].artworkId, 'art-fjall');
    assert.ok(!JSON.stringify(body).includes('user-tenant-admin'));
  });

  it('upload → 202 processing → ready after the render; the detail carries the preview', () => {
    const objectId = upload();
    assert.equal(call('POST', '/v1/admin/pod/artwork', { objectId, profileId: 'apparel_dtg' }).status, 400); // no rights
    const created = call('POST', '/v1/admin/pod/artwork', { objectId, profileId: 'apparel_dtg', rightsConfirmed: true, label: 'Logga' });
    assert.equal(created.status, 202);
    assert.equal(created.body.artwork.status, 'processing');
    const id = created.body.artwork.artworkId;
    assert.equal(call('GET', `/v1/admin/pod/artwork/${id}`).body.artwork.status, 'processing');
    now += RENDER_MS;
    const detail = call('GET', `/v1/admin/pod/artwork/${id}`).body;
    assert.equal(detail.artwork.status, 'ready');
    assert.match(detail.previewUrl, /^data:image\/png;base64,/);
    assert.equal(call('POST', '/v1/admin/pod/artwork', { objectId, profileId: 'apparel_dtg', rightsConfirmed: true }).status, 409);
  });

  it('a name with "avvisa" is rejected with a reason; with "misslyck" the render fails (list drops it, detail says failed)', () => {
    const r = call('POST', '/v1/admin/pod/artwork', { objectId: upload(Buffer.from('a')), profileId: 'apparel_dtg', rightsConfirmed: true, label: 'avvisa mig' }).body.artwork.artworkId;
    const f = call('POST', '/v1/admin/pod/artwork', { objectId: upload(Buffer.from('b')), profileId: 'apparel_dtg', rightsConfirmed: true, label: 'misslyckas' }).body.artwork.artworkId;
    now += RENDER_MS;
    const rejected = call('GET', `/v1/admin/pod/artwork/${r}`).body.artwork;
    assert.equal(rejected.status, 'rejected');
    assert.match(rejected.reasons[0].message, /DPI/);
    assert.ok(!call('GET', '/v1/admin/pod/artwork').body.artwork.some((a) => a.artworkId === f));
    assert.deepEqual(call('GET', `/v1/admin/pod/artwork/${f}`).body, { artwork: { artworkId: f, status: 'failed', reason: 'render_failed' }, previewUrl: null });
  });

  it('rename: the label only, trimmed; a bad body is 400', () => {
    assert.equal(call('PATCH', '/v1/admin/pod/artwork/art-fjall', { label: '  Ny logga ' }).body.artwork.label, 'Ny logga');
    assert.equal(call('PATCH', '/v1/admin/pod/artwork/art-fjall', { label: '' }).status, 400);
    assert.equal(call('PATCH', '/v1/admin/pod/artwork/art-fjall', { label: 'x', other: 1 }).status, 400);
    assert.equal(call('PATCH', '/v1/admin/pod/artwork/art-fjall', { label: null }).body.artwork.label, null);
  });

  it('delete: refused while any mapping names the artwork (even a removed one)', () => {
    assert.equal(call('DELETE', '/v1/admin/pod/artwork/art-fjall').status, 409);
    assert.equal(call('DELETE', '/v1/admin/pod/artwork/art-rygg').status, 204);
    assert.equal(call('DELETE', '/v1/admin/pod/artwork/art-rygg').status, 404);
  });
});

describe('printers, mappings and the quotes: one number', () => {
  it('the printers carry capabilities only', () => {
    const body = call('GET', '/v1/admin/pod/printers').body;
    const text = JSON.stringify(body);
    for (const hidden of ['hiddenPrices', 'blank', '6000', '38000', 'currency', 'tiers']) assert.ok(!text.includes(hidden), hidden);
    assert.ok(body.printers[0].capabilities.skus['DEV-TEE-BLK-S']);
  });

  it('the design quote: the two numbers, or a masked refusal', () => {
    const q = call('GET', '/v1/admin/pod/design-quote?printerId=dev-printer&sku=DEV-TEE-BLK-M&slots=front%2Cback');
    assert.deepEqual(Object.keys(q.body).sort(), ['currency', 'inkopMinor', 'priceFloorMinor']);
    assert.equal(q.body.inkopMinor, 14000);
    assert.equal(call('GET', '/v1/admin/pod/design-quote?printerId=dev-printer&sku=DEV-CAP-BLK&slots=front').body.error.code, 'sku_unavailable'); // unpriced, masked
    assert.equal(call('GET', '/v1/admin/pod/design-quote?printerId=dev-printer&sku=DEV-TEE-BLK-M&slots=left_sleeve').body.error.code, 'slot_not_printable');
    assert.equal(call('GET', '/v1/admin/pod/design-quote?printerId=dev-printer&sku=DEV-TEE-BLK-M&slots=front&x=1').status, 400);
  });

  it('a mapping: created 201 with the scope\'s quote; the product form\'s quote follows', () => {
    const made = call('POST', '/v1/admin/pod/mappings', { productId: 'prod-hoodie', artworkId: 'art-rygg', printerId: 'dev-printer', sku: 'DEV-HOOD-BLK-M', slots: ['back'] });
    assert.equal(made.status, 201);
    assert.deepEqual(Object.keys(made.body).sort(), ['currency', 'inkopMinor', 'mapping', 'priceFloorMinor']);
    const quote = call('GET', '/v1/admin/pod/quote?productId=prod-hoodie').body;
    assert.equal(quote.inkopMinor, made.body.inkopMinor);
    // the same tuple again: re-activated, 200
    assert.equal(call('POST', '/v1/admin/pod/mappings', { productId: 'prod-hoodie', artworkId: 'art-rygg', printerId: 'dev-printer', sku: 'DEV-HOOD-BLK-M', slots: ['back'] }).status, 200);
  });

  it('the refusals, in the Worker\'s order and codes', () => {
    const post = (body) => call('POST', '/v1/admin/pod/mappings', { productId: 'prod-tee', variantId: 'var-tee-vit-s', artworkId: 'art-fjall', printerId: 'dev-printer', sku: 'DEV-TEE-WHT-S', slots: ['front'], ...body });
    assert.equal(post({ artworkId: 'art-skarm' }).body.error.code, 'artwork_not_ready');
    assert.equal(post({ sku: 'NOPE' }).body.error.code, 'sku_unavailable');
    assert.equal(post({ slots: ['left_sleeve'] }).body.error.code, 'slot_not_printable');
    assert.equal(post({ printerId: 'other' }).body.error.code, 'printer_unavailable');
    assert.equal(post({ productId: 'prod-old' }).body.error.code, 'product_archived');
    assert.equal(post({ variantId: 'nope' }).status, 404);
    // a live product under the new floor: the sand tee on a hoodie article
    assert.equal(post({ variantId: 'var-tee-sand', sku: 'DEV-HOOD-BLK-M' }).body.error.code, 'price_below_floor');
    assert.equal(post({}).status, 201);
    assert.equal(post({ artworkId: 'art-gammal' }).body.error.code, 'slot_taken');
    assert.equal(post({ artworkId: 'art-gammal', sku: 'DEV-TEE-WHT-M', slots: ['back'] }).body.error.code, 'sku_mismatch');
  });

  it('removing a mapping leaves it inactive (still listed by the API, never twice an error)', () => {
    assert.equal(call('DELETE', '/v1/admin/pod/mappings/map-tee-svart-s').status, 204);
    assert.equal(call('DELETE', '/v1/admin/pod/mappings/map-tee-svart-s').status, 204);
    const m = call('GET', '/v1/admin/pod/mappings').body.mappings.find((x) => x.mappingId === 'map-tee-svart-s');
    assert.equal(m.status, 'inactive');
    assert.equal(call('DELETE', '/v1/admin/pod/mappings/nope').status, 404);
  });
});
