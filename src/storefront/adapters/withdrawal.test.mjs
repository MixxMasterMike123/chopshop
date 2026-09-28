// The withdrawal function's shapes, under Node:
//   node --test src/storefront/adapters/*.test.mjs
// Invented data only.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { toWithdrawalRequest, toWithdrawalView, withdrawalErrorKind } from './withdrawal.js';
import { ApiError } from '../../api/client.js';
import { submitWithdrawal } from '../../api/withdrawal.js';

// The route's answer (cloudflare/src/commerce/withdrawals.ts WithdrawalAnswer).
const ACK = {
  consumerName: 'Test Köpare',
  contactEmail: 'kund@example.test',
  exemptItems: [],
  orderNumber: '20260928-ABCD2345',
  shopName: 'Testbutiken',
  statement: 'Jag, Test Köpare, ångrar härmed mitt köp av order 20260928-ABCD2345. Detta meddelande togs emot 2026-09-28T10:15:30.123Z.',
  submittedAt: '2026-09-28T10:15:30.123Z',
  withdrawnItems: [{ name: 'Testtröja', quantity: 2, sku: 'TT-M' }],
};

describe('toWithdrawalRequest', () => {
  it('sends the three facts the buyer states, trimmed', () => {
    assert.deepEqual(toWithdrawalRequest({ orderNumber: ' 20260928-ABCD2345 ', name: ' Test Köpare', contactEmail: 'kund@example.test ' }), {
      orderNumber: '20260928-ABCD2345',
      name: 'Test Köpare',
      contactEmail: 'kund@example.test',
    });
  });

  it('is the body the route takes', async () => {
    const realFetch = globalThis.fetch;
    globalThis.location = { pathname: '/testbutik/angra' };
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ withdrawal: { acknowledgement: ACK, alreadyReceived: false, eligible: true, reason: null } }), { status: 201 });
    };
    try {
      const answer = await submitWithdrawal(toWithdrawalRequest({ orderNumber: '20260928-ABCD2345', name: 'Test Köpare', contactEmail: 'kund@example.test' }));
      assert.equal(sent.url, '/_api/testbutik/v1/withdrawals');
      assert.deepEqual(sent.body, { orderNumber: '20260928-ABCD2345', statement: { name: 'Test Köpare', contactEmail: 'kund@example.test' } });
      assert.equal(answer.eligible, true);
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.location;
    }
  });
});

describe('toWithdrawalView', () => {
  it('shows the receipt of a received message, with the keys the page prints', () => {
    const view = toWithdrawalView({ acknowledgement: ACK, alreadyReceived: false, eligible: true, reason: null });
    assert.equal(view.refusal, null);
    assert.deepEqual(view.acknowledgement, {
      submittedAt: '2026-09-28T10:15:30.123Z',
      orderNumber: '20260928-ABCD2345',
      statement: ACK.statement,
      withdrawnItems: [{ name: 'Testtröja', sku: 'TT-M', quantity: 2 }],
    });
  });

  it('a second message shows the FIRST receipt, with its own time of receipt', () => {
    const view = toWithdrawalView({ acknowledgement: ACK, alreadyReceived: true, eligible: true, reason: null });
    assert.equal(view.acknowledgement.submittedAt, ACK.submittedAt);
  });

  it('shows the answer for an order without the right, as the page shows it today', () => {
    for (const reason of ['personalized_exempt', 'window_passed']) {
      assert.deepEqual(toWithdrawalView({ acknowledgement: ACK, alreadyReceived: false, eligible: false, reason }), {
        acknowledgement: null,
        refusal: reason,
      });
    }
    assert.equal(toWithdrawalView({ eligible: false, reason: null }).refusal, 'unknown');
  });

  it('shows nothing new for an answer it cannot read', () => {
    assert.deepEqual(toWithdrawalView(null), { acknowledgement: null, refusal: null });
    assert.deepEqual(toWithdrawalView({ eligible: true }), { acknowledgement: null, refusal: null });
  });
});

describe('withdrawalErrorKind', () => {
  afterEach(() => {});
  it("maps the route's refusals to the page's texts", () => {
    const kind = (status, code) => withdrawalErrorKind(new ApiError({ status, code, message: 'x' }));
    assert.equal(kind(404, 'not_found'), 'not_found');
    assert.equal(kind(429, 'rate_limited'), 'rate_limited');
    assert.equal(kind(400, 'invalid_request'), 'other');
    assert.equal(kind(0, 'network_error'), 'other');
    assert.equal(withdrawalErrorKind(undefined), 'other');
  });
});
