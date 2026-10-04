// ModelCardGrid — presentational card grid for the platform 3D-model library
// (PlatformModels). Takes plain props + callbacks so the render harness can mount
// it WITHOUT Firebase. All data/handlers live in PlatformModels.jsx.
//
// PLATFORM DARK styling only (bg-gray-900 panels, border-white/10, indigo accents).
import React from 'react';
import { CubeIcon } from '@heroicons/react/24/outline';

// First colorway's photo (front view) for the card thumbnail, or null.
const firstPhotoUrl = (model) => {
  const colorways = model?.views?.front?.colorways || {};
  const first = Object.values(colorways)[0];
  return first?.photoUrl || null;
};

const colorwayCount = (model) =>
  Object.keys(model?.views?.front?.colorways || {}).length;

const ModelCard = ({ model, onEdit, onToggleActive, onDelete, busy }) => {
  const photo = firstPhotoUrl(model);
  const cwN = colorwayCount(model);
  const active = model.active !== false;
  const mm = model.printAreaMm?.front || {};
  const dimsCm =
    mm.w && mm.h ? `${(mm.w / 10).toLocaleString('sv')}×${(mm.h / 10).toLocaleString('sv')} cm` : null;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-white/10 bg-gray-900">
      <button
        type="button"
        onClick={() => onEdit(model)}
        className="relative block aspect-[4/5] w-full overflow-hidden bg-gray-800 text-left"
        title="Redigera modell"
      >
        {photo ? (
          <img src={photo} alt={model.label || ''} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <CubeIcon className="h-10 w-10 text-gray-700" />
          </div>
        )}
        <span
          className={
            'absolute right-2 top-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
            (active ? 'bg-green-500/15 text-green-300' : 'bg-gray-500/15 text-gray-300')
          }
        >
          {active ? 'Aktiv' : 'Inaktiv'}
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="font-medium text-white">{model.label || model.id}</div>
        <div className="text-xs text-gray-500">
          {cwN} {cwN === 1 ? 'färgväg' : 'färgvägar'}
          {dimsCm ? ` · tryckyta ${dimsCm}` : ''}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onEdit(model)}
            className="rounded-lg bg-white/5 px-3 py-1 text-xs font-medium text-gray-200 hover:bg-white/10"
          >
            Redigera
          </button>
          <button
            type="button"
            onClick={() => onToggleActive(model)}
            disabled={busy}
            className="rounded-lg bg-white/5 px-3 py-1 text-xs font-medium text-gray-300 hover:bg-white/10 disabled:opacity-50"
          >
            {busy ? '…' : active ? 'Inaktivera' : 'Aktivera'}
          </button>
          {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(model)}
            disabled={busy}
            className="ml-auto rounded-lg bg-white/5 px-3 py-1 text-xs font-medium text-gray-400 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50"
          >
            Ta bort
          </button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * ModelCardGrid — { models, onEdit, onToggleActive, onDelete, busyId }
 * Renders the empty state when models is empty. Without onDelete (a build
 * that deletes no model) the card has no "Ta bort".
 */
const ModelCardGrid = ({ models, onEdit, onToggleActive, onDelete, busyId }) => {
  if (!models || models.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-gray-900 py-16 text-center text-gray-500">
        <CubeIcon className="mx-auto mb-3 h-10 w-10 text-gray-700" />
        <p className="text-gray-400">Inga modeller ännu.</p>
        <p className="mt-1 text-xs text-gray-600">
          Skapa din första modell med ett plaggfoto och en displacement-karta.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {models.map((model) => (
        <ModelCard
          key={model.id}
          model={model}
          onEdit={onEdit}
          onToggleActive={onToggleActive}
          onDelete={onDelete}
          busy={busyId === model.id}
        />
      ))}
    </div>
  );
};

export default ModelCardGrid;
