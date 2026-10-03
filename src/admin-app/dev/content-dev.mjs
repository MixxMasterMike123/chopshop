// The dev API's rows for the catalogue's content pages (unit FG): collections,
// pages and the one object read, in the API's shapes (cloudflare/src/routes/
// admin-collections.ts, admin-pages.ts, storage/object-routes.ts).
// INVENTED DATA ONLY (content-fixtures.json). Held in memory per dev server.
//
// The refusals are the Worker's, small: a handle that is not a fixed point of
// slugify, a tag rule that does not fit the type, a taken handle or slug (409),
// a cover that is not an active public image (400 image_not_referencable), a
// member that is no product (400 product_not_found), a product list for a
// smart collection (409 collection_not_manual), a reserved slug (400
// slug_reserved), and content with a script-like tag (400 content_refused,
// with the reason: a stand-in for content/html-refusal.ts).

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'content-fixtures.json');
const PRODUCT_FIXTURES = join(HERE, 'products-fixtures.json');

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });
const refused = (status, code, extra = {}) => json(status, { error: { code, message: code, ...extra } });

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${randomBytes(6).toString('hex')}`;

// The Worker's reserved first segments (content/pages.ts RESERVED_PAGE_SLUGS).
const RESERVED_SLUGS = ['_api', 'angerratt', 'angra', 'assets', 'cart', 'checkout', 'integritetspolicy', 'kategori', 'kopvillkor', 'legal',
  'order-confirmation', 'order-return', 'plattformsvillkor', 'product', 'produkter', 'rapportera-intrang', 'samling', 'tagg'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const LANG = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
// Not the Worker's check: enough of it to show a refusal and its reason.
const HTML_REASONS = [
  [/<\s*script\b|javascript:/i, 'script'],
  [/<\s*(iframe|object|embed)\b/i, 'embedded_content'],
  [/\son[a-z]+\s*=/i, 'event_attribute'],
  [/(src|href)\s*=\s*["']?\s*data:/i, 'unsafe_address'],
  [/<\s*(form|style|svg)\b/i, 'form'],
];

const shopIdOf = (shop) => shop.shop.tenantId;

function content(state, shopId) {
  state.fgContent ??= new Map();
  if (!state.fgContent.has(shopId)) {
    const seed = JSON.parse(readFileSync(FIXTURES, 'utf8')).shops?.[shopId] ?? {};
    state.fgContent.set(shopId, {
      collections: new Map((seed.collections ?? []).map((c) => [c.collectionId, structuredClone(c)])),
      pages: new Map((seed.pages ?? []).map((p) => [p.pageId, structuredClone(p)])),
    });
  }
  return state.fgContent.get(shopId);
}

/** An object of the shop: the uploads of the product routes (held in state), else the fixtures' own. */
function objectOf(state, shopId, objectId) {
  const held = state.fcCatalogue?.get(shopId)?.objects?.get(objectId);
  if (held) return held;
  const seeded = JSON.parse(readFileSync(PRODUCT_FIXTURES, 'utf8')).shops?.[shopId]?.objects?.[objectId];
  return seeded ? { objectId, status: 'active', kind: 'product_media', ...seeded } : null;
}

function productExists(state, shopId, productId) {
  const held = state.fcCatalogue?.get(shopId)?.products;
  if (held) return held.has(productId);
  return (JSON.parse(readFileSync(PRODUCT_FIXTURES, 'utf8')).shops?.[shopId]?.products ?? []).some((p) => p.product.productId === productId);
}

function publicImage(state, shopId, objectId) {
  const o = objectId ? objectOf(state, shopId, objectId) : null;
  if (!o || o.status !== 'active' || o.kind !== 'product_media' || !o.url) return null;
  return { objectId, url: o.url, contentType: o.contentType ?? 'image/png', width: null, height: null };
}

// ── collections ─────────────────────────────────────────────────────────────

// slugify's fixed points: lower-case ASCII, digits, _ and -, never --, one letter or digit.
const isHandle = (h) => typeof h === 'string' && /^[a-z0-9_-]{1,200}$/.test(h) && !h.includes('--') && /[a-z0-9]/.test(h);

function summaryOf(state, shopId, c) {
  const { description: _d, productIds: _p, ...rest } = c;
  return {
    ...rest,
    path: `/samling/${c.handle}`,
    image: publicImage(state, shopId, c.imageObjectId),
    productCount: c.type === 'manual' ? c.productIds.length : 0,
    createdBy: undefined,
  };
}

const fullOf = (state, shopId, c) => ({ ...summaryOf(state, shopId, c), description: c.description ?? null, productIds: [...c.productIds], createdBy: 'u-dev', updatedBy: 'u-dev' });

const displayOrder = (a, b) =>
  (a.sortOrder ?? 1e12) - (b.sortOrder ?? 1e12) || a.title.localeCompare(b.title, 'sv') || a.collectionId.localeCompare(b.collectionId);

const COLLECTION_KEYS = ['description', 'externalRef', 'featured', 'handle', 'imageObjectId', 'published', 'ruleTag', 'sortOrder', 'title', 'type'];

function checkCollection(body, create) {
  if (!isObj(body)) return false;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((k) => !COLLECTION_KEYS.includes(k)) || (create && !keys.includes('title'))) return false;
  if ('title' in body && (typeof body.title !== 'string' || body.title.trim() === '' || body.title.length > 200)) return false;
  if ('handle' in body && !isHandle(body.handle)) return false;
  if ('description' in body && body.description !== null && (typeof body.description !== 'string' || body.description.length > 5000)) return false;
  if ('type' in body && !['manual', 'smart'].includes(body.type)) return false;
  for (const k of ['published', 'featured']) if (k in body && typeof body[k] !== 'boolean') return false;
  if ('sortOrder' in body && body.sortOrder !== null && !Number.isSafeInteger(body.sortOrder)) return false;
  if ('ruleTag' in body && body.ruleTag !== null && (typeof body.ruleTag !== 'string' || body.ruleTag.trim() === '' || body.ruleTag.length > 50)) return false;
  return true;
}

/** The type and tag a write leaves, or null when they do not fit (resolveRule). */
function resolveRule(body, current) {
  const type = body.type ?? current?.type ?? 'manual';
  if (type === 'manual') return typeof body.ruleTag === 'string' ? null : { type, ruleTag: null };
  const ruleTag = body.ruleTag !== undefined ? body.ruleTag : (current?.ruleTag ?? null);
  return ruleTag === null ? null : { type, ruleTag };
}

const handleTaken = (store, handle, exceptId) => [...store.collections.values()].some((c) => c.handle === handle && c.collectionId !== exceptId);

const ROUTE_COLLECTION = /^\/v1\/admin\/collections\/([^/]+)$/;
const ROUTE_COLLECTION_PRODUCTS = /^\/v1\/admin\/collections\/([^/]+)\/products$/;
const ROUTE_PAGE = /^\/v1\/admin\/pages\/([^/]+)$/;
const ROUTE_OBJECT_READ = /^\/v1\/admin\/objects\/([^/]+)$/;

const collectionOf = (store, segments) => store.collections.get(decodeURIComponent(segments[0])) ?? null;

// ── pages ───────────────────────────────────────────────────────────────────

function mapOk(value, { required, html = false }) {
  if (value === null && !required) return { ok: true, value: null };
  if (!isObj(value) || Object.keys(value).length === 0 || Object.keys(value).some((l) => !LANG.test(l))) return { ok: false };
  const map = {};
  for (const [lang, text] of Object.entries(value)) {
    if (typeof text !== 'string') return { ok: false };
    if (text.trim() === '') {
      if (required) return { ok: false };
      continue;
    }
    if (html) {
      const hit = HTML_REASONS.find(([pattern]) => pattern.test(text));
      if (hit) return { ok: false, refusal: { reason: hit[1], language: lang } };
    }
    map[lang] = text;
  }
  return Object.keys(map).length === 0 ? (required ? { ok: false } : { ok: true, value: null }) : { ok: true, value: map };
}

const PAGE_KEYS = ['author', 'content', 'imageObjectId', 'kind', 'metaDescription', 'metaTitle', 'publishedAt', 'slug', 'status', 'summary', 'title'];

/** → { fields } or { answer }. */
function parsePage(body, create) {
  if (!isObj(body)) return { answer: invalid() };
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((k) => !PAGE_KEYS.includes(k)) || (create && !['content', 'slug', 'title'].every((k) => keys.includes(k)))) return { answer: invalid() };
  const fields = {};
  if ('slug' in body) {
    if (typeof body.slug !== 'string' || !SLUG.test(body.slug)) return { answer: invalid() };
    if (RESERVED_SLUGS.includes(body.slug)) return { answer: refused(400, 'slug_reserved') };
    fields.slug = body.slug;
  }
  if ('kind' in body) {
    if (!['page', 'post'].includes(body.kind)) return { answer: invalid() };
    fields.kind = body.kind;
  }
  if ('status' in body) {
    if (!['draft', 'published'].includes(body.status)) return { answer: invalid() };
    fields.status = body.status;
  }
  for (const [key, required] of [['title', true], ['summary', false], ['metaTitle', false], ['metaDescription', false]]) {
    if (!(key in body)) continue;
    const r = mapOk(body[key], { required });
    if (!r.ok) return { answer: invalid() };
    fields[key] = r.value;
  }
  if ('content' in body) {
    const r = mapOk(body.content, { required: true, html: true });
    if (!r.ok) return { answer: r.refusal ? refused(400, 'content_refused', r.refusal) : invalid() };
    fields.content = r.value;
  }
  for (const k of ['author', 'imageObjectId', 'publishedAt']) if (k in body) fields[k] = body[k];
  return { fields };
}

const pageSummary = (p) => ({
  pageId: p.pageId, slug: p.slug, path: `/${p.slug}`, kind: p.kind ?? 'page', status: p.status, title: { ...p.title },
  publishedAt: p.publishedAt ?? null, createdAt: p.createdAt, updatedAt: p.updatedAt,
});

const pageFull = (p) => ({
  ...pageSummary(p), author: p.author ?? null, content: { ...p.content }, createdBy: 'u-dev', image: null, imageObjectId: p.imageObjectId ?? null,
  metaDescription: p.metaDescription ?? null, metaTitle: p.metaTitle ?? null, summary: p.summary ?? null, updatedBy: 'u-dev',
});

const slugTaken = (store, slug, exceptId) => [...store.pages.values()].some((p) => p.slug === slug && p.pageId !== exceptId);

function listParams(url) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 100);
  const offset = Number((url.searchParams.get('cursor') ?? 'o0').slice(1)) || 0;
  return { limit, offset };
}

function paged(rows, { limit, offset }) {
  return { rows: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? `o${offset + limit}` : null };
}

export const CONTENT_ROUTES = [
  // collections
  ['GET', '/v1/admin/collections', (state, { shop, url }) => {
    const store = content(state, shopIdOf(shop));
    const { rows, nextCursor } = paged([...store.collections.values()].sort(displayOrder), listParams(url));
    return json(200, { collections: rows.map((c) => summaryOf(state, shopIdOf(shop), c)), nextCursor });
  }],
  ['POST', '/v1/admin/collections', (state, { shop, body }) => {
    const shopId = shopIdOf(shop);
    const store = content(state, shopId);
    if (!checkCollection(body, true)) return invalid();
    const handle = body.handle ?? body.title.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const rule = resolveRule(body, null);
    if (!isHandle(handle) || !rule) return invalid();
    if (body.imageObjectId && !publicImage(state, shopId, body.imageObjectId)) return refused(400, 'image_not_referencable');
    if (handleTaken(store, handle, null)) return refused(409, 'handle_taken');
    const now = nowIso();
    const c = {
      collectionId: newId('col'), handle, externalRef: body.externalRef ?? null, title: body.title.trim(), description: body.description ?? null,
      type: rule.type, ruleTag: rule.ruleTag, published: body.published === true, featured: body.featured === true,
      sortOrder: body.sortOrder ?? null, imageObjectId: body.imageObjectId ?? null, productIds: [], createdAt: now, updatedAt: now,
    };
    store.collections.set(c.collectionId, c);
    return json(201, { collection: fullOf(state, shopId, c) });
  }],
  ['PUT', ROUTE_COLLECTION_PRODUCTS, (state, { shop, segments, body }) => {
    const shopId = shopIdOf(shop);
    const c = collectionOf(content(state, shopId), segments);
    if (!c) return notFound();
    if (!Array.isArray(body) || body.length > 500 || body.some((id) => typeof id !== 'string' || id === '') || new Set(body).size !== body.length) return invalid();
    if (c.type !== 'manual') return refused(409, 'collection_not_manual');
    if (body.some((id) => !productExists(state, shopId, id))) return refused(400, 'product_not_found');
    c.productIds = [...body];
    c.updatedAt = nowIso();
    return json(200, { collection: fullOf(state, shopId, c) });
  }],
  ['GET', ROUTE_COLLECTION, (state, { shop, segments }) => {
    const c = collectionOf(content(state, shopIdOf(shop)), segments);
    return c ? json(200, { collection: fullOf(state, shopIdOf(shop), c) }) : notFound();
  }],
  ['PATCH', ROUTE_COLLECTION, (state, { shop, segments, body }) => {
    const shopId = shopIdOf(shop);
    const store = content(state, shopId);
    const c = collectionOf(store, segments);
    if (!c) return notFound();
    if (!checkCollection(body, false)) return invalid();
    const rule = resolveRule(body, c);
    if (!rule) return invalid();
    if (body.imageObjectId !== undefined && body.imageObjectId !== c.imageObjectId && body.imageObjectId !== null
      && !publicImage(state, shopId, body.imageObjectId)) return refused(400, 'image_not_referencable');
    if (body.handle !== undefined && body.handle !== c.handle && handleTaken(store, body.handle, c.collectionId)) return refused(409, 'handle_taken');
    for (const k of ['handle', 'externalRef', 'description', 'imageObjectId', 'published', 'featured', 'sortOrder']) if (k in body) c[k] = body[k];
    if ('title' in body) c.title = body.title.trim();
    c.type = rule.type;
    c.ruleTag = rule.ruleTag;
    if (c.type === 'smart') c.productIds = [];
    c.updatedAt = nowIso();
    return json(200, { collection: fullOf(state, shopId, c) });
  }],
  ['DELETE', ROUTE_COLLECTION, (state, { shop, segments }) => {
    const store = content(state, shopIdOf(shop));
    const c = collectionOf(store, segments);
    if (!c) return notFound();
    store.collections.delete(c.collectionId);
    return { status: 204 };
  }],

  // pages
  ['GET', '/v1/admin/pages', (state, { shop, url }) => {
    const store = content(state, shopIdOf(shop));
    const status = url.searchParams.get('status');
    const kind = url.searchParams.get('kind');
    const rows = [...store.pages.values()]
      .filter((p) => (!status || p.status === status) && (!kind || (p.kind ?? 'page') === kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const { rows: page, nextCursor } = paged(rows, listParams(url));
    return json(200, { pages: page.map(pageSummary), nextCursor });
  }],
  ['POST', '/v1/admin/pages', (state, { shop, body }) => {
    const store = content(state, shopIdOf(shop));
    const parsed = parsePage(body, true);
    if (parsed.answer) return parsed.answer;
    const f = parsed.fields;
    if (slugTaken(store, f.slug, null)) return refused(409, 'slug_taken');
    const now = nowIso();
    const p = {
      pageId: newId('page'), kind: 'page', status: 'draft', summary: null, metaTitle: null, metaDescription: null, author: null, imageObjectId: null,
      ...f, publishedAt: f.publishedAt ?? (f.status === 'published' ? now : null), createdAt: now, updatedAt: now,
    };
    store.pages.set(p.pageId, p);
    return json(201, { page: pageFull(p) });
  }],
  ['GET', ROUTE_PAGE, (state, { shop, segments }) => {
    const p = content(state, shopIdOf(shop)).pages.get(decodeURIComponent(segments[0]));
    return p ? json(200, { page: pageFull(p) }) : notFound();
  }],
  ['PATCH', ROUTE_PAGE, (state, { shop, segments, body }) => {
    const store = content(state, shopIdOf(shop));
    const p = store.pages.get(decodeURIComponent(segments[0]));
    if (!p) return notFound();
    const parsed = parsePage(body, false);
    if (parsed.answer) return parsed.answer;
    const f = parsed.fields;
    if (f.slug !== undefined && f.slug !== p.slug && slugTaken(store, f.slug, p.pageId)) return refused(409, 'slug_taken');
    Object.assign(p, f);
    if (f.status === 'published' && !p.publishedAt) p.publishedAt = nowIso();
    p.updatedAt = nowIso();
    return json(200, { page: pageFull(p) });
  }],
  ['DELETE', ROUTE_PAGE, (state, { shop, segments }) => {
    const store = content(state, shopIdOf(shop));
    const id = decodeURIComponent(segments[0]);
    if (!store.pages.has(id)) return notFound();
    store.pages.delete(id);
    return { status: 204 };
  }],

  // one object (a branding or cover image's address)
  ['GET', ROUTE_OBJECT_READ, (state, { shop, segments }) => {
    const shopId = shopIdOf(shop);
    const o = objectOf(state, shopId, decodeURIComponent(segments[0]));
    if (!o || o.status !== 'active') return notFound();
    return json(200, { object: { objectId: o.objectId, kind: o.kind, contentType: o.contentType ?? 'image/png', sha256: o.sha256 ?? null, sizeBytes: o.sizeBytes ?? null, status: 'active', immutable: false, url: o.url ?? null, width: null, height: null } });
  }],
];
