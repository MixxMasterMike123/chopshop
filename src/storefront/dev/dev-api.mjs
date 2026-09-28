// The storefront's DEV API (CP4 brief F, "The dev API"): a middleware of the
// storefront's Vite dev server that answers the `/_api/<shop>/v1/…` routes a
// storefront page reads, from fixtures.json, in the API's exact shapes
// (cloudflare/src/catalog/public-catalog.ts, catalog/collections.ts,
// content/pages.ts, routes/public-legal.ts, storefront/public-storefront.ts).
// It lets a page be looked at before anything is deployed.
//
// INVENTED DATA ONLY: no product, name, text or image of a real shop, nothing
// of the earlier brand. The images are drawn here as SVG (`/_dev/images/…`).
//
// NEVER part of the build: vite.storefront.config.js imports this module only
// inside a plugin that applies to the dev server (`apply: 'serve'`), and only
// when no real API is proxied (STOREFRONT_API_ORIGIN unset). The marker below
// is in every answer; dev-api.test.mjs fails when a build holds it.
//
// Plain Node, no dependency: `route()` is a pure function of the fixtures and
// a request, tested by `node --test src/storefront/dev/dev-api.test.mjs`.
//
// Deliberately NOT here: the money routes (checkout, payment, receipt, order),
// the report and the withdrawal. They are builder F2's; F2 adds its rows to
// ROUTES below with its own fixtures.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONEY_ROUTES } from './money-api.mjs';

export const DEV_API_MARKER = 'storefront-dev-api-invented-data';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures.json');

// ── fixtures ────────────────────────────────────────────────────────────────

/** The shops of the fixture file; a shop with `extends` is a copy of another with its own keys on top. */
export function loadShops(file = FIXTURES) {
  const raw = JSON.parse(readFileSync(file, 'utf8')).shops;
  const shops = {};
  for (const [id, shop] of Object.entries(raw)) {
    const base = shop.extends ? raw[shop.extends] : {};
    const merged = { ...base, ...shop };
    if (shop.extends && shop.storefront) merged.storefront = { ...base.storefront, ...shop.storefront };
    delete merged.extends;
    shops[id] = merged;
  }
  return shops;
}

// ── shapes ──────────────────────────────────────────────────────────────────

// PublicProductSummary (public-catalog.ts): a detail is a summary plus these.
const SUMMARY_KEYS = [
  'category', 'compareAtPriceMinor', 'currency', 'description', 'featured', 'handle', 'image',
  'isFromPrice', 'lowestPriceMinor', 'name', 'path', 'priceMinor', 'productId', 'sku',
  'sortOrder', 'swatches', 'tags',
];
const COLLECTION_KEYS = ['description', 'externalRef', 'featured', 'handle', 'image', 'path', 'sortOrder', 'title'];
const PAGE_SUMMARY_KEYS = ['author', 'image', 'kind', 'path', 'publishedAt', 'slug', 'summary', 'title'];
const PAGE_DETAIL_KEYS = [...PAGE_SUMMARY_KEYS, 'content', 'lang', 'metaDescription', 'metaTitle', 'updatedAt'];

const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key] ?? null]));

/** The source's slugify (src/utils/productUrls.js) = the API's address key. */
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/&/g, '-and-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-');
}

// The display order: sort order (NULL last), name case-insensitive, id.
function displayOrder(a, b) {
  const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
  const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  const an = (a.name ?? a.title ?? '').toLowerCase();
  const bn = (b.name ?? b.title ?? '').toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  const ai = a.productId ?? a.handle ?? '';
  const bi = b.productId ?? b.handle ?? '';
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

// ── answers ─────────────────────────────────────────────────────────────────

const json = (status, body) => ({ status, body });
const notFound = (message = 'Route not found') => json(404, { error: { code: 'not_found', message } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });

/** Only these query parameters, each at most once; else null. */
function params(url, allowed) {
  const out = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || key in out) return null;
    out[key] = value;
  }
  return out;
}

