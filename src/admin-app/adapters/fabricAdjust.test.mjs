// The studio's fabric fine-tuning, pure: node --test src/admin-app/adapters/fabricAdjust.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasFabricAdjust,
  hasFabricMap,
  setFabricKnob,
  withFabricAdjust,
} from '../../wagons/pod-wagon/studio/fabricAdjust.js';

// The tuning a render reads, as TemplateBackground.jsx displacementTuningFor
// resolves it (kept beside the test: that file is JSX and cannot be imported
// here; the two must agree, and the build's studio would show it if not).
const tuningFor = (displacement, colorwayId) => {
  const per = displacement.perColorway?.[colorwayId] || {};
  return {
    displacementScale: per.displacementScale ?? displacement.scale ?? 30,
    displacementContrast: per.displacementContrast ?? displacement.contrast ?? 1,
    blend: per.blend ?? displacement.blend ?? 'normal',
    alpha: per.alpha ?? displacement.alpha ?? 1,
  };
};

const template = () => ({
  id: 'tee_bc_e150',
  photo: {
    w: 960,
    h: 1093,
    urls: { white: '/w.webp', black: '/b.webp' },
    displacement: {
      urls: { front: '/front_dm.webp', back: '/back_dm.webp' },
      scale: 30, blur: 6, contrast: 2, blend: 'multiply', alpha: 0.8,
      perColorway: { black: { blend: 'normal' }, navy: { blend: 'normal', displacementScale: 12 } },
    },
  },
});

describe('withFabricAdjust', () => {
  it('returns the same template when nothing is adjusted or there is no map', () => {
    const t = template();
    assert.equal(withFabricAdjust(t, null), t);
    assert.equal(withFabricAdjust(t, { base: {}, perColorway: {} }), t);
    assert.equal(withFabricAdjust(t, { base: {}, perColorway: { white: {} } }), t);
    const flat = { id: 'bag_flat' };
    assert.equal(withFabricAdjust(flat, { base: { displacementScale: 50 }, perColorway: {} }), flat);
    assert.equal(hasFabricMap(t), true);
    assert.equal(hasFabricMap(flat), false);
    assert.equal(hasFabricMap({ photo: { displacement: { urls: {} } } }), false);
  });

  it('a map knob applies to every colour, a seeded per-colour value included', () => {
    const t = template();
    const out = withFabricAdjust(t, { base: { displacementScale: 55, displacementContrast: 3.2 }, perColorway: {} });
    for (const id of ['white', 'black', 'navy']) {
      const tuning = tuningFor(out.photo.displacement, id);
      assert.equal(tuning.displacementScale, 55, id);
      assert.equal(tuning.displacementContrast, 3.2, id);
    }
    // The colours' own blend is untouched.
    assert.equal(tuningFor(out.photo.displacement, 'white').blend, 'multiply');
    assert.equal(tuningFor(out.photo.displacement, 'black').blend, 'normal');
    // Nothing of the given template was changed.
    assert.deepEqual(t, template());
  });

  it('blend and opacity apply to the one colour they were set on', () => {
    const out = withFabricAdjust(template(), { base: {}, perColorway: { black: { blend: 'screen', alpha: 0.6 } } });
    assert.deepEqual(tuningFor(out.photo.displacement, 'black'), {
      displacementScale: 30, displacementContrast: 2, blend: 'screen', alpha: 0.6,
    });
    assert.deepEqual(tuningFor(out.photo.displacement, 'white'), {
      displacementScale: 30, displacementContrast: 2, blend: 'multiply', alpha: 0.8,
    });
    // A seeded per-colour scale stays while the map knob is untouched.
    assert.equal(tuningFor(out.photo.displacement, 'navy').displacementScale, 12);
  });

  it('keeps everything else of the template and its map as it was', () => {
    const t = template();
    const out = withFabricAdjust(t, { base: { displacementScale: 40 }, perColorway: {} });
    assert.equal(out.id, t.id);
    assert.deepEqual(out.photo.urls, t.photo.urls);
    assert.deepEqual(out.photo.displacement.urls, t.photo.displacement.urls);
    assert.equal(out.photo.displacement.blur, 6);
    assert.equal(out.photo.displacement.contrast, 2);
  });
});

describe('setFabricKnob', () => {
  it('files a map knob under base and a colour knob under the colour on screen', () => {
    let adjust = setFabricKnob(null, 'white', 'displacementScale', 44);
    adjust = setFabricKnob(adjust, 'white', 'alpha', 0.5);
    adjust = setFabricKnob(adjust, 'black', 'blend', 'screen');
    adjust = setFabricKnob(adjust, 'black', 'displacementContrast', 1.5);
    assert.deepEqual(adjust, {
      base: { displacementScale: 44, displacementContrast: 1.5 },
      perColorway: { white: { alpha: 0.5 }, black: { blend: 'screen' } },
    });
    assert.equal(hasFabricAdjust(adjust), true);
  });

  it('does not change the adjustment it was given, and ignores an unknown knob', () => {
    const before = { base: { displacementScale: 44 }, perColorway: { white: { alpha: 0.5 } } };
    const copy = structuredClone(before);
    const after = setFabricKnob(before, 'white', 'alpha', 0.9);
    assert.deepEqual(before, copy);
    assert.equal(after.perColorway.white.alpha, 0.9);
    assert.equal(setFabricKnob(before, 'white', 'displacementBlur', 9), before);
    assert.equal(setFabricKnob(null, 'white', 'nope', 1), null);
    assert.equal(setFabricKnob(before, null, 'blend', 'add'), before);
    assert.equal(hasFabricAdjust(null), false);
  });
});
