// FlatCanvas.jsx — step 3 · Placering of a flat print (CP12 unit F3): the
// sheet at its real proportions, the motif placed cover/contain on the
// background, and the two marks the seller designs against:
//   - the bleed line, 3 mm in from the edge: what lies outside it may be
//     trimmed or sit under the frame's lip;
//   - the safe area, 10 mm in: text and faces belong inside it.
// The sheet is drawn by Pixi (flat/flatPixi.js, loaded on demand); where WebGL
// cannot start, the same picture is drawn on a 2D canvas (flatRender.js
// drawSheet). The marks are an SVG over either, in the admin's colour tokens.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BLEED_MM, SAFE_MM } from '../../../../admin-app/adapters/studioFlat.js';
import { drawSheet } from './flatRender';

const MAX_W = 420;
const MAX_H = 520;

const FlatCanvas = ({ image, artW, artH, size, fit, background, label }) => {
  const frameRef = useRef(null);
  const hostRef = useRef(null);
  const fallbackRef = useRef(null);
  const compositorRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [engine, setEngine] = useState('starting'); // 'starting' | 'pixi' | '2d'
  const mm = size.mm;

  // The on-screen sheet: as large as the column allows, at the sheet's aspect.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const measure = () => {
      const avail = Math.min(el.clientWidth || MAX_W, MAX_W);
      const k = Math.min(avail / mm.w, MAX_H / mm.h);
      setBox((prev) => {
        const next = { w: Math.round(mm.w * k), h: Math.round(mm.h * k) };
        return prev.w === next.w && prev.h === next.h ? prev : next;
      });
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [mm.w, mm.h]);

  // Pixi, once. A failure (no WebGL, a lost context) drops to the 2D drawing.
  useEffect(() => {
    let cancelled = false;
    let compositor = null;
    (async () => {
      try {
        const { createFlatCompositor } = await import('./flatPixi');
        compositor = await createFlatCompositor({ width: 10, height: 10, onContextLost: () => !cancelled && setEngine('2d') });
        if (cancelled || !hostRef.current) { compositor.destroy(); return; }
        compositor.canvas.className = 'block';
        compositor.canvas.setAttribute('aria-hidden', 'true');
        hostRef.current.appendChild(compositor.canvas);
        compositorRef.current = compositor;
        setEngine('pixi');
      } catch (error) {
        console.warn('FlatCanvas: WebGL unavailable, drawing in 2D', error?.message);
        try { compositor?.destroy(); } catch { /* never started */ }
        if (!cancelled) setEngine('2d');
      }
    })();
    return () => {
      cancelled = true;
      if (compositorRef.current === compositor) compositorRef.current = null;
      try { compositor?.destroy(); } catch { /* already torn down */ }
    };
  }, []);

  useEffect(() => {
    if (engine !== 'pixi') return;
    compositorRef.current?.setImage(image ?? null);
  }, [engine, image]);

  useEffect(() => {
    if (!box.w || !box.h) return;
    if (engine === 'pixi') {
      compositorRef.current?.draw({ w: box.w, h: box.h, artW, artH, fit, background });
      return;
    }
    if (engine === '2d' && fallbackRef.current) {
      const c = fallbackRef.current;
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      c.width = Math.round(box.w * dpr);
      c.height = Math.round(box.h * dpr);
      c.style.width = `${box.w}px`;
      c.style.height = `${box.h}px`;
      drawSheet(c.getContext('2d'), { image, artW, artH, w: c.width, h: c.height, fit, background });
    }
  }, [engine, box.w, box.h, image, artW, artH, fit, background]);

  const pct = (v, of) => `${(v / of) * 100}%`;
  return (
    <div ref={frameRef} className="w-full">
      <div
        className="relative mx-auto overflow-hidden rounded-[2px] bg-admin-surface shadow-[var(--shadow-admin)] ring-1 ring-admin-border"
        style={{ width: box.w || undefined, height: box.h || undefined }}
        role="img"
        aria-label={label}
      >
        <div ref={hostRef} className={engine === 'pixi' ? 'absolute inset-0' : 'hidden'} />
        {engine === '2d' && <canvas ref={fallbackRef} className="absolute inset-0 block" aria-hidden="true" />}
        {engine === 'starting' && (
          <div className="absolute inset-0 grid place-items-center bg-admin-surface-2 text-[12px] text-admin-text-muted">Laddar…</div>
        )}
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          <rect
            x={pct(BLEED_MM, mm.w)} y={pct(BLEED_MM, mm.h)}
            width={pct(mm.w - 2 * BLEED_MM, mm.w)} height={pct(mm.h - 2 * BLEED_MM, mm.h)}
            fill="none" strokeWidth="1" strokeDasharray="6 4"
            className="stroke-[var(--color-admin-critical-dot)]"
          />
          <rect
            x={pct(SAFE_MM, mm.w)} y={pct(SAFE_MM, mm.h)}
            width={pct(mm.w - 2 * SAFE_MM, mm.w)} height={pct(mm.h - 2 * SAFE_MM, mm.h)}
            fill="none" strokeWidth="1" strokeDasharray="2 3"
            className="stroke-[var(--color-admin-info-dot)]"
          />
        </svg>
      </div>
    </div>
  );
};

export default FlatCanvas;
