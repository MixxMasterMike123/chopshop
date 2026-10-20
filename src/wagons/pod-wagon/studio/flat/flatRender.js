// flatRender.js — the flat print drawn on a 2D canvas (CP12 unit F3).
//
// Two pictures, both display-only (the PRINT is made by the server from the
// artwork's print master at the model's exact px: CP12_BRIEFS.md "The print
// pipeline"):
//   drawSheet       the sheet as it prints: the background (contain) and the
//                   motif placed cover/contain, centred — the same geometry as
//                   adapters/studioFlat.js fitRect, which the server follows.
//   renderFramed    the step-4 preview and the product's image: the sheet in
//                   its frame on a plain wall. The platform's mockup templates
//                   carry one print area per template, and a poster family has
//                   one aspect per SIZE, so a photographic poster template
//                   needs the mechanism to know a flat kind (per-size areas);
//                   until then this drawn frame is the preview (F3 report).
// The placement canvas (FlatCanvas, Pixi) falls back to drawSheet when WebGL
// cannot start.

import { fitRect } from '../../../../admin-app/adapters/studioFlat.js';

/**
 * Draw the sheet into `ctx` over (0, 0, w, h): the background when the fit is
 * contain, then the motif. `image` is a decoded image (or null: background only).
 */
export function drawSheet(ctx, { image, artW, artH, w, h, fit, background }) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.fillStyle = fit === 'contain' ? background || '#ffffff' : '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const r = image ? fitRect({ w: artW, h: artH }, { w, h }, fit) : null;
  if (r) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, r.x, r.y, r.w, r.h);
  }
  ctx.restore();
}

const makeCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

/** The sheet alone, its long edge `longPx` pixels. */
export function renderSheet({ image, artW, artH, mm, fit, background, longPx = 1400 }) {
  const k = longPx / Math.max(mm.w, mm.h);
  const canvas = makeCanvas(mm.w * k, mm.h * k);
  drawSheet(canvas.getContext('2d'), { image, artW, artH, w: canvas.width, h: canvas.height, fit, background });
  return canvas;
}

const FRAME_MM = 20; // the budget frame's moulding face, about 2 cm
const BLEED_HIDDEN_MM = 3; // the sheet's edge under the frame's lip

/**
 * The framed preview: a square image of `out` px with a plain wall, the frame
 * in the finish's colour, and the sheet inside (its outer 3 mm under the
 * frame's lip). The frame is drawn to the sheet's real proportions, so each
 * size reads as itself.
 */
export function renderFramed({ image, artW, artH, mm, fit, background, frameHex = '#f4f3ef', out = 1400 }) {
  const canvas = makeCanvas(out, out);
  const ctx = canvas.getContext('2d');
  // The wall: a quiet warm grey with a soft light from the top left.
  const wall = ctx.createLinearGradient(0, 0, out, out);
  wall.addColorStop(0, '#ecebe7');
  wall.addColorStop(1, '#dcdad4');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, out, out);

  const outerW = mm.w + 2 * FRAME_MM;
  const outerH = mm.h + 2 * FRAME_MM;
  const k = (out * 0.72) / Math.max(outerW, outerH); // px per mm
  const fw = outerW * k;
  const fh = outerH * k;
  const fx = (out - fw) / 2;
  const fy = (out - fh) / 2 - out * 0.02;

  // Shadow on the wall (offset down-right, soft).
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
  ctx.shadowBlur = out * 0.03;
  ctx.shadowOffsetX = out * 0.008;
  ctx.shadowOffsetY = out * 0.016;
  ctx.fillStyle = frameHex;
  ctx.fillRect(fx, fy, fw, fh);
  ctx.restore();

  // The moulding: the face, a light bevel on the top/left, a darker one bottom/right.
  ctx.fillStyle = frameHex;
  ctx.fillRect(fx, fy, fw, fh);
  const face = FRAME_MM * k;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.fillRect(fx, fy, fw, Math.max(1, face * 0.08));
  ctx.fillRect(fx, fy, Math.max(1, face * 0.08), fh);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.10)';
  ctx.fillRect(fx, fy + fh - face * 0.08, fw, face * 0.08);
  ctx.fillRect(fx + fw - face * 0.08, fy, face * 0.08, fh);

  // The visible sheet: the whole sheet drawn, its outer 3 mm under the lip.
  const sx = fx + face;
  const sy = fy + face;
  const sw = mm.w * k;
  const sh = mm.h * k;
  const hidden = BLEED_HIDDEN_MM * k;
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx + hidden, sy + hidden, sw - 2 * hidden, sh - 2 * hidden);
  ctx.clip();
  ctx.translate(sx, sy);
  drawSheet(ctx, { image, artW, artH, w: sw, h: sh, fit, background });
  ctx.restore();

  // The glaze: an inner shadow along the lip and a faint diagonal sheen.
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.lineWidth = Math.max(1, out * 0.002);
  ctx.strokeRect(sx + hidden, sy + hidden, sw - 2 * hidden, sh - 2 * hidden);
  const sheen = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.10)');
  sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0.04)');
  ctx.fillStyle = sheen;
  ctx.fillRect(sx + hidden, sy + hidden, sw - 2 * hidden, sh - 2 * hidden);
  ctx.restore();
  return canvas;
}

/** canvas → Promise<Blob> (WebP where the browser makes it, else PNG). */
export function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((webp) => {
      if (webp && webp.type === 'image/webp') return resolve(webp);
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('Bilden kunde inte skapas.'))), 'image/png');
    }, 'image/webp', 0.9);
  });
}
