// src/config/printRouting.js for the ADMIN build (CP5 unit FN1): what can be
// produced for this shop, from GET /v1/admin/pod/printers (capabilities only:
// models, their garment and print frames, and the printer's articles; no
// price exists on that answer).
//
// The older loader read the PLATFORM's routing (garment → printer) and each
// printer's frames per garment. On the Worker the platform's default printer
// is not the seller's to read (D52), and a mapping names its printer AND the
// printer's article. So each (printer, model) that offers articles becomes one
// entry of `printersById`, shaped as the older studio reads a printer
// (garments, printAreasMm[garment]), and `routing.byGarment` names the first
// such entry per garment: the studio's template filter and frame reshaping
// (templateOffered, resolvePrinterUid, applyPrinterAreas) run unchanged on it.
// `production.options` lists every entry per garment, so the seller can pick
// another printer or model when there are several (DesignStudio step 1), and
// each entry carries the articles the publish step maps variants to.
//
// BOUND TO THE SHOP and A FAILED READ REJECTS (the studio says the templates
// could not be loaded, and retries): no printers known is not "no printers".

import { getRequestShopId } from '../../api/admin/client.js';
import { isUnresolvedShopId } from '../../config/tenancy.js';
import { listPrinters } from '../../api/admin/pod.js';
import { readForShop } from '../providers/ordersForShop.js';
import { productionFromPrinters } from '../adapters/studio.js';

const loads = new Map(); // shopId → Promise<{ routing, printersById, production }>

/** loadPrintRouting() → Promise<{ routing, printersById, production: { options } }> for the tab's shop. */
export const loadPrintRouting = async () => {
  const shopId = getRequestShopId();
  // The cache holds the shop's own request; only THIS caller is dropped when
  // the tab moves shop (a dropped promise never settles: never cached).
  if (!loads.has(shopId) && !isUnresolvedShopId(shopId)) {
    const load = listPrinters({ shopId }).then((printers) => {
      const { routing, printersById, options } = productionFromPrinters(printers);
      return { routing, printersById, production: { options } };
    });
    loads.set(shopId, load);
    load.catch(() => {
      if (loads.get(shopId) === load) loads.delete(shopId);
    });
  }
  return readForShop(shopId, () => loads.get(shopId));
};

/** Drop the cache so the next load reads the API again. */
export const clearPrintRoutingCache = () => {
  loads.clear();
};

/** The older build's studio harness seeds its cache; nothing to seed here. */
export const seedPrintRoutingCacheForDev = () => {};
