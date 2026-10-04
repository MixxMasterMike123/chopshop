// The POD page's reads for ONE shop (CP5 unit FM): the library, the profiles,
// the mappings, the printers and the products the mapping form picks from,
// in the shapes the older POD components read (adapters/pod.js). No React:
// the hook (podLibrary.js) and the components' data modules call these, and
// they are tested under Node against the dev API (podLibraryLoad.test.mjs).
//
// BOUND TO THE SHOP (CP5-FX finding 1). Every read asks the shop it was made
// for and goes through readForShop: an answer that arrives after the tab moved
// to another shop is dropped, never shown. The caches here are keyed by shop.
//
// A FAILED READ IS NOT A REMOVAL. The library's list is the server's truth;
// each artwork's detail (preview, notices, reasons) and its original's
// metadata (type, size, checksum) are read beside it, and a row whose extra
// read failed is shown without that part, never dropped.
//
// A RENDER THAT FAILED IS SAID. The list does not carry a failed render (its
// row is removed so the same upload can be posted again); only the detail of
// its id answers `failed`. So the tab remembers the renders it has seen
// processing (per shop, for the life of the tab) and asks each one's detail
// when it leaves the list: failed → a "Misslyckades" row until the seller
// dismisses it; the opaque 404 → forgotten (deleted); a failed read → kept.

import { getRequestShopId } from '../../api/admin/client.js';
import { getArtwork, listArtwork, listMappings, listPrinters, listProfiles } from '../../api/admin/pod.js';
import { getProduct, listAllProducts } from '../../api/admin/products.js';
import { getObject } from '../../api/admin/uploads.js';
import { readForShop } from '../providers/ordersForShop.js';
import { slotLabel } from '../../config/podSlots.js';
import {
  artworkRow,
  failedArtworkRow,
  mappingRows,
  pickerProducts,
  printerChoices,
  profileFromApi,
  renderState,
} from '../adapters/pod.js';
import { HELD_PREVIEW_LIMIT, heldPreviewUrl } from './podPreviewBlobs.js';

/** How many reads of one kind run at once (details, objects, products). */
export const READ_CONCURRENCY = 4;

