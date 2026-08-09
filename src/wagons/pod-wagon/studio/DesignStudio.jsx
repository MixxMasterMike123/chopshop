// DesignStudio.jsx — the Design Studio tab (POD add-on, Mode A / shop-owner studio).
//
// LAYOUT (v2 restructure 2026-08-08, from /impeccable critique): four NUMBERED
// task phases in one column — 1·Plagg (compact template strip) · 2·Tryck &
// placering (CompositorCanvas + trycklista SIDE BY SIDE; every print row owns
// its motif via an INLINE picker — no separate artwork rail) · 3·Färger &
// mockuper (colourway review strip w/ live gate counter, read-only 3D, mockup
// generation) · 4·Publicera. The studio stays MOUNTED across PodAdminPage tab
// switches (state survives a trip to the Original tab).
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
import { slotLabel, POCKET_POSITIONS, DEFAULT_POCKET_POSITION, pocketPositionLabel } from '../../../config/podSlots';
import {
  loadPodMockupTemplates,
  getPodMockupTemplatesMeta,
  templateSlots,
} from '../../../config/podMockupTemplates';
import { loadPodProfiles, getProfileById } from '../../../config/podProfiles';
import { loadPod3dModels } from '../../../config/pod3dModels';
import { tierLabel } from '../components/podTier';
import { isComposable, placementReadout, defaultPlacement, containPlacement, clampPlacement, templateWithPocketPosition } from './placementMath';
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
// composable original; non-pass tiers show as a caution dot on the inline
// picker thumb. Only non-composable files (no raster preview/dims — PDF/SVG)
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

  // TRYCKLISTAN (slice A, 2026-08-08): the design = an ordered list of PRINTS,
  // one row per physical position: { slot, artworkId|null }. A row without a
  // motif is incomplete (blocks publish); NO row = NO print — the old implicit
  // always-front default is gone. At most one row per slot.
  const [prints, setPrints] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [colorwayId, setColorwayId] = useState(null);
  // The ACTIVE print row's slot (drives canvas/strip). Reconciled against
  // `prints` — when the list is empty it idles on 'front' with no artwork.
  const [slot, setSlot] = useState('front');
  // Which row's INLINE motif picker is open (slot id | null). The picker lives
  // in the row itself — choosing a motif never means leaving the trycklista
  // (critique P0: the old left-rail picker forced a scroll round-trip).
  const [motifPickerSlot, setMotifPickerSlot] = useState(null);
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
    // Keep print rows whose slot exists on the new garment (the seller's motif
    // picks survive a garment switch); their placements reset below — they were
    // clamped against the OLD template's print areas. Both dispatches sit in
    // the effect body (never inside an updater — updaters must stay pure).
    const kept = prints.filter((p) => slots.includes(p.slot));
    setPrints(kept);
    const first = kept[0]?.slot || slots[0] || 'front';
    setSlot((cur) => (kept.some((p) => p.slot === cur) ? cur : first));
    setPocketPosition(DEFAULT_POCKET_POSITION);
    resetDesignState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId]);

  // (No global artwork-change reset anymore: changing a print row's motif
  // resets only THAT row's placement — see setPrintArtwork below.)

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

  const slots = templateSlots(selectedTemplate);

  // ── Trycklista helpers ────────────────────────────────────────────────────
  const printBySlot = useMemo(
    () => Object.fromEntries(prints.map((p) => [p.slot, p])),
    [prints]
  );
  const artworkById = (id) => (id ? artwork.find((a) => a.id === id) || null : null);
  // The base motif a slot prints (its row's artwork; null if no row/motif).
  const printArtwork = (forSlot) => artworkById(printBySlot[forSlot]?.artworkId);

  // Bröst + pocket collide physically (front starts 60–70 mm below the neck
  // seam; the pocket spot sits in that band — POD_PRINT_SPEC §1). BLOCKED as a
  // combo (decided 2026-08-08): adding one greys out the other.
  const BLOCKED_BY = { front: 'pocket', pocket: 'front' };
  const slotAvailability = (s) => {
    if (printBySlot[s]) return { available: false, reason: 'Redan tillagt' };
    const blocker = BLOCKED_BY[s];
    if (blocker && printBySlot[blocker]) {
      const blockerName = blocker === 'front' ? 'brösttryck' : 'ficktryck';
      return { available: false, reason: `Kan inte kombineras med ${blockerName} (ytorna överlappar)` };
    }
    return { available: true, reason: null };
  };

  // Any composite-affecting change invalidates generated mockups + reviews.
  const invalidateComposite = () => {
    setMockups([]);
    setHeroKey(null);
    resetReviews();
  };

  const addPrint = (s) => {
    if (!slotAvailability(s).available) return;
    setPrints((prev) => [...prev, { slot: s, artworkId: null }]);
    if (s === 'pocket') setPocketPosition(DEFAULT_POCKET_POSITION);
    setSlot(s);
    setMotifPickerSlot(s); // a motif-less row's next step is ALWAYS picking one
  };

  const removePrint = (s) => {
    setPrints((prev) => prev.filter((p) => p.slot !== s));
    setPlacements((prev) => { const n = { ...prev }; delete n[s]; return n; });
    setOverrides((prev) => { const n = { ...prev }; delete n[s]; return n; });
    setMotifPickerSlot((cur) => (cur === s ? null : cur));
    invalidateComposite();
    if (slot === s) {
      const remaining = prints.filter((p) => p.slot !== s);
      setSlot(remaining[0]?.slot || 'front');
    }
  };

  // New motif on a row = new aspect ratio for THAT slot only: its stored
  // placement is stale (clamping/derived height), the rest of the design keeps.
  const setPrintArtwork = (s, artId) => {
    setPrints((prev) => prev.map((p) => (p.slot === s ? { ...p, artworkId: artId } : p)));
    setPlacements((prev) => { const n = { ...prev }; delete n[s]; return n; });
    setMotifPickerSlot(null);
    invalidateComposite();
  };


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

  // Which artwork a colourway prints in a slot: its override, else the SLOT's
  // print-row artwork (slice A: per-slot base, no global motif). Single resolver
  // feeding the canvas, the strip AND the renderer, mirroring podMappings.
  const resolveArtwork = (forSlot, cwId) => {
    const overrideId = overrides[forSlot]?.[cwId];
    if (overrideId) {
      const found = artworkById(overrideId);
      if (found) return found;
    }
    return printArtwork(forSlot);
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

  // Override choices for the ACTIVE slot: selectable (non-FAIL) artwork that can
  // actually be COMPOSED (raster with known dims — a PASS-tier PDF can't
  // preview/mockup), excluding the slot's own base motif.
  const activeBaseArtworkId = printBySlot[slot]?.artworkId || null;
  const overrideOptions = useMemo(
    () => artwork.filter((a) => isSelectableArtwork(a) && a.id !== activeBaseArtworkId),
    [artwork, activeBaseArtworkId]
  );

  // Slots that end up on mockups + mappings: exactly the trycklista's rows that
  // have a motif AND exist on the template (list order preserved). No implicit
  // front — an empty list designs nothing.
  const designedSlots = (t) => {
    const valid = new Set(templateSlots(t));
    return prints.filter((p) => valid.has(p.slot) && p.artworkId).map((p) => p.slot);
  };

  // The placement a slot actually prints/renders: pocket is LOCKED to the
  // deterministic contain-centred rect (never user-stored); free slots use the
  // stored placement RE-CLAMPED against the given artwork (an override motif
  // with another aspect/resolution must not inherit an out-of-area or sub-DPI
  // rect), else the compositor default. Same function feeds the mockup
  // renderer AND the publish readouts so they can never disagree.
  const effectivePlacementFor = (s, art) => (s === 'pocket'
    ? containPlacement(effTemplate, s, art, profile?.min_dpi ?? null)
    : (placements[s]
        ? clampPlacement(placements[s], effTemplate, s, art, profile?.min_dpi ?? null)
        : defaultPlacement(effTemplate, s, art, profile?.min_dpi ?? null)));

  // Which flat a slot renders on (POD_PRINT_SPEC §5: sleeves + pocket draw on
  // the FRONT flat; only 'back' has its own view). Ghost outlines on the canvas
  // only make sense for designed slots sharing the ACTIVE slot's flat — they
  // are the row↔garment linkage the critique flagged (clicking one activates
  // that print's row).
  const viewOfSlot = (s) => (s === 'back' ? 'back' : 'front');
  const ghostAreas = designedSlots(selectedTemplate)
    .filter((s) => s !== slot && viewOfSlot(s) === viewOfSlot(slot))
    .map((s) => ({ slot: s, label: slotLabel(s), rect: effTemplate?.printAreas?.[s] || null }))
    .filter((g) => g.rect);

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
              artwork: art, placement: effectivePlacementFor(s, art),
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
    const publishSlots = designedSlots(selectedTemplate);
    if (publishSlots.length === 0) { setPublishError('Lägg till minst ett tryck med motiv innan du publicerar.'); return; }
    if (prints.some((p) => !p.artworkId)) { setPublishError('Ett tryck saknar motiv — välj motiv för raden eller ta bort den.'); return; }
    // A motif deleted from the library after it was picked would crash mid-
    // publish (after addDoc) — catch it here instead.
    if (prints.some((p) => p.artworkId && !artworkById(p.artworkId))) {
      setPublishError('Ett valt motiv finns inte längre i biblioteket — välj ett nytt motiv för trycket.');
      return;
    }
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
      for (const s of publishSlots) {
        const baseArt = printArtwork(s);
        const effective = effectivePlacementFor(s, baseArt);
        const readout = placementReadout(effective, effTemplate, s, baseArt);
        const isPocket = s === 'pocket';
        const posLabel = pocketPositionLabel(pocketPosition);
        await setMapping({
          shopId,
          sku: resolvedSku,
          artworkId: baseArt.id,
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
      for (const s of publishSlots) {
        const slotOverrides = overrides[s] || {};
        for (const [cwId, overrideArtworkId] of Object.entries(slotOverrides)) {
          if (!overrideArtworkId || !selectedSet.has(cwId)) continue;
          const groupSku = groupSkuByColorwayId.get(cwId);
          if (!groupSku) continue;
          const overrideArt = artworkById(overrideArtworkId) || printArtwork(s);
          const effective = effectivePlacementFor(s, overrideArt);
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
    <div className="flex flex-col gap-4">

      {/* ── 1 · PLAGG — a one-time choice, sized like one (critique P2:
          the old 2-col aspect-square cards dominated whole screen-heights). */}
      <CardSection title="1 · Plagg" bodyClassName="p-4">
        {templatesLoading ? (
          <p className="text-[13px] text-admin-text-muted">Laddar mallar…</p>
        ) : templates.length === 0 ? (
          <p className="text-[13px] text-admin-text-muted">
            Inga plaggmallar ännu. Plattformen behöver seeda mockup-mallarna.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
              {templates.map((t) => {
                const active = t.id === selectedTemplateId;
                const thumbColorway = t.colorways?.[0] || null;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(t.id)}
                    title={t.label}
                    className={`rounded-[var(--radius-admin-el)] border p-1.5 text-left transition ${
                      active
                        ? 'border-admin-info-dot ring-1 ring-admin-info-dot/40'
                        : 'border-admin-border hover:bg-admin-surface-2'
                    }`}
                  >
                    <div className="grid aspect-square place-items-center overflow-hidden rounded-[4px] bg-admin-surface-2">
                      <div className="h-[88%] w-[88%]">
                        <GarmentThumb template={t} colorway={thumbColorway} />
                      </div>
                    </div>
                    <div className="mt-1 truncate text-center text-[11px] font-medium text-admin-text">{t.label}</div>
                  </button>
                );
              })}
            </div>
            {meta.provisional && (
              <p className="mt-2 text-[11px] text-admin-text-faint">
                Generiska plaggmallar (preliminära) — ersätts när tryckeriets riktiga plagg finns.
              </p>
            )}
          </>
        )}
      </CardSection>

      {/* ── 2 · TRYCK & PLACERING — canvas and trycklista SIDE BY SIDE so a
          row and its zone on the garment are one glance apart (critique P1). */}
      <CardSection title="2 · Tryck & placering" bodyClassName="p-4">
        {/* NOTE: track lists use UNDERSCORES ([1fr_360px]) — a comma is not a
            valid CSS grid separator; [1fr,360px] emits an invalid rule the
            browser drops, silently collapsing to one column (shipped bug). */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
          {/* Trycklista — every row OWNS its motif via the inline picker;
              choosing a motif never leaves this panel (critique P0). */}
          <div className="flex min-w-0 flex-col gap-2 lg:order-2">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-admin-text">Tryck på plagget</span>
              {prints.length === 0 && (
                <span className="text-[11px] text-admin-text-faint">Inga tryck ännu</span>
              )}
            </div>

            {prints.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {prints.map((p) => {
                  const art = artworkById(p.artworkId);
                  const active = p.slot === slot;
                  const pickerOpen = motifPickerSlot === p.slot;
                  const label = p.slot === 'pocket'
                    ? `${slotLabel(p.slot)} · ${pocketPositionLabel(pocketPosition)}`
                    : slotLabel(p.slot);
                  return (
                    <li
                      key={p.slot}
                      className={`rounded-[var(--radius-admin-el)] border ${
                        active ? 'border-admin-info-dot bg-admin-info-bg/40' : 'border-admin-border-soft'
                      }`}
                    >
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => { setSlot(p.slot); setMotifPickerSlot(pickerOpen ? null : p.slot); }}
                          aria-expanded={pickerOpen}
                          aria-label={art ? `Byt motiv för ${label}` : `Välj motiv för ${label}`}
                          className="shrink-0"
                        >
                          {art?.previewUrl ? (
                            <img src={art.previewUrl} alt="" className="h-9 w-9 rounded-[4px] border border-admin-border object-cover" />
                          ) : (
                            <span className="grid h-9 w-9 place-items-center rounded-[4px] border border-dashed border-admin-caution-dot text-admin-caution-text">
                              <PhotoIcon className="h-4 w-4" />
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => setSlot(p.slot)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-[12px] font-medium text-admin-text">{label}</span>
                          <span className={`block truncate text-[11px] ${art ? 'text-admin-text-muted' : 'text-admin-caution-text'}`}>
                            {art ? (art.label || art.fileName) : 'Motiv saknas — välj här'}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => { setSlot(p.slot); setMotifPickerSlot(pickerOpen ? null : p.slot); }}
                          aria-expanded={pickerOpen}
                          className="shrink-0 rounded-[var(--radius-admin-el)] border border-admin-border px-2 py-1 text-[11px] text-admin-text hover:bg-admin-surface-2"
                        >
                          {art ? 'Byt motiv' : 'Välj motiv'}
                        </button>
                        <button
                          type="button"
                          onClick={() => removePrint(p.slot)}
                          aria-label={`Ta bort trycket: ${slotLabel(p.slot)}`}
                          className="shrink-0 rounded-[var(--radius-admin-el)] px-1.5 py-1 text-[11px] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-text"
                        >
                          Ta bort
                        </button>
                      </div>

                      {/* INLINE MOTIF PICKER — the motif is chosen IN the row;
                          no scroll round-trip to a distant library list. */}
                      {pickerOpen && (
                        <div className="border-t border-admin-border-soft p-2">
                          {loading ? (
                            <p className="text-[12px] text-admin-text-muted">Laddar original…</p>
                          ) : artwork.length === 0 ? (
                            <p className="text-[12px] text-admin-text-muted">
                              Inga original ännu — ladda upp under fliken Original.
                              Designen ligger kvar här under tiden.
                            </p>
                          ) : (
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1.5">
                              {artwork.map((a) => {
                                const selectable = isSelectableArtwork(a);
                                const isCurrent = a.id === p.artworkId;
                                return (
                                  <button
                                    key={a.id}
                                    type="button"
                                    disabled={!selectable}
                                    onClick={() => setPrintArtwork(p.slot, a.id)}
                                    title={`${a.label || a.fileName}${selectable ? '' : ' — kan inte förhandsgranskas i studion'}`}
                                    className={`relative overflow-hidden rounded-[4px] border ${
                                      isCurrent
                                        ? 'border-admin-info-dot ring-1 ring-admin-info-dot/50'
                                        : 'border-admin-border hover:border-admin-text-faint'
                                    } ${selectable ? '' : 'cursor-not-allowed opacity-40'}`}
                                  >
                                    {a.previewUrl ? (
                                      <img src={a.previewUrl} alt={a.label || a.fileName} className="aspect-square w-full object-cover" />
                                    ) : (
                                      <span className="grid aspect-square w-full place-items-center bg-admin-surface-2 text-admin-text-faint">
                                        <PhotoIcon className="h-4 w-4" />
                                      </span>
                                    )}
                                    {/* Advisory validation tier (WARN/FAIL) as a
                                        caution dot — tiers never block here. */}
                                    {a.validation?.tier && a.validation.tier !== 'pass' && (
                                      <span
                                        className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full border border-admin-surface bg-admin-caution-dot"
                                        title={tierLabel(a.validation.tier)}
                                      />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {slots.some((s) => slotAvailability(s).available) && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-admin-text-muted">Lägg till tryck:</span>
                {slots.map((s) => {
                  const { available, reason } = slotAvailability(s);
                  if (printBySlot[s]) return null;
                  return (
                    <button
                      key={s}
                      type="button"
                      disabled={!available}
                      title={!available ? reason : undefined}
                      onClick={() => addPrint(s)}
                      className="rounded-[var(--radius-admin-el)] border border-admin-border px-2.5 py-1.5 text-[12px] text-admin-text hover:bg-admin-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      + {slotLabel(s)}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Pocket position — discrete choice (left/center/right, wearer's
                perspective); the fixed 10×10 cm spot has no free placement. */}
            {slot === 'pocket' && selectedTemplate?.pocketPositions && (
              <div className="flex flex-wrap items-center gap-2 border-t border-admin-border-soft pt-2">
                <span className="text-[12px] text-admin-text-muted">Fickposition:</span>
                {POCKET_POSITIONS.map((pp) => {
                  const ppActive = pp.id === pocketPosition;
                  return (
                    <button
                      key={pp.id}
                      type="button"
                      onClick={() => {
                        setPocketPosition(pp.id);
                        invalidateComposite(); // the pocket rect moved
                      }}
                      className={`rounded-[var(--radius-admin-el)] px-2.5 py-1 text-[12px] ${
                        ppActive
                          ? 'bg-black/[0.08] font-medium text-admin-text'
                          : 'text-admin-text-muted hover:bg-black/[0.06]'
                      }`}
                    >
                      {pp.label}
                    </button>
                  );
                })}
                <span className="text-[11px] text-admin-text-faint">(sett från bäraren)</span>
              </div>
            )}
          </div>
          <div className="min-w-0 lg:order-1">
            <CompositorCanvas
              template={effTemplate}
              colorway={selectedColorway}
              slot={slot}
              artwork={canvasArtwork}
              profile={profile}
              locked={slot === 'pocket'}
              placement={slot === 'pocket' ? null : (placements[slot] || null)}
              ghostAreas={ghostAreas}
              onGhostClick={setSlot}
              onPlacementChange={(p) => {
                if (slot === 'pocket') return; // locked — geometry is deterministic
                setPlacements((prev) => ({ ...prev, [slot]: p }));
                // Moving the artwork changes the composite: generated mockups
                // are stale (they'd publish the OLD placement while the mapping
                // readout instructs the NEW one) and every colourway must be
                // re-seen.
                invalidateComposite();
              }}
            />
          </div>

        </div>
      </CardSection>

      {/* ── 3 · FÄRGER & MOCKUPER — the review gate lives here; the 3D beta
          sits BELOW the strip so it never buries the gate (critique P1). */}
      <CardSection title="3 · Färger & mockuper" bodyClassName="p-4">
        {selectedTemplate && (
          <ColorwayStrip
            template={effTemplate}
            slot={slot}
            minDpi={profile?.min_dpi ?? null}
            activeColorwayId={colorwayId}
            onSelect={setColorwayId}
            placement={placements[slot] || null}
            locked={slot === 'pocket'}
            resolveArtwork={(cwId) => resolveArtwork(slot, cwId)}
            overrides={overrides[slot] || {}}
            onOverrideChange={printArtwork(slot) ? (cwId, artId) => setOverride(slot, cwId, artId) : null}
            artworkOptions={overrideOptions}
            baseArtworkLabel={printArtwork(slot)?.label || printArtwork(slot)?.fileName || 'Standardmotiv'}
            reviewedColorwayIds={reviewedColorways}
          />
        )}

        {/* 3D-vy (beta): READ-ONLY — follows the live print placement and the
            model's calibrated tuning. WebGL-gated; pixi lazy-loads. */}
        <Studio3DSection
          artwork={resolveArtwork('front', colorwayId)}
          placement={resolveArtwork('front', colorwayId)
            ? effectivePlacementFor('front', resolveArtwork('front', colorwayId))
            : null}
          models={models3d}
        />

        {/* Generated mockups: per-colourway rasterized previews + hero pick. */}
        <MockupPanel
          mockups={mockups}
          heroKey={heroKey}
          onPickHero={setHeroKey}
          onGenerate={generateMockups}
          generating={generating}
          error={mockupError}
          canGenerate={Boolean(selectedTemplate) && designedSlots(selectedTemplate).some((s) => isComposable(printArtwork(s))) && !publishing}
        />
      </CardSection>

      {/* ── 4 · PUBLICERA ─────────────────────────────────────────────────── */}
      <CardSection title="4 · Publicera" bodyClassName="p-4">
        <PublishPanel
          mockups={mockups}
          template={selectedTemplate}
          vatRate={STORE.vatRate}
          hasArtwork={designedSlots(selectedTemplate).length > 0 && prints.every((p) => p.artworkId)}
          printSummary={designedSlots(selectedTemplate).map((s) => ({
            slot: s,
            slotLabel: s === 'pocket'
              ? `${slotLabel(s)} · ${pocketPositionLabel(pocketPosition)}`
              : slotLabel(s),
            artworkLabel: printArtwork(s)?.label || printArtwork(s)?.fileName || '—',
          }))}
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
