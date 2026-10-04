// src/config/podMockupTemplates.js for the ADMIN build (CP5 unit FN1): the
// design studio's mockup templates from GET /v1/admin/pod/mockup-templates
// (the platform's templates, read by a shop admin; images in the public
// bucket), in the older settings/podMockupTemplates document shape
// (adapters/studio.js templateFromApi). Same exports as the original.
//
// What differs from the original, on purpose:
//   - BOUND TO THE SHOP: the route is a shop's (X-Shop-Id), so the cache is
//     keyed by the shop, and an answer that arrives after the tab moved to
//     another shop is dropped (readForShop), never shown.
//   - A FAILED READ IS NOT "NO TEMPLATES": the load REJECTS (and is not
//     cached), so the studio says "Plaggmallarna kunde inte laddas" with its
//     retry, instead of "Inga plaggmallar" as if the platform had none.
//   - Only active templates arrive (the server filters); `garment` is always
//     present, so garmentOfTemplate's id-prefix fallback is a no-op here.

import { getRequestShopId } from '../../api/admin/client.js';
import { isUnresolvedShopId } from '../../config/tenancy.js';
import { listMockupTemplates } from '../../api/admin/podStudio.js';
import { readForShop } from '../providers/ordersForShop.js';
import { templatesFromApi } from '../adapters/studio.js';

export { applyPrinterAreas } from '../../config/printerAreas.js';
export { getTemplateById, templateSlots, garmentOfTemplate } from '../../config/podMockupTemplateHelpers.js';

const loads = new Map(); // shopId → Promise<{ templates, meta }>
let lastMeta = { version: 0, provisional: true };

/**
 * loadPodMockupTemplates() → Promise<Array<template>> for the tab's shop.
 * Rejects when the templates cannot be read.
 */
export const loadPodMockupTemplates = async () => {
  const shopId = getRequestShopId();
  // The cache holds the shop's own request; only THIS caller is dropped when
  // the tab moves shop (a dropped promise never settles, so it must never be
  // what the cache holds).
  if (!loads.has(shopId) && !isUnresolvedShopId(shopId)) {
    const load = listMockupTemplates({ shopId }).then(templatesFromApi);
    loads.set(shopId, load);
    load.catch(() => {
      if (loads.get(shopId) === load) loads.delete(shopId); // a failure is asked again next time
    });
  }
  const { templates, meta } = await readForShop(shopId, () => loads.get(shopId));
  lastMeta = meta;
  return templates;
};

/** The provisional flag of the last load (the studio's "preliminära" note). */
export const getPodMockupTemplatesMeta = () => lastMeta;

/** Drop the cache (the studio's "Försök igen") so the next load reads the API again. */
export const clearPodMockupTemplatesCache = () => {
  loads.clear();
  lastMeta = { version: 0, provisional: true };
};

/** The older build's studio harness seeds its cache; nothing to seed here. */
export const seedPodMockupTemplatesCacheForDev = () => {};
