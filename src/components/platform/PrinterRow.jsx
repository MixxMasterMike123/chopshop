// PrinterRow — one printer on Plattform → Tryckerier: the header line
// (name, status, garments, API badge) plus, when open, the tier editor
// ("Plagg & priser" + "Tryckytor (mm)") that writes printers/{uid}.
//
// PRESENTATIONAL + Firebase-free on purpose (same split as ModelCardGrid /
// ModelEditor): PlatformPrinters owns the Firestore reads/writes and hands in
// plain props, so the dev harness (src/dev/platformPrintersHarness.jsx) can
// mount the real row with fixture printers and look at it rendered.
//
// FORM ↔ DOC conversions live in ./printerTierForm.js (pure, unit-tested in
// rules-tests/audit-2026-09-26.test.mjs) and are re-exported here for the
// page + harness. ALL PRICES ARE EX MOMS.
import React from 'react';
import { POD_GARMENTS } from '../../config/podGarments';
import {
  PRICED_SLOTS, AREA_SLOTS, docToForm, formToPricing, formToPrintAreas, incompleteAreaCells,
} from './printerTierForm';

export { PRICED_SLOTS, AREA_SLOTS, docToForm, formToPricing, formToPrintAreas, incompleteAreaCells };

// Shared platform-surface classes (same strings as PlatformDac7.jsx).
export const inputCls = 'rounded-lg border border-white/10 bg-gray-950 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:border-indigo-500 focus:outline-none';
export const btnPrimary = 'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50';
const checkboxCls = 'rounded border-white/20 bg-gray-950 text-indigo-500 focus:ring-indigo-500';
// Compact numeric cell for the frame table — inputCls is too roomy for 3 per slot.
const mmCls = 'w-11 rounded-md border border-white/10 bg-gray-950 px-1.5 py-1 text-right text-xs tabular-nums text-gray-100 placeholder-gray-600 focus:border-indigo-500 focus:outline-none';

