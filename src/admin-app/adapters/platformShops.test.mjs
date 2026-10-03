// The platform console's shop shapes, under Node:
//   node --test src/admin-app/adapters/platformShops.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  API_FEATURE_KEYS,
  commissionErrorMessage,
  featureMapOf,
  hasOpenGrant,
  inviteErrorText,
  legalReadinessFromSummary,
  pageStatusOf,
  previewUrlOf,
  provisionFeaturesOf,
  toDetailShop,
  toListShops,
} from './platformShops.js';

const DETAIL = {
  domains: [{ domainId: 'd1', hostname: 'a.import.invalid', kind: 'storefront', status: 'verified' }],
  domainsTruncated: false,
  features: [
    { key: 'pod', enabled: true, defaultEnabled: false, source: 'explicit' },
    { key: 'discountCodes', enabled: false, defaultEnabled: true, source: 'explicit' },
  ],
  settings: { returnAddressSet: true, vatAnswered: false },
  tenant: {
    tenantId: 'test-shop-a', shopName: 'Test Shop A', status: 'suspended', published: false,
    commissionBps: 400, supportEmail: 's@example.com', vatRateBp: 2500,
    connect: { accountId: 'acct_x', chargesEnabled: false, detailsSubmitted: false, payoutsEnabled: false, syncedAt: null },
  },
};

describe('status', () => {
  it('only active is active; suspended, provisioning and closed read as disabled', () => {
    assert.equal(pageStatusOf('active'), 'active');
    for (const s of ['suspended', 'provisioning', 'closed', undefined]) assert.equal(pageStatusOf(s), 'disabled');
  });
});

describe('the list', () => {
  it('maps the directory rows and sorts by name, else id', () => {
    const rows = toListShops([
      { tenantId: 'zeta', shopName: null, status: 'active', published: true },
      { tenantId: 'b', shopName: 'Alfa', status: 'closed', published: false },
      null,
    ]);
    assert.deepEqual(rows, [
      { id: 'b', name: 'Alfa', status: 'disabled', tenantStatus: 'closed', published: false },
      { id: 'zeta', name: null, status: 'active', tenantStatus: 'active', published: true },
    ]);
  });
  it('carries no count (the API has none)', () => {
    const [row] = toListShops([{ tenantId: 'a', shopName: 'A', status: 'active', published: true }]);
    assert.equal('counts' in row, false);
  });
});

describe('the detail', () => {
  it('maps the tenant, the commission and the Connect facts; the opt-in from the Connect view', () => {
    const shop = toDetailShop(DETAIL, { enabled: true, chargesEnabled: false, accountId: 'acct_x' });
    assert.equal(shop.id, 'test-shop-a');
    assert.equal(shop.status, 'disabled');
    assert.equal(shop.published, false);
    assert.deepEqual(shop.payments, { chargesEnabled: false, stripeAccountId: true, connectEnabled: true, commissionBps: 400 });
    assert.deepEqual(shop.legalSummary, { returnAddressSet: true, vatAnswered: false });
  });
  it('without a Connect view the shop reads "not invited"; a null commission stays null', () => {
    const shop = toDetailShop({ ...DETAIL, tenant: { ...DETAIL.tenant, commissionBps: null } }, null);
    assert.equal(shop.payments.connectEnabled, false);
    assert.equal(shop.payments.commissionBps, null);
  });
  it('the account id itself is not passed on', () => {
    const shop = toDetailShop(DETAIL, null);
    assert.equal(JSON.stringify(shop).includes('acct_x'), false);
  });
  it('the add-ons the API never names are explicitly off', () => {
    const map = featureMapOf(DETAIL.features);
    assert.equal(map.pod, true);
    assert.equal(map.discountCodes, false);
    for (const key of ['affiliate', 'b2b', 'campaigns', 'dining', 'ambassador', 'writers']) assert.equal(map[key], false);
  });
});

describe('legal readiness from the summary', () => {
  it('never reads ready: the adoption is not known here', () => {
    const r = legalReadinessFromSummary({ returnAddressSet: true, vatAnswered: true });
    assert.equal(r.ready, false);
    assert.deepEqual(r.blockers.map((b) => b.key), ['acceptanceUnknown']);
  });
  it('lists the missing return address and VAT answer', () => {
    const r = legalReadinessFromSummary({ returnAddressSet: false, vatAnswered: false });
    assert.deepEqual(r.blockers.map((b) => b.key), ['returnAddress', 'vatRegistered', 'acceptanceUnknown']);
    assert.equal(r.needsReacceptance, false);
  });
  it('the unknown adoption is not the "bad" acceptance key', () => {
    const r = legalReadinessFromSummary({});
    assert.equal(r.blockers.some((b) => b.key === 'acceptance'), false);
  });
});

describe('messages', () => {
  it('a refused commission names the cap; a closed shop and the network have their own', () => {
    assert.match(commissionErrorMessage({ status: 400, code: 'invalid_request' }), /tak/);
    assert.match(commissionErrorMessage({ status: 409, code: 'conflict' }), /stängd/);
    assert.match(commissionErrorMessage({ status: 0, code: 'network_error' }), /nås/);
    assert.equal(commissionErrorMessage({ status: 500 }), 'Kunde inte spara avgift.');
  });
  it('the invite failures', () => {
    assert.match(inviteErrorText({ status: 503, code: 'email_unavailable' }), /köas/);
    assert.match(inviteErrorText({ status: 404, code: 'not_found' }), /konfigurerade/);
    assert.match(inviteErrorText({ status: 409, code: 'not_invitable' }), /bjudas in/);
  });
});

describe('provisioning', () => {
  it('sends only the keys the API allows', () => {
    const preset = { affiliate: true, campaigns: true, dining: false, discountCodes: true, abandonedCheckout: true, productReviews: true, contentStudio: false, marketingMaterials: false, b2b: false, pod: true };
    assert.deepEqual(provisionFeaturesOf(preset, API_FEATURE_KEYS), {
      abandonedCheckout: true, contentStudio: false, discountCodes: true, marketingMaterials: false, pod: true, productReviews: true,
    });
  });
});

describe('the preview', () => {
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  it('an open grant on that shop only', () => {
    const me = { actingAs: [{ tenantId: 'a', expiresAt: '2026-10-03T12:30:00.000Z' }, { tenantId: 'b', expiresAt: '2026-10-03T11:00:00.000Z' }] };
    assert.equal(hasOpenGrant(me, 'a', now), true);
    assert.equal(hasOpenGrant(me, 'b', now), false);
    assert.equal(hasOpenGrant(me, 'c', now), false);
    assert.equal(hasOpenGrant(null, 'a', now), false);
  });
  it('the address is the storefront root with the grant in the fragment', () => {
    assert.equal(previewUrlOf('https://web.example.com', 'shop-a', 'g.1-x'), 'https://web.example.com/shop-a/#preview=g.1-x');
  });
});
