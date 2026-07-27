// DesignStudio.jsx — the Design Studio tab (POD add-on, Mode A / shop-owner studio).
//
// SLICE 2: the picking UI around the LIVE placement compositor:
//   • left rail  — artwork picker (validated originals; PASS/WARN selectable, FAIL
//                  greyed with an "underkänd" hint) + garment template picker
//                  (cards showing the SVG flat thumbnail in its colourways).
//   • main area  — CompositorCanvas: the garment flat with the artwork placed in
//                  the print area (drag/resize/snap, cm readout, live DPI verdict).
//                  Colourway chips + a front/back slot selector sit under it.
//
// PLACEMENT STATE lives here, ONE PER SLOT (placements[slot] = {xMm,yMm,wMm}), so
// switching front↔back preserves each side's placement. Placements reset when the
// artwork or template changes (the aspect ratio and print areas they were clamped
// against no longer apply).
//
// SLICE 3 adds:
//   • overrides — per-slot, per-colourway artwork override ({ [slot]: { [cwId]:
//     artworkId } }), the "byt motiv på mörka plagg" feature; resolveArtwork()
//     feeds the override-aware artwork to the canvas, the strip AND the renderer.
//   • mockups/heroKey — "Generera mockuper" rasterizes one image per colourway
//     (× designed slot) via renderMockup, uploads drafts to the shop's Storage
//     partition (best-effort; downloads still work offline), hero pick for slice 4.
//
// Artwork comes from the SHARED usePodLibrary load (passed down from PodAdminPage),
// so no extra Firestore reads. Templates + print profiles (DPI thresholds) load
// once via their cached loaders.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PhotoIcon } from '@heroicons/react/24/outline';
import { CardSection } from '../../../components/admin/ui';
import StatusPill from '../../../components/admin/ui/StatusPill';
import { slotLabel, POCKET_POSITIONS, DEFAULT_POCKET_POSITION, pocketPositionLabel } from '../../../config/podSlots';
import {
  loadPodMockupTemplates,
  getPodMockupTemplatesMeta,
  templateSlots,
} from '../../../config/podMockupTemplates';
import { loadPodProfiles, getProfileById } from '../../../config/podProfiles';
import { loadPod3dModels } from '../../../config/pod3dModels';
import { tierTone, tierLabel } from '../components/podTier';
import { isComposable, placementReadout, defaultPlacement, templateWithPocketPosition } from './placementMath';
import { renderMockup } from './mockupRender';
import { uploadMockup } from './mockupUpload';
import TemplateBackground from './TemplateBackground';
import CompositorCanvas from './CompositorCanvas';
import ColorwayStrip from './ColorwayStrip';
import MockupPanel from './MockupPanel';
import PublishPanel from './PublishPanel';
import Studio3DSection from './Studio3DSection';
// Publish (slice 4) — create the real product + variants + POD mappings. These
// are the ONLY Firebase-touching imports in the studio; PublishPanel stays
// Firebase-free (presentational) so the dev harness can mount it standalone.
import { collection, addDoc, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from '../../../firebase/config';
import { withShopId } from '../../../config/withShopId';
import { skuFromName, uniqueSku } from '../../../utils/productUrls';
import { deriveVariantsFromGroups } from '../../../utils/variantDerivation';
import { setMapping } from '../../../utils/podMappings';
import { STORE } from '../../../config/store';

// Validation is ADVISORY (podValidation's contract: "WARN/FAIL never blocks — it
// guides the seller; the printer decides"). The studio therefore selects ANY
// composable original; the tier pill (Underkänd/Varning) stays visible on the row
// as the warning. Only non-composable files (no raster preview/dims — PDF/SVG)
// are unselectable, because the compositor literally has nothing to draw.
const isSelectableArtwork = (art) => isComposable(art);

// Thumbnail of a template in its first colourway (for the picker cards): SVG flat
// or the colourway's garment photo, via the shared background layer.
const GarmentThumb = ({ template, colorway }) => (
  <TemplateBackground template={template} colorway={colorway} />
);

const DesignStudio = ({ artwork = [], loading = false, shopId = null }) => {
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [meta, setMeta] = useState({ version: 0, provisional: true });
  const [profiles, setProfiles] = useState([]);
  const [models3d, setModels3d] = useState([]);

  const [selectedArtworkId, setSelectedArtworkId] = useState(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [colorwayId, setColorwayId] = useState(null);
  const [slot, setSlot] = useState('front');
  // Pocket position (left/center/right, wearer's perspective) — 'pocket' is a
  // fixed-size discrete-position slot, not free placement (docs/POD_PRINT_SPEC.md).
  const [pocketPosition, setPocketPosition] = useState(DEFAULT_POCKET_POSITION);
  // One placement per slot for the CURRENT artwork+template pair:
  // { front: {xMm,yMm,wMm}, back: … }. Missing slot → compositor uses its default.
  const [placements, setPlacements] = useState({});
  // Per-slot, per-colourway artwork override: { [slot]: { [colorwayId]: artworkId } }.
  const [overrides, setOverrides] = useState({});
  // Generated mockups: array of { key, colorwayId, colorwayLabel, slot, objectUrl,
  // url?, storagePath?, type } + the hero pick (slice 4 reads both).
  const [mockups, setMockups] = useState([]);
  const [heroKey, setHeroKey] = useState(null);
  // PER-COLOURWAY REVIEW GATE (slice 5): ids the seller has SEEN composited in the
  // strip for the CURRENT design. Only the active colourway counts as seen; the set
  // resets to just the active colourway whenever the composite changes (placement /
  // override / mockup / artwork / template) so a stale review can't unlock publish.
  const [reviewedColorways, setReviewedColorways] = useState(() => new Set());
  const [generating, setGenerating] = useState(false);
  const [mockupError, setMockupError] = useState(null);
  // Publish (slice 4): the "Skapa produkt" step. result = { name, sku } on success.
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState(null);
  const [publishResult, setPublishResult] = useState(null);
  // Object URLs owned by the current mockup set — revoked on replace/unmount.
  const objectUrlsRef = useRef([]);
  const replaceObjectUrls = (urls) => {
    objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    objectUrlsRef.current = urls;
  };
  useEffect(() => () => replaceObjectUrls([]), []);

  // Reviews are valid for the CURRENT design only — reset the seen-set to JUST the
  // active colourway. The colorwayId effect re-seeds anyway; seeding here keeps the
  // gate honest between that effect firing (and covers a null active colourway).
  const resetReviews = () => setReviewedColorways(colorwayId ? new Set([colorwayId]) : new Set());

  const resetDesignState = () => {
    setPlacements({});
    setOverrides({});
    setMockups([]);
    setHeroKey(null);
    setMockupError(null);
    setPublishError(null);
    setPublishResult(null);
    replaceObjectUrls([]);
    resetReviews();
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      setTemplatesLoading(true);
      const [t, p, m3d] = await Promise.all([loadPodMockupTemplates(), loadPodProfiles(), loadPod3dModels()]);
      if (!alive) return;
      setTemplates(t);
      setProfiles(p);
      setModels3d(m3d);
      setMeta(getPodMockupTemplatesMeta());
      // Default-select the first template + its first colourway so the canvas
      // isn't empty on open.
      if (t.length && !selectedTemplateId) {
        setSelectedTemplateId(t[0].id);
        setColorwayId(t[0].colorways?.[0]?.id || null);
      }
      setTemplatesLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || null,
    [templates, selectedTemplateId]
  );

  // Keep the colourway + slot valid whenever the template changes. Design state
  // (placements/overrides/mockups) resets too — it was built against the OLD
  // template's print areas and colourways.
  useEffect(() => {
    if (!selectedTemplate) return;
    const cwIds = (selectedTemplate.colorways || []).map((c) => c.id);
    if (!cwIds.includes(colorwayId)) setColorwayId(cwIds[0] || null);
    const slots = templateSlots(selectedTemplate);
    if (!slots.includes(slot)) setSlot(slots[0] || 'front');
    setPocketPosition(DEFAULT_POCKET_POSITION);
    resetDesignState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId]);

  // New artwork = new aspect ratio: every stored placement's derived height (and
  // clamping) is stale, and overrides/mockups referenced the old base motif.
  useEffect(() => {
    resetDesignState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArtworkId]);

  // The ACTIVE colourway is always considered SEEN — selecting one composites it
  // live in the strip. Covers the initial default colourway too. Switching slots
  // does NOT reset reviews (same colourways; the strip re-previews the active slot).
  useEffect(() => {
    if (!colorwayId) return;
    setReviewedColorways((prev) => (prev.has(colorwayId) ? prev : new Set(prev).add(colorwayId)));
  }, [colorwayId]);

  const selectedColorway = useMemo(
    () => (selectedTemplate?.colorways || []).find((c) => c.id === colorwayId) || selectedTemplate?.colorways?.[0] || null,
    [selectedTemplate, colorwayId]
  );

  const selectedArtwork = useMemo(
    () => artwork.find((a) => a.id === selectedArtworkId) || null,
    [artwork, selectedArtworkId]
  );

  const slots = templateSlots(selectedTemplate);

  // The template's print profile (settings/podProfiles) — DPI thresholds for the
  // compositor's live verdict.
  const profile = useMemo(
    () => getProfileById(profiles, selectedTemplate?.profileId),
    [profiles, selectedTemplate]
  );

  // The GEOMETRY template: selectedTemplate with the pocket rect moved to the
  // chosen position. Everything that does placement geometry (canvas, strip,
  // rasterizer, publish readouts) consumes THIS; pickers/colourways/slots read
  // selectedTemplate (same ids either way).
  const effTemplate = useMemo(
    () => templateWithPocketPosition(selectedTemplate, pocketPosition),
    [selectedTemplate, pocketPosition]
  );

  // Which artwork a colourway prints in a slot: its override, else the product's
  // base artwork. Single resolver feeding the canvas, the strip AND the renderer,
  // mirroring the podMappings colorway-override model.
  const resolveArtwork = (forSlot, cwId) => {
    const overrideId = overrides[forSlot]?.[cwId];
    if (overrideId) {
      const found = artwork.find((a) => a.id === overrideId);
      if (found) return found;
    }
    return selectedArtwork;
  };

  const setOverride = (forSlot, cwId, artworkId) => {
    setOverrides((prev) => {
      const slotMap = { ...(prev[forSlot] || {}) };
      if (artworkId) slotMap[cwId] = artworkId;
      else delete slotMap[cwId];
      return { ...prev, [forSlot]: slotMap };
    });
    setMockups([]); // stale — the motif map changed
    setHeroKey(null);
    resetReviews(); // the composite changed — every colourway must be re-seen
  };

  // Override choices: selectable (non-FAIL) artwork that can actually be
  // COMPOSED (raster with known dims — a PASS-tier PDF can't preview/mockup, and
  // offering it would silently drop that colourway from the generated set).
  const overrideOptions = useMemo(
    () => artwork.filter((a) => isSelectableArtwork(a) && isComposable(a) && a.id !== selectedArtworkId),
    [artwork, selectedArtworkId]
  );

  // Slots that end up on mockups: 'front' always (the canvas shows its default
  // immediately), other slots only once the seller actually placed something.
  const designedSlots = (t) =>
    templateSlots(t).filter((s) => s === 'front' || Boolean(placements[s]));

  const generateMockups = async () => {
    // Also blocked while PUBLISHING: regenerating revokes the object URLs the
    // publish loop is mid-fetch on (partial-failure trigger).
    if (!selectedTemplate || generating || publishing) return;
    setGenerating(true);
    setMockupError(null);
    const next = [];
    const urls = [];
    let uploadFailures = 0;
    let renderSkips = 0;
    try {
      for (const cw of selectedTemplate.colorways || []) {
        for (const s of designedSlots(selectedTemplate)) {
          const art = resolveArtwork(s, cw.id);
          if (!art || !isComposable(art)) continue;
          // Per-item try/catch: one un-renderable colourway (e.g. a photo
          // template missing that colourway's photo) skips, not aborts —
          // the other colourways' mockups still generate.
          let blob, type;
          try {
            ({ blob, type } = await renderMockup({
              template: effTemplate, colorway: cw, slot: s, minDpi: profile?.min_dpi ?? null,
              artwork: art, placement: placements[s] || null,
            }));
          } catch (e) {
            renderSkips += 1;
            console.warn('DesignStudio: mockup render skipped', cw.id, s, e?.message);
            continue;
          }
          const objectUrl = URL.createObjectURL(blob);
          urls.push(objectUrl);
          let uploaded = null;
          if (shopId) {
            try {
              uploaded = await uploadMockup({
                blob, type, shopId,
                templateId: selectedTemplate.id, slot: s, colorwayId: cw.id,
              });
            } catch (e) {
              uploadFailures += 1;
              console.warn('DesignStudio: mockup upload failed', cw.id, s, e?.message);
            }
          }
          next.push({
            key: `${cw.id}:${s}`, colorwayId: cw.id, colorwayLabel: cw.label,
            slot: s, objectUrl, type,
            url: uploaded?.url || null, storagePath: uploaded?.storagePath || null,
          });
        }
      }
      replaceObjectUrls(urls);
      setMockups(next);
      resetReviews(); // regenerated composites — the seller must re-scan the strip
      setHeroKey((prev) => (prev && next.some((m) => m.key === prev) ? prev : next[0]?.key || null));
      if (next.length === 0) {
        setMockupError(renderSkips > 0
          ? 'Inga mockuper kunde genereras — plaggfoton saknas för mallens färger.'
          : 'Inget att generera — välj ett original som kan förhandsgranskas.');
      } else if (renderSkips > 0 || uploadFailures > 0) {
        const parts = [];
        if (renderSkips > 0) parts.push(`${renderSkips} färg${renderSkips > 1 ? 'er' : ''} hoppades över (foto saknas)`);
        if (uploadFailures > 0) parts.push(`${uploadFailures} kunde inte sparas till lagringen — nedladdning fungerar ändå`);
        setMockupError(`Mockuperna genererades, men ${parts.join('; ')}.`);
      }
    } catch (e) {
      console.warn('DesignStudio: mockup generation failed', e);
      urls.forEach((u) => URL.revokeObjectURL(u));
      setMockupError(e?.message || 'Mockup-genereringen misslyckades.');
    } finally {
      setGenerating(false);
    }
  };

  // ── PUBLISH (slice 4) ───────────────────────────────────────────────────
  // Turn the generated mockups into a real, immediately-sellable product +
  // variants + POD mappings. PublishPanel is presentational and calls this with
  // the operator's picks; ALL Firebase work lives here (studio owns the state).
  //
  // Write order (mirrors ProductForm's save path where they overlap):
  //   validate → resolve per-shop-unique sku → upload hero + every mockup blob to
  //   the PUBLIC product path (the pod-artwork drafts are admin-read-only) → build
  //   resolved variant groups (selected colourways, per-colourway FRONT mockup as
  //   the group image, chosen sizes, explicit per-row price or '') →
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

  // Synchronous in-flight latch: the `publishing` STATE doesn't update between
  // two clicks dispatched in the same tick, and two concurrent publishes would
  // both resolve the SAME "unique" sku (both query the pre-commit SKU set) →
  // two live products sharing one SKU. The ref flips synchronously.
  const publishingRef = useRef(false);

  const publish = async ({ name, price, selectedColorwayIds, sizesByColorway, perColorwayPrices }) => {
    if (publishing || publishingRef.current) return;
    setPublishError(null);
    setPublishResult(null);

    // Validate (belt-and-suspenders; PublishPanel gates the button too).
    if (!shopId) { setPublishError('Ingen butik är vald.'); return; }
    if (!selectedArtwork) { setPublishError('Välj ett original innan du publicerar.'); return; }
    const cleanName = (name || '').trim();
    if (!cleanName) { setPublishError('Ange ett produktnamn.'); return; }
    const productPrice = parseFloat(price) || 0;
    if (!(productPrice > 0)) { setPublishError('Ange ett pris större än 0.'); return; }
    const selectedSet = new Set(selectedColorwayIds || []);
    if (selectedSet.size === 0) { setPublishError('Välj minst en färg att publicera.'); return; }
    if (mockups.length === 0) { setPublishError('Generera mockuper först.'); return; }

    publishingRef.current = true;
    setPublishing(true);
    let docCreated = false;
    try {
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
      // Track the FRONT mockup url per colourway for its variant group image.
      const galleryUrls = [];
      const frontUrlByColorway = {};
      for (const m of pubMockups) {
        const url = await uploadBlobToPublicPath(
          m.objectUrl, m.type, publicPath, `mockup_${m.colorwayId}_${m.slot}`
        );
        galleryUrls.push(url);
        if (m.slot === 'front') frontUrlByColorway[m.colorwayId] = url;
      }

      // 3. Build resolved variant groups — one per SELECTED colourway. Its image is
      // that colourway's FRONT mockup (fallback: any mockup for it, then hero).
      const anyUrlByColorway = {};
      pubMockups.forEach((m, i) => { if (!(m.colorwayId in anyUrlByColorway)) anyUrlByColorway[m.colorwayId] = galleryUrls[i]; });
      const colorwayLabel = (id) =>
        (selectedTemplate?.colorways || []).find((c) => c.id === id)?.label || id;
      // publishedIds order defines resolvedGroups order — and the derivation
      // processes groups 1:1 in order, so cleanGroups[i] ↔ publishedIds[i].
      // That index join (not labels) keys the override→group-sku lookup below.
      const publishedIds = (selectedColorwayIds || []).filter((id) => selectedSet.has(id));
      const resolvedGroups = publishedIds
        .map((id) => {
          const img = frontUrlByColorway[id] || anyUrlByColorway[id] || heroUrl;
          const explicit = (perColorwayPrices?.[id] ?? '').toString().trim();
          return {
            label: colorwayLabel(id),
            sku: '',                                   // auto-derive from product sku + label
            price: explicit === '' ? '' : explicit,    // '' inherits the product price
            images: img ? [img] : [],
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

      // 5. Build the product doc EXACTLY like ProductForm (studio-relevant field
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

      // 6. POD mappings. PARENT row per DESIGNED slot: keyed on the product sku,
      // its placement is the cm readout of the slot's EFFECTIVE placement (stored
      // placement, else the compositor default). The print pipeline resolves
      // longest-prefix within a slot, so per-colourway group-sku rows override the
      // parent for that colourway's sizes.
      // Group sku per COLORWAY ID (index-aligned with publishedIds) — an id join,
      // not a label join, so duplicate colorway labels can never cross-target.
      const groupSkuByColorwayId = new Map(publishedIds.map((id, i) => [id, cleanGroups[i]?.sku]));
      for (const s of designedSlots(selectedTemplate)) {
        const effective = placements[s] || defaultPlacement(effTemplate, s, selectedArtwork, profile?.min_dpi ?? null);
        const readout = placementReadout(effective, effTemplate, s, selectedArtwork);
        const isPocket = s === 'pocket';
        const posLabel = pocketPositionLabel(pocketPosition);
        await setMapping({
          shopId,
          sku: resolvedSku,
          artworkId: selectedArtwork.id,
          profileId: selectedTemplate.profileId,
          // Pocket rows carry the discrete position FIRST — that's the printer's
          // primary instruction for this slot ("Ficka — Vänster · 2 cm uppifrån…").
          placement: isPocket ? `${posLabel} · ${readout}` : readout,
          placementSlot: s,
          ...(isPocket ? { position: pocketPosition } : {}),
        });
      }

      // OVERRIDE row per (designed slot, colourway that has an override AND is
      // published): targets that colourway's GROUP sku so it wins over the parent.
      for (const s of designedSlots(selectedTemplate)) {
        const slotOverrides = overrides[s] || {};
        for (const [cwId, overrideArtworkId] of Object.entries(slotOverrides)) {
          if (!overrideArtworkId || !selectedSet.has(cwId)) continue;
          const groupSku = groupSkuByColorwayId.get(cwId);
          if (!groupSku) continue;
          const overrideArt = artwork.find((a) => a.id === overrideArtworkId) || selectedArtwork;
          const effective = placements[s] || defaultPlacement(effTemplate, s, overrideArt, profile?.min_dpi ?? null);
          const readout = placementReadout(effective, effTemplate, s, overrideArt);
          const isPocket = s === 'pocket';
          const posLabel = pocketPositionLabel(pocketPosition);
          await setMapping({
            shopId,
            sku: groupSku,
            artworkId: overrideArtworkId,
            profileId: selectedTemplate.profileId,
            placement: isPocket ? `${posLabel} · ${readout}` : readout,
            placementSlot: s,
            ...(isPocket ? { position: pocketPosition } : {}),
          });
        }
      }

      setPublishResult({ name: cleanName, sku: resolvedSku });
    } catch (e) {
      console.error('DesignStudio: publish failed', e);
      setPublishError(
        docCreated
          ? 'Produkten skapades men bilder/kopplingar kan vara ofullständiga — kontrollera under Produkter.'
          : (e?.message || 'Publiceringen misslyckades.')
      );
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  };

  const resetPublishForm = () => {
    setPublishError(null);
    setPublishResult(null);
  };

  const canvasArtwork = resolveArtwork(slot, colorwayId);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px,1fr]">
      {/* ── LEFT RAIL ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        {/* Artwork picker */}
        <CardSection title="Original" bodyClassName="p-0">
          {loading ? (
            <p className="px-4 py-4 text-[13px] text-admin-text-muted">Laddar…</p>
          ) : artwork.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-admin-text-muted">
              Inga original ännu. Ladda upp ett original under fliken Original först.
            </p>
          ) : (
            <ul className="max-h-[340px] overflow-y-auto">
              {artwork.map((art) => {
                const selectable = isSelectableArtwork(art);
                const active = art.id === selectedArtworkId;
                return (
                  <li key={art.id}>
                    <button
                      type="button"
                      disabled={!selectable}
                      onClick={() => selectable && setSelectedArtworkId(art.id)}
                      title={!selectable ? 'Formatet kan inte förhandsgranskas i studion (bildmått saknas)' : undefined}
                      className={`flex w-full items-center gap-3 border-b border-admin-border-soft px-4 py-2.5 text-left ${
                        active ? 'bg-admin-info-bg/60' : 'hover:bg-admin-surface-2'
                      } ${selectable ? '' : 'cursor-not-allowed opacity-45'}`}
                    >
                      {art.previewUrl ? (
                        <img src={art.previewUrl} alt="" className="h-11 w-11 shrink-0 rounded-[6px] border border-admin-border object-cover" />
                      ) : (
                        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-[6px] border border-admin-border bg-admin-surface-2 text-admin-text-faint">
                          <PhotoIcon className="h-5 w-5" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-admin-text">
                          {art.label || art.fileName}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <StatusPill tone={tierTone(art.validation?.tier)}>
                            {tierLabel(art.validation?.tier)}
                          </StatusPill>
                          {!selectable && (
                            <span className="text-[11px] text-admin-text-faint">kan inte användas</span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardSection>

        {/* Template picker */}
        <CardSection title="Plagg" bodyClassName="p-0">
          {templatesLoading ? (
            <p className="px-4 py-4 text-[13px] text-admin-text-muted">Laddar mallar…</p>
          ) : templates.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-admin-text-muted">
              Inga plaggmallar ännu. Plattformen behöver seeda mockup-mallarna.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 p-4">
              {templates.map((t) => {
                const active = t.id === selectedTemplateId;
                const thumbColorway = t.colorways?.[0] || null;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(t.id)}
                    className={`rounded-[var(--radius-admin)] border p-2 text-left transition ${
                      active
                        ? 'border-admin-info-dot ring-1 ring-admin-info-dot/40'
                        : 'border-admin-border hover:bg-admin-surface-2'
                    }`}
                  >
                    <div className="grid aspect-square place-items-center overflow-hidden rounded-[6px] bg-admin-surface-2">
                      <div className="h-[88%] w-[88%]">
                        <GarmentThumb template={t} colorway={thumbColorway} />
                      </div>
                    </div>
                    <div className="mt-1.5 truncate text-[12px] font-medium text-admin-text">{t.label}</div>
                  </button>
                );
              })}
            </div>
          )}
        </CardSection>
      </div>

      {/* ── MAIN AREA ─────────────────────────────────────────────────────── */}
      <CardSection
        title="Förhandsgranskning"
        bodyClassName="p-4"
      >
        {meta.provisional && (
          <p className="mb-3 text-[12px] text-admin-text-faint">
            Generiska plaggmallar (preliminära) — ersätts när tryckeriets riktiga plagg finns.
          </p>
        )}

        <CompositorCanvas
          template={effTemplate}
          colorway={selectedColorway}
          slot={slot}
          artwork={canvasArtwork}
          profile={profile}
          placement={placements[slot] || null}
          onPlacementChange={(p) => {
            setPlacements((prev) => ({ ...prev, [slot]: p }));
            resetReviews(); // moving the artwork changes every colourway's composite
          }}
        />

        {/* 3D-vy (beta): photo-displacement mockup with the FRONT slot's resolved
            artwork. DECOUPLED from the print placement — the 3D view composes the
            PRODUCT IMAGE only (never a print instruction); the canvas placement
            only seeds its starting position. WebGL-gated; pixi lazy-loads. */}
        <Studio3DSection
          artwork={resolveArtwork('front', colorwayId)}
          placement={placements.front || null}
          models={models3d}
        />

        {/* Colourway strip: composited per-colour previews + artwork override. */}
        {selectedTemplate && (
          <ColorwayStrip
            template={effTemplate}
            slot={slot}
            minDpi={profile?.min_dpi ?? null}
            activeColorwayId={colorwayId}
            onSelect={setColorwayId}
            placement={placements[slot] || null}
            resolveArtwork={(cwId) => resolveArtwork(slot, cwId)}
            overrides={overrides[slot] || {}}
            onOverrideChange={selectedArtwork ? (cwId, artId) => setOverride(slot, cwId, artId) : null}
            artworkOptions={overrideOptions}
            baseArtworkLabel={selectedArtwork?.label || selectedArtwork?.fileName || 'Standardmotiv'}
            reviewedColorwayIds={reviewedColorways}
          />
        )}

        {/* Slot selector — only when the template defines more than one slot. */}
        {slots.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-admin-text-muted">Placering:</span>
            {slots.map((s) => {
              const active = s === slot;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSlot(s)}
                  className={`rounded-[var(--radius-admin-el)] px-2.5 py-1 text-[12px] ${
                    active
                      ? 'bg-black/[0.08] font-medium text-admin-text'
                      : 'text-admin-text-muted hover:bg-black/[0.06]'
                  }`}
                >
                  {slotLabel(s)}
                </button>
              );
            })}
          </div>
        )}

        {/* Pocket position — discrete choice (left/center/right, wearer's
            perspective), no free placement for the fixed 10×10 cm pocket spot. */}
        {slot === 'pocket' && selectedTemplate?.pocketPositions && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-admin-text-muted">Fickposition:</span>
            {POCKET_POSITIONS.map((p) => {
              const active = p.id === pocketPosition;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setPocketPosition(p.id);
                    setMockups([]); // stale — the pocket rect moved
                    setHeroKey(null);
                    resetReviews(); // the composite changed — every colourway must be re-seen
                  }}
                  className={`rounded-[var(--radius-admin-el)] px-2.5 py-1 text-[12px] ${
                    active
                      ? 'bg-black/[0.08] font-medium text-admin-text'
                      : 'text-admin-text-muted hover:bg-black/[0.06]'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            <span className="text-[11px] text-admin-text-faint">(sett från bäraren)</span>
          </div>
        )}

        {/* Generated mockups: per-colourway rasterized previews + hero pick. */}
        <MockupPanel
          mockups={mockups}
          heroKey={heroKey}
          onPickHero={setHeroKey}
          onGenerate={generateMockups}
          generating={generating}
          error={mockupError}
          canGenerate={Boolean(selectedTemplate && isComposable(selectedArtwork)) && !publishing}
        />

        {/* Publish: pick colourways + sizes, price, and create the real product. */}
        <PublishPanel
          mockups={mockups}
          template={selectedTemplate}
          vatRate={STORE.vatRate}
          hasArtwork={Boolean(selectedArtwork)}
          shopId={shopId}
          publishing={publishing}
          result={publishResult}
          error={publishError}
          reviewedColorwayIds={reviewedColorways}
          onPublish={publish}
          onReset={resetPublishForm}
        />
      </CardSection>
    </div>
  );
};

export default DesignStudio;
