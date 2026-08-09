// Studio3DSection.jsx — the "3D-vy (beta)" of the Design Studio: the 2.5D
// photo-displacement mockup rendered with the seller's REAL library artwork and
// the studio's live front placement (position/scale/rotation in mm — the same
// object the flat canvas edits).
//
// READ-ONLY BY DESIGN (slice C, decided 2026-08-08): sellers get NO placement
// or appearance controls here. The render always follows the flat canvas's
// print placement, and tuning comes from the platform-calibrated model
// (pod3dModels defaults + perColorway overrides, edited in ModelEditor).
// Rationale: these renders can be downloaded and added to the customer-facing
// product gallery — if the seller could move/style the motif in 3D, the
// published photo could show a placement that will never be printed.
//
// GATES:
//   • WebGL — the displacement warp needs it; without WebGL Pixi silently falls
//     back to Canvas2D and SKIPS the filter, which would show an unwarped fake.
//     No WebGL → honest hint instead of the toggle.
//   • A 3D garment config must exist (displacement3dConfig; photo+map registered).
//
// pixi.js loads lazily: DisplacementPreview is React.lazy'd, so its chunk is
// fetched only when the seller opens the 3D view.
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { DEV_3D_GARMENTS } from './pixi/displacement3dConfig';
import { defaultPlacement } from './placementMath';

const DisplacementPreview = React.lazy(() => import('./pixi/DisplacementPreview'));

// A colourway is render-ready only if it carries BOTH a photo and a displacement
// map — a half-configured colourway (either missing) would break the compositor.
const colorwayReady = (cw) => Boolean(cw && cw.photoUrl && cw.displacementUrl);

// Render-ready colourway keys of a garment's front view, sorted by Swedish label
// (falling back to the key). Never assumes 'white'.
const readyColorwayIds = (garment) => {
  const cws = garment?.views?.front?.colorways || {};
  return Object.keys(cws)
    .filter((k) => colorwayReady(cws[k]))
    .sort((a, b) =>
      String(cws[a]?.label || a).localeCompare(String(cws[b]?.label || b), 'sv'));
};

// A model reaches the compositor only when its front view has real dimensions, a
// physical print area, a CALIBRATED px print area (a zero rect renders the motif
// into nothing — photo shows, artwork invisible), AND at least one render-ready
// colourway. The platform console can hold half-configured models — this guard
// keeps them out of the picker (and away from pixi) entirely.
const renderReady = (models = []) =>
  (Array.isArray(models) ? models : []).filter((m) => {
    const v = m?.views?.front;
    const pa = m?.printAreaMm?.front;
    return v?.w && v?.h && v?.printArea?.w > 0 && v?.printArea?.h > 0 &&
      pa?.w > 0 && pa?.h > 0 && readyColorwayIds(m).length > 0;
  });

const hasWebGL = () => {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
};

/**
 * Props:
 *   artwork    — the artwork doc to composite (front slot's resolved artwork)
 *   placement  — the FRONT slot's print placement; the 3D view FOLLOWS it live
 *                (read-only — nothing here can diverge from what gets printed)
 */
