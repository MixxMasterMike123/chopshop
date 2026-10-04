// The design studio's media in the ADMIN build (CP5 unit FN2): which image
// rows a design's mockups become on a product, and the 3D models as the
// studio reads them. PURE: no I/O, no React, no browser API; tested under
// Node (studioMedia.test.mjs).
//
// THE PRODUCT'S IMAGES are ONE ordered list (PUT /v1/admin/products/:id/images,
// ≤ 30 rows): the rows without a variant first (the first is the main image),
// then each colour's rows, each naming the colour's FIRST variant (the group
// rule shows them on every size of that colour). A row is unique per (variant,
// object). The studio's layout, the older studio's order kept:
//   - the product's own rows: the hero mockup first, then every other mockup
//     of the published colours, in the mockups' order (colour × printed side);
//   - each colour's rows: its front mockup (else its first printed side: a
//     design printed on the back only shows the back first), then its back
//     (mockupVariantImages.js orderedVariantMockupUrls, the older function).
//     Pocket and sleeve mockups stay in the product's own rows only.
//
// WHICH ROWS ARE THE STUDIO'S: a row whose `alt` is the studio's text for one
// of the colours this run publishes and a printed side ("Svart – baksida",
// mockupAlt). The studio is the only writer of an alt text in this build (the
// product form writes none; the import writes none). Everything else is the
// seller's and is kept, in its order. A row the studio wrote whose alt was
// later cleared (the product form re-saves the list without alt texts) is no
// longer recognised: it is then kept as the seller's, never removed.
//
// On an EXISTING product (the older studio's "fill, replace only on opt-in"):
//   - the studio's rows of the published colours are replaced by this run's;
//   - the main image becomes the hero only when the product has none, when
//     the main image was the studio's, or when the seller ticks "Ersätt även
//     befintlig huvudbild/variantbilder"; the old main image is then kept as
//     the next image (never dropped);
//   - a colour whose rows are all the seller's keeps them as they are, unless
//     the seller ticked the box: then the studio's come first and the
//     seller's follow;
//   - a published colour with no variant of that name gets its mockups in the
//     product's own rows only (as the older studio did).

import { orderedVariantMockupUrls } from '../../wagons/pod-wagon/studio/mockupVariantImages.js';

/** The server's cap on a product's image list. */
export const IMAGE_ROWS_MAX = 30;

/** The printed side, as the alt text names it. */
export const SIDE_WORDS = Object.freeze({
  front: 'framsida',
  back: 'baksida',
  pocket: 'bröstficka',
  left_sleeve: 'vänster ärm',
  right_sleeve: 'höger ärm',
  other: 'övrigt tryck',
});

/** The alt text of the studio's mockup of a colour's printed side (also its mark). */
export function mockupAlt(colourLabel, slot) {
  return `${String(colourLabel ?? '').trim()} – ${SIDE_WORDS[slot] ?? slot}`;
}

/** Every alt text the studio may have written for a colour (any side). */
function altsOfColour(label) {
  return new Set(Object.keys(SIDE_WORDS).map((slot) => mockupAlt(label, slot)));
}

const rowKey = (row) => `${row.variantId ?? ''}\n${row.objectId}`;

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row?.objectId || seen.has(rowKey(row))) continue;
    seen.add(rowKey(row));
    out.push({ objectId: row.objectId, variantId: row.variantId ?? null, alt: row.alt ?? null });
  }
  return out;
}

/**
 * The colours this run publishes that have no mockup at all, and the printed
 * sides missing for the others. `mockups` [{ colorwayId, slot }], `colours`
 * [{ id, label }], `slots` the designed slots.
 * → { colourless: [label], missingSides: [{ label, slot }] }
 */
export function mockupCoverage({ mockups, colours, slots }) {
  const colourless = [];
  const missingSides = [];
  for (const c of colours) {
    const own = mockups.filter((m) => m.colorwayId === c.id);
    if (own.length === 0) {
      colourless.push(c.label);
      continue;
    }
    for (const slot of slots) if (!own.some((m) => m.slot === slot)) missingSides.push({ label: c.label, slot });
  }
  return { colourless, missingSides };
}

/**
 * The image list after this run.
 *
 * input:
 *   rows           the server's rows now [{ objectId, variantId, alt }], in order
 *   colours        the published colours [{ id, label, variantIds }] (variantIds:
 *                  the colour's variants on the product, the first first; [] when
 *                  the product has no variant of that colour)
 *   mockups        the published colours' mockups [{ key, colorwayId, slot, objectId }],
 *                  in the studio's order
 *   heroKey        the mockup the seller picked as the main image (else the first)
 *   replaceImages  the seller's "Ersätt även befintlig huvudbild/variantbilder"
 *   fresh          a product the studio creates (or the draft it continues):
 *                  its rows are arranged as the studio's
 *
 * → { list, compacted, galleryOnly: [label], keptSeller: [label] }
 *   | { error: 'too_many', count }
 *   compacted   over the cap: the product's own rows hold only the hero (each
 *               colour's mockups stay on the colour)
 *   galleryOnly published colours without a variant of their name
 *   keptSeller  colours whose own (seller's) images were left in place
 */
