import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADDRESS_COPY,
  addressErrorMessage,
  addressPreview,
  labelProblem,
  normalizeLabel,
} from './shopAddress.js';

test('normalizeLabel lowercases and trims what is typed', () => {
  assert.equal(normalizeLabel('  MelodieMC '), 'melodiemc');
  assert.equal(normalizeLabel(undefined), '');
});

test('labelProblem mirrors the API grammar (a–z 0–9 -, not first or last, 1–63, no xn--)', () => {
  for (const ok of ['melodiemc', 'melodie-mc', 'a', '9', 'x'.repeat(63)]) assert.equal(labelProblem(ok), null, ok);
  assert.equal(labelProblem(''), ADDRESS_COPY.empty);
  assert.equal(labelProblem('x'.repeat(64)), ADDRESS_COPY.tooLong);
  for (const bad of ['melodie_mc', 'melodie.mc', 'mälodie', '-a', 'a-', 'a b', 'A', 'xn--abc']) {
    assert.equal(labelProblem(bad), ADDRESS_COPY.invalid, bad);
  }
  // Reserved labels are the API's to refuse: the client does not keep a copy of the list.
  assert.equal(labelProblem('admin'), null);
});

test('addressPreview shows the full address under the configured base', () => {
  assert.equal(addressPreview('melodiemc', 'flippinstuff.se'), 'melodiemc.flippinstuff.se');
  assert.equal(addressPreview('', 'flippinstuff.se'), '….flippinstuff.se');
  assert.equal(addressPreview('melodiemc', null), null);
});

test('addressErrorMessage turns every API code into Swedish', () => {
  assert.equal(addressErrorMessage({ code: 'subdomain_taken' }), 'Adressen är upptagen. Välj en annan.');
  assert.equal(addressErrorMessage({ code: 'subdomain_reserved' }), ADDRESS_COPY.reserved);
  assert.equal(addressErrorMessage({ code: 'subdomain_invalid' }), ADDRESS_COPY.invalid);
  assert.equal(addressErrorMessage({ code: 'subdomains_off' }), ADDRESS_COPY.off);
  assert.equal(addressErrorMessage({ code: 'conflict' }), ADDRESS_COPY.failed);
  assert.equal(addressErrorMessage(new Error('network')), ADDRESS_COPY.failed);
});
