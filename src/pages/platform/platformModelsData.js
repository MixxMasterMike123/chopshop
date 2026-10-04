// PlatformModels' data layer: the OLDER build's implementation (Firebase).
//
// The page (PlatformModels.jsx) and its editor (components/platform/ModelEditor.jsx)
// reach their data only through this module, so they serve two builds: the older
// build (vite.config.js) uses this file as it is; the admin build
// (vite.admin.config.js) swaps it, by its alias list, for
// src/admin-app/replacements/platformModelsData.js (the API). Both files export
// the same names with the same meaning.
//
// Everything here is the page's and the editor's former inline code, and the
// Storage half of src/utils/pod3dUpload.js, moved and unchanged. The page reads
// Firestore DIRECTLY (getDocs) — never the cached loader — so platform edits are
// never stale; the page and the editor call clearPod3dModelsCache() after every
// successful write so an open studio tab reloads fresh.

import {
  collection,
  getDocs,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  deleteField,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, listAll, deleteObject } from 'firebase/storage';
import { db, storage } from '../../firebase/config';
import { validateModelAssetSet, makeWebDerivative, measureMapContrastSd } from '../../utils/pod3dUpload';

// The editor's dot-path writes carry these sentinels (updateDoc understands them).
export { serverTimestamp, deleteField };

/** The card's "Ta bort" deletes the model and its files. */
export const DELETE_MODEL = true;

/** The confirm of the editor's "Ta bort" on one colorway. */
export const removeColorwayConfirm = (label) => `Vill du ta bort färgvägen "${label}"? Filerna raderas.`;

/** Every model of the pod3dModels collection, as the page lists it (unsorted). */
export async function loadModels() {
  const snap = await getDocs(collection(db, 'pod3dModels'));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
}

/** The model the editor opens with: the list's own row (the list was read directly). */
export async function readModelForEditor(model) {
  return model;
}

/** Aktivera / Inaktivera. Answers nothing: the page sets the flag on its row. */
export async function setModelActive(model, next) {
  await updateDoc(doc(db, 'pod3dModels', model.id), { active: next, updatedAt: serverTimestamp() });
}

/** "Ta bort": the model's Storage prefix (best-effort sweep, never throws), then its doc. */
export async function deleteModel(model) {
  await deleteModelAssets(model.id);
  await deleteDoc(doc(db, 'pod3dModels', model.id));
}

