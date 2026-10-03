// AdminPages' data layer — the ADMIN build's implementation (the API).
// The alias list of vite.admin.config.js puts this file where the page imports
// src/pages/admin/adminPagesData.js (the older build's, Firebase). Same names,
// same meaning; the shapes are bridged by adapters/content.js.
//
// There is no listener: the pages are read when the page opens and again after
// each change made through this module (a delete). No polling.
//
// The list route carries the title but not the content or the SEO texts, and
// the page's "Översättningar" column and its "SEO:" line read them: each page
// is read in full, four at a time.

import { deletePage, getPage, listAllPages } from '../../api/admin/content.js';
import { pageDocFromApi } from '../adapters/content.js';
import { inPool } from './contentSources.js';

const subscribers = new Set();

async function readPages(shopId) {
  const summaries = await listAllPages({}, { shopId });
  const docs = await inPool(summaries, 4, async (summary) => {
    try {
      return pageDocFromApi((await getPage(summary.pageId, { shopId })) ?? summary);
    } catch {
      return pageDocFromApi(summary);
    }
  });
  const pages = docs.filter(Boolean);
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
