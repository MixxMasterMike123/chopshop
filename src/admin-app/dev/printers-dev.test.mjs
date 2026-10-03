// The dev API's printer rows (unit FK), under Node:
//   node --test src/admin-app/dev/printers-dev.test.mjs
// Checked against the Worker's guards and refusals (pod-platform.ts,
// printers.ts, print-defaults.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';

const call = (state, method, path, { headers = {}, body = null } = {}) =>
  route(state, method, new URL(path, 'http://dev.invalid'), headers, body);

function platform(extraCookie = '') {
  const state = createState();
  const signIn = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'platform@example.com', password: 'dev-password-2' } });
  const cookie = signIn.setCookie.split(';')[0] + (extraCookie ? `; ${extraCookie}` : '');
  const go = (method) => (p, b = null, h = {}) => call(state, method, p, { headers: { cookie, ...h }, body: b });
  return { state, get: go('GET'), patch: go('PATCH'), put: go('PUT') };
}

const LIST = '/_api/v1/platform/printers';
const one = (p, id) => p.get(LIST).body.printers.find((x) => x.printerId === id);

describe('the guards', () => {
  it('signed out, a tenant admin and a request naming a shop get the opaque 404', () => {
    const state = createState();
    assert.equal(call(state, 'GET', LIST).status, 404);
    const admin = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'admin@example.com', password: 'dev-password-1' } });
    assert.equal(call(state, 'GET', LIST, { headers: { cookie: admin.setCookie.split(';')[0] } }).status, 404);
    assert.equal(platform().get(LIST, null, { 'x-shop-id': 'test-shop-a' }).status, 404);
  });
  it('the dark scenario answers 404 on every printer route', () => {
    const p = platform('admin_dev_fk=dark');
    assert.equal(p.get(LIST).status, 404);
    assert.equal(p.put(`${LIST}/default`, { printerId: null }).status, 404);
    assert.equal(p.patch(`${LIST}/fake-printer`, { status: 'inactive' }).status, 404);
  });
});

describe('the list', () => {
  it('every printer, ordered by id, with its tiers and the default', () => {
    const { status, body } = platform().get(LIST);
    assert.equal(status, 200);
    assert.deepEqual(body.printers.map((x) => x.printerId), ['fake-printer', 'handtryck-exempel', 'supplier-import']);
    assert.equal(body.defaultPrinterId, 'fake-printer');
    assert.equal(body.nextCursor, null);
    const fake = body.printers[0];
    assert.equal(fake.isDefault, true);
    assert.equal(fake.capabilitiesValid, true);
    assert.equal(fake.tiers.length, 3);
  });
  it('pages by cursor and refuses a bad query', () => {
    const p = platform();
    const first = p.get(`${LIST}?limit=2`).body;
    assert.equal(first.nextCursor, 'handtryck-exempel');
    assert.deepEqual(p.get(`${LIST}?limit=2&cursor=handtryck-exempel`).body.printers.map((x) => x.printerId), ['supplier-import']);
    for (const q of ['?limit=51', '?limit=0', '?cursor=Bad', '?status=active']) assert.equal(p.get(LIST + q).status, 400, q);
  });
  it('the empty and error scenarios', () => {
    assert.deepEqual(platform('admin_dev_fk=empty').get(LIST).body.printers, []);
    assert.equal(platform('admin_dev_fk=error').get(LIST).status, 500);
  });
});

