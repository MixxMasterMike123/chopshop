// The shop's print-on-demand library and print mappings (CP5 unit FM; the
// Worker: cloudflare/src/app.ts handleAdminPodRoute (profiles, artwork),
// src/routes/pod-artwork.ts (rename, a failed render), src/routes/pod-admin.ts
// (printers, mappings, the quotes); the shapes in docs/cf-port/CP5_WG_REPORT.md).
//
//   GET    /v1/admin/pod/profiles                  { profiles }
//   GET    /v1/admin/pod/artwork                   { artwork: ArtworkSummary[] }      (newest first, ≤ 500)
//   POST   /v1/admin/pod/artwork                   202 { artwork }  { objectId, profileId, rightsConfirmed: true, label? }
//   GET    /v1/admin/pod/artwork/:id               { artwork: ArtworkDetail | { status: 'failed', reason }, previewUrl }
//   PATCH  /v1/admin/pod/artwork/:id               { artwork: ArtworkSummary }  { label: string | null }
//   DELETE /v1/admin/pod/artwork/:id               204 · 409 conflict (a mapping has named it)
//   GET    /v1/admin/pod/printers                  { printers }   capabilities only, no price
//   GET    /v1/admin/pod/mappings[?productId=]     { mappings }
//   POST   /v1/admin/pod/mappings                  201|200 { mapping, inkopMinor, priceFloorMinor, currency }
//   DELETE /v1/admin/pod/mappings/:id              204 (the row stays, inactive)
//   GET    /v1/admin/pod/design-quote?printerId=&sku=&slots=   { inkopMinor, priceFloorMinor, currency }
//
// Every request carries X-Shop-Id (adminRequest). THE SELLER SEES ONE NUMBER:
// the only figures any of these answers carries are `inkopMinor` and
// `priceFloorMinor`; nothing here computes one.

import { AdminApiError, adminRequest, segment, withQuery } from './client.js';

export const POD_PATH = '/v1/admin/pod';
const artworkPath = (artworkId) => `${POD_PATH}/artwork/${segment(artworkId)}`;

const list = (value) => (Array.isArray(value) ? value : []);
const is404 = (error) => error instanceof AdminApiError && error.status === 404;

/** The active print profiles (the upload's "Tryckändamål"). */
export async function listProfiles({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', `${POD_PATH}/profiles`, { shopId, signal });
  return list(data?.profiles);
}

/** The shop's artwork library (summaries: no preview address, no notices). */
export async function listArtwork({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', `${POD_PATH}/artwork`, { shopId, signal });
  return list(data?.artwork);
}

/**
 * One artwork with its verdict and a short-lived preview address:
 * `{ artwork, previewUrl }`, or null on the opaque 404 (unknown, deleted, or
 * another shop's). A render that failed answers `artwork.status === 'failed'`.
 */
export async function getArtwork(artworkId, { shopId, signal } = {}) {
  try {
    const { data } = await adminRequest('GET', artworkPath(artworkId), { shopId, signal });
    if (!data || typeof data !== 'object' || !data.artwork) return null;
    return { artwork: data.artwork, previewUrl: typeof data.previewUrl === 'string' ? data.previewUrl : null };
  } catch (error) {
    if (is404(error)) return null;
    throw error;
  }
}

/**
 * Sends an uploaded original to the print pipeline. `rightsConfirmed` must be
 * the uploader's own `true` (the rights box): anything else is refused here,
 * before a request, as the server refuses it. → `{ status, artwork }`
 * (202: `artwork.status === 'processing'`; poll getArtwork).
 */
export async function createArtwork({ objectId, profileId, rightsConfirmed, label }, { shopId } = {}) {
  if (rightsConfirmed !== true) {
    throw new AdminApiError({ status: 0, code: 'rights_not_confirmed', message: 'Rättigheterna till motivet är inte bekräftade' });
  }
  const json = { objectId, profileId, rightsConfirmed: true };
  if (label !== undefined && label !== null) json.label = label;
  const { status, data } = await adminRequest('POST', `${POD_PATH}/artwork`, { json, shopId });
  return { status, artwork: data?.artwork ?? null };
}

/** The seller's name of an artwork (`null` clears it). → the summary as stored. */
export async function renameArtwork(artworkId, label, { shopId } = {}) {
  const { data } = await adminRequest('PATCH', artworkPath(artworkId), { json: { label }, shopId });
  return data?.artwork ?? null;
}

/** Removes an artwork and its print outputs. 409 `conflict` while any mapping (even a removed one) names it. */
export async function deleteArtwork(artworkId, { shopId } = {}) {
  await adminRequest('DELETE', artworkPath(artworkId), { shopId });
}

/** The printers this shop may map to: capabilities (models, articles, print frames), no price. */
export async function listPrinters({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', `${POD_PATH}/printers`, { shopId, signal });
  return list(data?.printers);
}

/** The shop's mappings (every status), or one product's. */
export async function listMappings({ productId, shopId, signal } = {}) {
  const { data } = await adminRequest('GET', withQuery(`${POD_PATH}/mappings`, { productId }), { shopId, signal });
  return list(data?.mappings);
}

/**
 * Creates (or re-activates) a mapping: `{ productId, variantId?, artworkId,
 * printerId, sku, slots }`. → `{ created, mapping, quote: { inkopMinor,
 * priceFloorMinor, currency } }` (the quote of the mapping's whole scope).
 */
export async function createMapping({ productId, variantId = null, artworkId, printerId, sku, slots }, { shopId } = {}) {
  const json = { productId, artworkId, printerId, sku, slots };
  if (variantId !== null && variantId !== undefined) json.variantId = variantId;
  const { status, data } = await adminRequest('POST', `${POD_PATH}/mappings`, { json, shopId });
  return {
    created: status === 201,
    mapping: data?.mapping ?? null,
    quote: { inkopMinor: data?.inkopMinor, priceFloorMinor: data?.priceFloorMinor, currency: data?.currency },
  };
}

/** Removes a mapping (it stays on the server as inactive). */
export async function deleteMapping(mappingId, { shopId } = {}) {
  await adminRequest('DELETE', `${POD_PATH}/mappings/${segment(mappingId)}`, { shopId });
}

/**
 * The seller's one number for a printer, an article and print slots chosen
 * before a mapping exists: `{ inkopMinor, priceFloorMinor, currency }`.
 * Rejects with the API's error (422 `printer_unavailable` |
 * `sku_unavailable` | `slot_not_printable`).
 */
export async function getDesignQuote({ printerId, sku, slots }, { shopId, signal } = {}) {
  const path = withQuery(`${POD_PATH}/design-quote`, { printerId, sku, slots: slots.join(',') });
  const { data } = await adminRequest('GET', path, { shopId, signal });
  return { inkopMinor: data?.inkopMinor, priceFloorMinor: data?.priceFloorMinor, currency: data?.currency };
}
