// PlatformModels — the operator console's 3D-MODEL LIBRARY (slice 2 of the model
// library). Lists/creates/edits/deletes pod3dModels docs: platform-owned garment
// photos + displacement maps that feed the studio's 3D-vy (replaces the hardcoded
// DEV_3D_GARMENTS). Platform-only. PLATFORM DARK design (not admin-*).
//
// Reads the models DIRECTLY — never the cached loader — so platform edits are
// never stale; every successful write calls clearPod3dModelsCache() so an open
// studio tab reloads fresh. (docs/PLATFORM_ARCHITECTURE.md)
//
// DATA: every read and write goes through ./platformModelsData (Firebase in the
// older build; the admin build's alias list swaps in the API's version,
// src/admin-app/replacements/platformModelsData.js).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import PlatformLayout from '../../components/platform/PlatformLayout';
import ModelCardGrid from '../../components/platform/ModelCardGrid';
import ModelEditor from '../../components/platform/ModelEditor';
import { clearPod3dModelsCache } from '../../config/pod3dModels';
import {
  DELETE_MODEL,
  loadModels,
  readModelForEditor,
  setModelActive,
  deleteModel,
  createModel as createModelDoc,
  saveModelDoc,
} from './platformModelsData';
import toast from 'react-hot-toast';
import { XMarkIcon } from '@heroicons/react/24/outline';

const PlatformModels = () => {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null); // model being edited
  const [showCreate, setShowCreate] = useState(false);
  // Counts every opening (Redigera, Ny modell). A Redigera whose read answers
  // after another opening began opens nothing: its model must never land in an
  // editor (or over a create form) that the operator opened meanwhile.
  const opening = useRef(0);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const list = await loadModels();
      list.sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'sv'));
      setModels(list);
    } catch (e) {
      console.error('Error loading pod3dModels:', e);
      toast.error(e?.userMessage || 'Kunde inte ladda modeller');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleActive = async (model) => {
    const next = model.active === false;
    try {
      setBusyId(model.id);
      // The stored model when the build's write answers one (the admin build).
      const stored = await setModelActive(model, next);
      clearPod3dModelsCache();
      setModels((prev) => prev.map((m) => (m.id === model.id ? stored || { ...m, active: next } : m)));
      toast.success(next ? 'Modell aktiverad' : 'Modell inaktiverad');
    } catch (e) {
      console.error('Error toggling model:', e);
      toast.error(e?.userMessage || 'Kunde inte ändra status');
    } finally {
      setBusyId(null);
    }
  };

  const removeModel = async (model) => {
    if (!window.confirm(`Vill du ta bort "${model.label || model.id}"? Alla uppladdade filer raderas.`)) return;
    try {
      setBusyId(model.id);
      await deleteModel(model); // best-effort storage sweep (never throws), then the doc
      clearPod3dModelsCache();
      setModels((prev) => prev.filter((m) => m.id !== model.id));
      toast.success('Modell borttagen');
    } catch (e) {
      console.error('Error deleting model:', e);
      toast.error(e?.userMessage || 'Kunde inte ta bort modellen');
    } finally {
      setBusyId(null);
    }
  };

  const createModel = async (label) => {
    const newModel = await createModelDoc(label);
    clearPod3dModelsCache();
    setModels((prev) => [...prev, newModel].sort((a, b) =>
      String(a.label || '').localeCompare(String(b.label || ''), 'sv')));
    opening.current += 1;
    setShowCreate(false);
    setEditing(newModel); // open editor directly
  };

  // Redigera: the editor starts from the model as it is stored now, never
  // from the list's row as it was (the older build's list was read directly:
  // it answers the row). Nothing else opens while a card is busy.
  const openEditor = async (model) => {
    if (busyId) return;
    const mine = ++opening.current;
    try {
      setBusyId(model.id);
      const fresh = await readModelForEditor(model);
      setModels((prev) => prev.map((m) => (m.id === fresh.id ? fresh : m)));
      if (mine === opening.current) setEditing(fresh);
    } catch (e) {
      console.error('Error opening model:', e);
      toast.error(e?.userMessage || 'Kunde inte öppna modellen');
    } finally {
      setBusyId(null);
    }
  };

  // Every write of the editor: the card follows the stored model when the
  // build's write answers one (the admin build; the older one answers nothing).
  const saveFromEditor = async (modelId, data) => {
    const stored = await saveModelDoc(modelId, data);
    if (stored) setModels((prev) => prev.map((m) => (m.id === stored.id ? stored : m)));
    return stored;
  };

  return (
    <PlatformLayout>
      <div className="px-6 lg:px-10 py-8 max-w-6xl">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">3D-modeller</h1>
            <p className="text-gray-400 mt-1">
              Plaggfoton med displacement-kartor för 3D-vyn i designstudion. Delas av alla butiker.
            </p>
          </div>
          <button
            onClick={() => {
              opening.current += 1;
              setShowCreate(true);
            }}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Ny modell
          </button>
        </div>

        {loading ? (
          <div className="py-16 text-center text-gray-500">Laddar…</div>
        ) : (
          <ModelCardGrid
            models={models}
            busyId={busyId}
            onEdit={openEditor}
            onToggleActive={toggleActive}
            onDelete={DELETE_MODEL ? removeModel : undefined}
          />
        )}
      </div>

      {showCreate && (
        <CreateModelModal onClose={() => setShowCreate(false)} onCreate={createModel} />
      )}

      {editing && (
        <ModelEditor
          key={editing.id}
          model={editing}
          saveDoc={saveFromEditor}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load(); // re-read so the card reflects the saved edits
          }}
        />
      )}
    </PlatformLayout>
  );
};

// Small create-modal: label only → a new model with defaults → open editor.
const CreateModelModal = ({ onClose, onCreate }) => {
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!label.trim()) return setError('Ange ett namn på modellen.');
    try {
      setSaving(true);
      await onCreate(label);
    } catch (err) {
      console.error('Create model failed:', err);
      setError(err?.userMessage || 'Kunde inte skapa modellen (behörighet?). Försök igen.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-gray-900 border border-white/10 p-6 text-gray-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">Ny modell</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Namn</label>
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="t.ex. T-shirt på modell"
              className="w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200">
              Avbryt
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? 'Skapar…' : 'Skapa modell'}
            </button>
          </div>
        </form>
        <p className="mt-4 text-xs text-gray-600">
          Ladda upp plaggfoto, displacement-karta och kalibrera tryckytan i nästa steg.
        </p>
      </div>
    </div>
  );
};

export default PlatformModels;