/** A new model with the defaults → the model as the page holds it (the editor opens on it). */
export async function createModel(label) {
  const created = await addDoc(collection(db, 'pod3dModels'), {
    label: label.trim(),
    scope: 'platform',
    active: true,
    views: { front: { w: null, h: null, printArea: { x: 0, y: 0, w: 0, h: 0 }, colorways: {} } },
    printAreaMm: { front: { w: 300, h: 400 } },
    displacementScale: 30,
    displacementBlur: 6,
    blend: 'multiply',
    alpha: 0.8,
    perColorway: {},
    output: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return {
    id: created.id,
    label: label.trim(),
    scope: 'platform',
    active: true,
    views: { front: { w: null, h: null, printArea: { x: 0, y: 0, w: 0, h: 0 }, colorways: {} } },
    printAreaMm: { front: { w: 300, h: 400 } },
    displacementScale: 30,
    displacementBlur: 6,
    blend: 'multiply',
    alpha: 0.8,
    perColorway: {},
    output: null,
  };
}

/** The editor's write: a dot-path patch of the model's doc. Answers nothing. */
export const saveModelDoc = (modelId, data) => updateDoc(doc(db, 'pod3dModels', modelId), data);

// Sanitize a filename for a Storage object segment (matches podUpload's safeName).
const safeName = (name) => String(name || 'asset').replace(/[^a-zA-Z0-9.-]/g, '_');

/**
 * uploadModelColorwayAssets({ modelId, viewId, colorwayId, photoFile,
 *   displacementFile, maskFile?, expectedOriginalDims? })
 *   → Promise<{ photoUrl, displacementUrl, maskUrl?, originalPaths, derivative, original, mapContrastSd }>
 *
 * Validates registration, uploads the raw originals, then uploads deterministic
 * EXTENSION-LESS web derivatives (true replace on re-upload — the contentType
 * metadata carries the real format, mirroring mockupUpload.js) and returns their
 * download URLs (token URLs; the pixi compositor loads them cross-origin with its
 * own corsbust handling — nothing to do here).
 *
 * ORIGINALS ARE RAW: originals upload BYTE-FOR-BYTE (uploadBytes, no canvas) so
 * the platform keeps a pristine master. NEVER route them through imageUpload.js.
 */
export const uploadModelColorwayAssets = async ({
  modelId,
  viewId,
  colorwayId,
  photoFile,
  displacementFile,
  maskFile,
  expectedOriginalDims,
} = {}) => {
  if (!modelId) throw new Error('Modell-id saknas.');
  if (!viewId) throw new Error('Vy-id saknas.');
  if (!colorwayId) throw new Error('Färgväg-id saknas.');
  if (!photoFile) throw new Error('Fotofil saknas.');
  if (!displacementFile) throw new Error('Displacement-karta saknas.');

  // 1) Registration gate (also vs the view's existing original dims when given).
  const original = await validateModelAssetSet(
    { photoFile, displacementFile, maskFile },
    expectedOriginalDims
  );

  const base = `pod-3d-models/${modelId}/${viewId}/${colorwayId}`;

  // 2) Upload ORIGINALS raw byte-for-byte (no canvas).
  const originalPaths = {};
  const photoOrigPath = `${base}/originals/photo_${safeName(photoFile.name)}`;
  const mapOrigPath = `${base}/originals/map_${safeName(displacementFile.name)}`;
  await uploadBytes(ref(storage, photoOrigPath), photoFile);
  await uploadBytes(ref(storage, mapOrigPath), displacementFile);
  originalPaths.photo = photoOrigPath;
  originalPaths.displacement = mapOrigPath;
  if (maskFile) {
    const maskOrigPath = `${base}/originals/mask_${safeName(maskFile.name)}`;
    await uploadBytes(ref(storage, maskOrigPath), maskFile);
    originalPaths.mask = maskOrigPath;
  }

  // 3) Build + upload derivatives to EXTENSION-LESS names (true replace on re-upload).
  const photoDeriv = await makeWebDerivative(photoFile);
  const mapDeriv = await makeWebDerivative(displacementFile);

  // Originals shared dims + deterministic downscale ⇒ derivatives share dims. Assert.
  if (photoDeriv.w !== mapDeriv.w || photoDeriv.h !== mapDeriv.h) {
    throw new Error(
      `Internt fel: foto- och kart-derivaten fick olika pixelmått ` +
      `(${photoDeriv.w}×${photoDeriv.h} vs ${mapDeriv.w}×${mapDeriv.h}).`
    );
  }

  // Measure displacement-map contrast on its derivative canvas (the exact pixels
  // the studio will warp with). A low sd → warn the operator (result field below).
  const mapContrastSd = mapDeriv.canvas ? measureMapContrastSd(mapDeriv.canvas) : null;

  const photoDerivPath = `${base}/photo-1600`;
  const mapDerivPath = `${base}/map-1600`;
  const photoSnap = await uploadBytes(ref(storage, photoDerivPath), photoDeriv.blob, { contentType: photoDeriv.type });
  const mapSnap = await uploadBytes(ref(storage, mapDerivPath), mapDeriv.blob, { contentType: mapDeriv.type });
  const photoUrl = await getDownloadURL(photoSnap.ref);
  const displacementUrl = await getDownloadURL(mapSnap.ref);

  const out = {
    photoUrl,
    displacementUrl,
    originalPaths,
    derivative: { w: photoDeriv.w, h: photoDeriv.h },
    original,
    mapContrastSd, // grayscale sd of the map's print-ish center; low = weak folds
  };

  if (maskFile) {
    const maskDeriv = await makeWebDerivative(maskFile);
    const maskDerivPath = `${base}/mask-1600`;
    const maskSnap = await uploadBytes(ref(storage, maskDerivPath), maskDeriv.blob, { contentType: maskDeriv.type });
    out.maskUrl = await getDownloadURL(maskSnap.ref);
  }

  return out;
};

/**
 * deleteColorwayAssets(modelId, viewId, colorwayId) → Promise<void>
 * Best-effort recursive delete of one colorway's Storage prefix. Never throws —
 * console.warn on any failure (a doc-only delete must not leave the UI stuck).
 */
export const deleteColorwayAssets = async (modelId, viewId, colorwayId) => {
  if (!modelId) throw new Error('Modell-id saknas.');
  if (!viewId) throw new Error('Vy-id saknas.');
  if (!colorwayId) throw new Error('Färgväg-id saknas.');
  await deletePrefix(`pod-3d-models/${modelId}/${viewId}/${colorwayId}`);
};

/**
 * deleteModelAssets(modelId) → Promise<void>
 * Best-effort recursive delete of a whole model's Storage prefix. Never throws.
 */
export const deleteModelAssets = async (modelId) => {
  if (!modelId) throw new Error('Modell-id saknas.');
  await deletePrefix(`pod-3d-models/${modelId}`);
};

// Recursively delete every object under a Storage prefix (best-effort). listAll
// returns direct items + prefixes; recurse into prefixes. Promise.allSettled so one
// failure never aborts the sweep; warn and move on — never throw.
const deletePrefix = async (prefix) => {
  try {
    const res = await listAll(ref(storage, prefix));
    const results = await Promise.allSettled([
      ...res.items.map((item) => deleteObject(item)),
      ...res.prefixes.map((p) => deletePrefix(p.fullPath)),
    ]);
    results
      .filter((r) => r.status === 'rejected')
      .forEach((r) => console.warn(`pod3dUpload: kunde inte radera under ${prefix}:`, r.reason?.message));
  } catch (err) {
    console.warn(`pod3dUpload: listAll misslyckades för ${prefix}:`, err?.message);
  }
};
