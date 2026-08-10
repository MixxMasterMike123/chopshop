// platformModelsHarness.jsx — DEV-ONLY harness for eyeballing the platform
// 3D-model library UI (PlatformModels' ModelCardGrid + ModelEditor) WITHOUT
// Firebase/auth. UNTRACKED: delete together with /platform-models-harness.html.
//
// The presentational pieces take plain props + injectable handlers, so this
// mounts them with fixture data and stubs. The editor's uploadAssets/saveDoc/
// deleteColorway are stubbed (uploadAssets resolves after 800ms with fixture URLs)
// so the upload flow + save are exercisable with no backend.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import toast, { Toaster } from 'react-hot-toast';
import '../index.css';
import ModelCardGrid from '../components/platform/ModelCardGrid';
import ModelEditor from '../components/platform/ModelEditor';

const PHOTO = '/dev-3d/photo-1600.jpg';

// Fixture models: one populated + active, one populated + inactive, one empty.
const FIXTURE_FULL = {
  id: 'tee_model_white',
  label: 'T-shirt på modell',
  scope: 'platform',
  active: true,
  views: {
    front: {
      w: 1600,
      h: 1936,
      originalDims: { w: 3200, h: 3871 },
      printArea: { x: 548, y: 875, w: 525, h: 700 },
      colorways: {
        white: { label: 'Vit', photoUrl: PHOTO, displacementUrl: PHOTO },
        black: { label: 'Svart', photoUrl: PHOTO, displacementUrl: PHOTO },
      },
    },
  },
  printAreaMm: { front: { w: 300, h: 400 } },
  displacementScale: 30,
  displacementBlur: 6,
  blend: 'screen',
  alpha: 0.8,
  perColorway: { black: { blend: 'screen', alpha: 0.9 } },
  output: { w: 1600, h: 1936 },
};

const FIXTURE_INACTIVE = {
  id: 'hoodie_model',
  label: 'Hoodie på modell',
  scope: 'platform',
  active: false,
  views: {
    front: {
      w: 1600,
      h: 1936,
      originalDims: { w: 3200, h: 3871 },
      printArea: { x: 500, y: 800, w: 500, h: 650 },
      colorways: { grey: { label: 'Grå', photoUrl: PHOTO, displacementUrl: PHOTO } },
    },
  },
  printAreaMm: { front: { w: 280, h: 360 } },
  displacementScale: 35,
  displacementBlur: 6,
  blend: 'multiply',
  alpha: 0.85,
  perColorway: {},
  output: { w: 1600, h: 1936 },
};

const FIXTURE_EMPTY = {
  id: 'new_model_empty',
  label: 'Ny modell (tom)',
  scope: 'platform',
  active: true,
  views: { front: { w: null, h: null, printArea: { x: 0, y: 0, w: 0, h: 0 }, colorways: {} } },
  printAreaMm: { front: { w: 300, h: 400 } },
  displacementScale: 30,
  displacementBlur: 6,
  blend: 'screen',
  alpha: 0.8,
  perColorway: {},
  output: null,
};

// Stubbed uploadAssets: resolves after 800ms with fixture URLs + fixture dims.
// ?weakmap=1 → return a LOW mapContrastSd (the measured weak-map value, 18) so the
// persistent low-contrast warning row is eyeball-testable; otherwise a good value.
const stubUpload = async ({ maskFile }) => {
  await new Promise((r) => setTimeout(r, 800));
  const weak = new URLSearchParams(window.location.search).get('weakmap') === '1';
  const out = {
    photoUrl: PHOTO,
    displacementUrl: PHOTO,
    originalPaths: { photo: 'stub/photo', displacement: 'stub/map' },
    derivative: { w: 1600, h: 1936 },
    original: { w: 3200, h: 3871 },
    mapContrastSd: weak ? 18 : 52, // measured: weak≈18, good≈52
  };
  if (maskFile) out.maskUrl = PHOTO;
  return out;
};

