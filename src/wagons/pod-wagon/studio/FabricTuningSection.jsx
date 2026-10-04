// FabricTuningSection.jsx — "Avancerat" for the ORDINARY garment photo: the
// 3D view's appearance sliders (Displacement, Kontrast, Opacitet, Blend) on
// the template's own fabric map, with a live warped preview beside them.
//
// The preview is the exported mockup's own recipe (DisplacedTemplatePreview →
// the Pixi compositor) at the print's real placement, so what the seller tunes
// here is what "Skapa mockuper" renders. The knobs are session-local and touch
// only the look (fabricAdjust.js): never the print, never the stored template.
//
// PROPS
//   template        the effective template (the adjustment already laid over it)
//   colorways       the colourways being sold, in order: [{ id, label, hex }]
//   slots           the designed slots that have a fabric map and a motif
//   labelForSlot    (slot) → Swedish label
//   resolveArtwork  (slot, colorwayId) → artwork | null
//   placementFor    (slot, artwork) → the placement the mockup renders
//   adjust          the current adjustment (null = untouched)
//   onAdjust        (next | null) → void
//   initialColorwayId
//   disabled        true while mockups are being generated or published
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import TemplateBackground, { displacementTuningFor, templateViewBox, viewForSlot } from './TemplateBackground';
import { isComposable, placementToViewBoxRect, rectToPercent } from './placementMath';
import { FABRIC_BLENDS, FABRIC_KNOBS, hasFabricAdjust, setFabricKnob } from './fabricAdjust';
import KnobSlider from './KnobSlider';
import LazyPart from './LazyPart';

// The Pixi engine stays out of the studio's main bundle until the panel opens.
const DisplacedTemplatePreview = React.lazy(() => import('./pixi/DisplacedTemplatePreview'));

const hasWebGL = () => {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
};

const SELECT_CLASS =
  'rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2.5 py-1.5 text-[13px] font-medium text-admin-text focus:outline-none focus:border-admin-info-dot focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]';

