// The dev API's 3D-model rows (unit CP5-FO), under Node:
//   node --test src/admin-app/dev/models-dev.test.mjs
// Checked against the Worker's guards and refusals (pod-studio-assets.ts,
// studio-assets.ts, studio-files.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';
import { dimensions, png, sniff } from './models-dev.mjs';

const call = (state, method, path, { headers = {}, body = null } = {}) =>
  route(state, method, new URL(path, 'http://dev.invalid'), headers, body);

function platform(extraCookie = '') {
  const state = createState();
  const signIn = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'platform@example.com', password: 'dev-password-2' } });
  const cookie = signIn.setCookie.split(';')[0] + (extraCookie ? `; ${extraCookie}` : '');
  const go = (method) => (p, b = null, h = {}) => call(state, method, p, { headers: { cookie, ...h }, body: b });
  return { state, get: go('GET'), put: go('PUT'), patch: go('PATCH'), post: go('POST') };
}

const LIST = '/_api/v1/platform/pod/3d-models';
const FILES = '/_api/v1/platform/pod/studio-files';
const TEE = 'DevTeeOnModel0000001';
const one = (p, id) => p.get(LIST).body.models.find((m) => m.modelId === id);
const strip = ({ modelId: _m, createdAt: _c, updatedAt: _u, ...body }) => body;
const upload = (p, bytes, type = 'image/png', extra = {}) =>
  p.post(FILES, { raw: bytes }, { 'content-type': type, 'content-length': String(bytes.length), ...extra });
const gray = (w, h, v = 128) => png(w, h, () => [v, v, v]);

describe('the guards (dev-api.mjs): platform only, never with a shop', () => {
  it('signed out, a tenant admin and a request naming a shop get the opaque 404', () => {
    const state = createState();
    assert.equal(call(state, 'GET', LIST).status, 404);
    const admin = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'admin@example.com', password: 'dev-password-1' } });
    const cookie = admin.setCookie.split(';')[0];
    assert.equal(call(state, 'GET', LIST, { headers: { cookie } }).status, 404);
    assert.equal(call(state, 'PUT', `${LIST}/x`, { headers: { cookie }, body: {} }).status, 404);
    assert.equal(platform().get(LIST, null, { 'x-shop-id': 'test-shop-a' }).status, 404);
  });
});

describe('the list', () => {
  it('every model, inactive too, by label, with the files they name as data: addresses', () => {
    const { status, body } = platform().get(LIST);
    assert.equal(status, 200);
    assert.deepEqual(body.models.map((m) => [m.label, m.active]),
      [['Hoodie (ej kalibrerad)', true], ['Linne (utgått)', false], ['T-shirt på modell', true]]);
    assert.equal(Object.keys(body.files).length, 6);
    for (const file of Object.values(body.files)) {
      assert.match(file.url, /^data:image\/png;base64,/);
      assert.ok(file.width > 0 && file.height > 0);
    }
  });
  it('the empty and error scenarios', () => {
    assert.deepEqual(platform('admin_dev_fo=empty').get(LIST).body, { models: [], files: {} });
    assert.equal(platform('admin_dev_fo=error').get(LIST).status, 500);
  });
});

