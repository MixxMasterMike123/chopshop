// flatPixi.js — the flat print's placement canvas in Pixi v8 (CP12 unit F3).
//
// A subset of the garment compositor: one sheet, its background (contain),
// one motif placed cover/contain and clipped to the sheet. No rotation, no
// displacement. The bleed and safe-area marks are NOT drawn here: FlatCanvas
// lays them over the canvas as SVG in the admin's own colour tokens.
//
// Same lifecycle rules as pixi/displacementCompositor.js: the compositor OWNS
// its canvas (never a React-owned one), renders on demand, and a lost WebGL
// context is reported once and turns every call into a no-op (the owner falls
// back to the 2D drawing). Import LAZILY: pixi.js is its own chunk.
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
// No-eval shader paths (the admin CSP): see displacementCompositor.js.
import 'pixi.js/unsafe-eval';
import { fitRect } from '../../../../admin-app/adapters/studioFlat.js';

const hexNumber = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  return m ? parseInt(m[1], 16) : 0xffffff;
};

/**
 * createFlatCompositor({ width, height, onContextLost }) → Promise<{
 *   canvas, setImage(img), draw({ w, h, artW, artH, fit, background }), destroy() }>
 * `w`/`h` are the sheet's on-screen size in CSS px (the canvas is resized to it).
 */
export async function createFlatCompositor({ width, height, onContextLost = null }) {
  const app = new Application();
  await app.init({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    autoStart: false,
    antialias: true,
    backgroundAlpha: 0,
    preference: 'webgl',
    resolution: Math.min(2, globalThis.devicePixelRatio || 1),
    autoDensity: true,
  });
  let destroyed = false;
  let lost = false;
  const handleLost = () => {
    if (lost || destroyed) return;
    lost = true;
    try { onContextLost?.(); } catch { /* the owner's callback must never crash us */ }
  };
  app.canvas.addEventListener('webglcontextlost', handleLost);

  const sheet = new Container();
  app.stage.addChild(sheet);
  const paper = new Graphics();
  sheet.addChild(paper);
  const art = new Sprite(Texture.EMPTY);
  sheet.addChild(art);
  const clip = new Graphics();
  app.stage.addChild(clip);
  sheet.mask = clip;
  let texture = null;

  const dead = () => destroyed || lost;
  return {
    canvas: app.canvas,
    setImage(image) {
      if (dead()) return;
      const next = image ? Texture.from(image) : Texture.EMPTY;
      art.texture = next;
      if (texture && texture !== next) texture.destroy(true);
      texture = image ? next : null;
    },
    draw({ w, h, artW, artH, fit, background }) {
      if (dead()) return;
      const W = Math.max(1, Math.round(w));
      const H = Math.max(1, Math.round(h));
      if (app.renderer.width !== W || app.renderer.height !== H) app.renderer.resize(W, H);
      paper.clear().rect(0, 0, W, H).fill(fit === 'contain' ? hexNumber(background) : 0xffffff);
      clip.clear().rect(0, 0, W, H).fill(0xffffff);
      const r = texture ? fitRect({ w: artW, h: artH }, { w: W, h: H }, fit) : null;
      art.visible = Boolean(r);
      if (r) {
        art.x = r.x;
        art.y = r.y;
        art.width = r.w;
        art.height = r.h;
      }
      try { app.render(); } catch { handleLost(); }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      app.canvas.removeEventListener('webglcontextlost', handleLost);
      try { texture?.destroy(true); } catch { /* already gone with the context */ }
      app.destroy(true, { children: true });
    },
  };
}
