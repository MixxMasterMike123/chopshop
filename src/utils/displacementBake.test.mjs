// The pure half of the photo → displacement-map bake:
//   node --test src/utils/displacementBake.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BAKE_DEFAULTS, bakeDisplacementPixels, gaussianKernel, regionStats } from './displacementBake.js';

const rgba = (w, h, fill) => {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
  return out;
};

// The bake's contract is stated for the CENTRE 60 % (the print region), so the
// tests measure there, with the module's own regionStats.
const stats = (out, w, h) => {
  const plane = new Float32Array(w * h);
  for (let p = 0; p < plane.length; p += 1) plane[p] = out[p * 4];
  return regionStats(plane, w, h, 0.6);
};

describe('gaussianKernel', () => {
  it('is normalised and symmetric, radius 3σ', () => {
    const k = gaussianKernel(3);
    assert.equal(k.length, 19);
    assert.ok(Math.abs(k.reduce((a, b) => a + b, 0) - 1) < 1e-6);
    assert.ok(Math.abs(k[0] - k[18]) < 1e-9);
    assert.ok(k[9] > k[8]);
  });
  it('σ 0 is the identity', () => {
    assert.deepEqual(Array.from(gaussianKernel(0)), [1]);
  });
});

describe('bakeDisplacementPixels', () => {
  it('keeps the pixel count, writes opaque grey', () => {
    const w = 20;
    const h = 10;
    const out = bakeDisplacementPixels(rgba(w, h, (x) => [x * 10, x * 10, x * 10]), w, h);
    assert.equal(out.length, w * h * 4);
    for (let i = 0; i < out.length; i += 4) {
      assert.equal(out[i], out[i + 1]);
      assert.equal(out[i + 1], out[i + 2]);
      assert.equal(out[i + 3], 255);
    }
  });

  it('a flat photo becomes flat mid-grey (nothing amplified out of nothing)', () => {
    const out = bakeDisplacementPixels(rgba(16, 16, () => [90, 90, 90]), 16, 16);
    const { mean, sd } = stats(out, 16, 16);
    assert.equal(mean, BAKE_DEFAULTS.targetMean);
    assert.equal(sd, 0);
  });

  it('a weak gradient is stretched to the target sd around the target mean', () => {
    const w = 120;
    const h = 60;
    // luminance 100..130: sd far below the target, the kind of flat hoodie photo the doc describes
    const out = bakeDisplacementPixels(rgba(w, h, (x) => [100 + (x % 30), 100 + (x % 30), 100 + (x % 30)]), w, h, { sigma: 0 });
    const { mean, sd } = stats(out, w, h);
    assert.ok(Math.abs(mean - BAKE_DEFAULTS.targetMean) < 1, `mean ${mean}`);
    assert.ok(Math.abs(sd - BAKE_DEFAULTS.targetSd) < 1, `sd ${sd}`);
  });

  it('a strong gradient is compressed to the same target sd, clamped to 0..255', () => {
    const w = 64;
    const h = 8;
    const out = bakeDisplacementPixels(rgba(w, h, (x) => [x * 4, x * 4, x * 4]), w, h, { sigma: 0 });
    const { sd } = stats(out, w, h);
    assert.ok(Math.abs(sd - BAKE_DEFAULTS.targetSd) < 1, `sd ${sd}`);
    for (let i = 0; i < out.length; i += 4) assert.ok(out[i] >= 0 && out[i] <= 255);
  });

  it('blur smooths a hard edge instead of keeping a step', () => {
    const w = 40;
    const h = 4;
    const step = (x) => (x < 20 ? [0, 0, 0] : [255, 255, 255]);
    const sharp = bakeDisplacementPixels(rgba(w, h, step), w, h, { sigma: 0 });
    const soft = bakeDisplacementPixels(rgba(w, h, step), w, h, { sigma: 3 });
    const at = (out, x) => out[(1 * w + x) * 4];
    // Sharp: the two pixels around the edge differ by the whole stretched range.
    assert.ok(Math.abs(at(sharp, 19) - at(sharp, 20)) > 60);
    // Soft: the step is spread over the kernel, each neighbour pair is close.
    assert.ok(Math.abs(at(soft, 19) - at(soft, 20)) < 25);
    // Luminance uses the colour channels, not just red.
    const colour = bakeDisplacementPixels(rgba(w, h, (x) => (x < 20 ? [0, 0, 0] : [0, 255, 0])), w, h, { sigma: 0 });
    assert.ok(at(colour, 30) > at(colour, 10));
  });

  it('a dark garment on a white background keeps its folds (statistics from the centre, not the silhouette)', () => {
    // Codex 2026-10-22: 400×400 white frame, a central 240×240 garment at luminance 30 ± 5.
    const w = 400;
    const h = 400;
    const inGarment = (x, y) => x >= 80 && x < 320 && y >= 80 && y < 320;
    const fold = (x, y) => 30 + 5 * Math.sin((x + y) / 7);
    const out = bakeDisplacementPixels(
      rgba(w, h, (x, y) => (inGarment(x, y) ? [fold(x, y), fold(x, y), fold(x, y)] : [255, 255, 255])),
      w,
      h,
      { sigma: 0 },
    );
    const centre = stats(out, w, h);
    assert.ok(Math.abs(centre.sd - BAKE_DEFAULTS.targetSd) < 2, `print-region sd ${centre.sd}`);
    assert.ok(Math.abs(centre.mean - BAKE_DEFAULTS.targetMean) < 2, `print-region mean ${centre.mean}`);
    // The background clips to white; it is outside the print and masked anyway.
    assert.equal(out[(10 * w + 10) * 4], 255);
  });

  it('regionStats reads the centred box only', () => {
    const w = 10;
    const h = 10;
    const plane = new Float32Array(w * h).fill(200);
    for (let y = 2; y < 8; y += 1) for (let x = 2; x < 8; x += 1) plane[y * w + x] = 50;
    const r = regionStats(plane, w, h, 0.6);
    assert.equal(r.mean, 50);
    assert.equal(r.sd, 0);
  });

  it('refuses a buffer that does not match the size', () => {
    assert.throws(() => bakeDisplacementPixels(new Uint8ClampedArray(10), 4, 4), /does not match/);
  });
});
