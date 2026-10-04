// PlatformModels' data layer for the ADMIN build (CP5 unit FO): everything but
// the browser half of the colourway upload, which platformModelsData.js adds
// (it draws on a canvas, so Node cannot load it). platformModelsData.js is the
// module the alias list puts in place of src/pages/platform/platformModelsData.js;
// both export the same names with the same meaning.
//
// PLATFORM-ONLY. Every call is a platform request (no X-Shop-Id):
//   the list                    GET   /v1/platform/pod/3d-models (inactive ones too, and their files)
//   Ny modell                   PUT   …/:modelId with an id made here, uncalibrated
//   Aktivera / Inaktivera       PATCH …/:modelId { active }
//   Redigera                    the list is read again, so the editor starts from the server
//   the editor's writes         PUT   …/:modelId: the WHOLE document = what the server last
//                               answered + the editor's dot-path patch (adapters/platformModels.js);
//                               the answer replaces what the page holds
//   a colourway's images        POST  /v1/platform/pod/studio-files, one per web derivative
// What has no route, and what the page does instead:
//   - "Ta bort" on a model: the Worker deletes no model (they are deactivated),
//     so the card's control leaves (DELETE_MODEL); deleteModel refuses;
//   - a removed colourway's images, and those of an upload whose save failed,
//     stay in the bucket: nothing deletes a studio file (deleteColorwayAssets
//     does nothing);
//   - the raw originals: no home on the Worker; only the derivatives are sent
//     (originalDims is still stored and still checks the next colourway).
// No revision fence exists on the PUT: the last write wins (a Worker follow-up).
// A write whose answer is lost (the connection broke, a gateway answered) is
// read back before the page is told it failed or succeeded.

import { notAvailable } from '../../api/admin/client.js';
import { put3dModel, readAll3dModels, set3dModelActive, uploadStudioFile } from '../../api/admin/platform.js';
import {
  DELETE_FIELD,
  SERVER_TIME,
  applyModelPatch,
  derivativeSizeProblem,
  isLostAnswer,
  modelBodyOf,
  modelRefusalMessage,
  newModelBody,
  newModelId,
  pageModelOf,
  sameModel,
  uploadRefusalMessage,
} from '../adapters/platformModels.js';
import { clearPod3dModelsCache } from './pod3dModels.js';

// The editor's dot-path writes carry these markers (applyModelPatch reads them).
export const serverTimestamp = () => SERVER_TIME;
export const deleteField = () => DELETE_FIELD;

/** No delete of a model on the Worker (deactivate it): the card's "Ta bort" leaves. */
export const DELETE_MODEL = false;

/** The confirm of the editor's "Ta bort" on one colourway: its images are not deleted here. */
export const removeColorwayConfirm = (label) =>
  `Vill du ta bort färgvägen "${label}"? Den tas bort från modellen; de uppladdade bilderna finns kvar på servern.`;

// What the server last answered, per model id: { raw (its PlatformModel), page }.
// Every read and every write's answer replaces the entry; a PUT is built on it.
const answered = new Map();
// Every studio file seen (the list's `files`, the uploads' answers), by id.
const knownFiles = new Map();

/** An Error the page shows as it is (`userMessage`). */
function pageError(message, cause) {
  const error = new Error(message);
  error.userMessage = message;
  if (cause) error.cause = cause;
  return error;
}

/** A 2xx whose body lacks what it must carry: the outcome is unknown, as with no answer. */
function lostAnswer() {
  const error = new Error('The answer did not carry the model');
  error.code = 'bad_response';
  return error;
}

function readFailureMessage(error) {
  if (error?.code === 'unauthenticated') return error.message;
  if (error?.code === 'network_error') return 'Modellerna kunde inte läsas: servern kunde inte nås.';
  return `Modellerna kunde inte läsas: servern svarade med ett fel (HTTP ${error?.status ?? '?'}).`;
}

function remember(raw) {
  const page = pageModelOf(raw, knownFiles);
  answered.set(raw.modelId, { raw, page });
  return structuredClone(page);
}

/** GET the list; every model and file in it becomes what the server last answered. */
async function readList() {
  const { models, files } = await readAll3dModels();
  for (const [id, file] of Object.entries(files)) knownFiles.set(id, file);
  const listed = models.filter((m) => m && typeof m.modelId === 'string');
  const ids = new Set(listed.map((m) => m.modelId));
  for (const id of [...answered.keys()]) if (!ids.has(id)) answered.delete(id);
  return listed.map(remember);
}

/** Every model, as the page lists it (unsorted). */
export async function loadModels() {
  try {
    return await readList();
  } catch (error) {
    throw pageError(readFailureMessage(error), error);
  }
}

/** The model the editor opens with: read again from the server, never the list's row as it was. */
export async function readModelForEditor(model) {
  await loadModels();
  const held = answered.get(model?.id);
  if (!held) throw pageError('Modellen finns inte längre på servern. Ladda om sidan.');
  return structuredClone(held.page);
}

/**
 * After a write whose answer was lost: the list is read again. → the model's
 * stored PlatformModel, or null when the list has no such model. Throws the
 * "unclear" sentence when the list cannot be read either.
 */
async function readBack(modelId, unclear, cause) {
  try {
    await readList();
  } catch {
    throw pageError(`Anslutningen bröts och det är oklart om ${unclear}. Ladda om sidan och kontrollera innan du försöker igen.`, cause);
  }
  return answered.get(modelId)?.raw ?? null;
}

