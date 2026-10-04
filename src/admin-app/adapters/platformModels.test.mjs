// The platform 3D models' adapter (unit CP5-FO), under Node:
//   node --test src/admin-app/adapters/platformModels.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DELETE_FIELD,
  MODEL_ID_PATTERN,
  SERVER_TIME,
  STUDIO_FILE_MAX_BYTES,
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
  workerShape,
} from './platformModels.js';

const F = (n) => `0f3d0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const url = (n) => `https://pub-test.r2.dev/platform/studio/${F(n)}/v1/image.webp`;
const FILES = Object.fromEntries([1, 2, 3, 4].map((n) => [F(n), { fileId: F(n), url: url(n), width: 400, height: 500 }]));

/** A PlatformModel as GET /v1/platform/pod/3d-models answers it (studio-assets.ts platformModel). */
const stored = () => ({
  modelId: 'AbCdEf0123456789wxyz',
  label: 'T-shirt på modell',
  active: true,
  displacementScale: 30,
  displacementBlur: 6,
  displacementContrast: 1.4,
  blend: 'multiply',
  alpha: 0.8,
  output: { w: 400, h: 500 },
  perColorway: { svart: { blend: 'screen', alpha: 0.9 } },
  views: {
    front: {
      w: 400, h: 500,
      printArea: { x: 135, y: 150, w: 130, h: 173 },
      printAreaMm: { w: 300, h: 400 },
      originalDims: { w: 2000, h: 2500 },
      colorways: [
        { id: 'vit', label: 'Vit', photoFileId: F(1), displacementFileId: F(2), maskFileId: F(3), mapContrastSd: 48.2 },
        { id: 'svart', label: 'Svart', photoFileId: F(4), displacementFileId: F(2), maskFileId: null },
      ],
    },
    back: {
      w: null, h: null, printArea: { x: 0, y: 0, w: 0, h: 0 }, printAreaMm: null, originalDims: null, colorways: [],
    },
  },
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-28T14:12:00.000Z',
});

const withoutMeta = ({ modelId: _m, createdAt: _c, updatedAt: _u, ...rest }) => rest;

describe('pageModelOf: the Worker\'s model → the older document the page reads', () => {
  it('colourways a map with their URLs (from `files`) and their ids, printAreaMm on top, tuning kept', () => {
    const page = pageModelOf(stored(), FILES);
    assert.equal(page.id, 'AbCdEf0123456789wxyz');
    assert.deepEqual(Object.keys(page.views.front.colorways), ['vit', 'svart']);
    assert.deepEqual(page.views.front.colorways.vit, {
      label: 'Vit', photoUrl: url(1), displacementUrl: url(2), maskUrl: url(3), mapContrastSd: 48.2,
      fileIds: { photo: F(1), displacement: F(2), mask: F(3) },
    });
    assert.equal(page.views.front.colorways.svart.maskUrl, undefined);
    assert.deepEqual(page.printAreaMm, { front: { w: 300, h: 400 } }); // back has none
    assert.deepEqual(page.views.front.originalDims, { w: 2000, h: 2500 });
    assert.equal(page.displacementContrast, 1.4);
    assert.deepEqual(page.output, { w: 400, h: 500 });
    assert.equal(page.active, true);
  });

  it('a file the list does not hold (or one without an address) leaves its URL out, never an error', () => {
    const page = pageModelOf(stored(), { [F(1)]: { url: null } });
    assert.equal(page.views.front.colorways.vit.photoUrl, undefined);
    assert.equal(page.views.front.colorways.vit.fileIds.photo, F(1));
    const fromMap = pageModelOf(stored(), new Map([[F(1), { url: url(1) }]]));
    assert.equal(fromMap.views.front.colorways.vit.photoUrl, url(1));
  });

  it('round trip: the page model sent back is exactly what the server stored', () => {
    const { body, problems } = modelBodyOf(pageModelOf(stored(), FILES));
    assert.deepEqual(problems, []);
    assert.ok(sameModel(body, stored()));
    assert.deepEqual(workerShape(body), workerShape(withoutMeta(stored())));
  });
});

