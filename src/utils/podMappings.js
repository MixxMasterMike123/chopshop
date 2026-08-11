// podMappings.js — the SKU → artwork mapping (the order↔artwork bridge).
//
// Collection: podMappings/{id}, keyed logically by (shopId, sku). Products are a
// SEPARATE entity — this never reads/writes products/{id}. The print-shop callable
// joins order.items[].sku → this mapping (scoped to the order's shop) → podArtwork
// to find the right original. firestore.rules podMappings block (Slice 3) enforces
// shop isolation at the rules layer.
import {
  collection, doc, addDoc, updateDoc, getDocs, deleteDoc, query, where, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { withShopId } from '../config/withShopId';
import { DEFAULT_SHOP_ID } from '../config/tenancy';
import { slotOf, DEFAULT_SLOT } from '../config/podSlots';

const COL = 'podMappings';

/** List a shop's mappings. */
export const listMappings = async (shopId) => {
  const q = query(collection(db, COL), where('shopId', '==', shopId || DEFAULT_SHOP_ID));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

/**
 * Get the mapping for a (shopId, sku, placementSlot), or null. MULTI-PLACEMENT:
 * a SKU may have several mappings (one per slot), so we match the slot too. A doc
 * MISSING placementSlot is treated as 'front' (slotOf normalises it), so the query
 * fetches every SKU row and matches slot in code (a Firestore `where` can't OR-in
 * the missing-field case).
 */
export const getMappingBySku = async (shopId, sku, placementSlot = DEFAULT_SLOT) => {
  const wantSlot = slotOf(placementSlot);
  const q = query(
    collection(db, COL),
    where('shopId', '==', shopId || DEFAULT_SHOP_ID),
    where('sku', '==', sku)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const match = snap.docs.find((d) => slotOf(d.data()) === wantSlot);
  if (!match) return null;
  return { id: match.id, ...match.data() };
};

/**
 * Upsert a mapping for (shopId, sku, placementSlot). MULTI-PLACEMENT: one mapping
 * per (SKU, slot) per shop — adding the same product+slot REPLACES that slot's
 * artwork; a different slot for the same SKU is a NEW row. `replaced` in the return
 * tells the caller a slot's previous artwork was overwritten (for the UI toast).
 * Returns { id, replaced }.
 */
export const setMapping = async ({ shopId, sku, artworkId, profileId, placement, placementSlot, position = null, slotLabel = null }) => {
  const cleanSku = String(sku || '').trim();
  if (!cleanSku) throw new Error('SKU krävs.');
  const slot = slotOf(placementSlot);
  const existing = await getMappingBySku(shopId, cleanSku, slot);
  const payload = {
    sku: cleanSku,
    artworkId: artworkId || null,
    profileId: profileId || null,
    placement: String(placement || '').trim(),
    placementSlot: slot,
    // Machine-readable pocket position (left/center/right) — the human text in
    // `placement` carries it too; this field is for future tooling.
    position: position || null,
    // Garment-correct DISPLAY label for the slot ("Framsida" on a keps — the
    // shared vocabulary says "Bröst"). Print projection prefers it, falls back
    // to the shared label when absent (older rows).
    slotLabel: String(slotLabel || '').trim().slice(0, 40) || null,
    updatedAt: serverTimestamp(),
  };
  if (existing) {
    await updateDoc(doc(db, COL, existing.id), payload);
    return { id: existing.id, replaced: true };
  }
  const ref = await addDoc(collection(db, COL), withShopId({ ...payload, createdAt: serverTimestamp() }, shopId));
  return { id: ref.id, replaced: false };
};

/** Delete a mapping by id. */
export const deleteMapping = async (id) => {
  await deleteDoc(doc(db, COL, id));
};

/**
 * Read-only product lookup (by shop) for the mapping UI's SKU picker + orphan check.
 * NEVER writes products — POD owns mappings, products stay untouched (locked arch).
 *
 * Returns:
 *   • skus     — Set of every mappable SKU (parent + variant), for orphan-flagging.
 *   • rows     — flat [{ sku, name, label }] (kept for existing callers).
 *   • products — [{ sku, name, image, hasSku, variants }] one row per PRODUCT
 *                (parent SKU), for the picker. A parent mapping covers all
 *                variants (print projection resolves variant lines to the parent
 *                SKU); a per-COLORWAY mapping wins over the parent for that
 *                colorway (use case: a different logo colour on dark garments).
 *                `variants` = [{ sku, label, image }] at colorway granularity
 *                (the variant rail's group level — the sku order-lines prefix).
 *                Products lacking a SKU are still listed (hasSku:false) so the
 *                seller sees them, disabled.
 */
export const listShopProductSkus = async (shopId) => {
  const snap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId || DEFAULT_SHOP_ID)));
  const skus = new Set();
  const rows = [];
  const products = [];
  snap.docs.forEach((d) => {
    const p = d.data();
    const image = p.imageUrl || p.b2cImageUrl || null;

    // Colorway-level variant rows for the picker. The variant rail persists the
    // colorway as a `variantGroups[]` entry ({ label, sku, image }); size rows in
    // `variants[]` derive their sku as `${groupSku}-${sizeSlug}`, so the GROUP sku
    // is the correct '-'-boundary prefix a per-colorway mapping should target
    // (mirrors resolveMapping). Prefer variantGroups; fall back to deduping
    // `variants[]` by group for legacy docs that lack variantGroups.
    const variantRows = [];
    const seenVariantSku = new Set();
    if (Array.isArray(p.variantGroups) && p.variantGroups.length > 0) {
      p.variantGroups.forEach((g) => {
        if (!g || !g.sku || seenVariantSku.has(g.sku)) return;
        seenVariantSku.add(g.sku);
        variantRows.push({ sku: g.sku, label: g.label || g.sku, image: g.image || null });
      });
    } else if (Array.isArray(p.variants)) {
      p.variants.forEach((v) => {
        if (!v || !v.sku || seenVariantSku.has(v.sku)) return;
        seenVariantSku.add(v.sku);
        variantRows.push({ sku: v.sku, label: v.group || v.label || v.sku, image: v.image || null });
      });
    }

    products.push({ id: d.id, sku: p.sku || '', name: p.name || '', image, hasSku: !!p.sku, variants: variantRows });
    if (p.sku) { skus.add(p.sku); rows.push({ sku: p.sku, name: p.name, label: null }); }
    // include every sellable variant SKU too (a mapping can target any of them)
    if (Array.isArray(p.variants)) {
      p.variants.forEach((v) => {
        if (v.sku) { skus.add(v.sku); rows.push({ sku: v.sku, name: p.name, label: v.label || '' }); }
      });
    }
    // ...and the colorway (group) skus, which may differ from any size row.
    variantRows.forEach((v) => { if (v.sku) skus.add(v.sku); });
  });
  // Stable, human-friendly order: named products first, alphabetical.
  products.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'sv'));
  return { skus, rows, products };
};