const CREATE_WORDS = { unclear: 'modellen skapades', notDone: 'modellen skapades inte' };
const SAVE_WORDS = { unclear: 'ändringen sparades', notDone: 'ändringen sparades inte' };

/** PUT the whole document → the page's model as the server stored it. */
async function putModel(modelId, body, words) {
  try {
    const { model } = await put3dModel(modelId, body);
    if (!model) throw lostAnswer();
    return remember(model);
  } catch (error) {
    if (error?.userMessage) throw error;
    if (!isLostAnswer(error)) throw pageError(modelRefusalMessage(error), error);
    const stored = await readBack(modelId, words.unclear, error);
    if (sameModel(body, stored)) return structuredClone(answered.get(modelId).page);
    throw pageError(`Anslutningen bröts och ${words.notDone}. Försök igen.`, error);
  } finally {
    // The shop admin's studio in this tab reads the models again (the older page's effect).
    clearPod3dModelsCache();
  }
}

/** Aktivera / Inaktivera → the model as the server stored it. */
export async function setModelActive(model, next) {
  try {
    const { model: stored } = await set3dModelActive(model.id, next);
    if (!stored) throw lostAnswer();
    return remember(stored);
  } catch (error) {
    if (error?.userMessage) throw error;
    if (!isLostAnswer(error)) throw pageError(modelRefusalMessage(error), error);
    const stored = await readBack(model.id, 'statusen ändrades', error);
    if (stored && stored.active === next) return structuredClone(answered.get(model.id).page);
    throw pageError('Anslutningen bröts och statusen ändrades inte. Försök igen.', error);
  } finally {
    clearPod3dModelsCache();
  }
}

/** No route deletes a model (deactivate it instead); the page does not offer it. */
export function deleteModel() {
  return Promise.reject(notAvailable('Att ta bort en 3D-modell'));
}

/** A new, uncalibrated model under an id made here → the model as the server stored it. */
export async function createModel(label) {
  const { body, problems } = newModelBody(label);
  if (problems.length > 0) throw pageError(problems.join(' '));
  return putModel(newModelId(), body, CREATE_WORDS);
}

/**
 * The editor's write: its dot-path patch on the model the server last
 * answered, sent whole. → the model as the server stored it (the editor
 * follows it). Refused before any request when a value is one the Worker
 * would refuse.
 */
export async function saveModelDoc(modelId, patch) {
  if (!answered.has(modelId)) await loadModels();
  const held = answered.get(modelId);
  if (!held) throw pageError('Modellen finns inte längre på servern. Ladda om sidan.');
  const { body, problems } = modelBodyOf(applyModelPatch(held.page, patch));
  if (problems.length > 0) throw pageError(problems.join(' '));
  return putModel(modelId, body, SAVE_WORDS);
}

/** Nothing deletes a studio file: a removed colourway's images stay in the bucket. */
export async function deleteColorwayAssets() {}

/** Nothing deletes a studio file (and no model is deleted). */
export async function deleteModelAssets() {}

const ROLES = { photo: 'Plaggfotot', map: 'Displacement-kartan', mask: 'Masken' };

/**
 * One derivative as a studio file. A lost answer is asked again once with the
 * same bytes: the Worker answers the file that already holds them (200), so
 * the second request is the read-back and never stores a second copy.
 */
async function postStudioFile(role, blob) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const file = await uploadStudioFile(blob, blob.type);
      if (!file || typeof file.fileId !== 'string') throw lostAnswer();
      knownFiles.set(file.fileId, file);
      return file;
    } catch (error) {
      if (!isLostAnswer(error)) throw pageError(uploadRefusalMessage(role, error), error);
      if (attempt >= 2) {
        throw pageError(
          `Anslutningen bröts när ${role.toLowerCase()} laddades upp. Försök igen — samma bild sparas inte två gånger.`,
          error,
        );
      }
    }
  }
}

/**
 * The network half of a colourway's upload. `photo`, `map`, `mask?`: the web
 * derivatives made in the browser ({ blob, w, h }), `original` the originals'
 * size, `mapContrastSd` the map's measure. Each derivative over the Worker's
 * cap is refused before any request. → what the editor reads of an upload,
 * plus `fileIds` (the colourway names its images by them in the PUT).
 */
export async function uploadPreparedColorway({ photo, map, mask = null, original, mapContrastSd = null }) {
  const parts = [['photo', photo], ['map', map], ...(mask ? [['mask', mask]] : [])];
  const tooBig = parts.map(([key, part]) => derivativeSizeProblem(ROLES[key], part?.blob)).filter(Boolean);
  if (tooBig.length > 0) throw pageError(tooBig.join(' '));
  const files = {};
  for (const [key, part] of parts) files[key] = await postStudioFile(ROLES[key], part.blob);
  const out = {
    photoUrl: files.photo.url,
    displacementUrl: files.map.url,
    fileIds: { photo: files.photo.fileId, displacement: files.map.fileId, mask: files.mask?.fileId ?? null },
    // The server's measure of the stored photo when it has one (it checks the set by it).
    derivative: { w: files.photo.width ?? photo.w, h: files.photo.height ?? photo.h },
    original,
    mapContrastSd,
  };
  if (files.mask) out.maskUrl = files.mask.url;
  return out;
}
