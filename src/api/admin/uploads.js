// Uploads to the object store (CP4 unit P; cloudflare/src/storage/object-routes.ts).
//
//   1. sha256 of the file, in the browser (Web Crypto)
//   2. POST /v1/admin/objects { contentType, kind, sha256, sizeBytes, fileName? }
//        → 201 { object: { objectId, objectKey } }               (the reservation)
//   3. PUT  /v1/admin/objects/:id/content   the bytes (Content-Length = the size)
//        → 200 { object: { objectId, kind, contentType, sha256, sizeBytes, status,
//                          immutable, url?, width?, height? } }  (url etc.: a public kind)
//   4. the caller names the object where it belongs (a product's images, the
//      store identity's logoObjectId, an artwork …): not this module's work.
//
// When the upload fails after the reservation, the pending row is removed
// (DELETE /v1/admin/objects/:id tombstones a pending row without touching the
// bucket), so a failed upload leaves nothing behind. Caps (the server decides,
// this only saves a pointless request): a public image (product_media,
// shop_branding) 15 MiB, an SVG 512 KiB, a private object 100 MB.

import { AdminApiError, adminRequest, segment } from './client.js';

export const PUBLIC_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const SVG_MAX_BYTES = 512 * 1024;
export const PRIVATE_OBJECT_MAX_BYTES = 100_000_000;
const PUBLIC_KINDS = new Set(['product_media', 'shop_branding']);
const FILE_NAME_MAX = 200;

/** The hex sha256 of a Blob, File, ArrayBuffer or typed array. */
export async function sha256Hex(data) {
  const bytes = typeof data?.arrayBuffer === 'function' ? await data.arrayBuffer() : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The cap this client knows for a kind and type (the server re-checks). */
export function sizeCap(kind, contentType) {
  if (!PUBLIC_KINDS.has(kind)) return PRIVATE_OBJECT_MAX_BYTES;
  return /^image\/svg\+xml$/i.test(contentType ?? '') ? SVG_MAX_BYTES : PUBLIC_IMAGE_MAX_BYTES;
}

/**
 * Uploads one file. Resolves `{ objectId, url, object }` (`url`: the public
 * address of a public kind, else null). Rejects with an AdminApiError
 * (`payload_too_large` before sending when over the cap; the API's code
 * otherwise, e.g. `invalid_request` with `reason` `type_not_as_stated`).
 *
 * options: { kind (required), contentType (default file.type), fileName
 * (default file.name), shopId, signal }
 */
export async function uploadObject(file, { kind, contentType, fileName, shopId, signal } = {}) {
  if (!file || typeof file.size !== 'number' || typeof file.arrayBuffer !== 'function') {
    throw new AdminApiError({ status: 0, code: 'bad_request', message: 'Not a file' });
  }
  const type = contentType || file.type || 'application/octet-stream';
  if (file.size < 1 || file.size > sizeCap(kind, type)) {
    throw new AdminApiError({ status: 413, code: 'payload_too_large', message: 'Filen är för stor' });
  }

  const sha256 = await sha256Hex(file);
  const name = typeof (fileName ?? file.name) === 'string' ? (fileName ?? file.name).slice(0, FILE_NAME_MAX) : undefined;
  const reserve = { contentType: type, kind, sha256, sizeBytes: file.size };
  if (name) reserve.fileName = name;

  const { data: reserved } = await adminRequest('POST', '/v1/admin/objects', { json: reserve, shopId, signal });
  const objectId = reserved?.object?.objectId;
  if (typeof objectId !== 'string' || objectId === '') {
    throw new AdminApiError({ status: 0, code: 'bad_response', message: 'The reservation named no object' });
  }

  try {
    const { data } = await adminRequest('PUT', `/v1/admin/objects/${segment(objectId)}/content`, {
      body: file,
      contentType: type,
      shopId,
      signal,
    });
    const object = data?.object ?? null;
    return { objectId, url: typeof object?.url === 'string' ? object.url : null, object };
  } catch (error) {
    await adminRequest('DELETE', `/v1/admin/objects/${segment(objectId)}`, { shopId }).catch(() => {});
    throw error;
  }
}

/** Removes an object (204). A frozen object answers 409. */
export async function deleteObject(objectId, { shopId, signal } = {}) {
  await adminRequest('DELETE', `/v1/admin/objects/${segment(objectId)}`, { shopId, signal });
}

/** An active object's metadata (`{ object }`), or null when the API says 404. */
export async function getObject(objectId, { shopId, signal } = {}) {
  try {
    const { data } = await adminRequest('GET', `/v1/admin/objects/${segment(objectId)}`, { shopId, signal });
    return data?.object ?? null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
}
