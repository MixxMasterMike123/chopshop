/**
 * scripts/cf-port/migrate/lib/transform-studio-assets.mjs — CP5-WH: the
 * export's design-studio documents (manifest rows 71 `settings/podMockupTemplates`
 * and 42 `pod3dModels`) turned into the bodies the Worker's platform routes
 * take (cloudflare/src/pod/studio-assets.ts parseMockupTemplateInput /
 * parseModel3dInput). Pure: no I/O.
 *
 * A file the body names is written as a placeholder `{ $source: <address> }`
 * where the Worker wants a studio-file id; the importer copies the address
 * and puts the file id in its place (`withFileIds`). `sources` lists every
 * distinct address, in a fixed order.
 *
 * What is carried and what is not:
 *   templates  id, label, garment (the document's, else the id's prefix — the
 *              rule of src/config/podMockupTemplates.js garmentOfTemplate),
 *              profileId, colourways, the print areas in px and mm, the
 *              offsets, slot labels, pocket positions, the photo per colourway
 *              (front + back), the displacement maps and their tuning, each
 *              colourway's override. Every template is active; `provisional`
 *              is the document's own flag (the studio's banner read it there);
 *              `sortOrder` keeps the document's order (index × 10). Any other
 *              key of a template is NOT carried and is counted by name
 *              (`droppedKeys`) — the old price fields among them, if any.
 *   models     id, label, active, the warp tuning, output size, the per-colour
 *              overrides, and per view (front/back) its size, print area,
 *              print size, the original size and each colourway's photo, map,
 *              mask and contrast hint. NOT carried: `originalPaths` (the raw
 *              masters in the source's storage; the studio renders the web
 *              derivatives only), `scope`, the times. A colourway without both
 *              a photo and a map is not render-ready in the studio either and
 *              is left out (counted).
 *
 * Left out, with a reason, rather than renamed: an item whose id, label or a
 * colourway's id or label matches a name family of the repository's guard
 * (`guard_family_<n>`, counted by the family's place, never by its name; the
 * same rule as scripts/cf-port/build-locales.mjs), an id outside the
 * Worker's grammar, a template whose garment cannot be told.
 */

export const TEMPLATE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const COLORWAY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GARMENT = /^[a-z][a-z0-9_-]{0,39}$/;
const MODEL_VIEWS = ['front', 'back'];
const TUNING_KEYS = ['alpha', 'blend', 'displacementBlur', 'displacementContrast', 'displacementScale'];
const TEMPLATE_KNOWN_KEYS = [
  'colorways',
  'garment',
  'id',
  'label',
  'photo',
  'pocketPositions',
  'printAreaMm',
  'printAreas',
  'printOffsetTopMm',
  'profileId',
  'slotLabels',
];
// src/config/podMockupTemplates.js GARMENT_ID_PREFIXES, in its order.
const GARMENT_ID_PREFIXES = ['longsleeve', 'sweatshirt', 'flatcap', 'hoodie', 'beanie', 'tee', 'bag', 'cap'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The guard family a text matches (`guard_family_<n>`), or null. */
export function guardFamilyOf(texts, names) {
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    const index = names.findIndex(({ re }) => new RegExp(re.source, re.flags.replace('g', '')).test(text));
    if (index !== -1) return `guard_family_${index + 1}`;
  }
  return null;
}

export function garmentOf(template) {
  const explicit = typeof template?.garment === 'string' ? template.garment.trim() : '';
  if (explicit) return explicit;
  const id = String(template?.id ?? '').trim().toLowerCase();
  return GARMENT_ID_PREFIXES.find((g) => id === g || id.startsWith(`${g}_`)) ?? null;
}

const source = (address) => (typeof address === 'string' && address.length > 0 ? { $source: address } : null);

function pickTuning(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const key of TUNING_KEYS) {
    if (value[key] !== undefined && value[key] !== null) out[key] = value[key];
  }
  return out;
}

function copySlotMap(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const [slot, entry] of Object.entries(value)) {
    // A slot outside PRINT_SLOTS is carried as is: the Worker refuses it, and
    // the refusal is the report.
    out[slot] = isPlainObject(entry) ? { ...entry } : entry;
  }
  return out;
}

