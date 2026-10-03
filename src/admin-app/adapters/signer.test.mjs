// node --test src/admin-app/adapters/signer.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLATFORM_SIGNER_LABEL, signerLabelOf } from './signer.js';

describe('signerLabelOf', () => {
  it('a person of the shop: the address, else the name', () => {
    assert.equal(signerLabelOf({ kind: 'admin', name: 'Anna', email: 'anna@shop.se' }), 'anna@shop.se');
    assert.equal(signerLabelOf({ kind: 'admin', name: 'Anna', email: null }), 'Anna');
  });
  it('a platform signer, as the shop is told of it (no name, no address): "Plattformen"', () => {
    assert.equal(PLATFORM_SIGNER_LABEL, 'Plattformen');
    assert.equal(signerLabelOf({ kind: 'platform', name: null, email: null }), 'Plattformen');
  });
  it('the platform console, which sees the person, reads the person', () => {
    assert.equal(signerLabelOf({ kind: 'platform', name: 'Mikael', email: 'm@platform.se' }), 'm@platform.se');
  });
  it('no one named: empty, so the page prints its own fallback', () => {
    assert.equal(signerLabelOf({ kind: 'admin', name: null, email: null }), '');
    assert.equal(signerLabelOf({ kind: 'admin', name: ' ', email: '' }), '');
    assert.equal(signerLabelOf(null), '');
    assert.equal(signerLabelOf('anna'), '');
  });
});
