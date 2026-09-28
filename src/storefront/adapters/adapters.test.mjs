// The storefront's adapters and replacements, under Node (no browser, no
// bundler):
//   node --test src/storefront/adapters/adapters.test.mjs
// Invented data only.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { skuOfProductPath, toPageProduct, toPageProducts } from './products.js';
import { toPageCollection } from './collections.js';
import { toFooterPages, toPagePage } from './pages.js';
import { toPageLegal, toPagePlatformTerms } from './legal.js';
import { toGateState } from './storefront.js';
import { getCardPrice } from '../replacements/productPricing.js';
import {
  buildMenuHref,
  getAllProductsUrl,
  getCategoryUrl,
  getCountryAwareUrl,
  getProductUrl,
} from '../replacements/productUrls.js';

const image = (name, extra = {}) => ({
  contentType: 'image/png',
  height: 800,
  objectId: `obj-${name}`,
  url: `https://images.example.test/shops/provbutiken/product_media/${name}.png`,
  width: 800,
  ...extra,
});

const SUMMARY = {
  productId: 'p-linne',
  sku: 'LT-100',
  name: 'Linnetröja',
  description: 'En tröja av linne.',
  priceMinor: 39900,
  currency: 'SEK',
  handle: 'linnetroja_LT-100',
  path: '/product/linnetroja_LT-100',
  image: { ...image('linne-1'), alt: 'Linnetröja framifrån' },
  lowestPriceMinor: 34900,
  isFromPrice: true,
  compareAtPriceMinor: 49900,
  featured: true,
  sortOrder: 3,
  category: 'Tröjor',
  tags: ['Nyhet', 'Sommar 2026'],
  swatches: [
    { label: 'Havsblå', image: { ...image('linne-bla'), alt: null } },
    { label: 'Sand', image: null },
  ],
};

const DETAIL = {
  ...SUMMARY,
  images: [
    { ...image('linne-1'), alt: null, variantId: null },
    { ...image('linne-2'), alt: null, variantId: null },
    { ...image('linne-bla'), alt: null, variantId: 'v-bla-s' },
  ],
  variants: [
    {
      variantId: 'v-bla-s',
      sku: 'LT-100-BLA-S',
      label: 'Havsblå / S',
      priceMinor: 34900,
      group: 'Havsblå',
      size: 'S',
      position: 0,
      image: { ...image('linne-bla'), alt: null },
      images: [{ ...image('linne-bla'), alt: null }],
    },
    {
      variantId: 'v-sand-m',
      sku: 'LT-100-SAND-M',
      label: 'Sand / M',
      priceMinor: 39900,
      group: 'Sand',
      size: 'M',
      position: 1,
      image: null,
      images: [],
    },
  ],
  pod: { previewUrls: ['/v1/storefront/pod-previews/p-linne/art-1'], printAreas: [] },
  allowShipping: true,
  allowPickup: false,
  isPersonalized: false,
  moreInfo: '<p>Tvättas i 40 grader.</p>',
  sizeGuide: 'S: 90 cm\nM: 96 cm',
  size: null,
  brand: 'Exempelmärket',
  eanCode: null,
  stock: null,
  launchDate: '2026-12-01',
};

describe('toPageProduct: a list answer', () => {
  const product = toPageProduct(SUMMARY);

  it('carries the ids, the address and the texts the pages read', () => {
    assert.equal(product.id, 'p-linne');
    assert.equal(product.productId, 'p-linne');
    assert.equal(product.sku, 'LT-100');
    assert.equal(product.name, 'Linnetröja');
    assert.equal(product.path, '/product/linnetroja_LT-100');
    assert.equal(product.description, 'En tröja av linne.');
    assert.deepEqual(product.descriptions, { b2c: 'En tröja av linne.' });
    assert.equal(product.category, 'Tröjor');
    assert.deepEqual(product.tags, ['Nyhet', 'Sommar 2026']);
    assert.equal(product.featured, true);
    assert.equal(product.sortOrder, 3);
  });

  it('turns minor units into kronor', () => {
    assert.equal(product.b2cPrice, 399);
    assert.equal(product.lowestPrice, 349);
    assert.equal(product.isFromPrice, true);
    assert.equal(product.compareAtPrice, 499);
  });

  it('turns the main image into its address, with no gallery', () => {
    assert.equal(product.b2cImageUrl, SUMMARY.image.url);
    assert.deepEqual(product.b2cImageGallery, []);
  });

  it('hands the card its variant hint as `variants`: label and image, no sku, no price', () => {
    assert.deepEqual(product.variants, [
      { group: 'Havsblå', label: 'Havsblå', image: SUMMARY.swatches[0].image.url, images: [] },
      { group: 'Sand', label: 'Sand', image: '', images: [] },
    ]);
  });

  it('carries no review count and no detail-only field', () => {
    for (const key of ['reviewCount', 'ratingSum', 'delivery', 'sizeGuide', 'weight', 'shipping', 'b2bPrice']) {
      assert.equal(key in product, false, key);
    }
  });

  it('is null for what is not a product', () => {
    assert.equal(toPageProduct(null), null);
    assert.equal(toPageProduct({ name: 'no id' }), null);
  });

  it('a product without an image has none, and nulls stay empty', () => {
    const bare = toPageProduct({ ...SUMMARY, image: null, compareAtPriceMinor: null, category: null, description: null, swatches: [] });
    assert.equal(bare.b2cImageUrl, null);
    assert.equal(bare.compareAtPrice, null);
    assert.equal(bare.category, null);
    assert.equal(bare.description, '');
    assert.deepEqual(bare.variants, []);
  });
});