/**
 * limit 1–max (default `fallback`); cursor "o<offset>". null when malformed.
 * `pageSize` (the dev server's STOREFRONT_DEV_PAGE_SIZE) answers fewer than
 * asked, so a page's walk to the end of a list can be seen at work.
 */
function page(query, fallback, max, pageSize = max) {
  const asked = query.limit === undefined ? fallback : Number(query.limit);
  if (!Number.isInteger(asked) || asked < 1 || asked > max) return null;
  const limit = Math.min(asked, pageSize);
  let offset = 0;
  if (query.cursor !== undefined) {
    if (!/^o\d{1,6}$/.test(query.cursor)) return null;
    offset = Number(query.cursor.slice(1));
  }
  return { limit, offset };
}

function slice(list, { limit, offset }) {
  const items = list.slice(offset, offset + limit);
  return { items, nextCursor: offset + limit < list.length ? `o${offset + limit}` : null };
}

const publicProducts = (shop) => (shop.products ?? []).filter((product) => product.public !== false);
const withoutFixtureKeys = ({ public: _hidden, ...product }) => product;

function productsList(shop, url, pageSize) {
  const query = params(url, ['tag', 'category', 'featured', 'cursor', 'limit']);
  if (query === null || (query.featured !== undefined && query.featured !== '1')) return invalid();
  const paging = page(query, 100, 100, pageSize);
  if (paging === null) return invalid();
  const list = publicProducts(shop)
    .filter((product) => query.tag === undefined || product.tags.some((tag) => slugify(tag) === query.tag))
    .filter((product) => query.category === undefined || slugify(product.category) === query.category)
    .filter((product) => query.featured === undefined || product.featured === true)
    .sort(displayOrder);
  const { items, nextCursor } = slice(list, paging);
  return json(200, { products: items.map((product) => pick(product, SUMMARY_KEYS)), nextCursor });
}

function productDetail(shop, ref) {
  const underscore = ref.lastIndexOf('_');
  const sku = underscore === -1 ? null : ref.slice(underscore + 1) || null;
  const product =
    publicProducts(shop).find((p) => p.productId === ref) ??
    publicProducts(shop).find((p) => p.handle === ref) ??
    (sku ? publicProducts(shop).find((p) => p.sku === sku) : undefined);
  return product ? json(200, { product: withoutFixtureKeys(product) }) : notFound('Product not found');
}

const publishedCollections = (shop) => (shop.collections ?? []).filter((c) => c.published === true);

function collectionsList(shop, url) {
  const query = params(url, ['cursor', 'limit']);
  const paging = query && page(query, 100, 100);
  if (!paging) return invalid();
  const { items, nextCursor } = slice([...publishedCollections(shop)].sort(displayOrder), paging);
  return json(200, { collections: items.map((c) => pick(c, COLLECTION_KEYS)), nextCursor });
}

function collectionDetail(shop, ref, url, pageSize) {
  const query = params(url, ['cursor', 'limit']);
  const paging = query && page(query, 24, 100, pageSize);
  if (!paging) return invalid();
  const collection =
    publishedCollections(shop).find((c) => c.handle === ref) ??
    publishedCollections(shop).find((c) => c.externalRef === ref);
  if (!collection) return notFound('Collection not found');
  const byId = new Map(publicProducts(shop).map((product) => [product.productId, product]));
  const members = collection.productIds.map((id) => byId.get(id)).filter(Boolean);
  const { items, nextCursor } = slice(members, paging);
  return json(200, {
    collection: pick(collection, COLLECTION_KEYS),
    products: items.map((product) => pick(product, SUMMARY_KEYS)),
    nextCursor,
  });
}

const publishedPages = (shop) =>
  (shop.pages ?? [])
    .filter((p) => p.status === 'published')
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));

