/**
 * scripts/cf-port/migrate/lib/transform-products.mjs — manifest row 51
 * (`products`) → products, product_variants, product_tags, product_images,
 * product_publications, product_screening (0005, 0009, 0024, 0031, 0040).
 *
 * THE RULE is the field table of docs/cf-port/CP4_A_REPORT.md §1 and its
 * "For S" note; every value goes through the Worker's own parsers
 * (lib/worker-rules.mjs), so an imported row is one the admin routes could
 * have written:
 *
 *   id                        products.product_id (kept, as CP3 keeps ids)
 *   sku, name                 products.sku, name (parseCreateProductInput)
 *   b2cPrice ?? basePrice     b2c_price_minor: kronor → öre, exact or the
 *                             product is left out (never rounded)
 *   descriptions.b2c ?? description   description ('' = none)
 *   descriptions.b2cMoreInfo  more_info (HTML: the Worker's checkHtml)
 *   category || group         category + category_key (slugify)
 *   tags[]                    product_tags (tag as typed, key = slugify)
 *   featured                  featured (the legacy `featured` tag while unset)
 *   sortOrder, compareAtPrice, size, sizeGuide, brand, eanCode, stock,
 *   launchDate                their columns (compareAtPrice 0 = none)
 *   delivery.{shipping,pickup}  allow_shipping / allow_pickup: ON unless
 *                             explicitly false, as every reader of the source
 *                             decides (Cart, PublicProductPage, createPaymentIntent)
 *   weight.value              weight_grams (the source prices carriage from
 *                             the value as grams, whatever the unit)
 *   shipping.{region}.cost    shipping_json, kronor → öre, exact or dropped
 *   isPodProduct              is_pod (D83: imported WITHOUT a mapping)
 *   isActive                  status: active, else draft
 *   isActive && availability.b2c   a publication row, published = 1
 *   handle                    productHandle(name, size, sku)
 *   variants[]                product_variants, one per source variant, in
 *                             the source's order (position), the rail's group
 *                             and size; the id derived (lib/ids.mjs)
 *   images                    product_images by OBJECT ID from the copy
 *                             manifest: the product's own first
 *                             (b2cImageUrl, else imageUrl, then the gallery),
 *                             then each group's once, anchored on its first
 *                             variant (THE GROUP RULE, CP4_A_REPORT §4)
 *   screening                 a published product gets the row a new product
 *                             of an established shop gets from the Worker
 *                             (advisory, nothing found yet) with the term
 *                             version EMPTY, so the re-screen sweep screens it
 *                             (D72). Never approved by the importer.
 *
 * Not carried (A's field table): hasVariants, options[], variantGroups as a
 * structure, color, reviewCount/ratingSum, podCostSek, podPrinterUid, b2bPrice,
 * availability.b2b, dimensions, migratedFrom, wooKey, shopifyKey.
 *
 * Nothing here prints a value of a row: the report holds counts by shop.
 */

import { deterministicId } from './ids.mjs';
import { insertStatement } from './sql.mjs';
import { carriedRow, rowContentHash } from './plan.mjs';
import { parseSourceTimestampMillis, clampForward } from './timestamps.mjs';
import { KEEP_ADDRESSES, looksLikeEmail, resolveEmail } from './scrub.mjs';
import { KINDS, lookupAddress } from './copy-manifest.mjs';

// ── shared by the four catalogue transforms ─────────────────────────────────

/** One count under a shop: report.byShop[shop][key] += n. */
export function count(report, shopId, key, n = 1) {
  report.byShop[shopId] ??= {};
  report.byShop[shopId][key] = (report.byShop[shopId][key] ?? 0) + n;
}

export function newReport() {
  return { byShop: {} };
}

/**
 * A lookup keyed by text, with no prototype (so an id such as "__proto__" is
 * data). Plain objects rather than Map/Set: test/no-write-calls.test.mjs
 * refuses any write-shaped method call (set, add, …) in this directory, as CP3's modules do.
 */
export function lookup() {
  return Object.create(null);
}

/**
 * A carried row: the INSERT and its row-hash bookkeeping (lib/plan.mjs), with
 * its values kept beside it for the importer's own checks (never written).
 */
export function insertRow(table, pk, columns, values) {
  return { ...carriedRow(table, pk, insertStatement(table, columns, values), rowContentHash(table, columns, values)), values };
}

