// PlatformModels' admin-build data module (unit CP5-FO), end to end against the
// dev API under Node: fetch is routed into dev-api.mjs's route(), and the
// writes are the patches ModelEditor.jsx builds (addColorway, removeColorway,
// save), with the markers of this build.
//   node --test src/admin-app/replacements/platformModelsCore.test.mjs
// (platformModelsData.js adds only the browser half of the upload: canvases.)

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from '../../api/admin/client.js';
import { STUDIO_FILE_MAX_BYTES } from '../adapters/platformModels.js';
import { createState, route } from '../dev/dev-api.mjs';
import { png } from '../dev/models-dev.mjs';
import { loadPod3dModels } from './pod3dModels.js';
import {
  DELETE_MODEL,
  createModel,
  deleteColorwayAssets,
  deleteField,
  deleteModel,
  loadModels,
  readModelForEditor,
  removeColorwayConfirm,
  saveModelDoc,
  serverTimestamp,
  setModelActive,
  uploadPreparedColorway,
} from './platformModelsCore.js';

const realFetch = globalThis.fetch;
let state;
let cookie;
let session;
let sent;
let sellerReads;

function setScenario(name = '') {
  cookie = session + (name ? `; admin_dev_fo=${name}` : '');
}

function useDevApi() {
  state = createState();
  const signIn = route(state, 'POST', new URL('http://dev.invalid/_api/api/auth/sign-in/email'), {}, { email: 'platform@example.com', password: 'dev-password-2' });
  session = signIn.setCookie.split(';')[0];
  setScenario();
  globalThis.fetch = async (url, init = {}) => {
    const headers = { cookie, ...Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])) };
    let body = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body instanceof Blob) {
      body = { raw: Buffer.from(await init.body.arrayBuffer()) };
      headers['content-length'] = String(init.body.size);
    }
    sent.push({ url, method: init.method || 'GET', headers, body });
    // The seller's studio read (pod3dModels.js): answered here, counted.
    if (url === '/_api/v1/admin/pod/3d-models') {
      sellerReads += 1;
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    const answer = route(state, init.method || 'GET', new URL(url, 'http://dev.invalid'), headers, body);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
}

