// fabricAdjust.js — the seller's fine-tuning of how the print sits in the
// fabric on an ORDINARY garment photo (a photo template with a registered
// fabric map), the same knobs the 3D view's "Avancerat" has.
//
// Session-local and appearance only: it changes the live preview and the
// generated product images, never the print (size and placement are the
// canvas's) and never the stored template (that calibration is the platform's).
//
// The knobs follow the template's own model (TemplateBackground.jsx
// displacementTuningFor):
//   • displacementScale, displacementContrast — properties of the fabric MAP,
//     one map per side shared by every colour, so an adjustment applies to the
//     whole template;
//   • blend, alpha — depend on the garment's COLOUR (multiply inks into light
//     fabric and erases the print on dark), so an adjustment applies to the one
//     colourway it was made on.
//
// Shape: null (untouched) or
//   { base: { displacementScale?, displacementContrast? },
//     perColorway: { [colorwayId]: { blend?, alpha? } } }

/** The sliders' ranges: the 3D view's (Studio3DSection.jsx). */
export const FABRIC_KNOBS = Object.freeze({
  displacementScale: Object.freeze({ min: 0, max: 100, step: 1 }),
  displacementContrast: Object.freeze({ min: 0.5, max: 4, step: 0.1 }),
  alpha: Object.freeze({ min: 0, max: 1, step: 0.05 }),
});

export const FABRIC_BLENDS = Object.freeze(['multiply', 'screen', 'overlay', 'normal', 'add']);

const BASE_KNOBS = ['displacementScale', 'displacementContrast'];
const COLORWAY_KNOBS = ['blend', 'alpha'];

/** Does the template have a fabric map to tune at all? */
export const hasFabricMap = (template) => {
  const urls = template?.photo?.displacement?.urls;
  return Boolean(urls && (urls.front || urls.back));
};

/** True when anything has been adjusted. */
export const hasFabricAdjust = (adjust) =>
  Boolean(adjust) && (
    Object.keys(adjust.base || {}).length > 0 ||
    Object.values(adjust.perColorway || {}).some((knobs) => Object.keys(knobs || {}).length > 0)
  );

/** One knob changed while `colorwayId` is on screen → the next adjustment. */
export const setFabricKnob = (adjust, colorwayId, key, value) => {
  const base = { ...(adjust?.base || {}) };
  const perColorway = { ...(adjust?.perColorway || {}) };
  if (BASE_KNOBS.includes(key)) {
    base[key] = value;
  } else if (COLORWAY_KNOBS.includes(key) && colorwayId) {
    perColorway[colorwayId] = { ...(perColorway[colorwayId] || {}), [key]: value };
  } else {
    return adjust ?? null;
  }
  return { base, perColorway };
};

/**
 * The template as the preview and the mockup renderer read it, with the
 * adjustment laid over its `photo.displacement`. The SAME object is returned
 * when there is nothing to lay over (no map, or nothing adjusted), so memoised
 * readers do not re-run.
 */
export const withFabricAdjust = (template, adjust) => {
  const displacement = template?.photo?.displacement;
  if (!displacement || !hasFabricAdjust(adjust)) return template;
  const base = adjust.base || {};
  const perColorway = {};
  for (const [id, knobs] of Object.entries(displacement.perColorway || {})) {
    const kept = { ...knobs };
    // A map knob the seller moved applies to every colour: a colourway's own
    // seeded value must not outvote it.
    for (const key of BASE_KNOBS) if (base[key] !== undefined) delete kept[key];
    perColorway[id] = kept;
  }
  for (const [id, knobs] of Object.entries(adjust.perColorway || {})) {
    perColorway[id] = { ...(perColorway[id] || {}), ...knobs };
  }
  return {
    ...template,
    photo: {
      ...template.photo,
      displacement: {
        ...displacement,
        ...(base.displacementScale !== undefined ? { scale: base.displacementScale } : {}),
        ...(base.displacementContrast !== undefined ? { contrast: base.displacementContrast } : {}),
        perColorway,
      },
    },
  };
};