describe('PATCH', () => {
  it('a status change bumps the revision and survives a re-read', () => {
    const p = platform();
    const answer = p.patch(`${LIST}/fake-printer`, { status: 'inactive', expectedRevision: 3 });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.printer.status, 'inactive');
    assert.equal(answer.body.printer.revision, 4);
    assert.deepEqual(answer.body.diff.fields, ['status']);
    assert.equal(one(p, 'fake-printer').status, 'inactive');
  });
  it('a stale revision is 409 revision_mismatch; an unknown printer 404; a malformed body 400', () => {
    const p = platform();
    assert.equal(p.patch(`${LIST}/fake-printer`, { status: 'inactive', expectedRevision: 2 }).body.error.code, 'revision_mismatch');
    assert.equal(p.patch(`${LIST}/no-such`, { status: 'inactive' }).status, 404);
    assert.equal(p.patch(`${LIST}/default`, { status: 'inactive' }).status, 404);
    for (const body of [{}, { status: 'paused' }, { currency: 'EUR' }, { tiers: {} }, { expectedRevision: 3 }]) {
      assert.equal(p.patch(`${LIST}/fake-printer`, body).status, 400, JSON.stringify(body));
    }
  });
  it('an api printer that is not this environment\'s target is refused (printer_not_allowed)', () => {
    const answer = platform().patch(`${LIST}/supplier-import`, { status: 'active' });
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error.code, 'printer_not_allowed');
  });
  it('tiers: upsert and remove; a removed price suspends its mapping; a tier of an unlisted SKU is refused', () => {
    const p = platform();
    const answer = p.patch(`${LIST}/fake-printer`, {
      tiers: { upsert: [{ sku: 'DEV-TEE-S', blankCostMinor: 5000, printCostsMinor: { front: 3000 } }], remove: ['DEV-HOOD-M'] },
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.diff.tiers, { added: [], changed: ['DEV-TEE-S'], removed: ['DEV-HOOD-M'] });
    assert.deepEqual(answer.body.diff.unpricedSkus, ['DEV-HOOD-M']);
    assert.equal(answer.body.suspendedMappings, 1);
    assert.equal(answer.body.diff.suspensions[0].reason, 'unpriced');
    const refused = p.patch(`${LIST}/fake-printer`, { tiers: { upsert: [{ sku: 'NOPE', blankCostMinor: 1, printCostsMinor: {} }] } });
    assert.equal(refused.body.error.code, 'invalid_tiers');
    assert.equal(p.patch(`${LIST}/fake-printer`, { tiers: { remove: ['DEV-HOOD-M'] } }).body.error.code, 'invalid_tiers');
  });
  it('capabilities: the whole document; a frame removed suspends the mapping that prints there', () => {
    const p = platform();
    const caps = structuredClone(one(p, 'fake-printer').capabilities);
    delete caps.models.garment_tee.printAreasMm.back;
    const answer = p.patch(`${LIST}/fake-printer`, { capabilities: caps, expectedRevision: 3 });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.diff.models.changed, ['garment_tee']);
    assert.equal(answer.body.diff.suspensions[0].reason, 'slot_not_printable');
    const bad = structuredClone(caps);
    bad.models.garment_tee.printAreasMm.front.w = 280.5;
    assert.equal(p.patch(`${LIST}/fake-printer`, { capabilities: bad }).status, 400);
  });
  it('the floor scenario reports products under the floor', () => {
    const answer = platform('admin_dev_fk=floor').patch(`${LIST}/fake-printer`, { tiers: { upsert: [{ sku: 'DEV-TEE-S', blankCostMinor: 9000, printCostsMinor: { front: 3300, back: 3300 } }] } });
    assert.equal(answer.body.diff.belowFloor.count, 2);
  });
});

describe('the default printer', () => {
  it('sets, clears, and refuses an inactive, unknown or malformed one', () => {
    const p = platform();
    assert.equal(p.put(`${LIST}/default`, { printerId: null }).body.defaultPrinter.printerId, null);
    assert.equal(p.get(LIST).body.defaultPrinterId, null);
    assert.equal(p.put(`${LIST}/default`, { printerId: 'fake-printer' }).body.defaultPrinter.printerActive, true);
    assert.equal(p.put(`${LIST}/default`, { printerId: 'handtryck-exempel' }).body.error.code, 'printer_inactive');
    assert.equal(p.put(`${LIST}/default`, { printerId: 'no-such' }).body.error.code, 'printer_not_found');
    for (const body of [{}, { printerId: 'default' }, { printerId: 5 }, { printerId: null, x: 1 }]) {
      assert.equal(p.put(`${LIST}/default`, body).status, 400, JSON.stringify(body));
    }
  });
});
