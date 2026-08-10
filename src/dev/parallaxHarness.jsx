// parallaxHarness.jsx — DEV-ONLY harness for eyeballing "2.5D parallax product
// film" clips generated from the POD displacement compositor. A visual experiment
// for the owner: does an auto-generated animated product ad (push-in + drift +
// depth parallax over a composited garment) look premium enough to ship?
//
// UNTRACKED: delete together with /parallax-harness.html. Mirrors studioHarness's
// pattern (createRoot, ../index.css, lazy pixi chunk). No Firestore/auth.
//
// The camera work + differential depth parallax live in src/dev/parallax/
// parallaxScene.js, which sits ON TOP of the real createDisplacementCompositor —
// it runs the compositor to get the printed-on garment "hero frame", then pans a
// virtual camera over it and adds a second, animated DisplacementFilter (same
// garment map) for foreground/background depth separation.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { DEV_3D_GARMENTS } from '../wagons/pod-wagon/studio/pixi/displacement3dConfig';

// Lazy: pixi.js stays in its own chunk, loaded only when the scene mounts.
const loadScene = () => import('./parallax/parallaxScene.js');

// Dev garment fixtures (reuse the real /public/dev-3d assets). Kent + Anna carry
// their own calibrated print areas; the DEV garment is the well-tuned default.
const KENT = {
  id: 'kent_dev', label: 'Kent',
  views: { front: { w: 1323, h: 1600, printArea: { x: 434, y: 750, w: 400, h: 600 },
    colorways: { white: { photoUrl: '/dev-3d/kent-photo.webp', displacementUrl: '/dev-3d/kent-map.webp' } } } },
  printAreaMm: { front: { w: 300, h: 400 } },
  displacementScale: 30, displacementBlur: 6, blend: 'multiply', alpha: 0.85,
  perColorway: {}, output: { w: 1323, h: 1600 },
};
const ANNA = {
  id: 'anna_dev', label: 'Anna',
  views: { front: { w: 1323, h: 1600, printArea: { x: 492, y: 800, w: 350, h: 500 },
    colorways: { white: { photoUrl: '/dev-3d/anna-photo.webp', displacementUrl: '/dev-3d/anna-map.webp' } } } },
  printAreaMm: { front: { w: 300, h: 400 } },
  displacementScale: 30, displacementBlur: 6, displacementContrast: 2.4, blend: 'multiply', alpha: 0.85,
  perColorway: {}, output: { w: 1323, h: 1600 },
};
const DEV1600 = DEV_3D_GARMENTS[0]; // photo-1600 / map-1600, the keeper default

const GARMENTS = { kent: KENT, anna: ANNA, dev1600: DEV1600 };
const GARMENT_LABELS = { kent: 'Kent', anna: 'Anna', dev1600: '1600 (default)' };

const PRESET_KEYS = ['pushin', 'drift', 'hero', 'orbit'];

