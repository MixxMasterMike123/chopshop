// pod3dUpload.js — the browser-side half of a 3D model-library asset set (garment
// photo + displacement map + optional mask) for the 2.5D displacement studio:
// the registration check, the web derivatives and the map-contrast measure.
// Browser-only (no React), and no storage of its own: the upload that uses these
// lives in the platform page's data module (src/pages/platform/platformModelsData.js
// for the older build; the admin build's alias list swaps in
// src/admin-app/replacements/platformModelsData.js).
//
// INVARIANTS this module enforces / relies on:
//  • REGISTRATION: within one (view, colorway) the photo, displacement map and
//    (optional) mask MUST have IDENTICAL pixel dimensions — they are derived from
//    the same frame; a mismatch means they are not registered and the warp would
//    smear artwork off the garment. validateModelAssetSet is the gate.
//  • DERIVATIVES ARE WHAT THE STUDIO RENDERS: the pixi compositor loads the web
//    derivatives (photo-1600 / map-1600 / mask-1600), so the model doc's coordinate
//    space (view.w/h, printArea px) is DERIVATIVE px, not original px. Because the
//    originals share dims and the downscale math is deterministic, the derivatives
//    also share dims (the upload asserts it).
//  • ORIGINAL-DIMS ARE THE VALIDATION SPACE: colorways added later to the same view
//    are validated against the view's stored originalDims (expectedOriginalDims) so
//    every colorway of a view stays registered to the same frame.
import { readImageDimensions, extOf } from './podUpload';

const DERIVATIVE_MAX_EDGE = 1600; // longest-edge cap for the web derivatives

// Displacement-map contrast floor. A map whose folds sit too close to mid-gray
// barely warps the artwork (DisplacementFilter shifts by (luminance−0.5)×scale),
// so edges render dead straight and the 3D-vy looks flat. MEASURED EVIDENCE: a
// weak operator map read sd≈18 over its print area, a good one sd≈52 — 25 sits
// safely between them. Below this we WARN the operator (and store the number).
export const LOW_CONTRAST_SD_THRESHOLD = 25;

/**
 * measureMapContrastSd(canvas) → number
 * Grayscale std-dev of the luminance over the CENTER 60% of the canvas (the print
 * area isn't calibrated at upload time, so we sample the middle where the print
 * usually lands). Standard Rec.601 luminance (0.299/0.587/0.114); every 4th pixel
 * for speed. Higher = more fold detail = warps better.
 */
export const measureMapContrastSd = (canvas) => {
  const cw = canvas.width;
  const ch = canvas.height;
  if (!cw || !ch) return 0;
  const x0 = Math.floor(cw * 0.2);
  const y0 = Math.floor(ch * 0.2);
  const rw = Math.max(1, Math.floor(cw * 0.6));
  const rh = Math.max(1, Math.floor(ch * 0.6));
  const { data } = canvas.getContext('2d').getImageData(x0, y0, rw, rh);
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  // step 16 bytes = every 4th pixel (4 bytes/pixel).
  for (let i = 0; i < data.length; i += 16) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum;
    sumSq += lum * lum;
    n += 1;
  }
  if (!n) return 0;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return Math.sqrt(variance);
};

/**
 * readDimsOrThrow(file, roleSv) → Promise<{ w, h }>
 * Reads a raster file's pixel dims; throws (Swedish) for formats the browser can't
 * decode (PDF/SVG/TIFF…) — model assets must be raster.
 */
const readDimsOrThrow = async (file) => {
  const { width, height } = await readImageDimensions(file);
  if (!width || !height) {
    throw new Error('Filen måste vara en rasterbild (JPEG/PNG/WebP).');
  }
  return { w: width, h: height };
};

/**
 * validateModelAssetSet({ photoFile, displacementFile, maskFile? }, expectedViewDims?)
 *   → Promise<{ w, h }>  (ORIGINAL pixel dims of the set)
 * Confirms the photo, map and (optional) mask are registered — identical ORIGINAL
 * pixel dims — and, when expectedViewDims ({w,h}) is given, that they match the
 * view's existing original dims. Throws a Swedish Error on any mismatch; never
 * returns without a validated {w,h}.
 */
export const validateModelAssetSet = async ({ photoFile, displacementFile, maskFile } = {}, expectedViewDims) => {
  if (!photoFile) throw new Error('Fotofil saknas.');
  if (!displacementFile) throw new Error('Displacement-karta saknas.');

  const photo = await readDimsOrThrow(photoFile);
  const map = await readDimsOrThrow(displacementFile);

  if (photo.w !== map.w || photo.h !== map.h) {
    throw new Error(
      `Fotot och displacement-kartan måste ha exakt samma pixelmått ` +
      `(foto: ${photo.w}×${photo.h}, karta: ${map.w}×${map.h}). ` +
      `De måste vara registrerade mot samma bild.`
    );
  }

  if (maskFile) {
    const mask = await readDimsOrThrow(maskFile);
    if (photo.w !== mask.w || photo.h !== mask.h) {
      throw new Error(
        `Fotot och masken måste ha exakt samma pixelmått ` +
        `(foto: ${photo.w}×${photo.h}, mask: ${mask.w}×${mask.h}). ` +
        `De måste vara registrerade mot samma bild.`
      );
    }
  }

  if (expectedViewDims && expectedViewDims.w && expectedViewDims.h) {
    if (photo.w !== expectedViewDims.w || photo.h !== expectedViewDims.h) {
      throw new Error(
        `Alla färgvägar i samma vy måste ha samma pixelmått. ` +
        `Vyn är ${expectedViewDims.w}×${expectedViewDims.h}, ` +
        `den nya filen är ${photo.w}×${photo.h}.`
      );
    }
  }

  return { w: photo.w, h: photo.h };
};

/**
 * makeWebDerivative(file, maxEdge = 1600) → Promise<{ blob, type, w, h, canvas }>
 * Canvas-downscales the longest edge to maxEdge (never upscales) and re-encodes to
 * WebP q0.9 — a UNIFORM pipeline: even an already-small jpeg/png/webp is re-encoded
 * so the studio always gets a predictable contentType. Falls back to PNG when the
 * browser can't produce WebP (keeps mask alpha). Reports the ACTUAL blob type.
 */
export const makeWebDerivative = (file, maxEdge = DERIVATIVE_MAX_EDGE) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      try {
        const w = img.naturalWidth || 1;
        const h = img.naturalHeight || 1;
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, cw, ch);

        let blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.9));
        // Browser couldn't make WebP (or gave a different type) → PNG keeps alpha.
        if (!blob || blob.type !== 'image/webp') {
          blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        }
        URL.revokeObjectURL(url);
        if (!blob) {
          reject(new Error('Kunde inte skapa webb-derivat av bilden.'));
          return;
        }
        // Return the canvas too so callers can measure map quality without a
        // re-decode (displacement-contrast check reuses THIS canvas).
        resolve({ blob, type: blob.type, w: cw, h: ch, canvas });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Filen måste vara en rasterbild (JPEG/PNG/WebP).'));
    };
    img.src = url;
  });
