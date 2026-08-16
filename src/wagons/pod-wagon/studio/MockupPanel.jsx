// MockupPanel.jsx — generated-mockups section of the Design Studio (slice 3).
//
// "Generera mockuper" rasterizes one image per colourway (× designed slot) via
// mockupRender and shows them in a grid with:
//   • hero pick — which mockup becomes the product's main image (slice 4 reads it),
//   • a per-image "Ladda ner" link — the flat mockup file is also the input for
//     external tools (e.g. feeding an image model to make photo/3D renders).
//
// STREAMING: DesignStudio publishes the full card list up front (entries with
// pending:true) and fills each card in as its render completes — the seller
// sees every upcoming mockup as a spinner card instantly, and images flow into
// the grid one by one with a fade (no dead "Skapar mockuper…" wait).
//
// Presentational: generation state + the mockup map live in DesignStudio.
import React, { useState } from 'react';
import { PhotoIcon } from '@heroicons/react/24/outline';
import { slotLabel } from '../../../config/podSlots';

// Mockup image that eases in once its bitmap is decoded. The aspect-ratio box
// reserves the final size, so the spinner→image swap never shifts the grid.
const FadeInImage = ({ src, alt, aspectRatio }) => {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={src}
      alt={alt}
      decoding="async"
      onLoad={() => setLoaded(true)}
      style={aspectRatio ? { aspectRatio } : undefined}
      // bg-white is DELIBERATE in both themes: mockups rasterize on white and
      // the swatch must show the garment colour truthfully.
      className={`w-full rounded-[6px] border border-admin-border-soft bg-white transition-opacity duration-300 ease-in ${
        loaded ? 'opacity-100' : 'opacity-0'
      }`}
    />
  );
};

/**
 * Props:
 *   mockups     — array of { key, colorwayLabel, slot, objectUrl, url?, type,
 *                 pending? } — pending entries render as spinner cards.
 *   heroKey     — key of the hero mockup (or null)
 *   onPickHero(key)
 *   onGenerate()
 *   generating  — bool
 *   error       — string | null (e.g. upload warning; generation still shown)
 *   canGenerate — bool (a composable artwork is selected)
 *   aspectRatio — number | null: the template's viewBox w/h, so pending cards
 *                 reserve exactly the finished image's footprint.
 */
const MockupPanel = ({
  mockups = [], heroKey = null, onPickHero, onGenerate, generating = false,
  error = null, canGenerate = false, aspectRatio = null,
}) => {
  const doneCount = mockups.filter((m) => !m.pending).length;
  const statusText = generating
    ? `Skapar mockuper… ${doneCount} av ${mockups.length} klara.`
    : mockups.length
      ? `${mockups.length} mockuper klara. Välj huvudbild och fortsätt till Publicera.`
      : '';

  return (
  <div>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[13px] font-medium text-admin-text">Skapa produktbilder</p>
        <p className="mt-0.5 text-[12px] text-admin-text-muted">
          En mockup skapas för varje vald färg. Du väljer sedan vilken som blir huvudbild.
        </p>
      </div>
      <button
        type="button"
        onClick={onGenerate}
        disabled={!canGenerate || generating}
        className="min-h-10 shrink-0 rounded-[var(--radius-admin-el)] bg-admin-primary px-4 py-2 text-[13px] font-medium text-white dark:text-admin-bg hover:bg-admin-primary-hover disabled:cursor-default disabled:opacity-40"
      >
        {generating ? 'Skapar mockuper…' : mockups.length ? 'Skapa om mockuper' : 'Skapa mockuper'}
      </button>
    </div>

    <div className="sr-only" aria-live="polite">{statusText}</div>

    {error && (
      <p className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
        {error}
      </p>
    )}

    {mockups.length === 0 ? (
      <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-admin)] border border-dashed border-admin-border bg-admin-surface-2 px-4 py-5 text-[12px] text-admin-text-muted">
        <PhotoIcon className="h-5 w-5 text-admin-text-muted" />
        {canGenerate
          ? 'Allt är klart. Klicka på Skapa mockuper för att se de färdiga produktbilderna.'
          : 'Lägg till ett tryck och välj motiv för att kunna generera mockuper.'}
      </div>
    ) : (
      <div>
        <p
          className={`mt-3 text-[12px] ${generating ? 'text-admin-text-muted' : 'text-admin-success-text'}`}
          role="status"
        >
          {statusText}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {mockups.map((m) => {
            const isHero = m.key === heroKey;
            const ext = m.type === 'image/png' ? 'png' : 'webp';
            return (
              <div
                key={m.key}
                className={`rounded-[var(--radius-admin)] border p-2 ${
                  isHero ? 'border-admin-info-dot ring-1 ring-admin-info-dot/40' : 'border-admin-border'
                }`}
              >
              {m.pending ? (
                <div
                  style={aspectRatio ? { aspectRatio } : undefined}
                  className={`grid w-full place-items-center rounded-[6px] border border-admin-border-soft bg-admin-surface-2 ${
                    aspectRatio ? '' : 'min-h-32'
                  }`}
                >
                  <span
                    className="h-5 w-5 animate-spin rounded-full border-2 border-admin-border border-t-admin-primary"
                    aria-hidden="true"
                  />
                </div>
              ) : (
                <FadeInImage
                  src={m.objectUrl}
                  alt={`Mockup ${m.colorwayLabel}`}
                  aspectRatio={aspectRatio}
                />
              )}
              <div className="mt-1.5 flex items-center justify-between gap-1">
                <span className="truncate text-[11px] font-medium text-admin-text">
                  {m.colorwayLabel}
                  {m.slot !== 'front' ? ` · ${slotLabel(m.slot)}` : ''}
                </span>
                {!m.pending && (
                  <a
                    href={m.objectUrl}
                    download={`mockup-${m.colorwayLabel}-${m.slot}.${ext}`.toLowerCase().replace(/\s+/g, '-')}
                    className="shrink-0 px-1 py-1 -my-1 text-[11px] text-admin-info-text hover:underline"
                  >
                    Ladda ner
                  </a>
                )}
              </div>
              {/* Hero pick appears with the image — a spinner can't be a huvudbild. */}
              {!m.pending && (
                <label className="mt-1 flex cursor-pointer items-center gap-1.5 py-1 text-[11px] text-admin-text-muted">
                  <input
                    type="radio"
                    name="mockup-hero"
                    checked={isHero}
                    onChange={() => onPickHero(m.key)}
                    className="h-4 w-4 accent-admin-primary"
                  />
                  Huvudbild
                </label>
              )}
              </div>
            );
          })}
        </div>
      </div>
    )}
  </div>
  );
};

export default MockupPanel;
