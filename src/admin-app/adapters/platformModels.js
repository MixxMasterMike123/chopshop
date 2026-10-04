// The platform's 3D models between the Worker's shape and the page's (CP5 unit
// FO). Pure: no request, no DOM; tested under Node (platformModels.test.mjs).
//
// The Worker (cloudflare/src/pod/studio-assets.ts, CP5_WH_REPORT.md):
//   PlatformModel = { modelId, label, active, displacementScale?, displacementBlur?,
//     displacementContrast?, blend?, alpha?, output: {w,h}|null, perColorway: {id: tuning},
//     views: { front?|back?: { w|null, h|null, printArea: {x,y,w,h}, printAreaMm: {w,h}|null,
//       originalDims: {w,h}|null, colorways: [{ id, label, photoFileId, displacementFileId,
//       maskFileId|null, mapContrastSd? }] } }, createdAt, updatedAt }
//   and the platform list's `files` = { fileId: { url, width, height, … } }.
// The page (PlatformModels.jsx, ModelCardGrid.jsx, ModelEditor.jsx) reads the
// older pod3dModels document: colourways a MAP by id, each with photoUrl /
// displacementUrl / maskUrl, and printAreaMm at the top, by view. A page
// colourway also carries `fileIds` ({ photo, displacement, mask }), which no
// markup reads: the whole document is rebuilt from them for every PUT.
//
// The editor writes Firestore-style dot-path patches ({ 'views.front.w': 1600,
// 'perColorway.vit': deleteField(), updatedAt: serverTimestamp() }). The Worker
// has a whole-document PUT only, so a write is: the model as the server last
// answered it (pageModelOf) + the patch (applyModelPatch) → the PUT body
// (modelBodyOf), whose answer replaces what the page holds.

