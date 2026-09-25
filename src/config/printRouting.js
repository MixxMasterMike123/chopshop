// printRouting.js — cached loader for the PLATFORM print-routing decision:
// which printer makes which garment, and what each printer can PRINT (garments,
// frames). It carries NO prices.
//
// Two Firestore reads, one cache (same contract as pod3dModels.js /
// podMockupTemplates.js — degrade to empty, never throw, so the studio still
// opens when the platform has configured nothing yet):
//
//   settings/printRouting      →  { byGarment: { [garmentId]: printerUid },
//                                  defaultPrinterUid: string|null,
//                                  updatedAt, updatedBy }
//   printersPublic (collection) →  printersPublic/{uid} = { name, type, active,
//                                  garments[], printAreasMm, provisionalAreas }
//
// A13 ("seller sees ONE number", 2026-09-25): this used to read printers/{uid}
// — the platform's price tiers — so the studio could compute the production
// cost itself. Those docs are platform-only now; this reads the price-free
// printersPublic mirror (server-maintained by syncPrintersPublicOnWrite) and
// the cost arrives as ONE number from the quotePodCost callable
// (src/config/podCostQuote.js). The cache shape { routing, printersById } is
// unchanged on purpose — the routing/capability rules
// (src/wagons/pod-wagon/printRouting.js) read exactly the fields the mirror
// keeps — but `printersById` now holds capability docs, never tiers.
//
// ⚠️ POD-ONLY. Call this from pod-gated code paths only (the Design Studio,
// which the pod add-on gates). A non-POD shop must never read these documents:
// nothing there concerns it, and the whole slice is supposed to be invisible to
// it.
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { db } from '../firebase/config';

const ROUTING_REF = () => doc(db, 'settings', 'printRouting');
const PRINTERS_REF = () => collection(db, 'printersPublic');

// Module-level cache. `null` = not loaded yet; an object = loaded (possibly empty).
let _cache = null;

const EMPTY = () => ({ routing: { byGarment: {}, defaultPrinterUid: null }, printersById: {} });

/**
 * loadPrintRouting() → Promise<{ routing, printersById }>
 * Reads settings/printRouting + the printersPublic collection once and caches
 * the pair. A missing routing doc (never configured) yields an empty routing,
 * which resolves to no printer — the studio then offers every template and the
 * cost quote comes back empty ("Produktionskostnad saknas").
 */
export const loadPrintRouting = async () => {
  if (_cache !== null) return _cache;
  try {
    const [routingSnap, printerSnap] = await Promise.all([getDoc(ROUTING_REF()), getDocs(PRINTERS_REF())]);
    const data = routingSnap.exists() ? routingSnap.data() || {} : {};
    const printersById = {};
    printerSnap.forEach((d) => { printersById[d.id] = { id: d.id, ...(d.data() || {}) }; });
    _cache = {
      routing: {
        byGarment: data.byGarment && typeof data.byGarment === 'object' ? data.byGarment : {},
        defaultPrinterUid: data.defaultPrinterUid || null,
      },
      printersById,
    };
  } catch (err) {
    console.warn('printRouting: could not load routing/printersPublic, studio runs unrouted:', err?.message);
    _cache = EMPTY();
  }
  return _cache;
};

/** Drop the cache (e.g. after a platform edit) so the next load re-reads Firestore. */
export const clearPrintRoutingCache = () => {
  _cache = null;
};

/** DEV-ONLY: pre-seed the cache so the studio harness can mount the FULL
 *  DesignStudio against a fake printer (e.g. SnapWear's frames) without
 *  Firestore. Pass printersPublic-shaped docs (no prices — the harness stubs
 *  the cost via seedPodCostQuoteForDev). Same contract as seedPodMockupTemplatesCacheForDev. No-op in
 *  production builds. */
export const seedPrintRoutingCacheForDev = (routing, printersById) => {
  if (!import.meta.env.DEV) return;
  _cache = {
    routing: { byGarment: routing?.byGarment || {}, defaultPrinterUid: routing?.defaultPrinterUid || null },
    printersById: printersById || {},
  };
};
