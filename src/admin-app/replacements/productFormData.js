// ProductForm's data layer — the ADMIN build's implementation (the API).
// The alias list of vite.admin.config.js puts this file where the form imports
// src/components/admin/productFormData.js (the older build's, Firebase). Same
// names, same meaning; the shapes are bridged by src/admin-app/adapters/product.js.
//
// THE SELLER SEES ONE NUMBER (rule 15). "Inköp" and the price floor are the
// server's (GET /v1/admin/pod/quote); the client formula of podPricing.js is
// not imported here, and nothing the form computes from a cost leaves this
// module: the profit line and the margin → price tool have no source in this
// build and leave the form (profitAt/marginAt answer null, suggestPrice is null).
//
// The save, in the order that keeps a refusal at the field it concerns:
//   1. the SKU made unique against the shop's products (as the older build)
//   2. the body checked against the API's limits (the field is named)
//   3. POST /v1/admin/products (create; a draft) or PATCH (update + status)
//      — a floor refusal or an HTML refusal of "Mer information" stops here,
//        with nothing written
//   4. the variants: DELETE / PATCH / POST until the server's rows are the
//      rail's rows (adapters/product.js planVariantSync); a size keeps its own
//      price unless the seller changed its group's price
//   5. the new images uploaded (src/api/admin/uploads.js), then the whole
//      list PUT (the first is the main image; a group's images name its first
//      variant)
//   6. publish / unpublish (the server's POD gate and screening decide)
//   7. the product's own images it no longer uses removed (D93)
// Steps 4–7 run after the product is written: a failure there says so and
// sends the seller back to the list (the form's state no longer matches the
// server's), never into a second create.

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useAdminShop } from '../providers/ShopFeatures.jsx';
import {
  createProduct,
  createVariant,
  deleteVariant,
  getPodQuote,
  listAllProducts,
  publishProduct,
  replaceProductImages,
  unpublishProduct,
  updateProduct,
  updateVariant,
} from '../../api/admin/products.js';
import { deleteObject, uploadObject } from '../../api/admin/uploads.js';
import { deriveVariantsFromGroups } from '../../utils/variantDerivation';
import { skuFromName, uniqueSku } from '../../utils/productUrls';
import {
  LIMITS,
  desiredVariants,
  droppedObjectIds,
  imageList,
  planVariantSync,
  podFigures,
  productBodyProblem,
  productWriteBody,
  refusalMessage,
  repricedMixedGroups,
  sameImageList,
  screeningNoticeFor,
  strictestFigures,
  variantProblem,
} from '../adapters/product.js';

/** `is_pod` is set by the first print mapping (pod-mappings.ts); no product route writes it. */
export const POD_FLAG_EDITABLE = false;
/** `is_personalized` is never the seller's to set (D46): the studio's buyer flow sets it. */
export const PERSONALIZED_EDITABLE = false;
/** A takedown is reinstated by the platform's review (infringement reports), not by this form. */
export const TAKEDOWN_REINSTATE_IN_FORM = false;

/** Groups whose quote is asked for when the product has no product-level set. */
const GROUP_QUOTES_MAX = 20;