const Studio3DSection = ({ artwork = null, placement = null, models = [] }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const previewRef = useRef(null);
  const webgl = useMemo(hasWebGL, []);

  // ("Lägg till i produkt" RETIRED 2026-08-09: attaching imagery to products —
  // new or existing — is unified in the Publicera step; the 3D section only
  // renders and downloads.)

  // GARMENT SOURCE: the platform-managed library models that are render-ready.
  // In DEV builds, fall back to the hardcoded dev garment so the harness/local
  // studio still renders before any model is seeded; in PROD an empty library
  // hides the whole section (return null below).
  const garments = useMemo(() => {
    const usable = renderReady(models);
    return usable.length ? usable : (import.meta.env.DEV ? DEV_3D_GARMENTS : []);
  }, [models]);

  // Selected model — reconciled with a fallback so a disappearing id (library
  // load / edit) never leaves us pointing at nothing.
  const [modelId, setModelId] = useState(() => garments[0]?.id || null);
  const garment = garments.find((g) => g.id === modelId) || garments[0] || null;

  // Render-ready colourways of the SELECTED model (never hardcode 'white').
  const colorwayIds = useMemo(() => (garment ? readyColorwayIds(garment) : []), [garment]);
  const [colorwayId, setColorwayId] = useState(() => colorwayIds[0] || null);

  // Reconcile the selected model when the library loads/changes (id vanished →
  // snap to the first available garment).
  useEffect(() => {
    if (garments.length && !garments.some((g) => g.id === modelId)) {
      setModelId(garments[0].id);
    }
  }, [garments, modelId]);

  // Reconcile the selected colourway on model switch: if the current colourway
  // isn't render-ready in the (new) model, snap to its first.
  useEffect(() => {
    if (colorwayIds.length && !colorwayIds.includes(colorwayId)) {
      setColorwayId(colorwayIds[0]);
    }
  }, [colorwayIds, colorwayId]);

  // Effective colourway: always valid for the CURRENT garment, even during the
  // one render where the reconcile effect above hasn't snapped colorwayId yet
  // (prevents a compositorConfigFor-null error flash on model switch).
  const effColorwayId = colorwayIds.includes(colorwayId) ? colorwayId : (colorwayIds[0] || null);

  // Tuning is READ-ONLY, derived from the platform-calibrated model: garment
  // defaults with the per-colourway overrides merged over them (both edited in
  // the platform ModelEditor). No live seller overrides.
  const tuning = useMemo(() => {
    const per = garment?.perColorway?.[effColorwayId] || {};
    return {
      displacementScale: per.displacementScale ?? garment?.displacementScale ?? 30,
      displacementContrast: per.displacementContrast ?? garment?.displacementContrast ?? 1,
      alpha: per.alpha ?? garment?.alpha ?? 0.8,
      blend: per.blend ?? garment?.blend ?? 'multiply',
    };
  }, [garment, effColorwayId]);

  if (garments.length === 0 || !garment) return null;

  // The render FOLLOWS the flat canvas's print placement live (DesignStudio
  // passes the same effective placement the mockups/publish use). The fallback
  // only covers a missing placement and derives it the same way the flat
  // canvas would (aspect-fitted defaultPlacement against the model's area) —
  // never an invented width that could overflow what actually prints.
  const effectivePlacement = placement || defaultPlacement(garment, 'front', artwork, null);

  const downloadPNG = async () => {
    setBusy(true);
    try {
      const blob = await previewRef.current.extractPNG();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `3d-mockup.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      console.warn('Studio3DSection: extract failed', e?.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-admin-border-soft pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-[12px] font-medium text-admin-text">3D-vy</span>
          <span className="ml-1.5 rounded-full bg-admin-info-bg px-1.5 py-0.5 text-[11px] font-medium text-admin-info-text">beta</span>
          <span className="ml-2 text-[11px] text-admin-text-muted">
            Motivet följer tygets veck på ett riktigt plaggfoto
          </span>
        </div>
        {webgl ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded-[var(--radius-admin-el)] border border-admin-border px-2.5 py-1 text-[12px] text-admin-text hover:bg-admin-surface-2"
          >
            {open ? 'Dölj 3D-vy' : 'Visa 3D-vy'}
          </button>
        ) : (
          <span className="text-[11px] text-admin-text-muted">
            Din webbläsare saknar WebGL — 3D-vyn kan inte visas här.
          </span>
        )}
      </div>

      {open && webgl && (
        <div className="mt-3">
          {!artwork?.previewUrl ? (
            <p className="text-[12px] text-admin-text-muted">Välj ett original för att se 3D-vyn.</p>
          ) : (
            /* Two-column layout: 2/3 canvas · 1/3 rail (model/colour pickers +
               actions — no editing controls). On narrow widths it stacks. */
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              {/* Canvas — 2/3 */}
              <div className="lg:col-span-2">
                <Suspense fallback={<div className="grid aspect-[4/5] w-full place-items-center rounded-[var(--radius-admin)] bg-admin-surface-2 text-[12px] text-admin-text-muted">Laddar 3D-motorn…</div>}>
                  <DisplacementPreview
                    ref={previewRef}
                    garment={garment}
                    viewId="front"
                    colorwayId={effColorwayId}
                    artworkUrl={artwork.previewUrl}
                    placement={effectivePlacement}
                    tuning={tuning}
                    className="w-full"
                  />
                </Suspense>
              </div>

              {/* Controls rail — 1/3 */}
              <div className="flex flex-col gap-5 rounded-[var(--radius-admin)] border border-admin-border-soft bg-admin-surface p-4 lg:col-span-1">
                {/* Model + colourway picker — the render-ready library models. The
                    model <select> only appears with >1 model (a single model shows
                    its label as static text); the colourway <select> only with >1
                    render-ready colourway. */}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-admin-text-muted">Modell</span>
                  <div className="flex items-center gap-2">
                    <img
                      src={garment.views.front.colorways[effColorwayId]?.photoUrl}
                      alt=""
                      className="h-7 w-7 rounded-[var(--radius-admin-el)] object-cover"
                    />
                    {garments.length > 1 ? (
                      <select
                        value={garment.id}
                        onChange={(e) => setModelId(e.target.value)}
                        aria-label="Modell"
                        className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2.5 py-1.5 text-[13px] font-medium text-admin-text focus:outline-none focus:border-admin-info-dot focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
                      >
                        {garments.map((g) => (
                          <option key={g.id} value={g.id}>{g.label || g.id}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[13px] font-medium text-admin-text">{garment.label || garment.id}</span>
                    )}
                  </div>
                </div>
                {colorwayIds.length > 1 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-medium text-admin-text-muted">Färg</span>
                    <select
                      value={effColorwayId}
                      onChange={(e) => setColorwayId(e.target.value)}
                      aria-label="Färg"
                      className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2.5 py-1.5 text-[13px] font-medium text-admin-text focus:outline-none focus:border-admin-info-dot focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
                    >
                      {colorwayIds.map((cwId) => (
                        <option key={cwId} value={cwId}>
                          {garment.views.front.colorways[cwId]?.label || cwId}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* No placement/appearance controls here BY DESIGN: the render
                    follows the flat canvas placement and the model's calibrated
                    tuning, so a downloaded/gallery-added 3D image can never show
                    a placement or look that won't be printed. */}

                {/* Download — full-width dark button, per reference */}
                <div className="mt-1 border-t border-admin-border-soft pt-4">
                  <button
                    type="button"
                    onClick={downloadPNG}
                    disabled={busy}
                    className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-admin)] bg-admin-text px-4 py-3 text-[13px] font-medium text-admin-surface hover:opacity-90 disabled:opacity-40"
                  >
                    {busy ? 'Skapar…' : 'Ladda ner 3D-bild (PNG)'}
                  </button>

                  <p className="mt-3 text-[12px] leading-relaxed text-admin-text-muted">
                    3D-vyn är en illustration och följer tryckplaceringen i arbetsytan — trycket följer den platta mockupen.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Studio3DSection;
