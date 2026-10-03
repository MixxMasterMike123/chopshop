// ArtworkUploadModal's data layer for the ADMIN build (CP5 unit FM): the alias
// list of vite.admin.config.js puts this module in place of
// src/wagons/pod-wagon/components/artworkUploadData.js (the older build's,
// Firebase). Same names.
//
// THE SERVER DECIDES (docs/POD_PRINT_SPEC.md gates: 300 DPI contain-fit, the
// real print areas, always-PNG). The browser does not judge the file: the
// pre-check never blocks and says "Kontrolleras vid uppladdning"; the
// verdict, its notices and its reasons are the server's, shown as given.
//
// The upload:
//   1. the original as a private `artwork_original` object (uploads.js);
//   2. POST /v1/admin/pod/artwork { objectId, profileId, rightsConfirmed: true,
//      label } → 202, the artwork `processing` (the rights box is the
//      uploader's own confirmation: nothing is sent without it);
//   3. its detail is asked (2 s, doubling, at most 10 s apart) until the
//      verdict: ready → saved, with the server's notices; rejected → the
//      server's reasons (the rejected artwork stays in the library, where it
//      can be removed); failed → said as failed ("ladda upp igen");
//   4. still processing after WAIT_MS → said as PENDING, never as done: the
//      library shows it "Bearbetas…" and its verdict when it lands.
// When step 2 is refused, the original uploaded in step 1 is removed again.

import { getRequestShopId } from '../../api/admin/client.js';
import { createArtwork, getArtwork } from '../../api/admin/pod.js';
import { deleteObject } from '../../api/admin/uploads.js';
import { readForShop } from '../providers/ordersForShop.js';
import { artworkRefusalMessage, pollDelay, renderState, uploadLabel } from '../adapters/pod.js';
import { uploadPodOriginal } from './podUpload.js';
import { forgetRender, trackRender } from './podLibraryLoad.js';

/** How long the modal waits for a verdict before it hands the render to the library. */
export const WAIT_MS = 120_000;

/** The pre-check of this build: nothing is judged in the browser. */
export const precheckArtwork = () => ({
  ok: true,
  deferred: true,
  effectiveDpi: null,
  maxPrintMm: null,
  requiredPx: null,
  reasons: [],
});

export const CREATED_NEXT_STEP =
  'Originalet finns nu i biblioteket. Koppla det till en produkt under Avancerat: där väljer du tryckeri, artikel och placering.';

export const PENDING_NOTE =
  'Originalet bearbetas fortfarande. Det står som ”Bearbetas…” i biblioteket och får sin status när servern är klar.';

function pageError(message, cause) {
  const error = new Error(message);
  error.userMessage = message;
  if (cause) error.cause = cause;
  return error;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks the artwork's detail until it has a verdict, or until `waitMs`.
 * → { state: 'ready' | 'rejected' | 'failed' | 'gone' | 'processing', notices, reasons }
 * A failed read is not a verdict: it is asked again. Bound to the shop.
 */
export async function waitForVerdict(shopId, artworkId, { waitMs = WAIT_MS, now = Date.now, wait = sleep } = {}) {
  const deadline = now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    await wait(pollDelay(attempt));
    let verdict = null;
    try {
      verdict = renderState(await readForShop(shopId, (id) => getArtwork(artworkId, { shopId: id })));
    } catch (error) {
      if (error?.code === 'unauthenticated') throw error;
    }
    if (verdict && verdict.state !== 'processing') return verdict;
    if (now() >= deadline) return { state: 'processing', notices: [], reasons: [] };
  }
}

/**
 * The modal's save. → { artworkId, notices } | { rejected: true, stored: true, artworkId, reasons }
 *                     | { pending: true, artworkId }
 * Rejects with an Error whose message is the seller's sentence.
 */
export async function saveArtworkUpload({ file, shopId, profile, label, rightsConfirmed, replaceTarget = null, onAccepted }, options = {}) {
  const shop = shopId ?? getRequestShopId();
  if (replaceTarget) throw pageError('Att ersätta filen finns inte här: ta bort originalet och ladda upp det igen.');
  if (rightsConfirmed !== true) throw pageError('Bekräfta att du har rätt att använda motivet.');

  let original;
  try {
    original = await uploadPodOriginal(file, shop, profile);
  } catch (error) {
    throw pageError(artworkRefusalMessage(error) ?? error?.message ?? 'Uppladdningen misslyckades.', error);
  }

  const name = uploadLabel(label, file.name);
  let created;
  try {
    created = await createArtwork(
      { objectId: original.objectId, profileId: profile.id, rightsConfirmed: true, label: name },
      { shopId: shop },
    );
  } catch (error) {
    await deleteObject(original.objectId, { shopId: shop }).catch(() => {});
    throw pageError(artworkRefusalMessage(error) ?? 'Uppladdningen misslyckades.', error);
  }

  const artwork = created.artwork;
  if (!artwork?.artworkId) throw pageError('Servern svarade inte som väntat. Ladda om sidan och se efter i biblioteket.');
  const artworkId = artwork.artworkId;
  trackRender(shop, { artworkId, label: name, profileId: profile.id, originalObjectId: original.objectId, createdAt: artwork.createdAt });
  try {
    onAccepted?.(artworkId);
  } catch {
    // the caller's refresh is not this save's concern
  }

  // A synchronous verdict (the Worker's fallback path) needs no wait.
  const first = renderState({ artwork });
  const verdict = first.state === 'processing' ? await waitForVerdict(shop, artworkId, options) : first;

  switch (verdict.state) {
    case 'ready':
      forgetRender(shop, artworkId);
      return { artworkId, notices: verdict.notices };
    case 'rejected':
      forgetRender(shop, artworkId);
      return {
        rejected: true,
        stored: true,
        artworkId,
        reasons: verdict.reasons.length ? verdict.reasons : [{ code: 'rejected', message: 'Filen godkändes inte.' }],
      };
    case 'failed':
      forgetRender(shop, artworkId); // said here, in the modal
      throw pageError('Filen kunde inte bearbetas på servern — ladda upp den igen.');
    case 'gone':
      forgetRender(shop, artworkId);
      throw pageError('Originalet togs bort medan det bearbetades.');
    default:
      return { pending: true, artworkId };
  }
}
