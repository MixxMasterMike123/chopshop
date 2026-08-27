// DesignStudio.jsx — the Design Studio tab (POD add-on, Mode A / shop-owner studio).
//
// LAYOUT: eight numbered task pages in one column — 1·Plagg · 2·Tryckytor ·
// 3·Motiv · 4·Placering · 5·Färger · 6·Godkänn · 7·Mockuper ·
// 8·Publicera. The studio stays MOUNTED across PodAdminPage tab switches
// (state survives a trip to the Original tab).
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
  clearPodMockupTemplatesCache,
  getPodMockupTemplatesMeta,
  templateSlots,
} from '../../../config/podMockupTemplates';
import { loadPodProfiles, clearPodProfilesCache, getProfileById } from '../../../config/podProfiles';
import { loadPod3dModels, clearPod3dModelsCache } from '../../../config/pod3dModels';
import { tierLabel } from '../components/podTier';
import { isComposable, placementReadout, defaultPlacement, containPlacement, clampPlacement, templateWithPocketPosition } from './placementMath';
import { renderMockup, createMockupSession } from './mockupRender';
import { uploadMockup } from './mockupUpload';
import TemplateBackground, { viewForSlot, templateViewBox } from './TemplateBackground';
import CompositorCanvas from './CompositorCanvas';
import ColorSelectionPanel from './ColorSelectionPanel';
import ColorwayStrip from './ColorwayStrip';
import MockupPanel from './MockupPanel';
import PublishPanel from './PublishPanel';
import Studio3DSection from './Studio3DSection';
// Publish (slice 4) — create the real product + variants + POD mappings. These
// are the ONLY Firebase-touching imports in the studio; PublishPanel stays
// Firebase-free (presentational) so the dev harness can mount it standalone.
import { collection, addDoc, getDocs, query, where, serverTimestamp, doc, getDoc, updateDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from '../../../firebase/config';
import { withShopId } from '../../../config/withShopId';
import { skuFromName, uniqueSku } from '../../../utils/productUrls';
import { deriveVariantsFromGroups } from '../../../utils/variantDerivation';
import { setMapping } from '../../../utils/podMappings';
import { priceFloor, podCostForSlots } from '../podPricing';
import { STORE } from '../../../config/store';
import { orderedVariantMockupUrls } from './mockupVariantImages';

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

const DesignStudio = ({ artwork = [], loading = false, shopId = null, products = [], onChanged = null, onOpenArtworkLibrary = null, designForProductId = null }) => {
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState(null);
  const [templateLoadAttempt, setTemplateLoadAttempt] = useState(0);
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
  // Colours offered by this design. A template starts with every colour on;
  // step 5 only opts colours out. This state is shared by artwork review,
  // mockup generation and publishing so the steps cannot drift apart.
  const [selectedColorwayIds, setSelectedColorwayIds] = useState(() => new Set());
  // The ACTIVE print row's slot (drives canvas/strip). Reconciled against
  // `prints` — when the list is empty it idles on 'front' with no artwork.
  const [slot, setSlot] = useState('front');
  // WIZARD: one decision at a time, as pages — 1 Plagg · 2 Tryckytor ·
  // 3 Motiv · 4 Placering · 5 Färger · 6 Godkänn · 7 Mockuper ·
  // 8 Publicera. Steps are
  // VIEWS over the same design state, so going back never loses work.
  const [step, setStep] = useState(1);
  const [motifCursor, setMotifCursor] = useState(0); // step 3: index into prints
  const [placeCursor, setPlaceCursor] = useState(0); // step 4: index into prints
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
  // override / artwork / template) so a stale review can't unlock publish.
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
      setTemplatesError(null);
      try {
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
      } catch (error) {
        if (!alive) return;
        console.error('DesignStudio: failed to load studio resources', error);
        setTemplatesError('Plaggmallarna kunde inte laddas. Kontrollera anslutningen och försök igen.');
      } finally {
        if (alive) setTemplatesLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateLoadAttempt]);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || null,
    [templates, selectedTemplateId]
  );

  const retryStudioResources = () => {
    clearPodMockupTemplatesCache();
    clearPodProfilesCache();
    clearPod3dModelsCache();
    setTemplateLoadAttempt((n) => n + 1);
  };

  // Keep the colourway + slot valid whenever the template changes. Design state
  // (placements/overrides/mockups) resets too — it was built against the OLD
  // template's print areas and colourways.
  useEffect(() => {
    if (!selectedTemplate) return;
    const cwIds = (selectedTemplate.colorways || []).map((c) => c.id);
    if (!cwIds.includes(colorwayId)) setColorwayId(cwIds[0] || null);
    setSelectedColorwayIds(new Set(cwIds));
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

  // Surface label for the CURRENT garment. The shared slot vocabulary is
  // apparel-worded ('front' = "Bröst") — wrong on a keps/mössa/tygkasse
  // (Kent bug 2026-08-11). Templates can override per slot via `slotLabels`
  // (seeded on the front-only accessories as "Framsida"); apparel falls
  // through to the shared labels. Print-portal labels (printProjection.ts)
  // still use the shared vocabulary — placement text carries the real info.
  const labelForSlot = (s) => selectedTemplate?.slotLabels?.[s] || slotLabel(s);

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
  // Called per pointermove during drags — every setter bails with the SAME
  // reference when already at the target so React skips those re-renders.
  const invalidateComposite = () => {
    setMockups((prev) => (prev.length ? [] : prev));
    setHeroKey((prev) => (prev === null ? prev : null));
    setReviewedColorways((prev) => {
      if (colorwayId && prev.size === 1 && prev.has(colorwayId)) return prev;
      if (!colorwayId && prev.size === 0) return prev;
      return colorwayId ? new Set([colorwayId]) : new Set();
    });
  };

  const addPrint = (s) => {
    if (!slotAvailability(s).available) return;
    setPrints((prev) => [...prev, { slot: s, artworkId: null }]);
    if (s === 'pocket') setPocketPosition(DEFAULT_POCKET_POSITION);
    setSlot(s);
  };

  const removePrint = (s) => {
    setPrints((prev) => prev.filter((p) => p.slot !== s));
    setPlacements((prev) => { const n = { ...prev }; delete n[s]; return n; });
    setOverrides((prev) => { const n = { ...prev }; delete n[s]; return n; });
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

  const setOverrideForColorways = (forSlot, cwIds, artworkId) => {
    const ids = new Set(cwIds);
    setOverrides((prev) => {
      const slotMap = { ...(prev[forSlot] || {}) };
      ids.forEach((cwId) => {
        if (artworkId) slotMap[cwId] = artworkId;
        else delete slotMap[cwId];
      });
      return { ...prev, [forSlot]: slotMap };
    });
    setMockups([]);
    setHeroKey(null);
    resetReviews();
  };

  const toggleSelectedColorway = (cwId) => {
    const next = new Set(selectedColorwayIds);
    if (next.has(cwId)) next.delete(cwId);
    else next.add(cwId);
    setSelectedColorwayIds(next);
    setMockups([]);
    setHeroKey(null);
    setMockupError(null);
    if (!next.has(colorwayId)) setColorwayId(next.values().next().value || null);
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

  // OTHER designed prints sharing the ACTIVE slot's flat (slot→view mapping =
  // TemplateBackground's viewForSlot, the single source). They render as REAL
  // composites — artwork at its effective placement — so switching rows never
  // makes a designed print "disappear" (bug report 2026-08-10); the dashed
  // rect stays as the clickable row↔garment link (activates that print's row).
  const ghostAreas = designedSlots(selectedTemplate)
    .filter((s) => s !== slot && viewForSlot(s) === viewForSlot(slot))
    .map((s) => {
      const art = resolveArtwork(s, colorwayId);
      return {
        slot: s,
        label: labelForSlot(s),
        rect: effTemplate?.printAreas?.[s] || null,
        artwork: art,
        placement: art ? effectivePlacementFor(s, art) : null,
      };
    })
    .filter((g) => g.rect);

  const generateMockups = async () => {
    // Also blocked while PUBLISHING: regenerating revokes the object URLs the
    // publish loop is mid-fetch on (partial-failure trigger).
    if (!selectedTemplate || generating || publishing) return;
    setGenerating(true);
    setMockupError(null);
    // The full work list is computed UP FRONT so the grid can show every
    // upcoming mockup as a spinner card instantly; each card's image then
    // streams in the moment its render completes (MockupPanel fades it in).
    const jobs = [];
    for (const cw of (selectedTemplate.colorways || []).filter((item) => selectedColorwayIds.has(item.id))) {
      for (const s of designedSlots(selectedTemplate)) {
        const art = resolveArtwork(s, cw.id);
        if (!art || !isComposable(art)) continue;
        jobs.push({ cw, s, art });
      }
    }
    const next = jobs.map(({ cw, s }) => ({
      key: `${cw.id}:${s}`, colorwayId: cw.id, colorwayLabel: cw.label,
      slot: s, objectUrl: null, type: null,
      url: null, storagePath: null,
      pending: true,
    }));
    // State gets COPIES; `next` stays the mutable source of truth this run
    // (uploads write url/storagePath onto its entries) and is re-published
    // into state per completion and once more after the uploads settle.
    setMockups(next.map((e) => ({ ...e })));
    const urls = [];
    const uploadPromises = [];
    let uploadFailures = 0;
    let renderSkips = 0;
    // One shared WebGL compositor for the whole run (colourways × slots) — see
    // createMockupSession: per-mockup contexts both re-process the fabric map
    // every time and can evict the live placement canvas's WebGL context.
    const renderSession = createMockupSession();
    try {
      for (const [i, { cw, s, art }] of jobs.entries()) {
        const entry = next[i];
        // Per-item try/catch: one un-renderable colourway (e.g. a photo
        // template missing that colourway's photo) skips, not aborts —
        // the other colourways' mockups still generate.
        let blob, type;
        try {
          ({ blob, type } = await renderMockup({
            template: effTemplate, colorway: cw, slot: s, minDpi: profile?.min_dpi ?? null,
            artwork: art, placement: effectivePlacementFor(s, art),
            session: renderSession,
          }));
        } catch (e) {
          renderSkips += 1;
          console.warn('DesignStudio: mockup render skipped', cw.id, s, e?.message);
          entry.failed = true;
          setMockups((prev) => prev.filter((m) => m.key !== entry.key));
          continue;
        }
        const objectUrl = URL.createObjectURL(blob);
        urls.push(objectUrl);
        Object.assign(entry, { objectUrl, type, pending: false });
        setMockups((prev) => prev.map((m) => (m.key === entry.key ? { ...entry } : m)));
        // Uploads overlap the remaining renders (fire-and-collect): render
        // stays serial (one canvas rasterization at a time), but the ~0.3-0.8s
        // Storage round-trips no longer serialize the whole generation.
        if (shopId) {
          uploadPromises.push(
            uploadMockup({
              blob, type, shopId,
              templateId: selectedTemplate.id, slot: s, colorwayId: cw.id,
            }).then((uploaded) => {
              entry.url = uploaded?.url || null;
              entry.storagePath = uploaded?.storagePath || null;
            }).catch((e) => {
              uploadFailures += 1;
              console.warn('DesignStudio: mockup upload failed', cw.id, s, e?.message);
            })
          );
        }
      }
      await Promise.all(uploadPromises);
      const done = next.filter((e) => !e.pending && !e.failed);
      replaceObjectUrls(urls);
      setMockups(done.map((e) => ({ ...e })));
      setHeroKey((prev) => (prev && done.some((m) => m.key === prev) ? prev : done[0]?.key || null));
      if (done.length === 0) {
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
      // State already holds this run's placeholder/streamed cards — clear them
      // (the pre-run grid is gone; a half-grid of spinners must not linger).
      setMockups([]);
      setMockupError(e?.message || 'Mockup-genereringen misslyckades.');
    } finally {
      renderSession.close();
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
    // Streaming generation publishes placeholder cards into `mockups` mid-run —
    // publishing then would ship half a grid (null objectUrls crash the fetch).
    if (generating || mockups.some((m) => m.pending)) { setPublishError('Vänta tills alla mockuper är klara.'); return; }

    publishingRef.current = true;
    setPublishing(true);
    let docCreated = false;
    try {
      // PRISGOLV — authoritative re-check in the handler (the UI enforces it
      // too, but the handler is the gate that actually creates a sellable
      // product; podPricing.js is the single formula source).
      {
        // Same cost basis as the stamp below and as PublishPanel's readout: the
        // DESIGNED slots decide the print cost, so the gate can't enforce a
        // cheaper floor than the one the seller was just shown.
        const costP = podCostForSlots(selectedTemplate, publishSlots);
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
        ...(() => {
          const c = podCostForSlots(selectedTemplate, publishSlots);
          return c != null ? { podCostSek: c } : {};
        })(),
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



      setPublishResult({ name: cleanName, sku: resolvedSku });
      onChanged?.();
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

  // ── UPDATE EXISTING PRODUCT (closing the content-first gap, 2026-08-09) ──
  // Attach the generated mockups to an EXISTING product: gallery images, main
  // image (only when missing, unless replaceImages), variant-group images on
  // EXACT colourway-label matches — and, the part that makes it PRINTABLE,
  // the same podMappings rows the create flow writes, keyed on the product's
  // own sku. Variants/prices/copy stay untouched (no variant surgery in v1).
  const updateProduct = async ({ productId, selectedColorwayIds, replaceImages }) => {
    if (publishing || publishingRef.current) return;
    setPublishError(null);
    setPublishResult(null);
    if (!shopId) { setPublishError('Ingen butik är vald.'); return; }
    const publishSlots = designedSlots(selectedTemplate);
    if (publishSlots.length === 0) { setPublishError('Lägg till minst ett tryck med motiv innan du publicerar.'); return; }
    if (prints.some((p) => !p.artworkId)) { setPublishError('Ett tryck saknar motiv — välj motiv för raden eller ta bort den.'); return; }
    if (prints.some((p) => p.artworkId && !artworkById(p.artworkId))) {
      setPublishError('Ett valt motiv finns inte längre i biblioteket — välj ett nytt motiv för trycket.');
      return;
    }
    const selectedSet = new Set(selectedColorwayIds || []);
    if (selectedSet.size === 0) { setPublishError('Välj minst en färg.'); return; }
    const pubMockups = mockups.filter((m) => selectedSet.has(m.colorwayId));
    if (pubMockups.length === 0) { setPublishError('Inga mockuper för de valda färgerna — generera om.'); return; }
    if (generating || pubMockups.some((m) => m.pending)) { setPublishError('Vänta tills alla mockuper är klara.'); return; }

    publishingRef.current = true;
    setPublishing(true);
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
            slotLabel: labelForSlot(s),
            placement: isPocket ? `${posLabel} · ${readoutO}` : readoutO,
            placementSlot: s,
            ...(isPocket ? { position: pocketPosition } : {}),
          }));
        }
      }
      await Promise.all(writes);

      // Same POD stamps as the create path — an existing product that gets a
      // studio design IS a POD product from now on. costU (computed for the
      // floor gate above) is the DESIGNED-slot cost: plagg + tryck per tryckt
      // yta + plattformsuttaget, så fram+bak stämplar mer än bara fram.
      updates.isPodProduct = true;
      if (costU != null) updates.podCostSek = costU;
      await updateDoc(prodRef, updates);
      docTouched = true;



      setPublishResult({
        name: prod.name || '(namnlös produkt)',
        sku: prod.sku || '',
        updated: true,
      });
      onChanged?.();
    } catch (e) {
      console.error('DesignStudio: update product failed', e);
      setPublishError(docTouched
        ? 'Bilderna lades till men tryckkopplingen kan vara ofullständig. Kontrollera produkten och försök igen.'
        : (e?.message || 'Uppdateringen misslyckades.'));
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

  // ── Wizard chrome: gates + navigation ─────────────────────────────────────
  // A step is enterable once every earlier step is done; completed steps stay
  // clickable (the pages are views over shared state — going back loses nothing).
  const s1done = Boolean(selectedTemplateId);
  const s2done = prints.length > 0;
  const s3done = s2done && prints.every((p) => p.artworkId);
  const selectedColorways = (selectedTemplate?.colorways || [])
    .filter((cw) => selectedColorwayIds.has(cw.id));
  const s5done = selectedColorways.length > 0;
  const s6done = s5done && selectedColorways.every((cw) => reviewedColorways.has(cw.id));
  // Pending (streaming) cards don't count — step 7 is done when every selected
  // colourway has a FINISHED mockup, not a spinner placeholder.
  const mockupColorwayIds = new Set(mockups.filter((m) => !m.pending).map((m) => m.colorwayId));
  const s7done = s6done && !generating && selectedColorways.every((cw) => mockupColorwayIds.has(cw.id));
  const STEP_META = [
    { n: 1, label: 'Plagg', done: s1done },
    { n: 2, label: 'Tryckytor', done: s2done },
    { n: 3, label: 'Motiv', done: s3done },
    { n: 4, label: 'Placering', done: s3done }, // auto-placement = always valid
    { n: 5, label: 'Färger', done: s5done },
    { n: 6, label: 'Godkänn', done: s6done },
    { n: 7, label: 'Mockuper', done: s7done },
    { n: 8, label: 'Publicera', done: Boolean(publishResult) },
  ];
  const canEnterStep = (n) => STEP_META.slice(0, n - 1).every((m) => m.done);
  const goStep = (n) => {
    if (n < 1 || n > 8 || !canEnterStep(n)) return;
    // Entering a one-surface-at-a-time page: land the cursor somewhere useful
    // (first motif-less surface for Motiv; clamped last position for
    // Placering) and point the canvas/strip at that row's slot.
    if (n === 3) {
      const firstEmpty = prints.findIndex((p) => !p.artworkId);
      const i = firstEmpty >= 0 ? firstEmpty : Math.min(motifCursor, Math.max(0, prints.length - 1));
      setMotifCursor(i);
      if (prints[i]) setSlot(prints[i].slot);
    }
    if (n === 4) {
      const i = Math.min(placeCursor, Math.max(0, prints.length - 1));
      setPlaceCursor(i);
      if (prints[i]) setSlot(prints[i].slot);
    }
    setStep(n);
  };
  // Surface cursors (steps 3 & 4 walk the prints ONE at a time, in list order —
  // "bröst först, sedan rygg, sist ärm"). Clamped against list edits.
  const mi = Math.min(motifCursor, Math.max(0, prints.length - 1));
  const pi = Math.min(placeCursor, Math.max(0, prints.length - 1));
  const goMotif = (i) => { const p = prints[i]; if (!p) return; setMotifCursor(i); setSlot(p.slot); };
  const goPlace = (i) => { const p = prints[i]; if (!p) return; setPlaceCursor(i); setSlot(p.slot); };
  // Picking a motif auto-advances to the next motif-less surface (still one
  // decision at a time — the next decision just presents itself).
  const pickMotif = (art) => {
    const cur = prints[mi];
    if (!cur) return;
    setPrintArtwork(cur.slot, art.id);
    const nextIdx = prints.findIndex((p, j) => j !== mi && !p.artworkId);
    if (nextIdx >= 0) goMotif(nextIdx);
  };

  // Segmented surface switcher (steps 3/4/6). The old free-floating text pills
  // were easy to miss on dual-surface garments ("Bröst/Rygg cta pretty obscure",
  // Mikael 2026-08-17) — this is a proper segmented control: equal-width
  // segments in a recessed track, the active one carried by a raised thumb
  // that SLIDES between surfaces (continuity: same garment, different side).
  // items: [{ key, label, done? }] — done renders the ✓ completion mark.
  const SurfaceSwitcher = ({ items, activeIndex, onSelect, ariaLabel }) => {
    if (items.length < 2) return null;
    return (
      <div
        role="group"
        aria-label={ariaLabel}
        className="relative mb-3 grid w-full max-w-[520px] rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 p-1"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        <span
          aria-hidden="true"
          className="pod-thumb absolute inset-y-1 left-1 rounded-[calc(var(--radius-admin-el)-4px)] bg-admin-surface shadow-[var(--shadow-admin)]"
          style={{
            width: `calc((100% - 8px) / ${items.length})`,
            transform: `translateX(${activeIndex * 100}%)`,
          }}
        />
        {items.map((it, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => onSelect(i)}
              aria-pressed={active}
              className={`relative z-10 min-h-10 truncate px-3 text-center text-[13px] transition-colors duration-150 ${
                active ? 'font-medium text-admin-text' : 'text-admin-text-muted hover:text-admin-text'
              }`}
            >
              {it.done && <span className="pod-pop mr-1 inline-block text-admin-success-text">✓</span>}
              {it.label}
            </button>
          );
        })}
      </div>
    );
  };

  // Shared step-footer nav (Tillbaka · primary Klar/Nästa).
  const StepNav = ({ nextLabel, nextEnabled, onNext, hint = null }) => (
    <div className="mt-5 border-t border-admin-border-soft pt-4">
      {hint && !nextEnabled && (
        <p className="mb-3 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text" role="status">
          För att fortsätta: {hint}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {step > 1 && (
          <button
            type="button"
            onClick={() => goStep(step - 1)}
            className="min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3.5 py-2 text-[13px] text-admin-text hover:bg-admin-surface-2"
          >
            ‹ Tillbaka
          </button>
        )}
        {nextLabel && (
          <button
            type="button"
            onClick={onNext}
            disabled={!nextEnabled}
            className="min-h-10 rounded-[var(--radius-admin-el)] bg-admin-primary px-4 py-2 text-[13px] font-medium text-white dark:text-admin-bg hover:bg-admin-primary-hover disabled:cursor-default disabled:opacity-40"
          >
            {nextLabel} ›
          </button>
        )}
      </div>
    </div>
  );

  // A state edit can retro-invalidate the CURRENT page's prerequisites
  // (a template switch drops print rows; page 2 can empty the trycklistan):
  // fall back to the deepest still-enterable page instead of a locked one.
  useEffect(() => {
    if (canEnterStep(step)) return;
    let n = step - 1;
    while (n > 1 && !canEnterStep(n)) n -= 1;
    setStep(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, s1done, s2done, s3done, s5done, s6done, s7done]);

  const designForProduct = designForProductId
    ? products.find((p) => p.id === designForProductId) || null
    : null;
  const currentStep = STEP_META[step - 1];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-[16px] font-semibold text-admin-text">Designstudio</h2>
            <p className="mt-1 max-w-[70ch] text-[13px] text-admin-text-muted">
              Bygg produkten steg för steg. Du kan alltid gå tillbaka utan att förlora dina val.
            </p>
          </div>
          <span className="text-[12px] text-admin-text-muted">Steg {step} av 8</span>
        </div>
        <p className="mt-3 text-[13px] text-admin-text">
          <span className="font-medium">Nu: {currentStep.label}.</span>{' '}
          {step === 1 && 'Välj produkten som motivet ska tryckas på.'}
          {step === 2 && 'Välj en eller flera ytor som ska få tryck.'}
          {step === 3 && 'Välj ett motiv för varje tryckyta.'}
          {step === 4 && 'Kontrollera placeringen; standardplaceringen är redan redo.'}
          {step === 5 && 'Behåll bara de färger som ska säljas.'}
          {step === 6 && 'Kontrollera att motivet fungerar på varje vald färg.'}
          {step === 7 && 'Skapa produktbilder och välj huvudbild.'}
          {step === 8 && 'Kontrollera uppgifterna och skapa eller uppdatera produkten.'}
        </p>
      </div>
      {/* Way-2 deep link (from the product form): the whole session designs FOR
          an existing product — say so up front, and PublishPanel preselects it. */}
      {designForProductId && (
        <div className="rounded-[var(--radius-admin)] border border-admin-info-dot/40 bg-admin-info-bg px-4 py-3 text-[13px] text-admin-info-text">
          <span className="font-semibold">
            Du designar för: {designForProduct?.name || 'vald produkt'}.
          </span>{' '}
          Bilderna och trycket kopplas till produkten i steg 8 · Publicera
          (förvalt som mål — du kan ändra det där).
        </div>
      )}

      {/* Wizard chrome — persistent step header: ✓ done (clickable to revisit),
          current, or locked (dimmed until every earlier gate is met). Steps
          are VIEWS over shared state — no routes, tab switches lose nothing. */}
      <div className="flex flex-wrap items-center gap-1.5" role="navigation" aria-label="Designstudions steg">
        {STEP_META.map((m) => {
          const current = m.n === step;
          const enterable = canEnterStep(m.n);
          return (
            <button
              key={m.n}
              type="button"
              onClick={() => goStep(m.n)}
              disabled={!enterable}
              aria-current={current ? 'step' : undefined}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition ${
                current
                  ? 'border-admin-info-dot bg-admin-info-bg font-medium text-admin-info-text'
                  : enterable
                    ? 'border-admin-border text-admin-text hover:bg-admin-surface-2'
                    : 'cursor-default border-admin-border-soft text-admin-text-faint'
              }`}
            >
              <span
                className={`grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-semibold ${
                  m.done && !current
                    ? 'bg-admin-success-bg text-admin-success-text'
                    : current
                      ? 'bg-admin-info-dot text-white'
                      : 'bg-admin-surface-2 text-admin-text-muted'
                }`}
              >
                {m.done && !current ? '✓' : m.n}
              </span>
              {m.label}
            </button>
          );
        })}
      </div>

      {/* ── 1 · PLAGG — page 1 of the wizard (Kents kedja 2026-08-10): the
          one-time garment choice, compact cards (critique P2). */}
      {step === 1 && (
      <CardSection title="1 · Plagg" className="pod-step-enter" bodyClassName="p-4">
        {templatesLoading ? (
          <p className="text-[13px] text-admin-text-muted">Laddar mallar…</p>
        ) : templatesError ? (
          <div className="rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-3">
            <p className="text-[13px] text-admin-caution-text">{templatesError}</p>
            <button type="button" onClick={retryStudioResources} className="mt-2 min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-2 text-[13px] font-medium text-admin-text hover:bg-admin-surface-2">
              Försök igen
            </button>
          </div>
        ) : templates.length === 0 ? (
          <div className="rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-3">
            <p className="text-[13px] text-admin-caution-text">
              Inga plaggmallar kunde hämtas. Försök igen eller kontakta plattformsadministratören om problemet kvarstår.
            </p>
            <button type="button" onClick={retryStudioResources} className="mt-2 min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-2 text-[13px] font-medium text-admin-text hover:bg-admin-surface-2">
              Försök igen
            </button>
          </div>
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
                    aria-pressed={active}
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
              <p className="mt-2 text-[11px] text-admin-text-muted">
                Generiska plaggmallar (preliminära) — ersätts när tryckeriets riktiga plagg finns.
              </p>
            )}
          </>
        )}
        <StepNav nextLabel="Nästa: Tryckytor" nextEnabled={s1done} onNext={() => goStep(2)} hint="Välj ett plagg" />
      </CardSection>
      )}

      {/* ── 2 · TRYCKYTOR — big toggle cards, one per physical surface. The
          bröst+ficka collision (beslut 1) is explained ON the blocked card. */}
      {step === 2 && (
      <CardSection title="2 · Tryckytor" className="pod-step-enter" bodyClassName="p-4">
        <p className="text-[13px] text-admin-text-muted">
          Välj var på produkten det ska tryckas. Varje yta blir ett eget tryck med eget motiv.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {slots.map((s) => {
            const row = printBySlot[s];
            const selected = Boolean(row);
            const { available, reason } = slotAvailability(s);
            const blocked = !selected && !available;
            const art = row ? artworkById(row.artworkId) : null;
            const mm = selectedTemplate?.printAreaMm?.[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => (selected ? removePrint(s) : addPrint(s))}
                disabled={blocked}
                aria-pressed={selected}
                title={blocked ? reason : undefined}
                className={`rounded-[var(--radius-admin-el)] border p-3 text-left transition ${
                  selected
                    ? 'border-admin-info-dot bg-admin-info-bg/40 ring-1 ring-admin-info-dot/40 dark:bg-admin-surface-2'
                    : blocked
                      ? 'cursor-not-allowed border-admin-border-soft opacity-50'
                      : 'border-admin-border hover:bg-admin-surface-2'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-admin-text">{labelForSlot(s)}</span>
                  {selected && <span className="pod-pop shrink-0 text-[11px] font-medium text-admin-info-text">✓ Valt</span>}
                </span>
                <span className={`mt-0.5 block text-[11px] ${blocked ? 'text-admin-caution-text' : 'text-admin-text-muted'}`}>
                  {blocked
                    ? reason
                    : art
                      ? `Motiv: ${art.label || art.fileName}`
                      : mm
                        ? `Yta upp till ${Math.round(mm.w / 10)} × ${Math.round(mm.h / 10)} cm`
                        : 'Egen tryckyta'}
                </span>
              </button>
            );
          })}
        </div>
        <StepNav nextLabel="Nästa: Motiv" nextEnabled={s2done} onNext={() => goStep(3)} hint="Välj minst en tryckyta" />
      </CardSection>
      )}

      {/* ── 3 · MOTIV — ONE surface at a time (Kents kedja): full-width motif
          grid for the cursor's surface, chips to jump between surfaces (✓ =
          has motif), and a pick auto-advances to the next motif-less surface. */}
      {step === 3 && prints[mi] && (
      <CardSection title="3 · Motiv" className="pod-step-enter" bodyClassName="p-4">
        <SurfaceSwitcher
          ariaLabel="Byt tryckyta"
          items={prints.map((p) => ({
            key: p.slot, label: labelForSlot(p.slot), done: Boolean(p.artworkId),
          }))}
          activeIndex={mi}
          onSelect={goMotif}
        />
        <p className="text-[13px] font-semibold text-admin-text">
          Motiv för {labelForSlot(prints[mi].slot)}{prints.length > 1 ? ` — ${mi + 1} av ${prints.length}` : ''}
        </p>
        {loading ? (
          <p className="mt-2 text-[13px] text-admin-text-muted">Laddar original…</p>
        ) : artwork.length === 0 ? (
          <div className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-surface-2 px-3 py-3">
            <p className="text-[13px] text-admin-text-muted">
              Inga godkända original finns ännu. Ladda upp en PNG eller JPG; designen ligger kvar här under tiden.
            </p>
            {onOpenArtworkLibrary && (
              <button type="button" onClick={onOpenArtworkLibrary} className="mt-2 min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-2 text-[13px] font-medium text-admin-text hover:bg-admin-surface">
                Gå till Original
              </button>
            )}
          </div>
        ) : !artwork.some(isSelectableArtwork) ? (
          <div className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-3">
            <p className="text-[13px] text-admin-caution-text">
              Originalen kan inte förhandsvisas i studion. Ladda upp en godkänd PNG eller JPG med bildmått.
            </p>
            {onOpenArtworkLibrary && (
              <button type="button" onClick={onOpenArtworkLibrary} className="mt-2 min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-2 text-[13px] font-medium text-admin-text hover:bg-admin-surface">
                Gå till Original
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
            {artwork.map((a) => {
              const selectable = isSelectableArtwork(a);
              const isCurrent = a.id === prints[mi].artworkId;
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={!selectable}
                  onClick={() => pickMotif(a)}
                  aria-pressed={isCurrent}
                  aria-label={`${a.label || a.fileName}${a.validation?.tier && a.validation.tier !== 'pass' ? ` — ${tierLabel(a.validation.tier)}` : ''}${selectable ? '' : ' — kan inte förhandsgranskas'}`}
                  title={`${a.label || a.fileName}${selectable ? '' : ' — kan inte förhandsgranskas i studion'}`}
                  className={`relative overflow-hidden rounded-[var(--radius-admin-el)] border p-1 text-left ${
                    isCurrent
                      ? 'border-admin-info-dot ring-1 ring-admin-info-dot/50'
                      : 'border-admin-border hover:border-admin-text-faint'
                  } ${selectable ? '' : 'cursor-not-allowed opacity-40'}`}
                >
                  {a.previewUrl ? (
                    <img src={a.previewUrl} alt="" loading="lazy" decoding="async" className="aspect-square w-full rounded-[4px] object-cover" />
                  ) : (
                    <span className="grid aspect-square w-full place-items-center rounded-[4px] bg-admin-surface-2 text-admin-text-muted">
                      <PhotoIcon className="h-4 w-4" />
                    </span>
                  )}
                  <span className="mt-1 block truncate text-[11px] text-admin-text">{a.label || a.fileName}</span>
                  {/* Advisory validation tier (WARN/FAIL) as a caution dot —
                      tiers never block here (podValidation's contract). */}
                  {a.validation?.tier && a.validation.tier !== 'pass' && (
                    <span
                      className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full border border-admin-surface bg-admin-caution-dot"
                      title={tierLabel(a.validation.tier)}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
        <StepNav nextLabel="Nästa: Placering" nextEnabled={s3done} onNext={() => goStep(4)} hint="Alla ytor behöver ett motiv" />
      </CardSection>
      )}

      {/* ── 4 · PLACERING — ONE print at a time in list order; the canvas
          composites ALL designed prints on the flat (d004250). Pocket rows get
          the discrete position picker ONLY (beslut 2 — no free placement). */}
      {step === 4 && prints[pi] && (
      <CardSection title="4 · Placering" className="pod-step-enter" bodyClassName="p-4">
        <p className="mb-3 text-[13px] text-admin-text-muted">
          Standardplaceringen är klar att använda. Dra eller ändra storlek bara om du vill justera resultatet.
        </p>
        <SurfaceSwitcher
          ariaLabel="Byt tryckyta"
          items={prints.map((p) => ({
            key: p.slot,
            label: p.slot === 'pocket'
              ? `${labelForSlot(p.slot)} · ${pocketPositionLabel(pocketPosition)}`
              : labelForSlot(p.slot),
          }))}
          activeIndex={pi}
          onSelect={goPlace}
        />
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-semibold text-admin-text">
            Placering för {labelForSlot(prints[pi].slot)}{prints.length > 1 ? ` — ${pi + 1} av ${prints.length}` : ''}
          </p>
          {/* Colour switcher for the WORKING canvas — pick which colourway the
              placement is previewed on (photo templates make this matter: white
              vs svart is a different backdrop). Same colorwayId state as step
              5's strip; the full review gate still lives there. */}
          {(selectedTemplate?.colorways || []).length > 1 && (
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Förhandsvisningsfärg">
              {(selectedTemplate?.colorways || []).map((cw) => {
                const cwActive = cw.id === colorwayId;
                return (
                  <button
                    key={cw.id}
                    type="button"
                    onClick={() => setColorwayId(cw.id)}
                    aria-pressed={cwActive}
                    aria-label={`Visa på ${cw.label}`}
                    title={cw.label}
                    className={`grid h-6 w-6 place-items-center rounded-full border transition ${
                      cwActive ? 'border-admin-info-dot ring-2 ring-admin-info-dot/40' : 'border-admin-border hover:border-admin-text-faint'
                    }`}
                  >
                    <span
                      className="h-4 w-4 rounded-full border border-black/10"
                      style={{ backgroundColor: cw.hex || '#ffffff' }}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {prints[pi].slot === 'pocket' ? (
          <div className="flex flex-col gap-2">
            {/* Pocket position — discrete choice (left/center/right, wearer's
                perspective); the fixed 10×10 cm spot has no free placement. */}
            <div className="flex flex-wrap items-center gap-2">
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
                    aria-pressed={ppActive}
                    className={`rounded-[var(--radius-admin-el)] px-2.5 py-1.5 text-[12px] ${
                      ppActive
                        ? 'bg-admin-surface-3 font-medium text-admin-text'
                        : 'text-admin-text-muted hover:bg-admin-surface-2'
                    }`}
                  >
                    {pp.label}
                  </button>
                );
              })}
              <span className="text-[11px] text-admin-text-muted">(sett från bäraren)</span>
            </div>
            <p className="text-[12px] text-admin-text-muted">
              Fickmotivet placeras automatiskt i vald position — fast yta 10 × 10 cm, ingen fri dragning.
            </p>
          </div>
        ) : (
          <CompositorCanvas
            template={effTemplate}
            colorway={selectedColorway}
            slot={slot}
            artwork={canvasArtwork}
            profile={profile}
            locked={false}
            // FLAT here on purpose: while POSITIONING, the fabric morph fights
            // the eye — a straight edge the wrinkles bend reads as a placement
            // error. Step 6 (Godkänn), the preview and the exported mockups
            // still show the warped truth.
            flat
            placement={placements[slot] || null}
            ghostAreas={ghostAreas}
            onGhostClick={(s) => {
              const i = prints.findIndex((p) => p.slot === s);
              if (i >= 0) goPlace(i);
            }}
            onPlacementChange={(p) => {
              setPlacements((prev) => ({ ...prev, [slot]: p }));
              // Moving the artwork changes the composite: generated mockups
              // are stale (they'd publish the OLD placement while the mapping
              // readout instructs the NEW one) and every colourway must be
              // re-seen.
              invalidateComposite();
            }}
          />
        )}
        <StepNav
          nextLabel={pi < prints.length - 1 ? 'Klar — nästa tryck' : 'Nästa: Färger'}
          nextEnabled={s3done}
          onNext={() => (pi < prints.length - 1 ? goPlace(pi + 1) : goStep(5))}
        />
      </CardSection>
      )}

      {/* ── 5 · FÄRGER — choose the sellable colour range before artwork
          variants and mockups. Every template colour starts selected. */}
      {step === 5 && (
      <CardSection title="5 · Färger" className="pod-step-enter" bodyClassName="p-4">
        <ColorSelectionPanel
          template={selectedTemplate}
          selectedColorwayIds={selectedColorwayIds}
          onToggle={toggleSelectedColorway}
        />
        <StepNav nextLabel="Nästa: Godkänn" nextEnabled={s5done} onNext={() => goStep(6)} hint="välj minst en färg" />
      </CardSection>
      )}

      {/* ── 6 · MOTIV PER FÄRG — review selected combinations, set explicit
          per-colour overrides and surface advisory contrast warnings. */}
      {step === 6 && (
      <CardSection title="6 · Godkänn" className="pod-step-enter" bodyClassName="p-4">
        <p className="mb-3 text-[13px] text-admin-text-muted">
          Granska varje färg innan mockuperna skapas. Byt motiv för en viss färg om kontrasten inte fungerar.
        </p>
        <SurfaceSwitcher
          ariaLabel="Förhandsvisa yta"
          items={designedSlots(selectedTemplate).map((s) => ({ key: s, label: labelForSlot(s) }))}
          activeIndex={Math.max(0, designedSlots(selectedTemplate).indexOf(slot))}
          onSelect={(i) => setSlot(designedSlots(selectedTemplate)[i])}
        />
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
            baseArtwork={printArtwork(slot)}
            baseArtworkLabel={printArtwork(slot)?.label || printArtwork(slot)?.fileName || 'Standardmotiv'}
            reviewedColorwayIds={reviewedColorways}
            colorwayIds={[...selectedColorwayIds]}
            onApplyOverrideToColorways={printArtwork(slot)
              ? (cwIds, artId) => setOverrideForColorways(slot, cwIds, artId)
              : null}
            onApproveAll={() => setReviewedColorways(new Set(selectedColorwayIds))}
          />
        )}
        <StepNav nextLabel="Nästa: Mockuper" nextEnabled={s6done} onNext={() => goStep(7)} hint="Granska varje vald färg" />
      </CardSection>
      )}

      {/* ── 7 · MOCKUPER — only selected colourways are generated. */}
      {step === 7 && (
      <CardSection title="7 · Mockuper" className="pod-step-enter" bodyClassName="p-4">
        {/* Generated mockups are the main task and the studio's first concrete
            output, so keep this action before the optional 3D preview. */}
        <MockupPanel
          mockups={mockups}
          heroKey={heroKey}
          aspectRatio={(() => { const vb = templateViewBox(effTemplate); return vb ? vb.w / vb.h : null; })()}
          onPickHero={setHeroKey}
          onGenerate={generateMockups}
          generating={generating}
          error={mockupError}
          canGenerate={s6done && Boolean(selectedTemplate) && designedSlots(selectedTemplate).some((s) => isComposable(printArtwork(s))) && !publishing}
        />

        {/* 3D-vy (beta): follows the live print placement; pixi lazy-loads.
            APPAREL ONLY — the 3D model library depicts garments (tees), so a
            keps/mössa/tygkasse motif would render onto a t-shirt photo, which
            is a lie. Heuristic: every apparel template defines a 'back' slot;
            the front-only accessories don't. Replace with an explicit
            template↔model link when the model library grows. */}
        {slots.includes('back') && (
          <Studio3DSection
            artwork={resolveArtwork('front', colorwayId)}
            placement={resolveArtwork('front', colorwayId)
              ? effectivePlacementFor('front', resolveArtwork('front', colorwayId))
              : null}
            models={models3d}
          />
        )}

        <StepNav nextLabel="Nästa: Publicera" nextEnabled={s7done} onNext={() => goStep(8)} hint="Generera en mockup för varje vald färg" />
      </CardSection>
      )}

      {/* ── 8 · PUBLICERA ─────────────────────────────────────────────────── */}
      {step === 8 && (
      <CardSection title="8 · Publicera" className="pod-step-enter" bodyClassName="p-4">
        <PublishPanel
          mockups={mockups}
          template={selectedTemplate}
          vatRate={STORE.vatRate}
          hasArtwork={designedSlots(selectedTemplate).length > 0 && prints.every((p) => p.artworkId)}
          printSummary={designedSlots(selectedTemplate).map((s) => ({
            slot: s,
            slotLabel: s === 'pocket'
              ? `${labelForSlot(s)} · ${pocketPositionLabel(pocketPosition)}`
              : labelForSlot(s),
            artworkLabel: printArtwork(s)?.label || printArtwork(s)?.fileName || '—',
          }))}
          shopId={shopId}
          publishing={publishing}
          result={publishResult}
          error={publishError}
          reviewedColorwayIds={reviewedColorways}
          selectedColorwayIds={[...selectedColorwayIds]}
          onPublish={publish}
          products={products}
          onUpdateExisting={updateProduct}
          initialTargetProductId={designForProductId}
          onReset={resetPublishForm}
        />
        <StepNav nextLabel={null} nextEnabled={false} onNext={() => {}} />
      </CardSection>
      )}
    </div>
  );
};

export default DesignStudio;
