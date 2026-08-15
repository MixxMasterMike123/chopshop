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
import { CheckIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
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
 *   artworkOptions          — selectable artwork docs (PASS/WARN) for the motif swap
 *   baseArtwork             — the slot's standard artwork doc (for its swap thumbnail)
 *   baseArtworkLabel        — label of the product's standard artwork
 *   reviewedColorwayIds     — Set|array of colourway ids the seller has SEEN (review gate)
 *   colorwayIds             — ids selected in step 5 (omitted = all template colours)
 *   onApplyOverrideToColorways(ids, artworkId) — optional bulk light/dark action
 *   onApproveAll()          — optional: mark every colour reviewed at once (the
 *                             guided per-colour path stays primary)
 */
const ColorwayStrip = ({
  template, slot, activeColorwayId, onSelect, placement,
  resolveArtwork, overrides = {}, onOverrideChange, artworkOptions = [], baseArtwork = null, baseArtworkLabel = 'Standardmotiv',
  reviewedColorwayIds = [], minDpi = null, locked = false, colorwayIds = null,
  onApplyOverrideToColorways = null, onApproveAll = null,
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

  const remaining = colorways.length - reviewedCount;
  const activeIndex = active ? colorways.findIndex((c) => c.id === active.id) : -1;
  // Tone-mates of the ACTIVE colourway (for the contextual bulk suggestion).
  const activeTone = active ? classifyHexTone(active.hex) : 'unknown';
  const toneMates = active
    ? colorways.filter((cw) => cw.id !== active.id && classifyHexTone(cw.hex) === activeTone)
    : [];
  const toneWord = activeTone === 'dark' ? 'mörka' : 'ljusa';
  // Swap choices: the standard motif + every selectable alternative. Rendered as
  // thumbnails (the same affordance as step 3's motif picker) so the fix for a
  // bad combination is VISIBLE next to the warning instead of hidden in a select.
  const swapChoices = [
    { id: '', label: `${baseArtworkLabel} (standard)`, previewUrl: baseArtwork?.previewUrl || null },
    ...artworkOptions.map((a) => ({ id: a.id, label: a.label || a.fileName, previewUrl: a.previewUrl })),
  ];
  const showSwap = Boolean(active && onOverrideChange && artworkOptions.length > 0);

  return (
    <div className="mt-4">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold text-admin-text">Granska varje färg</span>
        {/* Live review-gate progress — the gate blocks publish, so its state
            must be visible HERE, not first as a scolding in the publish step. */}
        <span className={`text-[12px] font-medium ${allSeen ? 'text-admin-success-text' : 'text-admin-text'}`}>
          {reviewedCount} av {colorways.length} granskade
        </span>
      </div>
      {/* Progress bar — glanceable gate state, mirrors the counter above. */}
      <div className="mb-2 h-1 overflow-hidden rounded-full bg-admin-surface-3" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-all ${allSeen ? 'bg-admin-success-dot' : 'bg-admin-info-dot'}`}
          style={{ width: `${colorways.length ? (reviewedCount / colorways.length) * 100 : 0}%` }}
        />
      </div>

      {/* ── Progress rail: one small chip per colour — navigation + status only.
          Judgment happens on the big review card below, not here. */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {colorways.map((cw) => {
          const isActive = cw.id === activeColorwayId;
          const isReviewed = reviewedSet.has(cw.id);
          const contrastWarning = contrastByColorway[cw.id]?.warning === true;
          return (
            <button
              key={cw.id}
              type="button"
              onClick={() => onSelect(cw.id)}
              aria-pressed={isActive}
              aria-label={`${cw.label}${isReviewed ? ', granskad' : ', ej granskad'}${contrastWarning ? ', låg kontrast' : ''}`}
              title={cw.label}
              className={`w-[60px] shrink-0 rounded-[var(--radius-admin-el)] border p-1 transition ${
                isActive
                  ? 'border-admin-info-dot ring-1 ring-admin-info-dot/40'
                  : 'border-admin-border hover:bg-admin-surface-2'
              }`}
            >
              <div className="relative overflow-hidden rounded-[4px] bg-admin-surface-2 p-0.5">
                <MiniMockup
                  template={template}
                  slot={slot}
                  colorway={cw}
                  artwork={resolveArtwork(cw.id)}
                  placement={placement}
                  locked={locked}
                  minDpi={minDpi}
                />
                {isReviewed ? (
                  <span className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-admin-success-dot text-white" aria-hidden="true">
                    <CheckIcon className="h-3 w-3" />
                  </span>
                ) : (
                  <span className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border border-white/70 bg-admin-caution-dot" aria-hidden="true" />
                )}
                {contrastWarning && (
                  <span className="absolute bottom-0.5 right-0.5 text-admin-caution-dot" aria-hidden="true">
                    <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                  </span>
                )}
              </div>
              <span className="mt-0.5 block truncate text-center text-[10px] font-medium text-admin-text">{cw.label}</span>
            </button>
          );
        })}
      </div>

      {/* ── Review card: the ACTIVE colour at judgment size. The verdict sits ON
          the card and the fix (motif swap) sits DIRECTLY UNDER the verdict, so
          "when do I change artwork?" is answered by structure, not prose. */}
      {active && (
        <div className="mt-2 rounded-[var(--radius-admin)] border border-admin-border bg-admin-surface p-3">
          <div className="flex flex-wrap gap-4">
            <div className="w-full max-w-[240px] self-start overflow-hidden rounded-[6px] bg-admin-surface-2 p-2">
              <MiniMockup
                template={template}
                slot={slot}
                colorway={active}
                artwork={resolveArtwork(active.id)}
                placement={placement}
                locked={locked}
                minDpi={minDpi}
              />
            </div>

            <div className="min-w-[240px] flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex items-center gap-2 text-[14px] font-semibold text-admin-text">
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full border border-admin-border"
                    style={{ backgroundColor: active.hex }}
                    aria-hidden="true"
                  />
                  {active.label}
                </span>
                <span className="text-[12px] text-admin-text-muted">Färg {activeIndex + 1} av {colorways.length}</span>
              </div>

              {/* Verdict — only once the analysis has an answer. */}
              {activeContrast?.warning === true && (
                <div className="mt-2 flex items-start gap-2 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2">
                  <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-admin-caution-dot" aria-hidden="true" />
                  <p className="text-[12px] leading-relaxed text-admin-caution-text">
                    <span className="font-semibold">Motivet syns dåligt på {active.label.toLowerCase()}.</span>{' '}
                    {showSwap ? 'Välj ett motiv som syns bättre nedan, eller godkänn ändå.' : 'Kontrollera kombinationen extra noga i mockupen, eller godkänn ändå.'}
                  </p>
                </div>
              )}
              {activeContrast && activeContrast.warning !== true && (
                <p className="mt-2 flex items-center gap-1.5 text-[12px] text-admin-success-text">
                  <CheckIcon className="h-4 w-4" aria-hidden="true" />
                  Kontrasten ser bra ut på den här färgen
                </p>
              )}

              {/* Motif swap — thumbnails, the same affordance as step 3's motif
                  picker. Picking one updates the big preview instantly, so the
                  cause→effect of a swap is taught by the interface itself. */}
              {showSwap && (
                <div className="mt-3">
                  <span className="block text-[12px] font-medium text-admin-text">Motiv på {active.label.toLowerCase()}:</span>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {swapChoices.map((choice) => {
                      const isChosen = (activeOverride || '') === choice.id;
                      return (
                        <button
                          key={choice.id || '__base'}
                          type="button"
                          onClick={() => onOverrideChange(active.id, choice.id)}
                          aria-pressed={isChosen}
                          title={choice.label}
                          className={`w-16 rounded-[var(--radius-admin-el)] border p-1 transition ${
                            isChosen
                              ? 'border-admin-info-dot ring-1 ring-admin-info-dot/40'
                              : 'border-admin-border hover:bg-admin-surface-2'
                          }`}
                        >
                          {choice.previewUrl ? (
                            <img src={choice.previewUrl} alt="" loading="lazy" decoding="async" className="aspect-square w-full rounded-[4px] bg-admin-surface-2 object-contain" />
                          ) : (
                            <span className="grid aspect-square w-full place-items-center rounded-[4px] bg-admin-surface-2 text-[10px] text-admin-text-muted">Std</span>
                          )}
                          <span className="mt-0.5 block truncate text-center text-[10px] text-admin-text-muted">
                            {choice.id === '' ? 'Standard' : choice.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Contextual bulk apply: offered only right after an override
                      pick, phrased as the decision it saves. */}
                  {activeOverride && onApplyOverrideToColorways && toneMates.length >= 1 && (
                    <button
                      type="button"
                      onClick={() => onApplyOverrideToColorways([active.id, ...toneMates.map((c) => c.id)], activeOverride)}
                      className="mt-2 rounded-[var(--radius-admin-el)] border border-admin-border px-2.5 py-1.5 text-[12px] text-admin-text hover:bg-admin-surface-2"
                    >
                      Använd det här motivet på alla {toneMates.length + 1} {toneWord} färger
                    </button>
                  )}
                </div>
              )}

              {/* Approve = advance. Viewing marks the colour reviewed (the
                  DesignStudio seen-on-view rule), so this button IS the
                  approval mechanic. */}
              {!allSeen && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const next = colorways.find((cw) => !reviewedSet.has(cw.id) && cw.id !== activeColorwayId);
                      if (next) onSelect(next.id);
                    }}
                    className="min-h-10 rounded-[var(--radius-admin-el)] bg-admin-primary px-4 py-2 text-[13px] font-medium text-white dark:text-admin-bg hover:bg-admin-primary-hover"
                  >
                    Ser bra ut — nästa färg ({remaining} kvar)
                  </button>
                  <button
                    type="button"
                    onClick={onApproveAll || undefined}
                    className={`min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3.5 py-2 text-[13px] font-medium text-admin-text hover:bg-admin-surface-2 ${onApproveAll ? '' : 'hidden'}`}
                  >
                    Godkänn alla {colorways.length}
                  </button>
                </div>
              )}
              {allSeen && (
                <p className="mt-4 flex items-center gap-1.5 text-[13px] font-medium text-admin-success-text">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-admin-success-dot text-white">
                    <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  Alla {colorways.length} färger granskade
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ColorwayStrip;
