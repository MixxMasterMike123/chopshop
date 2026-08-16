// studioHarness.jsx — DEV-ONLY harness for eyeballing the Design Studio canvas +
// colourway strip + mockup generation WITHOUT Firestore/auth (localhost forces
// emulators, which can't serve the named DB). UNTRACKED: delete together with
// /studio-harness.html when the studio ships.
//
// Mirrors DesignStudio's slice-3 wiring with mock data: two artworks (dark + light
// motif) so the per-colourway override is testable, and mockup generation via the
// real renderMockup — download the WebP/PNG and feed it to an image model (Gemini
// etc.) to experiment with photo/3D renders of the flat mockup.
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '../index.css';
import CompositorCanvas from '../wagons/pod-wagon/studio/CompositorCanvas';
import ColorwayStrip from '../wagons/pod-wagon/studio/ColorwayStrip';
import MockupPanel from '../wagons/pod-wagon/studio/MockupPanel';
import PublishPanel from '../wagons/pod-wagon/studio/PublishPanel';
import { renderMockup } from '../wagons/pod-wagon/studio/mockupRender';
import { isComposable } from '../wagons/pod-wagon/studio/placementMath';
import { DEV_3D_GARMENTS } from '../wagons/pod-wagon/studio/pixi/displacement3dConfig';
import Studio3DSection from '../wagons/pod-wagon/studio/Studio3DSection';
// FULL-STUDIO wizard bench (?wizard=1): mounts the real DesignStudio with the
// template/profile caches pre-seeded (DEV-only seeds — no Firestore round-trip).
import DesignStudio from '../wagons/pod-wagon/studio/DesignStudio';
import { seedPodMockupTemplatesCacheForDev } from '../config/podMockupTemplates';
import { seedPodProfilesCacheForDev } from '../config/podProfiles';

// Lazy: pixi.js stays in its own chunk, loaded only when the 3D testbed opens.
const DisplacementPreview = React.lazy(() => import('../wagons/pod-wagon/studio/pixi/DisplacementPreview'));

const COLORWAYS = [
  { id: 'white', label: 'Vit', hex: '#ffffff' },
  { id: 'black', label: 'Svart', hex: '#1a1a1a' },
  { id: 'navy', label: 'Marinblå', hex: '#1f2a44' },
  { id: 'heather', label: 'Gråmelerad', hex: '#b7b7b7' },
];

// Mirror of the seed script's tee FLAT template (scripts/seed-pod-mockup-templates.cjs).
const FLAT_TEMPLATE = {
  id: 'tee_flat',
  label: 'T-shirt',
  garment: 'tee',
  profileId: 'apparel_dtg',
  costSek: 149, // exercises the Publish step's cost/profit/margin columns
  colorways: COLORWAYS,
  printAreas: {
    front: { x: 280, y: 210, w: 240, h: 320 },
    back: { x: 280, y: 200, w: 240, h: 320 },
  },
  printAreaMm: {
    front: { w: 300, h: 400 },
    back: { w: 300, h: 400 },
  },
};

// Fake "photo" per colourway generated at runtime (no real photos exist yet): a
// garment-coloured rounded silhouette on a light-grey backdrop with a subtle
// gradient, so the PHOTO template branch is visually testable TODAY. 1000×1125 px
// coordinate space; printAreas below are in THIS space.
const makeFakePhoto = (hex) => {
  const w = 1000, h = 1125;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  // Studio backdrop.
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#eceef1');
  bg.addColorStop(1, '#dcdfe4');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // Garment body — rounded rectangle in the colourway hex, soft top-light gradient.
  const bx = w * 0.2, by = h * 0.16, bw = w * 0.6, bh = h * 0.74, r = 60;
  g.beginPath();
  g.moveTo(bx + r, by);
  g.arcTo(bx + bw, by, bx + bw, by + bh, r);
  g.arcTo(bx + bw, by + bh, bx, by + bh, r);
  g.arcTo(bx, by + bh, bx, by, r);
  g.arcTo(bx, by, bx + bw, by, r);
  g.closePath();
  const body = g.createLinearGradient(0, by, 0, by + bh);
  body.addColorStop(0, hex);
  body.addColorStop(1, hex === '#ffffff' ? '#e8e8e8' : hex);
  g.fillStyle = body;
  g.shadowColor = 'rgba(0,0,0,0.18)';
  g.shadowBlur = 40;
  g.shadowOffsetY = 20;
  g.fill();
  g.shadowColor = 'transparent';
  return c.toDataURL('image/jpeg', 0.9);
};