// A bold test motif so the camera move is legible: a ringed emblem + wordmark.
const makeTestArtwork = () => {
  const w = 1000, h = 1300;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#111318';
  g.beginPath(); g.arc(w / 2, h * 0.4, w * 0.34, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#e2574c'; g.lineWidth = 26;
  g.beginPath(); g.arc(w / 2, h * 0.4, w * 0.34 - 22, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#f5f5f2';
  g.font = `700 ${Math.round(w * 0.16)}px sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('CHOP', w / 2, h * 0.4);
  g.fillStyle = '#111318';
  g.font = `600 ${Math.round(w * 0.11)}px sans-serif`;
  g.fillText('STUDIO', w / 2, h * 0.82);
  return c.toDataURL('image/png');
};

const pickRecorderType = () => {
  const cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const t of cands) if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  return '';
};

const Harness = () => {
  const hostRef = useRef(null);
  const sceneRef = useRef(null);
  const artwork = useMemo(makeTestArtwork, []);

  const [garmentKey, setGarmentKey] = useState('dev1600');
  const [presetKey, setPresetKey] = useState('hero');
  const [durationMs, setDurationMs] = useState(6000);
  const [loop, setLoop] = useState(true);
  const [status, setStatus] = useState('Startar scenen…');
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState(null);

  // (Re)mount the scene whenever the garment changes — new compositor + hero frame.
  useEffect(() => {
    let alive = true;
    setReady(false);
    setStatus('Komponerar hero-bild…');
    setDownloadUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    (async () => {
      try {
        const { createParallaxScene } = await loadScene();
        const scene = await createParallaxScene({ garment: GARMENTS[garmentKey], artworkUrl: artwork });
        if (!alive) { scene.destroy(); return; }
        sceneRef.current = scene;
        scene.canvas.style.width = '100%';
        scene.canvas.style.height = 'auto';
        scene.canvas.style.display = 'block';
        scene.canvas.style.borderRadius = '10px';
        hostRef.current.innerHTML = '';
        hostRef.current.appendChild(scene.canvas);
        scene.setPreset(presetKey);
        scene.play({ durationMs, loop });
        setReady(true);
        setStatus('Klar. Tryck Spela in för att fånga en cykel.');
      } catch (e) {
        console.error('parallax scene init failed', e);
        if (alive) setStatus(`Fel: ${e?.message || 'kunde inte starta scenen.'}`);
      }
    })();
    return () => {
      alive = false;
      if (sceneRef.current) { sceneRef.current.destroy(); sceneRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [garmentKey]);

  // Preset / duration / loop changes → re-drive the live scene (no re-mount).
  useEffect(() => {
    const s = sceneRef.current;
    if (!ready || !s) return;
    s.setPreset(presetKey);
    s.play({ durationMs, loop });
  }, [ready, presetKey, durationMs, loop]);

  const restart = () => {
    const s = sceneRef.current;
    if (s) s.play({ durationMs, loop });
  };

  // Record exactly one cycle (loop OFF during capture) via captureStream +
  // MediaRecorder, then offer a download.
  const record = async () => {
    const s = sceneRef.current;
    if (!s || recording) return;
    const mimeType = pickRecorderType();
    if (!window.MediaRecorder || !mimeType) {
      setStatus('MediaRecorder/webm stöds inte i den här webbläsaren.');
      return;
    }
    setDownloadUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setRecording(true);
    setStatus(`Spelar in en cykel (${mimeType.split('codecs=')[1] || 'webm'})…`);

    const stream = s.canvas.captureStream(30);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      setDownloadUrl(URL.createObjectURL(blob));
      setRecording(false);
      setStatus('Inspelning klar — ladda ner nedan.');
      s.play({ durationMs, loop }); // resume the live preview
    };

    // Drive exactly one non-looping cycle for the capture.
    s.onCycle(() => { try { rec.stop(); } catch { /* already stopped */ } });
    rec.start();
    s.play({ durationMs, loop: false });
    // Safety stop a hair past the cycle in case onCycle is missed.
    setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, durationMs + 400);
  };

  const btn = (active) =>
    `rounded-[6px] border px-2.5 py-1 text-[12px] ${active
      ? 'border-admin-info-dot font-medium text-admin-text'
      : 'border-admin-border text-admin-text-muted'}`;

  return (
    <div className="mx-auto max-w-[720px] p-6">
      <h1 className="mb-1 text-[16px] font-semibold text-admin-text">Parallax-video harness</h1>
      <p className="mb-4 text-[12px] text-admin-text-muted">
        2.5D produktfilm ur POD-kompositorn · virtuell kamera (inzoom + drift) +
        differentiell djup-parallax via displacement-kartan · 1080×1350 (4:5) ·
        export till webm.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {Object.keys(GARMENTS).map((k) => (
          <button key={k} type="button" onClick={() => setGarmentKey(k)} className={btn(k === garmentKey)}>
            {GARMENT_LABELS[k]}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {PRESET_KEYS.map((k) => (
          <button key={k} type="button" onClick={() => setPresetKey(k)} className={btn(k === presetKey)}>
            {k === 'pushin' ? 'Push-in' : k === 'drift' ? 'Drift' : k === 'hero' ? 'Hero' : 'Orbit'}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[12px] text-admin-text-muted">
          <span className="w-16 shrink-0">Längd</span>
          <input type="range" min={4000} max={10000} step={500} value={durationMs}
            onChange={(e) => setDurationMs(parseInt(e.target.value, 10))} className="w-40" />
          <span className="w-12 text-right tabular-nums text-admin-text">{(durationMs / 1000).toFixed(1)}s</span>
        </label>
        <label className="flex items-center gap-2 text-[12px] text-admin-text-muted">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          Loopa
        </label>
        <button type="button" onClick={restart}
          className="rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-1.5 text-[12px] text-admin-text hover:bg-admin-surface-2">
          Spela om
        </button>
        <button type="button" onClick={record} disabled={!ready || recording}
          className="rounded-[var(--radius-admin-el)] bg-admin-primary px-3 py-1.5 text-[12px] font-medium text-white dark:text-admin-bg hover:bg-admin-primary-hover disabled:opacity-40">
          {recording ? 'Spelar in…' : 'Spela in'}
        </button>
      </div>

      <div className="rounded-[var(--radius-admin)] bg-admin-surface p-4 shadow-[var(--shadow-admin)]">
        {/* hostRef gets the Pixi canvas via appendChild — React must NEVER render
            children inside it (mixing React + manual DOM in one parent throws
            NotFoundError on reconciliation). The loader is an absolute sibling. */}
        <div className="relative mx-auto w-full max-w-[420px]">
          <div ref={hostRef} className="min-h-[80px] w-full overflow-hidden rounded-[10px] bg-[#f2f3f5]" />
          {!ready && (
            <div className="absolute inset-0 grid aspect-[4/5] place-items-center text-[12px] text-admin-text-muted">Laddar…</div>
          )}
        </div>
        <p className="mt-3 text-[12px] text-admin-text-muted">{status}</p>
        <p className="mt-1 text-[11px] text-admin-text-muted">
          {presetKey === 'pushin' && 'Push-in: långsam centrerad inzoom 1.00→1.08.'}
          {presetKey === 'drift' && 'Drift: sidled panorering vänster→höger + minimal inzoom.'}
          {presetKey === 'hero' && 'Hero: inzoom + drift + lätt djup-sway — den kompletta filmen.'}
          {presetKey === 'orbit' && 'Orbit: simulerad rotation ±några grader — djupet svänger horisontellt mot kamerans panorering. 2.5D:s maxgräns.'}
        </p>
        {downloadUrl && (
          <a href={downloadUrl} download={`parallax-${garmentKey}-${presetKey}.webm`}
            className="mt-3 inline-block rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-1.5 text-[12px] font-medium text-admin-text hover:bg-admin-surface-2">
            Ladda ner klipp (webm)
          </a>
        )}
      </div>
    </div>
  );
};

createRoot(document.getElementById('root')).render(<Harness />);
