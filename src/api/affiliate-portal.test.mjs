// The affiliate portal's client (CP13), under Node:
//   node --test src/api/*.test.mjs
// fetch is stubbed per test; nothing leaves the process. Invented data only.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AdminApiError } from './admin/client.js';
import {
  INVOICE_MAX_BYTES,
  acceptPortalTerms,
  getPayoutInvoice,
  getPortalMe,
  getPortalTerms,
  invoiceFileProblem,
  listPortalLedger,
  listPortalOrders,
  listPortalPayouts,
  onPortalSessionLost,
  portalRequest,
  requestPortalPayout,
  setPortalShopId,
  updatePortalProfile,
  uploadPortalInvoice,
} from './affiliate-portal.js';

const realFetch = globalThis.fetch;
let calls;
const answer = (status, body, headers = {}) =>
  new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const stub = (handler) => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
};

beforeEach(() => {
  calls = [];
  setPortalShopId('provbutik');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setPortalShopId(null);
  onPortalSessionLost(null);
});

describe('every request names the shop', () => {
  it('sends X-Shop-Id, same-origin, to the portal prefix', async () => {
    stub(() => answer(200, { affiliate: { code: 'ANNA10' } }));
    assert.deepEqual(await getPortalMe(), { code: 'ANNA10' });
    assert.equal(calls[0].url, '/_api/v1/affiliate/me');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(calls[0].init.headers['x-shop-id'], 'provbutik');
  });

  it('refuses without sending when no shop is chosen or the path is not the portal', async () => {
    stub(() => answer(200, {}));
    setPortalShopId(null);
    await assert.rejects(getPortalMe(), (e) => e instanceof AdminApiError && e.code === 'no_shop');
    setPortalShopId('provbutik');
    await assert.rejects(portalRequest('GET', '/v1/admin/shop'), (e) => e.code === 'bad_request');
    await assert.rejects(portalRequest('GET', '/v1/affiliate-terms'), (e) => e.code === 'bad_request');
    assert.equal(calls.length, 0);
  });
});

