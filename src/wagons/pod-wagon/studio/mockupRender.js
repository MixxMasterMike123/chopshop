// mockupRender.js — rasterize a Design Studio mockup: garment background (SVG flat
// OR per-colourway photo) + placed artwork → <canvas> → WebP (or PNG) blob.
//
// Browser-only, NO Firebase imports — the storage upload lives in mockupUpload.js
// so this renderer stays usable from the dev harness and any future export path
// (e.g. downloading a mockup to feed an image model). The math is the SAME
// placementMath the interactive canvas uses, so what the seller saw is what gets
// rasterized — the "inga tryck-överraskningar" contract extends to the export.
//
// The background comes from backgroundImageSource (templateBackground): a photo url
// for photo templates, or the SVG flat as a data URL for flat templates. Explicit
// width/height on the flat's root <svg> keep Safari from rasterizing it at 0×0.
import { templateViewBox, backgroundImageSource, viewForSlot } from './TemplateBackground';
import {
  pxPerMm, isComposable, placementHeightMm, clampPlacement, defaultPlacement,
} from './placementMath';

// Export resolution: viewBox × 2 (e.g. flat 800×900 → 1600×1800 px). Product-image
// class, not print class — the print file is the artwork ORIGINAL, decoupled by design.
export const MOCKUP_SCALE = 2;

// Load an image for canvas drawing. crossOrigin=anonymous so Firebase Storage
// download URLs (CORS: *) don't taint the canvas; harmless for data/object URLs.
const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Kunde inte läsa bilden för mockupen.'));
  img.src = src;
});

// canvas.toBlob with graceful format fallback: Safari ignores image/webp and
// returns PNG — we report the ACTUAL type back so filenames/paths stay truthful.
const canvasToBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error('Kunde inte skapa mockup-bilden.'));
  }, type, quality);
});

/**
 * createMockupSession() — shared WebGL state for a RUN of renderMockup calls.
 *
 * The generation loop renders (colourways × slots) mockups. Without a session
 * every displacement mockup spins up its OWN Pixi Application: a fresh WebGL
 * context (browsers cap ~16 live contexts and evict the oldest — which is the
 * step-4 preview's canvas → it goes black) and a full re-decode + blur +
 * contrast pass over the full-resolution fabric map, per mockup. With a session
 * the loop reuses ONE compositor: the map is processed once per view and only
 * photo/artwork/placement swap between renders. Call close() in a finally —
 * it drops the GPU context and all textures.
 */
export const createMockupSession = () => {
  const compositors = new Map();
  return {
    _get: (key) => compositors.get(key) || null,
    _set: (key, compositor) => { compositors.set(key, compositor); },
    _drop: (key) => { compositors.delete(key); },
    close: () => {
      for (const compositor of compositors.values()) {
        try { compositor.destroy(); } catch { /* renderer may already be gone */ }
      }
      compositors.clear();
    },
  };
};

/**
 * renderMockup({ template, colorway, slot, artwork, placement, session, … }) →
 *   Promise<{ blob, type: 'image/webp'|'image/png', width, height }>
 *
 * One mockup = one garment view: the garment background (flat in the colourway's
 * hex, or the colourway's photo) with the artwork drawn at its placement (mm →
 * viewBox px → export px). placement may be null → the slot's defaultPlacement
 * (same fallback the canvas shows). artwork may be null / non-composable →
 * garment-only mockup (still valid, e.g. a colourway with no print).
 *
 * For a PHOTO template whose colourway has NO photo, backgroundImageSource rejects
 * (in Swedish) — the exporter can't fabricate a backdrop, so we surface it (the
 * generation loop in DesignStudio already reports errors).
 */