export function isoOf(millis) {
  return new Date(millis).toISOString();
}

/** Kronor (a finite number) → öre, only when exact; else null. */
export function krToMinorExact(kronor) {
  if (typeof kronor !== 'number' || !Number.isFinite(kronor) || kronor < 0) return null;
  const minor = Math.round(kronor * 100);
  // A whole number of öre as the source stores it (a float such as 19.9
  // multiplies to 1989.9999…): within a millionth of an öre, else refused.
  return Math.abs(kronor * 100 - minor) < 1e-6 && Number.isSafeInteger(minor) ? minor : null;
}

/** The time of a source value in ms, the fallback when absent or unreadable. */
export function sourceMillis(value, fallbackMillis) {
  return parseSourceTimestampMillis(value, fallbackMillis);
}

// The pattern lib/scan-source-addresses.mjs finds an address with; the
// replacement below must find the same ones.
const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Staging (D20, S3): every e-mail address a written TEXT holds goes through
 * the email map, or with `scrubUnmapped` becomes the placeholder; an address
 * in neither refuses the run (UnmappedEmailError). Production keeps them.
 * The function returns the new text; `actions` counts what happened.
 */
export function makeTextScrubber({ emailMap, scrubUnmapped }) {
  const actions = { mapped: 0, scrubbed: 0 };
  function scrub(value, where) {
    if (typeof value !== 'string' || emailMap === KEEP_ADDRESSES || !value.includes('@')) return value;
    return value.replace(EMAIL_IN_TEXT, (match) => {
      if (!looksLikeEmail(match)) return match;
      const resolved = resolveEmail(match, emailMap, scrubUnmapped, where);
      if (resolved.action !== 'unchanged') actions[resolved.action] += 1;
      return resolved.value;
    });
  }
  return { actions, scrub };
}

/**
 * An image address of a row → its copied object, or why not. Only an entry
 * the copy manifest holds as `copied` FOR THIS SHOP, of the kind the reader
 * of the row asks for, names an object; every other case is a status that
 * the caller counts, and the row is written without that image.
 *   empty | not_source_storage | not_in_manifest | refused | missing |
 *   failed | wrong_kind | copied
 */
export function resolveImage(ctx, shopId, address, kind) {
  if (typeof address !== 'string' || address.trim().length === 0) return { status: 'empty' };
  if (!ctx.rules.isSourceStorageAddress(address)) return { status: 'not_source_storage' };
  const entry = lookupAddress(ctx.index, shopId, address, kind);
  if (entry === null) {
    const ofAnotherKind = KINDS.some((other) => other !== kind && lookupAddress(ctx.index, shopId, address, other) !== null);
    return { status: ofAnotherKind ? 'wrong_kind' : 'not_in_manifest' };
  }
  if (entry.status !== 'copied') return { status: entry.status };
  ctx.usedObjects.push({ entry, kind, objectId: entry.objectId, tenantId: shopId });
  return { entry, objectId: entry.objectId, status: 'copied' };
}

// ── products ────────────────────────────────────────────────────────────────

export const PRODUCT_COLUMNS = [
  'product_id', 'tenant_id', 'status', 'sku', 'name', 'description', 'b2c_price_minor', 'currency', 'is_pod',
  'weight_grams', 'allow_shipping', 'allow_pickup', 'shipping_json', 'is_personalized', 'handle', 'featured',
  'sort_order', 'compare_at_price_minor', 'category', 'category_key', 'more_info', 'size_guide', 'size', 'brand',
  'ean_code', 'stock', 'launch_date', 'created_at', 'updated_at',
];
export const VARIANT_COLUMNS = [
  'variant_id', 'tenant_id', 'product_id', 'sku', 'label', 'price_minor', 'active', 'variant_group', 'size',
  'position', 'created_at', 'updated_at',
];
export const TAG_COLUMNS = ['tenant_id', 'product_id', 'tag_key', 'tag', 'position'];
export const IMAGE_COLUMNS = ['tenant_id', 'product_id', 'position', 'variant_id', 'object_id', 'alt', 'created_at'];
export const PUBLICATION_COLUMNS = [
  'product_id', 'tenant_id', 'published', 'public_name', 'public_description', 'public_price_minor', 'currency',
  'projection_version', 'published_at', 'updated_at',
];
export const SCREENING_COLUMNS = [
  'product_id', 'tenant_id', 'status', 'reason', 'hits_json', 'earlier_hits_json', 'requires_approval',
  'decided_by', 'decided_at', 'version', 'created_at', 'updated_at', 'screened_tokens', 'screened_raw', 'terms_version',
];