beforeEach(() => {
  sent = [];
  sellerReads = 0;
  setRequestShopId('test-shop-a'); // a shop active in the tab: never sent on these routes
  useDevApi();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

const TEE = 'DevTeeOnModel0000001';
const writes = () => sent.filter((r) => r.method !== 'GET');
const platformOnly = () => sent.filter((r) => r.url.includes('/v1/platform/')).every((r) => !('x-shop-id' in r.headers));
const derivative = (w, h, v) => {
  const bytes = png(w, h, () => [v, v, v]);
  return { blob: new Blob([bytes], { type: 'image/png' }), w, h };
};
const prepared = (w = 40, h = 50, seed = 10) => ({
  photo: derivative(w, h, seed),
  map: derivative(w, h, seed + 1),
  mask: derivative(w, h, seed + 2),
  original: { w: w * 4, h: h * 4 },
  mapContrastSd: 31.5,
});

/** ModelEditor.addColorway's patch for an upload result. */
function addPatch(id, label, res, { seeded = null } = {}) {
  const entry = { label, photoUrl: res.photoUrl, displacementUrl: res.displacementUrl };
  if (res.maskUrl) entry.maskUrl = res.maskUrl;
  if (Number.isFinite(res.mapContrastSd)) entry.mapContrastSd = res.mapContrastSd;
  if (res.fileIds) entry.fileIds = res.fileIds;
  const patch = {
    [`views.front.colorways.${id}`]: entry,
    'views.front.w': res.derivative.w,
    'views.front.h': res.derivative.h,
    'views.front.originalDims': res.original,
    updatedAt: serverTimestamp(),
  };
  if (seeded) patch['views.front.printArea'] = seeded;
  return patch;
}

describe('what leaves, and what is said instead', () => {
  it('no delete of a model; a removed colourway\'s images are not deleted, and the confirm says so', async () => {
    assert.equal(DELETE_MODEL, false);
    await assert.rejects(deleteModel({ id: TEE }), (e) => e.code === 'not_available');
    await deleteColorwayAssets(TEE, 'front', 'vit');
    assert.equal(sent.length, 0);
    const text = removeColorwayConfirm('Vit');
    assert.match(text, /finns kvar på servern/);
    assert.doesNotMatch(text, /raderas/);
  });
});

describe('the list and the editor\'s start', () => {
  it('loadModels: every model with its images\' addresses and ids, no shop header', async () => {
    const list = await loadModels();
    assert.deepEqual(list.map((m) => m.id).sort(), ['DevHoodieModel000002', 'DevTankModel00000003', TEE]);
    const tee = list.find((m) => m.id === TEE);
    assert.match(tee.views.front.colorways.vit.photoUrl, /^data:image\/png;base64,/);
    assert.ok(tee.views.front.colorways.vit.fileIds.photo);
    assert.deepEqual(tee.printAreaMm.front, { w: 300, h: 400 });
    assert.equal(list.find((m) => m.id === 'DevTankModel00000003').active, false);
    assert.ok(platformOnly());
  });

  it('a failed list read says what happened', async () => {
    setScenario('error');
    await assert.rejects(loadModels(), (e) => e.userMessage === 'Modellerna kunde inte läsas: servern svarade med ett fel (HTTP 500).');
  });

  it('readModelForEditor reads the server again: a stale row never reaches the editor', async () => {
    const [row] = (await loadModels()).filter((m) => m.id === TEE);
    // Someone else renames it meanwhile.
    route(state, 'PATCH', new URL(`http://dev.invalid/_api/v1/platform/pod/3d-models/${TEE}`), { cookie }, { active: false });
    const fresh = await readModelForEditor(row);
    assert.equal(fresh.active, false);
    assert.equal(sent.filter((r) => r.method === 'GET').length, 2);
    await assert.rejects(readModelForEditor({ id: 'NoSuchModel' }), (e) => /finns inte längre/.test(e.userMessage));
  });
});

describe('create → upload → calibrate → save, as the editor does it', () => {
  it('a new model under a 20-character id, uncalibrated; its first colourway; the full save; held after a reload', async () => {
    await loadModels();
    const created = await createModel('  Sweatshirt  ');
    assert.match(created.id, /^[A-Za-z0-9]{20}$/);
    assert.equal(created.label, 'Sweatshirt');
    assert.deepEqual(created.views.front, { w: null, h: null, printArea: { x: 0, y: 0, w: 0, h: 0 }, originalDims: null, colorways: {} });
    assert.equal(writes()[0].method, 'PUT');

    // Lägg till färgväg: the derivatives go up, then the colourway is saved.
    const res = await uploadPreparedColorway(prepared());
    assert.equal(sent.filter((r) => r.url.endsWith('/studio-files')).length, 3);
    assert.deepEqual(res.derivative, { w: 40, h: 50 });
    assert.deepEqual(res.original, { w: 160, h: 200 });
    assert.match(res.photoUrl, /^data:image\/png/);
    assert.ok(res.fileIds.photo && res.fileIds.displacement && res.fileIds.mask);
    const seeded = { x: 12, y: 15, w: 17, h: 22 };
    const stored = await saveModelDoc(created.id, addPatch('gra-melerad', 'Grå melerad', res, { seeded }));
    assert.deepEqual(Object.keys(stored.views.front.colorways), ['gra-melerad']);
    assert.equal(stored.views.front.colorways['gra-melerad'].photoUrl, res.photoUrl);
    assert.equal(stored.views.front.colorways['gra-melerad'].mapContrastSd, 31.5);
    assert.deepEqual([stored.views.front.w, stored.views.front.h], [40, 50]);
    assert.deepEqual(stored.views.front.printArea, seeded);

    // Spara: the whole form.
    const saved = await saveModelDoc(created.id, {
      label: 'Sweatshirt på modell',
      'views.front.printArea': { x: 10, y: 12, w: 20, h: 26 },
      'printAreaMm.front': { w: 280, h: 360 },
      displacementScale: 40, displacementBlur: 4, displacementContrast: 1.5, blend: 'overlay', alpha: 0.7,
      perColorway: { 'gra-melerad': { alpha: 0.55 } },
      output: { w: 40, h: 50 },
      updatedAt: serverTimestamp(),
    });
    assert.equal(saved.label, 'Sweatshirt på modell');
    assert.deepEqual(saved.views.front.printArea, { x: 10, y: 12, w: 20, h: 26 });
    assert.equal(Object.keys(saved.views.front.colorways).length, 1); // untouched by the form, kept

    const again = (await loadModels()).find((m) => m.id === created.id);
    assert.deepEqual(again, saved);
    assert.ok(platformOnly());
  });

  it('removing a colourway is a PUT without it; its images stay on the server', async () => {
    await loadModels();
    const tee = await readModelForEditor({ id: TEE });
    const svartPhoto = tee.views.front.colorways.svart.fileIds.photo;
    const stored = await saveModelDoc(TEE, {
      'views.front.colorways.svart': deleteField(),
      'perColorway.svart': deleteField(),
      updatedAt: serverTimestamp(),
    });
    assert.deepEqual(Object.keys(stored.views.front.colorways), ['vit']);
    assert.deepEqual(stored.perColorway, {});
    assert.equal(writes().at(-1).method, 'PUT');
    assert.equal(writes().at(-1).body.views.front.colorways.length, 1);
    assert.ok(state.fo.files.has(svartPhoto)); // nothing deletes a studio file
  });

  it('Aktivera/Inaktivera; a later save keeps the server\'s flag (built on the last answer)', async () => {
    const [tee] = (await loadModels()).filter((m) => m.id === TEE);
    const off = await setModelActive(tee, false);
    assert.equal(off.active, false);
    assert.deepEqual(writes().at(-1).body, { active: false });
    const saved = await saveModelDoc(TEE, { label: 'T-shirt på modell', updatedAt: serverTimestamp() });
    assert.equal(saved.active, false);
    assert.equal(writes().at(-1).body.active, false);
  });
});

describe('refusals: the server\'s reason in a Swedish sentence', () => {
  it('a value the Worker would refuse is said before any request', async () => {
    await loadModels();
    await assert.rejects(saveModelDoc(TEE, { label: 'x'.repeat(81) }), (e) => /Namnet måste vara 1–80 tecken/.test(e.userMessage));
    await assert.rejects(saveModelDoc(TEE, { 'printAreaMm.front': { w: 2500, h: 300 } }), (e) => /högst 200 × 200 cm/.test(e.userMessage));
    await assert.rejects(createModel(''), (e) => /Namnet/.test(e.userMessage));
    assert.equal(writes().length, 0);
  });

  it('the server\'s refusals', async () => {
    await loadModels();
    setScenario('refuse:not_registered');
    await assert.rejects(saveModelDoc(TEE, { label: 'X' }), (e) => /samma pixelmått/.test(e.userMessage));
    setScenario('refuse:file_not_found');
    await assert.rejects(saveModelDoc(TEE, { label: 'X' }), (e) => /finns inte på servern/.test(e.userMessage));
    setScenario('limit');
    await assert.rejects(createModel('Ny'), (e) => /redan 100 modeller/.test(e.userMessage));
    setScenario();
    await assert.rejects(setModelActive({ id: 'NoSuchModel' }, true), (e) => /hittar inte modellen/.test(e.userMessage));
  });

  it('a refused upload names the image; a derivative over 15 MiB is refused before any request', async () => {
    setScenario('reject-file');
    await assert.rejects(uploadPreparedColorway(prepared()),
      (e) => e.userMessage === 'Plaggfotot togs inte emot: servern tar bara emot PNG, JPEG, WebP eller AVIF.');
    setScenario('dark');
    await assert.rejects(uploadPreparedColorway(prepared()), (e) => /inte påslagen/.test(e.userMessage));
    setScenario();
    sent = [];
    const big = prepared();
    big.map = { ...big.map, blob: new Blob([new Uint8Array(STUDIO_FILE_MAX_BYTES + 1)], { type: 'image/png' }) };
    await assert.rejects(uploadPreparedColorway(big), (e) => /^Displacement-kartan är 15,1 MB/.test(e.userMessage));
    assert.equal(sent.length, 0);
  });
});

describe('a lost answer is read back before anything is said', () => {
  it('lost: the write was done → success with the stored model', async () => {
    await loadModels();
    setScenario('lost');
    const stored = await saveModelDoc(TEE, { label: 'Efter ett tappat svar', updatedAt: serverTimestamp() });
    assert.equal(stored.label, 'Efter ett tappat svar');
    assert.equal(sent.at(-1).method, 'GET'); // the read-back
    const [tee] = (await loadModels()).filter((m) => m.id === TEE);
    setScenario('lost');
    assert.equal((await setModelActive(tee, false)).active, false);
    const created = await createModel('Tappad men skapad');
    assert.equal(created.label, 'Tappad men skapad');
  });

  it('drop: not done → "sparades inte"; unclear: the read-back fails too → "oklart"', async () => {
    await loadModels();
    setScenario('drop');
    await assert.rejects(saveModelDoc(TEE, { label: 'Aldrig sparad' }),
      (e) => e.userMessage === 'Anslutningen bröts och ändringen sparades inte. Försök igen.');
    await assert.rejects(createModel('Aldrig skapad'), (e) => /modellen skapades inte/.test(e.userMessage));
    await assert.rejects(setModelActive({ id: TEE }, false), (e) => /statusen ändrades inte/.test(e.userMessage));
    setScenario('unclear');
    await assert.rejects(saveModelDoc(TEE, { label: 'Kanske' }),
      (e) => /^Anslutningen bröts och det är oklart om ändringen sparades\. Ladda om sidan/.test(e.userMessage));
  });

  it('an upload whose answer is lost is sent once more (the same bytes answer the same file)', async () => {
    setScenario('lost');
    const res = await uploadPreparedColorway(prepared(30, 30, 90));
    assert.equal(sent.filter((r) => r.url.endsWith('/studio-files')).length, 6); // 3 × (lost + again)
    assert.ok(res.fileIds.photo);
    const stored = [...state.fo.files.values()].filter((f) => f.width === 30);
    assert.equal(stored.length, 3); // one file each, no copy
    setScenario('drop');
    await assert.rejects(uploadPreparedColorway(prepared(31, 31, 70)),
      (e) => e.userMessage === 'Anslutningen bröts när plaggfotot laddades upp. Försök igen — samma bild sparas inte två gånger.');
  });
});

describe('the seller\'s studio in the same tab reads the models again after a platform edit', () => {
  it('clearPod3dModelsCache: every write empties the seller\'s cache', async () => {
    await loadPod3dModels();
    await loadPod3dModels();
    assert.equal(sellerReads, 1); // cached
    const [tee] = (await loadModels()).filter((m) => m.id === TEE);
    await setModelActive(tee, false);
    await loadPod3dModels();
    assert.equal(sellerReads, 2);
    setScenario('drop');
    await assert.rejects(saveModelDoc(TEE, { label: 'X' }));
    await loadPod3dModels();
    assert.equal(sellerReads, 3); // also after an outcome that is not known
  });
});
