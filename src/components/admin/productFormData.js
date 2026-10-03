// ProductForm's data layer — the OLDER build's implementation (Firebase).
//
// The form (ProductForm.jsx) reaches its data only through this module, so one
// form serves two builds: the older build (vite.config.js) uses this file as
// it is; the admin build (vite.admin.config.js) swaps it, by its alias list,
// for src/admin-app/replacements/productFormData.js (the API). Both files
// export the same names with the same meaning.
//
// Everything here is the form's former inline code (the POD live-gate state,
// the price floor and its tools, the save from the SKU check to the screening
// notice), moved and unchanged.

import { useState, useEffect } from 'react';
import { collection, doc, getDoc, addDoc, setDoc, updateDoc, serverTimestamp, deleteField, query, where, getDocs } from 'firebase/firestore';
import { ref, deleteObject } from 'firebase/storage';
import toast from 'react-hot-toast';
import { uploadImageToStorage } from '../../utils/imageUpload';
import { db, storage } from '../../firebase/config';
import { withShopId } from '../../config/withShopId';
import { listMappings } from '../../utils/podMappings';
import { priceFloor, sellerProfitInkl, sellerMargin, priceForMargin, roundUpTo9, inklMoms, FEE_RATE, FEE_FIXED } from '../../wagons/pod-wagon/podPricing';
import { skuFromName, uniqueSku } from '../../utils/productUrls';
import { deriveVariantsFromGroups } from '../../utils/variantDerivation';
import { screenProduct, screeningNotice } from '../../utils/contentScreening';
import { loadScreeningBlocklist } from '../../utils/loadContentScreening';

/** The "Print on demand-produkt" box is the seller's to set here. */
export const POD_FLAG_EDITABLE = true;
/** The "Specialtillverkad / personlig produkt" box is the seller's to set here. */
export const PERSONALIZED_EDITABLE = true;
/** A platform user re-activating a taken-down product in the form IS the reinstatement. */
export const TAKEDOWN_REINSTATE_IN_FORM = true;

// Coverage rule (matches the print pipeline's longest-prefix resolution): the
// PARENT sku's mapping is the fallback for every colour, so parent-mapped =
// fully covered. Without a parent row, EVERY variant-group sku must be mapped
// — one override row alone must never count as "connected" (P1 2026-08-15).
const podCoverage = (parentSku, groupSkus, mappingSkus) => {
  if (!mappingSkus) return false; // not loaded → fail closed
  if (parentSku && mappingSkus.has(parentSku)) return true;
  const groups = (groupSkus || []).filter(Boolean);
  return groups.length > 0 && groups.every((sku) => mappingSkus.has(sku));
};
// Only a mapping WITH a garment covers a sku: since SnapWear A4 a garment-less
// row routes to no printer and checkout refuses the line (409), so counting
// it would put a product live that can never be bought.
const routableMappingSkus = (mappings) =>
  new Set(mappings.filter((m) => m.garment).map((m) => m.sku).filter(Boolean));

/**
 * The POD live-gate state and the price figures of the form.
 * → { loaded, connected, floor, inkopKr, feeNote, profitAt, marginAt, suggestPrice, mappingSkus }
 */
export function useProductPod({ podEnabled, isPodProduct, product, shopId }) {
  // The SKUs that have a ROUTABLE print connection (a podMappings row with a
  // garment — routableMappingSkus above). null = not loaded yet.
  // Connection is checked against the SAVED product's SKUs (mappings key on what
  // is in the database, not on unsaved form edits).
  const [podMappingSkus, setPodMappingSkus] = useState(null);
  useEffect(() => {
    if (!podEnabled || !shopId) return;
    let alive = true;
    listMappings(shopId)
      .then((ms) => { if (alive) setPodMappingSkus(routableMappingSkus(ms)); })
      .catch(() => { if (alive) setPodMappingSkus(new Set()); });
    return () => { alive = false; };
  }, [podEnabled, shopId]);
  const podConnected = product
    ? podCoverage(
        product.sku,
        Array.isArray(product.variantGroups) ? product.variantGroups.map((g) => g?.sku) : [],
        podMappingSkus
      )
    : false;
  // Break-even price floor (podPricing.js) — computable when the Studio stamped
  // the template's cost on the product. Legacy POD products without the stamp
  // simply get no floor here (the Studio enforces it on their next publish).
  const podFloor = podEnabled && isPodProduct && Number.isFinite(product?.podCostSek)
    ? priceFloor(product.podCostSek)
    : null;
  return {
    loaded: podMappingSkus !== null,
    connected: podConnected,
    floor: podFloor,
    // podCostSek lagras EX moms (tryckeriets pris); säljaren ser alltid inkl.
    // moms (Mikael 2026-08-30).
    inkopKr: podFloor != null ? Math.round(inklMoms(product.podCostSek)) : null,
    feeNote: ` (avgift ${Math.round(FEE_RATE * 100)} % + ${FEE_FIXED} kr inräknad).`,
    profitAt: (price) => sellerProfitInkl(price, product?.podCostSek),
    marginAt: (price) => sellerMargin(price, product?.podCostSek),
    // Marginal → pris, samma verktyg som i Designstudion: målmarginalen ger ett
    // …9-pris som faktiskt GER den marginalen (priceForMargin är
    // avgiftsmedveten), aldrig under golvet.
    suggestPrice: (marginPct) => {
      const raw = priceForMargin(product.podCostSek, marginPct / 100);
      return raw == null ? null : Math.max(roundUpTo9(raw), podFloor);
    },
    mappingSkus: podMappingSkus,
  };
}

