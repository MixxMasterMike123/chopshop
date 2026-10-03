// AdminPages' data layer — the ADMIN build's implementation (the API).
// The alias list of vite.admin.config.js puts this file where the page imports
// src/pages/admin/adminPagesData.js (the older build's, Firebase). Same names,
// same meaning; the shapes are bridged by adapters/content.js.
//
// There is no listener: the pages are read when the page opens and again after
// each change made through this module (a delete). No polling.
//
// The list route carries the SEO texts (metaTitle, metaDescription) and the
// languages that have content (contentLanguages), which is all the page's
// "Översättningar" column and its "SEO:" line read: one list, no read per page.

import { deletePage, listAllPages } from '../../api/admin/content.js';
import { pageDocFromApi } from '../adapters/content.js';

const subscribers = new Set();

async function readPages(shopId) {
  const pages = (await listAllPages({}, { shopId })).map(pageDocFromApi).filter(Boolean);
  // Newest change first, as the older build's fallback sorts.
  pages.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
  return pages;
}

export function subscribeToPages(shopId, onPages, onError) {
  let live = true;
  let latest = 0;
  const subscriber = {
    async refresh() {
      const mine = ++latest;
      try {
        const pages = await readPages(shopId);
        if (live && mine === latest) onPages(pages);
      } catch (error) {
        if (live && mine === latest) onError(error);
      }
    },
  };
  subscribers.add(subscriber);
  subscriber.refresh();
  return () => {
    live = false;
    subscribers.delete(subscriber);
  };
}

export async function deleteShopPage(pageId) {
  await deletePage(pageId);
  await Promise.all([...subscribers].map((s) => s.refresh()));
}