/** `fn` over `items`, at most `limit` at a time; each failure becomes null. */
export async function mapLimited(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const shopOf = (shopId) => shopId ?? getRequestShopId();

// ── what the tab remembers, per shop ────────────────────────────────────────

const trackers = new Map(); // shopId → Map(artworkId → { artworkId, label, profileId, originalObjectId, createdAt, failed })
const objectCache = new Map(); // shopId → Map(objectId → metadata)
const printerCache = new Map(); // shopId → Promise<printers>

function trackerOf(shopId) {
  if (!trackers.has(shopId)) trackers.set(shopId, new Map());
  return trackers.get(shopId);
}

/** Remember a render this tab saw start (or saw processing). */
export function trackRender(shopId, { artworkId, label = null, profileId = null, originalObjectId = null, createdAt = null }) {
  if (!shopId || !artworkId) return;
  const held = trackerOf(shopId);
  if (!held.has(artworkId)) held.set(artworkId, { artworkId, label, profileId, originalObjectId, createdAt: createdAt ?? Date.now(), failed: false });
}

/** Forget a render (deleted, dismissed, or its failure already told). */
export function forgetRender(shopId, artworkId) {
  trackers.get(shopId)?.delete(artworkId);
}

/** The renders the tab remembers for a shop (tests). */
export function trackedRenders(shopId) {
  return [...(trackers.get(shopId)?.values() ?? [])].map((t) => ({ ...t }));
}

/** Drop everything remembered (tests, and a fresh sign-in). */
export function resetPodMemory() {
  trackers.clear();
  objectCache.clear();
  printerCache.clear();
}

// ── reads ───────────────────────────────────────────────────────────────────

/** The printers this shop may map to, as the form's choices; one read per shop until `fresh`. */
export function loadPrinterChoices(shopId, { fresh = false } = {}) {
  const shop = shopOf(shopId);
  if (fresh || !printerCache.has(shop)) {
    const read = readForShop(shop, (id) => listPrinters({ shopId: id })).then(printerChoices);
    printerCache.set(shop, read);
    read.catch(() => printerCache.delete(shop));
  }
  return printerCache.get(shop);
}

/** The active profiles in the older shape. */
export function loadProfiles(shopId) {
  return readForShop(shopOf(shopId), async (id) => (await listProfiles({ shopId: id })).map(profileFromApi).filter(Boolean));
}

async function originalOf(shopId, objectId) {
  if (!objectId) return null;
  const cache = objectCache.get(shopId) ?? new Map();
  objectCache.set(shopId, cache);
  if (cache.has(objectId)) return cache.get(objectId);
  const object = await getObject(objectId, { shopId });
  if (object) cache.set(objectId, object); // a 404 or a failure is not cached: asked again next time
  return object;
}

/**
 * The library: one row per artwork of the list (with its detail and its
 * original's metadata where those reads succeeded), plus the failed renders
 * the tab remembers. Newest first.
 */
export function loadArtworkRows(shopId) {
  const shop = shopOf(shopId);
  return readForShop(shop, async (id) => {
    const summaries = await listArtwork({ shopId: id });
    const tracked = trackerOf(id);
    for (const s of summaries) {
      if (s.status === 'processing') {
        trackRender(id, { artworkId: s.artworkId, label: s.label, profileId: s.profileId, originalObjectId: s.originalObjectId, createdAt: s.createdAt });
      } else {
        tracked.delete(s.artworkId);
      }
    }
    const rows = await mapLimited(summaries, READ_CONCURRENCY, async (s, i) => {
      const [detail, object] = await Promise.all([
        getArtwork(s.artworkId, { shopId: id }).catch(() => null),
        originalOf(id, s.originalObjectId).catch(() => null),
      ]);
      // The preview is fetched now, while its signed address is fresh, and
      // held as a blob: address (podPreviewBlobs.js): the studio draws it long
      // after the five minutes the signed address lasts.
      const signed = detail?.previewUrl ?? null;
      const previewUrl = s.status === 'ready' && i < HELD_PREVIEW_LIMIT
        ? await heldPreviewUrl(id, s.artworkId, signed)
        : signed;
      return artworkRow(s, { detail: detail?.artwork ?? null, previewUrl, object });
    });

    // The renders the tab saw processing that the list no longer carries.
    const listed = new Set(summaries.map((s) => s.artworkId));
    const missing = [...tracked.values()].filter((t) => !listed.has(t.artworkId));
    const extra = await mapLimited(missing, READ_CONCURRENCY, async (t) => {
      if (t.failed) return failedArtworkRow(t);
      let answer;
      try {
        answer = await getArtwork(t.artworkId, { shopId: id });
      } catch {
        // Not known yet: still shown as being processed and asked again next
        // time; a failed read never makes it disappear.
        return { ...failedArtworkRow(t), status: 'processing' };
      }
      const { state } = renderState(answer);
      if (state === 'failed') {
        t.failed = true;
        return failedArtworkRow(t);
      }
      if (state === 'gone') tracked.delete(t.artworkId);
      return null;
    });

    return [...extra.filter(Boolean), ...rows.map((row, i) => row ?? artworkRow(summaries[i]))]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  });
}

/**
 * The shop's products for the mapping form's picker: the list, and each
 * product's detail where it has variants (its variants are the variant
 * choices). A detail that could not be read leaves its product without
 * variant choices.
 */
export function loadPickerProducts(shopId) {
  return readForShop(shopOf(shopId), async (id) => {
    const items = (await listAllProducts({ shopId: id })).filter((item) => item?.status !== 'archived');
    const details = await mapLimited(items, READ_CONCURRENCY, (item) =>
      item.variantCount === 0 ? null : getProduct(item.productId, { shopId: id }));
    return pickerProducts(items.map((item, i) => ({ item, detail: details[i] })));
  });
}

/**
 * Everything the POD page shows, for one shop:
 *   { artwork, profiles, mappings (list rows), products, productSkus }
 * Rejects when the library, the profiles, the mappings or the products
 * cannot be read (the page then says so); the printers are optional (a
 * mapping whose printer is not readable says so in its row).
 */
export async function loadPodLibrary(shopId) {
  const shop = shopOf(shopId);
  const [artwork, profiles, mappings, picker, printers] = await Promise.all([
    loadArtworkRows(shop),
    loadProfiles(shop),
    readForShop(shop, (id) => listMappings({ shopId: id })),
    loadPickerProducts(shop),
    loadPrinterChoices(shop, { fresh: true }).catch(() => []),
  ]);
  const artworkById = new Map(artwork.map((a) => [a.id, a]));
  return {
    artwork,
    profiles,
    mappings: mappingRows(mappings, { byScope: picker.byScope, printers, artworkById, slotLabel }),
    products: picker.products,
    productSkus: picker.skus,
  };
}

/**
 * Looks once more at the renders still processing. → true when any of them
 * has a verdict now (or failed, or is gone): the caller reads the library
 * again. A failed read counts as "no news".
 */
export function renderNews(shopId, artworkIds) {
  const shop = shopOf(shopId);
  return readForShop(shop, async (id) => {
    const states = await mapLimited(artworkIds, READ_CONCURRENCY, async (artworkId) =>
      renderState(await getArtwork(artworkId, { shopId: id })).state);
    return states.some((s) => s !== null && s !== 'processing');
  });
}
