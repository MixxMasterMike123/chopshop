import React from 'react';
import { CheckIcon } from '@heroicons/react/24/outline';
import TemplateBackground from './TemplateBackground';

const ColorSelectionPanel = ({ template, selectedColorwayIds = [], onToggle }) => {
  if (!template) return null;
  const selected = selectedColorwayIds instanceof Set
    ? selectedColorwayIds
    : new Set(selectedColorwayIds);
  const colorways = template.colorways || [];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-admin-text-muted">
          Alla färger är valda från början. Ta bort de färger som inte ska säljas.
        </p>
        <span className="text-[12px] font-medium text-admin-text">
          {selected.size} av {colorways.length} valda
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {colorways.map((cw) => {
          const active = selected.has(cw.id);
          return (
            <button
              key={cw.id}
              type="button"
              onClick={() => onToggle?.(cw.id)}
              aria-pressed={active}
              className={`rounded-[var(--radius-admin-el)] border p-2 text-left transition ${
                active
                  ? 'border-admin-info-dot bg-admin-info-bg/30 ring-1 ring-admin-info-dot/40'
                  : 'border-admin-border opacity-60 hover:bg-admin-surface-2 hover:opacity-100'
              }`}
            >
              <div className="relative grid aspect-square place-items-center overflow-hidden rounded-[6px] bg-admin-surface-2">
                <div className="h-[88%] w-[88%]">
                  <TemplateBackground template={template} colorway={cw} />
                </div>
                {active && (
                  <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-admin-info-dot text-white">
                    <CheckIcon className="h-4 w-4" aria-hidden="true" />
                  </span>
                )}
              </div>
              <span className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-admin-text">
                <span
                  className="h-3 w-3 shrink-0 rounded-full border border-admin-border"
                  style={{ backgroundColor: cw.hex || '#ffffff' }}
                />
                <span className="truncate">{cw.label}</span>
              </span>
              <span className="mt-0.5 block text-[11px] text-admin-text-muted">
                {active ? 'Säljs' : 'Erbjuds inte'}
              </span>
            </button>
          );
        })}
      </div>
      {selected.size === 0 && (
        <p className="mt-2 text-[12px] text-admin-caution-text">
          Välj minst en färg för att fortsätta.
        </p>
      )}
    </div>
  );
};

export default ColorSelectionPanel;
