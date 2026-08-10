// parallaxScene.js — DEV-ONLY. A "2.5D parallax product film" scene built on top
// of the REAL displacement compositor. NOT production code — a visual experiment.
//
// Pipeline:
//   1) Run the real createDisplacementCompositor (displacementCompositor.js) to
//      composite artwork onto the garment photo with the printed-on look
//      (mask + mean-centered displacement + blend-on-filter). extractPNG() once →
//      a flattened "hero frame" of the finished garment.
//   2) Mount our OWN Pixi Application sized to a 4:5 output canvas. Draw the hero
//      frame as a sprite inside a CAMERA container (scale/translate = the camera
//      move, eased in-out).
//   3) DIFFERENTIAL DEPTH PARALLAX: a second DisplacementFilter on the sprite,
//      driven by the SAME garment displacement map (bright/foreground fabric =
//      larger shift, dark/background = smaller), with a tiny animated offset that
//      tracks the camera drift. This is the "depth sway" — foreground fabric
//      drifts slightly more than the flat backdrop as the camera moves. Kept
//      SUBTLE (a few px) so it reads as premium product film, not a warp show.
//
// Gotchas honoured (from displacementCompositor.js):
//   - filter.padding must cover the displacement reach (edge warp) → padded here.
//   - blendMode goes on the FILTER, not the sprite (we keep 'normal' — no inking
//     needed on an already-composited frame).
//   - displacement map's mean-centre / DC handling is done INSIDE the real
//     compositor when it builds the hero frame; our second filter uses the raw
//     map only for relative depth and is DC-neutral because the offset animates
//     symmetrically around zero.
import { Application, Container, Sprite, DisplacementFilter, Texture } from 'pixi.js';
import { createDisplacementCompositor } from '../../wagons/pod-wagon/studio/pixi/displacementCompositor.js';
import { compositorConfigFor } from '../../wagons/pod-wagon/studio/pixi/displacement3dConfig.js';

// 4:5 portrait product-video canvas. Chosen over the compositor's native ~5:6
// aspect so the exported clip matches the 1080×1350 (4:5) social-ad slot the
// owner is judging. The hero frame is scaled to COVER this frame (crop, never
// letterbox) and the camera pushes further in from there.
export const OUTPUT_W = 1080;
export const OUTPUT_H = 1350;

const loadImageEl = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Kunde inte läsa bilden för parallax-scenen.'));
  img.src = src;
});

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// Presets: functions of eased progress p∈[0,1] → camera + depth params.
// zoom is a scale multiplier on the "cover" base; panX/panY in fraction of the
// overshoot margin; depth is the extra px of differential parallax shift.
export const PRESETS = {
  pushin: {
    label: 'Push-in',
    describe: 'Långsam inzoom 1.00 → 1.08, centrerad. Lugn, premiumkänsla.',
    camera: (p) => ({ zoom: 1.0 + 0.08 * p, panX: 0, panY: -0.04 * p, depth: 2 * p }),
  },
  drift: {
    label: 'Drift',
    describe: 'Sidled panorering vänster→höger + minimal inzoom (1.00 → 1.03).',
    camera: (p) => ({ zoom: 1.0 + 0.03 * p, panX: -0.5 + 1.0 * p, panY: 0, depth: 3 * (0.5 - Math.abs(p - 0.5)) * 2 }),
  },
  hero: {
    label: 'Hero',
    describe: 'Inzoom (1.00 → 1.07) + drift + lätt djup-sway. Den kompletta produktfilmen.',
    camera: (p) => ({
      zoom: 1.0 + 0.07 * p,
      panX: 0.35 * Math.sin(p * Math.PI),        // out and back, subtle
      panY: -0.05 * p,
      depth: 4 * Math.sin(p * Math.PI),          // depth swells mid-shot, settles
    }),
  },
  orbit: {
    label: 'Orbit',
    describe: 'Simulerad rotation: horisontellt djup svänger ± medan kameran mot-panorerar — plagget vrider sig några grader. 2.5D:s maxgräns.',
    camera: (p) => {
      // One full sway: centre → right → centre → left → centre. The rotation
      // illusion = HORIZONTAL depth displacement (foreground swings opposite the
      // camera pan) — no vertical component, like a real y-axis turn.
      const a = Math.sin(p * Math.PI * 2);
      return { zoom: 1.05, panX: -0.3 * a, panY: 0, depthX: 18 * a, depthY: 1.5 * a };
    },
  },
};

/**
 * createParallaxScene({ garment, artworkUrl, tuning }) → Promise<scene>
 *
 * scene:
 *   canvas                         — live <canvas> (OUTPUT_W × OUTPUT_H)
 *   setPreset(key)                 — swap animation preset
 *   play({ durationMs, loop })     — start/restart the camera move
 *   stop()                         — pause the ticker
 *   onCycle(cb)                    — fires when one non-loop cycle completes
 *   destroy()
 */
