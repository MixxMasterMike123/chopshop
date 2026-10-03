// src/utils/podArtwork.js for the ADMIN build (CP5 unit FM): the artwork
// library on the API (src/api/admin/pod.js). Same names as the original.
//
// What differs on the Worker, and why:
//   - an artwork is CREATED by the server's pipeline (POST …/artwork → 202,
//     then a verdict), not written by the browser: createArtwork is not
//     available here (the upload modal's data module sends the upload);
//   - a file is never replaced in place (no route): delete and upload again;
//   - a delete is refused (409) while ANY mapping names the artwork — also a
//     removed one: the mapping row stays, and with it the print file orders
//     may still need. The refusal says so; nothing is asked before it.

import { notAvailable } from '../../api/admin/client.js';
import { deleteArtwork as deleteArtworkRoute, getArtwork as getArtworkRoute, listArtwork as listArtworkRoute } from '../../api/admin/pod.js';
import { artworkRefusalMessage, artworkRow } from '../adapters/pod.js';
import { forgetRender } from './podLibraryLoad.js';

function pageError(message, cause) {
  const error = new Error(message);
  error.userMessage = message;
  if (cause) error.cause = cause;
  return error;
}

export const createArtwork = async () => {
  throw notAvailable('Att skapa ett original utan uppladdning');
};

/** A shop's artwork (summaries), newest first. */
export const listArtwork = async (shopId) => (await listArtworkRoute({ shopId })).map((s) => artworkRow(s));

/** One artwork (with its verdict and preview), or null. */
export const getArtwork = async (id, shopId) => {
  const answer = await getArtworkRoute(id, { shopId });
  if (!answer) return null;
  return answer.artwork.status === 'failed'
    ? null
    : artworkRow(answer.artwork, { detail: answer.artwork, previewUrl: answer.previewUrl });
};

export const mappingsReferencing = async () => {
  throw notAvailable('Kopplingar per original');
};

export const replaceArtworkFile = async () => {
  throw notAvailable('Att ersätta filen (ta bort originalet och ladda upp det igen)');
};

/**
 * Delete an artwork. A render that failed (shown from what the tab
 * remembers; the server has no row for it any more) is only dismissed.
 * Rejects with an Error whose message is the seller's sentence.
 */
export const deleteArtwork = async (artwork, shopId) => {
  if (!artwork?.id) throw pageError('Artwork-id saknas.');
  if (artwork.status === 'failed') {
    forgetRender(shopId, artwork.id);
    return;
  }
  try {
    await deleteArtworkRoute(artwork.id, { shopId });
  } catch (error) {
    throw pageError(artworkRefusalMessage(error, { step: 'delete' }) ?? 'Kunde inte ta bort originalet.', error);
  }
  forgetRender(shopId, artwork.id);
};
