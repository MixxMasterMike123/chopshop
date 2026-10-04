// ArtworkLibrary's data layer: the OLDER build's implementation (Firebase).
// The code below moved here unchanged from ArtworkLibrary.jsx (CP5 unit FM),
// so the component is the same file in both builds; the Cloudflare admin's
// build aliases this module to src/admin-app/replacements/podArtworkLibraryData.js
// (vite.admin.config.js), which exports the same names.
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../../firebase/config';

// LEGACY docs (no status field) predate the 2026-07-27 gate pipeline: they were
// validated against the old advisory thresholds and have no print PNG — the
// printer would get the raw original. "Validera om" runs them through the
// server pipeline (trim + PNG + authoritative gate) and stamps ready/rejected.
export const revalidateArtwork = async (shopId, art) => {
  const call = httpsCallable(functions, 'processPodArtwork');
  const { data: result } = await call({ shopId, artworkId: art.id });
  return result;
};

/** What a row offers beside "Ta bort": 'revalidate' ("Validera om") for anything not ready. */
export const rowAction = (art) => (art.status !== 'ready' ? 'revalidate' : null);

/** "Ersätt fil": the file is replaced in place (same id, every mapping keeps it). */
export const CAN_REPLACE = true;

/** No rename in this build: the name is set at upload. */
export const canRename = () => false;
export const renameArtwork = async () => null;

// Map artworkId → the SKU+slot pills that reference it (built once from the shared
// mappings). MULTI-PLACEMENT: a SKU may appear per slot, so the pill carries the
// slot too ("north-01 · Rygg"). Missing placementSlot → 'front' (Bröst).
// (Moved here from ArtworkLibrary.jsx, CP5-FP: the admin build counts per product.)
export const usagePills = (mappings, slotLabel, slotOf) => {
  const m = new Map();
  mappings.forEach((mp) => {
    if (!mp.artworkId || !mp.sku) return;
    const arr = m.get(mp.artworkId) || [];
    arr.push({ key: mp.id || `${mp.sku}-${slotOf(mp)}`, text: mp.sku, mono: true, variants: 0, slots: mp.slotsLabel || slotLabel(slotOf(mp)) });
    m.set(mp.artworkId, arr);
  });
  return m;
};