function pagesList(shop, url, pageSize) {
  const query = params(url, ['kind', 'lang', 'cursor', 'limit']);
  if (query === null || (query.kind !== undefined && !['page', 'post'].includes(query.kind))) return invalid();
  const paging = page(query, 20, 100, pageSize);
  if (!paging) return invalid();
  const list = publishedPages(shop).filter((p) => query.kind === undefined || p.kind === query.kind);
  const { items, nextCursor } = slice(list, paging);
  return json(200, { pages: items.map((p) => pick(p, PAGE_SUMMARY_KEYS)), nextCursor });
}

function pageDetail(shop, slug, url) {
  if (params(url, ['lang']) === null) return invalid();
  const found = publishedPages(shop).find((p) => p.slug === slug);
  return found ? json(200, { page: pick(found, PAGE_DETAIL_KEYS) }) : notFound('Page not found');
}

// routes/public-legal.ts PUBLIC_LEGAL_PAGES: key, today's address, title.
const LEGAL = [
  { key: 'kopvillkor', path: '/legal/kopvillkor', title: 'Köpvillkor' },
  { key: 'angerratt', path: '/legal/angerratt-och-returer', title: 'Ångerrätt & returer' },
  { key: 'integritetspolicy', path: '/legal/integritetspolicy', title: 'Integritetspolicy' },
  { key: 'plattformsvillkor', path: '/legal/plattformsvillkor', title: 'Plattformsvillkor' },
];

function legalList(shop) {
  const adopted = shop.legal ?? {};
  return json(200, { pages: LEGAL.filter((entry) => adopted[entry.key]).map((entry) => ({ ...entry })) });
}

function legalDetail(shop, named) {
  const entry = LEGAL.find((e) => e.key === named || e.path === `/legal/${named}`);
  const text = entry && shop.legal?.[entry.key];
  if (!text) return notFound('Legal page not found');
  if (entry.key === 'plattformsvillkor') {
    return json(200, { page: { key: entry.key, path: entry.path, title: entry.title, version: text.version, publishedAt: text.publishedAt, text: text.text } });
  }
  return json(200, { page: { key: entry.key, path: entry.path, title: entry.title, html: text.html, adoptedAt: text.adoptedAt } });
}

// ── the route table ─────────────────────────────────────────────────────────

// [method, path pattern with :segments, handler(shop, url, segments, options)]
export const ROUTES = [
  ['GET', '/v1/storefront', (shop) => json(200, { storefront: shop.storefront })],
  ['GET', '/v1/products', (shop, url, _s, options) => productsList(shop, url, options.pageSize)],
  ['GET', '/v1/products/:ref', (shop, url, [ref]) => (url.search ? invalid() : productDetail(shop, ref))],
  ['GET', '/v1/collections', (shop, url) => collectionsList(shop, url)],
  ['GET', '/v1/collections/:ref', (shop, url, [ref], options) => collectionDetail(shop, ref, url, options.pageSize)],
  ['GET', '/v1/pages', (shop, url, _s, options) => pagesList(shop, url, options.pageSize)],
  ['GET', '/v1/pages/:slug', (shop, url, [slug]) => pageDetail(shop, slug, url)],
  ['GET', '/v1/legal', (shop) => legalList(shop)],
  ['GET', '/v1/legal/:key', (shop, _url, [key]) => legalDetail(shop, key)],
  ['GET', '/v1/storefront/pod-previews/:product/:artwork', (_shop, _url, [product, artwork]) => ({
    status: 200,
    svg: drawImage(`preview-${product}-${artwork}`),
  })],
  // F2's rows: checkout, payment, receipt, order, withdrawal, report.
  ...MONEY_ROUTES,
];

/** One path segment, decoded once, as the Worker's id rule: no '/', '.', '..', control. */
function decodeSegment(raw) {
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return value === '' || value === '.' || value === '..' || /[/\\\u0000-\u001f]/.test(value) ? null : value;
}

