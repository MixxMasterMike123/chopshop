// AdminCollections' data layer — the ADMIN build's implementation (the API).
// The alias list of vite.admin.config.js puts this file where the page imports
// src/pages/admin/adminCollectionsData.js (the older build's, Firebase). Same
// names, same meaning; the shapes are bridged by adapters/content.js.
//
//   the list    GET /v1/admin/collections, every page
//   delete      DELETE /v1/admin/collections/:id
//   the star    PATCH { featured }
//   the order   PATCH { sortOrder } per collection whose place changed (the
//               API has no bulk route), four at a time

import { deleteCollection, listAllCollections, updateCollection } from '../../api/admin/content.js';
import { collectionRowFromApi } from '../adapters/content.js';
import { inPool } from './contentSources.js';

export async function loadShopCollections(shopId) {
  const rows = await listAllCollections({ shopId });
  return rows.map(collectionRowFromApi).filter(Boolean);
}

export async function deleteShopCollection(id) {
  await deleteCollection(id);
}

export async function setCollectionFeatured(id, featured) {
  await updateCollection(id, { featured });
}

export async function saveCollectionOrder(orderDraft) {
  const moved = orderDraft.map((c, place) => ({ id: c.id, place, was: c.sortOrder })).filter((c) => c.was !== c.place);
  await inPool(moved, 4, (c) => updateCollection(c.id, { sortOrder: c.place }));
}