describe('toPageProduct: a product answer', () => {
  const previews = [];
  const product = toPageProduct(DETAIL, {
    apiUrl: (path) => {
      previews.push(path);
      return `/_api/provbutiken${path}`;
    },
  });

  it('keeps the product\'s own images as main image and gallery; a variant\'s stay on the variant', () => {
    assert.equal(product.b2cImageUrl, image('linne-1').url);
    assert.deepEqual(product.b2cImageGallery, [image('linne-2').url]);
  });

  it('hands on the variant rail with prices in kronor and image addresses', () => {
    assert.deepEqual(product.variants[0], {
      variantId: 'v-bla-s',
      sku: 'LT-100-BLA-S',
      label: 'Havsblå / S',
      price: 349,
      group: 'Havsblå',
      size: 'S',
      position: 0,
      image: image('linne-bla').url,
      images: [image('linne-bla').url],
    });
    assert.equal(product.variants[1].image, '');
    assert.deepEqual(product.variants[1].images, []);
  });

  it('maps the delivery flags and the texts of the product page', () => {
    assert.deepEqual(product.delivery, { shipping: true, pickup: false });
    assert.equal(product.descriptions.b2cMoreInfo, '<p>Tvättas i 40 grader.</p>');
    assert.equal(product.sizeGuide, 'S: 90 cm\nM: 96 cm');
    assert.equal(product.launchDate, '2026-12-01');
    assert.equal(product.isPersonalized, false);
    assert.equal(product.brand, 'Exempelmärket');
    assert.equal(product.eanCode, null);
    assert.equal(product.stock, null);
    assert.equal(product.size, null);
  });

  it('reads the print previews of a POD product through apiUrl', () => {
    assert.equal(product.isPodProduct, true);
    assert.deepEqual(previews, ['/v1/storefront/pod-previews/p-linne/art-1']);
    assert.deepEqual(product.podPreviewUrls, ['/_api/provbutiken/v1/storefront/pod-previews/p-linne/art-1']);
  });

  it('a product with no own image shows its first visible image, and a plain product no previews', () => {
    const onlyVariantImages = toPageProduct({
      ...DETAIL,
      images: [{ ...image('linne-bla'), alt: null, variantId: 'v-bla-s' }],
      image: { ...image('linne-bla'), alt: null },
      pod: null,
    });
    assert.equal(onlyVariantImages.b2cImageUrl, image('linne-bla').url);
    assert.deepEqual(onlyVariantImages.b2cImageGallery, []);
    assert.equal(onlyVariantImages.isPodProduct, false);
    assert.deepEqual(onlyVariantImages.podPreviewUrls, []);
  });

  it('a variant without a group is not grouped (the page falls back to its flat picker)', () => {
    const flat = toPageProduct({ ...DETAIL, variants: [{ ...DETAIL.variants[0], group: null, size: null }] });
    assert.equal(flat.variants[0].group, null);
    assert.equal(flat.variants[0].size, null);
  });

  it('toPageProducts keeps the order and drops what is not a product', () => {
    const list = toPageProducts([SUMMARY, null, { ...SUMMARY, productId: 'p-2' }]);
    assert.deepEqual(list.map((p) => p.id), ['p-linne', 'p-2']);
  });
});

