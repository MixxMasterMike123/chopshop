// displacementCompositor.js — the 2.5D photo-displacement mockup engine (Pixi v8).
//
// The Printful/Printify "smart mockup" recipe, real-time in WebGL:
//   photo of the blank garment (base sprite)
//   → artwork sprite placed in the print area (position/scale/ROTATION, mm-driven)
//   → masked to the print area (never spills onto collar/sleeves/background)
//   → DisplacementFilter warps the artwork along the fabric folds (grayscale map,
//     mid-gray = zero shift; the map is registered to ITS photo — same px dims)
//   → blendMode + alpha ink the artwork into the garment's shadows
//   → render → extract PNG.
//
// NOT CGI, NOT three.js, NOT AI — a deterministic image compositor. Pixi v8 API
// throughout: async Application.init, Assets.load, string blend modes.
//
// TUNING KNOBS (cfg.tuning):
//   displacementScale     — warp strength in px at full black/white
//   displacementBlur      — gaussian blur (map px) at load; kills JPEG block noise
//   displacementContrast  — amplifies the map's folds; MEAN-CENTERED on the map's
//                           print-area mean (not fixed mid-gray), so it does NOT
//                           slide the artwork off the mask and maps need not be
//                           authored centred on mid-gray. Applied ALWAYS: even at
//                           C=1 it re-centres the print area on 128, cancelling the
//                           map's DC offset (a small uniform de-bias, folds intact).
//   blend / alpha         — how the warped artwork inks into the garment
//   output                — product-image resolution, independent of print DPI
//
// COORDINATES: everything inside the root container lives in PHOTO PIXELS (the
// view's w/h); the root is scaled once to the OUTPUT resolution. Placement stays
// in physical mm exactly like the flat studio: printArea (photo px) ↔ printAreaMm
// give the px-per-mm bridge, so the same {xMm,yMm,wMm} renders identically here
// and in the flat mockup. rotationDeg rotates around the artwork's centre.
//
// PRINT PATH: untouched by construction — the print file is the artwork ORIGINAL
// (podUpload), never a render of any mockup. This module is display-only.
//
// Import this module LAZILY (dynamic import) — pixi.js is its own chunk and must
// not enter the main admin bundle.
import {
  Application, Container, Sprite, Graphics, DisplacementFilter, Texture,
} from 'pixi.js';
// Side-effect import REQUIRED for multiply/overlay & co in Pixi v8: they are
// "advanced" blend modes implemented via backdrop-reading filters — without this
// they don't composite (multiply rendered the artwork as a black slab).
import 'pixi.js/advanced-blend-modes';

// Blend modes we allow from config ('overlay' is often the most fabric-real:
// shadows darken the ink, highlights lift it).
const ALLOWED_BLENDS = new Set(['normal', 'multiply', 'screen', 'overlay', 'add']);

// Load an image from ANY url kind. NOT Assets.load: it sniffs the loader from
// the file extension, so extension-less blob:/object URLs (uploaded artwork) and
// token-suffixed Storage URLs fail parser detection. A manual <img> decode is
// deterministic for every source we feed it.
const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous'; // Storage download URLs serve ACAO:* — no canvas taint
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Kunde inte läsa bilden för 3D-mockupen.'));
  // CACHE FOOTGUN: the same Storage URL is loaded elsewhere on the page by plain
  // <img> tags (picker/canvas/strip) WITHOUT CORS mode. The browser may serve
  // that cached non-CORS response to THIS crossOrigin request, which then
  // rejects. A fixed query param gives the CORS variant its own cache entry.
  // data:/blob: URLs are untouched (no network, no CORS).
  img.src = /^https?:/i.test(src)
    ? `${src}${src.includes('?') ? '&' : '?'}corsbust=2`
    : src;
});

const loadTexture = async (src) => Texture.from(await loadImage(src));

// Grayscale mean (Rec.601 luminance) over a rect of a 2D context, sampling every
// 4th pixel for speed. Used to find the map's DC level in the PRINT AREA.
const rectMeanLuminance = (g, rect, cw, ch) => {
  const x0 = Math.max(0, Math.min(cw - 1, Math.round(rect?.x ?? 0)));
  const y0 = Math.max(0, Math.min(ch - 1, Math.round(rect?.y ?? 0)));
  const rw = Math.max(1, Math.min(cw - x0, Math.round(rect?.w ?? cw)));
  const rh = Math.max(1, Math.min(ch - y0, Math.round(rect?.h ?? ch)));
  const { data } = g.getImageData(x0, y0, rw, rh);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 16) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n += 1;
  }
  return n ? sum / n : 128;
};

