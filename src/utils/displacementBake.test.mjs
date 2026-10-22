// The pure half of the photo → displacement-map bake:
//   node --test src/utils/displacementBake.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BAKE_DEFAULTS, bakeDisplacementPixels, gaussianKernel } from './displacementBake.js';

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

const stats = (out) => {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < out.length; i += 4) {
    sum += out[i];
    sumSq += out[i] * out[i];
    n += 1;
  }
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
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
    const { mean, sd } = stats(out);
    assert.equal(mean, BAKE_DEFAULTS.targetMean);
    assert.equal(sd, 0);
  });

  it('a weak gradient is stretched to the target sd around the target mean', () => {
    const w = 120;
    const h = 60;
    // luminance 100..130: sd far below the target, the kind of flat hoodie photo the doc describes
    const out = bakeDisplacementPixels(rgba(w, h, (x) => [100 + (x % 30), 100 + (x % 30), 100 + (x % 30)]), w, h, { sigma: 0 });
    const { mean, sd } = stats(out);
    assert.ok(Math.abs(mean - BAKE_DEFAULTS.targetMean) < 1, `mean ${mean}`);
    assert.ok(Math.abs(sd - BAKE_DEFAULTS.targetSd) < 1, `sd ${sd}`);
  });

  it('a strong gradient is compressed to the same target sd, clamped to 0..255', () => {
    const w = 64;
    const h = 8;
    const out = bakeDisplacementPixels(rgba(w, h, (x) => [x * 4, x * 4, x * 4]), w, h, { sigma: 0 });
    const { sd } = stats(out);
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

  it('refuses a buffer that does not match the size', () => {
    assert.throws(() => bakeDisplacementPixels(new Uint8ClampedArray(10), 4, 4), /does not match/);
  });
});