describe('PUT', () => {
  it('the same document → 200 changed:false; a change → 200; a new id → 201', () => {
    const p = platform();
    const tee = one(p, TEE);
    const same = p.put(`${LIST}/${TEE}`, strip(tee));
    assert.equal(same.status, 200);
    assert.equal(same.body.changed, false);
    const changed = p.put(`${LIST}/${TEE}`, { ...strip(tee), label: 'T-shirt (ny)' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.changed, true);
    assert.equal(one(p, TEE).label, 'T-shirt (ny)');
    const created = p.put(`${LIST}/NewModel01`, {
      label: 'Ny', views: { front: { w: null, h: null, printArea: { x: 0, y: 0, w: 0, h: 0 }, colorways: [] } },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.model.active, true); // the default
    assert.equal(created.body.model.views.front.printAreaMm, null);
  });

  it('refusals: shape (no reason), duplicate_colorway, file_not_found, not_registered; a bad id 404', () => {
    const p = platform();
    const tee = strip(one(p, TEE));
    assert.equal(p.put(`${LIST}/${TEE}`, { ...tee, blankCostSek: 1 }).body.error.reason, undefined);
    assert.equal(p.put(`${LIST}/${TEE}`, { ...tee, label: 'x'.repeat(81) }).status, 400);
    const cw = tee.views.front.colorways;
    assert.equal(p.put(`${LIST}/${TEE}`, { ...tee, views: { front: { ...tee.views.front, colorways: [cw[0], cw[0]] } } }).body.error.reason, 'duplicate_colorway');
    const missing = { ...cw[0], id: 'grå', photoFileId: '0f3d0000-0000-4000-8000-0000000000ff' };
    assert.equal(p.put(`${LIST}/${TEE}`, { ...tee, views: { front: { ...tee.views.front, colorways: [{ ...missing, id: 'gra' }] } } }).body.error.reason, 'file_not_found');
    // The tank's photo is 360 × 480; the tee's map 400 × 500: not one registered set.
    const tank = one(p, 'DevTankModel00000003').views.front.colorways[0];
    const mixed = { ...cw[0], id: 'mix', photoFileId: tank.photoFileId };
    assert.equal(p.put(`${LIST}/${TEE}`, { ...tee, views: { front: { ...tee.views.front, colorways: [mixed] } } }).body.error.reason, 'not_registered');
    assert.equal(p.put(`${LIST}/bad.id`, tee).status, 404);
  });

  it('the limit, refuse:<reason>, lost (done, 502), drop and unclear (not done, 502)', () => {
    const fresh = { label: 'Ny', views: { front: { w: null, h: null, printArea: { x: 0, y: 0, w: 0, h: 0 } } } };
    assert.equal(platform('admin_dev_fo=limit').put(`${LIST}/NewModel01`, fresh).body.error.code, 'limit_reached');
    assert.equal(platform('admin_dev_fo=refuse:not_registered').put(`${LIST}/NewModel01`, fresh).body.error.reason, 'not_registered');
    const lost = platform('admin_dev_fo=lost');
    assert.equal(lost.put(`${LIST}/NewModel01`, fresh).status, 502);
    assert.ok(one(lost, 'NewModel01'));
    const drop = platform('admin_dev_fo=drop');
    assert.equal(drop.put(`${LIST}/NewModel01`, fresh).status, 502);
    assert.equal(one(drop, 'NewModel01'), undefined);
    const unclear = platform('admin_dev_fo=unclear');
    assert.equal(unclear.put(`${LIST}/NewModel01`, fresh).status, 502);
    assert.equal(unclear.get(LIST).status, 500);
  });
});

describe('PATCH { active }', () => {
  it('flips, idempotent, refuses a bad body, 404 for an unknown id', () => {
    const p = platform();
    assert.equal(p.patch(`${LIST}/${TEE}`, { active: false }).body.changed, true);
    assert.equal(one(p, TEE).active, false);
    assert.equal(p.patch(`${LIST}/${TEE}`, { active: false }).body.changed, false);
    assert.equal(p.patch(`${LIST}/${TEE}`, { active: 'no' }).status, 400);
    assert.equal(p.patch(`${LIST}/${TEE}`, { active: true, label: 'x' }).status, 400);
    assert.equal(p.patch(`${LIST}/NoSuchModel`, { active: true }).status, 404);
  });
});

describe('POST studio-files', () => {
  it('a PNG → 201 with its size; the same bytes → 200, the same file', () => {
    const p = platform();
    const bytes = gray(30, 40);
    const first = upload(p, bytes);
    assert.equal(first.status, 201);
    assert.equal(first.body.file.width, 30);
    assert.equal(first.body.file.height, 40);
    assert.match(first.body.file.fileId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    const again = upload(p, bytes);
    assert.equal(again.status, 200);
    assert.equal(again.body.file.fileId, first.body.file.fileId);
  });

  it('refused by the bytes: not an allowed image, or not as stated; a length that lies; over 15 MiB', () => {
    const p = platform();
    assert.equal(upload(p, Buffer.from('GIF89a......'), 'image/png').body.error.reason, 'not_an_allowed_image');
    assert.equal(upload(p, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png').body.error.reason, 'not_an_allowed_image');
    assert.equal(upload(p, gray(4, 4), 'image/webp').body.error.reason, 'type_not_as_stated');
    assert.equal(upload(p, gray(4, 4), 'image/png', { 'content-length': '3' }).status, 400);
    assert.equal(upload(p, gray(4, 4), 'image/png', { 'content-length': String(15 * 1024 * 1024 + 1) }).status, 413);
  });

  it('the scenarios: dark 404, reject-file, lost (stored; the retry answers 200), drop (never stored)', () => {
    assert.equal(upload(platform('admin_dev_fo=dark'), gray(4, 4)).status, 404);
    assert.equal(upload(platform('admin_dev_fo=reject-file'), gray(4, 4)).body.error.reason, 'not_an_allowed_image');
    const lost = platform('admin_dev_fo=lost');
    assert.equal(upload(lost, gray(5, 5)).status, 502);
    assert.equal(upload(lost, gray(5, 5)).status, 200);
    const drop = platform('admin_dev_fo=drop');
    assert.equal(upload(drop, gray(5, 5)).status, 502);
    assert.equal(upload(drop, gray(5, 5)).status, 502);
  });
});

describe('the byte readers', () => {
  it('sniff and size: PNG, WebP (VP8, VP8L, VP8X), JPEG', () => {
    assert.equal(sniff(gray(3, 2)), 'image/png');
    assert.deepEqual(dimensions('image/png', gray(3, 2)), { width: 3, height: 2 });
    const riff = (chunk, tail) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.from(chunk), tail]);
    const vp8x = riff('VP8X', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0x3f, 0x06, 0, 0x7f, 0x0c, 0]));
    assert.equal(sniff(vp8x), 'image/webp');
    assert.deepEqual(dimensions('image/webp', vp8x), { width: 1600, height: 3200 });
    const lossy = riff('VP8 ', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x06, 0x80, 0x07]));
    assert.deepEqual(dimensions('image/webp', lossy), { width: 1600, height: 1920 });
    const bits = (1599) | (1919 << 14);
    const lossless = riff('VP8L', Buffer.concat([Buffer.from([0, 0, 0, 0, 0x2f]), Buffer.from(Uint32Array.of(bits).buffer)]));
    assert.deepEqual(dimensions('image/webp', lossless), { width: 1600, height: 1920 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0]);
    assert.equal(sniff(jpeg), 'image/jpeg');
    assert.deepEqual(dimensions('image/jpeg', jpeg), { width: 30, height: 20 });
  });
});
