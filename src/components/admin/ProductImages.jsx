// Product images — ONE list, no separate "huvudbild" concept.
//
// Built for a seller who has never run a shop and will not read help text.
// The whole model is one sentence: "the first image is the one the shop
// shows". So the rail is a single grid where the first tile is bigger and
// labelled Huvudbild, dragging any image to the front makes it the huvudbild,
// there is exactly one "+" tile to add more, and the variant editor reuses the
// same thumbnails as tap-to-select toggles instead of growing a third upload
// widget of its own.
//
// Storage is unchanged: ProductForm still persists b2cImageUrl (= first) +
// b2cImageGallery (= the rest) + per-variant `images`. These components only
// present that state as one ordered list; ProductForm translates drags/removes
// back into the underlying pieces (see the "unified images" block there).
//
// Admin-Neutral tokens throughout (admin-* / --radius-admin-el).
import React from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const helpCls = 'text-[12px] text-admin-text-muted';
const removeBtnCls =
  'absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-admin-border bg-admin-surface text-[14px] leading-none text-admin-text shadow-sm hover:bg-admin-surface-2';

const validateFiles = (files, maxBytes, onError) => {
  const ok = [];
  for (const f of files) {
    if (f.size > maxBytes) onError(`${f.name} är för stor. Max ${Math.round(maxBytes / (1024 * 1024))}MB`);
    else ok.push(f);
  }
  return ok;
};

// One draggable tile. The first (isMain) spans 2×2 so the huvudbild is
// unmistakable without reading the badge.
const Tile = ({ id, url, isMain, pending, onRemove }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative ${isMain ? 'col-span-2 row-span-2' : ''} ${isDragging ? 'z-10 opacity-70' : ''}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        title="Dra för att ändra ordning"
        className={`block aspect-square w-full cursor-grab touch-none overflow-hidden rounded-[var(--radius-admin-el)] border bg-white active:cursor-grabbing ${
          isMain ? 'border-admin-text' : 'border-admin-border'
        }`}
      >
        <img src={url} alt="" draggable={false} loading="lazy" decoding="async" className="h-full w-full object-contain" />
      </button>
      {isMain && (
        <span className="pointer-events-none absolute left-2 top-2 rounded-[var(--radius-admin-el)] bg-admin-text px-2 py-0.5 text-[11px] font-semibold text-admin-surface">
          Huvudbild
        </span>
      )}
      {pending && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-[var(--radius-admin-el)] bg-admin-info-bg px-1.5 py-0.5 text-[10px] font-medium text-admin-info-text">
          Ny
        </span>
      )}
      <button type="button" onClick={() => onRemove(id)} aria-label="Ta bort bild" title="Ta bort bild" className={removeBtnCls}>
        ×
      </button>
    </div>
  );
};

