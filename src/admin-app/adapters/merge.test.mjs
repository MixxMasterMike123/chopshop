// node --test src/admin-app/adapters/merge.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeThree, sameValue } from './merge.js';

describe('sameValue', () => {
  it('objects by key, whatever their order; an undefined value is an absent key', () => {
    assert.equal(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
    assert.equal(sameValue({ a: 1, b: undefined }, { a: 1 }), true);
    assert.equal(sameValue({ a: 1 }, { a: 1, b: null }), false);
    assert.equal(sameValue([1, 2], [2, 1]), false);
    assert.equal(sameValue(1, '1'), false);
    assert.equal(sameValue(null, undefined), false);
  });
});

describe('mergeThree', () => {
  const base = { tagline: 'old', address: 'A', social: { facebook: '', instagram: '' }, menu: [1] };

  it('keeps the person\'s edits where the server did not move, and the server\'s where the person did not', () => {
    const mine = { ...base, tagline: 'mine' };
    const theirs = { ...base, address: 'B' };
    assert.deepEqual(mergeThree(mine, base, theirs), { value: { ...base, tagline: 'mine', address: 'B' }, lost: [] });
  });

  it('two edits of different fields of one object both stay', () => {
    const mine = { ...base, social: { facebook: 'f', instagram: '' } };
    const theirs = { ...base, social: { facebook: '', instagram: 'i' } };
    assert.deepEqual(mergeThree(mine, base, theirs).value.social, { facebook: 'f', instagram: 'i' });
  });

  it('a field both changed differently takes the server\'s, and is lost', () => {
    const mine = { ...base, tagline: 'mine', menu: [1, 2] };
    const theirs = { ...base, tagline: 'theirs', menu: [3] };
    const merged = mergeThree(mine, base, theirs);
    assert.equal(merged.value.tagline, 'theirs');
    assert.deepEqual(merged.value.menu, [3]);
    assert.deepEqual(merged.lost, [['tagline'], ['menu']]);
  });

  it('a field both changed alike is not lost', () => {
    const merged = mergeThree({ ...base, tagline: 'same' }, base, { ...base, tagline: 'same' });
    assert.deepEqual(merged.lost, []);
  });

  it('a key only the page has (not loaded, not stored) stays; a key the server removed goes unless edited', () => {
    const merged = mergeThree({ ...base, gone: 'x', local: 1 }, { ...base, gone: 'x' }, { ...base });
    assert.equal(merged.value.local, 1);
    assert.equal('gone' in merged.value, false);
  });
});
