// The shop's products as the catalogue's content pages (the collection picker,
// the menu builder, the storefront's category list) read them (CP5 brief FG).
//
// GET /v1/admin/products lists a product WITH its tags (unit WJ), so the
// smart-collection tag picker and the menu's tag list read them from the same
// list: one pass over the pages, no read per product, no cap.

import { listAllProducts } from '../../api/admin/products.js';

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
export async function loadProductsWithTags(shopId) {
  const items = (await listAllProducts({ shopId })).filter((p) => p.status !== 'archived');
  return items.map((item) => ({ item, tags: Array.isArray(item.tags) ? item.tags : [] }));
}
