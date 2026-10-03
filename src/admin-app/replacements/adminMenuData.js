// AdminMenu's data layer — the ADMIN build's implementation (the API).
// The alias list of vite.admin.config.js puts this file where the page imports
// src/pages/admin/adminMenuData.js (the older build's, Firebase). Same names,
// same meaning.
//
//   sources   the products (categories, and the tags of each: contentSources.js),
//             the published collections and the published pages, by their
//             admin lists
//   the menu  the identity's `menu` (GET /v1/admin/settings through
//             shopConfig.js)
//   save      saveShopConfig({ menu }) — the whole array replaces the key. A
//             stored image id whose object is gone is cleared in the same save,
//             or the identity would be refused for it.

import { AdminApiError } from '../../api/admin/client.js';
import { listAllCollections, listAllPages } from '../../api/admin/content.js';
import { getSettings } from '../../api/admin/settings.js';
import { categoriesOf, menuPageTitle, settingsRefusal, tagsOf } from '../adapters/content.js';
import { deadReferencesPatch, readImages } from './brandingImages.js';
import { loadProductsWithTags } from './contentSources.js';
import { loadShopConfig, saveShopConfig } from './shopConfig.js';

const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', 'sv');

export async function loadMenuBuilder(shopId) {
  const [cfg, products, collections, pages] = await Promise.all([
    loadShopConfig(shopId),
    loadProductsWithTags(shopId),
    listAllCollections({ shopId }),
    listAllPages({ status: 'published' }, { shopId }),
  ]);
  return {
    menu: Array.isArray(cfg?.menu) ? cfg.menu : [],
    categories: categoriesOf(products.map((row) => row.item)),
    tags: tagsOf(products.map((row) => ({ tags: row.tags }))),
    collections: collections
      .filter((c) => c.published === true)
      .map((c) => ({ handle: c.handle, title: c.title }))
      .sort(byTitle),
    pages: pages
      .filter((p) => p.status === 'published' && p.slug)
      .map((p) => ({ slug: p.slug, title: menuPageTitle(p.title) }))
      .sort(byTitle),
  };
}

export async function saveMenu(menu, shopId) {
  try {
    const identity = (await getSettings({ shopId }))?.storeIdentity ?? {};
    const dead = deadReferencesPatch(identity, await readImages(identity, shopId));
    await saveShopConfig({ menu, ...dead }, shopId);
  } catch (error) {
    const message = error instanceof AdminApiError ? settingsRefusal(error) : null;
    if (message) {
      const refused = new Error(message, { cause: error });
      refused.userMessage = message;
      throw refused;
    }
    throw error;
  }
}