const PHOTO_TEMPLATE = {
  id: 'tee_photo_demo',
  label: 'T-shirt (foto)',
  profileId: 'apparel_dtg',
  photo: {
    w: 1000, h: 1125,
    // 'heather' left WITHOUT a photo on purpose → exercises the "Foto saknas"
    // placeholder + the mockup-generation reject path.
    urls: {
      white: makeFakePhoto('#ffffff'),
      black: makeFakePhoto('#1a1a1a'),
      navy: makeFakePhoto('#1f2a44'),
    },
  },
  colorways: COLORWAYS,
  printAreas: {
    front: { x: 350, y: 300, w: 300, h: 400 },
  },
  printAreaMm: {
    front: { w: 300, h: 400 },
  },
};

const PROFILE = { id: 'apparel_dtg', label: 'Plagg (DTG)', min_dpi: 150, target_dpi: 300 };

// Generate a recognizable artwork PNG (with alpha) at a KNOWN pixel size so the
// DPI verdict is predictable: 1200×1600 px → 102 DPI at full 30 cm width (FAIL),
// ~300 DPI at ~10 cm width (PASS).
const makeArtwork = (id, label, w, h, circleColor, boxColor, textColor) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = circleColor;
  g.beginPath(); g.arc(w / 2, h * 0.35, w * 0.3, 0, Math.PI * 2); g.fill();
  g.fillStyle = boxColor;
  g.fillRect(w * 0.2, h * 0.55, w * 0.6, h * 0.3);
  g.fillStyle = textColor;
  g.font = `${Math.round(w / 8)}px sans-serif`;
  g.textAlign = 'center';
  g.fillText('MOTIV', w / 2, h * 0.75);
  return {
    id,
    label,
    previewUrl: c.toDataURL('image/png'),
    sourceWidthPx: w,
    sourceHeightPx: h,
    validation: { tier: 'PASS' },
  };
};

