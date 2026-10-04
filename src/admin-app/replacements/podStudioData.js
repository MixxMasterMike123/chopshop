// The design studio's data module for the ADMIN build (CP5 unit FN1): the
// alias list of vite.admin.config.js puts this file where DesignStudio
// imports src/wagons/pod-wagon/studio/studioData.js (the older build's,
// Firebase). Same names.
//
// What the Worker's model changes in the studio (each listed in
// docs/cf-port/CP5_FN1_REPORT.md):
//   - THE PRINT IS SIZED BY THE SERVER. A mapping stores no placement and no
//     pocket position: the server prints each slot as large as the frame and
//     the artwork's DPI floor allow (contain-fit, pod-mappings.ts sizeSlot).
//     So the studio shows exactly that (placementEditable: false → every slot
//     is the locked contain placement, as the pocket always was), and the
//     pocket sits at the printer's own left-chest spot.
//   - THE SELLER CHOOSES the printer and model when several make a garment,
//     and the printer's ARTICLE for each colour and size (publish step): a
//     mapping is printer + article + slots.
//   - The numbers are the server's design quote per article (podCostQuote.js
//     quoteDesign); podPricing.js is not used.
//   - The 3D view and the mockup upload are OFF until unit FN2.
//   - Nothing is offered when no printer can make it (offerUnrouted: false):
//     the older studio offered every template before any printer existed.

import { useAdminShop } from '../providers/ShopFeatures.jsx';
import { skuFromName, uniqueSku } from '../../utils/productUrls';
import { deriveVariantsFromGroups } from '../../utils/variantDerivation';
import { publishNewDesign, updateExistingFromDesign } from './podStudioPublish.js';
import { serverPlacement } from '../adapters/studio.js';

export const STUDIO_FLAGS = Object.freeze({
  /** The seller drags and resizes a print (and picks the pocket position). */
  placementEditable: false,
  /** Every template is offered while no printer is known. */
  offerUnrouted: false,
  /** The seller picks the printer and model when several make the garment. */
  sellerChoosesProduction: true,
  /** The editor (step header, Tillbaka, the publish form) is locked while a save runs. */
  lockWhileSaving: true,
  /** The 3D view (unit FN2). */
  studio3d: false,
});

export const STUDIO_TEXT = Object.freeze({
  placementIntro:
    'Motivet trycks så stort som tryckytan och originalets upplösning tillåter, centrerat i ytan. Så här blir trycket — placeringen kan inte ändras här.',
  pocketNote:
    'Fickmotivet trycks på tryckeriets vänstra bröstplacering (sett från bäraren), så stort som den fasta ytan och upplösningen tillåter.',
  canvasLockedNote: 'Tryckeriet trycker motivet så stort som tryckytan och originalets upplösning tillåter, centrerat. Måtten ovan är trycket.',
  no3d: '3D-vyn finns inte i den här versionen av adminen ännu.',
  productionLabel: 'Tryckeri och plagg',
});

/**
 * The placement of a locked slot (every slot here): the print exactly as the
 * Worker sizes it — the chosen model's frame (slotFrame), the ARTWORK's own
 * profile DPI floor (else 300, never the template's), contain-fit, whole mm —
 * centred (adapters/studio.js serverPlacement). The canvas, the review strip,
 * the mockups and the measurements shown all read this one function.
 */
export const lockedPlacement = (template, slot, artwork, { frames, profiles } = {}) =>
  serverPlacement(template, slot, artwork, { frames, profiles });

/** What the studio needs of the shop for a publish: its currency. */
export function useStudioEnv() {
  const { shop } = useAdminShop();
  return { currency: shop?.currency || 'SEK' };
}

const DEPS = { skuFromName, uniqueSku, deriveVariantsFromGroups };

/**
 * The studio's "Skapa produkt": `ctx` is the studio's snapshot of the design
 * (DesignStudio studioContext), `form` the publish panel's. → { result } |
 * { error, field?, changed? }
 */
export async function publishDesign(ctx, form) {
  const production = ctx.production;
  if (!production?.printerId) return { error: 'Inget tryckeri kan tillverka plagget just nu. Kontakta plattformen.' };
  const byId = new Map((ctx.selectedTemplate?.colorways || []).map((c) => [c.id, c]));
  const colorways = (form.selectedColorwayIds || []).filter((id) => byId.has(id)).map((id) => {
    const sizes = form.sizesByColorway?.[id] || [];
    const articles = form.articlesByColorway?.[id] || {};
    return {
      id,
      label: byId.get(id).label,
      price: form.perColorwayPrices?.[id] ?? '',
      cells: sizes.length > 0
        ? sizes.map((size) => ({ size, sku: articles[size] || '' }))
        : [{ size: null, sku: articles[''] || '' }],
    };
  });
  return publishNewDesign({
    shopId: ctx.shopId,
    currency: ctx.env?.currency || 'SEK',
    name: String(form.name || '').trim(),
    price: form.price,
    colorways,
    slots: ctx.publishSlots,
    printerId: production.printerId,
    artworkFor: (slot, colorwayId) => ctx.resolveArtwork(slot, colorwayId)?.id ?? null,
  }, DEPS);
}

/**
 * The studio's "Uppdatera produkten": the design's print mappings on an
 * existing product's variants (each on the article the seller chose). Its
 * variants, prices and texts are not touched.
 */
export async function updateProductFromDesign(ctx, form) {
  const production = ctx.production;
  if (!production?.printerId) return { error: 'Inget tryckeri kan tillverka plagget just nu. Kontakta plattformen.' };
  const selected = new Set(form.selectedColorwayIds || []);
  const colorways = (ctx.selectedTemplate?.colorways || []).filter((c) => selected.has(c.id)).map((c) => ({ id: c.id, label: c.label }));
  const overrideColorwayIds = [...new Set(ctx.publishSlots.flatMap((slot) =>
    Object.entries(ctx.overrides?.[slot] || {}).filter(([cwId, artId]) => artId && selected.has(cwId)).map(([cwId]) => cwId)))];
  return updateExistingFromDesign({
    shopId: ctx.shopId,
    productId: form.productId,
    slots: ctx.publishSlots,
    printerId: production.printerId,
    articles: form.articlesByScope || {},
    colorways,
    overrideColorwayIds,
    artworkFor: (slot, colorwayId) =>
      (colorwayId ? ctx.resolveArtwork(slot, colorwayId) : ctx.printArtwork(slot))?.id ?? null,
  });
}