/** The decider of a screening row the importer writes (0024: 1–128 chars). */
export const IMPORT_ACTOR = 'import';

const OPTIONAL_CONTENT_KEYS = [
  'allowPickup', 'allowShipping', 'brand', 'category', 'compareAtPriceMinor', 'description', 'eanCode', 'featured',
  'launchDate', 'moreInfo', 'shippingRates', 'size', 'sizeGuide', 'sortOrder', 'stock', 'tags', 'weightGrams',
];

function isProductFeatured(data) {
  // src/utils/productSorting.js isProductFeatured, the source's rule.
  if (data.featured === true) return true;
  if (data.featured === false) return false;
  return Array.isArray(data.tags) && data.tags.some((tag) => String(tag).toLowerCase() === 'featured');
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** The tag list the admin could write: typed, 1–50, with an address, once per address, at most `max`. */
function cleanTags(ctx, shopId, raw, max) {
  const tags = [];
  const keys = lookup();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'string') {
      count(ctx.report, shopId, 'tags_left_out:not_text');
      continue;
    }
    const tag = entry.normalize('NFC').trim();
    // eslint-disable-next-line no-control-regex
    if (tag.length === 0 || tag.length > 50 || /[\u0000-\u001f\u007f]/.test(tag)) {
      count(ctx.report, shopId, 'tags_left_out:invalid');
      continue;
    }
    const key = ctx.rules.slugify(tag);
    if (key === '') {
      count(ctx.report, shopId, 'tags_left_out:no_address');
      continue;
    }
    if (keys[key] === true) {
      count(ctx.report, shopId, 'tags_left_out:same_address');
      continue;
    }
    if (tags.length >= max) {
      count(ctx.report, shopId, 'tags_left_out:over_cap');
      continue;
    }
    keys[key] = true;
    tags.push(tag);
  }
  return tags;
}

/** The source's carriage table in the admin's wire form, öre; null when a cost is not exact. */
function shippingRatesOf(ctx, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const wire = {};
  for (const region of ctx.rules.SHIPPING_REGIONS) {
    if (!Object.hasOwn(raw, region)) continue;
    const cost = krToMinorExact(raw[region]?.cost);
    if (cost === null) return null;
    wire[region] = { cost };
  }
  return wire;
}

/**
 * The admin's create body for one product, every optional field checked on
 * its own through parseCreateProductInput: a field the Worker refuses is left
 * out and counted, the rest is imported. Returns the parsed input, or null
 * with a reason when the core (sku, name, price, currency) is refused.
 */
function parseProduct(ctx, shopId, body) {
  const core = { currency: body.currency, name: body.name, priceMinor: body.priceMinor, sku: body.sku };
  if (ctx.rules.parseCreateProductInput(core) === null) return { reason: 'core_refused' };
  const kept = { ...core };
  for (const key of OPTIONAL_CONTENT_KEYS) {
    if (body[key] === undefined) continue;
    if (ctx.rules.parseCreateProductInput({ ...core, [key]: body[key] }) === null) {
      count(ctx.report, shopId, `product_fields_left_out:${key}`);
      continue;
    }
    kept[key] = body[key];
  }
  const input = ctx.rules.parseCreateProductInput(kept);
  return input === null ? { reason: 'refused_together' } : { input };
}

/** A text of the source for a written column: e-mail addresses scrubbed; a
 * source-storage address makes it unusable (counted, left out). */
function textField(ctx, shopId, value, where, fieldName) {
  if (typeof value !== 'string') return undefined;
  const scrubbed = ctx.textScrub(value, where);
  if (ctx.rules.isSourceStorageAddress(scrubbed)) {
    count(ctx.report, shopId, `product_fields_left_out:${fieldName}:storage_address`);
    return undefined;
  }
  return scrubbed;
}