const Harness = () => {
  const baseArt = useMemo(() => makeArtwork('art-dark', 'Mörkt motiv 1200×1600', 1200, 1600, '#e2574c', '#2c4b6e', '#ffffff'), []);
  const lightArt = useMemo(() => makeArtwork('art-light', 'Ljust motiv 1200×1600', 1200, 1600, '#f5d76e', '#eeeeee', '#1a1a1a'), []);
  const allArt = useMemo(() => [baseArt, lightArt], [baseArt, lightArt]);

  const [template, setTemplate] = useState(FLAT_TEMPLATE);
  const [colorwayId, setColorwayId] = useState('white');
  const [slot, setSlot] = useState('front');
  const [placements, setPlacements] = useState({});
  const [overrides, setOverrides] = useState({}); // { [slot]: { [cwId]: artId } }
  const [noArt, setNoArt] = useState(false);
  const [mockups, setMockups] = useState([]);
  const [heroKey, setHeroKey] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [mockupError, setMockupError] = useState(null);
  // Review gate (slice 5) — colourways seen in the strip for the CURRENT design.
  const [reviewedColorways, setReviewedColorways] = useState(() => new Set(['white']));
  const resetReviews = () => setReviewedColorways(colorwayId ? new Set([colorwayId]) : new Set());
  // Fake publish state — no Firebase in the harness; just prove the UI flow.
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState(null);
  const [publishError, setPublishError] = useState(null);

  // The ACTIVE colourway is always seen (mirrors DesignStudio). Switching slots
  // does NOT reset reviews.
  useEffect(() => {
    if (!colorwayId) return;
    setReviewedColorways((prev) => (prev.has(colorwayId) ? prev : new Set(prev).add(colorwayId)));
  }, [colorwayId]);

  // Switching template resets design state (mirrors DesignStudio): placements +
  // overrides + mockups were built against the OLD template's print areas.
  const pickTemplate = (t) => {
    setTemplate(t);
    setSlot('front');
    setPlacements({});
    setOverrides({});
    setMockups([]);
    setHeroKey(null);
    setMockupError(null);
    resetReviews();
  };

  const selectedArtwork = noArt ? null : baseArt;
  const colorway = template.colorways.find((c) => c.id === colorwayId);

  const resolveArtwork = (forSlot, cwId) => {
    const id = overrides[forSlot]?.[cwId];
    return (id && allArt.find((a) => a.id === id)) || selectedArtwork;
  };

  const setOverride = (forSlot, cwId, artId) => {
    setOverrides((prev) => {
      const m = { ...(prev[forSlot] || {}) };
      if (artId) m[cwId] = artId; else delete m[cwId];
      return { ...prev, [forSlot]: m };
    });
    setMockups([]); setHeroKey(null);
    resetReviews();
  };

  const generateMockups = async () => {
    setGenerating(true); setMockupError(null);
    try {
      const next = [];
      let skipped = 0;
      for (const cw of template.colorways) {
        for (const s of Object.keys(template.printAreas).filter((x) => x === 'front' || placements[x])) {
          const art = resolveArtwork(s, cw.id);
          if (!art || !isComposable(art)) continue;
          try {
            const { blob, type } = await renderMockup({
              template, colorway: cw, slot: s, artwork: art, placement: placements[s] || null,
            });
            next.push({
              key: `${cw.id}:${s}`, colorwayId: cw.id, colorwayLabel: cw.label,
              slot: s, objectUrl: URL.createObjectURL(blob), type, url: null,
            });
          } catch (err) {
            // Photo template: a colourway with no photo REJECTS — skip it, keep going.
            skipped += 1;
            console.warn('harness: skip mockup', cw.id, s, err?.message);
          }
        }
      }
      setMockups(next);
      resetReviews();
      setHeroKey(next[0]?.key || null);
      if (!next.length) setMockupError('Inget att generera.');
      else if (skipped) setMockupError(`${skipped} färg(er) hoppades över (foto saknas).`);
    } catch (e) {
      setMockupError(e?.message || 'Genereringen misslyckades.');
    } finally {
      setGenerating(false);
    }
  };

  // Fake publish: log the form and resolve after ~800ms so the panel's
  // publishing → success flow is eyeball-testable WITHOUT Firebase.
  const fakePublish = async (form) => {
    console.log('harness: publish()', form);
    setPublishing(true);
    setPublishError(null);
    setPublishResult(null);
    await new Promise((r) => setTimeout(r, 800));
    setPublishResult({ name: form.name, sku: `demo-${form.name.toLowerCase().replace(/\s+/g, '-') || 'produkt'}` });
    setPublishing(false);
  };

  return (
    <div className="mx-auto max-w-[860px] p-6">
      <h1 className="mb-1 text-[16px] font-semibold text-admin-text">Design Studio harness</h1>
      <p className="mb-4 text-[12px] text-admin-text-muted">
        1200×1600 px motiv · tryckyta 30×40 cm · min 150 / mål 300 DPI · Ladda ner en
        mockup och mata in i Gemini/AI Studio för foto/3D-experiment.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {[FLAT_TEMPLATE, PHOTO_TEMPLATE].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => pickTemplate(t)}
            className={`rounded-[6px] border px-2.5 py-1 text-[12px] ${
              t.id === template.id
                ? 'border-admin-info-dot font-medium text-admin-text'
                : 'border-admin-border text-admin-text-muted'
            }`}
          >
            {t.photo ? 'Foto-mall' : 'SVG-mall'}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {Object.keys(template.printAreas).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSlot(s)}
            className={`rounded-[6px] px-2.5 py-1 text-[12px] ${
              s === slot ? 'bg-black/[0.08] font-medium dark:bg-white/10' : 'text-admin-text-muted'
            }`}
          >
            {s}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setNoArt((v) => !v)}
          className="rounded-[6px] border border-admin-border px-2.5 py-1 text-[12px] text-admin-text-muted"
        >
          {noArt ? 'Med motiv' : 'Utan motiv'}
        </button>
      </div>

      <div className="rounded-[var(--radius-admin)] bg-admin-surface p-4 shadow-[var(--shadow-admin)]">
        <CompositorCanvas
          template={template}
          colorway={colorway}
          slot={slot}
          artwork={resolveArtwork(slot, colorwayId)}
          profile={PROFILE}
          placement={placements[slot] || null}
          onPlacementChange={(p) => {
            setPlacements((prev) => ({ ...prev, [slot]: p }));
            resetReviews();
          }}
        />

        <ColorwayStrip
          template={template}
          slot={slot}
          activeColorwayId={colorwayId}
          onSelect={setColorwayId}
          placement={placements[slot] || null}
          resolveArtwork={(cwId) => resolveArtwork(slot, cwId)}
          overrides={overrides[slot] || {}}
          onOverrideChange={selectedArtwork ? (cwId, artId) => setOverride(slot, cwId, artId) : null}
          artworkOptions={selectedArtwork ? [lightArt] : []}
          baseArtworkLabel={selectedArtwork?.label || 'Standardmotiv'}
          reviewedColorwayIds={reviewedColorways}
        />

        <MockupPanel
          mockups={mockups}
          heroKey={heroKey}
          onPickHero={setHeroKey}
          onGenerate={generateMockups}
          generating={generating}
          error={mockupError}
          canGenerate={isComposable(selectedArtwork)}
          products={[{ id: 'p1', name: 'Demo-hoodie' }, { id: 'p2', name: 'Demo-tee' }]}
          onAddToProduct={async (m, pid) => {
            // Harness stub: no Firebase — log + simulate the in-flight state.
            await new Promise((r) => setTimeout(r, 800));
            console.log('harness addToProduct', m.key, pid);
            return true;
          }}
        />

        <PublishPanel
          mockups={mockups}
          template={template}
          vatRate={0.25}
          hasArtwork={!!selectedArtwork}
          shopId="demo-shop"
          publishing={publishing}
          result={publishResult}
          error={publishError}
          reviewedColorwayIds={reviewedColorways}
          onPublish={fakePublish}
          onReset={() => { setPublishResult(null); setPublishError(null); }}
        />
      </div>
    </div>
  );
};

