// The dev API's product rows (unit FC): the product, variant, image, object
// and POD-quote routes, in the API's shapes (cloudflare/src/routes/
// admin-products.ts, app.ts handleAdminProductRoute, storage/object-routes.ts,
// routes/pod-admin.ts). INVENTED DATA ONLY (products-fixtures.json).
//
// The catalogue lives in memory per dev server (the shared fixtures are
// re-read on every request; these are seeded once from products-fixtures.json),
// so a save shows on the next read. The refusals are the Worker's, small:
// sku taken (409), the variant cap (409 variant_limit), a variant an order
// names is deactivated not deleted, "Mer information" with a script-like tag
// (400, a stand-in for content/html-refusal.ts), a lowered price of a live
// POD product under its floor (422 price_below_floor), a publish of a POD
// product without a quote (422 pod_mapping_missing), a taken-down product
// (422 taken_down). An uploaded image is answered as a data: address of its
// own bytes, so it shows without a bucket.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'products-fixtures.json');

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = (reason) => json(400, { error: { code: 'invalid_request', message: 'Request is not valid', ...(reason ? { reason } : {}) } });
const conflict = (code = 'conflict') => json(409, { error: { code, message: code } });
const refused = (code) => json(422, { error: { code, message: code } });

const id = (prefix) => `${prefix}-${randomBytes(6).toString('hex')}`;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const REFUSED_HTML = /<\s*(script|iframe|object|embed|form|style|svg)\b|\son[a-z]+\s*=|javascript:/i;

/** The shop's catalogue, seeded once per dev server. */
function catalogue(state, shopId) {
  state.fcCatalogue ??= new Map();
  if (!state.fcCatalogue.has(shopId)) {
    const seed = JSON.parse(readFileSync(FIXTURES, 'utf8')).shops?.[shopId] ?? { objects: {}, products: [], quotes: {} };
    state.fcCatalogue.set(shopId, {
      objects: new Map(Object.entries(seed.objects ?? {}).map(([k, v]) => [k, { objectId: k, status: 'active', kind: 'product_media', ...v }])),
      products: new Map((seed.products ?? []).map((p) => [p.product.productId, structuredClone(p)])),
      quotes: seed.quotes ?? {},
    });
  }
  return state.fcCatalogue.get(shopId);
}

const shopIdOf = (shop) => shop.shop.tenantId;

function imageView(cat, row) {
  const object = cat.objects.get(row.objectId);
  const image = object && object.status === 'active' && object.url
    ? { objectId: row.objectId, url: object.url, contentType: object.contentType ?? 'image/png', width: null, height: null }
    : null;
  return { alt: row.alt ?? null, image, objectId: row.objectId, position: row.position, variantId: row.variantId ?? null };
}

function detailOf(cat, record) {
  return {
    product: structuredClone(record.product),
    variants: record.variants.map((v) => ({ ...v })),
    images: record.images.map((row, position) => imageView(cat, { ...row, position })),
    publication: record.publication ? { ...record.publication } : null,
    variantsTruncated: false,
  };
}

function listItemOf(cat, record) {
  const first = record.images.map((row) => imageView(cat, row)).find((row) => row.image);
  const p = record.product;
  return {
    category: p.category, currency: p.currency, featured: p.featured, handle: p.handle,
    image: first ? { ...first.image, alt: first.alt } : null, isPod: p.isPod, name: p.name,
    priceMinor: p.priceMinor, productId: p.productId, published: record.publication?.published === true,
    screeningStatus: p.screeningStatus, sku: p.sku, sortOrder: p.sortOrder, status: p.status,
    takenDown: record.takenDown === true, updatedAt: record.updatedAt ?? '2026-10-01T09:00:00.000Z',
    // the Worker's list also carries the ACTIVE variants' count and the tags as typed
    variantCount: record.variants.filter((v) => v.active !== false).length,
    tags: Array.isArray(p.tags) ? [...p.tags] : [],
  };
}

const quoteOf = (cat, productId, variantId = null) => {
  const q = cat.quotes[productId];
  if (!q) return null;
  return variantId && q.variants ? q.variants[variantId] ?? null : q;
};

function skuTaken(cat, sku, exceptProduct) {
  const k = String(sku).toLowerCase();
  for (const r of cat.products.values()) {
    if (r.product.productId !== exceptProduct && r.product.sku.toLowerCase() === k) return true;
  }
  return false;
}

