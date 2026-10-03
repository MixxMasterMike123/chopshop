// AdminMenu's data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminMenu.jsx) reaches its data only through this module; the
// admin build swaps it, by its alias list, for
// src/admin-app/replacements/adminMenuData.js (the API). Both export the same
// names with the same meaning. Everything here is the page's former inline
// code, moved and unchanged.

import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { loadShopConfig, saveShopConfig } from '../../config/shopConfig';

const pageTitle = (t) => (typeof t === 'string' ? t : (t?.['sv-SE'] || Object.values(t || {}).find((v) => typeof v === 'string') || ''));

/**
 * The saved menu and the sources of the target dropdowns.
 * → { menu, categories, tags, collections: [{ handle, title }], pages: [{ slug, title }] }
 */
export async function loadMenuBuilder(shopId) {
  const [cfg, prodSnap, collSnap, pageSnap] = await Promise.all([
    loadShopConfig(shopId),
    getDocs(query(collection(db, 'products'), where('shopId', '==', shopId))),
    getDocs(query(collection(db, 'collections'), where('shopId', '==', shopId))),
    getDocs(query(collection(db, 'pages'), where('shopId', '==', shopId))),
  ]);

  const cats = new Set();
  const tagSet = new Set();
  prodSnap.forEach((d) => {
    const p = d.data();
    const cat = (p.category || p.group || '').trim();
    if (cat) cats.add(cat);
    if (Array.isArray(p.tags)) p.tags.forEach((t) => t && t.trim() && tagSet.add(t.trim()));
  });

  return {
    menu: Array.isArray(cfg?.menu) ? cfg.menu : [],
    categories: Array.from(cats).sort((a, b) => a.localeCompare(b, 'sv')),
    tags: Array.from(tagSet).sort((a, b) => a.localeCompare(b, 'sv')),
    collections: collSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => c.published === true)
      .map((c) => ({ handle: c.handle, title: c.title }))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'sv')),
    pages: pageSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.status === 'published' && p.slug)
      .map((p) => ({ slug: p.slug, title: pageTitle(p.title) }))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'sv')),
  };
}

/** Saves the COMPLETE array — saveShopConfig merges storeIdentity, so it replaces the whole menu key. */
export async function saveMenu(menu, shopId) {
  await saveShopConfig({ menu }, shopId);
}