// ── 3D testbed (2.5D photo-displacement mockups) ─────────────────────────────
// Eyeball bench for the Pixi compositor with the REAL test files in
// /public/dev-3d/: live sliders for every tuning knob + placement/rotation, and
// a PNG download of the extracted product image (the acceptance check: artwork
// follows the folds + picks up shadows = printed-on, not pasted-on).
const Slider = ({ label, min, max, step, value, onChange, fmt = (v) => v }) => (
  <label className="flex items-center gap-2 text-[12px] text-admin-text-muted">
    <span className="w-28 shrink-0">{label}</span>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))} className="w-40" />
    <span className="w-14 text-right tabular-nums text-admin-text">{fmt(value)}</span>
  </label>
);

const Bench3D = ({ artworkUrl }) => {
  const garment = DEV_3D_GARMENTS[0];
  const previewRef = useRef(null);
  const [placement, setPlacement] = useState({ xMm: 45, yMm: 60, wMm: 210, rotationDeg: 0 });
  const [tuning, setTuning] = useState({
    displacementScale: garment.displacementScale, blend: garment.blend, alpha: garment.alpha,
  });
  const [busy, setBusy] = useState(false);
  // Upload your OWN artwork (PNG/JPEG) — object URL replaces the mock motif.
  // (The real studio feeds the library's selected original here instead.)
  const [uploadedUrl, setUploadedUrl] = useState(null);
  const onPickArtwork = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  };
  const activeArtworkUrl = uploadedUrl || artworkUrl;

  const download = async () => {
    setBusy(true);
    try {
      const blob = await previewRef.current.extractPNG();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `3d-mockup-${garment.id}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 rounded-[var(--radius-admin)] bg-admin-surface p-4 shadow-[var(--shadow-admin)]">
      <div className="mb-1 text-[14px] font-semibold text-admin-text">3D-testbädd (photo-displacement)</div>
      <p className="mb-3 text-[12px] text-admin-text-muted">
        {garment.label} · /dev-3d/ · motivet ska följa tygvecken och ta upp skuggorna.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_300px]">
        <Suspense fallback={<div className="grid aspect-[4/5] place-items-center text-[12px] text-admin-text-muted">Laddar 3D-motorn…</div>}>
          <DisplacementPreview
            ref={previewRef}
            garment={garment}
            viewId="front"
            colorwayId="white"
            artworkUrl={activeArtworkUrl}
            placement={placement}
            tuning={tuning}
          />
        </Suspense>
        <div className="flex flex-col gap-2.5">
          <label className="flex items-center gap-2 text-[12px] text-admin-text-muted">
            <span className="w-28 shrink-0">Eget motiv</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={onPickArtwork}
              className="text-[11px] text-admin-text-muted file:mr-2 file:rounded-[var(--radius-admin-el)] file:border-0 file:bg-admin-surface-2 file:px-2 file:py-1 file:text-[11px]"
            />
          </label>
          <div className="my-1 border-t border-admin-border-soft" />
          <Slider label="Bredd (cm)" min={5} max={30} step={0.5} value={placement.wMm / 10}
            onChange={(v) => setPlacement((p) => ({ ...p, wMm: v * 10 }))} fmt={(v) => `${v} cm`} />
          <Slider label="Vänster (cm)" min={0} max={30} step={0.5} value={placement.xMm / 10}
            onChange={(v) => setPlacement((p) => ({ ...p, xMm: v * 10 }))} fmt={(v) => `${v} cm`} />
          <Slider label="Uppifrån (cm)" min={0} max={40} step={0.5} value={placement.yMm / 10}
            onChange={(v) => setPlacement((p) => ({ ...p, yMm: v * 10 }))} fmt={(v) => `${v} cm`} />
          <Slider label="Rotation" min={-15} max={15} step={0.5} value={placement.rotationDeg}
            onChange={(v) => setPlacement((p) => ({ ...p, rotationDeg: v }))} fmt={(v) => `${v}°`} />
          <div className="my-1 border-t border-admin-border-soft" />
          <Slider label="Displacement" min={0} max={100} step={1} value={tuning.displacementScale}
            onChange={(v) => setTuning((t) => ({ ...t, displacementScale: v }))} />
          <Slider label="Opacitet" min={0} max={1} step={0.05} value={tuning.alpha}
            onChange={(v) => setTuning((t) => ({ ...t, alpha: v }))} fmt={(v) => v.toFixed(2)} />
          <label className="flex items-center gap-2 text-[12px] text-admin-text-muted">
            <span className="w-28 shrink-0">Blend</span>
            <select value={tuning.blend}
              onChange={(e) => setTuning((t) => ({ ...t, blend: e.target.value }))}
              className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1 text-[12px] text-admin-text">
              <option value="multiply">multiply</option>
              <option value="screen">screen</option>
              <option value="overlay">overlay</option>
              <option value="normal">normal</option>
              <option value="add">add</option>
            </select>
          </label>
          <button type="button" onClick={download} disabled={busy}
            className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-primary px-3 py-1.5 text-[12px] font-medium text-white dark:text-admin-bg hover:bg-admin-primary-hover disabled:opacity-40">
            {busy ? 'Skapar…' : 'Ladda ner produktbild (PNG)'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Studio3DSection picker fixtures (slice 3) ────────────────────────────────
// Two render-ready library models + one deliberately half-configured model (no
// colourways) to prove the renderReady guard drops it from the picker. All reuse
// the real /dev-3d test assets so the compositor actually renders.
const DEV_PHOTO = '/dev-3d/photo-1600.jpg';
const DEV_MAP = '/dev-3d/map-1600.jpg';
const modelViewFront = (colorways) => ({
  w: 1600, h: 1936,
  printArea: { x: 548, y: 875, w: 525, h: 700 },
  colorways,
});
const LIB_MODEL_A = {
  id: 'lib_model_a',
  label: 'A – Vit tee (bibliotek)',
  scope: 'platform',
  active: true,
  views: {
    front: modelViewFront({
      white: { label: 'Vit', photoUrl: DEV_PHOTO, displacementUrl: DEV_MAP },
    }),
  },
  printAreaMm: { front: { w: 300, h: 400 } },
  displacementScale: 30, displacementBlur: 6, blend: 'screen', alpha: 0.8,
  perColorway: {},
  output: { w: 1600, h: 1936 },
};
const LIB_MODEL_B = {
  id: 'lib_model_b',
  label: 'B – Hoodie (bibliotek)',
  scope: 'platform',
  active: true,
  views: {
    front: modelViewFront({
      // sorted by Swedish label: 'Marinblå' < 'Svart', so navy is first/default
      svart: { label: 'Svart', photoUrl: DEV_PHOTO, displacementUrl: DEV_MAP },
      navy: { label: 'Marinblå', photoUrl: DEV_PHOTO, displacementUrl: DEV_MAP },
    }),
  },
  printAreaMm: { front: { w: 320, h: 420 } },
  // model B carries a DIFFERENT displacement default → the slider re-seeds on switch
  displacementScale: 62, displacementBlur: 6, blend: 'screen', alpha: 0.7,
  // per-colourway override on 'svart' → switching to it flips Blend to multiply
  perColorway: { svart: { blend: 'multiply', alpha: 0.9 } },
  output: { w: 1600, h: 1936 },
};
// Half-configured: real dims but ZERO colourways → renderReady must exclude it.
const LIB_MODEL_HALF = {
  id: 'lib_model_half',
  label: 'C – Halvfärdig (ska döljas)',
  scope: 'platform',
  active: true,
  views: { front: modelViewFront({}) },
  printAreaMm: { front: { w: 300, h: 400 } },
  displacementScale: 30, blend: 'screen', alpha: 0.8,
  output: { w: 1600, h: 1936 },
};
const LIB_MODELS = [LIB_MODEL_A, LIB_MODEL_B, LIB_MODEL_HALF];

const Section3DBench = () => {
  const art = useMemo(() => makeArtwork('sec-art', 'Sektionsmotiv', 1200, 1600, '#e2574c', '#2c4b6e', '#ffffff'), []);
  return (
    <div className="mx-auto max-w-[860px] px-6 pb-16">
      <div className="mb-2 text-[14px] font-semibold text-admin-text">Studio3DSection — modellväljare (slice 3)</div>
      <div className="rounded-[var(--radius-admin)] bg-admin-surface p-4 shadow-[var(--shadow-admin)]">
        <Studio3DSection
          artwork={{ previewUrl: art.previewUrl }}
          placement={{ xMm: 45, yMm: 60, wMm: 210, rotationDeg: 0 }}
          models={LIB_MODELS}
        />
      </div>
      {/* Empty library → DEV fallback branch: in a DEV build this must still render
          (DEV_3D_GARMENTS), proving `garments.length ? … : (DEV ? DEV_3D_GARMENTS : [])`.
          In a PROD build the same empty models yields null (verified by code reading). */}
      <div id="empty-lib-probe" className="mt-4 rounded-[var(--radius-admin)] bg-admin-surface p-4 shadow-[var(--shadow-admin)]">
        <div className="mb-2 text-[12px] font-medium text-admin-text">Tomt bibliotek (DEV-fallback)</div>
        <Studio3DSection
          artwork={{ previewUrl: art.previewUrl }}
          placement={{ xMm: 45, yMm: 60, wMm: 210, rotationDeg: 0 }}
          models={[]}
        />
      </div>
    </div>
  );
};

// ── displacementContrast VERIFY bench (?verify=contrast) ─────────────────────
// A deterministic, headless-drivable bench for the Kartkontrast build. Mounts ONE
// DisplacementPreview against a chosen garment + tuning and exposes an imperative
// API on window.__verify so the CDP driver can set values + wait for a stable
// render WITHOUT hunting the DOM. Anna = the WEAK real map (sd≈18); DEV = the good
// dev map. blend 'normal' alpha 1 maximizes visibility of the warp itself.

// Anna garment fixture — the weak operator map that reproduces the flat-edge bug.
// view 1323×1600, printArea x492 y800 w350 h500, printAreaMm 300×400.
const ANNA_GARMENT = {
  id: 'anna_dev',
  label: 'Anna (svag karta, dev)',
  views: {
    front: {
      w: 1323, h: 1600,
      printArea: { x: 492, y: 800, w: 350, h: 500 },
      colorways: {
        white: { label: 'Vit', photoUrl: '/dev-3d/anna-photo.webp', displacementUrl: '/dev-3d/anna-map.webp' },
      },
    },
  },
  printAreaMm: { front: { w: 300, h: 400 } },
  displacementScale: 30,
  displacementBlur: 6,
  // displacementContrast deliberately ABSENT → compositor defaults to 1 (bug repro).
  blend: 'normal', // maximum visibility of the warp itself (no shadow inking)
  alpha: 1,
  perColorway: {},
  output: { w: 1323, h: 1600 },
};

// Kent garment fixture — Mikael's real model whose GOOD map (sd≈42.6) still showed
// straight edges = the filter-padding bug repro. printArea x434 y750 w400 h600.
const KENT_GARMENT = {
  id: 'kent_dev',
  label: 'Kent (bra karta, dev)',
  views: {
    front: {
      w: 1323, h: 1600,
      printArea: { x: 434, y: 750, w: 400, h: 600 },
      colorways: {
        white: { label: 'Vit', photoUrl: '/dev-3d/kent-photo.webp', displacementUrl: '/dev-3d/kent-map.webp' },
      },
    },
  },
  printAreaMm: { front: { w: 300, h: 400 } },
  displacementScale: 30,
  displacementBlur: 6,
  blend: 'normal',
  alpha: 1,
  perColorway: {},
  output: { w: 1323, h: 1600 },
};

// A high-contrast test artwork: a large tight grid so straight vs warped edges are
// obvious. Placed LARGE so edges are long.
const makeGridArtwork = () => {
  const w = 900, h = 1200;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#111111'; g.lineWidth = 6;
  const step = 90;
  for (let x = 0; x <= w; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y <= h; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  // A bold border so the outer edges read as clearly straight/wavy.
  g.lineWidth = 14; g.strokeRect(7, 7, w - 14, h - 14);
  return c.toDataURL('image/png');
};

const VerifyBench = () => {
  const previewRef = useRef(null);
  const gridUrl = useMemo(makeGridArtwork, []);
  const [garmentId, setGarmentId] = useState('anna'); // 'anna' | 'dev' | 'kent'
  const [contrast, setContrast] = useState(1);
  const [scale, setScale] = useState(30);
  const [blend, setBlend] = useState('normal');
  const [plOverride, setPlOverride] = useState(null); // spill test: custom placement
  const garment = garmentId === 'anna' ? ANNA_GARMENT : garmentId === 'kent' ? KENT_GARMENT : {
    ...DEV_3D_GARMENTS[0],
    // Force blend normal/alpha 1 for the regression compare (identical config path
    // whether or not displacementContrast is present; DEV garment carries 1).
    blend: 'normal', alpha: 1,
  };
  // Placement LARGE so edges are long: ~26 cm wide, near top.
  const placement = plOverride || { xMm: 15, yMm: 20, wMm: 260, rotationDeg: 0 };
  const tuning = { displacementScale: scale, displacementContrast: contrast, blend, alpha: 1 };

  // Expose an imperative API for the CDP driver.
  useEffect(() => {
    window.__verify = {
      setGarment: (id) => setGarmentId(id),
      setContrast: (c) => setContrast(c),
      setScale: (v) => setScale(v),
      setBlend: (b) => setBlend(b),
      setPlacement: (p) => setPlOverride(p),
      // rapid successive sets — exercises the async rebuild race guard
      burstContrast: (vals) => { vals.forEach((v) => setContrast(v)); },
      extractPNG: () => previewRef.current?.extractPNG(),
      state: () => ({ garmentId, contrast }),
    };
  }, [garmentId, contrast]);

  return (
    <div className="mx-auto max-w-[720px] p-6">
      <h1 className="mb-1 text-[16px] font-semibold text-admin-text">Kartkontrast verify-bänk</h1>
      <p className="mb-3 text-[12px] text-admin-text-muted">
        Garment: {garment.label} · contrast {contrast} · blend normal alpha 1
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12px] text-admin-text-muted">
          <span>Garment</span>
          <select value={garmentId} onChange={(e) => setGarmentId(e.target.value)}
            className="rounded border border-admin-border bg-admin-surface px-2 py-1 text-[12px] text-admin-text">
            <option value="anna">Anna (svag karta)</option>
            <option value="dev">DEV (bra karta)</option>
            <option value="kent">Kent (bra karta)</option>
          </select>
        </label>
        <Slider label="Kontrast (karta)" min={0.5} max={4} step={0.1} value={contrast}
          onChange={setContrast} fmt={(v) => v.toFixed(1)} />
      </div>
      <div id="verify-canvas-host" data-garment={garmentId} data-contrast={contrast}>
        <Suspense fallback={<div className="grid aspect-[4/5] place-items-center text-[12px] text-admin-text-muted">Laddar 3D-motorn…</div>}>
          <DisplacementPreview
            ref={previewRef}
            key={garment.id}
            garment={garment}
            viewId="front"
            colorwayId="white"
            artworkUrl={gridUrl}
            placement={placement}
            tuning={tuning}
            className="max-w-[420px]"
          />
        </Suspense>
      </div>
    </div>
  );
};

// ── Wizard bench (?wizard=1) — the FULL DesignStudio component ───────────────
// Real tee template (copy of scripts/seed-pod-mockup-templates.cjs v3: front/
// back/pocket/sleeves + pocketPositions) so every wizard page is exercisable:
// tryckytor-cards incl. bröst↔ficka-blocking, per-surface motiv, pocket picker.
// MIRROR of the B&C E150 photo template in scripts/seed-pod-mockup-templates.cjs
// (keep in sync when recalibrating) — photos served from public/pod-garments/.
const WIZARD_TEE_COLORWAYS = [
  { id: 'white', label: 'Vit', hex: '#f3f3f3' },
  { id: 'black', label: 'Svart', hex: '#363435' },
  { id: 'navy', label: 'Marinblå', hex: '#3e3f53' },
  { id: 'sport-grey', label: 'Gråmelerad', hex: '#a5a5a5' },
  { id: 'red', label: 'Röd', hex: '#cf0d25' },
  { id: 'royal-blue', label: 'Kungsblå', hex: '#124c8c' },
  { id: 'burgundy', label: 'Vinröd', hex: '#6a3844' },
  { id: 'sand', label: 'Sand', hex: '#d3bda5' },
];
const wizardTeeUrls = (view) =>
  Object.fromEntries(WIZARD_TEE_COLORWAYS.map((c) => [c.id, `/pod-garments/tee-hanging/${c.id}_${view}.webp`]));
const WIZARD_TEE = {
  id: 'tee_bc_e150',
  label: 'T-shirt',
  profileId: 'apparel_dtg',
  costSek: 100,
  photo: {
    w: 960,
    h: 1093,
    urls: wizardTeeUrls('front'),
    backUrls: wizardTeeUrls('back'),
    displacement: {
      w: 1920,
      h: 2186,
      urls: {
        front: '/pod-garments/tee-hanging/white_front_dm.webp',
        back: '/pod-garments/tee-hanging/white_back_dm.webp',
      },
      scale: 40,
      blur: 6,
      contrast: 1,
      blend: 'multiply',
      alpha: 0.83,
    },
  },
  colorways: WIZARD_TEE_COLORWAYS,
  printAreas: {
    front: { x: 365, y: 365, w: 230, h: 322 },
    back: { x: 340, y: 340, w: 280, h: 373 },
    pocket: { x: 535, y: 365, w: 92, h: 92 },
    left_sleeve: { x: 725, y: 365, w: 74, h: 74 },
    right_sleeve: { x: 160, y: 365, w: 74, h: 74 },
  },
  pocketPositions: { left: { x: 535 }, center: { x: 434 }, right: { x: 333 } },
  printAreaMm: {
    front: { w: 250, h: 350 },
    back: { w: 300, h: 400 },
    pocket: { w: 100, h: 100 },
    left_sleeve: { w: 80, h: 80 },
    right_sleeve: { w: 80, h: 80 },
  },
};

const MockupDmVerifyBench = () => {
  const art = useMemo(
    () => makeArtwork('dm-grid', 'Displacement-test', 1200, 1600, '#e2574c', '#2c4b6e', '#ffffff'),
    []
  );
  const [renders, setRenders] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const colorway = WIZARD_TEE_COLORWAYS.find((c) => c.id === 'white');
    Promise.all(['front', 'back'].map(async (slot) => {
      const result = await renderMockup({
        template: WIZARD_TEE, colorway, slot, artwork: art, scale: 1,
      });
      return { slot, url: URL.createObjectURL(result.blob) };
    })).then((next) => {
      if (!alive) return next.forEach((item) => URL.revokeObjectURL(item.url));
      setRenders(next);
      window.__mockupDmReady = true;
    }).catch((e) => { if (alive) setError(e?.message || String(e)); });
    return () => {
      alive = false;
      renders.forEach((item) => URL.revokeObjectURL(item.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [art]);
  return (
    <div className="mx-auto max-w-[1400px] p-6">
      <h1 className="mb-1 text-[16px] font-semibold text-admin-text">Mockup displacement verify</h1>
      <p className="mb-4 text-[12px] text-admin-text-muted">Befintliga fram-/bakmått · scale 40 · blur 6 · multiply · 83%</p>
      {error && <p className="text-admin-critical-text">{error}</p>}
      <div className="grid grid-cols-3 gap-5">
        <figure>
          <CompositorCanvas
            template={WIZARD_TEE}
            colorway={WIZARD_TEE_COLORWAYS[0]}
            slot="front"
            artwork={art}
            profile={{ min_dpi: 72, target_dpi: 150 }}
          />
          <figcaption className="mt-2 text-center text-[12px] text-admin-text-muted">step 4 · live</figcaption>
        </figure>
        {renders.map((item) => (
          <figure key={item.slot}>
            <img src={item.url} alt={item.slot} className="w-full bg-white" />
            <figcaption className="mt-2 text-center text-[12px] text-admin-text-muted">{item.slot}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
};

const WizardBench = () => {
  const arts = useMemo(() => [
    makeArtwork('art-dark', 'Mörkt motiv 1200×1600', 1200, 1600, '#e2574c', '#2c4b6e', '#ffffff'),
    makeArtwork('art-light', 'Ljust motiv 1200×1600', 1200, 1600, '#f5d76e', '#eeeeee', '#1a1a1a'),
    makeArtwork('art-square', 'Kvadratiskt motiv 900×900', 900, 900, '#3f8f5f', '#1f2a44', '#ffffff'),
  ], []);
  return (
    <div className="mx-auto max-w-[1100px] p-6">
      <h1 className="mb-1 text-[16px] font-semibold text-admin-text">DesignStudio — wizardbänk</h1>
      <p className="mb-4 text-[12px] text-admin-text-muted">
        Hela komponenten med seedade mall/profil-cacher — ingen Firestore. Publicera
        misslyckas (ingen backend); allt före det steget är ögonbart.
      </p>
      <DesignStudio artwork={arts} loading={false} shopId={null} products={[]} />
    </div>
  );
};

const HarnessRoot = () => {
  const art = useMemo(() => makeArtwork('bench-art', 'Bänkmotiv', 1200, 1600, '#e2574c', '#2c4b6e', '#ffffff'), []);
  const [show3d, setShow3d] = useState(false);
  // ?verify=contrast → the deterministic Kartkontrast bench ONLY (headless driving).
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('verify') === 'contrast') {
    return <VerifyBench />;
  }
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('verify') === 'mockup-dm') {
    return <MockupDmVerifyBench />;
  }
  // ?wizard=1 → the FULL DesignStudio (wizard build 2026-08-10). Seed the module
  // caches BEFORE the studio's mount effect calls the loaders (idempotent).
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('wizard') === '1') {
    // Keps mirrors seed's cap_flat incl. the slotLabels override (Kent bug
    // 2026-08-11: 'front' must read "Framsida" here, not "Bröst").
    const WIZARD_CAP = {
      id: 'cap_flat',
      label: 'Keps',
      garment: 'cap',
      slotLabels: { front: 'Framsida' },
      profileId: 'apparel_dtg',
      costSek: 129,
      colorways: COLORWAYS,
      printAreas: { front: { x: 330, y: 330, w: 140, h: 100 } },
      printAreaMm: { front: { w: 70, h: 50 } },
    };
    seedPodMockupTemplatesCacheForDev([WIZARD_TEE, WIZARD_CAP], { provisional: true });
    seedPodProfilesCacheForDev([{ id: 'apparel_dtg', label: 'Plagg (DTG)', min_dpi: 150, target_dpi: 300 }]);
    return <WizardBench />;
  }
  return (
    <>
      <Harness />
      <div className="mx-auto max-w-[860px] px-6 pb-10">
        <button type="button" onClick={() => setShow3d((v) => !v)}
          className="rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-1.5 text-[12px] text-admin-text hover:bg-admin-surface-2">
          {show3d ? 'Dölj 3D-testbädd' : 'Visa 3D-testbädd'}
        </button>
        {show3d && <Bench3D artworkUrl={art.previewUrl} />}
      </div>
      <Section3DBench />
    </>
  );
};

// PublishPanel renders a react-router <Link>, so the harness needs a Router.
createRoot(document.getElementById('root')).render(
  <MemoryRouter>
    <HarnessRoot />
  </MemoryRouter>
);