const stubSaveDoc = async (id, data) => {
  console.log('harness: saveDoc', id, data);
  await new Promise((r) => setTimeout(r, 150));
};
const stubDeleteColorway = async (id, view, cw) => {
  console.log('harness: deleteColorway', id, view, cw);
  await new Promise((r) => setTimeout(r, 150));
};

const Harness = () => {
  const models = [FIXTURE_FULL, FIXTURE_INACTIVE, FIXTURE_EMPTY];
  // ?editor=1 auto-opens the editor on the full fixture (for the screenshot pass).
  const params = new URLSearchParams(window.location.search);
  const autoEditor = params.get('editor') === '1';
  // ?px=X,Y,W,H seeds a non-default print-area rect on the full fixture, to prove
  // the overlay rectangle tracks the px inputs (slice2-overlay.png).
  const pxParam = params.get('px');
  const fullFixture = React.useMemo(() => {
    if (!pxParam) return FIXTURE_FULL;
    const [x, y, w, h] = pxParam.split(',').map((n) => parseInt(n, 10) || 0);
    return {
      ...FIXTURE_FULL,
      views: { ...FIXTURE_FULL.views, front: { ...FIXTURE_FULL.views.front, printArea: { x, y, w, h } } },
    };
  }, [pxParam]);
  const [editing, setEditing] = useState(autoEditor ? fullFixture : null);

  // ?upload=1 drives the add-colorway flow once (synthetic files) to exercise the
  // stubbed upload → new-row → toast path headlessly.
  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get('upload') !== '1') return;
    const t = setTimeout(() => {
      const setNative = (el, value) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const labelInput = [...document.querySelectorAll('input')].find(
        (i) => i.placeholder === 't.ex. Vit'
      );
      const fileInputs = [...document.querySelectorAll('input[type="file"]')];
      if (!labelInput || fileInputs.length < 2) return;
      setNative(labelInput, 'Marinblå');
      const mk = (name) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' }));
        return dt.files;
      };
      Object.defineProperty(fileInputs[0], 'files', { value: mk('photo.png'), configurable: true });
      fileInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      Object.defineProperty(fileInputs[1], 'files', { value: mk('map.png'), configurable: true });
      fileInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      const addBtn = [...document.querySelectorAll('button')].find((b) => /Lägg till färgväg/.test(b.textContent));
      setTimeout(() => addBtn?.click(), 200);
    }, 1000);
    return () => clearTimeout(t);
  }, []);

  // ?scroll=cal auto-scrolls the open editor to the calibration section so a
  // headless screenshot can capture the live overlay rectangle.
  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get('scroll') !== 'cal') return;
    const t = setTimeout(() => {
      const imgWrap = document.querySelector('[style*="max-h"], .max-h-\\[420px\\]');
      const heading = [...document.querySelectorAll('h3')].find((h) => /Tryckyta/.test(h.textContent));
      (heading || imgWrap)?.scrollIntoView({ block: 'start' });
    }, 900);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <Toaster position="top-right" />
      <div className="px-6 lg:px-10 py-8 max-w-6xl">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">3D-modeller</h1>
            <p className="text-gray-400 mt-1">
              Plaggfoton med displacement-kartor för 3D-vyn i designstudion. Delas av alla butiker.
            </p>
          </div>
          <button
            onClick={() => setEditing(FIXTURE_EMPTY)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Ny modell
          </button>
        </div>

        <ModelCardGrid
          models={models}
          busyId={null}
          onEdit={(m) => setEditing(m)}
          onToggleActive={(m) => toast.success(`toggle ${m.id}`)}
          onDelete={(m) => toast(`delete ${m.id}`)}
        />
      </div>

      {editing && (
        <ModelEditor
          model={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.success('onSaved()');
            setEditing(null);
          }}
          uploadAssets={stubUpload}
          saveDoc={stubSaveDoc}
          deleteColorway={stubDeleteColorway}
        />
      )}
    </div>
  );
};

createRoot(document.getElementById('root')).render(
  <MemoryRouter>
    <Harness />
  </MemoryRouter>
);
