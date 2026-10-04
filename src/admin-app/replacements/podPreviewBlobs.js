// An artwork's preview, HELD for the life of the tab (CP6 studio follow-up).
//
// The API hands each preview out as a signed address of the private bucket
// that stops working after five minutes (the Worker's PREVIEW_URL_TTL_SECONDS).
// The studio reads the library once and then draws the motif for as long as
// the seller works: on the canvas, on every colour, in every mockup and in the
// 3D view. A seller who took more than five minutes over the steps got
// "Bilderna kunde inte läsas för export" and could only reload the page,
// losing the design.
//
// So the library fetches each preview once, while its address is fresh, and
// gives the rows a blob: address instead. A blob: address does not expire, is
// same-origin (no CORS, no cache to disagree with) and is downloaded once
// however many times it is drawn. The preview of an artwork never changes
// (another file is another artwork), so it is kept per shop and artwork and a
// later library read does not fetch it again.
//
// A preview that cannot be fetched keeps its signed address: it is shown as
// before, and drawn while the address lasts (corsImage.js).
//
// WHAT IS HELD IS BOUNDED. Each library read ends by letting go of every
// preview that its list no longer holds among its newest HELD_PREVIEW_LIMIT
// (a deleted artwork, one pushed out by newer uploads) and of every other
// shop's previews (the tab works in one shop at a time): at most
// HELD_PREVIEW_LIMIT previews are held, of one shop. Only the LATEST read may
// let go: an older read that answers late knows nothing of an artwork
// uploaded since, and must not free the preview the newer rows show.

import { isSignedUrl } from '../../wagons/pod-wagon/studio/corsImage.js';

/** Only this many previews (the newest of the list) are held; a larger library keeps signed addresses for the rest. */
export const HELD_PREVIEW_LIMIT = 100;

const held = new Map(); // `${shopId}\n${artworkId}` → blob: address
let latestRead = 0;

/** A library read starts: its token says whether it is still the latest when it ends. */
export function beginPreviewRead() {
  latestRead += 1;
  return latestRead;
}

/**
 * A library read ends: every held preview that is not one of `keepArtworkIds`
 * of `shopId` is freed. Nothing happens when a newer read has started since.
 * Answers how many were freed.
 */
export function releaseHeldPreviews(shopId, keepArtworkIds, token) {
  if (token !== latestRead) return 0;
  const keep = new Set([...keepArtworkIds].map((artworkId) => `${shopId}\n${artworkId}`));
  let freed = 0;
  for (const [key, address] of held) {
    if (keep.has(key)) continue;
    held.delete(key);
    URL.revokeObjectURL(address);
    freed += 1;
  }
  return freed;
}

/** The address to show and draw an artwork's preview from. */
export async function heldPreviewUrl(shopId, artworkId, previewUrl, { fetchImpl = globalThis.fetch } = {}) {
  if (!isSignedUrl(previewUrl)) return previewUrl ?? null;
  const key = `${shopId}\n${artworkId}`;
  if (held.has(key)) return held.get(key);
  try {
    const response = await fetchImpl(previewUrl, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return previewUrl;
    const address = URL.createObjectURL(await response.blob());
    // Two reads of the same artwork at once: the first one's address is the
    // one every row carries, the other is freed.
    if (held.has(key)) {
      URL.revokeObjectURL(address);
      return held.get(key);
    }
    held.set(key, address);
    return address;
  } catch {
    return previewUrl;
  }
}

/** How many previews are held (tests, and a look from the console). */
export const heldPreviewCount = () => held.size;

/** Tests only: forget every held preview. */
export function resetHeldPreviews() {
  held.clear();
  latestRead = 0;
}
