// studioData.js — the design studio's Firebase work, for the OLDER build
// (src/App.jsx, vite.config.js). Moved UNCHANGED out of DesignStudio.jsx
// (CP5 unit FN1) so the Cloudflare admin's build can put its own module in
// this one's place (vite.admin.config.js: src/admin-app/replacements/
// podStudioData.js), and DesignStudio.jsx itself imports no Firebase.
//
// The two functions hold the publish and the update-existing bodies exactly
// as they were in the component; the component's state they read arrives in
// `ctx` (DesignStudio studioContext) and the panel's form in `form`, under the
// same names, and the state setters they called become the outcome:
//   → { result } (the studio sets it and refreshes the library)
//   → { error }  (the studio shows it)
// The validation before them, the in-flight latch and `publishing` stay in
// the component, as before.
import { collection, addDoc, getDocs, query, where, serverTimestamp, doc, getDoc, updateDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from '../../../firebase/config';
import { withShopId } from '../../../config/withShopId';
import { skuFromName, uniqueSku } from '../../../utils/productUrls';
import { deriveVariantsFromGroups } from '../../../utils/variantDerivation';
import { setMapping } from '../../../utils/podMappings';
import { priceFloor } from '../podPricing';
import { orderedVariantMockupUrls } from './mockupVariantImages';
import { screenProduct } from '../../../utils/contentScreening';
import { loadScreeningBlocklist } from '../../../utils/loadContentScreening';
import { garmentOfTemplate } from '../../../config/podMockupTemplates';
import { placementReadout, containPlacement } from './placementMath';
import { pocketPositionLabel } from '../../../config/podSlots';

// What this build's studio does (the Cloudflare admin's module answers
// differently: src/admin-app/replacements/podStudioData.js).
export const STUDIO_FLAGS = Object.freeze({
  /** The seller drags and resizes a print (and picks the pocket position). */
  placementEditable: true,
  /** Every template is offered while no printer is known (pre-seed, dev harness). */
  offerUnrouted: true,
  /** The seller picks the printer and model when several make the garment (the platform routes here). */
  sellerChoosesProduction: false,
  /** The editor is locked while a save runs. */
  lockWhileSaving: false,
  /** The 3D view. */
  studio3d: true,
});

// The texts this build keeps as they were (null = the studio's own copy).
export const STUDIO_TEXT = Object.freeze({
  placementIntro: null,
  pocketNote: null,
  canvasLockedNote: null,
  no3d: null,
  productionLabel: null,
});

// Publish/update refuse to write when the server cost quote could not be
// fetched (A13) — see freshQuoteFor. (Moved with the bodies that use it.)
const QUOTE_FAILED_MSG = 'Produktionskostnaden kunde inte hämtas. Kontrollera anslutningen och försök igen.';

/**
 * The placement of a LOCKED slot (the pocket here): the artwork contain-fit
 * in the slot's area, capped at the template profile's DPI floor, centred —
 * exactly what the studio computed before (placementMath containPlacement).
 * The Cloudflare admin's module sizes it as its server does instead.
 */
export const lockedPlacement = (template, slot, artwork, { profile } = {}) =>
  containPlacement(template, slot, artwork, profile?.min_dpi ?? null);

const NO_ENV = Object.freeze({});
/** What the studio needs of the shop for a publish: nothing in this build. */
export const useStudioEnv = () => NO_ENV;

// ── PUBLISH (slice 4) ───────────────────────────────────────────────────
// Turn the generated mockups into a real, immediately-sellable product +
// variants + POD mappings. PublishPanel is presentational and calls this with
// the operator's picks; ALL Firebase work lives here (studio owns the state).
//
// Write order (mirrors ProductForm's save path where they overlap):
//   validate → resolve per-shop-unique sku → upload hero + every mockup blob to
//   the PUBLIC product path (the pod-artwork drafts are admin-read-only) → build
//   resolved variant groups (selected colourways, per-colourway FRONT mockup as
//   primary + BACK as secondary, chosen sizes, explicit per-row price or '') →
//   deriveVariantsFromGroups → build the product doc EXACTLY like ProductForm →
//   addDoc → setMapping parent rows (one per designed slot) → setMapping override
//   rows (one per slot×overridden-colourway) → success.
//
// NO rollback: if a later step fails after the doc was created, we surface an
// honest "created but images/mappings may be incomplete" message.
const uploadBlobToPublicPath = async (objectUrl, type, path, name) => {
  // Object URLs are same-session; fetch the blob and upload it RAW (it is already
  // a rendered WebP/PNG — no compression pipeline, matching mockupUpload.js).
  const blob = await (await fetch(objectUrl)).blob();
  const snap = await uploadBytes(storageRef(storage, `${path}/${name}`), blob, { contentType: type });
  return getDownloadURL(snap.ref);
};

export async function publishDesign(ctx, { name, price, selectedColorwayIds, sizesByColorway, perColorwayPrices }) {
  const {
    shopId, selectedTemplate, effTemplate, overrides, mockups, heroKey, pocketPosition, publishSlots,
    printArtwork, artworkById, effectivePlacementFor, labelForSlot, freshQuoteFor, publishedArtworkNames,
  } = ctx;
  // As the studio's validation computed them before this call.
  const cleanName = (name || '').trim();
  const productPrice = parseFloat(price) || 0;
  const selectedSet = new Set(selectedColorwayIds || []);
  let outcome = null;
  const setPublishError = (error) => { outcome = { error }; };
  const setPublishResult = (result) => { outcome = { result }; };
  const setPublishing = () => {}; // the studio owns the flag
  const onChanged = null; // the studio refreshes the library on a result
  await (async () => {
    let docCreated = false;
    try {
      const stampQuote = await freshQuoteFor(publishSlots);
      // A FAILED quote is not "unpriced": creating the product now would skip
      // the price floor and stamp no cost. Nothing is written yet — refuse.
      if (stampQuote.failed) throw new Error(QUOTE_FAILED_MSG);
      // PRISGOLV — authoritative re-check in the handler (the UI enforces it
      // too, but the handler is the gate that actually creates a sellable
      // product; podPricing.js is the single formula source).
      {
        // Same cost basis as the stamp below and as PublishPanel's readout: the
        // DESIGNED slots decide the print cost, so the gate can't enforce a
        // cheaper floor than the one the seller was just shown. Re-quoted just
        // above (fresh) and reused for the stamp, so gate and stamp are one number.
        const costP = stampQuote.costSek;
        const floorP = costP != null ? priceFloor(costP) : null;
        if (floorP != null) {
          if (!(parseFloat(price) >= floorP)) {
            throw new Error(`Priset måste vara minst prisgolvet ${floorP} kr — under det tjänar säljaren 0 kr.`);
          }
          const lowCw = Object.values(perColorwayPrices || {})
            .filter((v) => String(v).trim() !== '')
            .map((v) => parseFloat(v))
            .filter((n) => Number.isFinite(n) && n < floorP);
          if (lowCw.length > 0) {
            throw new Error(`Ett färgpris ligger under prisgolvet ${floorP} kr.`);
          }
        }
      }
      // 1. Resolve a per-shop-UNIQUE sku (same logic as ProductForm).
      const requestedSku = skuFromName(cleanName);
      const skuSnap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId)));
      const takenSkus = [];
      skuSnap.forEach((d) => { const s = (d.data().sku || '').trim(); if (s) takenSkus.push(s); });
      const resolvedSku = uniqueSku(requestedSku, takenSkus);

      // 2. Upload the hero + mockup blobs to the PUBLIC product image path — ONLY
      // for the SELECTED colourways: an unchecked colourway must not appear in the
      // product gallery (it isn't sellable — showing it would be a surprise).
      // productId is the STORAGE path id only (the Firestore doc id comes from
      // addDoc — they differ by design, same as ProductForm).
      const pubMockups = mockups.filter((m) => selectedSet.has(m.colorwayId));
      if (pubMockups.length === 0) {
        setPublishError('Inga mockuper för de valda färgerna — generera om.');
        setPublishing(false);
        return;
      }
      const productId = `prod_${Date.now()}`;
      const publicPath = `products/${shopId}/${productId}`;
      // Hero must be a PUBLISHED colourway's mockup; fall back to the first one.
      const hero = pubMockups.find((m) => m.key === heroKey) || pubMockups[0];

      const heroUrl = await uploadBlobToPublicPath(hero.objectUrl, hero.type, publicPath, 'b2c_main');

      // Upload the published mockups (in mockups-array order → gallery order).
      // Parallel uploads — Promise.all preserves input order, so galleryUrls[i]
      // still corresponds to pubMockups[i] (the index-join below depends on it).
      const galleryUrls = await Promise.all(pubMockups.map((m) =>
        uploadBlobToPublicPath(m.objectUrl, m.type, publicPath, `mockup_${m.colorwayId}_${m.slot}`)
      ));
      // 3. Build resolved variant groups — one per SELECTED colourway. Front is
      // primary and the matching back is secondary when both were designed.
      const colorwayLabel = (id) =>
        (selectedTemplate?.colorways || []).find((c) => c.id === id)?.label || id;
      // publishedIds order defines resolvedGroups order — and the derivation
      // processes groups 1:1 in order, so cleanGroups[i] ↔ publishedIds[i].
      // That index join (not labels) keys the override→group-sku lookup below.
      const publishedIds = (selectedColorwayIds || []).filter((id) => selectedSet.has(id));
      const resolvedGroups = publishedIds
        .map((id) => {
          const images = orderedVariantMockupUrls({
            colorwayId: id, mockups: pubMockups, urls: galleryUrls, fallbackUrl: heroUrl,
          });
          const explicit = (perColorwayPrices?.[id] ?? '').toString().trim();
          return {
            label: colorwayLabel(id),
            sku: '',                                   // auto-derive from product sku + label
            price: explicit === '' ? '' : explicit,    // '' inherits the product price
            images,
            sizes: sizesByColorway?.[id] || [],
          };
        });

      // 4. Derive the cleaned rail + sellable rows (byte-identical to ProductForm).
      const { cleanGroups, cleanVariants } = deriveVariantsFromGroups(resolvedGroups, {
        productSku: resolvedSku,
        productPrice,
        skuFromName,
      });
      const hasVariants = cleanVariants.length > 0;

      // 5. POD mappings — written BEFORE the product doc goes live (P1 fix
      // 2026-08-15: the old order created a LIVE product first and connected it
      // after; a failed mapping write left a live-but-unprintable product. This
      // order can at worst leave orphan mapping rows for a product that was
      // never created — harmless, visible in Avancerat, overwritten on retry).
      // PARENT row per DESIGNED slot: keyed on the product sku,
      // its placement is the cm readout of the slot's EFFECTIVE placement (stored
      // placement, else the compositor default). The print pipeline resolves
      // longest-prefix within a slot, so per-colourway group-sku rows override the
      // parent for that colourway's sizes.
      // Group sku per COLORWAY ID (index-aligned with publishedIds) — an id join,
      // not a label join, so duplicate colorway labels can never cross-target.
      const groupSkuByColorwayId = new Map(publishedIds.map((id, i) => [id, cleanGroups[i]?.sku]));
      // All mapping rows in PARALLEL: every setMapping call targets a distinct
      // upsert key (shopId, sku, slot) — parent rows use the product sku,
      // override rows a group sku — so the read-then-write upserts can't race
      // each other. Was a serial O(slots × colorways) round-trip chain.
      const mappingWrites = [];
      // The garment this design is printed on — persisted per mapping row so
      // the print pipeline can route the production line to the printer that
      // makes this garment. null (unknown template) → the default printer.
      const publishGarment = garmentOfTemplate(selectedTemplate);
      for (const s of publishSlots) {
        const baseArt = printArtwork(s);
        const effective = effectivePlacementFor(s, baseArt);
        const readout = placementReadout(effective, effTemplate, s, baseArt);
        const isPocket = s === 'pocket';
        const posLabel = pocketPositionLabel(pocketPosition);
        mappingWrites.push(setMapping({
          shopId,
          sku: resolvedSku,
          artworkId: baseArt.id,
          profileId: selectedTemplate.profileId,
          garment: publishGarment,
          slotLabel: labelForSlot(s),
          // Pocket rows carry the discrete position FIRST — that's the printer's
          // primary instruction for this slot ("Ficka — Vänster · 2 cm uppifrån…").
          placement: isPocket ? `${posLabel} · ${readout}` : readout,
          placementSlot: s,
          ...(isPocket ? { position: pocketPosition } : {}),
        }));

        // OVERRIDE row per (designed slot, colourway that has an override AND is
        // published): targets that colourway's GROUP sku so it wins over the parent.
        const slotOverrides = overrides[s] || {};
        for (const [cwId, overrideArtworkId] of Object.entries(slotOverrides)) {
          if (!overrideArtworkId || !selectedSet.has(cwId)) continue;
          const groupSku = groupSkuByColorwayId.get(cwId);
          if (!groupSku) continue;
          const overrideArt = artworkById(overrideArtworkId) || printArtwork(s);
          const effectiveO = effectivePlacementFor(s, overrideArt);
          const readoutO = placementReadout(effectiveO, effTemplate, s, overrideArt);
          mappingWrites.push(setMapping({
            shopId,
            sku: groupSku,
            artworkId: overrideArtworkId,
            profileId: selectedTemplate.profileId,
            garment: publishGarment,
            slotLabel: labelForSlot(s),
            placement: isPocket ? `${posLabel} · ${readoutO}` : readoutO,
            placementSlot: s,
            ...(isPocket ? { position: pocketPosition } : {}),
          }));
        }
      }
      await Promise.all(mappingWrites);

      // 6. Build the product doc EXACTLY like ProductForm (studio-relevant field
      // set). Single price → BOTH b2cPrice + basePrice. Empty weight/dimensions/
      // shipping shapes copied verbatim from ProductForm's emptyForm.
      // Prices are stored INKL. moms (see STORE.vatRate — VAT is display-only in
      // the Publish step's profit columns, not applied to the stored number).
      const data = {
        name: cleanName,
        sku: resolvedSku,
        category: '',
        tags: [],
        hasVariants,
        variantGroups: cleanGroups,
        options: [],
        variants: cleanVariants,
        b2cPrice: productPrice,
        basePrice: productPrice,          // keep in sync for the `b2cPrice || basePrice` fallback
        isActive: true,
        featured: false,
        imageUrl: heroUrl,
        b2cImageUrl: heroUrl,
        b2cImageGallery: galleryUrls,
        availability: { b2c: true },
        descriptions: { b2c: '', b2cMoreInfo: '' },
        // LEGAL FIREWALL: studio-authored products are NEVER personalized. The
        // 14-day withdrawal right stays; isPersonalized is order-flow-derived only.
        isPersonalized: false,
        // POD marker + economics: lets the product form gate "live" on a print
        // connection and compute the break-even price floor (podPricing.js)
        // without loading the template. The cost is computed from the DESIGNED
        // slots — plagg + ett tryckpris per tryckt yta + plattformsuttaget — så
        // fram+bak stämplar mer än bara fram.
        isPodProduct: true,
        // podPrinterUid records WHICH printer the frozen cost was quoted for, so
        // the product form and any later audit can see the basis without
        // re-resolving today's routing — rerouting must never silently restate
        // an existing product's economics. podCostSek is the ONE quoted number
        // (A13); nothing here says how it is made up.
        ...(stampQuote.costSek != null
          ? { podCostSek: stampQuote.costSek, podPrinterUid: stampQuote.printerUid }
          : {}),
        sizeGuide: '',
        weight: { value: 0, unit: 'g' },
        dimensions: {
          length: { value: 0, unit: 'mm' },
          width: { value: 0, unit: 'mm' },
          height: { value: 0, unit: 'mm' },
        },
        shipping: {
          sweden: { cost: 0, service: 'Standard' },
          nordic: { cost: 0, service: 'Nordic' },
          eu: { cost: 0, service: 'EU' },
          worldwide: { cost: 0, service: 'International' },
        },
        delivery: { shipping: true, pickup: true },
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      };
      await addDoc(collection(db, 'products'), withShopId(data, shopId));
      docCreated = true;

      // Brand screening notice (A11). Advisory only: publishing is NOT blocked
      // (that would just invite renaming around the list); the server trigger
      // stamps `screening` and the platform reviews. The client never writes it.
      const screeningHits = screenProduct(
        data,
        await loadScreeningBlocklist(),
        publishedArtworkNames(publishSlots, selectedSet),
      );

      setPublishResult({ name: cleanName, sku: resolvedSku, screeningHits });
      onChanged?.();
    } catch (e) {
      console.error('DesignStudio: publish failed', e);
      setPublishError(
        docCreated
          ? 'Produkten skapades men bilder/kopplingar kan vara ofullständiga — kontrollera under Produkter.'
          : (e?.message || 'Publiceringen misslyckades.')
      );
    }
  })();
  return outcome;
}

