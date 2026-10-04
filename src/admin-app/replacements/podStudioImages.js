// The design studio's mockups → the product's images, on the API (CP5 unit
// FN2). No React: podStudioPublish.js calls these at its image step, and they
// are tested under Node against the dev API (podStudioPublish.test.mjs).
//
//   1. each mockup's bytes are hashed (sha256, uploads.js);
//   2. an object the product already holds for the same colour and side (its
//      alt text, adapters/studioMedia.js) whose sha256 is the same is KEPT;
//      so is an object this tab uploaded before with the same sha256 that is
//      still active (a re-run after a failure uploads only what is missing);
//      everything else is uploaded (POST /v1/admin/objects → PUT content,
//      kind product_media; the type is decided by the bytes);
//   3. the whole list is PUT, only when it differs from the server's;
//   4. a lost answer to the PUT (no answer, a 5xx) is READ BACK before
//      anything is said: the list as planned = saved; another list = not
//      saved; an unreadable product = unknown;
//   5. after a confirmed write, the objects of the studio's earlier rows the
//      list no longer names are removed (D93), as the product form removes its
//      own dropped images. A failure there is not the seller's problem.
//
// The mockup's Blob is kept from the render (DesignStudio entry.blob): the
// admin CSP's connect-src has no `blob:`, so the older build's fetch of the
// blob: address would be refused here.

import { AdminApiError } from '../../api/admin/client.js';
import { getProduct, replaceProductImages } from '../../api/admin/products.js';
import { deleteObject, getObject, sha256Hex, uploadObject } from '../../api/admin/uploads.js';
import { refusalMessage } from '../adapters/product.js';
import { droppedStudioObjects, sameStudioList, studioObjectsBySide } from '../adapters/studioMedia.js';

const isNetwork = (error) => !(error instanceof AdminApiError) || error.status === 0 || error.status >= 500;

// The objects this tab uploaded, per shop, product and sha256 (for the life of
// the tab). Keyed by the product too: an object is never shared between two
// products, so removing a product's dropped object can never take another's.
const uploadedBySha = new Map(); // `${shopId}\n${productId}\n${sha256}` → objectId

/** Forget the tab's uploads (tests). The objects themselves stay on the server. */
export function forgetStudioUploads() {
  uploadedBySha.clear();
}

/** The cause the seller reads when an upload or the list write is refused or lost. */
export function imageStepCause(error) {
  if (error?.code === 'unauthenticated') return 'Sessionen har gått ut. Logga in igen.';
  const said = refusalMessage(error, { step: 'images' });
  if (said) return said;
  return isNetwork(error) ? 'Anslutningen bröts.' : 'En bild kunde inte sparas.';
}

/**
 * The object of each mockup: kept, reused or uploaded. Calls `progress(done,
 * total)` after each. → { objectIdByKey } or throws the API's error with
 * `done`/`total` on it.
 *
 * mockups: [{ key, colorwayId, slot, blob, type }]; productId: the product
 * the objects are for; rows: its rows now; colours: [{ id, label }].
 */
export async function resolveMockupObjects(mockups, { shopId, productId, rows, colours }) {
  const bySide = studioObjectsBySide(rows, mockups, colours);
  const onProduct = new Set(rows.map((r) => r.objectId));
  const shaOf = new Map(); // objectId → sha256 | null (unknown)
  const readSha = async (objectId) => {
    if (!shaOf.has(objectId)) {
      // A failed read is "unknown", never "gone": the object is uploaded again,
      // and the product's earlier row is replaced, not dropped without a successor.
      const object = await getObject(objectId, { shopId }).catch(() => null);
      shaOf.set(objectId, object && object.status === 'active' ? object.sha256 ?? null : null);
    }
    return shaOf.get(objectId);
  };

  const objectIdByKey = {};
  let done = 0;
  for (const m of mockups) {
    try {
      const sha = await sha256Hex(m.blob);
      let objectId = null;
      const same = bySide[m.key];
      if (same && (await readSha(same)) === sha) objectId = same;
      if (!objectId) {
        const earlier = uploadedBySha.get(`${shopId}\n${productId}\n${sha}`);
        if (earlier && (onProduct.has(earlier) || (await readSha(earlier)) === sha)) objectId = earlier;
      }
      if (!objectId) {
        ({ objectId } = await uploadObject(m.blob, { kind: 'product_media', contentType: m.type || m.blob.type, shopId }));
        uploadedBySha.set(`${shopId}\n${productId}\n${sha}`, objectId);
      }
      objectIdByKey[m.key] = objectId;
      done += 1;
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { done, total: mockups.length });
    }
  }
  return { objectIdByKey };
}

/**
 * The list PUT, only when it differs from `before`. → { ok: true, written }
 * | { ok: false, cause, unknown?: true } (unknown: the answer was lost and the
 * product could not be read back).
 */
export async function writeStudioImages(productId, list, { shopId, before, colours }) {
  if (sameStudioList(list, before)) return { ok: true, written: false };
  try {
    await replaceProductImages(productId, list, { shopId });
  } catch (error) {
    if (!isNetwork(error) || error?.code === 'unauthenticated') return { ok: false, cause: imageStepCause(error) };
    // The answer was lost: read back what the server holds before saying anything.
    const detail = await getProduct(productId, { shopId }).catch(() => undefined);
    if (!detail) return { ok: false, unknown: true, cause: 'Anslutningen bröts.' };
    const now = (detail.images ?? []).map((r) => ({ objectId: r.objectId, variantId: r.variantId ?? null, alt: r.alt ?? null }));
    if (!sameStudioList(list, now)) return { ok: false, cause: 'Anslutningen bröts innan bilderna sparades.' };
  }
  for (const objectId of droppedStudioObjects(before, list, colours)) {
    await deleteObject(objectId, { shopId }).catch(() => {});
  }
  return { ok: true, written: true };
}

/** The server's rows of a product detail, in the shape the planner reads. */
export const rowsOf = (detail) =>
  (detail?.images ?? []).map((r) => ({ objectId: r.objectId, variantId: r.variantId ?? null, alt: r.alt ?? null }));