describe('applyModelPatch: the editor\'s dot-path writes', () => {
  const page = () => pageModelOf(stored(), FILES);

  it('adds a colourway with the view\'s sizes; the server time is dropped; the input is not changed', () => {
    const before = page();
    const entry = { label: 'Grå', photoUrl: url(1), displacementUrl: url(2), fileIds: { photo: F(1), displacement: F(2), mask: null } };
    const next = applyModelPatch(before, {
      'views.front.colorways.gra': entry,
      'views.front.w': 400,
      'views.front.h': 500,
      'views.front.originalDims': { w: 2000, h: 2500 },
      updatedAt: SERVER_TIME,
    });
    assert.deepEqual(Object.keys(next.views.front.colorways), ['vit', 'svart', 'gra']);
    assert.equal(next.updatedAt, before.updatedAt);
    assert.equal(before.views.front.colorways.gra, undefined);
    entry.label = 'ändrad efteråt';
    assert.equal(next.views.front.colorways.gra.label, 'Grå'); // a copy
    const { body } = modelBodyOf(next);
    assert.deepEqual(body.views.front.colorways.at(-1), { id: 'gra', label: 'Grå', photoFileId: F(1), displacementFileId: F(2), maskFileId: null });
  });

  it('removes a colourway and its override; the last one clears the view\'s sizes', () => {
    const next = applyModelPatch(page(), {
      'views.front.colorways.svart': DELETE_FIELD,
      'perColorway.svart': DELETE_FIELD,
      updatedAt: SERVER_TIME,
    });
    assert.deepEqual(Object.keys(next.views.front.colorways), ['vit']);
    assert.deepEqual(next.perColorway, {});
    const last = applyModelPatch(next, {
      'views.front.colorways.vit': DELETE_FIELD,
      'views.front.w': null, 'views.front.h': null, 'views.front.originalDims': null,
    });
    const { body, problems } = modelBodyOf(last);
    assert.deepEqual(problems, []);
    assert.deepEqual(body.views.front, {
      w: null, h: null, printArea: { x: 135, y: 150, w: 130, h: 173 }, printAreaMm: { w: 300, h: 400 }, originalDims: null, colorways: [],
    });
  });

  it('the full save: label, print area, physical size, tuning, overrides and output', () => {
    const next = applyModelPatch(page(), {
      label: 'T-shirt (ny)',
      'views.front.printArea': { x: 100, y: 120, w: 200, h: 266 },
      'printAreaMm.front': { w: 280, h: 370 },
      displacementScale: 44,
      displacementBlur: 3,
      displacementContrast: 2,
      blend: 'overlay',
      alpha: 0.6,
      perColorway: { vit: { alpha: 0.5 } },
      output: { w: 800, h: 1000 },
      updatedAt: SERVER_TIME,
    });
    const { body, problems } = modelBodyOf(next);
    assert.deepEqual(problems, []);
    assert.equal(body.label, 'T-shirt (ny)');
    assert.deepEqual(body.views.front.printArea, { x: 100, y: 120, w: 200, h: 266 });
    assert.deepEqual(body.views.front.printAreaMm, { w: 280, h: 370 });
    assert.deepEqual(body.perColorway, { vit: { alpha: 0.5 } });
    assert.deepEqual(body.output, { w: 800, h: 1000 });
    assert.equal(body.active, true); // the server's, untouched
    assert.equal(body.views.front.colorways.length, 2); // the server's, untouched
    assert.ok(body.views.back); // a view the editor does not show is kept
  });

  it('an unsafe or empty path segment throws', () => {
    assert.throws(() => applyModelPatch(page(), { '__proto__.x': 1 }));
    assert.throws(() => applyModelPatch(page(), { 'views..w': 1 }));
  });
});

