// ColorwayStrip.jsx — the per-colourway strip of the Design Studio (slice 3).
//
// One card per colourway showing a LIVE composited mini-preview (garment flat in
// that colour + the artwork that colourway will actually print, at the shared
// slot placement) FOR EVERY PRINT AREA AT ONCE — bröst and rygg side by side.
// This is the foundation of the per-colourway review gate: navy-on-navy is
// visible HERE, before anything ships.
//
// The strip also hosts the signature feature no incumbent automates: the
// PER-COLOURWAY ARTWORK OVERRIDE ("byt motiv på mörka plagg") — each surface
// gets its own motif thumbnails that swap the artwork for that colourway and
// that slot only, mirroring the podMappings colorway-override model the print
// pipeline already resolves.
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
 *   template                — active template
 *   slot                    — the PRIMARY slot (drives the rail chips' thumbnail)
 *   slots                   — every print area to review together, e.g.
 *                             ['front','back']. Omitted → [slot], the old
 *                             single-surface behaviour the dev harnesses use.
 *   activeColorwayId        — selected colourway
 *   onSelect(colorwayId)
 *   placementFor(slot)      — that slot's shared placement (or null → default)
 *   resolveArtwork(slot, colorwayId) → artwork doc that colourway prints there
 *   overridesFor(slot)      — { [colorwayId]: artworkId } for that slot
 *   onOverrideChange(slot, colorwayId, artworkId|null)
 *   artworkOptionsFor(slot) — selectable artwork docs (PASS/WARN) for the swap
 *   baseArtworkFor(slot)    — that slot's standard artwork doc
 *   baseArtworkLabelFor(slot)
 *   lockedSlot(slot)        — true for fixed-geometry slots (pocket)
 *   labelForSlot(slot)      — display name; the parent owns it because the slot
 *                             vocabulary is apparel-worded and accessories
 *                             override it via template.slotLabels
 *   reviewedColorwayIds     — Set|array of colourway ids the seller has SEEN (review gate)
 *   colorwayIds             — ids selected in step 5 (omitted = all template colours)
 *   onApplyOverrideToColorways(slot, ids, artworkId) — optional bulk light/dark action
 *   onApproveAll()          — optional: mark every colour reviewed at once (the
 *                             guided per-colour path stays primary)
 *   onRemoveColorway(id)    — optional: drop a colour from the design (step 5's
 *                             deselect, reachable from the verdict) so a bad
 *                             contrast can be resolved WITHOUT leaving step 6
 *
 * REVIEW UNIT = THE COLOURWAY, NOT THE COLOURWAY×SLOT (owner call 2026-08-27).
 * The card shows every print area of the active colour side by side — each with
 * its own contrast verdict and motif thumbnails — and ONE "Godkänn" approves the
 * whole colour. That matches the gate `reviewedColorways` has always been (a Set
 * of colourway ids); the old per-slot SurfaceSwitcher only hid half the evidence
 * behind a tab while the click already approved everything. The colour-level fix
 * ("Ta bort färg") is therefore offered ONCE per card, not once per surface.
 */
const ColorwayStrip = ({
  template, slot, slots = null, activeColorwayId, onSelect,
  placementFor = () => null,
  resolveArtwork, overridesFor = () => ({}), onOverrideChange = null,
  artworkOptionsFor = () => [], baseArtworkFor = () => null,
  baseArtworkLabelFor = () => 'Standardmotiv',
  reviewedColorwayIds = [], minDpi = null, lockedSlot = () => false, colorwayIds = null,
  labelForSlot = (s) => s,
  onApplyOverrideToColorways = null, onApproveAll = null, onRemoveColorway = null,
}) => {
  // Every reviewed surface, in the canonical order the parent passes.
  const reviewSlots = (slots && slots.length ? slots : [slot]).filter(Boolean);
  const railSlot = reviewSlots[0] || slot;
  const selectedSet = colorwayIds ? new Set(colorwayIds) : null;
  const colorways = (template?.colorways || []).filter((cw) => !selectedSet || selectedSet.has(cw.id));
  const active = colorways.find((c) => c.id === activeColorwayId) || null;
  // Accept a Set or an array — reviewed = the seller has seen this composite.
  const reviewedSet = reviewedColorwayIds instanceof Set ? reviewedColorwayIds : new Set(reviewedColorwayIds);
  const reviewedCount = colorways.filter((c) => reviewedSet.has(c.id)).length;
  const allSeen = reviewedCount === colorways.length;
  // Contrast is analysed per colourway AND per slot (front and back can carry
  // different motifs). Keyed "slot:colorwayId"; contrastGuard caches by
  // (previewUrl, hex), so slots sharing a motif cost one analysis, not two.
  const [contrastByKey, setContrastByKey] = useState({});
  const contrastInputs = reviewSlots.flatMap((s) => colorways.map((cw) => ({
    key: `${s}:${cw.id}`,
    hex: cw.hex,
    artwork: resolveArtwork(s, cw.id),
  })));
  const contrastKey = JSON.stringify(contrastInputs.map(({ key, hex, artwork }) => [key, hex, artwork?.id, artwork?.previewUrl]));

  useEffect(() => {
    let current = true;
    setContrastByKey({});
    Promise.all(contrastInputs.map(async ({ key, hex, artwork }) => [
      key,
      await analyzeArtworkContrast(artwork?.previewUrl, hex),
    ])).then((entries) => {
      if (current) setContrastByKey(Object.fromEntries(entries));
    });
    return () => { current = false; };
    // contrastKey captures the primitive inputs without depending on the
    // resolver function identity, which changes whenever the parent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contrastKey]);

  // A colourway warns if ANY of its surfaces does — the rail chip must not look
  // clean because the front happens to be fine while the back disappears.
  const colorwayWarns = (cwId) => reviewSlots.some((s) => contrastByKey[`${s}:${cwId}`]?.warning === true);

  if (!template) return null;

  const remaining = colorways.length - reviewedCount;
  const activeIndex = active ? colorways.findIndex((c) => c.id === active.id) : -1;
  // Tone-mates of the ACTIVE colourway (for the contextual bulk suggestion).
  const activeTone = active ? classifyHexTone(active.hex) : 'unknown';
  const toneMates = active
    ? colorways.filter((cw) => cw.id !== active.id && classifyHexTone(cw.hex) === activeTone)
    : [];
  const toneWord = activeTone === 'dark' ? 'mörka' : 'ljusa';
  // Swap choices PER SLOT: that slot's standard motif + every selectable
  // alternative. Rendered as thumbnails (the same affordance as step 3's motif
  // picker) so the fix for a bad combination is VISIBLE next to the warning
  // instead of hidden in a select.
  const swapChoicesFor = (s) => [
    {
      id: '',
      label: `${baseArtworkLabelFor(s)} (standard)`,
      previewUrl: baseArtworkFor(s)?.previewUrl || null,
    },
    ...artworkOptionsFor(s).map((a) => ({ id: a.id, label: a.label || a.fileName, previewUrl: a.previewUrl })),
  ];
  const showSwapFor = (s) => Boolean(active && onOverrideChange && artworkOptionsFor(s).length > 0);

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
          const contrastWarning = colorwayWarns(cw.id);
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
                {/* One identifying thumbnail per colour (the first surface —
                    normally bröst). Every surface gets its own full-size
                    preview on the review card below. */}
                <MiniMockup
                  template={template}
                  slot={railSlot}
                  colorway={cw}
                  artwork={resolveArtwork(railSlot, cw.id)}
                  placement={placementFor(railSlot)}
                  locked={lockedSlot(railSlot)}
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

      {/* ── Review card: the ACTIVE colour at judgment size, across ALL of its
          print areas. Each surface carries its own verdict, and its fix (the
          motif swap) sits DIRECTLY UNDER that verdict, so "when do I change
          artwork, and on which surface?" is answered by structure, not prose.
          One approval at the bottom covers the whole colour. */}
      {active && (
        <div className="mt-2 rounded-[var(--radius-admin)] border border-admin-border bg-admin-surface p-3">
          {/* Colour identity — stated ONCE for the whole card, because the card
              is one colour across all of its print areas. */}
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

          {/* ── One panel per print area, SIDE BY SIDE. Judging bröst and rygg
              against each other is the actual task; a tab that hides one of
              them was hiding half the evidence behind the same single click. */}
          <div className="mt-3 flex flex-wrap items-start gap-4">
            {reviewSlots.map((s) => {
              const art = resolveArtwork(s, active.id);
              const verdict = contrastByKey[`${s}:${active.id}`];
              const slotOverride = overridesFor(s)[active.id] || '';
              const showSwap = showSwapFor(s);
              return (
                <section
                  key={s}
                  aria-label={`${labelForSlot(s)} på ${active.label}`}
                  className="min-w-[220px] flex-1 basis-[260px]"
                >
                  <h4 className="mb-1.5 text-[12px] font-semibold text-admin-text">{labelForSlot(s)}</h4>
                  <div className="overflow-hidden rounded-[6px] bg-admin-surface-2 p-2">
                    <MiniMockup
                      template={template}
                      slot={s}
                      colorway={active}
                      artwork={art}
                      placement={placementFor(s)}
                      locked={lockedSlot(s)}
                      minDpi={minDpi}
                    />
                  </div>

                  {/* Verdict PER SURFACE — only once the analysis has an
                      answer. The BACKGROUND carries the verdict (soft red =
                      low contrast, soft green = OK) so the answer reads at a
                      glance instead of needing the prose. The admin status
                      tokens are deliberately mode-agnostic pastels (see
                      StatusPill) — they stay legible on the dark canvas too.
                      The FIX lives at colour level below, because removing a
                      colour is not a per-surface decision. */}
                  {verdict?.warning === true && (
                    <div className="mt-2 flex items-start gap-2 rounded-[var(--radius-admin-el)] border border-admin-critical-dot/30 bg-admin-critical-bg px-3 py-2">
                      <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-admin-critical-dot" aria-hidden="true" />
                      <p className="text-[12px] leading-relaxed text-admin-critical-text">
                        <span className="font-semibold">Motivet syns dåligt på {active.label.toLowerCase()}.</span>{' '}
                        {showSwap ? 'Välj ett motiv som syns bättre nedan, eller godkänn ändå.' : 'Kontrollera kombinationen extra noga i mockupen, eller godkänn ändå.'}
                      </p>
                    </div>
                  )}
                  {verdict && verdict.warning !== true && (
                    <p className="mt-2 flex items-center gap-1.5 rounded-[var(--radius-admin-el)] border border-admin-success-dot/30 bg-admin-success-bg px-3 py-2 text-[12px] text-admin-success-text">
                      <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      Kontrasten ser bra ut på den här färgen
                    </p>
                  )}

                  {/* Motif swap for THIS surface — thumbnails, the same
                      affordance as step 3's motif picker. Picking one updates
                      the preview above it instantly. */}
                  {showSwap && (
                    <div className="mt-3">
                      <span className="block text-[12px] font-medium text-admin-text">
                        Motiv på {active.label.toLowerCase()}:
                      </span>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {swapChoicesFor(s).map((choice) => {
                          const isChosen = slotOverride === choice.id;
                          return (
                            <button
                              key={choice.id || '__base'}
                              type="button"
                              onClick={() => onOverrideChange(s, active.id, choice.id)}
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

                      {/* Contextual bulk apply: offered only right after an
                          override pick, phrased as the decision it saves. */}
                      {slotOverride && onApplyOverrideToColorways && toneMates.length >= 1 && (
                        <button
                          type="button"
                          onClick={() => onApplyOverrideToColorways(s, [active.id, ...toneMates.map((c) => c.id)], slotOverride)}
                          className="mt-2 rounded-[var(--radius-admin-el)] border border-admin-border px-2.5 py-1.5 text-[12px] text-admin-text hover:bg-admin-surface-2"
                        >
                          Använd det här motivet på alla {toneMates.length + 1} {toneWord} färger
                        </button>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          {/* The fix that needed a trip back to step 5 until now: drop the
              colour from the design without leaving the review. Colour-level,
              offered once as soon as ANY of its surfaces reads badly — the
              colour goes or stays as a whole. */}
          {onRemoveColorway && colorwayWarns(active.id) && (
            <button
              type="button"
              onClick={() => onRemoveColorway(active.id)}
              className="mt-3 rounded-[var(--radius-admin-el)] border border-admin-critical-dot/40 bg-admin-critical-bg px-2.5 py-1.5 text-[12px] font-medium text-admin-critical-text hover:opacity-90"
            >
              Ta bort {active.label.toLowerCase()} ur designen
            </button>
          )}

          {/* Approve = advance. ONE click approves the colour across EVERY
              surface above — the gate has always been keyed by colourway, so
              this is the whole card's verdict, not the visible tab's. */}
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
                {reviewSlots.length > 1
                  ? `Godkänn ${active.label.toLowerCase()} — alla ${reviewSlots.length} ytor (${remaining} färger kvar)`
                  : `Ser bra ut — nästa färg (${remaining} kvar)`}
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
      )}
    </div>
  );
};

export default ColorwayStrip;
