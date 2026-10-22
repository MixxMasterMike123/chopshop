// displacementBake.js — a displacement map DERIVED FROM THE GARMENT PHOTO, in the
// browser, so a platform operator never has to author one by hand.
//
// The recipe is the one docs/POD_MOCKUP_TEMPLATES.md prescribes for a flat map
// (grayscale → gaussian blur σ3 → mean-centred stretch to sd≈40, runtime
// contrast 1): the photo's own shading IS the fold information the 2.5D studio
// warps artwork with (DisplacementFilter shifts by (luminance − 0.5) × scale),
// so a blurred, contrast-normalised luminance of the photo is a usable map. A
// hand-authored map still wins when the operator uploads one — this is the
// default, not a replacement.
//
// The map is produced at the photo's ORIGINAL pixel size: pod3dUpload's
// registration gate requires photo and map to share dims exactly, and the web
// derivatives are downscaled from both with the same deterministic math.
//
// `bakeDisplacementPixels` is pure (typed arrays in, typed array out) and tested
// under Node; `deriveDisplacementMapFile` is the browser wrapper around it.

export const BAKE_DEFAULTS = Object.freeze({
  sigma: 3, // gaussian blur, in pixels of the ORIGINAL photo
  targetSd: 40, // the doc's "sd≈40" for a baked map (contrast 1 at runtime)
  targetMean: 128, // mid-grey = no displacement
});

/** Rec.601 luminance of one RGBA pixel, 0..255. */
const luminance = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

/** A normalised 1-D gaussian kernel, radius ceil(3σ). σ ≤ 0 → identity. */
export const gaussianKernel = (sigma) => {
  if (!(sigma > 0)) return Float32Array.of(1);
  const radius = Math.ceil(3 * sigma);
  const kernel = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k += 1) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = v;
    sum += v;
  }
  for (let k = 0; k < kernel.length; k += 1) kernel[k] /= sum;
  return kernel;
};

/**
 * One separable blur pass along x (then the caller transposes the roles for y).
 * Edges clamp to the nearest pixel, so the border keeps the garment's own tone
 * instead of darkening towards zero.
 */
const blurAxis = (src, dst, w, h, kernel, alongX) => {
  const radius = (kernel.length - 1) / 2;
  const outer = alongX ? h : w;
  const inner = alongX ? w : h;
  for (let o = 0; o < outer; o += 1) {
    for (let i = 0; i < inner; i += 1) {
      let acc = 0;
      for (let k = -radius; k <= radius; k += 1) {
        let j = i + k;
        if (j < 0) j = 0;
        else if (j >= inner) j = inner - 1;
        const idx = alongX ? o * w + j : j * w + o;
        acc += src[idx] * kernel[k + radius];
      }
      dst[alongX ? o * w + i : i * w + o] = acc;
    }
  }
};

/** Mean and standard deviation of a plane over its centred `fraction` box. */
export const regionStats = (plane, w, h, fraction) => {
  const rw = Math.max(1, Math.floor(w * fraction));
  const rh = Math.max(1, Math.floor(h * fraction));
  const x0 = Math.floor((w - rw) / 2);
  const y0 = Math.floor((h - rh) / 2);
  let n = 0;
  let sum = 0;
  for (let y = y0; y < y0 + rh; y += 1) {
    for (let x = x0; x < x0 + rw; x += 1) {
      sum += plane[y * w + x];
      n += 1;
    }
  }
  const mean = sum / n;
  let sumSq = 0;
  for (let y = y0; y < y0 + rh; y += 1) {
    for (let x = x0; x < x0 + rw; x += 1) {
      const d = plane[y * w + x] - mean;
      sumSq += d * d;
    }
  }
  return { mean, sd: Math.sqrt(sumSq / n) };
};

/**
 * bakeDisplacementPixels(rgba, w, h, opts?) → Uint8ClampedArray (RGBA, opaque grey)
 *
 * luminance → gaussian blur σ → mean-centred stretch so the CENTRE region's
 * standard deviation is `targetSd` around `targetMean`, clamped to 0..255. A flat input
 * (sd 0) stays flat at `targetMean`: nothing is amplified out of noise.
 */
export const bakeDisplacementPixels = (rgba, w, h, opts = {}) => {
  const { sigma, targetSd, targetMean } = { ...BAKE_DEFAULTS, ...opts };
  if (!(w > 0 && h > 0) || rgba.length < w * h * 4) {
    throw new Error('bakeDisplacementPixels: pixel buffer does not match the given size');
  }
  const n = w * h;
  const lum = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) lum[p] = luminance(rgba, i);

  const kernel = gaussianKernel(sigma);
  let blurred = lum;
  if (kernel.length > 1) {
    const tmp = new Float32Array(n);
    blurred = new Float32Array(n);
    blurAxis(lum, tmp, w, h, kernel, true);
    blurAxis(tmp, blurred, w, h, kernel, false);
  }

  // The statistics come from the CENTRE 60 % of the frame (the same region
  // pod3dUpload's measureMapContrastSd samples: where the print lands), never
  // the whole photo. On a dark garment against a light background the
  // whole-frame deviation is the garment's silhouette, and a stretch fitted to
  // it leaves the folds under the artwork nearly flat (Codex, 2026-10-22). The
  // transform is then applied to every pixel; the background may clip, which
  // is fine: it is outside the print and the mask hides it anyway.
  const { mean, sd } = regionStats(blurred, w, h, 0.6);
  const gain = sd > 1e-6 ? targetSd / sd : 0;

  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const v = targetMean + (blurred[p] - mean) * gain; // Uint8Clamped rounds + clamps
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
};

/**
 * deriveDisplacementMapFile(photoFile, opts?) → Promise<File>
 * Browser-only. Decodes the photo at its original size, bakes the map and
 * returns it as an opaque PNG File of exactly the photo's pixel dims (PNG, so
 * no lossy re-encode blurs the map twice). Throws a Swedish Error for a file
 * the browser cannot decode as a raster.
 */
export const deriveDisplacementMapFile = (photoFile, opts = {}) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(photoFile);
    const fail = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.onload = async () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) throw new Error('Filen måste vara en rasterbild (JPEG/PNG/WebP).');
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const src = ctx.getImageData(0, 0, w, h);
        const baked = bakeDisplacementPixels(src.data, w, h, opts);
        ctx.putImageData(new ImageData(baked, w, h), 0, 0);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        URL.revokeObjectURL(url);
        if (!blob) {
          reject(new Error('Kunde inte skapa displacement-kartan från fotot.'));
          return;
        }
        const base = String(photoFile.name || 'foto').replace(/\.[^.]+$/, '');
        resolve(new File([blob], `${base}-displacement.png`, { type: 'image/png' }));
      } catch (err) {
        fail(err);
      }
    };
    img.onerror = () => fail(new Error('Filen måste vara en rasterbild (JPEG/PNG/WebP).'));
    img.src = url;
  });
