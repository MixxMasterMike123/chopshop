// The product's shapes, bridged (CP5 brief FC). PURE: no React, no fetch, no
// browser API; tested under Node (product.test.mjs).
//
// The pages (AdminProducts.jsx, ProductForm.jsx) read the product as the
// Firebase document they were written for: `name`, `sku`, `b2cPrice`,
// `isActive`, `availability.b2c`, `b2cImageUrl` + `b2cImageGallery`, the rail
// `variantGroups`, `delivery`, `shipping`, `weight` … The API answers
// `AdminProduct` + `variants[]` + `images[]` + `publication` in minor units
// (cloudflare/src/catalog/admin-product-reads.ts). This module turns one into
// the other and back, so the pages' markup does not change.
//
// THE TWO MODELS, side by side:
//   isActive                      products.status 'active' | 'draft'
//   isActive && availability.b2c  a publication with published = true
//   "deleted"                     status 'archived' (no product is deleted: an
//                                 order line keeps it; the list hides it)
//   b2cImageUrl, b2cImageGallery  image rows WITHOUT a variant, in order; the
//                                 first row is the main image
//   variantGroups[] (the rail)    variants grouped by `group`, in `position`
//                                 order; a group's sizes = its rows' sizes; a
//                                 group's images = the image rows naming any
//                                 variant of the group (THE GROUP RULE)
//   price in kronor               priceMinor in öre
//   weight {value, unit}          weightGrams
//   shipping {region: {cost kr}}  shippingRates {region: {cost öre}} | null
//   delivery {shipping, pickup}   allowShipping, allowPickup
//
// Nothing here computes a payout or a price floor (rule 15): the floor and the
// one number ("Inköp") are the server's (GET /v1/admin/pod/quote). The only
// arithmetic on them is the unit change (öre → kr) and, for Inköp, the VAT the
// seller sees it with (the server's own note: the UI converts ex → inkl. moms
// "at the edge").

// ── the server's limits (cloudflare/src/catalog/admin-catalog.ts,
//    product-variants.ts, product-images.ts), checked here so a refusal can be
//    said at the field it concerns instead of as "the request is not valid" ──
export const LIMITS = Object.freeze({
  sku: 64,
  name: 200,
  description: 2_000,
  category: 100,
  tag: 50,
  tags: 20,
  moreInfo: 20_000,
  sizeGuide: 5_000,
  variantLabel: 200,
  variantGroup: 100,
  variantSize: 50,
  activeVariants: 200,
  images: 30,
  priceMinor: 100_000_000,
  weightGrams: 1_000_000,
  shippingCostMinor: 10_000_000,
});

/** The production VAT Inköp is shown with (pod-quote.ts PRODUCTION_VAT_BP). */
export const PRODUCTION_VAT_BP = 2_500;

const REGIONS = ['sweden', 'nordic', 'eu', 'worldwide'];
const REGION_SERVICE = { sweden: 'Standard', nordic: 'Nordic', eu: 'EU', worldwide: 'International' };

/** öre → kr (a number), 0 for anything that is not an integer. */
export function kr(minor) {
  return Number.isSafeInteger(minor) ? minor / 100 : 0;
}

