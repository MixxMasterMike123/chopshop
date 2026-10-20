// StudioKindSwitch.jsx — the studio's entry (CP12): "Nytt plagg" (a motif on a
// garment) or "Nytt tryck" (the motif IS the product: a framed poster). The
// garment studio's segmented control (its SurfaceSwitcher), one size up: it
// chooses which studio is on screen, so it sits above both.
import React from 'react';

const KINDS = [
  { id: 'garment', label: 'Nytt plagg', hint: 'Motiv på t-shirt, hoodie, keps …' },
  { id: 'flat', label: 'Nytt tryck', hint: 'Affisch i ram' },
];

const StudioKindSwitch = ({ kind, onChange }) => {
  const index = Math.max(0, KINDS.findIndex((k) => k.id === kind));
  return (
    <div
      role="radiogroup"
      aria-label="Vad vill du skapa?"
      className="relative grid w-full max-w-[520px] grid-cols-2 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 p-1"
    >
      <span
        aria-hidden="true"
        className="pod-thumb absolute inset-y-1 left-1 rounded-[calc(var(--radius-admin-el)-4px)] bg-admin-surface shadow-[var(--shadow-admin)]"
        style={{ width: 'calc((100% - 8px) / 2)', transform: `translateX(${index * 100}%)` }}
      />
      {KINDS.map((k, i) => {
        const active = i === index;
        return (
          <button
            key={k.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(k.id)}
            className="relative z-10 min-h-12 px-3 py-1.5 text-center"
          >
            <span className={`block text-[13px] transition-colors duration-150 ${active ? 'font-medium text-admin-text' : 'text-admin-text-muted'}`}>
              {k.label}
            </span>
            <span className="block truncate text-[11px] text-admin-text-muted">{k.hint}</span>
          </button>
        );
      })}
    </div>
  );
};

export default StudioKindSwitch;