function imageTier(own, groups) {
  // THE CAP (30 rows): the main image first, then each colour's first photo
  // (so every colour keeps its picture), then the rest of the product's own,
  // then the rest of each colour's, in their order. What is kept keeps its
  // natural order: the product's own, then the colours in rail order.
  const ranked = [];
  own.forEach((image, i) => ranked.push({ image, tier: i === 0 ? 0 : 2 }));
  groups.forEach((group) => group.forEach((image, i) => ranked.push({ image, tier: i === 0 ? 1 : 3 })));
  return ranked;
}

/**
 * @param {object} args
 * @param {object[]} args.docs         decoded `products` documents
 * @param {Map<string,{currency:string}>} args.tenants  the shops this plan writes into
 * @param {object} args.ctx            { env, nowMillis, rules, index, report, textScrub, usedObjects }
 * @returns {{ sections, products: object (productId → facts), expected }}
 */
export function transformProducts({ ctx, docs, tenants }) {
  const { env, nowMillis, rules, report } = ctx;
  const sections = { product_images: [], product_publications: [], product_screening: [], product_tags: [], product_variants: [], products: [] };
  const products = lookup();
  const expected = lookup();
  // `${shopId}\n${value}` → true: a sku, a handle and a variant sku are unique per shop.
  const productSkus = lookup();
  const handles = lookup();
  const variantSkus = lookup();
  const nowIso = isoOf(nowMillis);

  const sorted = [...docs].sort((a, b) => (a.data?.shopId ?? '').localeCompare(b.data?.shopId ?? '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const doc of sorted) {
    const data = doc.data ?? {};
    const shopId = typeof data.shopId === 'string' ? data.shopId : null;
    if (shopId === null) {
      count(report, '(none)', 'products_left_out:no_shop');
      continue;
    }
    const tenant = tenants.get(shopId);
    if (tenant === undefined) {
      count(report, shopId, 'products_left_out:shop_not_in_target');
      continue;
    }
    expected[shopId] ??= { collectionMembers: 0, collections: 0, images: 0, pages: 0, podProducts: 0, products: 0, publicIfLive: [], publications: 0, screening: 0, sourcePublic: 0, tags: 0, variants: 0 };
    const exp = expected[shopId];
    const where = `products/${doc.id}`;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(doc.id)) {
      count(report, shopId, 'products_left_out:id_shape');
      continue;
    }

    const priceMinor = krToMinorExact(data.b2cPrice ?? data.basePrice);
    if (priceMinor === null) {
      count(report, shopId, 'products_left_out:price_not_exact');
      continue;
    }
    const name = typeof data.name === 'string' ? ctx.textScrub(data.name, `${where}.name`) : null;
    if (name === null || rules.isSourceStorageAddress(name)) {
      count(report, shopId, 'products_left_out:name');
      continue;
    }

    const body = { currency: tenant.currency, name, priceMinor, sku: data.sku };
    const description = textField(ctx, shopId, data.descriptions?.b2c ?? data.description, `${where}.description`, 'description');
    if (description !== undefined) body.description = nonEmptyText(description) === null ? null : description;
    const moreInfo = textField(ctx, shopId, data.descriptions?.b2cMoreInfo, `${where}.moreInfo`, 'moreInfo');
    if (moreInfo !== undefined && nonEmptyText(moreInfo) !== null) body.moreInfo = moreInfo;
    const sizeGuide = textField(ctx, shopId, data.sizeGuide, `${where}.sizeGuide`, 'sizeGuide');
    if (sizeGuide !== undefined && nonEmptyText(sizeGuide) !== null) body.sizeGuide = sizeGuide;
    const category = nonEmptyText(data.category) ?? nonEmptyText(data.group);
    if (category !== null) body.category = textField(ctx, shopId, category, `${where}.category`, 'category');
    for (const [key, source] of [['size', data.size], ['brand', data.brand], ['eanCode', data.eanCode]]) {
      const text = textField(ctx, shopId, source, `${where}.${key}`, key);
      if (text !== undefined && nonEmptyText(text) !== null) body[key] = text;
    }
    if (data.launchDate !== undefined && data.launchDate !== null) body.launchDate = data.launchDate;
    if (typeof data.stock === 'number') body.stock = data.stock;
    if (typeof data.sortOrder === 'number') body.sortOrder = data.sortOrder;
    body.featured = isProductFeatured(data);
    if (data.featured !== true && data.featured !== false && body.featured) count(report, shopId, 'featured_from_legacy_tag');
    if (typeof data.compareAtPrice === 'number') {
      if (data.compareAtPrice > 0) {
        const compareAt = krToMinorExact(data.compareAtPrice);
        if (compareAt === null) count(report, shopId, 'product_fields_left_out:compareAtPriceMinor:not_exact');
        else body.compareAtPriceMinor = compareAt;
      } else {
        // The source shows a compare-at price only above 0 (getCompareAtPrice).
        count(report, shopId, 'compare_at_price_zero_as_none');
      }
    }
    body.allowShipping = data.delivery?.shipping !== false;
    body.allowPickup = data.delivery?.pickup !== false;
    if (data.delivery === undefined || data.delivery === null) count(report, shopId, 'delivery_absent_both_on');
    if (data.weight !== undefined && data.weight !== null) {
      const grams = data.weight?.value;
      if (typeof grams === 'number' && Number.isSafeInteger(grams) && grams >= 0 && grams <= rules.MAX_WEIGHT_GRAMS) body.weightGrams = grams;
      else count(report, shopId, 'product_fields_left_out:weightGrams');
      if (data.weight?.unit !== undefined && data.weight.unit !== 'g') count(report, shopId, 'weight_unit_not_g_value_kept_as_grams');
    }
    if (data.shipping !== undefined && data.shipping !== null) {
      const rates = shippingRatesOf(ctx, data.shipping);
      if (rates === null || rates === undefined) count(report, shopId, 'product_fields_left_out:shippingRates');
      else body.shippingRates = rates;
    }
    const tags = cleanTags(ctx, shopId, (Array.isArray(data.tags) ? data.tags : []).map((tag) => (typeof tag === 'string' ? ctx.textScrub(tag, `${where}.tags`) : tag)), rules.MAX_PRODUCT_TAGS);
    if (tags.length > 0) body.tags = tags;
    if (data.isPersonalized === true) count(report, shopId, 'is_personalized_not_carried');

    const parsed = parseProduct(ctx, shopId, body);
    if (parsed.input === undefined) {
      count(report, shopId, `products_left_out:${parsed.reason}`);
      continue;
    }
    const input = parsed.input;
    const handle = rules.productHandle(input.name, input.size ?? null, input.sku);

    if (productSkus[`${shopId}\n${input.sku}`] === true || handles[`${shopId}\n${handle}`] === true) {
      count(report, shopId, 'products_left_out:sku_or_handle_taken');
      continue;
    }
    productSkus[`${shopId}\n${input.sku}`] = true;
    handles[`${shopId}\n${handle}`] = true;

    const createdMs = sourceMillis(data.createdAt, sourceMillis(data.updatedAt, nowMillis));
    const updatedMs = clampForward(sourceMillis(data.updatedAt, createdMs), createdMs);
    const isActive = data.isActive === true;
    const published = isActive && data.availability?.b2c === true;
    const isPod = data.isPodProduct === true;
    const status = isActive ? 'active' : 'draft';
    if (!isActive) count(report, shopId, 'products_inactive_as_draft');
    if (isActive && !published) count(report, shopId, 'products_active_not_published');

    const shippingJson = (() => {
      const stored = input.shippingRates === undefined || input.shippingRates === null ? null : rules.emptyToNull(input.shippingRates);
      return stored === null ? null : JSON.stringify(rules.toShippingRatesWire(stored));
    })();
    const productRow = {
      allow_pickup: input.allowPickup ?? false ? 1 : 0,
      allow_shipping: input.allowShipping ?? true ? 1 : 0,
      b2c_price_minor: input.priceMinor,
      brand: input.brand ?? null,
      category: input.category ?? null,
      category_key: input.category === undefined || input.category === null ? null : rules.slugify(input.category),
      compare_at_price_minor: input.compareAtPriceMinor ?? null,
      created_at: createdMs,
      currency: input.currency,
      description: input.description ?? null,
      ean_code: input.eanCode ?? null,
      featured: input.featured ? 1 : 0,
      handle,
      is_personalized: 0,
      is_pod: isPod ? 1 : 0,
      launch_date: input.launchDate ?? null,
      more_info: input.moreInfo ?? null,
      name: input.name,
      product_id: doc.id,
      shipping_json: shippingJson,
      size: input.size ?? null,
      size_guide: input.sizeGuide ?? null,
      sku: input.sku,
      sort_order: input.sortOrder ?? null,
      status,
      stock: input.stock ?? null,
      tenant_id: shopId,
      updated_at: updatedMs,
      weight_grams: input.weightGrams ?? 0,
    };
    sections.products.push(insertRow('products', doc.id, PRODUCT_COLUMNS, productRow));
    exp.products += 1;
    if (isPod) exp.podProducts += 1;
    if (published) exp.sourcePublic += 1;

    // ── variants ──
    const keptVariants = [];
    const sourceVariants = Array.isArray(data.variants) ? data.variants : [];
    if (sourceVariants.length === 0 && Array.isArray(data.variantGroups) && data.variantGroups.length > 0) {
      count(report, shopId, 'variant_groups_without_variants_not_expanded');
    }
    sourceVariants.forEach((variant, index) => {
      if (variant === null || typeof variant !== 'object') {
        count(report, shopId, 'variants_left_out:not_an_object');
        return;
      }
      const variantPrice = krToMinorExact(variant.price);
      if (variantPrice === null) {
        count(report, shopId, 'variants_left_out:price_not_exact');
        return;
      }
      const sku = typeof variant.sku === 'string' ? variant.sku : null;
      if (sku === null || sku.length === 0) {
        count(report, shopId, 'variants_left_out:sku');
        return;
      }
      const label = typeof variant.label === 'string' ? ctx.textScrub(variant.label, `${where}.variants.label`) : variant.label;
      const group = nonEmptyText(variant.group) === null ? undefined : ctx.textScrub(variant.group, `${where}.variants.group`);
      const size = nonEmptyText(variant.size) === null ? undefined : ctx.textScrub(variant.size, `${where}.variants.size`);
      // The admin's parser caps a sku at 64 characters; the column has no cap
      // (0005), and the source sells such variants. The sku is kept as is and
      // counted; every other field passes the admin's own parser.
      const overAdminCap = sku.length > 64;
      const parsedVariant = rules.parseCreateVariantInput({
        active: true,
        label,
        position: index,
        priceMinor: variantPrice,
        sku: overAdminCap ? 'sku' : sku,
        ...(group === undefined ? {} : { group }),
        ...(size === undefined ? {} : { size }),
      });
      if (parsedVariant === null) {
        count(report, shopId, 'variants_left_out:refused');
        return;
      }
      if (variantSkus[`${shopId}\n${sku}`] === true) {
        count(report, shopId, 'variants_left_out:sku_taken');
        return;
      }
      if (keptVariants.length >= rules.MAX_ACTIVE_VARIANTS || keptVariants.length >= rules.MAX_PRODUCT_VARIANTS) {
        count(report, shopId, 'variants_left_out:over_cap');
        return;
      }
      if (overAdminCap) count(report, shopId, 'variant_sku_longer_than_admin_accepts');
      variantSkus[`${shopId}\n${sku}`] = true;
      const variantId = deterministicId('product_variant', env, doc.id, sku);
      keptVariants.push({ group: parsedVariant.group, source: variant, variantId });
      sections.product_variants.push(
        insertRow('product_variants', variantId, VARIANT_COLUMNS, {
          active: 1,
          created_at: createdMs,
          label: parsedVariant.label,
          position: index,
          price_minor: parsedVariant.priceMinor,
          product_id: doc.id,
          size: parsedVariant.size,
          sku,
          tenant_id: shopId,
          updated_at: updatedMs,
          variant_group: parsedVariant.group,
          variant_id: variantId,
        }),
      );
      exp.variants += 1;
    });

    // ── tags ──
    (input.tags ?? []).forEach((tag, position) => {
      const tagKey = rules.slugify(tag);
      sections.product_tags.push(insertRow('product_tags', `${doc.id}:${tagKey}`, TAG_COLUMNS, { position, product_id: doc.id, tag, tag_key: tagKey, tenant_id: shopId }));
      exp.tags += 1;
    });

    // ── images (the group rule) ──
    const resolveList = (addresses) => {
      const objects = [];
      for (const address of [...new Set(addresses.filter((a) => typeof a === 'string' && a.trim().length > 0))]) {
        const resolved = resolveImage(ctx, shopId, address, 'product_media');
        if (resolved.status !== 'copied') {
          count(report, shopId, `images_left_out:${resolved.status}`);
          continue;
        }
        if (!objects.includes(resolved.objectId)) objects.push(resolved.objectId);
      }
      return objects;
    };
    const firstOwn = nonEmptyText(data.b2cImageUrl) ?? nonEmptyText(data.imageUrl);
    const own = resolveList([firstOwn, ...(Array.isArray(data.b2cImageGallery) ? data.b2cImageGallery : [])]);
    const groupsByLabel = lookup();
    for (const group of Array.isArray(data.variantGroups) ? data.variantGroups : []) {
      if (group && typeof group === 'object' && typeof group.label === 'string' && groupsByLabel[group.label] === undefined) groupsByLabel[group.label] = group;
    }
    const anchors = [];
    const seenGroups = lookup();
    for (const kept of keptVariants) {
      const key = kept.group === null ? `variant:${kept.variantId}` : `group:${kept.group}`;
      if (seenGroups[key] === true) continue;
      seenGroups[key] = true;
      const railGroup = kept.group === null ? undefined : groupsByLabel[kept.source.group];
      const holder = railGroup ?? kept.source;
      const images = resolveList([holder.image, ...(Array.isArray(holder.images) ? holder.images : [])]);
      anchors.push({ images, variantId: kept.variantId });
    }
    const ranked = imageTier(own, anchors.map((a) => a.images));
    const keep = new Set(
      ranked
        .map((entry, order) => ({ ...entry, order }))
        .sort((a, b) => a.tier - b.tier || a.order - b.order)
        .slice(0, rules.MAX_PRODUCT_IMAGES)
        .map((entry) => entry.order),
    );
    if (ranked.length > rules.MAX_PRODUCT_IMAGES) {
      count(report, shopId, 'images_left_out:over_cap', ranked.length - rules.MAX_PRODUCT_IMAGES);
      count(report, shopId, 'products_with_images_over_cap');
    }
    const imageList = [];
    let order = 0;
    for (const objectId of own) {
      if (keep.has(order)) imageList.push({ objectId, variantId: null });
      order += 1;
    }
    for (const anchor of anchors) {
      for (const objectId of anchor.images) {
        if (keep.has(order)) imageList.push({ objectId, variantId: anchor.variantId });
        order += 1;
      }
    }
    if (rules.parseProductImagesInput(imageList) === null) {
      // Cannot happen after the cap and the de-duplication above; refused loudly if it does.
      ctx.problems.push(`INTERNAL: products/${shopId}: an image list the Worker would refuse`);
    }
    imageList.forEach((image, position) => {
      sections.product_images.push(
        insertRow('product_images', `${doc.id}:${position}`, IMAGE_COLUMNS, {
          alt: null,
          created_at: nowIso,
          object_id: image.objectId,
          position,
          product_id: doc.id,
          tenant_id: shopId,
          variant_id: image.variantId,
        }),
      );
      exp.images += 1;
    });
    if (imageList.length === 0) count(report, shopId, 'products_without_image');

    // ── publication + screening ──
    if (published) {
      sections.product_publications.push(
        insertRow('product_publications', doc.id, PUBLICATION_COLUMNS, {
          currency: input.currency,
          product_id: doc.id,
          projection_version: 1,
          public_description: input.description ?? null,
          public_name: input.name,
          public_price_minor: input.priceMinor,
          published: 1,
          published_at: updatedMs,
          tenant_id: shopId,
          updated_at: updatedMs,
        }),
      );
      sections.product_screening.push(
        insertRow('product_screening', doc.id, SCREENING_COLUMNS, {
          created_at: nowIso,
          decided_at: nowIso,
          decided_by: IMPORT_ACTOR,
          earlier_hits_json: '[]',
          hits_json: '[]',
          product_id: doc.id,
          reason: null,
          requires_approval: 0,
          screened_raw: null,
          screened_tokens: null,
          status: 'advisory',
          tenant_id: shopId,
          terms_version: null,
          updated_at: nowIso,
          version: 1,
        }),
      );
      exp.publications += 1;
      exp.screening += 1;
      if (!isPod) exp.publicIfLive.push(doc.id);
    }
    products[doc.id] = { handle, isPod, published, shopId, status };
  }
  for (const exp of Object.values(expected)) exp.publicIfLive.sort();
  return { expected, products, sections };
}
