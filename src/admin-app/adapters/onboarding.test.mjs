// The dashboard's "Kom igång" steps, pure: node --test src/admin-app/adapters/onboarding.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLATFORM_STEP_NOTE, onboardingComplete, onboardingSteps } from './onboarding.js';
import { notEnabledPayments, toPagePayments } from './payments.js';

// A brand-new shop, right after the terms gate (the dry run of 2026-10-04).
const NEW_SHOP = {
  status: {
    accepted: true,
    inGrace: false,
    identityMissing: ['legalName', 'address', 'supportEmail'],
    readiness: { legalPagesAccepted: false, ready: false, returnAddress: false, vatAnswered: false },
  },
  shop: { published: false },
  payments: notEnabledPayments(),
  products: [],
  pod: true,
};

const READY = {
  status: {
    accepted: true,
    inGrace: false,
    identityMissing: [],
    readiness: { legalPagesAccepted: true, ready: true, returnAddress: true, vatAnswered: true },
  },
  shop: { published: true },
  payments: toPagePayments({ enabled: true, hasAccount: true, chargesEnabled: true, status: 'complete' }),
  products: [{ published: true, takenDown: false, screeningStatus: 'approved' }],
  pod: true,
};

const step = (facts, key) => onboardingSteps(facts).find((s) => s.key === key);