describe('the card price (storefront getCardPrice)', () => {
  it('prices a list product from the server\'s lowest price and "från"', () => {
    assert.deepEqual(getCardPrice(toPageProduct(SUMMARY)), { price: 349, isFrom: true, compareAt: 499, onSale: true });
  });

  it('a compare-at price not above the price is no sale', () => {
    const product = toPageProduct({ ...SUMMARY, compareAtPriceMinor: 30000, isFromPrice: false });
    assert.deepEqual(getCardPrice(product), { price: 349, isFrom: false, compareAt: null, onSale: false });
  });

  it('a product without the server\'s price is priced by the variants, as the Firebase module does', () => {
    const product = { b2cPrice: 100, variants: [{ price: 80 }, { price: 120 }] };
    assert.deepEqual(getCardPrice(product), { price: 80, isFrom: true, compareAt: null, onSale: false });
  });
});

describe('skuOfProductPath', () => {
  it('reads the sku after the last underscore of the handle', () => {
    assert.equal(skuOfProductPath('/product/linnetroja_LT-100'), 'LT-100');
    assert.equal(skuOfProductPath('/product/a_b_LT-100'), 'LT-100');
    assert.equal(skuOfProductPath('/product/r%C3%B6d-m%C3%B6ssa_RM-1'), 'RM-1');
  });

  it('is null for anything else', () => {
    for (const path of [null, undefined, '', '/product/', '/product/no-sku', '/product/trailing_', '/samling/x_y', '/product/%E0%A4%A_x']) {
      assert.equal(skuOfProductPath(path), null, String(path));
    }
  });
});

describe('toPageCollection', () => {
  const API = {
    handle: 'sommar',
    externalRef: null,
    title: 'Sommar',
    description: 'Lätta plagg.',
    image: image('sommar'),
    path: '/samling/sommar',
    featured: true,
    sortOrder: 2,
  };

  it('is a manual collection of exactly the products the API answered, in its order', () => {
    const products = toPageProducts([{ ...SUMMARY, productId: 'p-b' }, { ...SUMMARY, productId: 'p-a' }]);
    assert.deepEqual(toPageCollection(API, products), {
      id: 'sommar',
      handle: 'sommar',
      title: 'Sommar',
      description: 'Lätta plagg.',
      imageUrl: image('sommar').url,
      featured: true,
      sortOrder: 2,
      published: true,
      type: 'manual',
      productIds: ['p-b', 'p-a'],
    });
  });

  it('without products it holds none; without a cover or description, null', () => {
    const collection = toPageCollection({ ...API, image: null, description: null, sortOrder: null });
    assert.deepEqual(collection.productIds, []);
    assert.equal(collection.imageUrl, null);
    assert.equal(collection.description, null);
    assert.equal(collection.sortOrder, null);
    assert.equal(toPageCollection(null), null);
  });
});

describe('toPagePage and toFooterPages', () => {
  const API = {
    slug: 'om-oss',
    path: '/om-oss',
    kind: 'page',
    lang: 'sv-SE',
    title: 'Om oss',
    content: '<p>Vi syr.</p>',
    summary: null,
    metaTitle: null,
    metaDescription: 'Om butiken.',
    author: null,
    publishedAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    image: null,
  };

  it('hands on the texts as strings and the update time as a timestamp', () => {
    const page = toPagePage(API);
    assert.equal(page.title, 'Om oss');
    assert.equal(page.content, '<p>Vi syr.</p>');
    assert.equal(page.metaTitle, '');
    assert.equal(page.metaDescription, 'Om butiken.');
    assert.equal(page.updatedAt.toDate().toISOString(), '2026-09-01T10:00:00.000Z');
    assert.equal('attachments' in page, false);
  });

  it('an unreadable time is no time', () => {
    assert.equal(toPagePage({ ...API, updatedAt: 'not a time' }).updatedAt, null);
    assert.equal(toPagePage(null), null);
  });

  it('the footer keeps slug and title of every page that has both', () => {
    assert.deepEqual(
      toFooterPages([API, { ...API, slug: 'fragor', title: 'Frågor' }, { slug: '', title: 'x' }, { slug: 'y', title: '' }, null]),
      [
        { slug: 'om-oss', title: 'Om oss' },
        { slug: 'fragor', title: 'Frågor' },
      ],
    );
    assert.deepEqual(toFooterPages(undefined), []);
  });
});

describe('toPageLegal', () => {
  it('cleans the adopted text with the sanitizer the page hands in', () => {
    const cleaned = [];
    const legal = toPageLegal(
      {
        key: 'kopvillkor',
        path: '/legal/kopvillkor',
        title: 'Köpvillkor',
        html: '<h2>1. Säljare</h2><img src=x onerror=alert(1)>',
        adoptedAt: '2026-09-10T08:00:00.000Z',
      },
      { sanitize: (html) => { cleaned.push(html); return '<h2>1. Säljare</h2>'; } },
    );
    assert.deepEqual(cleaned, ['<h2>1. Säljare</h2><img src=x onerror=alert(1)>']);
    assert.deepEqual(legal, {
      title: 'Köpvillkor',
      html: '<h2>1. Säljare</h2>',
      ready: true,
      blockers: [],
      custom: {},
      adoptedAt: '2026-09-10T08:00:00.000Z',
    });
  });

  it('is null without a text or without a sanitizer (never uncleaned HTML)', () => {
    assert.equal(toPageLegal({ title: 'x' }, { sanitize: (h) => h }), null);
    assert.equal(toPageLegal({ title: 'x', html: '<p>x</p>' }), null);
  });
});

