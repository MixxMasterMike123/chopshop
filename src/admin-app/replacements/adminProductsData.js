// AdminProducts' data layer — the ADMIN build's implementation (the API).
// The alias list of vite.admin.config.js puts this file where the page imports
// src/pages/admin/adminProductsData.js (the older build's, Firebase). Same
// names, same meaning; the shapes are bridged by src/admin-app/adapters/product.js.
//
//   the list      GET /v1/admin/products, every page (archived ones hidden)
//   "delete"      PATCH { status: 'archived' }: an order line keeps a product
//                 (ON DELETE RESTRICT), so no product is deleted; the list
//                 hides it from then on
//   the star      PATCH { featured }
//   the order     PUT /v1/admin/products/order, 200 entries per request
//   open          GET /v1/admin/products/:id (variants, images, publication)

import { AdminApiError } from '../../api/admin/client.js';
import { getProduct, listAllProducts, setProductOrder, updateProduct } from '../../api/admin/products.js';
import { orderEntries, productFromDetail, productFromListItem } from '../adapters/product.js';
import { skuFromName } from '../../utils/productUrls';

/** The list route carries `variantCount` (the active variants): the "Varianter" column reads it. */
export const LIST_SHOWS_VARIANT_COUNT = true;

export async function loadShopProducts(shopId) {
  const items = await listAllProducts({ shopId });
  return items.map(productFromListItem).filter(Boolean);
}

/** Archives the product. An unknown one answers like the older build's (code 'not-found'). */
export async function deleteProduct(productId) {
  try {
    await updateProduct(productId, { status: 'archived' });
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) {
      const gone = new Error('Produkten finns inte');
      gone.code = 'not-found';
      throw gone;
    }
    throw error;
  }
}

export async function setProductFeatured(productId, featured) {
  await updateProduct(productId, { featured });
}

export async function saveProductOrder(orderDraft) {
  await setProductOrder(orderEntries(orderDraft));
}

/** The whole product for the form (the list row carries no variants or gallery). */
export async function openProduct(p) {
  const detail = await getProduct(p.id);
  if (!detail) throw new Error('Produkten finns inte längre');
  return productFromDetail(detail, { listItem: p, skuFromName });
}
