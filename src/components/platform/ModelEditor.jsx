// ModelEditor — the platform 3D-model editor (slice 2). Edits ONE pod3dModels
// doc: name, colorways (upload photo + displacement map + optional mask),
// print-area calibration (physical cm ↔ photo px), and the studio tuning
// defaults. Modal-panel like ProvisionShopModal but WIDER + scrollable.
//
// v1 is single view 'front'; everything is written under views.front so more
// views slot in later. The doc's coordinate space is DERIVATIVE px (view.w/h),
// matching pod3dUpload.js + displacement3dConfig's compositorConfigFor.
//
// Presentation is harness-renderable WITHOUT Firebase: uploadAssets / saveDoc /
// deleteColorway are INJECTABLE props defaulting to the real implementations.
// Firestore hygiene: never write `undefined` (client throws) — omit or null.
import React, { useMemo, useRef, useState } from 'react';
import { doc, updateDoc, serverTimestamp, deleteField } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { uploadModelColorwayAssets, deleteColorwayAssets, LOW_CONTRAST_SD_THRESHOLD } from '../../utils/pod3dUpload';
import { clearPod3dModelsCache } from '../../config/pod3dModels';
import toast from 'react-hot-toast';
import { XMarkIcon } from '@heroicons/react/24/outline';

const INPUT =
  'w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none';