export function planStudioImages({ rows = [], colours = [], mockups = [], heroKey = null, replaceImages = false, fresh = false }) {
  const labelOf = new Map(colours.map((c) => [c.id, c.label]));
  const published = mockups.filter((m) => labelOf.has(m.colorwayId) && m.objectId);
  const studioRow = (m, variantId = null) => ({ objectId: m.objectId, variantId, alt: mockupAlt(labelOf.get(m.colorwayId), m.slot) });
  const studioAlts = new Set(colours.flatMap((c) => [...altsOfColour(c.label)]));
  const isStudio = (row) => row.alt != null && studioAlts.has(row.alt);

  // The product's own rows.
  const ownOld = rows.filter((r) => r.variantId == null);
  const keptOwn = ownOld.filter((r) => !isStudio(r));
  const hero = published.find((m) => m.key === heroKey) ?? published[0] ?? null;
  const studioOwn = hero ? [hero, ...published.filter((m) => m !== hero)].map((m) => studioRow(m)) : [];
  const takeMain = fresh || replaceImages || ownOld.length === 0 || keptOwn.length === 0 || isStudio(ownOld[0]);

  // Each colour's rows.
  const colourOfVariant = new Map();
  for (const c of colours) for (const v of c.variantIds ?? []) colourOfVariant.set(v, c);
  const variantOld = rows.filter((r) => r.variantId != null);
  const blocks = new Map(); // colour id → its rows after this run
  const keptSeller = [];
  const galleryOnly = [];
  for (const c of colours) {
    const firstVariant = c.variantIds?.[0] ?? null;
    if (!firstVariant) {
      if (published.some((m) => m.colorwayId === c.id)) galleryOnly.push(c.label);
      continue;
    }
    const old = variantOld.filter((r) => colourOfVariant.get(r.variantId) === c);
    const seller = old.filter((r) => !isStudio(r));
    const hadStudio = old.length > seller.length;
    const own = published.filter((m) => m.colorwayId === c.id);
    const ordered = orderedVariantMockupUrls({ colorwayId: c.id, mockups: own, urls: own.map((m) => m.objectId) });
    const studio = ordered.map((objectId) => studioRow(own.find((m) => m.objectId === objectId), firstVariant));
    if (studio.length === 0) {
      blocks.set(c.id, seller);
    } else if (fresh || replaceImages || seller.length === 0 || hadStudio) {
      blocks.set(c.id, [...studio, ...seller]);
    } else {
      blocks.set(c.id, seller);
      keptSeller.push(c.label);
    }
  }

  const variantRows = [];
  const emitted = new Set();
  for (const row of variantOld) {
    const c = colourOfVariant.get(row.variantId);
    if (!c || !blocks.has(c.id)) {
      variantRows.push(row);
      continue;
    }
    if (emitted.has(c.id)) continue;
    emitted.add(c.id);
    variantRows.push(...blocks.get(c.id));
  }
  for (const c of colours) if (blocks.has(c.id) && !emitted.has(c.id)) variantRows.push(...blocks.get(c.id));

  const assemble = (studioOwnRows) => dedupe([
    ...(takeMain ? [...studioOwnRows.slice(0, 1), ...keptOwn, ...studioOwnRows.slice(1)] : [...keptOwn, ...studioOwnRows]),
    ...variantRows,
  ]);
  let list = assemble(studioOwn);
  let compacted = false;
  if (list.length > IMAGE_ROWS_MAX) {
    // Over the cap: the product's own rows keep only the hero and any mockup
    // that is on no colour (its only place); each colour keeps its own.
    const onAColour = new Set(variantRows.map((r) => r.objectId));
    list = assemble(studioOwn.filter((r, i) => (takeMain && i === 0) || !onAColour.has(r.objectId)));
    compacted = true;
  }
  if (list.length > IMAGE_ROWS_MAX) return { error: 'too_many', count: list.length };
  return { list, compacted, galleryOnly, keptSeller };
}

/** True when two lists hold the same rows (object, variant, alt) in the same order. */
export function sameStudioList(a, b) {
  return a.length === b.length && a.every((row, i) =>
    row.objectId === b[i].objectId && (row.variantId ?? null) === (b[i].variantId ?? null) && (row.alt ?? null) === (b[i].alt ?? null));
}

/** The objects the studio's rows named before and the new list no longer names (to remove, D93). */
export function droppedStudioObjects(before, after, colours) {
  const studioAlts = new Set(colours.flatMap((c) => [...altsOfColour(c.label)]));
  const named = new Set(after.map((row) => row.objectId));
  return [...new Set(before.filter((row) => row.alt != null && studioAlts.has(row.alt)).map((row) => row.objectId))]
    .filter((id) => !named.has(id));
}

/**
 * For each mockup, the object the product already holds for the same colour
 * and side (the row with its alt text), if any: { [key]: objectId }. Whether
 * its bytes are the same is the caller's to check (the object's sha256).
 */
export function studioObjectsBySide(rows, mockups, colours) {
  const labelOf = new Map(colours.map((c) => [c.id, c.label]));
  const out = {};
  for (const m of mockups) {
    const label = labelOf.get(m.colorwayId);
    if (label == null) continue;
    const alt = mockupAlt(label, m.slot);
    const row = rows.find((r) => r.alt === alt);
    if (row) out[m.key] = row.objectId;
  }
  return out;
}

// ── the 3D models ───────────────────────────────────────────────────────────

/**
 * GET /v1/admin/pod/3d-models `models` → what Studio3DSection reads (the older
 * pod3dModels documents plus `id`): the same shape, so only what the Worker
 * leaves out or answers as null is bridged — `output: null` becomes absent
 * (the compositor's own default), and the list is sorted by label with the
 * Swedish collation as the older loader did. A model without an id or views
 * is dropped (nothing could draw it). Inactive models never arrive.
 */
export function models3dFromApi(models) {
  return (Array.isArray(models) ? models : [])
    .filter((m) => m && typeof m.id === 'string' && m.id !== '' && m.views && typeof m.views === 'object')
    .map((m) => {
      const { output, ...rest } = m;
      return output && output.w > 0 ? { ...rest, output: { ...output } } : rest;
    })
    .sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'sv'));
}