function match(pattern, path) {
  const want = pattern.split('/');
  const have = path.split('/');
  if (want.length !== have.length) return null;
  const segments = [];
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) {
      const value = decodeSegment(have[i]);
      if (value === null) return null;
      segments.push(value);
    } else if (want[i] !== have[i]) {
      return null;
    }
  }
  return segments;
}

/**
 * The answer to one request: `{ status, body }` (JSON) or `{ status, svg }`.
 * `url` is the request's URL; the shared-host grammar `/_api/<shop>/v1/…`.
 */
export function route(shops, method, url, { pageSize = 100 } = {}) {
  const m = /^\/_api\/([a-z0-9][a-z0-9-]{0,62})(\/v1\/.*)$/.exec(url.pathname);
  if (!m) return notFound();
  const shop = shops[m[1]];
  for (const [verb, pattern, handler] of ROUTES) {
    const segments = match(pattern, m[2]);
    if (segments === null) continue;
    if (verb !== method) continue;
    // An unknown shop: the API's one 404 (unknown, suspended or unpublished).
    if (!shop) return notFound();
    return handler(shop, url, segments, { pageSize });
  }
  return notFound();
}

// ── images ──────────────────────────────────────────────────────────────────

const PALETTE = ['#2F5D7C', '#C9B28F', '#7A8B6F', '#B5563C', '#4B4E6D', '#D9A441', '#8C6A8F', '#3E7F7A'];

function hash(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h;
}

const escapeXml = (text) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** An invented picture: a garment-like shape on a tinted ground, or a wordmark for `logo…`. */
export function drawImage(name) {
  const label = escapeXml(name.replace(/\.svg$/, '').replace(/[-_]+/g, ' ').slice(0, 40));
  if (name.startsWith('logo')) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="64" viewBox="0 0 360 64"><text x="0" y="46" font-family="Georgia, serif" font-size="44" font-weight="700" fill="#1A1C1E">${name.includes('sport') ? 'Sportbutiken' : 'Provbutiken'}</text></svg>`;
  }
  const colour = PALETTE[hash(name) % PALETTE.length];
  const ground = PALETTE[(hash(name) >> 3) % PALETTE.length];
  if (name.startsWith('hero') || name.startsWith('cover')) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="${ground}"/><circle cx="1180" cy="360" r="300" fill="${colour}" opacity="0.8"/><rect x="160" y="520" width="640" height="220" rx="24" fill="#ffffff" opacity="0.18"/><text x="80" y="860" font-family="sans-serif" font-size="28" fill="#ffffff" opacity="0.6">${label}</text></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800"><rect width="800" height="800" fill="#EDEBE6"/><path d="M270 150 L340 120 Q400 170 460 120 L530 150 L650 260 L585 340 L540 305 L540 680 L260 680 L260 305 L215 340 L150 260 Z" fill="${colour}"/><circle cx="400" cy="420" r="70" fill="${ground}" opacity="0.9"/><text x="400" y="760" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#71757C">${label}</text></svg>`;
}

// ── the middleware ──────────────────────────────────────────────────────────

/** A Connect middleware for Vite's dev server. */
export function createDevApi({ fixtures = FIXTURES, pageSize = 100 } = {}) {
  return function devApi(req, res, next) {
    const url = new URL(req.url, 'http://dev.invalid');
    if (url.pathname.startsWith('/_dev/images/')) {
      const name = decodeSegment(url.pathname.slice('/_dev/images/'.length));
      return send(res, name ? { status: 200, svg: drawImage(name) } : notFound());
    }
    if (!url.pathname.startsWith('/_api/')) return next();
    // Fixtures are re-read on every request, so an edit shows on reload.
    return send(res, route(loadShops(fixtures), req.method, url, { pageSize }));
  };
}

function send(res, answer) {
  res.statusCode = answer.status;
  res.setHeader('X-Storefront-Dev', DEV_API_MARKER);
  res.setHeader('Cache-Control', 'no-store');
  if (answer.svg !== undefined) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end(answer.svg);
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(answer.body));
}