function bump(counter, key) {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * The settings document → { templates: [{ id, body }], leftOut, droppedKeys }.
 */
export function transformTemplates(settingsDoc, names) {
  const data = settingsDoc?.data ?? {};
  const list = Array.isArray(data.templates) ? data.templates : [];
  const provisional = data.provisional !== false;
  const templates = [];
  const leftOut = [];
  const droppedKeys = {};
  const droppedColorways = {};

  list.forEach((template, index) => {
    const id = typeof template?.id === 'string' ? template.id : null;
    if (id === null || !TEMPLATE_ID.test(id)) {
      leftOut.push({ id: id ?? `#${index}`, kind: 'template', reason: 'bad_id' });
      return;
    }
    const family = guardFamilyOf([id, template.label, ...Object.values(template.slotLabels ?? {})], names);
    if (family !== null) {
      leftOut.push({ id: `#${index}`, kind: 'template', reason: family });
      return;
    }
    const garment = garmentOf(template);
    if (garment === null || !GARMENT.test(garment)) {
      leftOut.push({ id, kind: 'template', reason: 'no_garment' });
      return;
    }
    for (const key of Object.keys(template)) {
      if (!TEMPLATE_KNOWN_KEYS.includes(key)) bump(droppedKeys, key);
    }

    const photo = isPlainObject(template.photo) ? template.photo : null;
    const map = photo !== null && isPlainObject(photo.displacement) ? photo.displacement : null;
    const perColorway = isPlainObject(map?.perColorway) ? map.perColorway : {};
    const colorways = [];
    for (const colorway of Array.isArray(template.colorways) ? template.colorways : []) {
      const colorwayFamily = guardFamilyOf([colorway?.id, colorway?.label], names);
      if (colorwayFamily !== null) {
        bump(droppedColorways, colorwayFamily);
        continue;
      }
      const entry = { hex: colorway?.hex, id: colorway?.id, label: colorway?.label };
      if (photo !== null) {
        entry.frontFileId = source(photo.urls?.[colorway?.id]);
        entry.backFileId = source(photo.backUrls?.[colorway?.id]);
      }
      if (map !== null) {
        const tuning = pickTuning(perColorway[colorway?.id]);
        if (Object.keys(tuning).length > 0) entry.tuning = tuning;
      }
      colorways.push(entry);
    }

    const body = {
      active: true,
      colorways,
      garment,
      label: template.label,
      printAreaMm: copySlotMap(template.printAreaMm) ?? {},
      printAreas: copySlotMap(template.printAreas) ?? {},
      profileId: template.profileId,
      provisional,
      sortOrder: index * 10,
    };
    for (const key of ['printOffsetTopMm', 'slotLabels', 'pocketPositions']) {
      const value = copySlotMap(template[key]);
      if (value !== undefined && Object.keys(value).length > 0) body[key] = value;
    }
    if (photo !== null) {
      body.photo = { displacement: null, h: photo.h, w: photo.w };
      if (map !== null) {
        const displacement = {
          backFileId: source(map.urls?.back),
          frontFileId: source(map.urls?.front),
          h: map.h,
          w: map.w,
        };
        for (const key of ['scale', 'blur', 'contrast', 'blend', 'alpha']) {
          if (map[key] !== undefined && map[key] !== null) displacement[key] = map[key];
        }
        body.photo.displacement = displacement;
      }
    }
    templates.push({ body, id });
  });

  return { droppedColorways, droppedKeys, leftOut, templates };
}

/** The `pod3dModels` documents → { models: [{ id, body }], leftOut, counts }. */
export function transformModels(docs, names) {
  const models = [];
  const leftOut = [];
  const counts = { colorwaysIncomplete: 0, colorwaysLeftOut: {}, originalPathsNotCopied: 0, viewsLeftOut: 0 };

  for (const doc of docs) {
    const id = doc.id;
    const data = doc.data ?? {};
    if (typeof id !== 'string' || !MODEL_ID.test(id)) {
      leftOut.push({ id: String(id), kind: 'model', reason: 'bad_id' });
      continue;
    }
    const label = typeof data.label === 'string' && data.label.trim().length > 0 ? data.label.trim() : id;
    const family = guardFamilyOf([id, label], names);
    if (family !== null) {
      leftOut.push({ id: '(withheld)', kind: 'model', reason: family });
      continue;
    }
    const body = {
      active: data.active !== false,
      label,
      output: isPlainObject(data.output) && isNumber(data.output.w) && isNumber(data.output.h)
        ? { h: data.output.h, w: data.output.w }
        : null,
      perColorway: {},
      views: {},
      ...pickTuning(data),
    };
    if (isPlainObject(data.perColorway)) {
      for (const [colorwayId, override] of Object.entries(data.perColorway)) {
        const tuning = pickTuning(override);
        if (Object.keys(tuning).length > 0) body.perColorway[colorwayId] = tuning;
      }
    }
    for (const [viewId, view] of Object.entries(isPlainObject(data.views) ? data.views : {})) {
      if (!MODEL_VIEWS.includes(viewId) || !isPlainObject(view)) {
        counts.viewsLeftOut += 1;
        continue;
      }
      const colorways = [];
      for (const [colorwayId, colorway] of Object.entries(isPlainObject(view.colorways) ? view.colorways : {})) {
        const colorwayLabel =
          typeof colorway?.label === 'string' && colorway.label.trim().length > 0 ? colorway.label.trim() : colorwayId;
        const colorwayFamily = guardFamilyOf([colorwayId, colorwayLabel], names);
        if (colorwayFamily !== null) {
          bump(counts.colorwaysLeftOut, colorwayFamily);
          continue;
        }
        if (!colorway?.photoUrl || !colorway?.displacementUrl) {
          counts.colorwaysIncomplete += 1;
          continue;
        }
        if (isPlainObject(colorway.originalPaths)) counts.originalPathsNotCopied += 1;
        const entry = {
          displacementFileId: source(colorway.displacementUrl),
          id: colorwayId,
          label: colorwayLabel,
          maskFileId: source(colorway.maskUrl),
          photoFileId: source(colorway.photoUrl),
        };
        if (isNumber(colorway.mapContrastSd)) entry.mapContrastSd = colorway.mapContrastSd;
        colorways.push(entry);
      }
      const area = isPlainObject(view.printArea) ? view.printArea : {};
      const mm = isPlainObject(data.printAreaMm?.[viewId]) ? data.printAreaMm[viewId] : null;
      const original = isPlainObject(view.originalDims) ? view.originalDims : null;
      body.views[viewId] = {
        colorways,
        h: isNumber(view.h) ? view.h : null,
        originalDims: original !== null && isNumber(original.w) && isNumber(original.h) ? { h: original.h, w: original.w } : null,
        printArea: { h: area.h ?? 0, w: area.w ?? 0, x: area.x ?? 0, y: area.y ?? 0 },
        printAreaMm: mm !== null && isNumber(mm.w) && isNumber(mm.h) ? { h: mm.h, w: mm.w } : null,
        w: isNumber(view.w) ? view.w : null,
      };
    }
    models.push({ body, id });
  }
  return { counts, leftOut, models };
}

/** Every `$source` address in a body, depth first. */
export function sourcesOf(body) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (isPlainObject(value)) {
      if (typeof value.$source === 'string' && Object.keys(value).length === 1) {
        found.push(value.$source);
        return;
      }
      Object.values(value).forEach(walk);
    }
  };
  walk(body);
  return found;
}

/**
 * The body with every placeholder replaced by the file id `fileIdOf(address)`
 * answers; null when any address has none (the item cannot be written whole).
 */
export function withFileIds(body, fileIdOf) {
  let complete = true;
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isPlainObject(value)) return value;
    if (typeof value.$source === 'string' && Object.keys(value).length === 1) {
      const fileId = fileIdOf(value.$source);
      if (typeof fileId !== 'string') complete = false;
      return fileId ?? null;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
  };
  const out = walk(body);
  return complete ? out : null;
}
