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
//   save      saveShopConfig({ menu }) — the fenced PATCH of the one key `menu`
//             (unit CP5-FP), the whole array replacing it. Only the keys a
//             PATCH writes are checked, so an image whose object is gone no
//             longer blocks the menu's save (the identity is not sent).
//   conflict  the settings changed since the page read them (409): the menu
//             shown follows what is stored when the other change moved the
//             menu too (the seller's menu is then lost, and said so); when it
//             moved only other settings, the seller's menu stays on the page

import { AdminApiError } from '../../api/admin/client.js';
import { listAllCollections, listAllPages } from '../../api/admin/content.js';
import { categoriesOf, menuPageTitle, settingsRefusal, tagsOf } from '../adapters/content.js';
import { mergeThree } from '../adapters/merge.js';
import { settingsConflictMessage } from '../adapters/settings.js';
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

const menuOf = (saved) => (Array.isArray(saved?.menu) ? saved.menu : []);

export async function saveMenu(menu, shopId) {
  try {
    await saveShopConfig({ menu }, shopId);
  } catch (error) {
    if (error?.code === 'settings_conflict') {
      const merged = mergeThree({ menu }, { menu: menuOf(error.before) }, { menu: menuOf(error.saved) });
      const message = settingsConflictMessage(merged.lost, { lostAnswer: error.lostAnswer });
      const refused = new Error(message, { cause: error });
      refused.userMessage = message;
      refused.menu = merged.value.menu ?? [];
      throw refused;
    }
    if (error?.userMessage) throw error;
    const message = error instanceof AdminApiError ? settingsRefusal(error) : null;
    if (message) {
      const refused = new Error(message, { cause: error });
      refused.userMessage = message;
      throw refused;
    }
    throw error;
  }
}
