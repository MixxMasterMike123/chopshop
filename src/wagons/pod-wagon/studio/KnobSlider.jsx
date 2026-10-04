// KnobSlider.jsx — the appearance-slider row of the studio's "Avancerat"
// panels (the 3D view and the garment photo's fine-tuning): label · range ·
// value readout.
import React from 'react';

const KnobSlider = ({ label, min, max, step, value, onChange, fmt = (v) => v, disabled = false }) => (
  <label className="flex items-center gap-2 text-[12px] text-admin-text-muted">
    <span className="w-24 shrink-0">{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="min-w-0 flex-1 accent-[var(--color-admin-primary)] disabled:opacity-40"
    />
    <span className="w-11 shrink-0 text-right tabular-nums text-admin-text">{fmt(value)}</span>
  </label>
);

export default KnobSlider;