describe('toPagePlatformTerms', () => {
  const text = JSON.stringify({
    version: '2026-01-01',
    terms: 'Villkor av {{platform_legal_name}}, uppdaterade {{last_updated}}.',
    dpa: 'Avtal, uppdaterat {{last_updated}}.',
  });
  const render = (markdown) => `<p>${markdown}</p>`;

  it('renders the archived templates, dated by the version, as the page renders them', () => {
    const terms = toPagePlatformTerms(
      { key: 'plattformsvillkor', title: 'Plattformsvillkor', version: '2026-01-01', publishedAt: '2026-01-01T00:00:00.000Z', text },
      { render, dpaTitle: 'Personuppgiftsbiträdesavtal' },
    );
    assert.deepEqual(terms, {
      version: '2026-01-01',
      terms: { title: 'Plattformsvillkor', html: '<p>Villkor av {{platform_legal_name}}, uppdaterade 2026-01-01.</p>' },
      dpa: { title: 'Personuppgiftsbiträdesavtal', html: '<p>Avtal, uppdaterat 2026-01-01.</p>' },
    });
  });

  it('is null for a text not in the templates\' format', () => {
    for (const bad of ['not json', '{}', JSON.stringify({ terms: 'x' }), JSON.stringify(null)]) {
      assert.equal(toPagePlatformTerms({ title: 't', version: 'v', text: bad }, { render }), null, bad);
    }
    assert.equal(toPagePlatformTerms({ title: 't', version: 'v', text }), null);
  });
});

describe('toGateState', () => {
  it('maps every state of the storefront response to the gate\'s', () => {
    assert.deepEqual(toGateState({ status: 'loading' }), { status: 'checking', shop: null });
    assert.deepEqual(toGateState({ status: 'ready' }), { status: 'ok', shop: { status: 'active', published: true } });
    assert.deepEqual(toGateState({ status: 'not_found' }), { status: 'ok', shop: { status: 'disabled' } });
    assert.deepEqual(toGateState({ status: 'no_shop' }), { status: 'unknown', shop: null });
    assert.deepEqual(toGateState({ status: 'error' }), { status: 'ok', shop: null });
    assert.deepEqual(toGateState(undefined), { status: 'ok', shop: null });
  });
});

describe('the storefront\'s addresses (replacement productUrls), shared host', () => {
  beforeEach(() => {
    globalThis.location = { pathname: '/provbutiken/produkter', origin: 'https://web.example.test' };
  });
  afterEach(() => {
    delete globalThis.location;
  });

  it('puts the root in front of the API\'s product path', () => {
    assert.equal(getProductUrl(toPageProduct(SUMMARY)), '/provbutiken/product/linnetroja_LT-100');
  });

  it('builds the address of a product without a path as the Firebase module did', () => {
    assert.equal(getProductUrl({ name: { 'sv-SE': 'Röd Mössa' }, sku: 'RM-1' }), '/provbutiken/product/rod-mossa_RM-1');
  });

  it('builds the shop\'s own addresses under the root', () => {
    assert.equal(getCountryAwareUrl(''), '/provbutiken');
    assert.equal(getCountryAwareUrl('legal/kopvillkor'), '/provbutiken/legal/kopvillkor');
    assert.equal(getCategoryUrl('Tröjor & Toppar'), '/provbutiken/kategori/trojor-and-toppar');
    assert.equal(getAllProductsUrl(), '/provbutiken/produkter');
  });

  it('a menu entry goes where the API resolved it', () => {
    assert.equal(buildMenuHref({ type: 'collection', target: 'x', path: '/samling/sommar', url: null, label: 'S' }), '/provbutiken/samling/sommar');
    assert.equal(buildMenuHref({ type: 'url', target: 'https://example.test/', path: null, url: 'https://example.test/', label: 'U' }), 'https://example.test/');
    assert.equal(buildMenuHref({ type: 'tag', target: 'Nyhet' }), '/provbutiken/tagg/nyhet');
  });

  it('an address that names no shop links to the site\'s root', () => {
    globalThis.location = { pathname: '/admin/x' };
    assert.equal(getCountryAwareUrl('cart'), '/');
  });
});
