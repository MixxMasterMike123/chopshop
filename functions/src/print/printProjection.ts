// printProjection.ts — builds the FIELD-MINIMISED production view of a POD order
// for the print shop. This is the data-minimisation boundary: the printer (an
// external sub-processor) gets ship-to + production fields ONLY — never customer
// email/phone, payment refs, totals, marketing flags, or internal notes.
//
// The order↔artwork join: order.items[].sku → podMappings (scoped to the order's
// shop) → podArtwork → a short-lived SIGNED download URL for the original.
import { getStorage } from 'firebase-admin/storage';
import { db } from '../config/database';

const SIGNED_URL_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Placement slots — a single product can carry SEVERAL artworks (front/back/
// sleeve). A mapping's placementSlot picks which physical position its artwork
// prints on. MISSING placementSlot on a doc = 'front' (backward compat: the one
// live pre-slot mapping keeps working with zero migration). Swedish labels are
// the shop/print-facing text; the id is stored.
export type PlacementSlot = 'front' | 'back' | 'pocket' | 'left_sleeve' | 'right_sleeve' | 'other';
const SLOT_LABELS: Record<PlacementSlot, string> = {
  front: 'Bröst',
  back: 'Rygg',
  pocket: 'Ficka', // position name, not a sewn pocket (left-chest logo spot)
  left_sleeve: 'Vänster ärm',
  right_sleeve: 'Höger ärm',
  other: 'Övrig',
};
export const DEFAULT_SLOT: PlacementSlot = 'front';
export function slotOf(mapping: any): PlacementSlot {
  const s = mapping?.placementSlot;
  return s === 'back' || s === 'pocket' || s === 'left_sleeve' || s === 'right_sleeve' || s === 'other' ? s : DEFAULT_SLOT;
}
export function slotLabel(slot: PlacementSlot): string {
  return SLOT_LABELS[slot] || SLOT_LABELS[DEFAULT_SLOT];
}

// Mint a short-lived signed read URL for a Storage object. Falls back to the
// stored download URL if signing isn't available (the Functions service account
// needs roles/iam.serviceAccountTokenCreator to sign — a project-config item).
async function signedUrlFor(storagePath: string, fallbackUrl: string | null): Promise<string | null> {
  if (!storagePath) return fallbackUrl;
  try {
    const [url] = await getStorage()
      .bucket()
      .file(storagePath)
      .getSignedUrl({ action: 'read', expires: Date.now() + SIGNED_URL_TTL_MS });
    return url;
  } catch (e: any) {
    console.warn(`print: signed URL failed for ${storagePath} (need serviceAccountTokenCreator?), falling back:`, e?.message);
    return fallbackUrl;
  }
}

// Load a shop's POD mappings, grouped by mapping SKU (one read per shop, cached by
// caller). MULTI-PLACEMENT: a SKU can now carry SEVERAL mappings (one per slot:
// front/back/sleeve), so each map value is an ARRAY of mappings for that SKU — the
// old one-row-per-sku assumption is gone. Slot resolution happens in resolveSlots.
export async function loadShopMappings(shopId: string): Promise<Map<string, any[]>> {
  const snap = await db.collection('podMappings').where('shopId', '==', shopId).get();
  const bySku = new Map<string, any[]>();
  snap.docs.forEach((d) => {
    const m = d.data();
    if (!m.sku) return;
    const arr = bySku.get(m.sku) || [];
    arr.push({ id: d.id, ...m });
    bySku.set(m.sku, arr);
  });
  return bySku;
}

// Resolve the best mapping PER SLOT for an order-line SKU. For each slot, the same
// matching rule as before applies INDEPENDENTLY: an exact-SKU mapping for that slot
// wins; otherwise the LONGEST '-'-boundary-prefix mapping for that slot wins (a
// per-colorway `north-01-svart` beats the parent `north-01` for `north-01-svart-l`,
// but only within the SAME slot — a colorway front-mapping does NOT override the
// parent's back-mapping). Variant SKUs derive as `${parent}-${color}-${size}`.
// Docs missing placementSlot resolve as 'front' (backward compat).
//
// Returns a Map<slot, mapping> holding one winning mapping per slot that resolves
// (empty when the SKU has no mapping at all → a non-POD line).
export function resolveSlots(sku: string, mappingsBySku: Map<string, any[]>): Map<PlacementSlot, any> {
  const out = new Map<PlacementSlot, any>();
  if (!sku) return out;
  // Per slot: track the current winner + the length of the key that matched it.
  // Exact match is modelled as an infinitely-long key so it always beats a prefix.
  const bestLen: Partial<Record<PlacementSlot, number>> = {};
  for (const [key, mappings] of mappingsBySku) {
    let matchLen = -1;
    if (key === sku) matchLen = Number.MAX_SAFE_INTEGER; // exact wins over any prefix
    else if (sku.startsWith(key + '-')) matchLen = key.length;
    else continue;
    for (const mapping of mappings) {
      const slot = slotOf(mapping);
      const prev = bestLen[slot] ?? -1;
      // Ties (two docs same slot + same key length, e.g. duplicate exact rows) keep
      // the first seen — deterministic enough; the admin upsert prevents this.
      if (matchLen > prev) {
        out.set(slot, mapping);
        bestLen[slot] = matchLen;
      }
    }
  }
  return out;
}

// Back-compat helper: resolve the single best mapping for a SKU (any slot). Used by
// the any-slot POD checks (orderHasPodLine, setPrintJobStatus). Returns null if the
// SKU has no mapping in any slot; otherwise a representative winning mapping.
export function resolveMapping(sku: string, mappingsBySku: Map<string, any[]>): any | null {
  const slots = resolveSlots(sku, mappingsBySku);
  if (slots.size === 0) return null;
  // Prefer the front slot when present, else any resolved slot.
  return slots.get(DEFAULT_SLOT) || slots.values().next().value;
}

// Is this order a POD order for the given shop? (any line's sku resolves any slot)
export function orderHasPodLine(order: any, mappingsBySku: Map<string, any[]>): boolean {
  const items = Array.isArray(order.items) ? order.items : [];
  return items.some((it: any) => it && it.sku && resolveSlots(it.sku, mappingsBySku).size > 0);
}

// Build the PRODUCTION-SCOPED line list for the printer notification email —
// one entry per (order item × resolved slot), with the slot-aware placement label
// ("Bröst — Centrerat på bröstet"). No artwork lookup (the email links to the
// portal for files), no customer PII. Mirrors toPrintJob's slot iteration.
export function toPrintNotificationLines(
  order: any,
  mappingsBySku: Map<string, any[]>
): Array<{ productName: string; sku: string; quantity: number; placement: string }> {
  const items = Array.isArray(order.items) ? order.items : [];
  const SLOT_ORDER: PlacementSlot[] = ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve', 'other'];
  const out: Array<{ productName: string; sku: string; quantity: number; placement: string }> = [];
  for (const it of items) {
    if (!it || !it.sku) continue;
    const slots = resolveSlots(it.sku, mappingsBySku);
    if (slots.size === 0) continue;
    for (const slot of SLOT_ORDER.filter((s) => slots.has(s))) {
      const mapping = slots.get(slot);
      const detail = String(mapping.placement || '').trim();
      out.push({
        productName: typeof it.name === 'string' ? it.name : (it.name?.['sv-SE'] || it.sku),
        sku: it.sku,
        quantity: it.quantity || 0,
        placement: detail ? `${slotLabel(slot)} — ${detail}` : slotLabel(slot),
      });
    }
  }
  return out;
}

// Minimal LIST row — no address, no contact, no money.
export function toQueueRow(orderId: string, order: any, shopName: string, mappingsBySku: Map<string, any[]>) {
  const items = Array.isArray(order.items) ? order.items : [];
  // MULTI-PLACEMENT: one production line per (item × resolved slot) — a shirt with a
  // front + back print counts as 2 lines. Sum resolved slots across items.
  let podLineCount = 0;
  for (const it of items) {
    if (it && it.sku) podLineCount += resolveSlots(it.sku, mappingsBySku).size;
  }
  const ship = order.shippingInfo || {};
  const isPickup = order.deliveryMethod === 'pickup';
  return {
    orderId,
    orderNumber: order.orderNumber || orderId,
    orderDate: order.createdAt?.toDate ? order.createdAt.toDate().toISOString() : (order.createdAt || null),
    shopId: order.shopId || null,
    shopName: shopName || order.shopId || '',
    status: order.status || '',
    podLineCount,
    deliveryMethod: isPickup ? 'pickup' : 'home',
    // Pickup rows show the pickup location, not a customer city.
    shipToCity: isPickup ? (order.pickupLocation?.name || '') : (ship.city || ''),
    shipToCountry: isPickup ? '' : (ship.country || ''),
  };
}

// Full per-order PRODUCTION view: ship-to + per POD line (resolved artwork +
// signed URL). Lines whose mapping/artwork can't resolve come back with
// artwork:{unresolved:true,reason} (visible problem, never a silently-missing line).
export async function toPrintJob(orderId: string, order: any, shopName: string, mappingsBySku: Map<string, any[]>) {
  const items = Array.isArray(order.items) ? order.items : [];
  const ship = order.shippingInfo || {};

  // MULTI-PLACEMENT: emit ONE production line per (order item × resolved slot). A
  // shirt with a front + back artwork yields two lines, each with its own file and
  // a slot-aware placement label ("Bröst — Centrerat på bröstet": slot label +
  // free-text detail). Slots resolve independently (see resolveSlots).
  const lines = [];
  for (const it of items) {
    if (!it || !it.sku) continue;
    const slots = resolveSlots(it.sku, mappingsBySku);
    if (slots.size === 0) continue; // non-POD line — skip

    // Stable ordering of the per-item slot lines (front→back→sleeves→other).
    const SLOT_ORDER: PlacementSlot[] = ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve', 'other'];
    const orderedSlots = SLOT_ORDER.filter((s) => slots.has(s));

    for (const slot of orderedSlots) {
      const mapping = slots.get(slot);
      const detail = String(mapping.placement || '').trim();
      // "Bröst — Centrerat på bröstet" (slot label + optional free-text detail).
      const placement = detail ? `${slotLabel(slot)} — ${detail}` : slotLabel(slot);
      const base = {
        productName: typeof it.name === 'string' ? it.name : (it.name?.['sv-SE'] || it.sku),
        sku: it.sku,
        variantLabel: it.label || null,
        quantity: it.quantity || 0,
        placementSlot: slot,
        slotLabel: slotLabel(slot),
        placement,
        profileId: mapping.profileId || null,
      };

      if (!mapping.artworkId) {
        lines.push({ ...base, purpose: mapping.profileId || null, artwork: { unresolved: true, reason: 'Ingen artworkId i kopplingen' } });
        continue;
      }
      const artSnap = await db.collection('podArtwork').doc(mapping.artworkId).get();
      if (!artSnap.exists) {
        lines.push({ ...base, purpose: mapping.profileId || null, artwork: { unresolved: true, reason: 'Originalet är borttaget' } });
        continue;
      }
      const art: any = artSnap.data();
      // DELIVERY = the gate-verified print PNG (docs/POD_PRINT_SPEC.md: always
      // transparent PNG, RGB, ≥300 DPI). The print/ storage path is SERVER-OWNED
      // (storage.rules denies client create/update), and we only honour a path
      // inside THIS shop's print/ folder — so a hand-crafted doc can never route
      // ungated or cross-tenant bytes to the printer.
      const shopPrintPrefix = `pod-artwork/${String(order.shopId || '')}/print/`;
      const isPrintFile =
        typeof art.printStoragePath === 'string' && art.printStoragePath.startsWith(shopPrintPrefix);
      // Legacy docs (created before the gate pipeline — no status field) fall back
      // to the raw original for continuity. A doc that CLAIMS a status but lacks a
      // valid print file is not deliverable — surface it instead of shipping it.
      if (!isPrintFile && art.status !== undefined) {
        lines.push({ ...base, purpose: art.purpose || mapping.profileId || null, artwork: { unresolved: true, reason: 'Tryckfil saknas — be butiken validera om originalet' } });
        continue;
      }
      const downloadUrl = isPrintFile
        ? await signedUrlFor(art.printStoragePath, art.printUrl || null)
        : await signedUrlFor(art.originalStoragePath, art.originalUrl || null);
      lines.push({
        ...base,
        purpose: art.purpose || mapping.profileId || null,
        artwork: {
          tier: art.validation?.tier || null,
          fileName: art.fileName || '',
          ext: isPrintFile ? 'png' : (art.ext || ''),
          isPrintFile,
          downloadUrl,
          previewUrl: art.previewUrl || null,
        },
      });
    }
  }

  const deliveryMethod = order.deliveryMethod === 'pickup' ? 'pickup' : 'home';
  return {
    order: {
      orderNumber: order.orderNumber || orderId,
      orderDate: order.createdAt?.toDate ? order.createdAt.toDate().toISOString() : (order.createdAt || null),
      status: order.status || '',
      orderRef: orderId,
    },
    shopName: shopName || order.shopId || '',
    deliveryMethod,
    // Pickup orders: the printer delivers to the SHOP's pickup location and the
    // shop hands over to the customer — so no customer ship-to at all (data
    // minimisation: the printer doesn't even need the customer's name; the order
    // number identifies the parcel).
    pickup: deliveryMethod === 'pickup'
      ? {
          name: order.pickupLocation?.name || '',
          address: order.pickupLocation?.address || '',
          date: order.pickupLocation?.date || '',
        }
      : null,
    // ship-to ONLY — name + address, needed to fulfil. NO email/phone.
    shipTo: deliveryMethod === 'pickup'
      ? null
      : {
          name: order.customerInfo?.name || '',
          line1: ship.address || '',
          line2: ship.apartment || '',
          postalCode: ship.postalCode || '',
          city: ship.city || '',
          country: ship.country || '',
        },
    lines,
  };
}