/** kr as the form holds it (a number or the text of a number input) → öre, or null. */
export function ore(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return null;
  const minor = Math.round(n * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

const text = (value) => (typeof value === 'string' ? value : '');

// ── the list ────────────────────────────────────────────────────────────────

/**
 * A row of GET /v1/admin/products → the page's product. `null` for an
 * archived product: archiving is this build's "delete", so the list hides it.
 */
export function productFromListItem(item) {
  if (!item || typeof item !== 'object' || item.status === 'archived') return null;
  const url = typeof item.image?.url === 'string' ? item.image.url : '';
  const price = kr(item.priceMinor);
  return {
    id: item.productId,
    documentId: item.productId,
    name: text(item.name),
    sku: text(item.sku),
    category: item.category ?? '',
    isActive: item.status === 'active',
    featured: item.featured === true,
    sortOrder: Number.isSafeInteger(item.sortOrder) ? item.sortOrder : null,
    b2cPrice: price,
    basePrice: price,
    imageUrl: url,
    b2cImageUrl: url,
    isPodProduct: item.isPod === true,
    takedown: item.takenDown === true ? { at: null } : null,
    published: item.published === true,
    screeningStatus: item.screeningStatus ?? null,
    tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [],
    // The list route carries the COUNT of the active variants, not the rows;
    // the page's "Varianter" column reads `variants.length`, so the list row
    // holds that many empty stand-ins (the form reads the real rows from the
    // product's own detail: productFromDetail).
    variants: Array.from({ length: Number.isSafeInteger(item.variantCount) && item.variantCount > 0 ? item.variantCount : 0 }, () => ({})),
  };
}

/** The display order the drag-sort mode saves: the draft's index is the place. */
export function orderEntries(draft) {
  return draft.map((p, index) => ({ productId: p.id, sortOrder: index }));
}

// ── one product, for the form ───────────────────────────────────────────────

const groupKeyOf = (variant) => (variant.group == null ? `variant:${variant.variantId}` : `group:${variant.group}`);

/**
 * The rail's group sku the derivation (utils/variantDerivation.js) turns back
 * into these rows: a sizeless row's own sku; for sized rows the common base B
 * of `B-<slug(size)>`. Rows that were not derived that way (an import) give
 * their first sku without its size suffix, or the first sku.
 */
function groupSkuOf(rows, skuFromName) {
  if (rows.length === 1 && rows[0].size == null) return rows[0].sku;
  const bases = rows.map((row) => {
    if (row.size == null) return row.sku;
    const suffix = `-${skuFromName(row.size)}`;
    return row.sku.toLowerCase().endsWith(suffix.toLowerCase()) ? row.sku.slice(0, -suffix.length) : null;
  });
  if (bases.every((b) => b !== null && b === bases[0])) return bases[0];
  return bases.find((b) => b) ?? rows[0].sku;
}

/**
 * The detail (GET /v1/admin/products/:id) → the product the form reads.
 * `listItem` (optional) adds what only the list carries (the takedown flag).
 * `skuFromName` is utils/productUrls.js's (injected: this module stays pure).
 *
 * Hidden fields the save reads (the form copies none of them into its state):
 *   `_server`  { variants (all, inactive too), railPriceOf, imageRows,
 *               published, isPod, currency, status, screeningStatus, priceMinor }
 *   `_objectIdByUrl`  the object behind each image address
 */
export function productFromDetail(detail, { listItem = null, skuFromName } = {}) {
  const p = detail.product;
  const variants = Array.isArray(detail.variants) ? detail.variants : [];
  const imageRows = Array.isArray(detail.images) ? detail.images : [];
  const price = kr(p.priceMinor);

  const objectIdByUrl = {};
  const urlOf = (row) => {
    const url = typeof row?.image?.url === 'string' ? row.image.url : null;
    if (url) objectIdByUrl[url] = row.objectId;
    return url;
  };

  // The product's own images: the rows without a variant, in order.
  const own = imageRows.filter((row) => row.variantId == null).map(urlOf).filter(Boolean);
  const ownUnique = [...new Set(own)];

  // The rail: the ACTIVE variants grouped, in position order. (An inactive
  // variant is one an order or a mapping names: it stays on the server, out of
  // the rail; the save reactivates it if the rail names its sku again.)
  const byPosition = [...variants].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const keyOfVariant = new Map(variants.map((v) => [v.variantId, groupKeyOf(v)]));
  const groups = [];
  const groupIndex = new Map();
  for (const v of byPosition) {
    if (v.active !== true) continue;
    const key = groupKeyOf(v);
    if (!groupIndex.has(key)) {
      groupIndex.set(key, groups.length);
      groups.push({ key, label: v.group ?? v.label, rows: [] });
    }
    groups[groupIndex.get(key)].rows.push(v);
  }
  const imagesOfGroup = (key) => [
    ...new Set(imageRows.filter((row) => row.variantId != null && keyOfVariant.get(row.variantId) === key).map(urlOf).filter(Boolean)),
  ];

  // The rail holds ONE price per group; the server's sizes may each have their
  // own (an import, the API). `railPriceOf` remembers, per variant, the price
  // the form shows for its group and whether the group's sizes differ, so the
  // save writes a size's price only when the seller changed the group's
  // (planVariantSync). The form keeps no hidden field of its own.
  const railPriceOf = {};
  const variantGroups = groups.map((g) => {
    const prices = [...new Set(g.rows.map((r) => r.priceMinor))];
    const images = imagesOfGroup(g.key);
    // One price for the group and it is the product's → inherited (empty field).
    const price = prices.length === 1 && prices[0] === p.priceMinor ? null : kr(g.rows[0].priceMinor);
    for (const row of g.rows) railPriceOf[row.variantId] = { shown: price, mixed: prices.length > 1 };
    return {
      label: g.label,
      sku: groupSkuOf(g.rows, skuFromName),
      price,
      image: images[0] || '',
      images,
      sizes: g.rows.map((r) => r.size).filter((s) => typeof s === 'string' && s.trim() !== ''),
    };
  });
  const activeRows = byPosition.filter((v) => v.active === true);

  const shipping = {};
  for (const region of REGIONS) {
    shipping[region] = { cost: kr(p.shippingRates?.[region]?.cost), service: REGION_SERVICE[region] };
  }

  return {
    id: p.productId,
    documentId: p.productId,
    name: text(p.name),
    sku: text(p.sku),
    category: p.category ?? '',
    tags: Array.isArray(p.tags) ? [...p.tags] : [],
    b2cPrice: price,
    basePrice: price,
    compareAtPrice: Number.isSafeInteger(p.compareAtPriceMinor) ? kr(p.compareAtPriceMinor) : 0,
    hasVariants: activeRows.length > 0,
    variantGroups,
    variants: activeRows.map((v) => ({
      sku: v.sku,
      label: v.label,
      price: kr(v.priceMinor),
      group: v.group ?? v.label,
      size: v.size ?? null,
    })),
    isActive: p.status === 'active',
    featured: p.featured === true,
    sortOrder: Number.isSafeInteger(p.sortOrder) ? p.sortOrder : null,
    imageUrl: ownUnique[0] || '',
    b2cImageUrl: ownUnique[0] || '',
    b2cImageGallery: ownUnique.slice(1),
    launchDate: p.launchDate || '',
    // A draft has no publication to read; "Tillgänglig i webbshoppen" keeps the
    // Firebase default (on) so activating it publishes it.
    availability: { b2c: p.status === 'active' ? detail.publication?.published === true : true },
    isPodProduct: p.isPod === true,
    isPersonalized: p.isPersonalized === true,
    sizeGuide: text(p.sizeGuide),
    descriptions: { b2c: text(p.description), b2cMoreInfo: text(p.moreInfo) },
    weight: { value: Number.isSafeInteger(p.weightGrams) ? p.weightGrams : 0, unit: 'g' },
    shipping,
    delivery: { shipping: p.allowShipping !== false, pickup: p.allowPickup === true },
    takedown: listItem?.takedown ?? null,
    screeningStatus: p.screeningStatus ?? null,
    _objectIdByUrl: objectIdByUrl,
    _server: {
      variants: variants.map((v) => ({ ...v })),
      railPriceOf,
      imageRows: imageRows.map((row) => ({ objectId: row.objectId, variantId: row.variantId ?? null, alt: row.alt ?? null })),
      published: detail.publication?.published === true,
      isPod: p.isPod === true,
      currency: p.currency,
      status: p.status,
      priceMinor: p.priceMinor,
      variantsTruncated: detail.variantsTruncated === true,
    },
  };
}

// ── the write ───────────────────────────────────────────────────────────────

/** Quill's empty editor ("<p><br></p>") or only white space → no text. */
export function moreInfoValue(html) {
  const value = text(html);
  const visible = value.replace(/<br\s*\/?>/gi, '').replace(/<\/?p>/gi, '').replace(/&nbsp;/g, ' ').trim();
  return visible === '' && !/<img\b/i.test(value) ? null : value;
}

/** The form's weight → grams (the column is whole grams). */
export function weightGramsOf(weight) {
  const value = Number(weight?.value) || 0;
  const grams = Math.round(weight?.unit === 'kg' ? value * 1000 : value);
  return Math.max(0, grams);
}

/** The form's carriage table → shippingRates (öre), or null when every region is 0 (the fallback tariff, the same thing). */
export function shippingRatesOf(shipping) {
  const rates = {};
  let any = false;
  for (const region of REGIONS) {
    const cost = ore(shipping?.[region]?.cost ?? 0) ?? 0;
    rates[region] = { cost: Math.max(0, cost) };
    if (cost > 0) any = true;
  }
  return any ? rates : null;
}

/**
 * The body of POST /v1/admin/products (create = true) or PATCH (create =
 * false), from the form's state and the values the save resolved (the sku,
 * the price, the was-price). A create carries the currency and no status (a
 * new product is a draft); an update carries the status.
 */
export function productWriteBody({ formData, sku, price, compareAtPrice, create, currency }) {
  const name = text(formData.name).trim();
  const body = {
    sku,
    // The API needs a name; the form lets it be empty and shows the sku then.
    name: name || sku,
    description: text(formData.descriptions?.b2c).trim() === '' ? null : formData.descriptions.b2c,
    priceMinor: ore(price) ?? 0,
    compareAtPriceMinor: compareAtPrice > 0 ? ore(compareAtPrice) : null,
    category: text(formData.category).trim() === '' ? null : formData.category,
    tags: Array.isArray(formData.tags) ? [...formData.tags] : [],
    featured: formData.featured === true,
    moreInfo: moreInfoValue(formData.descriptions?.b2cMoreInfo),
    sizeGuide: text(formData.sizeGuide).trim() === '' ? null : formData.sizeGuide,
    launchDate: /^\d{4}-\d{2}-\d{2}/.test(text(formData.launchDate)) ? formData.launchDate.slice(0, 10) : null,
    weightGrams: weightGramsOf(formData.weight),
    allowShipping: formData.delivery?.shipping === true,
    allowPickup: formData.delivery?.pickup === true,
    shippingRates: shippingRatesOf(formData.shipping),
  };
  if (create) body.currency = currency || 'SEK';
  else body.status = formData.isActive === true ? 'active' : 'draft';
  return body;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * What the server would refuse in a product body, said at the field: the
 * first problem as `{ field, message }`, or null. (The HTML of "Mer
 * information" is the server's to judge; see refusalMessage.)
 */
export function productBodyProblem(body) {
  const len = (v) => (typeof v === 'string' ? v.length : 0);
  if (len(body.sku) < 1 || len(body.sku) > LIMITS.sku) {
    return { field: 'sku', message: `SKU (Artikelnummer) får vara högst ${LIMITS.sku} tecken.` };
  }
  if (len(body.name) > LIMITS.name) return { field: 'name', message: `Titeln får vara högst ${LIMITS.name} tecken.` };
  if (CONTROL.test(body.name)) return { field: 'name', message: 'Titeln innehåller ett otillåtet tecken.' };
  if (len(body.description) > LIMITS.description) {
    return { field: 'description', message: `Beskrivningen får vara högst ${LIMITS.description} tecken.` };
  }
  if (body.priceMinor == null || body.priceMinor < 0 || body.priceMinor > LIMITS.priceMinor) {
    return { field: 'price', message: 'Priset är inte ett giltigt belopp.' };
  }
  if (len(body.category) > LIMITS.category || (body.category != null && CONTROL.test(body.category))) {
    return { field: 'category', message: `Kategorin får vara högst ${LIMITS.category} tecken på en rad.` };
  }
  if (body.tags.length > LIMITS.tags) return { field: 'tags', message: `Högst ${LIMITS.tags} taggar per produkt.` };
  if (body.tags.some((t) => len(t.trim()) < 1 || len(t.trim()) > LIMITS.tag || CONTROL.test(t))) {
    return { field: 'tags', message: `En tagg får vara högst ${LIMITS.tag} tecken.` };
  }
  if (len(body.moreInfo) > LIMITS.moreInfo) {
    return { field: 'moreInfo', message: `Mer information får vara högst ${LIMITS.moreInfo} tecken.` };
  }
  if (len(body.sizeGuide) > LIMITS.sizeGuide) {
    return { field: 'sizeGuide', message: `Storleksguiden får vara högst ${LIMITS.sizeGuide} tecken.` };
  }
  if (body.weightGrams > LIMITS.weightGrams) return { field: 'weight', message: 'Vikten är för stor (högst 1 000 kg).' };
  for (const region of REGIONS) {
    const cost = body.shippingRates?.[region]?.cost ?? 0;
    if (cost > LIMITS.shippingCostMinor) return { field: 'shipping', message: 'En fraktkostnad är för hög.' };
  }
  return null;
}

// ── the variants ────────────────────────────────────────────────────────────

/**
 * The rows the derivation gave (cleanVariants of utils/variantDerivation.js)
 * → the variant bodies, in rail order (position = index). With the
 * derivation's `cleanGroups`, each row also carries `groupPrice`: its group's
 * price field as the seller left it (kr, or null when it follows the product
 * price), which planVariantSync compares with what the form showed.
 */
export function desiredVariants(cleanVariants, cleanGroups = null) {
  const groupPriceOf = Array.isArray(cleanGroups) ? new Map(cleanGroups.map((g) => [g.label, g.price ?? null])) : null;
  return cleanVariants.map((row, position) => {
    const want = {
      sku: row.sku,
      label: row.label,
      group: row.group,
      size: row.size ?? null,
      priceMinor: ore(row.price) ?? 0,
      position,
    };
    if (groupPriceOf) want.groupPrice = groupPriceOf.get(row.group) ?? null;
    return want;
  });
}

/** The first problem of the desired variants, said at the variant, or null. */
export function variantProblem(desired) {
  if (desired.length > LIMITS.activeVariants) {
    return { field: 'variants', message: `Högst ${LIMITS.activeVariants} varianter (storlekar inräknade) per produkt.` };
  }
  for (const v of desired) {
    if (v.sku.length > LIMITS.sku) return { field: 'variants', message: `Variantens SKU "${v.sku}" är längre än ${LIMITS.sku} tecken.` };
    if (v.label.length > LIMITS.variantLabel || (v.group ?? '').length > LIMITS.variantGroup) {
      return { field: 'variants', message: `Variantnamnet "${v.group}" är för långt.` };
    }
    if ((v.size ?? '').length > LIMITS.variantSize) return { field: 'variants', message: `Storleken "${v.size}" är för lång.` };
    if (v.priceMinor > LIMITS.priceMinor) return { field: 'variants', message: `Priset för ${v.label} är inte ett giltigt belopp.` };
  }
  return null;
}

const lower = (s) => String(s ?? '').toLowerCase();
const sizeKey = (s) => lower(s ?? '').trim();

/** A group price as the derivation reads the field: öre when it is set (> 0), else null (inherited). */
const explicitMinor = (value) => (parseFloat(value) > 0 ? ore(value) : null);

/**
 * True when the seller left the price of a size's group as the form showed it
 * while the group's sizes have prices of their own: the size keeps ITS price.
 * `rail`: railPriceOf[variantId] of productFromDetail; `want.groupPrice`: of
 * desiredVariants(cleanVariants, cleanGroups).
 */
function keepsOwnPrice(rail, want) {
  if (!rail || rail.mixed !== true || !('groupPrice' in want)) return false;
  return explicitMinor(want.groupPrice) === explicitMinor(rail.shown);
}

/**
 * The variant writes that make the server's variants the desired ones.
 * Matched by sku first (a renamed variant keeps its row, its orders and its
 * print mapping), then by group + size (an edited sku keeps the row); the
 * rest is created; an active variant no row names is removed (the server
 * deactivates it instead when an order or a mapping names it). An inactive
 * variant whose sku comes back is reactivated rather than created twice.
 *
 * PRICES (a selling price never changes unless the seller changed it): the
 * rail has one price per group, and a group whose sizes have different prices
 * on the server shows the first size's. A size of such a group keeps its own
 * price while the seller leaves the group's price as shown (`railPriceOf`, of
 * productFromDetail); when the seller changes the group's price, every size of
 * the group gets the new price (the rail's rule, as in the older build), and
 * repricedMixedGroups names the groups for the seller.
 *
 * → { deletes: [variantId], updates: [{ variantId, body, sku }], creates: [{ body, sku }] }
 */
export function planVariantSync(existing, desired, { railPriceOf = null } = {}) {
  const pool = [...existing];
  const take = (predicate) => {
    const index = pool.findIndex(predicate);
    return index < 0 ? null : pool.splice(index, 1)[0];
  };
  const matched = desired.map((want) => ({ want, have: take((v) => lower(v.sku) === lower(want.sku)) }));
  for (const pair of matched) {
    if (pair.have) continue;
    const { group, size } = pair.want;
    pair.have = take((v) => v.active === true && lower(v.group ?? v.label) === lower(group) && sizeKey(v.size) === sizeKey(size));
  }

  const updates = [];
  const creates = [];
  for (const { want: w, have } of matched) {
    // `have` may be inactive (matched by sku): it is reactivated below.
    if (!have) {
      creates.push({ sku: w.sku, body: { sku: w.sku, label: w.label, group: w.group, size: w.size, priceMinor: w.priceMinor, position: w.position, active: true } });
      continue;
    }
    const body = {};
    if (have.sku !== w.sku) body.sku = w.sku;
    if (have.label !== w.label) body.label = w.label;
    if ((have.group ?? null) !== w.group) body.group = w.group;
    if ((have.size ?? null) !== w.size) body.size = w.size;
    const priceMinor = keepsOwnPrice(railPriceOf?.[have.variantId], w) ? have.priceMinor : w.priceMinor;
    if (have.priceMinor !== priceMinor) body.priceMinor = priceMinor;
    if (have.position !== w.position) body.position = w.position;
    if (have.active !== true) body.active = true;
    if (Object.keys(body).length > 0) updates.push({ variantId: have.variantId, sku: w.sku, body });
  }
  const deletes = pool.filter((v) => v.active === true).map((v) => v.variantId);
  return { deletes, updates, creates };
}

/**
 * The groups whose sizes had different prices and now get the one price the
 * seller set for the group (the plan writes a price to one of their sizes):
 * the save says so, so no size's price changes unannounced.
 */
export function repricedMixedGroups(plan, desired, railPriceOf) {
  const labels = new Set();
  for (const update of plan.updates) {
    if (update.body.priceMinor === undefined || railPriceOf?.[update.variantId]?.mixed !== true) continue;
    const group = desired.find((want) => want.sku === update.sku)?.group;
    if (group) labels.add(group);
  }
  return [...labels];
}

// ── the images ──────────────────────────────────────────────────────────────

/**
 * The whole image list (PUT …/images): the product's own images first (the
 * first is the main image), then each group's images, each row naming the
 * group's FIRST variant (the group rule shows it on every size of the group).
 * `own`: objectIds in order. `groups`: [{ objectIds, variantId }].
 * No object twice for one owner (the server refuses that list).
 *
 * `before`: the rows the server holds (`_server.imageRows`). The PUT replaces
 * the list whole and the form edits no alt text, so each row keeps the alt
 * its object had (unit CP5-FP; the studio marks its images by their alt,
 * CP5_FN2_REPORT.md): the same object for the same owner first, else the
 * same object anywhere in the list. A row without one sends none.
 */
export function imageList(own, groups, before = []) {
  const altByRow = new Map();
  const altByObject = new Map();
  for (const row of Array.isArray(before) ? before : []) {
    if (!row || typeof row.alt !== 'string' || row.alt === '') continue;
    altByRow.set(`${row.variantId ?? ''}\n${row.objectId}`, row.alt);
    if (!altByObject.has(row.objectId)) altByObject.set(row.objectId, row.alt);
  }
  const list = [];
  const seen = new Set();
  const push = (objectId, variantId) => {
    const key = `${variantId ?? ''}\n${objectId}`;
    if (!objectId || seen.has(key)) return;
    seen.add(key);
    const alt = altByRow.get(key) ?? altByObject.get(objectId);
    list.push(alt === undefined ? { objectId, variantId: variantId ?? null } : { objectId, variantId: variantId ?? null, alt });
  };
  for (const objectId of own) push(objectId, null);
  for (const group of groups) for (const objectId of group.objectIds) push(objectId, group.variantId);
  return list;
}

/** True when two image lists hold the same rows in the same order (an alt text the list carries counts too). */
export function sameImageList(a, b) {
  return a.length === b.length && a.every((row, i) => row.objectId === b[i].objectId
    && (row.variantId ?? null) === (b[i].variantId ?? null)
    && (row.alt === undefined || row.alt === (b[i].alt ?? null)));
}

/** The objects of `before` that `after` no longer names (removed from the product). */
export function droppedObjectIds(before, after) {
  const kept = new Set(after.map((row) => row.objectId));
  return [...new Set(before.map((row) => row.objectId))].filter((id) => !kept.has(id));
}

// ── the POD numbers, as the server quotes them ──────────────────────────────

/**
 * GET /v1/admin/pod/quote → what the form shows: the floor in kr (incl. VAT,
 * as the server computes it) and "Inköp" in whole kr incl. the production VAT
 * (the server quotes it ex VAT and asks the UI to add the VAT at the edge).
 */
export function podFigures(quote) {
  if (!quote || !Number.isSafeInteger(quote.priceFloorMinor) || !Number.isSafeInteger(quote.inkopMinor)) return null;
  return {
    floorKr: quote.priceFloorMinor / 100,
    inkopKr: Math.round((quote.inkopMinor * (10_000 + PRODUCTION_VAT_BP)) / 10_000 / 100),
  };
}

/** Of several quotes (one per group), the strictest floor — the one every price must clear. */
export function strictestFigures(quotes) {
  const figures = quotes.map(podFigures).filter(Boolean);
  if (figures.length === 0) return null;
  return figures.reduce((a, b) => (b.floorKr > a.floorKr ? b : a));
}

// ── the API's refusals, in the page's words ─────────────────────────────────

const REFUSALS = {
  price_below_floor: 'Priset ligger under prisgolvet. Höj priset och spara igen.',
  pod_mapping_missing: 'Sparad som utkast — produkten visas i webbshoppen först när tryckkopplingen (med plagg valt) finns.',
  pod_mapping_suspended: 'En tryckkoppling är pausad eftersom tryckeriet inte längre kan göra den. Koppla om eller ta bort den under Print on demand.',
  pod_unavailable: 'Produkten kan inte tillverkas som den är uppsatt just nu. Kontakta plattformen.',
  // CP6-PS4: a mapping's printer model has only stand-in frames while the print canvas is on.
  pod_frame_unconfirmed: 'Tryckeriet har inte bekräftat tryckytan för plagget än, så produkten kan inte publiceras just nu. Den kan publiceras när tryckeriet har bekräftat tryckytan.',
  pod_too_large: 'Produkten har för många aktiva varianter för att prisgolvet ska kunna kontrolleras. Avpublicera den och minska varianterna till högst 200.',
  taken_down: 'Produkten är avpublicerad av plattformen efter en anmälan och kan inte publiceras.',
  variant_limit: 'Produkten har så många varianter som tillåts (högst 200 aktiva).',
};

/**
 * An API error of a product write → the sentence the seller reads, or null
 * (then the page's generic "Misslyckades med att spara produkten").
 * `context`: { step: 'product' | 'variant' | 'images' | 'publish', moreInfo?, label?, sku? }
 */
export function refusalMessage(error, context = {}) {
  const code = error?.code;
  if (code === 'unauthenticated') return 'Sessionen har gått ut. Logga in igen.';
  if (REFUSALS[code]) {
    if (code === 'price_below_floor' && context.step === 'variant' && context.label) {
      return `Priset för ${context.label} ligger under prisgolvet. Höj priset och spara igen.`;
    }
    return REFUSALS[code];
  }
  if (error?.status === 400 && context.step === 'product' && context.moreInfo) {
    return 'Mer information innehåller kod som inte är tillåten (t.ex. skript, inbäddningar, formulär eller länkar till den gamla bildlagringen). Ta bort den och spara igen.';
  }
  if (error?.status === 400 && context.step === 'images') {
    return error.reason === 'variant_not_found'
      ? 'En variant ändrades medan du sparade. Ladda om produkten och försök igen.'
      : 'En bild kunde inte användas (den är borttagen eller inte uppladdad klart). Ta bort den och försök igen.';
  }
  if (error?.status === 409 && context.step === 'variant') {
    return `Variantens SKU "${context.sku}" används redan i butiken — ändra variantens SKU.`;
  }
  if (error?.status === 409 && context.step === 'product') {
    return 'Produkten kunde inte sparas: SKU:t används redan, eller så ändrades produkten samtidigt. Ladda om och försök igen.';
  }
  if (error?.status === 413 || code === 'payload_too_large') return 'En bild är för stor (högst 15 MB).';
  if (error?.status === 400 && error.reason === 'type_not_as_stated') return 'En fil är inte en bild av de format som stöds (JPEG, PNG, WebP, GIF, AVIF).';
  return null;
}

/** The server's screening verdict after a save → the notice, or null. */
export function screeningNoticeFor(status) {
  switch (status) {
    case 'pending':
      return 'Produkten är sparad och granskas av plattformen innan den visas i butiken.';
    case 'blocked':
      return 'Produkten visas inte i butiken: plattformens granskning har stoppat den. Kontakta plattformen om du anser att det är fel.';
    case 'flagged':
      return 'Namnet/beskrivningen kan innehålla ett skyddat varumärke. Produkten publiceras men granskas av plattformen. Om du inte har rätt att använda märket kan produkten stängas av.';
    default:
      return null;
  }
}