export const createParallaxScene = async ({ garment, artworkUrl, viewId = 'front', colorwayId = 'white', tuning = null }) => {
  const cfg = compositorConfigFor(garment, viewId, colorwayId);
  if (!cfg) throw new Error('Parallax: 3D-konfiguration saknas.');
  if (tuning) cfg.tuning = { ...cfg.tuning, ...tuning };

  // 1) Real compositor → hero frame (printed-on garment).
  const comp = await createDisplacementCompositor(cfg);
  await comp.setArtwork(artworkUrl);
  // A generous, centred placement so the motif reads in the film.
  comp.setPlacement({ xMm: 30, yMm: 40, wMm: 240, rotationDeg: 0 });
  const heroBlob = await comp.extractPNG();
  const heroUrl = URL.createObjectURL(heroBlob);
  const heroImg = await loadImageEl(heroUrl);
  const heroTex = Texture.from(heroImg);
  comp.destroy(); // done with the compositor; we own the hero frame now

  // The raw garment displacement map drives depth parallax.
  const mapImg = await loadImageEl(cfg.assets.displacementUrl);
  const mapTex = Texture.from(mapImg);

  // 2) Our camera scene.
  const app = new Application();
  await app.init({
    width: OUTPUT_W,
    height: OUTPUT_H,
    autoStart: false,
    antialias: true,
    backgroundAlpha: 1,
    background: '#f2f3f5',
    preference: 'webgl',
    useBackBuffer: true,
  });

  const camera = new Container();
  app.stage.addChild(camera);

  const hero = new Sprite(heroTex);
  hero.anchor.set(0.5);
  camera.addChild(hero);

  // Depth map sprite, registered to the hero frame (same aspect). renderable:false
  // — it only feeds the DisplacementFilter.
  const depthSprite = new Sprite(mapTex);
  depthSprite.anchor.set(0.5);
  depthSprite.renderable = false;
  camera.addChild(depthSprite);

  // Differential parallax filter. scale animates a few px so foreground fabric
  // (bright map) shifts more than the flat backdrop (dark map). padding covers
  // the reach so hero edges warp cleanly instead of clipping (the compositor's
  // edge-warp gotcha, same fix).
  const MAX_DEPTH_PX = 20; // orbit swings up to ±18px horizontally
  const depthFilter = new DisplacementFilter({ sprite: depthSprite, scale: 0, antialias: 'on' });
  depthFilter.padding = Math.ceil(8 + MAX_DEPTH_PX);
  hero.filters = [depthFilter];

  // "cover" base scale: fill the 4:5 frame from the hero's native aspect.
  const coverScale = Math.max(OUTPUT_W / heroImg.width, OUTPUT_H / heroImg.height);
  // Overshoot margin available for panning without exposing background edges.
  const marginX = (heroImg.width * coverScale - OUTPUT_W) / 2;
  const marginY = (heroImg.height * coverScale - OUTPUT_H) / 2;

  let preset = PRESETS.hero;
  let durationMs = 6000;
  let loop = false;
  let startT = 0;
  let running = false;
  let cycleCb = null;

  const applyFrame = (p) => {
    const cam = preset.camera(p);
    const s = coverScale * cam.zoom;
    hero.scale.set(s);
    depthSprite.scale.set(s);
    // Keep the sprite centred, then offset by the pan (bounded by the margin so
    // we never reveal the backdrop past the cover crop). Extra zoom widens margin.
    const zMarginX = (heroImg.width * s - OUTPUT_W) / 2;
    const zMarginY = (heroImg.height * s - OUTPUT_H) / 2;
    const cx = OUTPUT_W / 2 + cam.panX * Math.min(marginX + 40, zMarginX);
    const cy = OUTPUT_H / 2 + cam.panY * Math.min(marginY + 40, zMarginY);
    hero.position.set(cx, cy);
    depthSprite.position.set(cx, cy);
    // Differential depth parallax; presets may drive x/y separately (orbit uses
    // horizontal-only for a y-axis-turn illusion) or a single uniform `depth`.
    depthFilter.scale.set(cam.depthX ?? cam.depth ?? 0, cam.depthY ?? cam.depth ?? 0);
    app.render();
  };

  const tick = () => {
    if (!running) return;
    const now = performance.now();
    let p = (now - startT) / durationMs;
    if (p >= 1) {
      if (loop) {
        startT = now - ((now - startT) % durationMs);
        p = ((now - startT) / durationMs);
      } else {
        applyFrame(easeInOut(1));
        running = false;
        app.ticker.stop();
        if (cycleCb) cycleCb();
        return;
      }
    }
    applyFrame(easeInOut(loop ? (p % 1) : p));
  };
  app.ticker.add(tick);

  applyFrame(0);

  return {
    canvas: app.canvas,
    setPreset(key) {
      if (PRESETS[key]) preset = PRESETS[key];
      applyFrame(0);
    },
    play({ durationMs: d = 6000, loop: l = false } = {}) {
      durationMs = d;
      loop = l;
      startT = performance.now();
      running = true;
      app.ticker.start();
    },
    stop() {
      running = false;
      app.ticker.stop();
    },
    onCycle(cb) { cycleCb = cb; },
    get durationMs() { return durationMs; },
    destroy() {
      running = false;
      try { app.destroy(true, { children: true, texture: true }); } catch { /* gone */ }
      URL.revokeObjectURL(heroUrl);
    },
  };
};
