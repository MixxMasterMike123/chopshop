// TemplateBackground.jsx — the background layer of the Design Studio compositor.
//
// A template is EITHER a FLAT (has `garment`: an SVG flat from GARMENT_FLATS, drawn
// in the colourway's hex) OR a PHOTO (has `photo`: a real blank-garment photo per
// colourway id). The artwork compositing stays code-driven (canvas) — only this
// background layer differs. Placements are stored in physical mm; the template's
// px↔mm mapping (printAreas px + printAreaMm) lives ENTIRELY in placementMath, so a
// photo template only changes the COORDINATE SPACE (photo.w/h instead of the SVG
// viewBox) and the background rendering — nothing in placementMath moves.
//
// PHOTO TEMPLATE shape (see podMockupTemplates.js SHAPE comment):
//   { id, label, profileId, photo: { w, h, urls: { [colorwayId]: url },
//     backUrls?: { [colorwayId]: url } }, colorways,
//     printAreas (px IN PHOTO COORDS), printAreaMm }
// backUrls (2026-08-10, B&C packshots have real back photos): the BACK view's
// photo per colourway. Optional — a colourway without one falls back to its
// front photo (the pre-backUrls behavior). Front and back photos MUST share
// the same pixel dimensions (photo.w/h is the single coordinate space that
// printAreas for ALL slots live in).
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GARMENT_FLATS, GARMENT_VIEWBOX } from './garments';

// SLOT → VIEW: the back slot renders on the garment's back-view flat; every other
// slot (front/pocket/sleeves) is visible on the front view. A garment without a
// back flat falls back to front (v1 behavior for photo templates too — one photo
// set per colourway, no per-view photos yet).
export const viewForSlot = (slot) => (slot === 'back' ? 'back' : 'front');

/** Resolve the flat COMPONENT for a garment + slot. GARMENT_FLATS values are
 *  view maps ({ front, back? }); missing back view → front. Null when unknown. */
export const flatForSlot = (garment, slot) => {
  const views = GARMENT_FLATS[garment];
  if (!views) return null;
  return views[viewForSlot(slot)] || views.front || null;
};

/** True for a PHOTO template (real garment-photo background per colourway) vs a
 *  FLAT template (SVG flat). Defined HERE, not in config/podMockupTemplates — that
 *  module imports firebase/config, and the studio render pipeline (this file,
 *  mockupRender, the dev harness) must stay Firebase-free. */
export const isPhotoTemplate = (t) =>
  Boolean(t && t.photo && t.photo.w > 0 && t.photo.h > 0);

/** The template's own coordinate space { w, h } — the space printAreas px are in:
 *  photo.w/h for a photo template, else the garment flat's SVG viewBox. Null when
 *  neither resolves (unknown garment / malformed template) → callers guard on it. */
export const templateViewBox = (template) => {
  if (!template) return null;
  if (isPhotoTemplate(template)) {
    const { w, h } = template.photo;
    return w > 0 && h > 0 ? { w, h } : null;
  }
  return GARMENT_VIEWBOX[template.garment] || null;
};

/** The blank-garment photo url for a colourway on a PHOTO template, or null when
 *  that colourway has no photo yet. Not used for flat templates. The BACK view
 *  (slot 'back') uses photo.backUrls when present, else falls back to the front
 *  photo (pre-backUrls behavior — a back design still gets SOME backdrop). */
export const backgroundUrl = (template, colorway, slot = 'front') => {
  if (!isPhotoTemplate(template) || !colorway) return null;
  const front = template.photo.urls?.[colorway.id] || null;
  if (viewForSlot(slot) === 'back') {
    return template.photo.backUrls?.[colorway.id] || front;
  }
  return front;
};

// SVG flat → data URL for canvas rasterization. Explicit width/height attrs are
// REQUIRED — Safari rasterizes a dimensionless SVG image at 0×0. Moved here from
// mockupRender.js so both the DOM preview and the exporter share one definition.
const flatToDataUrl = (garment, slot, hex, widthPx, heightPx) => {
  const Flat = flatForSlot(garment, slot);
  if (!Flat) throw new Error(`Okänt plagg: ${garment}`);
  const markup = renderToStaticMarkup(
    React.createElement(Flat, { color: hex, width: widthPx, height: heightPx })
  );
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
};

/**
 * backgroundImageSource(template, colorway, { widthPx, heightPx, slot }) → Promise<string>
 * The src the canvas exporter draws as the background layer:
 *   • photo template → the colourway's photo url (REJECTS in Swedish if missing —
 *     the exporter can't fabricate a backdrop for an un-photographed colourway),
 *   • flat template  → the SVG flat FOR THE SLOT'S VIEW (back slot → back flat)
 *     as a data URL at the target px dimensions.
 */
export const backgroundImageSource = (template, colorway, { widthPx, heightPx, slot = 'front' } = {}) => {
  if (isPhotoTemplate(template)) {
    const url = backgroundUrl(template, colorway, slot);
    return url
      ? Promise.resolve(url)
      : Promise.reject(new Error(`Foto saknas för färgen ${colorway?.label || colorway?.id || ''} — ladda upp ett plaggfoto för den färgen.`));
  }
  try {
    return Promise.resolve(flatToDataUrl(template.garment, slot, colorway?.hex || '#ffffff', widthPx, heightPx));
  } catch (e) {
    return Promise.reject(e);
  }
};

/**
 * <TemplateBackground template colorway className> — the background element for the
 * DOM preview. Fills its container width and preserves the template's aspect ratio
 * in BOTH branches (the artwork/print-area overlays position by percentage against
 * this box, so its box must match how the SVG flat currently sizes).
 *   • photo template → <img> of the colourway's photo, or a neutral "Foto saknas"
 *     placeholder (same aspect ratio via CSS aspect-ratio) when that colourway has
 *     no photo — the seller can still place artwork; only the backdrop is missing.
 *   • flat template  → the existing <Flat color={hex}>.
 */
const TemplateBackground = ({ template, colorway, slot = 'front', className = '' }) => {
  const vb = templateViewBox(template);

  if (isPhotoTemplate(template)) {
    const url = backgroundUrl(template, colorway, slot);
    if (url) {
      return (
        <img
          src={url}
          alt=""
          draggable={false}
          className={`block h-auto w-full ${className}`}
        />
      );
    }
    return (
      <div
        className={`grid w-full place-items-center bg-admin-surface-2 text-[11px] text-admin-text-muted ${className}`}
        style={vb ? { aspectRatio: `${vb.w} / ${vb.h}` } : undefined}
      >
        Foto saknas
      </div>
    );
  }

  const Flat = template ? flatForSlot(template.garment, slot) : null;
  if (!Flat) return <div className={`h-full w-full bg-admin-surface-2 ${className}`} />;
  return <Flat color={colorway?.hex || '#ffffff'} className={`block h-auto w-full ${className}`} />;
};

export default TemplateBackground;