describe('onboardingSteps', () => {
  it('six steps in the order a new shop meets them', () => {
    assert.deepEqual(onboardingSteps(NEW_SHOP).map((s) => s.key), ['terms', 'identity', 'legal', 'payments', 'product', 'live']);
  });

  it('a new shop: what the seller does, with its page; what only the platform does, said so', () => {
    const steps = onboardingSteps(NEW_SHOP);
    assert.deepEqual(steps.map((s) => s.state), ['done', 'todo', 'todo', 'platform', 'todo', 'platform']);
    assert.equal(
      step(NEW_SHOP, 'identity').text,
      'Fyll i juridiskt namn, adress, returadress och om butiken är momsregistrerad under Inställningar. Support-e-posten lägger plattformen in.',
    );
    assert.equal(step(NEW_SHOP, 'identity').to, '/admin/settings');
    assert.equal(step(NEW_SHOP, 'legal').to, '/admin/settings');
    assert.equal(step(NEW_SHOP, 'payments').text, 'Plattformen öppnar betalningar för butiken.');
    assert.equal(step(NEW_SHOP, 'product').to, '/admin/pod');
    assert.equal(step({ ...NEW_SHOP, pod: false }, 'product').to, '/admin/products');
    for (const s of steps) {
      if (s.state === 'platform') {
        assert.equal(s.note, PLATFORM_STEP_NOTE);
        assert.equal(s.to, undefined);
      }
      if (s.state === 'todo') assert.ok(s.to && s.linkLabel, s.key);
      if (s.state !== 'platform') assert.equal(s.note, undefined, s.key);
    }
  });

  it('the terms: open by acceptance or inside the grace', () => {
    assert.equal(step({ ...NEW_SHOP, status: { ...NEW_SHOP.status, accepted: false } }, 'terms').state, 'todo');
    assert.equal(step({ ...NEW_SHOP, status: { ...NEW_SHOP.status, accepted: false, inGrace: true } }, 'terms').state, 'done');
    assert.equal(step({ ...NEW_SHOP, status: null }, 'terms').state, 'todo');
  });

  it('the identity: the seller\'s facts first; the support address alone is the platform\'s', () => {
    const only = { ...READY, status: { ...READY.status, identityMissing: ['supportEmail'] } };
    assert.equal(step(only, 'identity').state, 'platform');
    assert.equal(step(only, 'identity').text, 'Plattformen lägger in butikens support-e-post.');
    const company = { ...READY, status: { ...READY.status, identityMissing: ['orgNumber', 'vatNumber'] } };
    assert.equal(step(company, 'identity').text, 'Fyll i organisationsnummer och momsregistreringsnummer under Inställningar.');
    const noReturn = { ...READY, status: { ...READY.status, readiness: { ...READY.status.readiness, returnAddress: false } } };
    assert.equal(step(noReturn, 'identity').text, 'Fyll i returadress under Inställningar.');
  });

  it('the payments, three states and Stripe\'s review', () => {
    assert.equal(step(NEW_SHOP, 'payments').state, 'platform');
    const invited = toPagePayments({ enabled: true, hasAccount: false, chargesEnabled: false, status: 'none' });
    assert.equal(step({ ...NEW_SHOP, payments: invited }, 'payments').state, 'todo');
    assert.equal(step({ ...NEW_SHOP, payments: invited }, 'payments').to, '/admin/payments');
    const started = toPagePayments({ enabled: true, hasAccount: true, chargesEnabled: false, status: 'restricted' });
    assert.equal(step({ ...NEW_SHOP, payments: started }, 'payments').text, 'Fyll i det som saknas i Stripes formulär under Utbetalningar.');
    const review = toPagePayments({ enabled: true, hasAccount: true, chargesEnabled: false, status: 'pending' });
    assert.equal(step({ ...NEW_SHOP, payments: review }, 'payments').state, 'waiting');
    assert.equal(step(READY, 'payments').state, 'done');
    // A live account charges whatever the invite flag says (the payment route keys on it).
    const live = toPagePayments({ enabled: false, hasAccount: true, chargesEnabled: true, status: 'complete' });
    assert.equal(step({ ...NEW_SHOP, payments: live }, 'payments').state, 'done');
  });

  it('the first product: none, held for the review, rejected, taken down, live', () => {
    const products = (list) => ({ ...NEW_SHOP, products: list });
    assert.equal(step(products([{ published: false, screeningStatus: null }]), 'product').state, 'todo');
    const held = step(products([{ published: true, screeningStatus: 'pending' }]), 'product');
    assert.equal(held.state, 'platform');
    assert.equal(held.text, 'Produkten är sparad och visas i butiken när plattformen har granskat den.');
    // 'blocked' is the server's word for a product screening refused.
    assert.equal(step(products([{ published: true, screeningStatus: 'blocked' }]), 'product').state, 'todo');
    assert.equal(step(products([{ published: true, screeningStatus: 'flagged' }]), 'product').state, 'done');
    assert.equal(step(products([{ published: true, screeningStatus: 'blocked' }, { published: true, screeningStatus: 'pending' }]), 'product').state, 'platform');
    assert.equal(step(products([{ published: true, screeningStatus: 'approved', takenDown: true }]), 'product').state, 'todo');
    assert.equal(step(products([{ published: true, screeningStatus: 'approved' }]), 'product').state, 'done');
    // A product that needs no review (not screened) is live.
    assert.equal(step(products([{ published: true, screeningStatus: null }]), 'product').state, 'done');
    assert.equal(step(products([{ published: true, screeningStatus: 'pending' }, { published: true, screeningStatus: 'approved' }]), 'product').state, 'done');
    assert.equal(step(products(undefined), 'product').state, 'todo');
  });

  it('live is the platform\'s go-live', () => {
    assert.equal(step(NEW_SHOP, 'live').state, 'platform');
    assert.equal(step(READY, 'live').state, 'done');
  });

  it('complete when every step is done; the copy holds no figure, dash or exclamation mark', () => {
    assert.equal(onboardingComplete(onboardingSteps(READY)), true);
    assert.equal(onboardingComplete(onboardingSteps(NEW_SHOP)), false);
    assert.equal(onboardingComplete(null), false);
    const variants = [NEW_SHOP, READY, { ...NEW_SHOP, pod: false }];
    for (const facts of variants) {
      for (const s of onboardingSteps(facts)) {
        for (const text of [s.title, s.text, s.note, s.linkLabel].filter(Boolean)) {
          assert.doesNotMatch(text, /[—!]|\d|kr\b|%/, text);
        }
      }
    }
  });
});
