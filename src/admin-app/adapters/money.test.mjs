// node --test src/admin-app/adapters/money.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { kronorToMinor, minorToKronor } from './money.js';

describe('money', () => {
  it('minor → kronor', () => {
    assert.equal(minorToKronor(12345), 123.45);
    assert.equal(minorToKronor(-50), -0.5);
    assert.equal(minorToKronor(1.5), null);
    assert.equal(minorToKronor(null), null);
    assert.equal(minorToKronor('100'), null);
  });

  it('kronor (typed) → minor, at most two decimals', () => {
    assert.equal(kronorToMinor('123,45'), 12345);
    assert.equal(kronorToMinor('1 299'), 129900);
    assert.equal(kronorToMinor('0.5'), 50);
    assert.equal(kronorToMinor('-10'), -1000);
    assert.equal(kronorToMinor(19.99), 1999);
    assert.equal(kronorToMinor(0.1 + 0.2), 30);
    for (const bad of ['1.234', 'abc', '', '1,2,3', NaN, null, 1.005]) assert.equal(kronorToMinor(bad), null, String(bad));
  });
});
