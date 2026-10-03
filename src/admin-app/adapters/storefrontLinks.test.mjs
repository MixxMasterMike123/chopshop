// The admin pages' storefront links (CP5-FX, finding 9), under Node:
//   node --test src/admin-app/adapters/storefrontLinks.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectionPath,
  homePath,
  pagePath,
  storefrontLinkProps,
  storefrontUrl,
  withPreviewGrant,
} from './storefrontLinks.js';

const ORIGIN = 'https://storefront.example.com';
const GRANT = `v1.${Date.now() + 1_800_000}.${'a'.repeat(43)}`;

describe('the storefront addresses: the storefront\'s origin, the shop, the storefront\'s path', () => {
  it('the home, a content page, a collection', () => {
    assert.equal(storefrontUrl(ORIGIN, 'test-shop-a', homePath()), 'https://storefront.example.com/test-shop-a/');
    assert.equal(storefrontUrl(ORIGIN, 'test-shop-a', pagePath('om-oss')), 'https://storefront.example.com/test-shop-a/om-oss');
    assert.equal(storefrontUrl(ORIGIN, 'test-shop-a', collectionPath('hem-och-linne')), 'https://storefront.example.com/test-shop-a/samling/hem-och-linne');
  });

  it('never a path of the admin\'s own origin; a trailing slash of the origin is not doubled', () => {
    assert.equal(storefrontUrl(`${ORIGIN}/`, 'test-shop-a', '/x'), 'https://storefront.example.com/test-shop-a/x');
    assert.match(storefrontUrl(ORIGIN, 'test-shop-a', pagePath('kontakt')), /^https:\/\/storefront\.example\.com\//);
  });

  it('no shop, no address', () => {
    assert.equal(storefrontUrl(ORIGIN, null, '/'), null);
    assert.deepEqual(storefrontLinkProps({ origin: ORIGIN, shopId: null, published: true, path: '/', openPreview: () => {} }), {});
  });

  it('the preview address carries the grant in the fragment', () => {
    assert.equal(withPreviewGrant('https://storefront.example.com/test-shop-a/om-oss', GRANT), `https://storefront.example.com/test-shop-a/om-oss#preview=${GRANT}`);
  });
});

describe('a link of a published shop opens it; one of an unpublished shop opens its preview', () => {
  it('published: the plain address, nothing else', () => {
    const props = storefrontLinkProps({ origin: ORIGIN, shopId: 'test-shop-a', published: true, path: pagePath('om-oss'), openPreview: () => assert.fail('no preview') });
    assert.deepEqual(props, { href: 'https://storefront.example.com/test-shop-a/om-oss' });
  });

  it('unpublished (or not known yet): the click asks for the preview of the same place instead', () => {
    for (const published of [false, undefined]) {
      const opened = [];
      let prevented = false;
      const props = storefrontLinkProps({
        origin: ORIGIN, shopId: 'test-shop-a', published, path: collectionPath('tryck'), openPreview: (...args) => opened.push(args),
      });
      assert.equal(props.href, 'https://storefront.example.com/test-shop-a/samling/tryck');
      props.onClick({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true, 'the plain address (the not-found page) is not opened');
      assert.deepEqual(opened, [['test-shop-a', '/samling/tryck']]);
    }
  });
});
