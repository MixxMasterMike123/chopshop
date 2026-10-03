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
