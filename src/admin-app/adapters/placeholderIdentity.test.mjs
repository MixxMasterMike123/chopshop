// CP9-OB: the placeholder identity texts and the identity an adoption of the
// legal pages requires, pure: node --test src/admin-app/adapters/placeholderIdentity.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { STORE } from '../../config/store.js';
import {
  PLACEHOLDER_IDENTITY_KEYS,
  PLACEHOLDER_IDENTITY_TEXTS,
  PLACEHOLDER_LOGO_URL,
  isPlaceholderAddress,
  isPlaceholderText,
  isRealAddress,
  isRealText,
  ownLogoUrl,
  withoutPlaceholderIdentity,
} from '../../utils/placeholderIdentity.js';
import { LEGAL_IDENTITY_LABELS, SUPPORT_EMAIL_BY_PLATFORM_LABEL, legalIdentityGaps } from '../../utils/legalIdentity.js';
import { LEGAL_IDENTITY_FIELDS, identityGapLabels } from './settings.js';

const WORKER = readFileSync(new URL('../../../cloudflare/src/legal/legal-identity.ts', import.meta.url), 'utf8');

// What the older admin stored as melodie-mc's own identity (the export of 2026-09-27).
const STORED_DEFAULTS = {
  shopName: 'Melodie MC',
  legalName: 'My Company',
  tagline: 'Quality products, delivered.',
  supportEmail: 'hello@example.com',
  address: 'My Company<br>123 Main Street<br>City',
  companyDescription: 'Quality products, delivered.',
  returnAddress: '',
};

const COMPLETE = {
  legalName: 'Melodie MC AB',
  address: 'Storgatan 1<br>123 45 Sundsvall',
  supportEmail: 'kundtjanst@melodie.se',
  sellerType: 'individual',
};

describe('the placeholder texts', () => {
  it('are the same list as the Worker\'s (cloudflare/src/legal/legal-identity.ts)', () => {
    const block = WORKER.slice(WORKER.indexOf('PLACEHOLDER_IDENTITY_TEXTS'), WORKER.indexOf('];', WORKER.indexOf('PLACEHOLDER_IDENTITY_TEXTS')));
    const worker = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(worker, [...PLACEHOLDER_IDENTITY_TEXTS]);
    // The address rule too.
    assert.match(WORKER, /@example\\\.\(com\|org\|net\|se\)\$/);
    // And the adopt rule's fields, in the Worker's order.
    const fields = WORKER.match(/LEGAL_IDENTITY_FIELDS = \[([^\]]+)\]/)[1];
    assert.deepEqual([...fields.matchAll(/"([^"]+)"/g)].map((m) => m[1]), [...LEGAL_IDENTITY_FIELDS]);
  });

  it('are no longer STORE\'s defaults: a new shop starts with the six fields empty', () => {
    for (const key of PLACEHOLDER_IDENTITY_KEYS) assert.equal(STORE[key], '', key);
    for (const value of Object.values(STORE)) {
      if (typeof value === 'string') assert.equal(isPlaceholderText(value), false, value);
    }
  });

  it('are recognised without tags, spaces and case, and only whole', () => {
    for (const text of PLACEHOLDER_IDENTITY_TEXTS) assert.equal(isPlaceholderText(text), true, text);
    assert.equal(isPlaceholderText('  my COMPANY '), true);
    assert.equal(isPlaceholderText('My Company<br/>\n123 Main Street<br>\nCity'), true);
    assert.equal(isPlaceholderText('<p>My Shop</p>'), true);
    assert.equal(isPlaceholderText('My Company AB'), false);
    assert.equal(isPlaceholderText(''), false);
    assert.equal(isPlaceholderText(null), false);
    assert.equal(isRealText('My Company AB'), true);
    assert.equal(isRealText(' <br> '), false);
    assert.equal(isRealText(undefined), false);
  });

  it('an address at a placeholder domain is not a real one', () => {
    for (const a of ['hello@example.com', 'X@EXAMPLE.SE', ' y@example.net ']) assert.equal(isPlaceholderAddress(a), true, a);
    for (const a of ['kundtjanst@butik.se', 'a@shop.example.com', 'a@example.test']) assert.equal(isPlaceholderAddress(a), false, a);
    assert.equal(isRealAddress('kundtjanst@butik.se'), true);
    assert.equal(isRealAddress('hello@example.com'), false);
    assert.equal(isRealAddress(''), false);
  });

  it('withoutPlaceholderIdentity empties exactly the stored defaults and keeps the rest', () => {
    assert.deepEqual(withoutPlaceholderIdentity(STORED_DEFAULTS), {
      shopName: 'Melodie MC',
      legalName: '',
      tagline: '',
      supportEmail: '',
      address: '',
      companyDescription: '',
      returnAddress: '',
    });
    // Any address at a placeholder domain, not only the shipped one.
    assert.equal(withoutPlaceholderIdentity({ supportEmail: 'info@example.se' }).supportEmail, '');
    assert.equal(withoutPlaceholderIdentity({ supportEmail: 'kundtjanst@butik.se' }).supportEmail, 'kundtjanst@butik.se');
    // A key that never had a default keeps even a placeholder-looking text.
    assert.deepEqual(withoutPlaceholderIdentity({ heroHeadline: 'My Shop', legalName: 'Kent AB' }), { heroHeadline: 'My Shop', legalName: 'Kent AB' });
    assert.deepEqual(withoutPlaceholderIdentity(undefined), {});
    // A new object: the input is not changed.
    const input = { legalName: 'My Company' };
    withoutPlaceholderIdentity(input);
    assert.equal(input.legalName, 'My Company');
  });

  it('the generic logo is no logo', () => {
    assert.equal(STORE.logoUrl, PLACEHOLDER_LOGO_URL);
    assert.equal(ownLogoUrl(PLACEHOLDER_LOGO_URL), '');
    assert.equal(ownLogoUrl(''), '');
    assert.equal(ownLogoUrl(undefined), '');
    assert.equal(ownLogoUrl('https://pub.example.r2.dev/logo.webp'), 'https://pub.example.r2.dev/logo.webp');
  });
});

