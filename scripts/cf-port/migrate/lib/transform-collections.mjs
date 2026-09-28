/**
 * scripts/cf-port/migrate/lib/transform-collections.mjs — manifest row 20
 * (`collections`) → collections, collection_products (0041), by the rule of
 * docs/cf-port/CP4_B_REPORT.md "For S" (open question 4):
 *
 *   id                 collection_id (kept)
 *   title, handle      through the Worker's parseCollectionInput: the handle
 *                      must be a fixed point of the slug rule (refused, never
 *                      repaired)
 *   description        description ('' = none)
 *   imageUrl           image_object_id: the copied object of this shop, kind
 *                      product_media, else none (counted by status)
 *   type, rule.tag     type; rule_tag only for a smart collection
 *   published, featured, sortOrder   their columns
 *   productIds[]       collection_products in their order: only products this
 *                      plan imports for the same shop; others left out and
 *                      counted; at most 500
 *   createdAt, updatedAt   ISO (createdAt absent → updatedAt)
 *   created_by, updated_by, external_ref   NULL (D87: the export has none)
 */

import { count, insertRow, isoOf, lookup, resolveImage, sourceMillis } from './transform-products.mjs';
import { clampForward } from './timestamps.mjs';

export const COLLECTION_COLUMNS = [
  'collection_id', 'tenant_id', 'handle', 'external_ref', 'title', 'description', 'image_object_id', 'type',
  'rule_tag', 'published', 'featured', 'sort_order', 'created_at', 'updated_at', 'created_by', 'updated_by',
];
export const MEMBER_COLUMNS = ['tenant_id', 'collection_id', 'product_id', 'position'];

const OPTIONAL_KEYS = ['description', 'featured', 'imageObjectId', 'published', 'sortOrder'];

/**
 * @param {object} args
 * @param {object} args.ctx        the shared context (transform-products.mjs)
 * @param {object[]} args.docs     decoded `collections` documents
 * @param {Map} args.tenants       the shops this plan writes into
 * @param {object} args.products   productId → { shopId, … } of the products this plan imports
 * @param {object} args.expected   the per-shop expected block (products' transform), extended here
 */
