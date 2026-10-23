// The cart's discount code rules, under Node:
//   node --test src/storefront/adapters/*.test.mjs
// Invented data only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DISCOUNT_MESSAGES,
  LINK_MESSAGES,
  REF_MAX_AGE_MS,
  currentDiscountMinor,
  currentPreview,
  discountNoticeOf,
  hasRefParameter,
  previewCodes,
  refCodeFromSearch,
  searchWithoutRef,
  storedRef,
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

// ── CP13: the link's code ───────────────────────────────────────────────────

describe('the ?ref= landing', () => {
  it('reads one ref, normalised as the server reads a code', () => {
    assert.equal(refCodeFromSearch('?ref=anna10'), 'ANNA10');
    assert.equal(refCodeFromSearch('?utm=x&ref=%20Anna10%20'), 'ANNA10');
    assert.equal(refCodeFromSearch(''), null);
    assert.equal(refCodeFromSearch('?ref='), null);
    assert.equal(refCodeFromSearch('?ref=AN%20NA'), null, 'whitespace inside is not a code');
    assert.equal(refCodeFromSearch(`?ref=${'A'.repeat(21)}`), null, 'over 20');
    assert.equal(refCodeFromSearch('?ref=ab'), null, 'under 3');
    assert.equal(refCodeFromSearch('?ref=ANNA_10'), null, 'outside A-Z 0-9 -');
    assert.equal(refCodeFromSearch('?ref=ANNÅ10'), null, 'outside A-Z 0-9 -');
    assert.equal(refCodeFromSearch('?ref=anna-10'), 'ANNA-10');
    assert.equal(refCodeFromSearch(`?ref=${'A'.repeat(20)}`), 'A'.repeat(20));
    assert.equal(refCodeFromSearch('?ref=A&ref=B'), null, 'two codes are none (the server refuses two too)');
    assert.equal(refCodeFromSearch(undefined), null);
  });

  it('takes the parameter out of the address and keeps the others in their order', () => {
    assert.equal(hasRefParameter('?ref=ANNA10'), true);
    assert.equal(hasRefParameter('?ref='), true);
    assert.equal(hasRefParameter('?x=1'), false);
    assert.equal(searchWithoutRef('?ref=ANNA10'), '');
    assert.equal(searchWithoutRef('?a=1&ref=ANNA10&b=2'), '?a=1&b=2');
    assert.equal(searchWithoutRef('?ref=A&ref=B&a=1'), '?a=1');
    assert.equal(searchWithoutRef(''), '');
  });
});

describe('the stored link stamp', () => {
  const now = Date.UTC(2026, 9, 23, 12);
  it('keeps a well-shaped stamp for 30 days', () => {
    const at = now - REF_MAX_AGE_MS;
    assert.deepEqual(storedRef({ refCode: 'ANNA10', source: 'link', refAt: at }, now), { refCode: 'ANNA10', source: 'link', refAt: at });
    assert.deepEqual(storedRef({ refCode: 'ANNA10', source: 'link', refAt: at - 1 }, now), { refCode: null, source: null, refAt: null });
  });

  it('drops anything else', () => {
    const none = { refCode: null, source: null, refAt: null };
    for (const saved of [
      null,
      {},
      { refCode: 'ANNA10', refAt: now },
      { refCode: 'ANNA10', source: 'typed', refAt: now },
      { refCode: 'AN NA', source: 'link', refAt: now },
      { refCode: 'ANNA_10', source: 'link', refAt: now },
      { refCode: 'anna10', source: 'link', refAt: now },
      { refCode: 'ANNA10', source: 'link', refAt: String(now) },
      { refCode: 'ANNA10', source: 'link' },
    ]) {
      assert.deepEqual(storedRef(saved, now), none, JSON.stringify(saved));
    }
  });
});

describe('the preview of two codes', () => {
  it('asks with the codes the cart holds, and nothing without one', () => {
    assert.deepEqual(previewCodes('SOMMAR20', 'ANNA10'), { code: 'SOMMAR20', refCode: 'ANNA10' });
    assert.deepEqual(previewCodes(null, 'ANNA10'), { refCode: 'ANNA10' });
    assert.deepEqual(previewCodes('SOMMAR20', null), { code: 'SOMMAR20' });
    assert.equal(previewCodes(null, null), null);
    assert.equal(previewCodes('', ''), null);
  });

  it('a preview counts only for the codes it was asked for', () => {
    const preview = { applies: true, code: 'ANNA10', discountMinor: 2_990, typed: null, ref: 'ANNA10' };
    assert.equal(currentPreview(preview, null, 'ANNA10'), preview);
    assert.equal(currentPreview(preview, undefined, 'ANNA10'), preview);
    assert.equal(currentPreview(preview, 'SOMMAR20', 'ANNA10'), null);
    assert.equal(currentPreview(preview, null, null), null);
    assert.equal(currentPreview(null, null, 'ANNA10'), null);
    assert.equal(currentDiscountMinor(preview), 2_990);
    assert.equal(currentDiscountMinor({ ...preview, applies: false }), 0);
    assert.equal(currentDiscountMinor({ ...preview, discountMinor: 1.5 }), 0);
    assert.equal(currentDiscountMinor(null), 0);
  });
});

describe('the link notice', () => {
  const ref = 'ANNA10';
  it('the link applies: "Länkkod ANNA10 tillagd – rabatten visas i summeringen" (no percent: the preview names no rate)', () => {
    const preview = { applies: true, code: ref, discountMinor: 2_990, typed: null, ref };
    assert.deepEqual(discountNoticeOf(preview, { ref }), { kind: 'link_added', code: ref });
    assert.equal(LINK_MESSAGES.link_added[1].replace('{{code}}', ref), 'Länkkod ANNA10 tillagd – rabatten visas i summeringen');
    assert.equal('link_added_percent' in LINK_MESSAGES, false);
  });

  it('a typed code set aside for the link: "Länkkoden ANNA10 används i stället"', () => {
    const preview = { applies: true, code: ref, discountMinor: 2_990, typed: 'SOMMAR20', ref };
    assert.deepEqual(discountNoticeOf(preview, { typed: 'SOMMAR20', ref }), { kind: 'link_overridden', code: ref });
    assert.equal(LINK_MESSAGES.link_overridden[1].replace('{{code}}', ref), 'Länkkoden ANNA10 används i stället');
  });

  it('the typed code applies (the link is not live): nothing to say', () => {
    const preview = { applies: true, code: 'SOMMAR20', discountMinor: 5_980, typed: 'SOMMAR20', ref };
    assert.equal(discountNoticeOf(preview, { typed: 'SOMMAR20', ref }), null);
  });

  it('nothing applies: the typed code is named, a lone link code is not (a 0 % affiliate is attribution only)', () => {
    const typedPreview = { applies: false, code: 'NOPE', discountMinor: 0, typed: 'NOPE', ref };
    assert.deepEqual(discountNoticeOf(typedPreview, { typed: 'NOPE', ref }), { kind: 'not_applicable', code: 'NOPE' });
    const linkPreview = { applies: false, code: ref, discountMinor: 0, typed: null, ref };
    assert.equal(discountNoticeOf(linkPreview, { ref }), null);
    assert.equal(discountNoticeOf(null, { ref }), null);
  });

  it('an invalid ?ref= never replaces a live stamp (it reads as no code)', () => {
    const live = { refCode: 'ANNA10', source: 'link', refAt: Date.now() };
    const incoming = refCodeFromSearch('?ref=<script>');
    assert.equal(incoming, null);
    assert.deepEqual(storedRef(incoming === null ? live : { ...live, refCode: incoming }), live);
  });
});
