// DisplacementPreview.jsx — live 2.5D mockup preview (React wrapper around the
// Pixi displacement compositor).
//
// Imperative Pixi inside React: the compositor mounts once per (garment, view,
// colorway) via ref + effect and is fully destroyed on unmount/config change;
// artwork/placement/tuning changes flow through the compositor's setters (no
// re-init). The parent updates `placement` as the customer moves the artwork —
// same mm placement object as the flat studio, plus optional rotationDeg.
//
// Exposes extractPNG() through the forwarded ref:
//   const ref = useRef(); …  const blob = await ref.current.extractPNG();
//
// This file may import the compositor statically (same lazy chunk) — but the
// component itself must be loaded via React.lazy/dynamic import so pixi.js
// stays out of the main admin bundle.
import React, {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import { createDisplacementCompositor } from './displacementCompositor';
import { compositorConfigFor } from './displacement3dConfig';

const DisplacementPreview = forwardRef(({
  garment,                 // config entry (displacement3dConfig shape)
  viewId = 'front',
  colorwayId = 'white',
  artworkUrl = null,       // the artwork image (previewUrl / data URL)
  placement = null,        // { xMm, yMm, wMm, rotationDeg? } — top-left in print area
  tuning = null,           // live overrides { displacementScale, displacementContrast, blend, alpha }
  className = '',
}, ref) => {
  const hostRef = useRef(null);
  const compRef = useRef(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);

  // Mount/replace the compositor when the (garment, view, colorway) set changes.
  useEffect(() => {
    let alive = true;
    setReady(false);
    setError(null);
    const cfg = compositorConfigFor(garment, viewId, colorwayId);
    if (!cfg) { setError('3D-konfiguration saknas för den här färgen/vyn.'); return undefined; }

    (async () => {
      try {
        const comp = await createDisplacementCompositor({
          ...cfg,
          // GPU memory pressure can revoke the context mid-session (seen in
          // Firefox during mockup generation). The compositor goes inert; show
          // the Swedish error panel instead of rendering a dead canvas.
          onContextLost: () => setError('3D-vyn tappade grafikminnet — ladda om sidan för att visa den igen.'),
        });
        if (!alive) { comp.destroy(); return; }
        compRef.current = comp;
        // The canvas renders at output resolution; CSS scales it responsively.
        comp.canvas.style.width = '100%';
        comp.canvas.style.height = 'auto';
        comp.canvas.style.display = 'block';
        hostRef.current?.appendChild(comp.canvas);
        setReady(true);
      } catch (e) {
        console.warn('DisplacementPreview: init failed', e);
        if (alive) setError(e?.message || '3D-förhandsvisningen kunde inte starta.');
      }
    })();

    return () => {
      alive = false;
      setReady(false);
      if (compRef.current) {
        try { compRef.current.destroy(); } catch { /* context may already be lost */ }
        compRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [garment?.id, viewId, colorwayId]);

  // Artwork swaps (async load), then placement/tuning (sync) — gated on ready so
  // the first values apply right after init.
  useEffect(() => {
    if (!ready || !compRef.current || !artworkUrl) return;
    compRef.current.setArtwork(artworkUrl).catch((e) => {
      console.warn('DisplacementPreview: artwork load failed', e);
      setError('Motivet kunde inte läsas in i 3D-vyn.');
    });
  }, [ready, artworkUrl]);

  // try/catch: a throw from a dead WebGL context inside a React effect is
  // UNCAUGHT — it unmounts the whole admin to a white screen (Firefox context
  // loss, 2026-08-17). The compositor no-ops after loss, this is the backstop.
  useEffect(() => {
    if (!ready || !compRef.current || !placement) return;
    try { compRef.current.setPlacement(placement); } catch { /* dead context */ }
  }, [ready, placement]);

  useEffect(() => {
    if (!ready || !compRef.current || !tuning) return;
    try { compRef.current.setTuning(tuning); } catch { /* dead context */ }
  }, [ready, tuning]);

  useImperativeHandle(ref, () => ({
    /** Product-image PNG at the config's output resolution. */
    extractPNG: () => {
      if (!compRef.current) return Promise.reject(new Error('3D-vyn är inte redo.'));
      return compRef.current.extractPNG();
    },
  }), []);

  return (
    <div className={className}>
      {error ? (
        <div className="grid aspect-[4/5] w-full place-items-center rounded-[var(--radius-admin)] border border-dashed border-admin-border bg-admin-surface-2 p-4 text-center text-[12px] text-admin-text-muted">
          {error}
        </div>
      ) : (
        <>
          {!ready && (
            <div className="grid aspect-[4/5] w-full place-items-center rounded-[var(--radius-admin)] border border-dashed border-admin-border bg-admin-surface-2 text-[12px] text-admin-text-muted">
              Laddar plaggfoto…
            </div>
          )}
          <div ref={hostRef} className="w-full overflow-hidden rounded-[var(--radius-admin)]" />
        </>
      )}
    </div>
  );
});

DisplacementPreview.displayName = 'DisplacementPreview';
export default DisplacementPreview;