export function transformCollections({ ctx, docs, expected, products, tenants }) {
  const { nowMillis, report, rules } = ctx;
  const sections = { collection_products: [], collections: [] };
  const names = lookup(); // `${shopId}\n${name}` → true: handles and ids (the :ref namespace)

  const sorted = [...docs].sort((a, b) => (a.data?.shopId ?? '').localeCompare(b.data?.shopId ?? '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const doc of sorted) {
    const data = doc.data ?? {};
    const shopId = typeof data.shopId === 'string' ? data.shopId : null;
    if (shopId === null || !tenants.has(shopId)) {
      count(report, shopId ?? '(none)', 'collections_left_out:shop_not_in_target');
      continue;
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(doc.id)) {
      count(report, shopId, 'collections_left_out:id_shape');
      continue;
    }
    const where = `collections/${doc.id}`;
    const type = data.type === 'smart' ? 'smart' : data.type === 'manual' ? 'manual' : null;
    if (type === null) {
      count(report, shopId, 'collections_left_out:type');
      continue;
    }
    const core = {
      handle: data.handle,
      title: typeof data.title === 'string' ? ctx.textScrub(data.title, `${where}.title`) : data.title,
      type,
      ...(type === 'smart' ? { ruleTag: typeof data.rule?.tag === 'string' ? data.rule.tag : null } : {}),
    };
    if (type === 'smart' && core.ruleTag === null) {
      count(report, shopId, 'collections_left_out:smart_without_tag');
      continue;
    }
    if (rules.parseCollectionInput(core, 'create') === null) {
      count(report, shopId, 'collections_left_out:refused');
      continue;
    }
    const body = { ...core };
    if (typeof data.description === 'string') {
      const description = ctx.textScrub(data.description, `${where}.description`);
      body.description = description.trim().length === 0 ? null : description;
    }
    if (typeof data.published === 'boolean') body.published = data.published;
    if (typeof data.featured === 'boolean') body.featured = data.featured;
    if (data.sortOrder !== undefined) body.sortOrder = data.sortOrder;
    if (typeof data.imageUrl === 'string' && data.imageUrl.trim().length > 0) {
      const image = resolveImage(ctx, shopId, data.imageUrl, 'product_media');
      if (image.status === 'copied') body.imageObjectId = image.objectId;
      else count(report, shopId, `collection_covers_left_out:${image.status}`);
    }
    const kept = { ...core };
    for (const key of OPTIONAL_KEYS) {
      if (body[key] === undefined) continue;
      if (rules.parseCollectionInput({ ...core, [key]: body[key] }, 'create') === null) {
        count(report, shopId, `collection_fields_left_out:${key}`);
        continue;
      }
      kept[key] = body[key];
    }
    const input = rules.parseCollectionInput(kept, 'create');
    if (input === null) {
      count(report, shopId, 'collections_left_out:refused_together');
      continue;
    }
    // No handle in the source: the admin's rule (`handle || slugify(title)`).
    const handle = input.handle ?? rules.slugify(input.title);
    if (!rules.isCollectionHandle(handle)) {
      count(report, shopId, 'collections_left_out:handle');
      continue;
    }
    // One namespace per shop for `:ref` (0041): a handle or an id of this
    // collection may not name another collection of the shop.
    if (names[`${shopId}\n${handle}`] === true || names[`${shopId}\n${doc.id}`] === true) {
      count(report, shopId, 'collections_left_out:name_taken');
      continue;
    }
    names[`${shopId}\n${handle}`] = true;
    names[`${shopId}\n${doc.id}`] = true;

    const createdMs = sourceMillis(data.createdAt, sourceMillis(data.updatedAt, nowMillis));
    const updatedMs = clampForward(sourceMillis(data.updatedAt, createdMs), createdMs);
    sections.collections.push(
      insertRow('collections', doc.id, COLLECTION_COLUMNS, {
        collection_id: doc.id,
        created_at: isoOf(createdMs),
        created_by: null,
        description: input.description ?? null,
        external_ref: null,
        featured: input.featured ? 1 : 0,
        handle,
        image_object_id: input.imageObjectId ?? null,
        published: input.published ? 1 : 0,
        rule_tag: type === 'smart' ? input.ruleTag : null,
        sort_order: input.sortOrder ?? null,
        tenant_id: shopId,
        title: input.title,
        type,
        updated_at: isoOf(updatedMs),
        updated_by: null,
      }),
    );
    expected[shopId] ??= {};
    expected[shopId].collections = (expected[shopId].collections ?? 0) + 1;

    // ── members (manual only) ──
    const sourceIds = Array.isArray(data.productIds) ? data.productIds : [];
    if (type === 'smart') {
      if (sourceIds.length > 0) count(report, shopId, 'collection_members_left_out:smart_collection', sourceIds.length);
      continue;
    }
    const members = [];
    for (const productId of sourceIds) {
      if (typeof productId !== 'string') {
        count(report, shopId, 'collection_members_left_out:not_an_id');
      } else if (members.includes(productId)) {
        count(report, shopId, 'collection_members_left_out:repeated');
      } else if (products[productId]?.shopId !== shopId) {
        count(report, shopId, 'collection_members_left_out:product_not_imported');
      } else if (members.length >= rules.MAX_COLLECTION_PRODUCTS) {
        count(report, shopId, 'collection_members_left_out:over_cap');
      } else {
        members.push(productId);
      }
    }
    if (rules.parseCollectionProductsInput(members) === null) {
      ctx.problems.push(`INTERNAL: collections/${doc.id}: a member list the Worker would refuse`);
      continue;
    }
    members.forEach((productId, position) => {
      sections.collection_products.push(
        insertRow('collection_products', `${doc.id}:${productId}`, MEMBER_COLUMNS, { collection_id: doc.id, position, product_id: productId, tenant_id: shopId }),
      );
    });
    expected[shopId].collectionMembers = (expected[shopId].collectionMembers ?? 0) + members.length;
  }
  return { sections };
}