export const DELETE_FIELD = Symbol('platformModels.deleteField');
export const SERVER_TIME = Symbol('platformModels.serverTime');

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLORWAY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The Worker's bounds (studio-assets.ts, studio-files.ts).
export const STUDIO_FILE_MAX_BYTES = 15 * 1024 * 1024;
export const MAX_COLORWAYS = 40;
const MAX_PER_COLORWAY = 100;
const LABEL_MAX = 80;
const PX_MAX = 20_000;
const MM_MAX = 2_000;
const ORIGINAL_PX_MAX = 100_000;
const VIEWS = ['front', 'back'];
const BLENDS = ['add', 'multiply', 'normal', 'overlay', 'screen'];
const TUNING = {
  alpha: [0, 1],
  displacementScale: [0, 1000],
  displacementBlur: [0, 100],
  displacementContrast: [0, 20],
};
const TUNING_KEYS = ['alpha', 'blend', 'displacementBlur', 'displacementContrast', 'displacementScale'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const copy = (v) => (v === undefined ? undefined : structuredClone(v));
const sizeOf = (v) => (isObject(v) ? { w: v.w, h: v.h } : null);

// ── ids ─────────────────────────────────────────────────────────────────────

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A new model id, made here: the Worker's PUT creates the model under the id
 * it is given (Firebase's addDoc minted one). 20 characters of [A-Za-z0-9],
 * as Firestore's own ids, so imported and new ids look alike. `random(n)` →
 * n random bytes (Web Crypto by default); a byte ≥ 248 is skipped, so every
 * character is equally likely.
 */
export function newModelId(random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  let id = '';
  while (id.length < 20) {
    for (const byte of random(32)) {
      if (byte < 248 && id.length < 20) id += ID_ALPHABET[byte % 62];
    }
  }
  return id;
}

// ── the Worker's shape → the page's ─────────────────────────────────────────

/**
 * PlatformModel + the list's `files` (a Map or an object by file id) → the
 * page's model. A file the map does not hold (or one without an address)
 * leaves its URL out, as the seller shape does.
 */
export function pageModelOf(model, files = {}) {
  const fileOf = (id) => (files instanceof Map ? files.get(id) : files?.[id]);
  const urlOf = (id) => {
    const url = id ? fileOf(id)?.url : null;
    return typeof url === 'string' && url !== '' ? url : null;
  };
  const page = {
    id: model.modelId,
    label: model.label,
    active: model.active !== false,
    views: {},
    printAreaMm: {},
    perColorway: copy(model.perColorway ?? {}),
    output: sizeOf(model.output),
  };
  for (const key of TUNING_KEYS) if (model[key] !== undefined && model[key] !== null) page[key] = model[key];
  for (const viewId of VIEWS) {
    const view = model.views?.[viewId];
    if (!isObject(view)) continue;
    const colorways = {};
    for (const cw of Array.isArray(view.colorways) ? view.colorways : []) {
      const entry = {
        label: cw.label,
        fileIds: { photo: cw.photoFileId, displacement: cw.displacementFileId, mask: cw.maskFileId ?? null },
      };
      const photo = urlOf(cw.photoFileId);
      const map = urlOf(cw.displacementFileId);
      const mask = urlOf(cw.maskFileId);
      if (photo) entry.photoUrl = photo;
      if (map) entry.displacementUrl = map;
      if (mask) entry.maskUrl = mask;
      if (typeof cw.mapContrastSd === 'number') entry.mapContrastSd = cw.mapContrastSd;
      colorways[cw.id] = entry;
    }
    page.views[viewId] = {
      w: view.w ?? null,
      h: view.h ?? null,
      printArea: { ...view.printArea },
      originalDims: sizeOf(view.originalDims),
      colorways,
    };
    if (isObject(view.printAreaMm)) page.printAreaMm[viewId] = sizeOf(view.printAreaMm);
  }
  if (model.createdAt) page.createdAt = model.createdAt;
  if (model.updatedAt) page.updatedAt = model.updatedAt;
  return page;
}

// ── the editor's patch ──────────────────────────────────────────────────────

/**
 * The page's model with one of the editor's dot-path patches applied (a new
 * object; `page` is not changed). DELETE_FIELD removes the key; SERVER_TIME is
 * dropped (the Worker stamps its own times). A path that names an unsafe key
 * throws: it can only come from a bug.
 */
export function applyModelPatch(page, patch) {
  const next = structuredClone(page);
  for (const [path, value] of Object.entries(patch ?? {})) {
    if (value === SERVER_TIME) continue;
    const keys = path.split('.');
    if (keys.some((key) => key === '' || UNSAFE_KEYS.has(key))) throw new Error(`Ogiltig sökväg i ändringen: ${path}`);
    let target = next;
    for (const key of keys.slice(0, -1)) {
      if (!isObject(target[key])) target[key] = {};
      target = target[key];
    }
    const last = keys[keys.length - 1];
    if (value === DELETE_FIELD) delete target[last];
    else target[last] = copy(value);
  }
  return next;
}

// ── the page's shape → the PUT body ─────────────────────────────────────────

function tuningOf(source, problems, where) {
  const out = {};
  for (const key of TUNING_KEYS) {
    const value = source?.[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'blend') {
      if (BLENDS.includes(value)) out.blend = value;
      else problems.push(`${where}: blend-läget ”${value}” finns inte.`);
    } else if (isNum(value, ...TUNING[key])) {
      out[key] = value;
    } else {
      const [min, max] = TUNING[key];
      problems.push(`${where}: ${TUNING_WORDS[key]} måste vara mellan ${min} och ${max}.`);
    }
  }
  return out;
}

const TUNING_WORDS = {
  alpha: 'opaciteten',
  displacementScale: 'displacement',
  displacementBlur: 'oskärpan på kartan',
  displacementContrast: 'kartkontrasten',
};

function isLabel(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= LABEL_MAX && value === value.trim();
}

function viewBodyOf(viewId, view, mm, problems) {
  const where = viewId === 'front' ? 'Framsidan' : 'Baksidan';
  const w = view.w ?? null;
  const h = view.h ?? null;
  if ((w === null) !== (h === null) || (w !== null && (!isInt(w, 1, PX_MAX) || !isInt(h, 1, PX_MAX)))) {
    problems.push(`${where}: fotots pixelmått är ogiltiga.`);
  }
  const pa = view.printArea ?? { x: 0, y: 0, w: 0, h: 0 };
  const printArea = { x: pa.x, y: pa.y, w: pa.w, h: pa.h };
  if (!['x', 'y', 'w', 'h'].every((k) => isInt(printArea[k], 0, PX_MAX))) {
    problems.push(`Tryckytans rektangel måste vara hela pixlar mellan 0 och ${PX_MAX.toLocaleString('sv')}.`);
  }
  const printAreaMm = sizeOf(mm);
  if (printAreaMm && !(isInt(printAreaMm.w, 0, MM_MAX) && isInt(printAreaMm.h, 0, MM_MAX))) {
    problems.push(`Tryckytans storlek får vara högst ${MM_MAX / 10} × ${MM_MAX / 10} cm.`);
  }
  const originalDims = sizeOf(view.originalDims);
  if (originalDims && !(isInt(originalDims.w, 1, ORIGINAL_PX_MAX) && isInt(originalDims.h, 1, ORIGINAL_PX_MAX))) {
    problems.push(`${where}: originalets pixelmått är ogiltiga.`);
  }
  const entries = Object.entries(isObject(view.colorways) ? view.colorways : {});
  if (entries.length > MAX_COLORWAYS) problems.push(`En vy kan ha högst ${MAX_COLORWAYS} färgvägar.`);
  const colorways = entries.map(([id, cw]) => {
    const name = cw?.label || id;
    if (!COLORWAY_ID_PATTERN.test(id)) {
      problems.push(`Färgvägens id ”${id}” går inte att spara (högst 64 tecken: a–z, 0–9, - och _).`);
    }
    if (!isLabel(cw?.label)) problems.push(`Färgvägens namn ”${name}” måste vara 1–${LABEL_MAX} tecken.`);
    const ids = cw?.fileIds ?? {};
    if (!FILE_ID_PATTERN.test(ids.photo ?? '') || !FILE_ID_PATTERN.test(ids.displacement ?? '')
      || (ids.mask != null && !FILE_ID_PATTERN.test(ids.mask))) {
      problems.push(`Färgvägen ”${name}” saknar sina bilder på servern. Ta bort den och ladda upp den igen.`);
    }
    const body = {
      id,
      label: cw?.label,
      photoFileId: ids.photo,
      displacementFileId: ids.displacement,
      maskFileId: ids.mask ?? null,
    };
    // A measure, not a setting: kept when it is one the Worker takes.
    if (isNum(cw?.mapContrastSd, 0, 256)) body.mapContrastSd = cw.mapContrastSd;
    return body;
  });
  return { w, h, printArea, printAreaMm, originalDims, colorways };
}

/**
 * The page's model → { body, problems }: the PUT body of
 * /v1/platform/pod/3d-models/:modelId (the whole document), and every value
 * the Worker would refuse, each a Swedish sentence. A caller sends nothing
 * while `problems` is not empty.
 */
export function modelBodyOf(page) {
  const problems = [];
  const label = typeof page?.label === 'string' ? page.label.trim() : '';
  if (!isLabel(label)) problems.push(`Namnet måste vara 1–${LABEL_MAX} tecken.`);
  const body = {
    label,
    active: page?.active !== false,
    ...tuningOf(page, problems, 'Standardinställningar'),
    output: null,
    perColorway: {},
    views: {},
  };
  if (page?.output != null) {
    const output = sizeOf(page.output);
    if (output && isInt(output.w, 1, PX_MAX) && isInt(output.h, 1, PX_MAX)) body.output = output;
    else problems.push(`Utdata måste vara hela pixlar mellan 1 och ${PX_MAX.toLocaleString('sv')}, eller tomt.`);
  }
  const overrides = Object.entries(isObject(page?.perColorway) ? page.perColorway : {});
  if (overrides.length > MAX_PER_COLORWAY) problems.push(`Högst ${MAX_PER_COLORWAY} färgvägar kan ha egna inställningar.`);
  for (const [id, override] of overrides) {
    if (!COLORWAY_ID_PATTERN.test(id)) {
      problems.push(`Färgvägens id ”${id}” går inte att spara (högst 64 tecken: a–z, 0–9, - och _).`);
      continue;
    }
    const tuning = tuningOf(override, problems, `Färgvägen ”${id}”`);
    if (Object.keys(tuning).length > 0) body.perColorway[id] = tuning;
  }
  for (const viewId of VIEWS) {
    const view = page?.views?.[viewId];
    if (isObject(view)) body.views[viewId] = viewBodyOf(viewId, view, page.printAreaMm?.[viewId], problems);
  }
  if (Object.keys(body.views).length === 0) problems.push('Modellen saknar vy.');
  return { body, problems: [...new Set(problems)] };
}

/**
 * The body of a new, uncalibrated model (the older page's defaults: a front
 * view without a photo and with a zero print rect, 30 × 40 cm, the tuning
 * defaults) → { body, problems }.
 */
export function newModelBody(label) {
  return modelBodyOf({
    label: typeof label === 'string' ? label.trim() : '',
    active: true,
    views: { front: { w: null, h: null, printArea: { x: 0, y: 0, w: 0, h: 0 }, colorways: {} } },
    printAreaMm: { front: { w: 300, h: 400 } },
    displacementScale: 30,
    displacementBlur: 6,
    blend: 'multiply',
    alpha: 0.8,
    perColorway: {},
    output: null,
  });
}

// ── is it stored? (a lost answer is read back) ──────────────────────────────

/** A PUT body or a PlatformModel in the one form the Worker stores (defaults filled, empties dropped). */
export function workerShape(model) {
  const out = {
    label: model?.label,
    active: model?.active !== false,
    output: sizeOf(model?.output),
    perColorway: {},
    views: {},
  };
  for (const key of TUNING_KEYS) if (model?.[key] !== undefined && model[key] !== null) out[key] = model[key];
  for (const [id, override] of Object.entries(isObject(model?.perColorway) ? model.perColorway : {})) {
    const kept = Object.fromEntries(TUNING_KEYS.filter((k) => override?.[k] !== undefined).map((k) => [k, override[k]]));
    if (Object.keys(kept).length > 0) out.perColorway[id] = kept;
  }
  for (const viewId of VIEWS) {
    const view = model?.views?.[viewId];
    if (!isObject(view)) continue;
    out.views[viewId] = {
      w: view.w ?? null,
      h: view.h ?? null,
      printArea: { x: view.printArea?.x, y: view.printArea?.y, w: view.printArea?.w, h: view.printArea?.h },
      printAreaMm: sizeOf(view.printAreaMm),
      originalDims: sizeOf(view.originalDims),
      colorways: (Array.isArray(view.colorways) ? view.colorways : []).map((cw) => ({
        id: cw.id,
        label: cw.label,
        photoFileId: cw.photoFileId,
        displacementFileId: cw.displacementFileId,
        maskFileId: cw.maskFileId ?? null,
        ...(typeof cw.mapContrastSd === 'number' ? { mapContrastSd: cw.mapContrastSd } : {}),
      })),
    };
  }
  return out;
}

function stable(value) {
  return JSON.stringify(value, (_key, v) => (isObject(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v));
}

/** True when `stored` (a PlatformModel) holds exactly what `sent` (a PUT body) asked for. */
export function sameModel(sent, stored) {
  return stored != null && stable(workerShape(sent)) === stable(workerShape(stored));
}

// ── what went wrong, in Swedish ─────────────────────────────────────────────

/**
 * True when the request may have reached the server but its answer did not
 * come back whole: the connection broke, a gateway answered for it (5xx), or
 * the answer could not be read. The outcome must then be read back.
 */
export function isLostAnswer(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 'network_error') return true;
  if (error.code === 'bad_response') return true;
  return Number.isInteger(error.status) && error.status >= 500;
}

const MODEL_REASONS = {
  file_not_found: 'En av färgvägarnas bilder finns inte på servern. Ta bort färgvägen och ladda upp den igen.',
  not_registered: 'Foto, displacement-karta och mask har inte samma pixelmått på servern. Ladda upp färgvägen igen med bilder i samma mått.',
  duplicate_colorway: 'Två färgvägar har samma id. Ge den ena ett annat namn.',
};

/** A refused model write (PUT or PATCH) → the sentence the page shows. */
export function modelRefusalMessage(error) {
  const status = error?.status;
  if (error?.code === 'unauthenticated') return error.message;
  if (status === 400) return MODEL_REASONS[error.reason] ?? 'Servern godtog inte modellen: ett värde ligger utanför det tillåtna.';
  if (status === 409 && error.code === 'limit_reached') {
    return 'Plattformen har redan 100 modeller. Inaktivera eller återanvänd en befintlig modell i stället för att skapa en ny.';
  }
  if (status === 413) return 'Modellen är för stor för att sparas.';
  if (status === 404) return 'Servern hittar inte modellen, eller så saknar kontot behörighet. Ladda om sidan.';
  if (status === 429) return 'För många förfrågningar just nu. Vänta en stund och försök igen.';
  return `Servern godtog inte ändringen (HTTP ${status ?? '?'}).`;
}

const UPLOAD_REASONS = {
  not_an_allowed_image: 'servern tar bara emot PNG, JPEG, WebP eller AVIF.',
  type_not_as_stated: 'bildens innehåll stämmer inte med dess filtyp.',
};

/** A refused studio-file upload → the sentence the editor shows (`role`: "Plaggfotot", …). */
export function uploadRefusalMessage(role, error) {
  const status = error?.status;
  if (error?.code === 'unauthenticated') return error.message;
  if (status === 400) return `${role} togs inte emot: ${UPLOAD_REASONS[error.reason] ?? 'filen var tom eller hade fel längd.'}`;
  if (status === 413) return `${role} är större än 15 MB.`;
  if (status === 409) return `${role} laddas redan upp just nu. Försök igen om en stund.`;
  if (status === 404) return 'Uppladdning av studiobilder är inte påslagen i den här miljön.';
  if (status === 429) return 'För många förfrågningar just nu. Vänta en stund och försök igen.';
  return `${role} togs inte emot (HTTP ${status ?? '?'}).`;
}

/**
 * The size check of a derivative before it is sent (the Worker's cap is 15 MiB,
 * refused there before the body is read) → a sentence, or null when it fits.
 */
export function derivativeSizeProblem(role, blob) {
  const size = blob?.size;
  if (!Number.isFinite(size) || size <= 0) return `${role} blev tom när den skalades ner.`;
  if (size <= STUDIO_FILE_MAX_BYTES) return null;
  // Rounded up, so a file just over the cap never reads as "15 MB".
  const mb = (Math.ceil((size / (1024 * 1024)) * 10) / 10).toLocaleString('sv');
  return `${role} är ${mb} MB efter nedskalningen; servern tar emot högst 15 MB per bild. Använd en mindre eller enklare bild.`;
}