/** The first active variant of each group, in rail order (the unit a group's quote is asked for). */
function groupProbes(variants) {
  const seen = new Set();
  const probes = [];
  for (const v of [...(variants ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (v.active !== true) continue;
    const key = v.group == null ? `variant:${v.variantId}` : `group:${v.group}`;
    if (seen.has(key)) continue;
    seen.add(key);
    probes.push(v.variantId);
  }
  return probes;
}

/** The connection and the server's numbers for a saved POD product. */
async function quoteState(productId, variants, shopId) {
  const product = await getPodQuote(productId, { shopId });
  if (product) return { connected: true, figures: podFigures(product) };
  // No product-level set: the product is connected when every group has its own.
  const probes = groupProbes(variants);
  if (probes.length === 0 || probes.length > GROUP_QUOTES_MAX) return { connected: false, figures: null };
  const quotes = [];
  for (const variantId of probes) {
    const quote = await getPodQuote(productId, { variantId, shopId });
    if (!quote) return { connected: false, figures: null };
    quotes.push(quote);
  }
  return { connected: true, figures: strictestFigures(quotes) };
}

/**
 * The POD live-gate state and the server's numbers.
 * → { loaded, connected, floor, inkopKr, feeNote, profitAt, marginAt, suggestPrice, mappingSkus }
 */
export function useProductPod({ podEnabled, isPodProduct, product, shopId }) {
  const productId = product ? product.documentId || product.id || null : null;
  const key = podEnabled && isPodProduct && productId && shopId ? `${shopId}\n${productId}` : null;
  const [state, setState] = useState({ key: null, connected: false, figures: null });

  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    quoteState(productId, product?._server?.variants, shopId)
      .catch(() => ({ connected: false, figures: null })) // unreadable → fail closed (draft)
      .then((next) => {
        if (alive) setState({ key, ...next });
      });
    return () => {
      alive = false;
    };
    // The saved product's variants are fixed while the form is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = key !== null && state.key === key;
  const figures = current ? state.figures : null;
  return {
    loaded: key === null || current,
    connected: current && state.connected,
    floor: figures ? figures.floorKr : null,
    inkopKr: figures ? figures.inkopKr : null,
    // The server's floor holds the fee and the parcel; the page names no part of it.
    feeNote: '.',
    profitAt: () => null,
    marginAt: () => null,
    suggestPrice: null,
    mappingSkus: null,
  };
}

/** The save, bound to the shop's currency. Resolves { saved } as the older build's. */
export function useProductSave() {
  const { shop } = useAdminShop();
  const currency = shop?.currency || 'SEK';
  return useCallback((args) => saveProduct({ ...args, currency }), [currency]);
}

const lower = (s) => String(s ?? '').toLowerCase();

function withMessage(error, message) {
  if (error && typeof error === 'object' && message) error.userMessage = message;
  return error;
}

/** How many image rows the save would write (the server holds at most 30). */
function imageRowCount({ formData, mainImageFile, existingGallery, galleryFiles, editedGroups }) {
  const main = mainImageFile ? 1 : formData.b2cImageUrl ? 1 : 0;
  const gallery = new Set(existingGallery.filter((u) => u && u !== formData.b2cImageUrl)).size + galleryFiles.length;
  const groups = editedGroups.reduce((n, g) => n + g.images.length, 0);
  return main + gallery + groups;
}

async function saveProduct(args) {
  const { product, shopId, formData, mainImageFile, existingGallery, galleryFiles, editedGroups, price, compareAtPrice, podEnabled, pod, currency } = args;
  const server = product?._server ?? null;
  const objectIdByUrl = { ...(product?._objectIdByUrl ?? {}) };
  const ownId = product ? product.documentId || product.id : null;

  // 1. The SKU, unique in the shop (every product, archived ones too: the
  //    server keeps their skus).
  const shopProducts = await listAllProducts({ shopId });
  const takenSkus = shopProducts.filter((p) => p.productId !== ownId).map((p) => (p.sku || '').trim()).filter(Boolean);
  const requestedSku = args.resolvedSku;
  const resolvedSku = uniqueSku(requestedSku, takenSkus, product ? formData.sku || '' : '');
  if (resolvedSku !== requestedSku) {
    // Not silent: the operator may rely on the exact SKU externally.
    toast(`SKU "${requestedSku}" används redan av en annan produkt — sparas som "${resolvedSku}".`, { icon: '⚠️' });
  }

  // 2. What the API would refuse, said before anything is written.
  const { cleanGroups, cleanVariants } = deriveVariantsFromGroups(
    editedGroups.map((g) => ({ ...g, images: [] })),
    { productSku: resolvedSku, productPrice: price, skuFromName },
  );
  // Each row knows its group's price field, so a size whose own price differs
  // from the group's keeps it unless the seller changed the group's price.
  const desired = desiredVariants(cleanVariants, cleanGroups);
  const body = productWriteBody({ formData, sku: resolvedSku, price, compareAtPrice, create: !product, currency });
  const problem = productBodyProblem(body) ?? variantProblem(desired);
  if (problem) {
    toast.error(problem.message);
    return { saved: false };
  }
  if (imageRowCount(args) > LIMITS.images) {
    toast.error(`Högst ${LIMITS.images} bilder per produkt, variantbilderna inräknade.`);
    return { saved: false };
  }

  // 3. The product.
  let productId = ownId;
  let written;
  try {
    if (!product) {
      written = await createProduct(body, { shopId });
      productId = written?.productId;
      if (!productId) throw new Error('The create named no product');
    } else {
      written = await updateProduct(productId, body, { shopId });
    }
  } catch (error) {
    throw withMessage(error, refusalMessage(error, { step: 'product', moreInfo: body.moreInfo }));
  }

  // 4–7 run on a product that exists: a failure sends the seller back to the list.
  try {
    // 4. The variants.
    const railPriceOf = server?.railPriceOf ?? null;
    const plan = planVariantSync(server?.variants ?? [], desired, { railPriceOf });
    const repriced = repricedMixedGroups(plan, desired, railPriceOf);
    const variantIdBySku = new Map((server?.variants ?? []).map((v) => [lower(v.sku), v.variantId]));
    const labelOf = new Map((server?.variants ?? []).map((v) => [v.variantId, v.label]));
    const kept = [];
    for (const variantId of plan.deletes) {
      try {
        const { outcome } = await deleteVariant(productId, variantId, { shopId });
        if (outcome === 'deactivated') kept.push(labelOf.get(variantId) ?? '');
      } catch (error) {
        throw withMessage(error, refusalMessage(error, { step: 'variant', label: labelOf.get(variantId) }));
      }
    }
    for (const { variantId, sku, body: patch } of plan.updates) {
      const label = desired.find((d) => d.sku === sku)?.label;
      try {
        await updateVariant(productId, variantId, patch, { shopId });
      } catch (error) {
        throw withMessage(error, refusalMessage(error, { step: 'variant', label, sku }));
      }
      variantIdBySku.set(lower(sku), variantId);
    }
    for (const { sku, body: create } of plan.creates) {
      try {
        const variant = await createVariant(productId, create, { shopId });
        variantIdBySku.set(lower(sku), variant?.variantId);
      } catch (error) {
        throw withMessage(error, refusalMessage(error, { step: 'variant', label: create.label, sku }));
      }
    }
    if (kept.length > 0) {
      toast(`${kept.map((l) => `"${l}"`).join(', ')} finns på en order eller har en tryckkoppling och inaktiverades i stället för att tas bort.`, { icon: 'ℹ️', duration: 8000 });
    }
    if (repriced.length > 0) {
      toast(`Storlekarna i ${repriced.map((l) => `"${l}"`).join(', ')} hade olika priser och har nu alla variantens pris.`, { icon: 'ℹ️', duration: 8000 });
    }

    // 5. The images: the new files uploaded, then the whole list.
    const upload = async (file) => {
      try {
        const { objectId } = await uploadObject(file, { kind: 'product_media', shopId });
        return objectId;
      } catch (error) {
        throw withMessage(error, refusalMessage(error, { step: 'upload' }));
      }
    };
    const own = [];
    own.push(mainImageFile ? await upload(mainImageFile) : objectIdByUrl[formData.b2cImageUrl]);
    for (const url of existingGallery) own.push(objectIdByUrl[url]);
    for (const file of galleryFiles) own.push(await upload(file));
    const groupImages = [];
    for (let i = 0; i < editedGroups.length; i++) {
      const objectIds = [];
      for (const im of editedGroups[i].images) objectIds.push(im.url ? objectIdByUrl[im.url] : im.file ? await upload(im.file) : null);
      const firstRow = cleanVariants.find((row) => row.group === cleanGroups[i].label);
      const variantId = firstRow ? variantIdBySku.get(lower(firstRow.sku)) : null;
      if (variantId) groupImages.push({ objectIds: objectIds.filter(Boolean), variantId });
    }
    const list = imageList(own.filter(Boolean), groupImages);
    const before = server?.imageRows ?? [];
    const variantsWritten = plan.deletes.length + plan.updates.length + plan.creates.length > 0;
    if (!product || variantsWritten || !sameImageList(list, before)) {
      if (product || list.length > 0) {
        try {
          await replaceProductImages(productId, list, { shopId });
        } catch (error) {
          throw withMessage(error, refusalMessage(error, { step: 'images' }));
        }
      }
    }

    // 6. Status and publication.
    const gateClosed = podEnabled && formData.isPodProduct === true && !pod?.connected;
    const wantPublished = formData.isActive === true && formData.availability?.b2c !== false && !gateClosed;
    const isPublished = server?.published === true;
    let after = written;
    if (!product && formData.isActive === true) after = await updateProduct(productId, { status: 'active' }, { shopId });
    if (wantPublished && !isPublished && !product?.takedown) {
      try {
        after = await publishProduct(productId, { shopId });
      } catch (error) {
        const message = refusalMessage(error, { step: 'publish' });
        if (!message || error?.status !== 422) throw withMessage(error, message);
        toast(message, { icon: '🔒', duration: 10000 });
      }
    } else if (!wantPublished && isPublished && formData.isActive === true) {
      after = await unpublishProduct(productId, { shopId });
    }

    toast.success(product ? 'Produkt uppdaterad' : 'Produkt tillagd');

    if (formData.availability?.b2c !== false && gateClosed) {
      toast('Sparad som utkast — produkten visas i webbshoppen först när tryckkopplingen (med plagg valt) finns.', { icon: '🔒' });
    }
    // The server's screening verdict (the client screens nothing).
    const notice = wantPublished ? screeningNoticeFor(after?.screeningStatus) : null;
    if (notice) toast(notice, { icon: '⚠️', duration: 12000 });

    // 7. The product's own images it no longer uses (D93: removed everywhere).
    //    A variant's images are left for the sweep, as the older build left them.
    for (const objectId of droppedObjectIds(before.filter((row) => row.variantId == null), list)) {
      await deleteObject(objectId, { shopId }).catch((err) => console.error('Error deleting image:', err));
    }
    return { saved: true };
  } catch (error) {
    console.error('Error saving product:', error);
    const message = error?.userMessage || 'Allt kunde inte sparas.';
    toast.error(`${message} Det som hann sparas finns kvar — öppna produkten igen för att fortsätta.`, { duration: 12000 });
    return { saved: true };
  }
}
