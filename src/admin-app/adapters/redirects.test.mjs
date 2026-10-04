// The forwards' adapter under Node (unit CP5-FL). The normal-form table is
// the Worker's own (cloudflare/test/redirects.test.ts), so the port is held
// to it.
//   node --test src/admin-app/adapters/redirects.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROBLEM_MESSAGES,
  compareUtf8,
  cursorOf,
  lookupCursorFor,
  normalizeStorefrontPath,
  redirectRefusalMessage,
  scanPage,
} from './redirects.js';

describe('normalizeStorefrontPath (the Worker\'s table)', () => {
  const normal = [
    ['/products/%F0%9F%98%80-tee', '/products/😀-tee'],
    ['/products/😀-tee', '/products/😀-tee'],
    ['/products/%f0%9f%98%80-tee', '/products/😀-tee'],
    ['/samling/år', '/samling/år'],
    ['/samling/%C3%A5r', '/samling/år'],
    ['/blogs/news/', '/blogs/news'],
    ['/blogs/news///', '/blogs/news'],
    ['/blogs/news?page=2#top', '/blogs/news'],
    ['/Blogs/News', '/Blogs/News'],
    ['/a%20b', '/a b'],
    ['/a+b', '/a+b'],
    ['/', '/'],
    ['/?q=1', '/'],
    ['/%3Fnot-a-query', '/?not-a-query'],
  ];
  for (const [raw, out] of normal) it(`${raw} → ${out}`, () => assert.equal(normalizeStorefrontPath(raw), out));

  it('refuses what the Worker refuses', () => {
    for (const raw of ['products/x', '', '/a//b', '//evil.test/x', '/a\\b', '/a%5Cb', '/a%2Fb', '/a/./b', '/a/../b',
      '/a/%2e%2e/b', '/%2E/b', '/a%E0%A4%A', '/100%-cotton', '/a%C3', '/a%00b', '/a\u0007b', '/a%C2%85b', `/${'a'.repeat(2048)}`, null]) {
      assert.equal(normalizeStorefrontPath(raw), null, String(raw));
    }
  });
});

describe('the lookup of one old address', () => {
  it('orders by UTF-8 bytes, as D1 does (not by UTF-16 units)', () => {
    assert.ok(compareUtf8('/a', '/b') < 0);
    assert.ok(compareUtf8('/a', '/ab') < 0);
    // U+FF5E (3 bytes EF BD 9E) sorts BEFORE U+1F600 (4 bytes F0 …) in UTF-8, after it in UTF-16.
    assert.ok(compareUtf8('/～', '/😀') < 0);
    assert.ok('/～' > '/😀');
  });

  it('starts just before the address: its prefix, as a cursor the Worker takes', () => {
    assert.equal(lookupCursorFor('/a'), cursorOf('/'));
    assert.equal(Buffer.from(lookupCursorFor('/products/😀'), 'base64url').toString('utf8'), '/products/');
    assert.equal(lookupCursorFor('/'), null);
    assert.equal(lookupCursorFor('x'), null);
    assert.equal(cursorOf('/å'), Buffer.from('/å').toString('base64url'));
  });

  it('found, absent once passed or at the end, else read on', () => {
    const rows = [{ fromPath: '/a' }, { fromPath: '/b' }, { fromPath: '/d' }];
    assert.deepEqual(scanPage(rows, 'c', '/b'), { state: 'found', row: { fromPath: '/b' } });
    assert.deepEqual(scanPage(rows, 'c', '/c'), { state: 'absent' });
    assert.deepEqual(scanPage(rows, 'c', '/e'), { state: 'next' });
    assert.deepEqual(scanPage(rows, null, '/e'), { state: 'absent' });
    assert.deepEqual(scanPage([], null, '/e'), { state: 'absent' });
  });
});

describe('refusals as Swedish sentences', () => {
  it('every reason the Worker gives has one', () => {
    for (const reason of ['invalid_path', 'reserved_path', 'same_path', 'duplicate', 'chain']) {
      assert.ok(PROBLEM_MESSAGES[reason], reason);
      assert.equal(redirectRefusalMessage({ code: 'refused_redirects', details: { problems: [{ index: 0, reason }] } }), PROBLEM_MESSAGES[reason]);
    }
    assert.match(redirectRefusalMessage({ code: 'conflict' }), /Ladda om sidan/);
    assert.match(redirectRefusalMessage({ code: 'network_error' }), /kunde inte nås/);
    assert.match(redirectRefusalMessage({ code: 'refused_redirects', details: {} }), /tog inte emot/);
  });
});