function variantSkuTaken(cat, sku, exceptVariant) {
  const k = String(sku).toLowerCase();
  for (const r of cat.products.values()) {
    if (r.variants.some((v) => v.variantId !== exceptVariant && v.sku.toLowerCase() === k)) return true;
  }
  return false;
}

const PRODUCT_FIELDS = ['allowPickup', 'allowShipping', 'brand', 'category', 'compareAtPriceMinor', 'description', 'eanCode', 'featured', 'launchDate', 'moreInfo', 'name', 'priceMinor', 'shippingRates', 'size', 'sizeGuide', 'sku', 'sortOrder', 'stock', 'tags', 'weightGrams'];

function checkProductBody(body, create) {
  if (!isObj(body)) return 'shape';
  const allowed = new Set([...PRODUCT_FIELDS, create ? 'currency' : 'status']);
  if (Object.keys(body).some((k) => !allowed.has(k))) return 'keys';
  if (create && (typeof body.sku !== 'string' || typeof body.name !== 'string' || !Number.isSafeInteger(body.priceMinor) || typeof body.currency !== 'string')) return 'required';
  if (typeof body.moreInfo === 'string' && REFUSED_HTML.test(body.moreInfo)) return 'html';
  if (Array.isArray(body.tags) && body.tags.length > 20) return 'tags';
  return null;
}

const live = (record) => record.product.status === 'active' && record.publication?.published === true;

const ROUTE_PRODUCT = /^\/v1\/admin\/products\/([^/]+)$/;
const ROUTE_ACTION = /^\/v1\/admin\/products\/([^/]+)\/(publish|unpublish)$/;
const ROUTE_VARIANTS = /^\/v1\/admin\/products\/([^/]+)\/variants$/;
const ROUTE_VARIANT = /^\/v1\/admin\/products\/([^/]+)\/variants\/([^/]+)$/;
const ROUTE_IMAGES = /^\/v1\/admin\/products\/([^/]+)\/images$/;
const ROUTE_OBJECT = /^\/v1\/admin\/objects\/([^/]+)$/;
const ROUTE_OBJECT_CONTENT = /^\/v1\/admin\/objects\/([^/]+)\/content$/;

function record(state, shop, segments) {
  return catalogue(state, shopIdOf(shop)).products.get(decodeURIComponent(segments[0])) ?? null;
}