describe('modelBodyOf: what the Worker would refuse is said before any request', () => {
  const page = () => pageModelOf(stored(), FILES);
  const problemsOf = (patch) => modelBodyOf(applyModelPatch(page(), patch)).problems;

  it('each refused value is a Swedish sentence', () => {
    assert.match(problemsOf({ label: 'x'.repeat(81) }).join(), /Namnet måste vara 1–80 tecken/);
    assert.match(problemsOf({ label: '   ' }).join(), /Namnet/);
    assert.match(problemsOf({ 'printAreaMm.front': { w: 2010, h: 400 } }).join(), /högst 200 × 200 cm/);
    assert.match(problemsOf({ 'printAreaMm.front': { w: -10, h: 400 } }).join(), /högst 200 × 200 cm/);
    assert.match(problemsOf({ 'views.front.printArea': { x: 1.5, y: 0, w: 10, h: 10 } }).join(), /hela pixlar/);
    assert.match(problemsOf({ output: { w: -5, h: 10 } }).join(), /Utdata/);
    assert.match(problemsOf({ output: { w: null, h: 10 } }).join(), /Utdata/);
    assert.match(problemsOf({ alpha: 1.5 }).join(), /opaciteten måste vara mellan 0 och 1/);
    assert.match(problemsOf({ perColorway: { vit: { alpha: 2 } } }).join(), /Färgvägen ”vit”: opaciteten/);
    assert.match(problemsOf({ blend: 'darken' }).join(), /blend-läget ”darken” finns inte/);
  });

  it('a colourway without its images on the server, a bad id, a long name, over 40', () => {
    assert.match(problemsOf({ 'views.front.colorways.ny': { label: 'Ny', photoUrl: url(1), displacementUrl: url(2) } }).join(),
      /”Ny” saknar sina bilder på servern/);
    const ok = { label: 'X', fileIds: { photo: F(1), displacement: F(2), mask: null } };
    assert.match(problemsOf({ ['views.front.colorways.' + 'a'.repeat(65)]: ok }).join(), /går inte att spara/);
    assert.match(problemsOf({ 'views.front.colorways.ny': { ...ok, label: 'n'.repeat(81) } }).join(), /1–80 tecken/);
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`views.front.colorways.c${i}`, ok]));
    assert.match(problemsOf(many).join(), /högst 40 färgvägar/);
  });

  it('empty tuning values are left out (the server keeps them unset), not refused', () => {
    const { body, problems } = modelBodyOf(applyModelPatch(page(), { perColorway: { vit: {} }, blend: '' }));
    assert.deepEqual(problems, []);
    assert.deepEqual(body.perColorway, {});
    assert.equal('blend' in body, false);
  });
});

describe('a new model', () => {
  it('newModelBody: an uncalibrated front view, 30 × 40 cm, the tuning defaults', () => {
    const { body, problems } = newModelBody('  Hoodie  ');
    assert.deepEqual(problems, []);
    assert.deepEqual(body, {
      label: 'Hoodie',
      active: true,
      alpha: 0.8,
      blend: 'multiply',
      displacementBlur: 6,
      displacementScale: 30,
      output: null,
      perColorway: {},
      views: { front: { w: null, h: null, printArea: { x: 0, y: 0, w: 0, h: 0 }, printAreaMm: { w: 300, h: 400 }, originalDims: null, colorways: [] } },
    });
    assert.match(newModelBody('').problems.join(), /Namnet/);
  });

  it('newModelId: 20 characters the Worker takes, from the bytes it is given, unbiased', () => {
    for (let i = 0; i < 50; i++) {
      const id = newModelId();
      assert.equal(id.length, 20);
      assert.match(id, MODEL_ID_PATTERN);
    }
    // 248 and over are skipped (62 × 4 = 248).
    let call = 0;
    const id = newModelId(() => (call++ === 0 ? new Uint8Array(32).fill(250) : new Uint8Array(32).fill(1)));
    assert.equal(id, 'B'.repeat(20));
  });
});

