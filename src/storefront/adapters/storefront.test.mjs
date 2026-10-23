// The storefront body's affiliate sign-in link (CP13), under Node:
//   node --test src/storefront/adapters/*.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { affiliateLoginUrl } from './storefront.js';

describe('affiliateLoginUrl', () => {
  it("is the admin origin's /login, from the body only", () => {
    assert.equal(affiliateLoginUrl({ adminOrigin: 'https://admin.example.test' }), 'https://admin.example.test/login');
    assert.equal(affiliateLoginUrl({ adminOrigin: 'https://admin.example.test/' }), 'https://admin.example.test/login');
    assert.equal(affiliateLoginUrl({ adminOrigin: 'https://admin.example.test/x?y=1' }), 'https://admin.example.test/login');
  });

  it('no origin, or no web origin, gives no link', () => {
    for (const adminOrigin of [null, undefined, '', 'admin.example.test', 'javascript:alert(1)', 'ftp://admin.example.test', 42]) {
      assert.equal(affiliateLoginUrl({ adminOrigin }), null, String(adminOrigin));
    }
    assert.equal(affiliateLoginUrl(null), null);
  });
});