// Slug an id from a label: lowercase, åäö→aao, non-alnum→'-', collapse, trim '-'.
export const slugColorwayId = (s) =>
  (s || '')
    .toLowerCase()
    .trim()
    .replace(/[åä]/g, 'a')
    .replace(/[ö]/g, 'o')
    .replace(/[æ]/g, 'a')
    .replace(/[ø]/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// Swedish decimal input: "30,5" must parse as 30.5, never NaN/0 silently.
const num = (v) => Number(String(v ?? '').replace(',', '.'));

// An uncalibrated (zero) print area renders the motif into NOTHING in the 3D-vy
// (photo shows, artwork invisible) — seed a plausible chest rect instead:
// centred, ~42% of the photo width, aspect from the physical print size.
const isZeroArea = (pa) => !pa || !(num(pa.w) > 0) || !(num(pa.h) > 0);
const defaultPrintArea = (w, h, mmW, mmH) => {
  if (!w || !h) return null;
  const aspect = mmW > 0 && mmH > 0 ? mmH / mmW : 4 / 3;
  const pw = Math.round(w * 0.42);
  const ph = Math.min(Math.round(pw * aspect), Math.round(h * 0.6));
  return { x: Math.round((w - pw) / 2), y: Math.round(h * 0.3), w: pw, h: ph };
};

// deleteField() sentinel — updateDoc removes the dot-path key. In the harness the
// stubbed saveDoc just logs it; production forwards it to updateDoc.
const deleteFieldMarker = () => deleteField();

// ── Real default handlers (production). The harness injects stubs. ────────────
const realSaveDoc = (modelId, data) => updateDoc(doc(db, 'pod3dModels', modelId), data);
const realDeleteColorway = (modelId, viewId, colorwayId) =>
  deleteColorwayAssets(modelId, viewId, colorwayId);

const Range = ({ label, min, max, step, value, onChange, fmt = (v) => v, help }) => (
  <div>
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 text-sm text-gray-400">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-indigo-500"
      />
      <span className="w-14 text-right text-sm tabular-nums text-gray-300">{fmt(value)}</span>
    </div>
    {help && <p className="ml-40 mt-0.5 text-xs text-gray-600">{help}</p>}
  </div>
);

const ModelEditor = ({
  model,
  onSaved,
  onClose,
  // Injectable for the harness — default to the real implementations.
  uploadAssets = uploadModelColorwayAssets,
  saveDoc = realSaveDoc,
  deleteColorway = realDeleteColorway,
}) => {
  const modelId = model.id;
  const view0 = model.views?.front || {};

  const [label, setLabel] = useState(model.label || '');
  const [colorways, setColorways] = useState(view0.colorways || {});
  const [viewW, setViewW] = useState(view0.w ?? null);
  const [viewH, setViewH] = useState(view0.h ?? null);
  const [originalDims, setOriginalDims] = useState(view0.originalDims || null);

  // Physical print-area size (stored MM; edited in CM).
  const mm0 = model.printAreaMm?.front || {};
  const [areaWcm, setAreaWcm] = useState(mm0.w ? mm0.w / 10 : 30);
  const [areaHcm, setAreaHcm] = useState(mm0.h ? mm0.h / 10 : 40);

  // Pixel calibration rect (derivative px). A saved-but-uncalibrated model
  // (zero rect — renders nothing in the 3D-vy) gets the default suggestion
  // pre-filled locally; the operator adjusts and saves.
  const pa0 = view0.printArea || { x: 0, y: 0, w: 0, h: 0 };
  const calSeeded = isZeroArea(pa0) && Boolean(view0.w && view0.h);
  const [printArea, setPrintArea] = useState(() =>
    calSeeded ? defaultPrintArea(view0.w, view0.h, mm0.w, mm0.h) : pa0
  );

  // Tuning defaults.
  const [displacementScale, setDisplacementScale] = useState(model.displacementScale ?? 30);
  const [displacementBlur, setDisplacementBlur] = useState(model.displacementBlur ?? 6);
  const [displacementContrast, setDisplacementContrast] = useState(model.displacementContrast ?? 1);
  const [blend, setBlend] = useState(model.blend || 'multiply');
  const [alpha, setAlpha] = useState(model.alpha ?? 0.8);
  const [outW, setOutW] = useState(model.output?.w ?? null);
  const [outH, setOutH] = useState(model.output?.h ?? null);
  const [perColorway, setPerColorway] = useState(model.perColorway || {});

  // Add-colorway form.
  const [cwLabel, setCwLabel] = useState('');
  const [cwPhoto, setCwPhoto] = useState(null);
  const [cwMap, setCwMap] = useState(null);
  const [cwMask, setCwMask] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [addError, setAddError] = useState('');
  // Persistent low-contrast warnings, keyed by colorway id → { label, sd }.
  const [lowContrast, setLowContrast] = useState({});

  const [saving, setSaving] = useState(false);
  const photoInput = useRef(null);
  const mapInput = useRef(null);
  const maskInput = useRef(null);

  const colorwayIds = Object.keys(colorways);
  const hasColorway = colorwayIds.length > 0;
  const firstPhotoUrl = hasColorway ? colorways[colorwayIds[0]].photoUrl : null;
  const derivedId = useMemo(() => slugColorwayId(cwLabel), [cwLabel]);

  const resetAddForm = () => {
    setCwLabel('');
    setCwPhoto(null);
    setCwMap(null);
    setCwMask(null);
    if (photoInput.current) photoInput.current.value = '';
    if (mapInput.current) mapInput.current.value = '';
    if (maskInput.current) maskInput.current.value = '';
  };

  const addColorway = async () => {
    setAddError('');
    const newId = derivedId;
    if (!cwLabel.trim()) return setAddError('Ange ett namn på färgvägen.');
    if (!newId) return setAddError('Namnet ger inget giltigt id — använd bokstäver eller siffror.');
    if (colorways[newId]) return setAddError(`Färgvägen "${newId}" finns redan. Välj ett annat namn.`);
    if (!cwPhoto) return setAddError('Plaggfoto krävs.');
    if (!cwMap) return setAddError('Displacement-karta krävs.');

    setUploading(true);
    try {
      const res = await uploadAssets({
        modelId,
        viewId: 'front',
        colorwayId: newId,
        photoFile: cwPhoto,
        displacementFile: cwMap,
        maskFile: cwMask || undefined,
        // undefined for the FIRST colorway → the util fixes the view's dims.
        expectedOriginalDims: originalDims || undefined,
      });

      // Build the colorway entry — never write undefined.
      const entry = {
        label: cwLabel.trim(),
        photoUrl: res.photoUrl,
        displacementUrl: res.displacementUrl,
      };
      if (res.maskUrl) entry.maskUrl = res.maskUrl;
      if (res.originalPaths) entry.originalPaths = res.originalPaths;
      // Harmless metadata: lets the studio warn later if we want.
      if (Number.isFinite(res.mapContrastSd)) entry.mapContrastSd = res.mapContrastSd;

      const nextColorways = { ...colorways, [newId]: entry };
      const newViewW = res.derivative.w;
      const newViewH = res.derivative.h;
      const newOrig = res.original;

      // Persist immediately: colorway entry + view dims (dot-paths so a parallel
      // save of the numeric fields can't clobber colorways, and vice-versa).
      const patch = {
        [`views.front.colorways.${newId}`]: entry,
        'views.front.w': newViewW,
        'views.front.h': newViewH,
        'views.front.originalDims': newOrig,
        updatedAt: serverTimestamp(),
      };
      // First colorway on an uncalibrated model: seed a default print area so the
      // model renders in the 3D-vy out of the box (the operator refines it below).
      const seeded = isZeroArea(printArea)
        ? defaultPrintArea(newViewW, newViewH, num(areaWcm) * 10, num(areaHcm) * 10)
        : null;
      if (seeded) patch['views.front.printArea'] = seeded;
      await saveDoc(modelId, patch);
      clearPod3dModelsCache();
      if (seeded) setPrintArea(seeded);

      // Update local state. If this was the FIRST colorway, seed the output res.
      setColorways(nextColorways);
      setViewW(newViewW);
      setViewH(newViewH);
      setOriginalDims(newOrig);
      if (outW == null) setOutW(newViewW);
      if (outH == null) setOutH(newViewH);
      // Persistent low-contrast warning: a weak map warps the artwork barely at
      // all → the 3D-vy looks flat. Set/clear the warning for this colorway.
      setLowContrast((prev) => {
        const next = { ...prev };
        if (Number.isFinite(res.mapContrastSd) && res.mapContrastSd < LOW_CONTRAST_SD_THRESHOLD) {
          next[newId] = { label: cwLabel.trim(), sd: res.mapContrastSd };
        } else {
          delete next[newId];
        }
        return next;
      });
      resetAddForm();
      toast.success(`Färgväg "${cwLabel.trim()}" tillagd`);
    } catch (err) {
      // Orphan-cleanup (slice-1 review P2): best-effort remove any partial upload.
      try {
        await deleteColorway(modelId, 'front', newId);
      } catch {
        /* best-effort */
      }
      setAddError(err?.message || 'Kunde inte ladda upp färgvägen.');
    } finally {
      setUploading(false);
    }
  };

  const removeColorway = async (cwId) => {
    const cw = colorways[cwId];
    if (!window.confirm(`Vill du ta bort färgvägen "${cw?.label || cwId}"? Filerna raderas.`)) return;
    setSaving(true);
    try {
      await deleteColorway(modelId, 'front', cwId);
      const next = { ...colorways };
      delete next[cwId];
      const wasLast = Object.keys(next).length === 0;

      const update = {
        [`views.front.colorways.${cwId}`]: deleteFieldMarker(),
        updatedAt: serverTimestamp(),
      };
      // If it was the LAST colorway, clear the view dims so the next upload
      // re-fixes dimensions.
      if (wasLast) {
        update['views.front.w'] = null;
        update['views.front.h'] = null;
        update['views.front.originalDims'] = null;
      }
      // Drop any per-colorway override for this id.
      if (perColorway[cwId]) update[`perColorway.${cwId}`] = deleteFieldMarker();

      await saveDoc(modelId, update);
      clearPod3dModelsCache();

      setColorways(next);
      setLowContrast((prev) => {
        if (!prev[cwId]) return prev;
        const p = { ...prev };
        delete p[cwId];
        return p;
      });
      if (wasLast) {
        setViewW(null);
        setViewH(null);
        setOriginalDims(null);
      }
      if (perColorway[cwId]) {
        setPerColorway((prev) => {
          const p = { ...prev };
          delete p[cwId];
          return p;
        });
      }
      toast.success('Färgväg borttagen');
    } catch (err) {
      toast.error(err?.message || 'Kunde inte ta bort färgvägen.');
    } finally {
      setSaving(false);
    }
  };

  // Per-colorway override editor: perColorway[id] = { blend?, alpha? }.
  const setOverride = (cwId, key, value) => {
    setPerColorway((prev) => {
      const entry = { ...(prev[cwId] || {}) };
      if (value === '' || value == null || (typeof value === 'number' && Number.isNaN(value))) delete entry[key];
      else entry[key] = value;
      const next = { ...prev };
      if (Object.keys(entry).length === 0) delete next[cwId];
      else next[cwId] = entry;
      return next;
    });
  };

  // Clamp the pixel rect on commit (not while typing).
  const commitPrintArea = (patch) => {
    setPrintArea((prev) => {
      const w = viewW || Infinity;
      const h = viewH || Infinity;
      let next = { ...prev, ...patch };
      next.x = clamp(num(next.x) || 0, 0, w);
      next.y = clamp(num(next.y) || 0, 0, h);
      next.w = clamp(num(next.w) || 0, 0, w - next.x);
      next.h = clamp(num(next.h) || 0, 0, h - next.y);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const data = {
        label: label.trim() || model.label || 'Namnlös modell',
        'views.front.printArea': {
          x: Math.round(num(printArea.x)) || 0,
          y: Math.round(num(printArea.y)) || 0,
          w: Math.round(num(printArea.w)) || 0,
          h: Math.round(num(printArea.h)) || 0,
        },
        'printAreaMm.front': {
          w: Math.round((num(areaWcm) || 0) * 10),
          h: Math.round((num(areaHcm) || 0) * 10),
        },
        displacementScale: num(displacementScale) || 0,
        displacementBlur: num(displacementBlur) || 0,
        displacementContrast: Number.isFinite(num(displacementContrast)) ? num(displacementContrast) : 1,
        blend: blend || 'multiply',
        alpha: Number.isFinite(num(alpha)) ? num(alpha) : 0.8,
        perColorway: perColorway || {},
        output: outW && outH ? { w: num(outW) || null, h: num(outH) || null } : null,
        updatedAt: serverTimestamp(),
      };
      await saveDoc(modelId, data);
      clearPod3dModelsCache();
      toast.success('Modell sparad');
      onSaved?.();
    } catch (err) {
      toast.error(err?.message || 'Kunde inte spara modellen.');
    } finally {
      setSaving(false);
    }
  };

  // Overlay rect as percentages of the view coordinate space.
  const overlayStyle = () => {
    const w = viewW || 0;
    const h = viewH || 0;
    if (!w || !h) return { display: 'none' };
    return {
      left: `${(printArea.x / w) * 100}%`,
      top: `${(printArea.y / h) * 100}%`,
      width: `${(printArea.w / w) * 100}%`,
      height: `${(printArea.h / h) * 100}%`,
    };
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="my-6 w-full max-w-3xl rounded-2xl border border-white/10 bg-gray-900 text-gray-100 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-gray-900/95 px-6 py-4 backdrop-blur">
          <h2 className="text-lg font-bold">Redigera modell</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-8 px-6 py-6">
          {/* a) Namn */}
          <section>
            <label className="mb-1 block text-sm text-gray-400">Namn</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="t.ex. T-shirt på modell"
              className={INPUT}
            />
          </section>

          {/* b) Färgvägar */}
          <section>
            <h3 className="mb-1 text-sm font-semibold text-white">Färgvägar (vy: framsida)</h3>
            <p className="mb-3 text-xs text-gray-600">
              Foto, displacement-karta och mask måste ha exakt samma pixelmått.
            </p>

            <div className="space-y-2">
              {colorwayIds.length === 0 && (
                <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-gray-600">
                  Inga färgvägar ännu — lägg till den första nedan.
                </div>
              )}
              {colorwayIds.map((cwId) => {
                const cw = colorways[cwId];
                const ov = perColorway[cwId] || {};
                const weak = lowContrast[cwId];
                return (
                  <div key={cwId} className="space-y-1.5">
                  <div
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-gray-800/50 p-2"
                  >
                    <img
                      src={cw.photoUrl}
                      alt={cw.label || cwId}
                      className="h-16 w-12 shrink-0 rounded object-cover bg-gray-800"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-white">{cw.label || cwId}</div>
                      <div className="text-xs text-gray-500">{cwId}</div>
                    </div>
                    {/* Per-colorway overrides */}
                    <div className="flex items-center gap-2">
                      <select
                        value={ov.blend || ''}
                        onChange={(e) => setOverride(cwId, 'blend', e.target.value)}
                        title="Blend-läge för denna färgväg"
                        className="rounded-lg bg-gray-800 border border-white/10 px-2 py-1 text-xs text-white focus:border-indigo-400 focus:outline-none"
                      >
                        <option value="">Ärv standard</option>
                        <option value="multiply">multiply</option>
                        <option value="screen">screen</option>
                        <option value="overlay">overlay</option>
                        <option value="normal">normal</option>
                        <option value="add">add</option>
                      </select>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={ov.alpha ?? ''}
                        onChange={(e) =>
                          setOverride(cwId, 'alpha', e.target.value === '' ? '' : num(e.target.value))
                        }
                        placeholder="opac."
                        title="Opacitet för denna färgväg (tom = ärv)"
                        className="w-16 rounded-lg bg-gray-800 border border-white/10 px-2 py-1 text-xs text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeColorway(cwId)}
                      disabled={saving || uploading}
                      className="rounded-lg bg-white/5 px-3 py-1 text-xs font-medium text-gray-400 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50"
                    >
                      Ta bort
                    </button>
                  </div>
                  {weak && (
                    <p className="rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-amber-300">
                      Displacement-kartan för ”{weak.label}” har låg kontrast (svaga veck)
                      — 3D-vyn kan se platt ut. Höj Kartkontrast under Standardinställningar,
                      eller ladda upp en karta med tydligare veck.
                    </p>
                  )}
                  </div>
                );
              })}
            </div>

            {/* Add colorway */}
            <div className="mt-4 rounded-lg border border-white/10 bg-gray-800/30 p-3">
              <div className="mb-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-gray-400">Namn på färgväg</label>
                  <input
                    value={cwLabel}
                    onChange={(e) => setCwLabel(e.target.value)}
                    placeholder="t.ex. Vit"
                    className={INPUT}
                  />
                  {cwLabel && (
                    <p className="mt-1 text-xs text-gray-600">
                      id: <span className="font-mono text-gray-500">{derivedId || '—'}</span>
                    </p>
                  )}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs text-gray-400">Plaggfoto (krävs)</label>
                  <input
                    ref={photoInput}
                    type="file"
                    accept="image/*"
                    disabled={uploading}
                    onChange={(e) => setCwPhoto(e.target.files?.[0] || null)}
                    className="w-full text-xs text-gray-400 file:mr-2 file:rounded file:border-0 file:bg-gray-700 file:px-2 file:py-1 file:text-xs file:text-gray-200"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-400">Displacement-karta (krävs)</label>
                  <input
                    ref={mapInput}
                    type="file"
                    accept="image/*"
                    disabled={uploading}
                    onChange={(e) => setCwMap(e.target.files?.[0] || null)}
                    className="w-full text-xs text-gray-400 file:mr-2 file:rounded file:border-0 file:bg-gray-700 file:px-2 file:py-1 file:text-xs file:text-gray-200"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-400">Mask (valfri)</label>
                  <input
                    ref={maskInput}
                    type="file"
                    accept="image/*"
                    disabled={uploading}
                    onChange={(e) => setCwMask(e.target.files?.[0] || null)}
                    className="w-full text-xs text-gray-400 file:mr-2 file:rounded file:border-0 file:bg-gray-700 file:px-2 file:py-1 file:text-xs file:text-gray-200"
                  />
                </div>
              </div>
              {addError && <p className="mt-2 text-sm text-red-400">{addError}</p>}
              <div className="mt-3">
                <button
                  type="button"
                  onClick={addColorway}
                  disabled={uploading || saving}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {uploading ? 'Laddar upp…' : 'Lägg till färgväg'}
                </button>
              </div>
            </div>
          </section>

          {/* c) Tryckyta (kalibrering) */}
          <section className={hasColorway ? '' : 'opacity-40 pointer-events-none'}>
            <h3 className="mb-1 text-sm font-semibold text-white">Tryckyta (kalibrering)</h3>
            {!hasColorway && (
              <p className="mb-2 text-xs text-gray-600">Lägg till en färgväg först (behöver fotot).</p>
            )}
            {calSeeded && (
              <p className="mb-2 rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-amber-300">
                Tryckytan var inte kalibrerad — utan den visas inget motiv i 3D-vyn.
                Ett förslag visas nedan: justera rektangeln så den täcker tryckytan på plagget och spara.
              </p>
            )}

            {/* Physical size FIRST (cm-first). */}
            <div className="mb-4">
              <label className="mb-1 block text-sm text-gray-400">Tryckytans storlek</label>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={areaWcm}
                    onChange={(e) => setAreaWcm(e.target.value)}
                    className="w-24 rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white focus:border-indigo-400 focus:outline-none"
                  />
                  <span className="text-xs text-gray-500">cm bred</span>
                </div>
                <span className="text-gray-600">×</span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={areaHcm}
                    onChange={(e) => setAreaHcm(e.target.value)}
                    className="w-24 rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white focus:border-indigo-400 focus:outline-none"
                  />
                  <span className="text-xs text-gray-500">cm hög</span>
                </div>
              </div>
              <p className="mt-1 text-xs text-gray-600">Fysisk storlek på tryckytan, t.ex. 30 × 40 cm.</p>
            </div>

            {/* Pixel calibration with live overlay. */}
            <div className="grid gap-4 md:grid-cols-[1fr_240px]">
              <div className="flex justify-center rounded-lg bg-gray-800 p-2">
                {firstPhotoUrl ? (
                  // Wrapper shrink-wraps the rendered image so the overlay's
                  // percentages map to the IMAGE box (not a wide container).
                  <div className="relative inline-block">
                    <img
                      src={firstPhotoUrl}
                      alt="Förhandsvisning"
                      className="block max-h-[420px] w-auto max-w-full"
                    />
                    <div
                      className="pointer-events-none absolute border-2 border-indigo-400 bg-indigo-400/10"
                      style={overlayStyle()}
                    />
                  </div>
                ) : (
                  <div className="grid h-40 w-full place-items-center text-xs text-gray-600">Inget foto</div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-xs text-gray-600">
                  Rita in var trycket hamnar på fotot. Rektangeln visas direkt i förhandsvisningen.
                </p>
                {[
                  ['x', 'X'],
                  ['y', 'Y'],
                  ['w', 'Bredd'],
                  ['h', 'Höjd'],
                ].map(([k, lbl]) => (
                  <label key={k} className="flex items-center gap-2 text-sm text-gray-400">
                    <span className="w-16 shrink-0">{lbl}</span>
                    <input
                      type="number"
                      min="0"
                      value={printArea[k]}
                      onChange={(e) => setPrintArea((p) => ({ ...p, [k]: e.target.value }))}
                      onBlur={(e) => commitPrintArea({ [k]: num(e.target.value) || 0 })}
                      className="w-full rounded-lg bg-gray-800 border border-white/10 px-2 py-1 text-sm text-white focus:border-indigo-400 focus:outline-none"
                    />
                    <span className="text-xs text-gray-600">px</span>
                  </label>
                ))}
                <p className="text-xs text-gray-600">px i fotot ({viewW || '?'}×{viewH || '?'})</p>
              </div>
            </div>
          </section>

          {/* d) Standardinställningar (tuning) */}
          <section>
            <h3 className="mb-1 text-sm font-semibold text-white">Standardinställningar</h3>
            <p className="mb-3 text-xs text-gray-600">
              Används när modellen väljs i studion. Reglagen där kan fortfarande justeras live.
            </p>
            <div className="space-y-3">
              <Range
                label="Displacement"
                min={0}
                max={100}
                step={1}
                value={displacementScale}
                onChange={setDisplacementScale}
              />
              <Range
                label="Oskärpa på kartan"
                min={0}
                max={20}
                step={1}
                value={displacementBlur}
                onChange={setDisplacementBlur}
                help="Jämnar ut JPEG-artefakter i displacement-kartan."
              />
              <Range
                label="Kartkontrast"
                min={0.5}
                max={4}
                step={0.1}
                value={displacementContrast}
                onChange={setDisplacementContrast}
                fmt={(v) => Number(v).toFixed(1)}
                help="Förstärker vecken i displacement-kartan. Höj om 3D-vyn ser platt ut trots skarp karta — 1 = kartan som den är."
              />
              <div className="flex items-center gap-3">
                <span className="w-40 shrink-0 text-sm text-gray-400">Blend</span>
                <select
                  value={blend}
                  onChange={(e) => setBlend(e.target.value)}
                  className="rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white focus:border-indigo-400 focus:outline-none"
                >
                  <option value="multiply">multiply</option>
                  <option value="screen">screen</option>
                  <option value="overlay">overlay</option>
                  <option value="normal">normal</option>
                  <option value="add">add</option>
                </select>
              </div>
              <Range
                label="Opacitet"
                min={0}
                max={1}
                step={0.05}
                value={alpha}
                onChange={setAlpha}
                fmt={(v) => Number(v).toFixed(2)}
              />
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="w-40 shrink-0 text-sm text-gray-400">Utdata</span>
                  <input
                    type="number"
                    min="0"
                    value={outW ?? ''}
                    onChange={(e) => setOutW(e.target.value === '' ? null : parseInt(e.target.value, 10))}
                    placeholder="bredd"
                    className="w-24 rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
                  />
                  <span className="text-gray-600">×</span>
                  <input
                    type="number"
                    min="0"
                    value={outH ?? ''}
                    onChange={(e) => setOutH(e.target.value === '' ? null : parseInt(e.target.value, 10))}
                    placeholder="höjd"
                    className="w-24 rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
                  />
                  <span className="text-xs text-gray-500">px</span>
                </div>
                <p className="ml-40 mt-0.5 text-xs text-gray-600">
                  Upplösning på den exporterade produktbilden.
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-white/10 bg-gray-900/95 px-6 py-4 backdrop-blur">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200"
          >
            Avbryt
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || uploading}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? 'Sparar…' : 'Spara'}
          </button>
        </div>
      </div>
    </div>
  );
};
export default ModelEditor;
