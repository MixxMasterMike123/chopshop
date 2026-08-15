// ColorwayStrip.jsx — the per-colourway strip of the Design Studio (slice 3).
//
// One card per colourway showing a LIVE composited mini-preview (garment flat in
// that colour + the artwork that colourway will actually print, at the shared
// slot placement). This is the foundation of the per-colourway review gate:
// navy-on-navy is visible HERE, before anything ships.
//
// The strip also hosts the signature feature no incumbent automates: the
// PER-COLOURWAY ARTWORK OVERRIDE ("byt motiv på mörka plagg") — the active
// colourway gets a select that swaps its artwork for this slot only, mirroring
// the podMappings colorway-override model the print pipeline already resolves.
//
// Pure presentational: state (active colourway, overrides) lives in DesignStudio.
import React, { useEffect, useState } from 'react';
import TemplateBackground, { templateViewBox } from './TemplateBackground';
import { analyzeArtworkContrast, classifyHexTone } from './contrastGuard';
import {
  isComposable, clampPlacement, defaultPlacement, containPlacement,
  placementToViewBoxRect, rectToPercent,
} from './placementMath';

// Composited mini-preview: background (flat or photo) + artwork img at the
// placement (same math as the big canvas — placementToViewBoxRect is the shared
// source of truth). `locked` (pocket) uses the deterministic contain-centred
// rect PER RESOLVED ARTWORK — same geometry as the locked canvas, the mockup
// renderer and publish, so the review gate never shows a placement that
// differs from the print.
const MiniMockup = ({ template, slot, colorway, artwork, placement, minDpi = null, locked = false }) => {
  const viewBox = templateViewBox(template);
  if (!viewBox) return <div className="h-full w-full bg-admin-surface-2" />;

  let artRect = null;
  if (artwork && isComposable(artwork)) {
    const p = locked
      ? containPlacement(template, slot, artwork, minDpi)
      : clampPlacement(
          placement || defaultPlacement(template, slot, artwork, minDpi),
          template, slot, artwork, minDpi
        );
    artRect = p ? placementToViewBoxRect(p, template, slot, artwork) : null;
  }

  return (
    <div className="relative w-full">
      <TemplateBackground template={template} colorway={colorway} slot={slot} />
      {artRect && (
        <img
          src={artwork.previewUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="pointer-events-none absolute object-fill"
          style={{
            ...rectToPercent(artRect, viewBox),
            transform: `rotate(${placement?.rotationDeg || 0}deg)`,
            transformOrigin: 'center',
          }}
        />
      )}
    </div>
  );
};

/**
 * Props:
 *   template, slot          — active template + slot (previews composite for this slot)
 *   activeColorwayId        — selected colourway
 *   onSelect(colorwayId)
 *   placement               — the slot's shared placement (or null → default)
 *   resolveArtwork(colorwayId) → artwork doc that colourway prints (override-aware)
 *   overrides               — { [colorwayId]: artworkId } for THIS slot
 *   onOverrideChange(colorwayId, artworkId|null)
 *   artworkOptions          — selectable artwork docs (PASS/WARN) for the override select
 *   baseArtworkLabel        — label of the product's standard artwork (select's default row)
 *   reviewedColorwayIds     — Set|array of colourway ids the seller has SEEN (review gate)
 *   colorwayIds             — ids selected in step 5 (omitted = all template colours)
 *   onApplyOverrideToColorways(ids, artworkId) — optional bulk light/dark action
 */
const ColorwayStrip = ({
  template, slot, activeColorwayId, onSelect, placement,
  resolveArtwork, overrides = {}, onOverrideChange, artworkOptions = [], baseArtworkLabel = 'Standardmotiv',
  reviewedColorwayIds = [], minDpi = null, locked = false, colorwayIds = null,
  onApplyOverrideToColorways = null,
}) => {
  const selectedSet = colorwayIds ? new Set(colorwayIds) : null;
  const colorways = (template?.colorways || []).filter((cw) => !selectedSet || selectedSet.has(cw.id));
  const active = colorways.find((c) => c.id === activeColorwayId) || null;
  const activeOverride = active ? overrides[active.id] || '' : '';
  // Accept a Set or an array — reviewed = the seller has seen this composite.
  const reviewedSet = reviewedColorwayIds instanceof Set ? reviewedColorwayIds : new Set(reviewedColorwayIds);
  const reviewedCount = colorways.filter((c) => reviewedSet.has(c.id)).length;
  const allSeen = reviewedCount === colorways.length;
  const [contrastByColorway, setContrastByColorway] = useState({});
  const contrastInputs = colorways.map((cw) => ({
    id: cw.id,
    hex: cw.hex,
    artwork: resolveArtwork(cw.id),
  }));
  const contrastKey = JSON.stringify(contrastInputs.map(({ id, hex, artwork }) => [id, hex, artwork?.id, artwork?.previewUrl]));

  useEffect(() => {
    let current = true;
    setContrastByColorway({});
    Promise.all(contrastInputs.map(async ({ id, hex, artwork }) => [
      id,
      await analyzeArtworkContrast(artwork?.previewUrl, hex),
    ])).then((entries) => {
      if (current) setContrastByColorway(Object.fromEntries(entries));
    });
    return () => { current = false; };
    // contrastKey captures the primitive inputs without depending on the
    // resolver function identity, which changes whenever the parent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contrastKey]);

  const activeContrast = active ? contrastByColorway[active.id] : null;
  const bulkIds = (tone) => colorways.filter((cw) => classifyHexTone(cw.hex) === tone).map((cw) => cw.id);

  if (!template) return null;

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold text-admin-text">Färger</span>
        {/* Live review-gate progress — the gate blocks publish, so its state
            must be visible HERE, not first as a scolding in the publish step. */}
        <span className={`text-[11px] ${allSeen ? 'text-admin-success-text' : 'text-admin-text-muted'}`}>
          {allSeen
            ? `Alla ${colorways.length} färger granskade ✓`
            : `${reviewedCount} av ${colorways.length} färger granskade — klicka på varje färg; det du ser är det som trycks`}
        </span>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {colorways.map((cw) => {
          const isActive = cw.id === activeColorwayId;
          const hasOverride = Boolean(overrides[cw.id]);
          const isReviewed = reviewedSet.has(cw.id);
          const contrastWarning = contrastByColorway[cw.id]?.warning === true;
          return (
            <button
              key={cw.id}
              type="button"
              onClick={() => onSelect(cw.id)}
              aria-pressed={isActive}
              className={`w-[86px] shrink-0 rounded-[var(--radius-admin)] border p-1.5 text-left transition ${
                isActive
                  ? 'border-admin-info-dot ring-1 ring-admin-info-dot/40'
                  : 'border-admin-border hover:bg-admin-surface-2'
              }`}
            >
              <div className="overflow-hidden rounded-[6px] bg-admin-surface-2 p-1">
                <MiniMockup
                  template={template}
                  slot={slot}
                  colorway={cw}
                  artwork={resolveArtwork(cw.id)}
                  placement={placement}
                  locked={locked}
                  minDpi={minDpi}
                />
              </div>
              <div className="mt-1 flex items-center gap-1">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full border border-admin-border"
                  style={{ backgroundColor: cw.hex }}
                />
                <span className="truncate text-[11px] font-medium text-admin-text">{cw.label}</span>
                {/* Review gate: a subtle "sedd" tick — reviewed colourways only. */}
                {isReviewed && (
                  <span className="shrink-0 text-[11px] leading-none text-admin-success-dot" title="Granskad" aria-label="Granskad">✓</span>
                )}
              </div>
              {hasOverride && (
                <div className="mt-0.5 text-[11px] text-admin-info-text">eget motiv</div>
              )}
              {contrastWarning && (
                <div className="mt-0.5 text-[11px] font-medium text-admin-caution-text">låg kontrast</div>
              )}
            </button>
          );
        })}
      </div>

      {active && activeContrast?.warning && (
        <p className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
          Motivet kan bli svårt att se på {active.label.toLowerCase()} eftersom stora delar har låg kontrast mot plagget.
          Välj ett alternativt motiv nedan eller kontrollera kombinationen noggrant i mockupen. Varningen blockerar inte publicering.
        </p>
      )}

      {/* Override select for the ACTIVE colourway — swaps the artwork this
          colourway prints in this slot (light motif on dark garments, etc). */}
      {active && onOverrideChange && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor="cw-override" className="text-[12px] text-admin-text-muted">
            Motiv på {active.label.toLowerCase()}:
          </label>
          <select
            id="cw-override"
            value={activeOverride}
            onChange={(e) => onOverrideChange(active.id, e.target.value || null)}
            className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1 text-[12px] text-admin-text focus:outline-none focus:border-admin-info-dot focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
          >
            <option value="">{baseArtworkLabel} (standard)</option>
            {artworkOptions.map((a) => (
              <option key={a.id} value={a.id}>{a.label || a.fileName}</option>
            ))}
          </select>
          {activeOverride && onApplyOverrideToColorways && (
            <div className="flex flex-wrap gap-1.5">
              {bulkIds('dark').length > 1 && (
                <button
                  type="button"
                  onClick={() => onApplyOverrideToColorways(bulkIds('dark'), activeOverride)}
                  className="rounded-[var(--radius-admin-el)] border border-admin-border px-2 py-1 text-[11px] text-admin-text hover:bg-admin-surface-2"
                >
                  Använd på alla mörka
                </button>
              )}
              {bulkIds('light').length > 1 && (
                <button
                  type="button"
                  onClick={() => onApplyOverrideToColorways(bulkIds('light'), activeOverride)}
                  className="rounded-[var(--radius-admin-el)] border border-admin-border px-2 py-1 text-[11px] text-admin-text hover:bg-admin-surface-2"
                >
                  Använd på alla ljusa
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ColorwayStrip;