// The single "+" tile: click to pick files, or drop files on it. When the
// product has no images yet it takes the huvudbild's 2×2 slot so the empty
// state already shows where the picture goes.
const AddTile = ({ onAdd, big, compact, maxBytes, onError, multiple = true, label = 'Lägg till bilder' }) => {
  const [over, setOver] = React.useState(false);
  const take = (list) => {
    const ok = validateFiles(Array.from(list || []), maxBytes, onError);
    if (ok.length) onAdd(ok);
  };
  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius-admin-el)] border-2 border-dashed text-admin-text-muted transition hover:bg-admin-surface-2 hover:text-admin-text ${
        compact ? 'h-16 w-16 shrink-0' : 'aspect-square'
      } ${big ? 'col-span-2 row-span-2' : ''} ${over ? 'border-admin-text bg-admin-surface-2 text-admin-text' : 'border-admin-border'}`}
    >
      <span className={big ? 'text-[32px] leading-none' : compact ? 'text-[18px] leading-none' : 'text-[22px] leading-none'} aria-hidden="true">+</span>
      <span className={`px-1 text-center font-medium leading-tight ${compact ? 'text-[10px]' : 'text-[11px]'}`}>{label}</span>
      <input
        type="file"
        accept="image/*"
        multiple={multiple}
        className="sr-only"
        onChange={(e) => { take(e.target.files); e.target.value = ''; }}
      />
    </label>
  );
};

/**
 * ProductImageRail — the Media card body.
 * @param images   [{ id, url, pending? }] in display order; index 0 is the huvudbild
 * @param onReorder(list)  full list in new order
 * @param onRemove(id)
 * @param onAdd(files)     validated File[]
 */
export const ProductImageRail = ({ images, onReorder, onRemove, onAdd, maxBytes, onError }) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = images.findIndex((i) => i.id === active.id);
    const to = images.findIndex((i) => i.id === over.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(images, from, to));
  };
  const empty = images.length === 0;
  return (
    <div className="space-y-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={images.map((i) => i.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {images.map((img, i) => (
              <Tile key={img.id} id={img.id} url={img.url} pending={img.pending} isMain={i === 0} onRemove={onRemove} />
            ))}
            <AddTile onAdd={onAdd} big={empty} maxBytes={maxBytes} onError={onError} />
          </div>
        </SortableContext>
      </DndContext>
      <p className={helpCls}>
        {empty
          ? 'Lägg till bilder. Den första blir huvudbilden som visas i butiken.'
          : 'Dra för att ändra ordning. Den första bilden är huvudbilden som visas i butiken.'}
      </p>
    </div>
  );
};

/**
 * VariantImagePicker — inside a variant: the product's images as tap-to-select
 * toggles (numbered in the order picked; nr 1 is what the shop shows for the
 * variant), plus the variant's own not-yet-saved uploads, plus one "+" tile.
 * @param choices   product image URLs (saved ones only — new files have no URL yet)
 * @param selected  the variant's images: [{ url } | { file, preview }]
 */
export const VariantImagePicker = ({ choices, selected, onPick, onMakeFirst, onRemoveAt, onAddFiles, maxBytes, onError }) => {
  const orderOf = (url) => selected.findIndex((im) => im.url === url);
  const numCls =
    'pointer-events-none absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-admin-text px-1 text-[11px] font-semibold text-admin-surface';
  const tileCls = (on) =>
    `relative h-16 w-16 shrink-0 overflow-hidden rounded-[var(--radius-admin-el)] border-2 bg-white transition ${
      on ? 'border-admin-text' : 'border-admin-border opacity-50 hover:opacity-100'
    }`;
  // Everything the variant HAS but the product list doesn't show (an older
  // per-variant upload, an unsaved file) must still be visible and removable.
  const extras = selected
    .map((im, i) => ({ im, i }))
    .filter(({ im }) => im.file || (im.url && !choices.includes(im.url)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {choices.map((url) => {
          const n = orderOf(url);
          const on = n >= 0;
          return (
            <div key={url} className="relative">
              <button
                type="button"
                onClick={() => (on ? onMakeFirst(n) : onPick(url))}
                aria-pressed={on}
                title={on ? (n === 0 ? 'Nr 1 — visas i butiken' : 'Klicka för att göra till nr 1') : 'Klicka för att använda på varianten'}
                className={tileCls(on)}
              >
                <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" />
                {on && <span className={numCls}>{n + 1}</span>}
              </button>
              {on && (
                <button type="button" onClick={() => onRemoveAt(n)} aria-label="Ta bort från varianten" title="Ta bort från varianten" className={removeBtnCls}>
                  ×
                </button>
              )}
            </div>
          );
        })}
        {extras.map(({ im, i }) => (
          <div key={`x-${i}`} className="relative">
            <button
              type="button"
              onClick={() => onMakeFirst(i)}
              title={i === 0 ? 'Nr 1 — visas i butiken' : 'Klicka för att göra till nr 1'}
              className={tileCls(true)}
            >
              <img src={im.preview || im.url} alt="" className="h-full w-full object-contain" />
              <span className={numCls}>{i + 1}</span>
              {im.file && (
                <span className="pointer-events-none absolute bottom-1 left-1 rounded-[var(--radius-admin-el)] bg-admin-info-bg px-1 py-0.5 text-[9px] font-medium text-admin-info-text">Ny</span>
              )}
            </button>
            <button type="button" onClick={() => onRemoveAt(i)} aria-label="Ta bort från varianten" title="Ta bort från varianten" className={removeBtnCls}>
              ×
            </button>
          </div>
        ))}
        <AddTile compact onAdd={onAddFiles} maxBytes={maxBytes} onError={onError} label="Ny bild" />
      </div>
      <p className={helpCls}>
        Klicka på en bild för att använda den. Klicka igen för att göra den till nr 1 — den visas i butiken. × tar bort.
      </p>
    </div>
  );
};
