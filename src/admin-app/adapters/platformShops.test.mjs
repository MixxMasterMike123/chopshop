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
  legalFactsOf,
  legalReadinessFromLegal,
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
    assert.equal('legalSummary' in shop, false, 'the readiness is the detail\'s `legal`, not the settings summary');
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

const ADMIN = { kind: 'admin', name: 'Anna', email: 'anna@shop.se' };
const LEGAL = {
  checkoutOpen: true,
  readiness: { returnAddress: true, vatAnswered: true, legalPagesAccepted: true, ready: true },
  pagesAdoption: { acceptedAt: '2026-10-01T09:30:00.000Z', templateVersion: 'v7', pages: ['angerratt', 'integritetspolicy', 'kopvillkor'], acceptedBy: ADMIN },
  terms: {
    currentVersion: 'v7', acceptedCurrent: true, gateOpen: true, inGrace: false, graceDeadline: null,
    latestAcceptance: { version: 'v7', acceptedAt: '2026-10-01T09:00:00.000Z', acceptedBy: { kind: 'platform', name: 'Mikael', email: 'm@platform.se' } },
  },
};

describe('legal facts and readiness from the detail\'s `legal`', () => {
  it('who adopted the pages and accepted the terms, and when, where the page reads them', () => {
    const shop = toDetailShop({ ...DETAIL, legal: LEGAL }, null);
    assert.deepEqual(shop.storeIdentity.legal.acceptance, { email: 'anna@shop.se', acceptedAt: '2026-10-01T09:30:00.000Z', templateVersion: 'v7' });
    assert.deepEqual(shop.platformTerms, { email: 'm@platform.se', acceptedAt: '2026-10-01T09:00:00.000Z', version: 'v7' });
    assert.equal(shop.legal, LEGAL);
  });
  it('a platform signer the console is not told the person of reads "Plattformen"', () => {
    const f = legalFactsOf({ ...LEGAL, terms: { ...LEGAL.terms, latestAcceptance: { ...LEGAL.terms.latestAcceptance, acceptedBy: { kind: 'platform', name: null, email: null } } } });
    assert.equal(f.platformTerms.email, 'Plattformen');
  });
  it('nothing adopted or accepted: the page\'s "Ej godkända" (no acceptedAt)', () => {
    const f = legalFactsOf({ ...LEGAL, pagesAdoption: null, terms: { ...LEGAL.terms, latestAcceptance: null } });
    assert.deepEqual(f.storeIdentity, {});
    assert.equal(f.platformTerms, null);
    assert.deepEqual(legalFactsOf(undefined), { legal: null, storeIdentity: {}, platformTerms: null });
  });
  it('ready is the checkout\'s own answer', () => {
    assert.deepEqual(legalReadinessFromLegal(LEGAL), { ready: true, blockers: [], missing: [], needsReacceptance: false });
    // a shop in the grace period: the checkout is open, no blocker
    assert.equal(legalReadinessFromLegal({ ...LEGAL, terms: { ...LEGAL.terms, acceptedCurrent: false, inGrace: true } }).ready, true);
  });
  it('names every missing part, in the order of the seller\'s own list', () => {
    const closed = {
      checkoutOpen: false,
      readiness: { returnAddress: false, vatAnswered: false, legalPagesAccepted: false, ready: false },
      pagesAdoption: null,
      terms: { ...LEGAL.terms, acceptedCurrent: false, gateOpen: false, latestAcceptance: null },
    };
    const r = legalReadinessFromLegal(closed);
    assert.equal(r.ready, false);
    assert.deepEqual(r.blockers.map((b) => b.key), ['platformTerms', 'returnAddress', 'vatRegistered', 'acceptance']);
    assert.equal(r.blockers[1].label, 'Returadress saknas');
  });
  it('ready follows checkoutOpen, not the pieces (one predicate with the checkout)', () => {
    assert.equal(legalReadinessFromLegal({ ...LEGAL, checkoutOpen: false }).ready, false);
  });
  it('a detail without `legal` is never ready', () => {
    const r = legalReadinessFromLegal(undefined);
    assert.equal(r.ready, false);
    assert.deepEqual(r.blockers.map((b) => b.key), ['acceptance']);
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
