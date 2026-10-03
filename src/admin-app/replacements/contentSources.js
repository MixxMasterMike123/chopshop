// The shop's products as the catalogue's content pages (the collection picker,
// the menu builder, the storefront's category list) read them (CP5 brief FG).
//
// GET /v1/admin/products lists a product with its category but WITHOUT its
// tags; the tags are on the product's own read. The smart-collection tag
// picker and the menu's tag list need them, so the detail of each product is
// read, a few at a time. Bounded: at most TAG_READ_CAP products are read for
// tags (the first ones, in the list's order); the rest are listed without.
// The answer is held for TAG_TTL_MS so that two pages opened in a row read once.
// (A `tags` field on the list item, or a tag list route, would make this one
// request: see the report's open questions.)

import { getProduct, listAllProducts } from '../../api/admin/products.js';

export const TAG_READ_CAP = 300;
const TAG_READ_PARALLEL = 8;
const TAG_TTL_MS = 30_000;

const held = new Map(); // shopId → { at, promise }

export async function inPool(items, size, work) {
  const out = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]);
    }
  });
  await Promise.all(lanes);
  return out;
}

/** → [{ item: AdminProductListItem, tags: string[] }] for every product of the shop (archived ones left out). */
export function loadProductsWithTags(shopId) {
  const hit = held.get(shopId);
  if (hit && Date.now() - hit.at < TAG_TTL_MS) return hit.promise;
  const promise = (async () => {
    const items = (await listAllProducts({ shopId })).filter((p) => p.status !== 'archived');
    const tagged = items.slice(0, TAG_READ_CAP);
    const tags = await inPool(tagged, TAG_READ_PARALLEL, async (item) => {
      try {
        const detail = await getProduct(item.productId, { shopId });
        return Array.isArray(detail?.product?.tags) ? detail.product.tags : [];
      } catch {
        return [];
      }
    });
    return items.map((item, i) => ({ item, tags: tags[i] ?? [] }));
  })();
  held.set(shopId, { at: Date.now(), promise });
  promise.catch(() => held.delete(shopId));
  return promise;
}

/** Forgets what was read (after a write that changes products: none here, for tests). */
export function forgetProducts() {
  held.clear();
}
