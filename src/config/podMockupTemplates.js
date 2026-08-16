// podMockupTemplates.js — cached loader for the Design Studio garment mockup
// templates (settings/podMockupTemplates).
//
// These templates are GLOBAL config (not per-shop), mirroring podProfiles.js: a
// single settings doc holding the array of mockup templates the Design Studio
// composes artwork onto. They are SEEDED/edited by an Admin-SDK script
// (scripts/seed-pod-mockup-templates.cjs) and the platform — firestore.rules makes
// settings/{id} read=isActiveUser, write=isPlatform — so the app only ever READS
// them. Changing a template's print-area coords/colorways auto-updates the studio
// (no code change).
//
// SHAPE of settings/podMockupTemplates:
//   { version, provisional, templates: [ template, … ] }
// A template is EITHER a FLAT (SVG flat background) OR a PHOTO (real garment-photo
// background per colourway). The px↔mm mapping (printAreas + printAreaMm) is the
// same for both — only the background layer + coordinate space differ.
//
// FLAT template (SVG flat, viewBox 800×900 coordinate space):
//   {
//     id: 'tee_flat',              // stable template id
//     label: 'T-shirt',            // Swedish UI label
//     garment: 'tee',              // which SVG flat renders this ('tee' | 'hoodie')
//     profileId: 'apparel_dtg',    // ↔ settings/podProfiles profile (print specs/DPI)
//     costSek: 149,                // OPTIONAL provisional production cost (SEK, ex the
//                                  // print price matrix). Drives the Publish step's
//                                  // profit/margin columns; undefined → those show '—'.
//     colorways: [{ id, label, hex }, …],   // selectable garment colours
//     printAreas: { front: {x,y,w,h}, … },  // in SVG viewBox coords (800×900)
//     printAreaMm: { front: {w,h}, … },      // physical print size ↔ profile.print_area_mm
//     pocketPositions: { left:{x}, center:{x}, right:{x} },  // OPTIONAL: discrete x
//                                  // offsets for the fixed-size 'pocket' slot
//                                  // (wearer's perspective; same y/w/h as
//                                  // printAreas.pocket — see placementMath's
//                                  // templateWithPocketPosition)
//   }
//
// PHOTO template (real blank-garment photo per colourway; photo px = coord space):
//   {
//     id: 'tee_photo_stanley',
//     label: 'T-shirt (foto)',
//     profileId: 'apparel_dtg',
//     photo: {
//       w: 2000, h: 2250,          // photo pixel dims = this template's coord space
//       urls: { white: 'https://…', black: 'https://…' },  // photo PER colourway id
//       displacement?: {           // optional shared fabric warp maps per view
//         w: 2000, h: 2250,        // map/source-photo coordinate space
//         urls: { front: '…', back: '…' },
//         scale: 40, blur: 6, contrast: 1, blend: 'normal', alpha: 0.8,
//       },
//     },
//     colorways: [{ id, label, hex }, …],   // hex still drives the colour-dot chips
//     printAreas: { front: {x,y,w,h}, … },  // px rects IN PHOTO COORDS (calibrated)
//     printAreaMm: { front: {w,h}, … },      // unchanged semantics
//   }
//
// px↔mm MAPPING (what the compositor uses): printAreas[slot] gives the rect — in the
// template's OWN coordinate space (photo.w/h when photo exists, else the SVG viewBox)
// — where the artwork is placed; printAreaMm[slot] gives that same rect's physical
// size in millimetres. The compositor computes effective DPI per placement from the
// artwork's source pixels and the physical mm — e.g.
//   effectiveDpi = artworkWidthPx / (printAreaMm.w / 25.4).
// The two must describe the SAME physical region; printAreas is only the on-screen
// preview geometry (aspect ratio should match printAreaMm's w:h).
//
// Degrades to [] on missing/error so callers never crash (same contract as
// loadPodProfiles).
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase/config';

const TEMPLATES_REF = () => doc(db, 'settings', 'podMockupTemplates');

