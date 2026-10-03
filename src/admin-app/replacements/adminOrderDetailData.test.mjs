// The order detail's refund outcome (CP5-FX, finding 3), under Node:
//   node --test src/admin-app/replacements/adminOrderDetailData.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from '../../api/admin/client.js';
import { REFUND_PENDING_MESSAGE, refundWholeOrder } from './adminOrderDetailData.js';

const realFetch = globalThis.fetch;
const ORDER_ID = '0a000000-0000-4000-8000-000000000001';
const ORDER = { id: ORDER_ID, refundableMinor: 69600 };

function answerWith(status, refund) {
  globalThis.fetch = async () => new Response(JSON.stringify({ refund }), { status });
}

beforeEach(() => setRequestShopId('test-shop-a'));
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('the whole-order refund, as the page announces it', () => {
  it('202 reserved (Stripe\'s outcome unknown) is pending, with the words to show, never "refunded"', async () => {
    answerWith(202, { refundId: 'r-1', amountMinor: 69600, state: 'reserved' });
    const outcome = await refundWholeOrder(ORDER_ID, ORDER);
    assert.equal(outcome.pending, true);
    assert.equal(outcome.message, REFUND_PENDING_MESSAGE);
    assert.match(outcome.message, /inte bekräftad/);
    assert.doesNotMatch(outcome.message, /återbetalad\b/i);
  });

  it('201 succeeded or submitted (Stripe has the refund) is done', async () => {
    for (const state of ['succeeded', 'submitted']) {
      answerWith(201, { refundId: 'r-1', amountMinor: 69600, state });
      const outcome = await refundWholeOrder(ORDER_ID, ORDER);
      assert.equal(outcome.pending, false, state);
      assert.equal(outcome.refund.state, state);
    }
  });

  it('201 failed (Stripe said no) is a refusal in words', async () => {
    answerWith(201, { refundId: 'r-1', amountMinor: 69600, state: 'failed' });
    await assert.rejects(refundWholeOrder(ORDER_ID, ORDER), (error) => typeof error.userMessage === 'string');
  });

  it('nothing refundable: nothing is sent', async () => {
    let sent = 0;
    globalThis.fetch = async () => {
      sent += 1;
      return new Response('{}', { status: 201 });
    };
    await assert.rejects(refundWholeOrder(ORDER_ID, { refundableMinor: 0 }));
    assert.equal(sent, 0);
  });
});
