// printRouting.js — cached loader for the PLATFORM print-routing decision:
// which printer makes which garment, plus every printer's price tier.
//
// Two Firestore reads, one cache (same contract as pod3dModels.js /
// podMockupTemplates.js — degrade to empty, never throw, so the studio still
// opens when the platform has configured nothing yet):
//
//   settings/printRouting  →  { byGarment: { [garmentId]: printerUid },
//                              defaultPrinterUid: string|null,
//                              updatedAt, updatedBy }
//   printers (collection)  →  printers/{uid} = { name, garments[],
//                              pricing: { blankCostSek: {garment: n},
//                                         printCostSek: {slot: n} } }   (EX moms)
//
// Both are PLATFORM-written / active-user-read (firestore.rules). The routing
// RULES themselves live in src/wagons/pod-wagon/printRouting.js — this file
// only fetches; it holds no decision logic.
//
// ⚠️ POD-ONLY. Call this from pod-gated code paths only (the Design Studio,
// which the pod add-on gates). A non-POD shop must never read these documents:
// nothing there concerns it, and the whole slice is supposed to be invisible to
// it.
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { db } from '../firebase/config';

const ROUTING_REF = () => doc(db, 'settings', 'printRouting');
const PRINTERS_REF = () => collection(db, 'printers');

// Module-level cache. `null` = not loaded yet; an object = loaded (possibly empty).
let _cache = null;

const EMPTY = () => ({ routing: { byGarment: {}, defaultPrinterUid: null }, printersById: {} });

/**
 * loadPrintRouting() → Promise<{ routing, printersById }>
 * Reads settings/printRouting + the printers collection once and caches the
 * pair. A missing routing doc (never configured) yields an empty routing, which
 * resolves to no printer — the cost calculation then falls back to the mockup
 * template's legacy prices, exactly as before this slice.
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
    console.warn('printRouting: could not load routing/printers, falling back to template prices :', err?.message);
    _cache = EMPTY();
  }
  return _cache;
};

/** Drop the cache (e.g. after a platform edit) so the next load re-reads Firestore. */
export const clearPrintRoutingCache = () => {
  _cache = null;
};