describe('sameModel: is the lost write stored?', () => {
  it('defaults and empty overrides do not count as a difference; a real one does', () => {
    const { body } = modelBodyOf(pageModelOf(stored(), FILES));
    const answer = { ...stored(), perColorway: { ...stored().perColorway, vit: {} } };
    assert.ok(sameModel(body, answer));
    assert.ok(!sameModel(body, { ...stored(), label: 'Annan' }));
    assert.ok(!sameModel(body, { ...stored(), active: false }));
    const moved = stored();
    moved.views.front.colorways.reverse();
    assert.ok(!sameModel(body, moved)); // the order is the position
    assert.ok(!sameModel(body, null));
  });
});

describe('what went wrong, in Swedish', () => {
  it('isLostAnswer: no answer, a gateway\'s, an unreadable one; not a refusal', () => {
    assert.ok(isLostAnswer({ status: 0, code: 'network_error' }));
    assert.ok(isLostAnswer({ status: 502, code: 'bad_gateway' }));
    assert.ok(isLostAnswer({ status: 200, code: 'bad_response' }));
    for (const e of [{ status: 400, code: 'invalid_request' }, { status: 404 }, { status: 401, code: 'unauthenticated' }, { status: 0, code: 'bad_request' }, null]) {
      assert.equal(isLostAnswer(e), false, JSON.stringify(e));
    }
  });

  it('a refused model write says the server\'s reason', () => {
    assert.match(modelRefusalMessage({ status: 400, reason: 'not_registered' }), /samma pixelmått/);
    assert.match(modelRefusalMessage({ status: 400, reason: 'file_not_found' }), /finns inte på servern/);
    assert.match(modelRefusalMessage({ status: 400, reason: 'duplicate_colorway' }), /samma id/);
    assert.match(modelRefusalMessage({ status: 400 }), /utanför det tillåtna/);
    assert.match(modelRefusalMessage({ status: 409, code: 'limit_reached' }), /redan 100 modeller/);
    assert.match(modelRefusalMessage({ status: 404 }), /hittar inte modellen/);
    assert.equal(modelRefusalMessage({ status: 401, code: 'unauthenticated', message: 'Sessionen har gått ut. Logga in igen.' }),
      'Sessionen har gått ut. Logga in igen.');
    for (const e of [{ status: 400 }, { status: 409, code: 'limit_reached' }, { status: 418 }]) {
      assert.doesNotMatch(modelRefusalMessage(e), /^Kunde inte/);
    }
  });

  it('a refused upload names the image and the reason', () => {
    assert.equal(uploadRefusalMessage('Plaggfotot', { status: 400, reason: 'not_an_allowed_image' }),
      'Plaggfotot togs inte emot: servern tar bara emot PNG, JPEG, WebP eller AVIF.');
    assert.match(uploadRefusalMessage('Masken', { status: 400, reason: 'type_not_as_stated' }), /^Masken .*filtyp/);
    assert.match(uploadRefusalMessage('Masken', { status: 413 }), /större än 15 MB/);
    assert.match(uploadRefusalMessage('Masken', { status: 404 }), /inte påslagen/);
  });

  it('derivativeSizeProblem: over 15 MiB is refused before any request; empty too', () => {
    assert.equal(derivativeSizeProblem('Plaggfotot', { size: STUDIO_FILE_MAX_BYTES }), null);
    assert.match(derivativeSizeProblem('Plaggfotot', { size: STUDIO_FILE_MAX_BYTES + 1 }), /^Plaggfotot är 15,1 MB efter nedskalningen; servern tar emot högst 15 MB/);
    assert.match(derivativeSizeProblem('Masken', { size: 0 }), /tom/);
  });
});