export async function updateProductFromDesign(ctx, { productId, selectedColorwayIds, replaceImages }) {
  const {
    shopId, selectedTemplate, effTemplate, overrides, mockups, heroKey, pocketPosition, publishSlots,
    printArtwork, artworkById, effectivePlacementFor, labelForSlot, freshQuoteFor, publishedArtworkNames,
  } = ctx;
  // As the studio's validation computed them before this call.
  const selectedSet = new Set(selectedColorwayIds || []);
  const pubMockups = mockups.filter((m) => selectedSet.has(m.colorwayId));
  let outcome = null;
  const setPublishError = (error) => { outcome = { error }; };
  const setPublishResult = (result) => { outcome = { result }; };
  const onChanged = null; // the studio refreshes the library on a result
  await (async () => {
    let docTouched = false;
    try {
      // Fresh authoritative read — the library listing is a projection and the
      // doc may have changed since it loaded.
      const prodRef = doc(db, 'products', productId);
      const prodSnap = await getDoc(prodRef);
      if (!prodSnap.exists()) throw new Error('Produkten finns inte längre.');
      const prod = prodSnap.data();
      if (prod.shopId !== shopId) throw new Error('Produkten tillhör en annan butik.');
      if (!String(prod.sku || '').trim()) {
        throw new Error('Produkten saknar SKU. Ge den en unik SKU under Produkter innan du fortsätter.');
      }
      // A mapping is keyed by SKU. Two products sharing one SKU would also share
      // one artwork in Printkön, violating the studio's product-specific contract.
      // Re-check authoritatively at submit time; the picker data may be stale.
      const productSnap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId)));
      const duplicateSku = productSnap.docs.some((d) =>
        d.id !== productId && String(d.data()?.sku || '').trim() === String(prod.sku).trim());
      if (duplicateSku) {
        throw new Error(`SKU ”${prod.sku}” används av flera produkter. Ge varje produkt en unik SKU under Produkter.`);
      }
      const norm = (x) => String(x || '').trim().toLowerCase();
      const groupSkuByLabel = new Map(
        (Array.isArray(prod.variantGroups) ? prod.variantGroups : [])
          .filter((g) => g?.sku && g?.label)
          .map((g) => [norm(g.label), g.sku])
      );
      const cwLabelOf = (id) =>
        (selectedTemplate?.colorways || []).find((c) => c.id === id)?.label || null;
      // A colour-specific motif must have an exact variant-group target. Block
      // before uploads rather than publish a mockup that differs from Printkön.
      const missingOverrideLabels = new Set();
      for (const s of publishSlots) {
        for (const [cwId, overrideArtworkId] of Object.entries(overrides[s] || {})) {
          if (!overrideArtworkId || !selectedSet.has(cwId)) continue;
          if (!groupSkuByLabel.has(norm(cwLabelOf(cwId)))) {
            missingOverrideLabels.add(cwLabelOf(cwId) || cwId);
          }
        }
      }
      if (missingOverrideLabels.size > 0) {
        throw new Error(`Motivet för ${[...missingOverrideLabels].join(', ')} kan inte kopplas eftersom färgnamnet saknas på produkten. Uppdatera produktens färger eller skapa en ny produkt.`);
      }
      // No PRISGOLV gate here: updating an existing product only refreshes
      // mockup images/artwork. Pricing is owned by the Products page —
      // ProductForm blocks any save below the floor (podPricing.js).
      // costU is still needed to stamp podCostSek on the product below — a
      // FRESH server quote (A13), never the memoised one the panel showed.
      const { costSek: costU, printerUid: printerUidU, failed: quoteFailedU } = await freshQuoteFor(publishSlots);
      if (quoteFailedU) throw new Error(QUOTE_FAILED_MSG); // before any upload/write
      const publicPath = `products/${shopId}/${productId}`;
      const hero = pubMockups.find((m) => m.key === heroKey) || pubMockups[0];
      // 'studio_' prefix + deterministic (colorway, slot) names: re-running the
      // update replaces this flow's own files instead of accumulating copies.
      const galleryUrls = await Promise.all(pubMockups.map((m) =>
        uploadBlobToPublicPath(m.objectUrl, m.type, publicPath, `studio_${m.colorwayId}_${m.slot}`)
      ));
      const heroUrl = galleryUrls[pubMockups.indexOf(hero)];

      // Gallery merge deduped on storage PATH — download tokens differ between
      // uploads of the same object, so URL equality would stack duplicates.
      const pathOf = (u) => { try { return new URL(u).pathname; } catch { return u; } };
      const existingGallery = Array.isArray(prod.b2cImageGallery) ? prod.b2cImageGallery : [];
      const keptGallery = existingGallery.filter((u) => !galleryUrls.some((n) => pathOf(n) === pathOf(u)));
      const updates = {
        b2cImageGallery: [...keptGallery, ...galleryUrls],
        updatedAt: serverTimestamp(),
      };
      // Main image: fill when missing; replace only on explicit opt-in.
      const hasMain = Boolean(prod.imageUrl || prod.b2cImageUrl);
      if (!hasMain || replaceImages) {
        updates.imageUrl = heroUrl;
        updates.b2cImageUrl = heroUrl;
      }

      // Variant-group images on EXACT label matches (case-insensitive):
      // fill empty groups always, replace populated ones only on opt-in.
      const variantUrlsByLabel = {};
      for (const id of selectedSet) {
        const label = cwLabelOf(id);
        if (!label) continue;
        variantUrlsByLabel[norm(label)] = orderedVariantMockupUrls({
          colorwayId: id, mockups: pubMockups, urls: galleryUrls, fallbackUrl: heroUrl,
        });
      }
      // NOTE both `image` AND `images` must be written: the storefront card
      // reads g.image / v.image, the product page reads variant.images — the
      // persisted shape carries both (variantDerivation CleanGroup/VariantRow).
      // The change must also propagate to the sellable variants[] rows, which
      // hold their own copies (joined by `group` = the group's label).
      if (Array.isArray(prod.variantGroups) && prod.variantGroups.length) {
        const updatedUrlByLabel = {};
        let changed = false;
        const groups = prod.variantGroups.map((g) => {
          const urls = variantUrlsByLabel[norm(g?.label)];
          if (!urls?.length) return g;
          const has = Array.isArray(g.images) ? g.images.length > 0 : Boolean(g.image);
          if (has && !replaceImages) return g;
          changed = true;
          updatedUrlByLabel[norm(g.label)] = urls;
          const rest = Array.isArray(g.images)
            ? g.images.slice(1).filter((u) => !urls.some((url) => pathOf(u) === pathOf(url)))
            : [];
          return { ...g, image: urls[0], images: [...urls, ...rest] };
        });
        if (changed) {
          updates.variantGroups = groups;
          if (Array.isArray(prod.variants) && prod.variants.length) {
            updates.variants = prod.variants.map((v) => {
              const urls = updatedUrlByLabel[norm(v?.group)];
              if (!urls?.length) return v;
              const rest = Array.isArray(v.images)
                ? v.images.slice(1).filter((u) => !urls.some((url) => pathOf(u) === pathOf(url)))
                : [];
              return { ...v, image: urls[0], images: [...urls, ...rest] };
            });
          }
        }
      }

      // KNOWN WINDOW: getDoc → uploads → updateDoc is a seconds-long
      // read-modify-write; a concurrent ProductForm save in that window loses
      // its group edits to this snapshot. Accepted for v1 (single-admin shops).
      // Automatic print connection — written BEFORE the product doc is touched
      // (P1 fix 2026-08-15: mapping-write failure must abort with the product
      // unchanged, never leave updated images/stamps on a broken connection).
      // Identical mapping rows to the create flow, keyed on
      // the product's OWN sku; override rows target group skus whose label
      // EXACTLY matches the overridden colourway's label (decision 2026-08-09:
      // exact matches only, nothing fuzzy).
      const writes = [];
      // Same routing key as the create path — the garment this design prints on.
      const updateGarment = garmentOfTemplate(selectedTemplate);
      for (const s of publishSlots) {
        const baseArt = printArtwork(s);
        const effective = effectivePlacementFor(s, baseArt);
        const readout = placementReadout(effective, effTemplate, s, baseArt);
        const isPocket = s === 'pocket';
        const posLabel = pocketPositionLabel(pocketPosition);
        writes.push(setMapping({
          shopId,
          sku: prod.sku,
          artworkId: baseArt.id,
          profileId: selectedTemplate.profileId,
          garment: updateGarment,
          slotLabel: labelForSlot(s),
          placement: isPocket ? `${posLabel} · ${readout}` : readout,
          placementSlot: s,
          ...(isPocket ? { position: pocketPosition } : {}),
        }));
        const slotOverrides = overrides[s] || {};
        for (const [cwId, overrideArtworkId] of Object.entries(slotOverrides)) {
          if (!overrideArtworkId || !selectedSet.has(cwId)) continue;
          const gSku = groupSkuByLabel.get(norm(cwLabelOf(cwId)));
          if (!gSku) continue; // preflight above blocks this mismatch
          const overrideArt = artworkById(overrideArtworkId) || printArtwork(s);
          const effO = effectivePlacementFor(s, overrideArt);
          const readoutO = placementReadout(effO, effTemplate, s, overrideArt);
          writes.push(setMapping({
            shopId,
            sku: gSku,
            artworkId: overrideArtworkId,
            profileId: selectedTemplate.profileId,
            garment: updateGarment,
            slotLabel: labelForSlot(s),
            placement: isPocket ? `${posLabel} · ${readoutO}` : readoutO,
            placementSlot: s,
            ...(isPocket ? { position: pocketPosition } : {}),
          }));
        }
      }
      await Promise.all(writes);

      // Same POD stamps as the create path — an existing product that gets a
      // studio design IS a POD product from now on. costU (the fresh server
      // quote above) is the DESIGNED-slot cost as ONE number — fram+bak
      // stämplar mer än bara fram.
      updates.isPodProduct = true;
      if (costU != null) { updates.podCostSek = costU; updates.podPrinterUid = printerUidU; }
      await updateDoc(prodRef, updates);
      docTouched = true;



      // Same advisory brand-screening notice as the create path (A11): the
      // product's existing text + the motifs this update prints.
      const screeningHits = screenProduct(
        prod,
        await loadScreeningBlocklist(),
        publishedArtworkNames(publishSlots, selectedSet),
      );

      setPublishResult({
        name: prod.name || '(namnlös produkt)',
        sku: prod.sku || '',
        updated: true,
        screeningHits,
      });
      onChanged?.();
    } catch (e) {
      console.error('DesignStudio: update product failed', e);
      setPublishError(docTouched
        ? 'Bilderna lades till men tryckkopplingen kan vara ofullständig. Kontrollera produkten och försök igen.'
        : (e?.message || 'Uppdateringen misslyckades.'));
    }
  })();
  return outcome;
}
