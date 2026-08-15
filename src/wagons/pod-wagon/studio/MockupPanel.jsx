// MockupPanel.jsx — generated-mockups section of the Design Studio (slice 3).
//
// "Generera mockuper" rasterizes one image per colourway (× designed slot) via
// mockupRender and shows them in a grid with:
//   • hero pick — which mockup becomes the product's main image (slice 4 reads it),
//   • a per-image "Ladda ner" link — the flat mockup file is also the input for
//     external tools (e.g. feeding an image model to make photo/3D renders).
//
// Presentational: generation state + the mockup map live in DesignStudio.
import React from 'react';
import { PhotoIcon } from '@heroicons/react/24/outline';
import { slotLabel } from '../../../config/podSlots';

/**
 * Props:
 *   mockups     — array of { key, colorwayLabel, slot, objectUrl, url?, type }
 *   heroKey     — key of the hero mockup (or null)
 *   onPickHero(key)
 *   onGenerate()
 *   generating  — bool
 *   error       — string | null (e.g. upload warning; generation still shown)
 *   canGenerate — bool (a composable artwork is selected)
 */
const MockupPanel = ({
  mockups = [], heroKey = null, onPickHero, onGenerate, generating = false,
  error = null, canGenerate = false,
}) => (
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

    <div className="sr-only" aria-live="polite">
      {generating ? 'Mockuper skapas.' : mockups.length ? `${mockups.length} mockuper är klara.` : ''}
    </div>

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
        <p className="mt-3 text-[12px] text-admin-success-text" role="status">
          {mockups.length} mockuper klara. Välj huvudbild och fortsätt till Publicera.
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
              {/* bg-white is DELIBERATE in both themes: mockups rasterize on
                  white and the swatch must show the garment colour truthfully. */}
              <img
                src={m.objectUrl}
                alt={`Mockup ${m.colorwayLabel}`}
                loading="lazy"
                decoding="async"
                className="w-full rounded-[6px] border border-admin-border-soft bg-white"
              />
              <div className="mt-1.5 flex items-center justify-between gap-1">
                <span className="truncate text-[11px] font-medium text-admin-text">
                  {m.colorwayLabel}
                  {m.slot !== 'front' ? ` · ${slotLabel(m.slot)}` : ''}
                </span>
                <a
                  href={m.objectUrl}
                  download={`mockup-${m.colorwayLabel}-${m.slot}.${ext}`.toLowerCase().replace(/\s+/g, '-')}
                  className="shrink-0 px-1 py-1 -my-1 text-[11px] text-admin-info-text hover:underline"
                >
                  Ladda ner
                </a>
              </div>
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
              </div>
            );
          })}
        </div>
      </div>
    )}
  </div>
);

export default MockupPanel;