export const renderMockup = async ({
  template, colorway, slot = 'front', artwork = null, placement = null, minDpi = null,
  scale = MOCKUP_SCALE, type = 'image/webp', quality = 0.92, background = '#ffffff',
  session = null,
}) => {
  const viewBox = templateViewBox(template);
  if (!viewBox) throw new Error('Okänd mall — kan inte generera mockup.');
  const W = Math.round(viewBox.w * scale);
  const H = Math.round(viewBox.h * scale);

  const areaRect = template.printAreas?.[slot];
  const ppm = pxPerMm(template, slot);
  const p = artwork && isComposable(artwork) && areaRect && ppm
    ? clampPlacement(
        placement || defaultPlacement(template, slot, artwork, minDpi),
        template, slot, artwork, minDpi
      )
    : null;

  // Photo templates may carry a registered fabric displacement map per view.
  // Reuse the proven Pixi compositor lazily so the ordinary bundle does not pay
  // for WebGL unless a warped mockup is actually generated. The template's
  // existing print area/mm mapping remains the source of truth; only its px rect
  // is scaled into the full-resolution map/photo coordinate space.
  const displacement = template?.photo?.displacement;
  const displacementUrl = displacement?.urls?.[viewForSlot(slot)] || null;
  if (p && displacementUrl) {
    // One compositor per (template, output size) within a session; without a
    // session the compositor lives for this single render only.
    const sessionKey = `${template.id}:${W}x${H}`;
    // Resolve the backdrop BEFORE touching the session compositor: a colourway
    // without a photo rejects here (benign per-item skip), and must not tear
    // down the session's renderer that later colourways still need. Its Swedish
    // error surfaces through the flat path below, same as before.
    const bgSrc = await backgroundImageSource(template, colorway, {
      widthPx: W, heightPx: H, slot,
    });
    const mapW = displacement.w || template.photo.w;
    const mapH = displacement.h || template.photo.h;
    const sx = mapW / viewBox.w;
    const sy = mapH / viewBox.h;
    const printArea = {
      x: areaRect.x * sx,
      y: areaRect.y * sy,
      w: areaRect.w * sx,
      h: areaRect.h * sy,
    };
    let compositor = session?._get(sessionKey) || null;
    // A reused session compositor may sit on a REVOKED WebGL context (the
    // browser reclaims contexts under GPU pressure — Firefox does this mid-
    // generation). That failure earns ONE retry on a freshly created context;
    // a failure on a fresh compositor means WebGL itself is unhealthy, so it
    // falls through to the flat renderer without burning another context.
    const attempts = compositor ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (compositor) {
          // Reused renderer: swap the view's map/geometry and this colourway's
          // photo. The compositor caches processed map textures per (url, area),
          // so front/back alternation costs no re-processing.
          await compositor.setSurface({
            printArea, printAreaMm: template.printAreaMm?.[slot], displacementUrl,
          });
          await compositor.setPhoto(bgSrc);
        } else {
          const { createDisplacementCompositor } = await import('./pixi/displacementCompositor');
          compositor = await createDisplacementCompositor({
            view: { w: mapW, h: mapH, printArea },
            printAreaMm: template.printAreaMm?.[slot],
            assets: { photoUrl: bgSrc, displacementUrl },
            tuning: {
              displacementScale: displacement.scale ?? 30,
              displacementBlur: displacement.blur ?? 6,
              displacementContrast: displacement.contrast ?? 1,
              blend: displacement.blend || 'normal',
              alpha: displacement.alpha ?? 1,
            },
            output: { w: W, h: H },
          });
          session?._set(sessionKey, compositor);
        }
        await compositor.setArtwork(artwork.previewUrl);
        compositor.setPlacement(p);
        if (!compositor.hasVisibleArtwork()) {
          throw new Error('WebGL-renderingen utelämnade motivet.');
        }
        // Pixi extraction is deliberately PNG: browser WebP encoders can leave a
        // WebGL readback promise unresolved (observed in headless Chrome). Return
        // the actual type so upload paths and download extensions stay truthful.
        const blob = await compositor.extractPNG();
        if (!session) compositor.destroy();
        return { blob, type: blob.type, width: W, height: H };
      } catch (error) {
        // WebGL can be evicted or unavailable on memory-constrained admin tabs.
        // A product image is still more useful than a frozen workflow, so this
        // one output continues through the deterministic flat 2D renderer below.
        console.warn(
          attempt + 1 < attempts
            ? 'Displacement mockup failed; retrying on a fresh WebGL context.'
            : 'Displacement mockup failed; using the flat renderer.',
          error
        );
        session?._drop(sessionKey);
        try { compositor?.destroy(); } catch { /* renderer may already be invalid */ }
        compositor = null;
      }
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Solid background — product images shouldn't ship with alpha (marketplaces
  // and the storefront cards expect a filled frame).
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);

  const bgSrc = await backgroundImageSource(template, colorway, { widthPx: W, heightPx: H, slot });
  const bgImg = await loadImage(bgSrc);
  ctx.drawImage(bgImg, 0, 0, W, H);

  if (p) {
    const artImg = await loadImage(artwork.previewUrl);
    const x = (areaRect.x + p.xMm * ppm.x) * scale;
    const y = (areaRect.y + p.yMm * ppm.y) * scale;
    const w = p.wMm * ppm.x * scale;
    const h = placementHeightMm(p, artwork) * ppm.y * scale;
    // Clip to the print area (belt-and-braces with the clamp), then rotate
    // around the artwork's centre — same semantics as the canvas + 3D view.
    ctx.save();
    ctx.beginPath();
    ctx.rect(areaRect.x * scale, areaRect.y * scale, areaRect.w * scale, areaRect.h * scale);
    ctx.clip();
    const deg = p.rotationDeg || 0;
    if (deg) {
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.globalAlpha = displacement ? (displacement.alpha ?? 1) : 1;
      ctx.drawImage(artImg, -w / 2, -h / 2, w, h);
    } else {
      ctx.globalAlpha = displacement ? (displacement.alpha ?? 1) : 1;
      ctx.drawImage(artImg, x, y, w, h);
    }
    ctx.restore();
  }

  const blob = await canvasToBlob(canvas, type, quality);
  return { blob, type: blob.type, width: W, height: H };
};