// Module-level cache. `null` = not loaded yet; an array (possibly empty) = loaded.
let _cache = null;
let _meta = { version: 0, provisional: true };

/**
 * loadPodMockupTemplates() → Promise<Array<template>>
 * Reads settings/podMockupTemplates once and caches the templates array. Returns []
 * if the doc is missing (not seeded yet) or on any read error — the Design Studio
 * then shows an empty template list rather than throwing.
 */
export const loadPodMockupTemplates = async () => {
  if (_cache !== null) return _cache;
  try {
    const snap = await getDoc(TEMPLATES_REF());
    if (snap.exists()) {
      const data = snap.data() || {};
      _cache = Array.isArray(data.templates) ? data.templates : [];
      _meta = { version: data.version || 0, provisional: data.provisional !== false };
      warnOnAspectMismatch(_cache);
    } else {
      _cache = [];
    }
  } catch (err) {
    console.warn('podMockupTemplates: could not load settings/podMockupTemplates, using [] :', err?.message);
    _cache = [];
  }
  return _cache;
};

/** The version/provisional metadata of the last successful load (for banners). */
export const getPodMockupTemplatesMeta = () => _meta;

// The px rect and the mm size MUST describe the same physical region, so their
// aspect ratios must agree (docs/POD_PRINT_SPEC.md) — a mismatch silently skews
// every preview and cm readout. Config is seed-script-authored (no editor UI),
// so this is a loud dev-time tripwire, not a hard failure.
const warnOnAspectMismatch = (templates) => {
  for (const t of templates || []) {
    for (const slot of Object.keys(t?.printAreas || {})) {
      const px = t.printAreas[slot];
      const mm = t.printAreaMm?.[slot];
      if (!px?.w || !px?.h || !mm?.w || !mm?.h) continue;
      const drift = Math.abs((px.w / px.h) / (mm.w / mm.h) - 1);
      if (drift > 0.01) {
        console.warn(
          `podMockupTemplates: ${t.id}.${slot} px aspect (${px.w}×${px.h}) drifts ` +
          `${(drift * 100).toFixed(1)}% from mm aspect (${mm.w}×${mm.h}) — previews will skew. Fix the seed.`
        );
      }
    }
  }
};

// NOTE: isPhotoTemplate lives in the studio's TemplateBackground.jsx (not here) —
// this module imports firebase/config, and the studio render pipeline must stay
// Firebase-free (dev harness + rasterizer run without an initialized app).

/** Find a loaded template by its id (e.g. 'tee_flat'). Returns null if absent. */
export const getTemplateById = (templates, id) =>
  (Array.isArray(templates) ? templates : []).find((t) => t && t.id === id) || null;

// Canonical slot order for every slot enumeration (step-2 tryckytor cards,
// trycklista, preview tabs, mockup/publish loops): chest → back → pocket →
// sleeves. Needed because printAreas arrives as a FIRESTORE MAP, and Firestore
// gives map keys back in no guaranteed order — raw Object.keys shuffled the
// step-2 cards on every reload. Slots not listed here sort last, in map order.
const SLOT_ORDER = ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve'];
const slotRank = (slot) => {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length : i;
};

/** The slots a template actually defines a print area for, in canonical order
 *  (e.g. ['front','back','pocket',…]). */
export const templateSlots = (template) =>
  (template && template.printAreas ? Object.keys(template.printAreas) : [])
    .sort((a, b) => slotRank(a) - slotRank(b));

/** Drop the cache (e.g. after a platform edit) so the next load re-reads Firestore. */
export const clearPodMockupTemplatesCache = () => {
  _cache = null;
  _meta = { version: 0, provisional: true };
};

/** DEV-ONLY: pre-seed the cache so the untracked studio harness can mount the
 *  FULL DesignStudio without Firestore. No-op in production builds. */
export const seedPodMockupTemplatesCacheForDev = (templates, meta = {}) => {
  if (!import.meta.env.DEV) return;
  _cache = Array.isArray(templates) ? templates : [];
  _meta = { version: meta.version ?? 999, provisional: meta.provisional !== false };
};
