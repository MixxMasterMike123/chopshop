// ArtworkLibrary's data layer for the ADMIN build (CP5 unit FM): the alias
// list of vite.admin.config.js puts this module in place of
// src/wagons/pod-wagon/components/artworkLibraryData.js (the older build's,
// Firebase). Same names.
//
//   "Validera om"   leaves: every artwork on the Worker went through the
//                   server's pipeline (there are no unvalidated legacy rows),
//                   and the same bytes get the same verdict;
//   "Ladda upp igen"  on a render that FAILED (the server could not process
//                   the file): the upload is made again, the file chosen anew
//                   and the rights confirmed anew;
//   "Byt namn"      PATCH …/artwork/:id { label } (nothing is written when
//                   the name is unchanged; the library is read again after);
//   "Ersätt fil" and the link to the print file / original leave: no route
//                   replaces a file, the print file is the print shop's, and
//                   the original is private.
//   "Används av"    one pill per PRODUCT (unit CP5-FP): a studio product maps
//                   every variant, and a pill per variant made one row of 65
//                   pills; the pill counts the variants instead

import { notAvailable } from '../../api/admin/client.js';
import { renameArtwork as renameArtworkRoute } from '../../api/admin/pod.js';
import { LABEL_MAX, artworkRefusalMessage, renameValue, usagePillsByArtwork } from '../adapters/pod.js';

export const revalidateArtwork = async () => {
  throw notAvailable('Validera om');
};

/** What a row offers beside "Ta bort": a failed render is uploaded again. */
export const rowAction = (art) => (art.status === 'failed' ? 'reupload' : null);

export const CAN_REPLACE = false;

/** Every artwork the server holds may be renamed (a failed render is not held). */
export const canRename = (art) => art.status === 'ready' || art.status === 'rejected' || art.status === 'processing';

/**
 * The seller typed `typed` as the new name of `art` → the stored summary, or
 * null when nothing was written (cancelled, or the name unchanged). Rejects
 * with an Error whose message is the seller's sentence.
 */
export async function renameArtwork(shopId, art, typed) {
  const label = renameValue(typed, art.label);
  if (label === undefined) return null;
  if (label !== null && label.length > LABEL_MAX) {
    const e = new Error(`Namnet kan vara högst ${LABEL_MAX} tecken.`);
    e.userMessage = e.message;
    throw e;
  }
  try {
    return await renameArtworkRoute(art.id, label, { shopId });
  } catch (error) {
    const message = artworkRefusalMessage(error, { step: 'rename' }) ?? 'Kunde inte byta namn.';
    const e = new Error(message);
    e.userMessage = message;
    e.cause = error;
    throw e;
  }
}

/** The "Används av" pills: artworkId → [{ key, text, mono, variants, slots }], one per product. */
export const usagePills = (mappings, slotLabel) => usagePillsByArtwork(mappings, slotLabel);
