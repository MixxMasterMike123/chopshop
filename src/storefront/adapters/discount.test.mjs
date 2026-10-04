// The cart's discount code rules, under Node:
//   node --test src/storefront/adapters/*.test.mjs
// Invented data only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DISCOUNT_MESSAGES,
  isDiscountCodeShape,
  normalizeDiscountCode,
  previewedDiscountMinor,
  previewOutcome,
  storedDiscountCode,
} from './discount.js';
import { ApiError } from '../../api/client.js';

describe('the code as the server reads it', () => {
  it('is trimmed and upper case', () => {
    assert.equal(normalizeDiscountCode('  sommar20 '), 'SOMMAR20');
    assert.equal(normalizeDiscountCode(null), '');
  });

  it('is 1 to 50 characters with no whitespace or control character inside', () => {
    assert.equal(isDiscountCodeShape('SOMMAR20'), true);
    assert.equal(isDiscountCodeShape('A'.repeat(50)), true);
    assert.equal(isDiscountCodeShape('SOMMAR-2026'), true);
    for (const code of ['', 'A'.repeat(51), 'SOM MAR', 'SOM\tMAR', 'SOM\u0007MAR', 'SOM\u0085MAR', 20, null]) {
      assert.equal(isDiscountCodeShape(code), false, JSON.stringify(code));
    }
  });

  it('a stored code is kept only when it has that shape', () => {
    assert.equal(storedDiscountCode('SOMMAR20'), 'SOMMAR20');
    for (const value of [undefined, null, '', 'A B', 7]) assert.equal(storedDiscountCode(value), null);
  });
});

describe("the preview's answer", () => {
  it('applies only with a whole positive amount', () => {
    assert.equal(previewOutcome({ discount: { applies: true, code: 'X', discountMinor: 500 } }), 'applies');
    for (const discount of [
      { applies: false, code: 'X', discountMinor: 0 },
      { applies: true, code: 'X', discountMinor: 0 },
      { applies: true, code: 'X', discountMinor: 1.5 },
      null,
    ]) {
      assert.equal(previewOutcome({ discount }), 'not_applicable');
    }
  });

  it('names a refusal: 400 the shape, 429 the limit, anything else unavailable', () => {
    assert.equal(previewOutcome({ error: new ApiError({ status: 400, code: 'invalid_request' }) }), 'invalid_format');
    assert.equal(previewOutcome({ error: new ApiError({ status: 429, code: 'rate_limited' }) }), 'rate_limited');
    for (const status of [0, 404, 422, 502]) {
      assert.equal(previewOutcome({ error: new ApiError({ status, code: 'x' }) }), 'unavailable', String(status));
    }
  });

  it('has words for every outcome, plain Swedish, no exclamation mark and no dash', () => {
    for (const outcome of ['applies', 'not_applicable', 'invalid_format', 'rate_limited', 'unavailable']) {
      const [key, fallback] = DISCOUNT_MESSAGES[outcome];
      assert.match(key, /^discount_code_/);
      assert.ok(!/[!–—]/.test(fallback), fallback);
    }
  });

  it('the cart shows the amount only for the code it holds, and only when it applies', () => {
    const preview = { applies: true, code: 'SOMMAR20', discountMinor: 16_940 };
    assert.equal(previewedDiscountMinor(preview, 'SOMMAR20'), 16_940);
    assert.equal(previewedDiscountMinor(preview, 'VINTER10'), 0);
    assert.equal(previewedDiscountMinor(preview, null), 0);
    assert.equal(previewedDiscountMinor({ ...preview, applies: false }, 'SOMMAR20'), 0);
    assert.equal(previewedDiscountMinor(null, 'SOMMAR20'), 0);
  });
});