describe('legalIdentityGaps: what the legal pages print and the identity lacks', () => {
  const keys = (identity, options) => legalIdentityGaps(identity, options).map((gap) => gap.key);

  it('a new shop lacks the legal name, the address and the support address', () => {
    assert.deepEqual(keys({ ...STORE }), ['legalName', 'address', 'supportEmail']);
    assert.deepEqual(keys({}), ['legalName', 'address', 'supportEmail']);
  });

  it('the older admin\'s stored defaults count as missing', () => {
    assert.deepEqual(keys(STORED_DEFAULTS), ['legalName', 'address', 'supportEmail']);
  });

  it('complete: nothing', () => {
    assert.deepEqual(keys(COMPLETE), []);
    assert.deepEqual(keys({ ...COMPLETE, sellerType: '' }), []);
    // An individual's pages print no VAT number, registered or not.
    assert.deepEqual(keys({ ...COMPLETE, vatRegistered: true }), []);
  });

  it('a company: the org number; a VAT-registered company: the VAT number too', () => {
    const company = { ...COMPLETE, sellerType: 'company' };
    assert.deepEqual(keys(company), ['orgNumber']);
    assert.deepEqual(keys({ ...company, vatRegistered: true }), ['orgNumber', 'vatNumber']);
    assert.deepEqual(keys({ ...company, orgNumber: '556677-8899', vatRegistered: true }), ['vatNumber']);
    assert.deepEqual(keys({ ...company, orgNumber: '556677-8899', vatRegistered: false }), []);
    assert.deepEqual(keys({ ...company, orgNumber: '556677-8899', vatRegistered: true, vatNumber: 'SE556677889901' }), []);
  });

  it('labels each gap in the seller\'s words; the support address says the platform sets it where it does', () => {
    assert.deepEqual(legalIdentityGaps({}), [
      { key: 'legalName', label: LEGAL_IDENTITY_LABELS.legalName },
      { key: 'address', label: LEGAL_IDENTITY_LABELS.address },
      { key: 'supportEmail', label: LEGAL_IDENTITY_LABELS.supportEmail },
    ]);
    assert.equal(legalIdentityGaps({}, { supportEmailByPlatform: true })[2].label, SUPPORT_EMAIL_BY_PLATFORM_LABEL);
    for (const label of [...Object.values(LEGAL_IDENTITY_LABELS), SUPPORT_EMAIL_BY_PLATFORM_LABEL]) {
      assert.doesNotMatch(label, /[—!]/, label);
    }
  });
});

describe('identityGapLabels: the Worker\'s refusal in the seller\'s words', () => {
  it('names the fields in the Worker\'s order, the support address as the platform\'s, an unknown name dropped', () => {
    assert.deepEqual(identityGapLabels(['supportEmail', 'legalName', 'nonsense']), [
      LEGAL_IDENTITY_LABELS.legalName,
      SUPPORT_EMAIL_BY_PLATFORM_LABEL,
    ]);
    assert.deepEqual(identityGapLabels(['vatNumber', 'orgNumber', 'address']), [
      LEGAL_IDENTITY_LABELS.address,
      LEGAL_IDENTITY_LABELS.orgNumber,
      LEGAL_IDENTITY_LABELS.vatNumber,
    ]);
    assert.deepEqual(identityGapLabels(undefined), []);
    assert.deepEqual(identityGapLabels('legalName'), []);
  });
});