describe('the reads', () => {
  it('pages orders, ledger and payouts with cursor and limit', async () => {
    stub((url) => {
      if (url.includes('/orders')) return answer(200, { orders: [{ orderNumber: 'A-1' }], nextCursor: 'c2' });
      if (url.includes('/ledger')) return answer(200, { entries: [], nextCursor: null });
      return answer(200, { payouts: [{ payoutId: 'p1' }], nextCursor: null });
    });
    assert.deepEqual(await listPortalOrders({ limit: 10 }), { orders: [{ orderNumber: 'A-1' }], nextCursor: 'c2' });
    assert.deepEqual(await listPortalLedger({ cursor: 'x~1', limit: 50 }), { entries: [], nextCursor: null });
    assert.deepEqual(await listPortalPayouts(), { payouts: [{ payoutId: 'p1' }], nextCursor: null });
    assert.equal(calls[0].url, '/_api/v1/affiliate/orders?limit=10');
    assert.equal(calls[1].url, '/_api/v1/affiliate/ledger?cursor=x%7E1&limit=50');
    assert.equal(calls[2].url, '/_api/v1/affiliate/payouts');
  });

  it('downloads an invoice as a Blob by an escaped id', async () => {
    stub(() => new Response(new Uint8Array([37, 80, 68, 70, 45]), { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const blob = await getPayoutInvoice('p/1');
    assert.equal(calls[0].url, '/_api/v1/affiliate/payouts/p%2F1/invoice');
    assert.equal(calls[0].init.headers['x-shop-id'], 'provbutik');
    assert.equal(blob.size, 5);
  });
});

describe('the writes', () => {
  it('a payout request sends only what it was given', async () => {
    stub(() => answer(201, { payout: { payoutId: 'p1', status: 'requested' } }));
    assert.deepEqual(await requestPortalPayout({ amountMinor: 25_050, invoiceNumber: ' F-1 ', invoiceObjectId: 'obj-1' }), {
      payoutId: 'p1',
      status: 'requested',
    });
    await requestPortalPayout({ amountMinor: 1.5, invoiceNumber: '  ' });
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { amountMinor: 25_050, invoiceNumber: 'F-1', invoiceObjectId: 'obj-1' });
    assert.deepEqual(JSON.parse(calls[1].init.body), {});
  });

  it('a refused request carries the 409 code', async () => {
    stub(() => answer(409, { error: { code: 'payout_open', message: 'x' } }));
    await assert.rejects(requestPortalPayout({}), (e) => e instanceof AdminApiError && e.status === 409 && e.code === 'payout_open');
  });

  it('the profile is a PATCH and answers the new PortalMe', async () => {
    stub(() => answer(200, { affiliate: { name: 'Anna' } }));
    assert.deepEqual(await updatePortalProfile({ name: 'Anna' }), { name: 'Anna' });
    assert.equal(calls[0].init.method, 'PATCH');
    assert.equal(calls[0].url, '/_api/v1/affiliate/profile');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
  });

  it('the terms: read, then accept the version shown', async () => {
    stub((url) =>
      url.endsWith('/accept')
        ? answer(200, { terms: { version: '2026-10-22', accepted: true } })
        : answer(200, { terms: { version: '2026-10-22', accepted: false, text: 'Villkor' } }),
    );
    assert.equal((await getPortalTerms()).accepted, false);
    assert.equal((await acceptPortalTerms('2026-10-22')).accepted, true);
    assert.deepEqual(JSON.parse(calls[1].init.body), { version: '2026-10-22' });
  });
});

describe('the invoice upload', () => {
  const pdf = () => new File([new Uint8Array([37, 80, 68, 70, 45, 49])], 'faktura.pdf', { type: 'application/pdf' });

  it('reserves with the sha256 and size, then puts the bytes; resolves the object id', async () => {
    stub((url) => (url.endsWith('/objects') ? answer(201, { object: { objectId: 'obj-9' } }) : answer(200, { object: { objectId: 'obj-9', status: 'active' } })));
    assert.equal(await uploadPortalInvoice(pdf()), 'obj-9');
    const reserve = JSON.parse(calls[0].init.body);
    assert.equal(calls[0].url, '/_api/v1/affiliate/objects');
    assert.equal(reserve.contentType, 'application/pdf');
    assert.match(reserve.sha256, /^[0-9a-f]{64}$/);
    assert.equal(reserve.sizeBytes, 6);
    assert.equal(reserve.fileName, 'faktura.pdf');
    assert.equal(calls[1].url, '/_api/v1/affiliate/objects/obj-9/content');
    assert.equal(calls[1].init.method, 'PUT');
    assert.equal(calls[1].init.headers['content-type'], 'application/pdf');
    assert.equal(calls[1].init.headers['x-shop-id'], 'provbutik');
  });

  it('refuses before sending what cannot be the invoice', async () => {
    stub(() => answer(201, {}));
    assert.equal(invoiceFileProblem(pdf()), null);
    assert.equal(invoiceFileProblem(new File(['x'], 'bild.png', { type: 'image/png' })), 'not_pdf');
    assert.equal(invoiceFileProblem(new File(['x'], 'faktura.PDF', { type: '' })), null);
    assert.equal(invoiceFileProblem({ size: INVOICE_MAX_BYTES + 1, type: 'application/pdf', name: 'a.pdf' }), 'too_large');
    assert.equal(invoiceFileProblem(new File([], 'tom.pdf', { type: 'application/pdf' })), 'empty');
    await assert.rejects(uploadPortalInvoice(new File(['x'], 'bild.png', { type: 'image/png' })), (e) => e.code === 'invalid_file');
    assert.equal(calls.length, 0);
  });
});

describe('the lost session', () => {
  it('a 404 whose /v1/me is a 401 is "unauthenticated", and the handler is told once', async () => {
    let told = 0;
    onPortalSessionLost(() => {
      told += 1;
    });
    stub((url) => (url === '/_api/v1/me' ? answer(401, { error: { code: 'unauthenticated' } }) : answer(404, { error: { code: 'not_found' } })));
    await assert.rejects(getPortalMe(), (e) => e.status === 401 && e.code === 'unauthenticated');
    assert.equal(told, 1);
  });

  it('a 404 with the session alive stays a 404', async () => {
    stub((url) => (url === '/_api/v1/me' ? answer(200, { user: { id: 'u1' }, accountType: 'affiliate' }) : answer(404, { error: { code: 'not_found' } })));
    await assert.rejects(getPortalMe(), (e) => e.status === 404 && e.code === 'not_found');
  });
});