const PrinterRow = ({
  row,              // { id, kind: 'user'|'api'|'tier', title, subtitle, active, garmentsLabel }
  open = false,
  form = null,
  setForm = () => {},
  saving = false,
  areasNotice = [], // garment labels whose frames changed in the LAST save
  onToggleEditor = () => {},
  onToggleActive = () => {},
  onSave = () => {},
}) => {
  const toggleGarment = (id) =>
    setForm((f) => {
      const garments = new Set(f.garments);
      if (garments.has(id)) garments.delete(id); else garments.add(id);
      return { ...f, garments };
    });
  const setBlank = (id, v) => setForm((f) => ({ ...f, blank: { ...f.blank, [id]: v } }));
  const setPrint = (id, v) => setForm((f) => ({ ...f, print: { ...f.print, [id]: v } }));
  const setArea = (g, s, key, v) =>
    setForm((f) => ({
      ...f,
      areas: { ...f.areas, [g]: { ...f.areas[g], [s]: { ...f.areas[g][s], [key]: v } } },
    }));
  const toggleProvisional = (g) =>
    setForm((f) => {
      const provisional = new Set(f.provisional);
      if (provisional.has(g)) provisional.delete(g); else provisional.add(g);
      return { ...f, provisional };
    });

  const offered = form ? POD_GARMENTS.filter((g) => form.garments.has(g.id)) : [];

  return (
    <div className="rounded-lg border border-white/10 bg-white/5">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-white">{row.title}</span>
            {row.kind === 'api' && (
              <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-xs font-medium text-indigo-300">API</span>
            )}
            {row.kind === 'tier' && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">Utan konto</span>
            )}
            <span className={'rounded px-1.5 py-0.5 text-xs ' + (row.active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-gray-500/20 text-gray-400')}>
              {row.active ? 'Aktiv' : 'Inaktiv'}
            </span>
          </div>
          <div className="truncate text-xs text-gray-400">{row.subtitle}</div>
          <div className="truncate text-xs text-gray-500">plagg: {row.garmentsLabel}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={onToggleEditor}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/10">
            {open ? 'Stäng' : 'Plagg & priser'}
          </button>
          <button onClick={onToggleActive}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/10">
            {row.active ? 'Inaktivera' : 'Aktivera'}
          </button>
        </div>
      </div>

      {open && form && (
        <div className="border-t border-white/10 px-4 py-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">Plagg &amp; priser</h3>
            <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
              Alla priser ex. moms
            </span>
          </div>
          <p className="mb-4 text-xs text-gray-500">
            Kryssa i de plagg tryckeriet kan tillverka och ange blankpris per plagg samt tryckpris
            per placering. Tomt fält = inget pris angivet (sparas inte).
          </p>

          <div className="mb-5">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
              Plagg &amp; blankpris (kr, ex. moms)
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {POD_GARMENTS.map((g) => {
                const on = form.garments.has(g.id);
                return (
                  <div key={g.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-gray-900 px-3 py-2">
                    <label className="flex min-w-0 items-center gap-2 text-sm text-gray-300">
                      <input type="checkbox" checked={on} onChange={() => toggleGarment(g.id)} className={checkboxCls} />
                      <span className="truncate">{g.label}</span>
                    </label>
                    <input type="number" min="0" step="1" inputMode="decimal"
                      value={form.blank[g.id]} disabled={!on}
                      onChange={(e) => setBlank(g.id, e.target.value)}
                      placeholder="—"
                      className={`w-24 text-right tabular-nums disabled:opacity-40 ${inputCls}`} />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mb-5">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
              Tryckpris per placering (kr, ex. moms)
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {PRICED_SLOTS.map((slot) => (
                <div key={slot.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-gray-900 px-3 py-2">
                  <span className="truncate text-sm text-gray-300">{slot.label}</span>
                  <input type="number" min="0" step="1" inputMode="decimal"
                    value={form.print[slot.id]}
                    onChange={(e) => setPrint(slot.id, e.target.value)}
                    placeholder="—"
                    className={`w-24 text-right tabular-nums ${inputCls}`} />
                </div>
              ))}
            </div>
          </div>

          {/* Tryckytor — the printer's real print FRAMES per garment × slot.
              The studio reshapes its templates to these (applyPrinterAreas) and
              checkout refuses a slot left empty here (slot-not-printable). */}
          <div className="mb-5">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
              Tryckytor (mm)
            </div>
            <p className="mb-2 text-xs text-gray-500">
              Bredd × höjd per yta, och avstånd från kragsömmen till ytans överkant (“topp”). Tom yta =
              tryckeriet kan inte trycka där — ytan döljs i designstudion. Fickan ryms i bröstytan och
              fungerar även utan egna mått. Ett ikryssat plagg utan någon yta kan inte tryckas alls och
              döljs helt i designstudion.
            </p>
            {offered.length === 0 ? (
              <p className="rounded-lg border border-white/10 bg-gray-900 px-3 py-2 text-xs text-gray-500">
                Kryssa i minst ett plagg ovan för att ange tryckytor.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-white/10 bg-gray-900">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-gray-400">
                      <th className="px-3 py-2 font-medium">Plagg</th>
                      {AREA_SLOTS.map((s) => (
                        <th key={s.id} className="px-1.5 py-2 font-medium whitespace-nowrap last:pr-3">
                          {s.label}
                          <span className="block font-normal text-gray-600">b × h · topp</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {offered.map((g) => {
                      const prov = form.provisional.has(g.id);
                      return (
                        <tr key={g.id} className="border-b border-white/5 last:border-0 align-top">
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5 whitespace-nowrap text-sm text-gray-300">
                              {g.label}
                              {prov && (
                                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300" title="Ytorna är provisoriska tills tryckeriet bekräftat dem">
                                  ⚠ Preliminär
                                </span>
                              )}
                            </div>
                            <label className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-gray-500">
                              <input type="checkbox" checked={prov} onChange={() => toggleProvisional(g.id)} className={checkboxCls} />
                              Preliminära mått
                            </label>
                          </td>
                          {AREA_SLOTS.map((s) => {
                            const cell = form.areas[g.id][s.id];
                            return (
                              <td key={s.id} className="px-1.5 py-2 last:pr-3">
                                <div className="flex items-center gap-1">
                                  <input aria-label={`${g.label} ${s.label} bredd (mm)`} inputMode="decimal"
                                    value={cell.w} onChange={(e) => setArea(g.id, s.id, 'w', e.target.value)}
                                    placeholder="b" className={mmCls} />
                                  <span className="text-gray-600">×</span>
                                  <input aria-label={`${g.label} ${s.label} höjd (mm)`} inputMode="decimal"
                                    value={cell.h} onChange={(e) => setArea(g.id, s.id, 'h', e.target.value)}
                                    placeholder="h" className={mmCls} />
                                </div>
                                <input aria-label={`${g.label} ${s.label} avstånd från kragen (mm)`} inputMode="decimal"
                                  value={cell.top} onChange={(e) => setArea(g.id, s.id, 'top', e.target.value)}
                                  placeholder="topp" className={`mt-1 ${mmCls}`} />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={onSave} disabled={saving} className={btnPrimary}>
              {saving ? 'Sparar…' : 'Spara'}
            </button>
          </div>

          {/* Same frozen-state honesty as the reroute notice: products already
              published were validated against the OLD frames and are not
              re-checked (a re-validation sweep is a follow-up). */}
          {areasNotice.length > 0 && (
            <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Tryckytorna ändrades för {areasNotice.join(', ')}. Publicerade produkter valideras inte om
              automatiskt — kontrollera plagg med ändrade ytor.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default PrinterRow;