// Build the displacement texture that drives the warp. Two passes, in order:
//
//  1) BLUR. JPEG maps carry 8×8 block noise that QUANTIZES the displacement field
//     — artwork edges then shift in discrete jumps and read as stair-steps. A
//     gaussian blur at load (the Affinity recipe's "blur the map" step) smooths
//     the field; blurPx is in MAP pixels (JPEG blocks are 8px → default 6 kills
//     them without flattening folds). Old Safari lacks ctx.filter → downscale→
//     upscale resample approximates the blur.
//
//  2) MEAN-CENTERED CONTRAST. DisplacementFilter shifts each artwork pixel by
//     (luminance/255 − 0.5) × scale, so the map's MEAN luminance is a uniform DC
//     translation of the whole artwork, and only the DEVIATION from the mean is
//     the fold detail. We remap  v' = clamp((v − mean)*C + 128)  where `mean` is
//     measured over the PRINT AREA (blurred). This:
//       • RE-CENTERS the print area on 128 → cancels the map's DC offset, so the
//         artwork no longer carries a constant sideways/vertical bias (dev map
//         print-area mean ≈166 → ~4.5px bias removed at C=1). Folds unchanged.
//       • AMPLIFIES the folds by C WITHOUT sliding the artwork off the mask (a
//         fixed-128 pivot would multiply the DC offset too and shove weak maps
//         out of the print area — the exact failure this replaces).
//     Maps therefore need NOT be authored centred on mid-gray. Applied ALWAYS
//     (even at C=1, for the DC-neutralising re-centre).
//
// Returns a canvas-backed Pixi Texture.
const loadDisplacementTexture = async (img, blurPx, contrast = 1, printArea = null) => {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  const C = contrast > 0 ? contrast : 1;

  // Pass 1 — blur.
  if (typeof g.filter === 'string') {
    g.filter = blurPx ? `blur(${blurPx}px)` : 'none';
    g.drawImage(img, 0, 0);
    g.filter = 'none';
  } else if (blurPx) {
    const small = document.createElement('canvas');
    const f = Math.max(2, Math.round(blurPx));
    small.width = Math.max(1, Math.round(img.naturalWidth / f));
    small.height = Math.max(1, Math.round(img.naturalHeight / f));
    small.getContext('2d').drawImage(img, 0, 0, small.width, small.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, 0, 0, c.width, c.height);
  } else {
    g.drawImage(img, 0, 0);
  }

  // Pass 2 — mean-centered contrast (manual pixel loop; a canvas filter can't
  // pivot on an arbitrary mean). Measure the mean AFTER the blur so it reflects
  // the field the warp actually samples.
  const mean = rectMeanLuminance(g, printArea, c.width, c.height);
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.max(0, Math.min(255, (px[i] - mean) * C + 128));
    px[i + 1] = Math.max(0, Math.min(255, (px[i + 1] - mean) * C + 128));
    px[i + 2] = Math.max(0, Math.min(255, (px[i + 2] - mean) * C + 128));
  }
  g.putImageData(data, 0, 0);
  return Texture.from(c);
};

/**
 * createDisplacementCompositor(cfg) → Promise<compositor>
 *
 * cfg:
 *   view        — { w, h, printArea: {x,y,w,h} }  (photo px space)
 *   printAreaMm — { w, h }                        (physical size of printArea)
 *   assets      — { photoUrl, displacementUrl, maskUrl? }
 *   tuning      — { displacementScale, displacementBlur, displacementContrast, blend, alpha }
 *   output      — { w, h }  canvas/PNG resolution (independent of print DPI)
 *
 * compositor:
 *   canvas                       — the live <canvas> (append it to the DOM)
 *   setPhoto(url) → Promise      — replace only the garment photo (map/GPU stay live)
 *   setArtwork(url) → Promise    — load/replace the artwork texture
 *   setPlacement({xMm,yMm,wMm,rotationDeg}) — reposition (artwork aspect from its texture)
 *   setTuning({displacementScale?, displacementContrast?, blend?, alpha?}) — live tuning knobs
 *                                (contrast triggers a guarded async map rebuild)
 *   extractPNG() → Promise<Blob> — the product image at output resolution
 *   destroy()                    — full teardown (GPU + textures)
 */