const deleteImageFromStorage = async (imageUrl) => {
  try {
    const url = new URL(imageUrl);
    const pathStart = url.pathname.indexOf('/o/') + 3;
    const pathEnd = url.pathname.indexOf('?');
    const storagePath = decodeURIComponent(url.pathname.substring(pathStart, pathEnd));
    await deleteObject(ref(storage, storagePath));
  } catch (err) {
    console.error('Error deleting image from storage:', err);
    // non-fatal — continue
  }
};

/**
 * The save, bound to the shop. → a function of the form's state that writes
 * the product and resolves `{ saved: true }`, or `{ saved: false }` when it
 * stopped with a message of its own (nothing for the form to add). It throws
 * on a failure; `error.userMessage`, when set, is the sentence to show.
 */
export function useProductSave() {
  return saveProduct;
}

async function saveProduct({
  product, shopId, formData, resolvedSku: requestedSku0, mainImageFile, existingGallery, galleryFiles,
  editedGroups, price, compareAtPrice, b2bPrice, b2bEnabled, podEnabled, pod, isPlatform,
}) {
  let resolvedSku = requestedSku0;
  const productId = product ? (product.documentId || product.id || formData.id) : `prod_${Date.now()}`;

  // Enforce per-shop SKU uniqueness (collision = two products on one URL /
  // cart line). Load this shop's existing SKUs and de-dupe, excluding this
  // product's own current SKU when editing.
  const skuSnap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId)));
  const takenSkus = [];
  skuSnap.forEach((docSnap) => {
    if (docSnap.id === productId) return; // ignore self (edit)
    const s = (docSnap.data().sku || '').trim();
    if (s) takenSkus.push(s);
  });
  const requestedSku = resolvedSku;
  resolvedSku = uniqueSku(resolvedSku, takenSkus, product ? (formData.sku || '') : '');
  if (resolvedSku !== requestedSku) {
    // Not silent: the operator may rely on the exact SKU externally.
    toast(`SKU "${requestedSku}" används redan av en annan produkt — sparas som "${resolvedSku}".`, { icon: '⚠️' });
  }

  // Resolve images.
  let mainImageUrl = formData.b2cImageUrl;
  if (mainImageFile) {
    mainImageUrl = await uploadImageToStorage(mainImageFile, `products/${shopId}/${productId}`, 'b2c_main');
  }

  let gallery = [...existingGallery];
  for (let i = 0; i < galleryFiles.length; i++) {
    const u = await uploadImageToStorage(galleryFiles[i], `products/${shopId}/${productId}`, `b2c_gallery_${Date.now()}_${i}`);
    gallery.push(u);
  }
  // Orphan sweep: delete every image the product ARRIVED with that survives
  // in neither the final gallery nor the final main image. Resolving here
  // (instead of queueing on each remove click) is what makes re-picking the
  // huvudbild safe in both directions — promoting a gallery image rescues
  // it, and replacing the old huvudbild collects it.
  const keptUrls = new Set([...gallery, mainImageUrl, formData.imageUrl].filter(Boolean));
  const originalUrls = [
    product?.b2cImageUrl,
    product?.imageUrl,
    ...(Array.isArray(product?.b2cImageGallery) ? product.b2cImageGallery : []),
  ].filter(Boolean);
  for (const url of new Set(originalUrls)) {
    if (!keptUrls.has(url)) await deleteImageFromStorage(url);
  }

  // Resolve each group's images first (the one async step: upload pending
  // files in list order, keep already-uploaded URLs), then hand the
  // resolved groups to the shared PURE derivation so this and the Design
  // Studio publish wizard produce byte-identical rows. Money paths key on
  // the row sku — see utils/variantDerivation.js.
  const resolvedGroups = [];
  for (const g of editedGroups) {
    const label = g.label.trim();
    const images = [];
    for (let i = 0; i < g.images.length; i++) {
      const im = g.images[i];
      if (im.url) {
        images.push(im.url);
      } else if (im.file) {
        images.push(await uploadImageToStorage(im.file, `products/${shopId}/${productId}`, `variant_${skuFromName(label)}_${i}`));
      }
    }
    resolvedGroups.push({ ...g, images });
  }
  const { cleanGroups, cleanVariants } = deriveVariantsFromGroups(resolvedGroups, {
    productSku: resolvedSku,
    productPrice: price,
    skuFromName,
  });

  // POD LIVE-GATE, decided on the SKUs BEING SAVED (P1 fix 2026-08-15: the
  // render-time check uses the SAVED sku, so editing the SKU could carry a
  // stale "connected" verdict onto skus the Print Queue will never find).
  // Mappings are fetched fresh if the initial load hasn't landed.
  let podConnectedFinal = false;
  if (podEnabled && formData.isPodProduct === true) {
    let mappingSkus = pod.mappingSkus;
    if (mappingSkus === null) {
      try {
        mappingSkus = routableMappingSkus(await listMappings(shopId));
      } catch {
        mappingSkus = new Set(); // unreadable → fail closed (draft)
      }
    }
    podConnectedFinal = podCoverage(resolvedSku, cleanGroups.map((g) => g?.sku), mappingSkus);
  }
  const hasVariants = cleanVariants.length > 0;

  // Build the persisted doc. Single price → BOTH consumer-price fields.
  const data = {
    name: formData.name,            // plain string going forward
    sku: resolvedSku,               // guaranteed non-empty + per-shop-unique
    category: formData.category,    // browse taxonomy / URL driver (was `group`)
    tags: formData.tags,
    hasVariants,
    variantGroups: cleanGroups,
    // v2.1 options-matrix is superseded by the rail — cleared on save so
    // the storefront renders the grouped picker for re-saved products.
    options: [],
    variants: cleanVariants,
    b2cPrice: price,
    basePrice: price,               // keep in sync for the `b2cPrice || basePrice` fallback
    compareAtPrice,                 // was-price for a REA (0 = not on sale)
    // Wholesale price — only written for B2B shops (a non-B2B shop's
    // products never gain the field). NOT folded into base/b2cPrice.
    ...(b2bEnabled ? { b2bPrice } : {}),
    isActive: formData.isActive,
    // Always written so the boolean supersedes the legacy `featured` tag.
    featured: formData.featured === true,
    imageUrl: mainImageUrl || formData.imageUrl || '',
    b2cImageUrl: mainImageUrl || '',
    b2cImageGallery: gallery,
    // POD marker — always written so unchecking persists.
    isPodProduct: formData.isPodProduct === true,
    availability: {
      // LIVE-GATE (enforced at save, not only in the UI): an unconnected POD
      // product is never written live. podMappingSkus === null (load raced
      // the save) counts as unconnected — fail CLOSED, the seller can re-save
      // once the connection exists.
      b2c: formData.availability.b2c !== false
        && !(podEnabled && formData.isPodProduct === true && !podConnectedFinal),
      // Only carry the b2b availability flag for B2B shops, so a non-B2B
      // shop's products never gain a stray key.
      ...(b2bEnabled ? { b2b: formData.availability.b2b !== false } : {}),
    },
    descriptions: {
      b2c: formData.descriptions.b2c || '',
      b2cMoreInfo: formData.descriptions.b2cMoreInfo || '',
    },
    // Right-of-withdrawal (POD): always written so toggling OFF persists
    // (a product can move from personalized → standard). Size guide is
    // free text; empty string when unset.
    isPersonalized: formData.isPersonalized === true,
    sizeGuide: formData.sizeGuide || '',
    weight: formData.weight,
    dimensions: formData.dimensions,
    shipping: formData.shipping,
    // Per-product delivery modes (validated above: at least one is true).
    delivery: { shipping: !!formData.delivery?.shipping, pickup: !!formData.delivery?.pickup },
    updatedAt: serverTimestamp(),
  };

  if (formData.launchDate) data.launchDate = new Date(formData.launchDate);

  if (!product) {
    data.createdAt = serverTimestamp();
    await addDoc(collection(db, 'products'), withShopId(data, shopId));
    toast.success('Produkt tillagd');
  } else {
    if (!productId || !String(productId).trim()) {
      toast.error('Fel: Produkt-ID saknas. Ladda om sidan.');
      return { saved: false };
    }
    const docRef = doc(db, 'products', productId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      // Platform reinstatement of a taken-down product: clear the stamp
      // (and take it out of the review queue's taken_down state) so the
      // seller owns the isActive toggle again. Only ever for platform —
      // the rules reject both keys from a shop admin.
      const reinstate = isPlatform && snap.data().takedown && formData.isActive === true
        ? {
            takedown: deleteField(),
            ...(snap.data().screening?.status === 'taken_down' ? { 'screening.status': 'cleared' } : {}),
          }
        : {};
      await updateDoc(docRef, { ...data, ...reinstate });
    } else {
      await setDoc(docRef, withShopId({ ...data, createdAt: serverTimestamp() }, shopId));
    }
    toast.success('Produkt uppdaterad');
  }

  if (formData.availability.b2c !== false && podEnabled && formData.isPodProduct === true && !podConnectedFinal) {
    toast('Sparad som utkast — produkten visas i webbshoppen först när tryckkopplingen (med plagg valt) finns.', { icon: '🔒' });
  }

  // Brand screening notice (SnapWear A11) for a product that is going
  // live. Advisory only — the save already happened; the server trigger
  // stamps `screening` and the platform reviews (the client never writes it).
  if (data.isActive === true && data.availability.b2c === true) {
    const hits = screenProduct(data, await loadScreeningBlocklist());
    if (hits.length > 0) toast(screeningNotice(hits), { icon: '⚠️', duration: 12000 });
  }
  return { saved: true };
}
