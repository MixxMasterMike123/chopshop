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
import { templateViewBox, backgroundImageSource } from './TemplateBackground';
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
 * renderMockup({ template, colorway, slot, artwork, placement, … }) →
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
}) => {
  const viewBox = templateViewBox(template);
  if (!viewBox) throw new Error('Okänd mall — kan inte generera mockup.');
  const W = Math.round(viewBox.w * scale);
  const H = Math.round(viewBox.h * scale);

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

  const areaRect = template.printAreas?.[slot];
  const ppm = pxPerMm(template, slot);
  if (artwork && isComposable(artwork) && areaRect && ppm) {
    const p = clampPlacement(
      placement || defaultPlacement(template, slot, artwork, minDpi),
      template, slot, artwork, minDpi
    );
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
        ctx.drawImage(artImg, -w / 2, -h / 2, w, h);
      } else {
        ctx.drawImage(artImg, x, y, w, h);
      }
      ctx.restore();
    }
  }

  const blob = await canvasToBlob(canvas, type, quality);
  return { blob, type: blob.type, width: W, height: H };
};