export const createDisplacementCompositor = async ({ view, printAreaMm, assets, tuning = {}, output }) => {
  if (!view?.w || !view?.h || !view?.printArea) throw new Error('3D-mockup: ogiltig vy-konfiguration.');
  if (!printAreaMm?.w || !printAreaMm?.h) throw new Error('3D-mockup: printAreaMm saknas.');
  if (!assets?.photoUrl || !assets?.displacementUrl) throw new Error('3D-mockup: foto eller displacement-karta saknas i konfigurationen.');

  const outW = Math.round(output?.w || 1600);
  const outH = Math.round(output?.h || Math.round((outW * view.h) / view.w));

  // The compositor ALWAYS owns its canvas (callers append app.canvas to the DOM
  // once ready). Never init Pixi onto a caller-owned canvas: destroy() runs
  // WEBGL_lose_context.loseContext(), and a canvas whose context was lost can
  // never hand out a fresh one — a second init on the same element (StrictMode
  // double-mount, effect re-run) then renders into a dead context → permanently
  // black canvas. That was the step-4 "flickering black screen".
  const app = new Application();
  await app.init({
    width: outW,
    height: outH,
    autoStart: false,          // render-on-demand — this is a compositor, not a scene
    antialias: true,
    backgroundAlpha: 1,
    background: '#ffffff',
    preference: 'webgl',
    // REQUIRED for multiply/overlay & co: backdrop-reading blend modes need to
    // sample "what pixels they draw onto". Pixi's WebGL renderer only provides
    // that when it renders via a back buffer — and the DEFAULT is false, which
    // made multiply ink the artwork against an EMPTY backdrop → black slab
    // (screen survived only because screen-vs-empty degenerates to normal — it
    // never actually picked up the garment's shadows either).
    useBackBuffer: true,
  });

  // Root container in PHOTO px space, scaled once to the output resolution.
  const root = new Container();
  root.scale.set(outW / view.w, outH / view.h);
  app.stage.addChild(root);

  // The map's ORIGINAL HTMLImageElement is kept in closure so displacementContrast
  // can be re-applied LIVE (rebuild the canvas pass) without re-fetching.
  const dispBlur = tuning.displacementBlur ?? 6;
  const [photoTex, initialDispImg, maskTex] = await Promise.all([
    loadTexture(assets.photoUrl),
    loadImage(assets.displacementUrl),
    assets.maskUrl ? loadTexture(assets.maskUrl) : Promise.resolve(null),
  ]);
  let dispImg = initialDispImg;
  const dispTex = await loadDisplacementTexture(dispImg, dispBlur, tuning.displacementContrast ?? 1, view.printArea);

  // 1) Base: the blank-garment photograph, filling the view.
  const photo = new Sprite(photoTex);
  photo.width = view.w;
  photo.height = view.h;
  root.addChild(photo);

  // 3-prep) Displacement sprite: the grayscale map, registered to the photo →
  // same placement, full view. In the tree so the filter picks up its transform,
  // but never drawn (it would paint the gray map over the photo).
  const dispSprite = new Sprite(dispTex);
  dispSprite.width = view.w;
  dispSprite.height = view.h;
  dispSprite.renderable = false;
  root.addChild(dispSprite);

  // 2) Artwork layer: a container masked to the print area; the sprite inside is
  // anchored at its centre so rotationDeg rotates in place.
  //
  // MASK BLEED (re-probed 2026-08-17, current Pixi clips the filter's OUTPUT at
  // the mask — a full-printyta artwork rendered ZERO ink pixels outside the
  // rect, contradicting the earlier input-clip observation): a mask drawn
  // exactly on the print-area rect slices the warp's fabric waves ruler-flat at
  // the boundary, which reads as a printed sticker instead of ink on cloth. The
  // rect mask is therefore EXPANDED by the filter's own padding (= the shader's
  // max displacement excursion, scale/2 px, plus headroom — see applyTuning), so
  // warped ink survives just past the printyta the way pulled fabric would,
  // while the mask still stops anything from reaching collar/sleeves/backdrop.
  // Display-only by construction: placement stays clamped INSIDE the printyta
  // and the print file is the artwork original — the bleed exists only on the
  // product image. The Graphics rect is (re)drawn in applyTuning, which owns the
  // padding value it must track (and setSurface re-runs it on view changes).
  const artLayer = new Container();
  root.addChild(artLayer);

  let mask;
  if (maskTex) {
    mask = new Sprite(maskTex);
    mask.width = view.w;
    mask.height = view.h;
  } else {
    // Placeholder rect — applyTuning() below immediately redraws it with the
    // scale-dependent bleed before the first render.
    const r = view.printArea;
    mask = new Graphics().rect(r.x, r.y, r.w, r.h).fill(0xffffff);
  }
  root.addChild(mask);
  artLayer.mask = mask;

  // Redraw the generated rect mask around the CURRENT print area with the
  // CURRENT warp bleed. No-op for registered photo-alpha masks (maskTex).
  const redrawRectMask = (bleed) => {
    if (maskTex || !(mask instanceof Graphics)) return;
    const r = view.printArea;
    mask.clear()
      .rect(r.x - bleed, r.y - bleed, r.w + bleed * 2, r.h + bleed * 2)
      .fill(0xffffff);
  };

  const artSprite = new Sprite();
  artSprite.anchor.set(0.5);
  artLayer.addChild(artSprite);

  // 3+4) The warp + the ink.
  const state = {
    displacementScale: tuning.displacementScale ?? 30,
    displacementContrast: tuning.displacementContrast ?? 1,
    blend: ALLOWED_BLENDS.has(tuning.blend) ? tuning.blend : 'multiply',
    alpha: tuning.alpha ?? 0.8,
    placement: null,
    surfaceKey: null,
    surfaceUrl: assets.displacementUrl,
  };
  let destroyed = false;
  let contrastToken = 0; // guards against out-of-order async rebuilds
  let surfaceToken = 0;
  let photoToken = 0;
  let artworkToken = 0;
  // antialias:'on' forces the filter's INTERMEDIATE render target to be
  // multisampled. Without it (Pixi's default is 'off' even when the Application
  // has antialias:true — the app flag only AAs final-stage geometry, not a
  // filter's own buffer), the warp resamples artwork edges into a hard, aliased
  // boundary → stair-stepped motif edges, worst at high displacement/contrast
  // (exactly when the shift is largest). The app render target IS antialiased
  // (Application.init antialias:true above), so 'on' is safe per the Pixi docs.
  // Display-only: the DisplacementFilter is on the product-image artLayer, never
  // the print file.
  const dispFilter = new DisplacementFilter({
    sprite: dispSprite,
    scale: state.displacementScale,
    antialias: 'on',
  });
  artLayer.filters = [dispFilter];

  let pxPerMmX = view.printArea.w / printAreaMm.w;
  let pxPerMmY = view.printArea.h / printAreaMm.h;

  const applyTuning = () => {
    dispFilter.scale.set(state.displacementScale);
    // CRITICAL: Pixi renders a filtered container into an intermediate texture
    // the size of its bounds + filter.padding — and the DEFAULT padding is 0, so
    // displaced pixels could never LEAVE the artwork's own rectangle: interior
    // warped, edges stayed ruler-straight ("warp inside the container"). The
    // shader's max shift is scale/2 px ((map−0.5)·scale, |map−0.5| ≤ 0.5); pad
    // by that plus headroom so the artwork edges genuinely warp.
    dispFilter.padding = Math.ceil(8 + (state.displacementScale || 0) * 0.6);
    // Mask bleed tracks the padding: the mask must admit exactly as much warp
    // excursion as the filter can produce (see MASK BLEED above).
    redrawRectMask(dispFilter.padding);
    // Blend/alpha go on the FILTERED CONTAINER, not the sprite: a filtered
    // container renders its children into an intermediate texture first, so a
    // sprite-level multiply blends against that buffer's EMPTY (black) backdrop
    // → solid black artwork. On the container, the blend applies where the
    // filter's OUTPUT composites with the photo — which is the whole point.
    // Blend goes on the FILTER, not the sprite/container (pixi maintainer's
    // answer in pixijs#7224, "working as intended"): filter.blendMode sets how
    // the filter's OUTPUT composites onto the scene, via the NATIVE GL blend —
    // no backdrop reading needed. Container-level blend on a filtered container
    // applies inside the filter pipeline against an EMPTY buffer: multiply
    // rendered black, and screen/overlay silently degenerated to normal ("blend
    // modes do nothing").
    dispFilter.blendMode = state.blend;
    artLayer.alpha = state.alpha;
  };

  const applyPlacement = () => {
    const p = state.placement;
    const tex = artSprite.texture;
    if (!p || !tex || tex.width <= 1) { artSprite.visible = false; return; }
    artSprite.visible = true;
    const wPx = p.wMm * pxPerMmX;
    const hPx = wPx * (tex.height / tex.width); // aspect from the artwork itself
    artSprite.width = wPx;
    artSprite.height = hPx;
    // xMm/yMm are the artwork's TOP-LEFT within the print area (studio convention);
    // the sprite is centre-anchored for rotation, so offset by half.
    artSprite.position.set(
      view.printArea.x + p.xMm * pxPerMmX + wPx / 2,
      view.printArea.y + p.yMm * pxPerMmY + hPx / 2
    );
    artSprite.rotation = ((p.rotationDeg || 0) * Math.PI) / 180;
  };

  const render = () => { if (!destroyed) app.render(); };
  const contextIsLost = () => Boolean(
    app.renderer?.context?.isLost || app.renderer?.gl?.isContextLost?.()
  );

  // Read back what the compositor ACTUALLY drew, from the presented canvas.
  //
  // NEVER via app.renderer.extract: Pixi's extract system re-renders the stage
  // into an offscreen texture, and in Firefox that offscreen pass silently drops
  // the DisplacementFilter's output — extract sees only the garment photograph
  // while the live canvas shows the warped artwork perfectly (probed 2026-08-16
  // with a with/without-artwork pixel diff: extract delta = 0 in every renderer
  // config, live-canvas delta = thousands of px; Chrome extract works). The old
  // extract-based probe therefore declared healthy Firefox renders blank and
  // pushed every Firefox user onto the flat un-warped fallback.
  //
  // drawImage(app.canvas) into a 2D canvas reads the real framebuffer in every
  // browser — but ONLY in the same task as app.render(): the context runs with
  // preserveDrawingBuffer:false, so the buffer is not guaranteed to survive the
  // browser's next composite.
  const captureRegion = (sx, sy, sw, sh, dw, dh, g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, dw, dh);
    g.drawImage(app.canvas, sx, sy, sw, sh, 0, 0, dw, dh);
    return g.getImageData(0, 0, dw, dh).data;
  };

  // Truth-check for the render pipeline: does the artwork actually appear on the
  // canvas? Compares a small (≤96 px) capture of the artwork's region with the
  // same scene while the artwork is hidden — cheap, and immune to "the render
  // completed without throwing but drew nothing" failure modes (context loss,
  // driver drops). Runs BEFORE a preview canvas is shown, so the visibility
  // toggle never flashes on screen.
  const hasVisibleArtwork = () => {
    if (destroyed || contextIsLost() || !state.placement || !artSprite.visible) return false;
    const p = state.placement;
    const tex = artSprite.texture;
    if (!tex || tex.width <= 1) return false;

    const outScaleX = outW / view.w;
    const outScaleY = outH / view.h;
    const w = p.wMm * pxPerMmX * outScaleX;
    const h = p.wMm * pxPerMmX * (tex.height / tex.width) * outScaleY;
    const x = (view.printArea.x + p.xMm * pxPerMmX) * outScaleX;
    const y = (view.printArea.y + p.yMm * pxPerMmY) * outScaleY;
    const radians = ((p.rotationDeg || 0) * Math.PI) / 180;
    const rotatedW = Math.abs(w * Math.cos(radians)) + Math.abs(h * Math.sin(radians));
    const rotatedH = Math.abs(w * Math.sin(radians)) + Math.abs(h * Math.cos(radians));
    const padX = Math.ceil((dispFilter.padding || 0) * outScaleX);
    const padY = Math.ceil((dispFilter.padding || 0) * outScaleY);
    const left = Math.max(0, Math.floor(x + w / 2 - rotatedW / 2 - padX));
    const top = Math.max(0, Math.floor(y + h / 2 - rotatedH / 2 - padY));
    const right = Math.min(outW, Math.ceil(x + w / 2 + rotatedW / 2 + padX));
    const bottom = Math.min(outH, Math.ceil(y + h / 2 + rotatedH / 2 + padY));
    const srcW = Math.max(1, right - left);
    const srcH = Math.max(1, bottom - top);
    const probeScale = Math.min(1, 96 / Math.max(srcW, srcH));
    const dw = Math.max(1, Math.round(srcW * probeScale));
    const dh = Math.max(1, Math.round(srcH * probeScale));
    const probe = document.createElement('canvas');
    probe.width = dw;
    probe.height = dh;
    const g = probe.getContext('2d', { willReadFrequently: true });

    render();
    const withArtwork = captureRegion(left, top, srcW, srcH, dw, dh, g);
    artSprite.visible = false;
    render();
    const withoutArtwork = captureRegion(left, top, srcW, srcH, dw, dh, g);
    artSprite.visible = true;
    render();
    if (contextIsLost()) return false;

    let changed = 0;
    const pixelCount = withArtwork.length / 4;
    for (let i = 0; i < withArtwork.length; i += 4) {
      const delta = Math.abs(withArtwork[i] - withoutArtwork[i])
        + Math.abs(withArtwork[i + 1] - withoutArtwork[i + 1])
        + Math.abs(withArtwork[i + 2] - withoutArtwork[i + 2]);
      if (delta >= 18) changed += 1;
    }
    return changed >= Math.max(4, Math.floor(pixelCount * 0.001));
  };

  // Rebuild the displacement texture with the current contrast (re-runs the
  // canvas pass on the original map image) and hot-swap it into the sprite. The
  // DisplacementFilter re-reads sprite.texture.source on every apply(), so the
  // swap alone updates the warp — no filter poking needed.
  //
  // A monotonic token defeats out-of-order async: a slower older rebuild that
  // resolves after a newer one must NOT overwrite the newer texture. Bails if the
  // compositor was destroyed mid-rebuild.
  //
  // TEXTURE LIFECYCLE: never explicitly destroy a Texture or TextureSource here.
  // Pixi may reuse Texture objects and cache GPU BindGroups across compositors;
  // destroying a source during one mockup's teardown can therefore leave the
  // still-live step-4 preview with a null bind-group resource. Renderer teardown
  // releases this compositor's GPU resources. We only drop our JS references and
  // let Pixi/the browser collect the texture objects once nobody uses them.
  const parkedTextures = [];
  const surfaceKeyFor = (url, area, contrast = state.displacementContrast) =>
    `${url}:${area.x}:${area.y}:${area.w}:${area.h}:${dispBlur}:${contrast}`;
  state.surfaceKey = surfaceKeyFor(assets.displacementUrl, view.printArea);
  const surfaceTextures = new Map([
    [state.surfaceKey, { texture: dispTex, image: dispImg }],
  ]);
  const surfaceLoads = new Map();

  const loadSurfaceTexture = (url, area) => {
    const key = surfaceKeyFor(url, area);
    if (surfaceTextures.has(key)) return Promise.resolve({ key, ...surfaceTextures.get(key) });
    if (surfaceLoads.has(key)) return surfaceLoads.get(key);
    const pending = (async () => {
      const image = await loadImage(url);
      const texture = await loadDisplacementTexture(
        image, dispBlur, state.displacementContrast, area
      );
      if (destroyed) return null;
      const loaded = { texture, image };
      surfaceTextures.set(key, loaded);
      return { key, ...loaded };
    })().finally(() => surfaceLoads.delete(key));
    surfaceLoads.set(key, pending);
    return pending;
  };
  const rebuildDisplacement = async () => {
    const myToken = ++contrastToken;
    const nextTex = await loadDisplacementTexture(dispImg, dispBlur, state.displacementContrast, view.printArea);
    if (destroyed || myToken !== contrastToken) return;
    const oldTex = dispSprite.texture;
    dispSprite.texture = nextTex;
    if (oldTex && oldTex !== nextTex) parkedTextures.push(oldTex); // free at teardown
    state.surfaceKey = surfaceKeyFor(state.surfaceUrl, view.printArea);
    surfaceTextures.set(state.surfaceKey, { texture: nextTex, image: dispImg });
    render();
  };

  applyTuning();
  render();

  return {
    canvas: app.canvas,

    async setPhoto(url) {
      const myToken = ++photoToken;
      const tex = await loadTexture(url);
      if (destroyed || myToken !== photoToken) return;
      const oldTex = photo.texture;
      photo.texture = tex;
      photo.width = view.w;
      photo.height = view.h;
      if (oldTex && oldTex !== Texture.EMPTY && oldTex !== tex) parkedTextures.push(oldTex);
      render();
    },

    async setSurface({ printArea, printAreaMm: nextAreaMm, displacementUrl }) {
      if (!printArea?.w || !printArea?.h || !nextAreaMm?.w || !nextAreaMm?.h || !displacementUrl) return;
      const myToken = ++surfaceToken;
      const loaded = await loadSurfaceTexture(displacementUrl, printArea);
      if (!loaded || destroyed || myToken !== surfaceToken) return;

      dispSprite.texture = loaded.texture;
      dispImg = loaded.image;
      state.surfaceKey = loaded.key;
      state.surfaceUrl = displacementUrl;
      view.printArea = { ...printArea };
      pxPerMmX = printArea.w / nextAreaMm.w;
      pxPerMmY = printArea.h / nextAreaMm.h;

      // Registered tee surfaces use the generated rectangular mask. Rebuild it
      // in place (with the warp bleed) so front/back can share one renderer.
      redrawRectMask(dispFilter.padding);
      applyPlacement();
      render();
    },

    async setArtwork(url) {
      const myToken = ++artworkToken;
      const tex = await loadTexture(url);
      if (destroyed || myToken !== artworkToken) return;
      const oldTex = artSprite.texture;
      artSprite.texture = tex;
      if (oldTex && oldTex !== Texture.EMPTY && oldTex !== tex) parkedTextures.push(oldTex);
      applyPlacement();
      render();
    },

    setPlacement(placement) {
      if (destroyed) return;
      state.placement = placement;
      applyPlacement();
      render();
    },

    setTuning({ displacementScale, displacementContrast, blend, alpha } = {}) {
      if (destroyed) return;
      if (displacementScale !== undefined) state.displacementScale = displacementScale;
      if (blend !== undefined && ALLOWED_BLENDS.has(blend)) state.blend = blend;
      if (alpha !== undefined) state.alpha = alpha;
      // Contrast changes the MAP TEXTURE → async rebuild (guarded), not applyTuning.
      const contrastChanged =
        displacementContrast !== undefined && displacementContrast !== state.displacementContrast;
      if (displacementContrast !== undefined) state.displacementContrast = displacementContrast;
      applyTuning();
      render();
      if (contrastChanged) rebuildDisplacement();
    },

    hasVisibleArtwork,

    async extractPNG() {
      if (destroyed) throw new Error('Mockup-kompositorn är stängd.');
      if (contextIsLost()) throw new Error('WebGL-kontexten för mockupen gick förlorad.');
      render();
      if (contextIsLost()) throw new Error('WebGL-kontexten för mockupen gick förlorad.');
      // Same-task copy of the presented framebuffer — NOT renderer.extract (its
      // offscreen re-render drops the displacement warp in Firefox, see the
      // captureRegion comment above).
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      canvas.getContext('2d').drawImage(app.canvas, 0, 0);
      if (contextIsLost()) throw new Error('WebGL-kontexten för mockupen gick förlorad.');
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Kunde inte skapa produktbilden.'))),
          'image/png'
        );
      });
    },

    destroy() {
      if (destroyed) return;
      destroyed = true; // any in-flight contrast rebuild will no-op on resolve
      surfaceToken += 1;
      photoToken += 1;
      artworkToken += 1;
      parkedTextures.length = 0;
      surfaceTextures.clear();
      // removeView:true — the compositor owns its canvas; if a caller appended
      // it to the DOM, destroy detaches it there too.
      app.destroy(true, { children: true });
    },
  };
};
