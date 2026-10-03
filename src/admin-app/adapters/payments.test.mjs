// AdminPayments' shapes, under Node:
//   node --test src/admin-app/adapters/payments.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOGIN_LINK_ACTING_AS_REASON,
  connectErrorMessage,
  loginLinkRefusal,
  notEnabledPayments,
  payoutDelayOf,
  toPagePayments,
} from './payments.js';

const VIEW = {
  enabled: true,
  hasAccount: true,
  status: 'restricted',
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: ['external_account', 'individual.verification.document'],
  syncedAt: '2026-10-03T09:00:00.000Z',
};

describe('toPagePayments', () => {
  it('maps the seller view onto the five facts the page reads, and only those', () => {
    assert.deepEqual(toPagePayments(VIEW), {
      connectEnabled: true,
      connectStatus: 'restricted',
      stripeAccountId: true,
      chargesEnabled: false,
      requirementsDue: ['external_account', 'individual.verification.document'],
    });
  });

  it('never passes on a figure or an id the server might add', () => {
    const page = toPagePayments({
      ...VIEW,
      accountId: 'acct_invented',
      commissionBps: 500,
      feeMinor: 100,
      payoutDelayDays: 7,
      platformFeeRate: 0.05,
    });
    const text = JSON.stringify(page);
    for (const word of ['acct_', 'commission', 'fee', 'Fee', 'delay', 'platform', '500', '0.05']) {
      assert.equal(text.includes(word), false, word);
    }
    assert.equal(page.stripeAccountId, true);
  });

  it('no account: stripeAccountId false, status none', () => {
    const page = toPagePayments({ ...VIEW, hasAccount: false, status: 'none', requirementsDue: [] });
    assert.equal(page.stripeAccountId, false);
    assert.equal(page.connectStatus, 'none');
  });

  it('an unknown status reads none; flags only for a literal true', () => {
    const page = toPagePayments({ status: 'weird', enabled: 'yes', chargesEnabled: 1, requirementsDue: [1, 'x'] });
    assert.deepEqual(page, {
      connectEnabled: false,
      connectStatus: 'none',
      stripeAccountId: false,
      chargesEnabled: false,
      requirementsDue: ['x'],
    });
  });

  it('no view (the route answered 404) is "not enabled, no account"', () => {
    assert.deepEqual(toPagePayments(null), notEnabledPayments());
    assert.equal(notEnabledPayments().connectEnabled, false);
  });
});

describe('payoutDelayOf', () => {
  it('days stay days; null (Stripe default) is minimum', () => {
    assert.equal(payoutDelayOf({ payoutDelayDays: 7 }), 7);
    assert.equal(payoutDelayOf({ payoutDelayDays: 0 }), 0);
    assert.equal(payoutDelayOf({ payoutDelayDays: null }), 'minimum');
    assert.equal(payoutDelayOf(null), 'minimum');
  });
});

describe('loginLinkRefusal', () => {
  it('refused, with the reason, for a platform user (always acting as here)', () => {
    assert.equal(loginLinkRefusal({ isPlatform: true }), LOGIN_LINK_ACTING_AS_REASON);
  });
  it('the shop\'s own admin may open it', () => {
    assert.equal(loginLinkRefusal({ isPlatform: false }), '');
    assert.equal(loginLinkRefusal({}), '');
  });
});

describe('connectErrorMessage', () => {
  it('maps the API codes to Swedish', () => {
    assert.match(connectErrorMessage({ code: 'connect_unavailable', message: 'x' }), /Stripe kunde inte nås/);
    assert.match(connectErrorMessage({ code: 'connect_payout_delay_refused' }), /fördröjningen/);
    assert.match(connectErrorMessage({ code: 'rate_limited' }), /För många försök/);
  });
  it('falls back to the message, then a generic line', () => {
    assert.equal(connectErrorMessage({ code: 'other', message: 'Servern kunde inte nås' }), 'Servern kunde inte nås');
    assert.equal(connectErrorMessage(null), 'Något gick fel.');
  });
});