const FabricTuningSection = ({
  template, colorways = [], slots = [], labelForSlot = (s) => s,
  resolveArtwork = () => null, placementFor = () => null,
  adjust = null, onAdjust = () => {}, initialColorwayId = null, disabled = false,
}) => {
  const webgl = useMemo(hasWebGL, []);
  const [open, setOpen] = useState(false);
  const [colorwayId, setColorwayId] = useState(initialColorwayId);
  const [slot, setSlot] = useState(slots[0] ?? null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // The colour and side on screen always exist among what is being sold.
  const colorway = colorways.find((c) => c.id === colorwayId) || colorways[0] || null;
  const effSlot = slots.includes(slot) ? slot : slots[0] ?? null;
  const artwork = colorway && effSlot ? resolveArtwork(effSlot, colorway.id) : null;
  const composable = Boolean(artwork && isComposable(artwork));
  const placement = composable ? placementFor(effSlot, artwork) : null;

  useEffect(() => { setFailed(false); }, [template?.id, colorway?.id, effSlot, artwork?.previewUrl]);
  // Stable callbacks: the preview's renderer is rebuilt when either changes.
  const handleError = useCallback((error) => {
    console.warn('FabricTuningSection: preview failed', error?.message);
    setFailed(true);
  }, []);
  const handleReady = useCallback((isReady) => setReady(isReady), []);

  if (colorways.length === 0 || slots.length === 0) return null;

  const displacement = template?.photo?.displacement;
  const tuning = displacementTuningFor(displacement, colorway?.id);
  const viewBox = templateViewBox(template);
  const artRect = placement && viewBox ? placementToViewBoxRect(placement, template, effSlot, artwork) : null;
  const setKnob = (key, value) => onAdjust(setFabricKnob(adjust, colorway?.id, key, value));
  const mapMissing = !displacement?.urls?.[viewForSlot(effSlot)];

  return (
    <div className="mt-4 border-t border-admin-border-soft pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-[12px] font-medium text-admin-text">Finjustera plaggbilden</span>
          <span className="ml-2 text-[11px] text-admin-text-muted">
            Hur motivet följer tygets veck i produktbilderna
          </span>
        </div>
        {webgl ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded-[var(--radius-admin-el)] border border-admin-border px-2.5 py-1 text-[12px] text-admin-text hover:bg-admin-surface-2"
          >
            {open ? 'Dölj finjustering' : 'Visa finjustering'}
          </button>
        ) : (
          <span className="text-[11px] text-admin-text-muted">
            Din webbläsare saknar WebGL, så plaggbilden kan inte finjusteras här.
          </span>
        )}
      </div>

      {open && webgl && (
        <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Live preview — 2/3 */}
          <div className="lg:col-span-2">
            <div className="relative mx-auto w-full max-w-[520px] overflow-hidden rounded-[var(--radius-admin)] bg-admin-surface-2">
              <TemplateBackground template={template} colorway={colorway} slot={effSlot} />
              {/* The flat motif shows until the warped layer is verified and on
                  screen, and stays if WebGL gives up: never an empty garment. */}
              {artRect && viewBox && (
                <img
                  src={artwork.previewUrl}
                  alt=""
                  draggable={false}
                  className={`pointer-events-none absolute object-fill ${ready && !failed ? 'opacity-0' : ''}`}
                  style={{
                    ...rectToPercent(artRect, viewBox),
                    transform: `rotate(${placement.rotationDeg || 0}deg)`,
                    transformOrigin: 'center',
                  }}
                />
              )}
              {composable && placement && !mapMissing && !failed && (
                <LazyPart>
                  <DisplacedTemplatePreview
                    template={template}
                    colorway={colorway}
                    slot={effSlot}
                    artworkUrl={artwork.previewUrl}
                    placement={placement}
                    onError={handleError}
                    onReadyChange={handleReady}
                  />
                </LazyPart>
              )}
            </div>
            {failed && (
              <p className="mx-auto mt-2 max-w-[520px] text-[12px] text-admin-caution-text">
                Förhandsvisningen kunde inte ritas med tygets veck. Reglagen gäller ändå när mockuperna skapas.
              </p>
            )}
            {!composable && (
              <p className="mx-auto mt-2 max-w-[520px] text-[12px] text-admin-text-muted">
                Välj ett motiv för att se förhandsvisningen.
              </p>
            )}
          </div>

          {/* Controls rail — 1/3 */}
          <div className="flex flex-col gap-5 self-start rounded-[var(--radius-admin)] border border-admin-border-soft bg-admin-surface p-4 lg:col-span-1">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium text-admin-text-muted">Färg</span>
                {colorways.length > 1 ? (
                  <select
                    value={colorway?.id ?? ''}
                    onChange={(e) => setColorwayId(e.target.value)}
                    aria-label="Färg"
                    className={SELECT_CLASS}
                  >
                    {colorways.map((c) => (
                      <option key={c.id} value={c.id}>{c.label || c.id}</option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[13px] font-medium text-admin-text">{colorway?.label || colorway?.id}</span>
                )}
              </div>
              {slots.length > 1 && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-admin-text-muted">Tryckyta</span>
                  <select
                    value={effSlot ?? ''}
                    onChange={(e) => setSlot(e.target.value)}
                    aria-label="Tryckyta"
                    className={SELECT_CLASS}
                  >
                    {slots.map((s) => (
                      <option key={s} value={s}>{labelForSlot(s)}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2.5 border-t border-admin-border-soft pt-3">
              <span className="text-[11px] font-medium uppercase tracking-wide text-admin-text-muted">Tygets veck (alla färger)</span>
              <KnobSlider
                label="Displacement" {...FABRIC_KNOBS.displacementScale}
                value={tuning?.displacementScale ?? 0}
                onChange={(v) => setKnob('displacementScale', v)}
                disabled={disabled}
              />
              <KnobSlider
                label="Kontrast" {...FABRIC_KNOBS.displacementContrast}
                value={tuning?.displacementContrast ?? 1}
                onChange={(v) => setKnob('displacementContrast', v)}
                fmt={(v) => Number(v).toFixed(1)}
                disabled={disabled}
              />
              <span className="mt-1 text-[11px] font-medium uppercase tracking-wide text-admin-text-muted">
                Utseende ({colorway?.label || colorway?.id})
              </span>
              <KnobSlider
                label="Opacitet" {...FABRIC_KNOBS.alpha}
                value={tuning?.alpha ?? 1}
                onChange={(v) => setKnob('alpha', v)}
                fmt={(v) => Number(v).toFixed(2)}
                disabled={disabled}
              />
              <label className="flex items-center gap-2 text-[12px] text-admin-text-muted">
                <span className="w-24 shrink-0">Blend</span>
                <select
                  value={tuning?.blend ?? 'normal'}
                  onChange={(e) => setKnob('blend', e.target.value)}
                  disabled={disabled}
                  className="min-w-0 flex-1 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1 text-[12px] text-admin-text focus:outline-none focus:border-admin-info-dot disabled:opacity-40"
                >
                  {FABRIC_BLENDS.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </label>
              <div className="flex items-start justify-between gap-2">
                <span className="text-[11px] text-admin-text-muted">
                  Reglagen ändrar bara hur trycket ser ut i produktbilderna. Själva trycket påverkas inte. Skapa mockuperna igen efter en ändring.
                </span>
                {hasFabricAdjust(adjust) && (
                  <button
                    type="button"
                    onClick={() => onAdjust(null)}
                    disabled={disabled}
                    className="shrink-0 rounded-[var(--radius-admin-el)] border border-admin-border px-2 py-1 text-[11px] text-admin-text hover:bg-admin-surface-2 disabled:opacity-40"
                  >
                    Återställ
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FabricTuningSection;
