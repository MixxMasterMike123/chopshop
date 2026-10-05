// node --test src/api/admin/checkoutReminders.test.mjs — the seller's switch of
// Övergiven kassa (CP9-AC): the calls, and the admin build's cart-recovery
// seam (admin-app/replacements/shopConfig.js) against a stubbed fetch.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import { getCheckoutReminders, putCheckoutReminders } from './checkoutReminders.js';
import { loadCartRecovery, saveCartRecovery } from '../../admin-app/replacements/shopConfig.js';

const realFetch = globalThis.fetch;
let calls;

const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const VIEW = {
  delayHours: 3,
  enabled: true,
  enabledAt: '2026-10-05T08:00:00.000Z',
  mailConfigured: false,
  queuedLast30Days: 2,
  updatedAt: '2026-10-05T08:00:00.000Z',
};

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
}

beforeEach(() => {
  calls = [];
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('the calls', () => {
  it('GET and PUT /v1/admin/checkout-reminders with the shop header; the body is the switch and the delay only', async () => {
    stubFetch(() => answer(200, { checkoutReminders: VIEW }));
    assert.deepEqual(await getCheckoutReminders(), VIEW);
    assert.deepEqual(await putCheckoutReminders({ delayHours: 3, enabled: true, extra: 1 }), VIEW);
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
      ['GET', '/_api/v1/admin/checkout-reminders'],
      ['PUT', '/_api/v1/admin/checkout-reminders'],
    ]);
    assert.equal(calls[1].init.headers['x-shop-id'], 'test-shop-a');
    assert.deepEqual(JSON.parse(calls[1].init.body), { delayHours: 3, enabled: true });
  });

  it('a refusal comes back as the error it is', async () => {
    stubFetch(() => answer(400, { error: { code: 'invalid_request', message: 'Request is not valid' } }));
    await assert.rejects(putCheckoutReminders({ delayHours: 0, enabled: true }), (error) => error.status === 400);
  });
});

describe("the admin build's cart-recovery seam", () => {
  it('loads the switch for the named shop, and {} while the add-on is off (the 404)', async () => {
    stubFetch(() => answer(200, { checkoutReminders: VIEW }));
    assert.deepEqual(await loadCartRecovery('test-shop-b'), VIEW);
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-b');
    stubFetch(() => answer(404, { error: { code: 'not_found', message: 'Route not found' } }));
    assert.deepEqual(await loadCartRecovery('test-shop-b'), {});
    stubFetch(() => answer(500, {}));
    await assert.rejects(loadCartRecovery('test-shop-b'));
  });

  it('saves { enabled, delayHours } (enabled strictly boolean) and resolves the stored switch', async () => {
    stubFetch(() => answer(200, { checkoutReminders: VIEW }));
    assert.deepEqual(await saveCartRecovery({ delayHours: 3, enabled: true }, 'test-shop-a'), VIEW);
    await saveCartRecovery({ delayHours: 1 }, 'test-shop-a');
    assert.deepEqual(JSON.parse(calls[0].init.body), { delayHours: 3, enabled: true });
    assert.deepEqual(JSON.parse(calls[1].init.body), { delayHours: 1, enabled: false });
  });
});