export const PRODUCT_ROUTES = [
  ['GET', '/v1/admin/products', (state, { shop, url }) => {
    const cat = catalogue(state, shopIdOf(shop));
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 100);
    const offset = Number((url.searchParams.get('cursor') ?? 'o0').slice(1)) || 0;
    const all = [...cat.products.values()].sort((a, b) =>
      (a.product.sortOrder ?? 1e12) - (b.product.sortOrder ?? 1e12) || a.product.name.localeCompare(b.product.name));
    const page = all.slice(offset, offset + limit);
    return json(200, {
      products: page.map((r) => listItemOf(cat, r)),
      nextCursor: offset + limit < all.length ? `o${offset + limit}` : null,
    });
  }],
  ['POST', '/v1/admin/products', (state, { shop, body }) => {
    const cat = catalogue(state, shopIdOf(shop));
    if (checkProductBody(body, true)) return invalid();
    if (skuTaken(cat, body.sku)) return conflict();
    const productId = id('prod');
    const product = {
      productId, sku: body.sku, name: body.name, description: body.description ?? null, priceMinor: body.priceMinor,
      currency: body.currency, status: 'draft', isPod: false, screeningStatus: null, weightGrams: body.weightGrams ?? 0,
      allowShipping: body.allowShipping ?? true, allowPickup: body.allowPickup ?? false, shippingRates: body.shippingRates ?? null,
      handle: `${body.name}_${body.sku}`, featured: body.featured ?? false, sortOrder: body.sortOrder ?? null,
      compareAtPriceMinor: body.compareAtPriceMinor ?? null, category: body.category ?? null, tags: body.tags ?? [],
      moreInfo: body.moreInfo ?? null, sizeGuide: body.sizeGuide ?? null, size: null, brand: null, eanCode: null,
      stock: null, launchDate: body.launchDate ?? null, isPersonalized: false,
    };
    cat.products.set(productId, { product, variants: [], images: [], publication: null });
    return json(201, { product });
  }],
  ['PUT', '/v1/admin/products/order', (state, { shop, body }) => {
    const cat = catalogue(state, shopIdOf(shop));
    if (!Array.isArray(body) || body.length === 0 || body.length > 200) return invalid();
    if (!body.every((e) => cat.products.has(e.productId))) return notFound();
    for (const e of body) cat.products.get(e.productId).product.sortOrder = e.sortOrder;
    return json(200, { products: body });
  }],
  ['GET', ROUTE_PRODUCT, (state, { shop, segments }) => {
    const r = record(state, shop, segments);
    return r ? json(200, detailOf(catalogue(state, shopIdOf(shop)), r)) : notFound();
  }],
  ['PATCH', ROUTE_PRODUCT, (state, { shop, segments, body }) => {
    const cat = catalogue(state, shopIdOf(shop));
    const r = record(state, shop, segments);
    if (!r) return notFound();
    if (checkProductBody(body, false) || Object.keys(body).length === 0) return invalid();
    if (body.sku && skuTaken(cat, body.sku, r.product.productId)) return conflict();
    const q = quoteOf(cat, r.product.productId);
    const staysLive = live(r) && (body.status ?? r.product.status) === 'active';
    if (r.product.isPod && staysLive && body.priceMinor !== undefined && body.priceMinor < r.product.priceMinor
      && (!q || body.priceMinor < q.priceFloorMinor)) return refused('price_below_floor');
    Object.assign(r.product, body);
    if (r.product.status !== 'active' && r.publication) r.publication.published = false;
    return json(200, { product: r.product });
  }],
  ['POST', ROUTE_ACTION, (state, { shop, segments }) => {
    const cat = catalogue(state, shopIdOf(shop));
    const r = record(state, shop, segments);
    if (!r) return notFound();
    if (segments[1] === 'unpublish') {
      if (r.publication) r.publication.published = false;
      return json(200, { product: r.product });
    }
    if (r.product.status !== 'active') return conflict();
    if (r.takenDown) return refused('taken_down');
    if (r.product.isPod) {
      const q = quoteOf(cat, r.product.productId);
      if (!q) return refused('pod_mapping_missing');
      const active = r.variants.filter((v) => v.active);
      const prices = active.length ? active.map((v) => v.priceMinor) : [r.product.priceMinor];
      if (prices.some((p) => p < q.priceFloorMinor)) return refused('price_below_floor');
    }
    r.publication = { published: true, publishedAt: new Date().toISOString() };
    r.product.screeningStatus = r.screenAs ?? r.product.screeningStatus ?? 'approved';
    return json(200, { product: r.product });
  }],
  ['POST', ROUTE_VARIANTS, (state, { shop, segments, body }) => {
    const cat = catalogue(state, shopIdOf(shop));
    const r = record(state, shop, segments);
    if (!r) return notFound();
    if (!isObj(body) || typeof body.sku !== 'string' || typeof body.label !== 'string' || !Number.isSafeInteger(body.priceMinor)) return invalid();
    if (r.variants.filter((v) => v.active).length >= 200) return conflict('variant_limit');
    if (variantSkuTaken(cat, body.sku)) return conflict();
    const variant = {
      variantId: id('var'), sku: body.sku, label: body.label, priceMinor: body.priceMinor, active: body.active !== false,
      group: body.group ?? null, size: body.size ?? null, position: body.position ?? r.variants.length,
    };
    r.variants.push(variant);
    return json(201, { variant });
  }],
  ['PATCH', ROUTE_VARIANT, (state, { shop, segments, body }) => {
    const cat = catalogue(state, shopIdOf(shop));
    const r = record(state, shop, segments);
    const v = r?.variants.find((x) => x.variantId === decodeURIComponent(segments[1]));
    if (!v) return notFound();
    if (!isObj(body) || Object.keys(body).length === 0) return invalid();
    if (body.sku && variantSkuTaken(cat, body.sku, v.variantId)) return conflict();
    const q = quoteOf(cat, r.product.productId, v.variantId) ?? quoteOf(cat, r.product.productId);
    if (r.product.isPod && live(r) && body.priceMinor !== undefined && body.priceMinor < v.priceMinor && q && body.priceMinor < q.priceFloorMinor) {
      return refused('price_below_floor');
    }
    Object.assign(v, body);
    return json(200, { variant: v });
  }],
  ['DELETE', ROUTE_VARIANT, (state, { shop, segments }) => {
    const r = record(state, shop, segments);
    const index = r ? r.variants.findIndex((x) => x.variantId === decodeURIComponent(segments[1])) : -1;
    if (index < 0) return notFound();
    const v = r.variants[index];
    if (v.onOrder) {
      v.active = false;
      return json(200, { outcome: 'deactivated', variant: v });
    }
    r.variants.splice(index, 1);
    r.images = r.images.filter((row) => row.variantId !== v.variantId);
    return json(200, { outcome: 'deleted', variant: null });
  }],
  ['PUT', ROUTE_IMAGES, (state, { shop, segments, body }) => {
    const cat = catalogue(state, shopIdOf(shop));
    const r = record(state, shop, segments);
    if (!r) return notFound();
    if (!Array.isArray(body) || body.length > 30) return invalid();
    const owners = new Set();
    for (const row of body) {
      const key = `${row.variantId ?? ''}\n${row.objectId}`;
      if (!isObj(row) || owners.has(key)) return invalid();
      owners.add(key);
      if (cat.objects.get(row.objectId)?.status !== 'active') return invalid('image_not_referencable');
      if (row.variantId && !r.variants.some((v) => v.variantId === row.variantId)) return invalid('variant_not_found');
    }
    r.images = body.map((row) => ({ objectId: row.objectId, variantId: row.variantId ?? null, alt: row.alt ?? null }));
    return json(200, { images: r.images.map((row, position) => imageView(cat, { ...row, position })) });
  }],
  ['POST', '/v1/admin/objects', (state, { shop, body }) => {
    const cat = catalogue(state, shopIdOf(shop));
    if (!isObj(body) || typeof body.sha256 !== 'string' || !Number.isSafeInteger(body.sizeBytes) || typeof body.kind !== 'string') return invalid();
    if (body.kind === 'product_media' && body.sizeBytes > 15 * 1024 * 1024) return json(413, { error: { code: 'payload_too_large' } });
    const objectId = id('obj');
    cat.objects.set(objectId, { objectId, status: 'pending', kind: body.kind, contentType: body.contentType, sha256: body.sha256, sizeBytes: body.sizeBytes });
    return json(201, { object: { objectId, objectKey: `shops/${shopIdOf(shop)}/${body.kind}/${objectId}` } });
  }],
  ['PUT', ROUTE_OBJECT_CONTENT, (state, { shop, segments, body }) => {
    const cat = catalogue(state, shopIdOf(shop));
    const object = cat.objects.get(decodeURIComponent(segments[0]));
    if (!object || object.status !== 'pending') return notFound();
    const bytes = body?.raw;
    if (!Buffer.isBuffer(bytes) || bytes.length !== object.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== object.sha256) {
      return invalid('bytes_not_as_declared');
    }
    if (!/^image\//.test(object.contentType ?? '')) return invalid('type_not_as_stated');
    Object.assign(object, { status: 'active', url: `data:${object.contentType};base64,${bytes.toString('base64')}` });
    return json(200, { object: { objectId: object.objectId, kind: object.kind, contentType: object.contentType, sha256: object.sha256, sizeBytes: object.sizeBytes, status: 'active', immutable: false, url: object.url, width: null, height: null } });
  }],
  ['DELETE', ROUTE_OBJECT, (state, { shop, segments }) => {
    const cat = catalogue(state, shopIdOf(shop));
    const object = cat.objects.get(decodeURIComponent(segments[0]));
    if (!object || object.status === 'deleted') return notFound();
    object.status = 'deleted';
    return { status: 204 };
  }],
  ['GET', '/v1/admin/pod/quote', (state, { shop, url }) => {
    const cat = catalogue(state, shopIdOf(shop));
    const productId = url.searchParams.get('productId');
    if (!productId) return invalid();
    if (!cat.products.has(productId)) return notFound();
    const q = quoteOf(cat, productId, url.searchParams.get('variantId'));
    return q
      ? json(200, { inkopMinor: q.inkopMinor, priceFloorMinor: q.priceFloorMinor, currency: q.currency ?? 'SEK' })
      : json(422, { error: { code: 'not_quotable', message: 'Product has no POD mapping that can be produced' } });
  }],
];
