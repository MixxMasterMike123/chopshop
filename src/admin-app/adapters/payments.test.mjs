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
  balanceFailure,
  balanceView,
  moneyText,
  payoutScheduleText,
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

describe('the balance panel (CP5-FP)', () => {
  // AdminPayments' own formatter for öre, which the panel's must match for SEK.
  const pageSek = (ore) => `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;

  it('money per currency: the page\'s formatter for SEK; a currency\'s own minor unit', () => {
    assert.equal(moneyText(1284050, 'sek'), pageSek(1284050));
    assert.equal(moneyText(-500, 'SEK'), pageSek(-500));
    assert.match(moneyText(4200, 'eur'), /^42,00\s€$/);
    assert.match(moneyText(500, 'jpy'), /500/);
    assert.equal(moneyText(1.5, 'sek'), '');
    assert.equal(moneyText(100, 'sekk'), '');
  });

  it('the payout schedule in plain Swedish', () => {
    assert.equal(payoutScheduleText({ interval: 'daily', delayDays: 7 }), 'Stripe betalar ut till ditt bankkonto varje dag. Pengar från en betalning hålls i 7 dagar innan de kan betalas ut.');
    assert.match(payoutScheduleText({ interval: 'weekly', weeklyAnchor: 'friday', delayDays: 1 }), /varje vecka, på fredagar\. .*1 dag innan/);
    assert.match(payoutScheduleText({ interval: 'monthly', monthlyAnchor: 15, delayDays: null }), /den 15 varje månad\.$/);
    assert.match(payoutScheduleText({ interval: 'manual', delayDays: 7 }), /^Utbetalningarna är manuella[^]*automatiskt\.$/);
    assert.match(payoutScheduleText(null), /inget utbetalningsschema/);
  });

  it('the view: SEK first, sums per currency, a negative available amount flagged', () => {
    const view = balanceView({
      available: [{ currency: 'eur', amountMinor: 4200 }, { currency: 'sek', amountMinor: -1500 }],
      pending: [{ currency: 'sek', amountMinor: 1000 }, { currency: 'sek', amountMinor: 500 }],
      payoutSchedule: null,
      retrievedAt: '2026-10-04T12:03:00.000Z',
    });
    assert.deepEqual(view.rows.map((r) => [r.currency, r.available, r.pending, r.negative]), [
      ['sek', pageSek(-1500), pageSek(1500), true],
      ['eur', moneyText(4200, 'eur'), moneyText(0, 'eur'), false],
    ]);
    assert.equal(view.negative, true);
    assert.ok(view.readAt.length > 0);
    assert.equal(balanceView({ available: 'x' }), null);
  });

  it('a failed read: no panel, quiet limits, Stripe down, other errors', () => {
    assert.equal(balanceFailure({ status: 404, code: 'not_found' }).state, 'none');
    assert.equal(balanceFailure({ status: 409, code: 'connect_account_missing' }).state, 'none');
    const limited = balanceFailure({ status: 429, code: 'rate_limited', retryAfterSeconds: 60 });
    assert.equal(limited.state, 'limited');
    assert.match(limited.message, /kan inte uppdateras just nu.*om 60 sekunder/);
    assert.match(balanceFailure({ status: 502, code: 'connect_unavailable' }).message, /kunde inte hämtas från Stripe just nu/);
    assert.equal(balanceFailure({ status: 0, code: 'network_error' }).state, 'error');
  });
});
